import fs from 'node:fs/promises';
import {watch as watchDirectory} from 'node:fs';
import path from 'node:path';
import {setImmediate as yieldTurn} from 'node:timers/promises';

const ignored = new Set(['management', 'models', 'model', 'model-assets', 'basic-memory-state', 'node_modules', 'vendor', 'attachments']);
const absent = error => ['ENOENT', 'ENOTDIR'].includes(error.code);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
};
const same = (a, b) => a?.mtimeMs === b?.mtimeMs && a?.size === b?.size;

/** Metadata-only observer for ONE explicitly selected Vault. No body reads,
 * hashes, writes, semantic jobs or persisted content/version catalogue.
 *
 * onChange(changes, {vaultPath, signal}) accepts batches of:
 *   {operation: 'added'|'modified'|'deleted', path: 'vault/relative.md',
 *    previous: {mtimeMs, size}|null, current: {mtimeMs, size}|null}
 * These are hints, NOT content revisions: the consumer must reread authority
 * and use P07's real checksum. P02 still owns conflicting model submissions.
 * A named native event can request a reread even with unchanged mtime/size;
 * silent edits preserving both metadata fields cannot be detected by scans.
 * Resolve only after accepting the batch into the host's recoverable queue.
 * Failed batches can repeat; restart reports existing files as additions.
 *
 * start() performs the initial background scan and installs nonrecursive
 * native watches; wake() retries pending work; scan() explicitly reconciles.
 * status() is synchronous/cache-only. close() aborts delivery and drains work.
 * includePaths optionally limits traversal to selected relative files/trees;
 * hidden/management/model directories and all symlinks remain excluded.
 */
export function createMemoryVaultWatch({
  vaultPath, onChange, onScan = () => {}, logger, canRun = () => true, includePaths = ['.'],
  excludeDirectories = [], batchSize = 64, debounceMs = 150, retryMs = 1000,
  rescanMs = 60_000, watch = watchDirectory,
} = {}) {
  if (typeof vaultPath !== 'string' || !path.isAbsolute(vaultPath)) throw TypeError('Explicit absolute vaultPath required');
  if ([onChange,onScan,canRun].some(value=>typeof value!=='function')) throw TypeError('onChange, onScan and canRun must be functions');
  for (const [key, value] of Object.entries({batchSize, debounceMs, retryMs, rescanMs})) {
    if (!Number.isSafeInteger(value) || value < (['debounceMs', 'rescanMs'].includes(key) ? 0 : 1)) throw TypeError('Invalid ' + key);
  }
  const root = path.resolve(vaultPath);
  const excluded = new Set([...ignored, ...excludeDirectories.map(name => String(name).toLowerCase())]);
  const excludedPart = name => name.startsWith('.') || excluded.has(name.toLowerCase());
  const relative = full => path.relative(root, full).split(path.sep).join('/');
  if (!Array.isArray(includePaths) || !includePaths.length) throw TypeError('Nonempty includePaths required');
  const selections = [...new Set(includePaths.map(value => {
    if (typeof value !== 'string' || !value || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) throw TypeError('Vault-relative includePaths required');
    const parts = value.replace(/\\/g, '/').split('/');
    if (value !== '.' && parts.some(part => !part || part === '.' || part === '..' || excludedPart(part))) throw TypeError('Invalid includePaths');
    const full = path.resolve(root, value);
    if (!inside(root, full)) throw TypeError('includePaths outside Vault');
    return full;
  }))];
  const selected = full => selections.some(item => inside(item, full));
  const traversable = full => selected(full) || selections.some(item => inside(full, item));
  const known = new Map(), watchers = new Map(), hints = new Map(), controller = new AbortController();
  const stats = {scans: 0, delivered: 0, batches: 0};
  let started = false, closed = false, dirty = false, active, timer, periodic, closing;
  let waitingReason = null, lastError = null, eventSequence = 0;

  function status() {
    return {vaultPath: root, started, closed, busy: Boolean(active), pending: dirty,
      files: known.size, watchers: watchers.size, waitingReason, lastError, ...stats};
  }
  function schedule(delay = debounceMs) {
    if (closed || !started) return;
    clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void run(); }, delay);
    timer.unref?.();
  }
  function changed() {
    if (closed) return;
    dirty = true;
    schedule();
  }
  async function admitted() {
    if (closed) return false;
    const decision = await canRun({lane: 'vault-watch', vaultPath: root});
    if (closed) return false;
    const allowed = typeof decision === 'boolean' ? decision : decision?.allowed === true;
    waitingReason = allowed ? null : decision?.reason || 'resource-busy';
    return allowed;
  }
  // Check every visited path, including the root and selected ancestors. Never
  // descend through symlinks/junctions, even if the target is inside the Vault.
  async function inspect(full) {
    try {
      const info = await fs.lstat(full);
      if (info.isSymbolicLink()) {
        if (full === root) throw Object.assign(Error('Selected Vault is a link'), {code: 'VAULT_REDIRECTED'});
        return null;
      }
      const actual = await fs.realpath(full);
      if (path.relative(full, actual) !== '' || !inside(root, actual)) throw Object.assign(Error('Vault path redirected'), {code: 'VAULT_REDIRECTED'});
      return info;
    } catch (error) { if (absent(error)) return null; throw error; }
  }
  function attach(full) {
    if (closed || watchers.has(full)) return;
    const handle = watch(full, {persistent: false}, (event, filename) => {
      if (closed) return;
      if (filename && excludedPart(path.basename(String(filename)))) return;
      if (filename && /\.md$/i.test(String(filename))) {
        const target = path.resolve(full, String(filename));
        if (inside(root, target) && selected(target)) hints.set(relative(target), ++eventSequence);
      }
      // rename includes directory creation/removal; platform events may omit names.
      if (event === 'rename' || !filename || /\.md$/i.test(String(filename))) changed();
    });
    watchers.set(full, handle);
    handle.on('error', error => {
      if (closed) return;
      lastError = error.code || 'VAULT_WATCH_FAILED';
      handle.close(); watchers.delete(full); changed();
    });
  }
  async function collect() {
    const found = new Map(), directories = new Set(), pending = [root];
    let count = 0;
    while (pending.length) {
      if (!await admitted()) return null;
      const directory = pending.pop(), info = await inspect(directory);
      if (!info?.isDirectory()) continue;
      directories.add(directory); attach(directory);
      let handle;
      try { handle = await fs.opendir(directory, {bufferSize: batchSize}); }
      catch (error) { if (absent(error)) continue; throw error; }
      for await (const entry of handle) {
        if (closed) return null;
        if (++count % batchSize === 0) {
          await yieldTurn();
          if (!await admitted()) return null;
        }
        if (excludedPart(entry.name) || entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name);
        if (!traversable(full)) continue;
        if (entry.isDirectory()) pending.push(full);
        else if (entry.isFile() && selected(full) && /\.md$/i.test(entry.name)) {
          const current = await inspect(full);
          if (current?.isFile()) found.set(relative(full), {mtimeMs: current.mtimeMs, size: current.size});
        }
      }
    }
    return {found, directories};
  }
  async function reconcile() {
    if (!await admitted()) return;
    dirty = false;
    const observedHints = new Map(hints);
    const result = await collect();
    if (!result || closed) { dirty = !closed; return; }
    stats.scans++;
    // Reuse the existing rescan clock for metadata outside Markdown. Failed
    // delivery follows the same retry path, including scans with no file edits.
    await onScan({vaultPath:root,signal:controller.signal});
    if(closed)return;
    const {found, directories} = result;
    for (const [directory, handle] of watchers) if (!directories.has(directory)) { handle.close(); watchers.delete(directory); }
    const changes = [];
    for (const [file, current] of found) {
      const previous = known.get(file);
      if (!previous || !same(previous, current) || observedHints.has(file)) changes.push({operation: previous ? 'modified' : 'added', path: file, previous: previous ?? null, current});
    }
    for (const [file, previous] of known) if (!found.has(file)) changes.push({operation: 'deleted', path: file, previous, current: null});
    for (let offset = 0; offset < changes.length; offset += batchSize) {
      await yieldTurn();
      if (!await admitted()) { dirty = !closed; return; }
      const batch = changes.slice(offset, offset + batchSize);
      await onChange(structuredClone(batch), {vaultPath: root, signal: controller.signal});
      if (closed) return;
      // Acknowledge only delivered batches. Failure/busy retains the rest for wake.
      for (const item of batch) {
        item.current ? known.set(item.path, item.current) : known.delete(item.path);
        if (hints.get(item.path) === observedHints.get(item.path)) hints.delete(item.path);
      }
      stats.delivered += batch.length; stats.batches++;
    }
    for (const [file, sequence] of observedHints) if (!found.has(file) && hints.get(file) === sequence) hints.delete(file);
    lastError = null;
  }
  function run() {
    if (active) return active.then(status);
    if (closed || !started || !dirty) return Promise.resolve(status());
    clearTimeout(timer); timer = undefined;
    active = reconcile().catch(error => {
      if (closed) return;
      dirty = true; lastError = error.code || 'VAULT_SCAN_FAILED';
      logger?.warn?.('Vault metadata sync deferred: ' + lastError);
    }).finally(() => {
      active = undefined;
      if (dirty && !closed) schedule(waitingReason || lastError ? retryMs : debounceMs);
    });
    return active.then(status);
  }
  function start() {
    if (closed || started) return active ? active.then(status) : Promise.resolve(status());
    started = true; dirty = true;
    if (rescanMs) {
      periodic = setInterval(changed, rescanMs);
      periodic.unref?.();
    }
    return run();
  }
  function scan() {
    if (closed) return Promise.resolve(status());
    if (!started) return start();
    dirty = true;
    return run();
  }
  function close() {
    if (closing) return closing;
    closed = true; dirty = false; controller.abort();
    clearTimeout(timer); clearInterval(periodic);
    for (const handle of watchers.values()) handle.close();
    watchers.clear(); hints.clear();
    closing = Promise.resolve(active).then(status);
    return closing;
  }
  return {start, wake: () => started ? run() : start(), scan, status, close};
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {createMemoryVaultWatch} from '../lib/memory-vault-watch.js';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-vault-watch-'));
  const vaultPath = path.join(directory, 'vault');
  await fs.mkdir(vaultPath);
  const batches = [], contexts = [];
  const observer = createMemoryVaultWatch({vaultPath, debounceMs: 15, retryMs: 50, rescanMs: 0,
    onChange: async (batch, context) => { batches.push(batch); contexts.push(context); }, ...options});
  t.after(async () => { await observer.close(); await fs.rm(directory, {recursive: true, force: true}); });
  const write = async (file, text) => {
    const full = path.join(vaultPath, file);
    await fs.mkdir(path.dirname(full), {recursive: true});
    await fs.writeFile(full, text);
    return full;
  };
  return {directory, vaultPath, observer, batches, contexts, write, events: () => batches.flat()};
}

test('periodic scans reconcile maintenance even without Markdown edits and retry failures',async t=>{
  let scans=0,fail=true;
  const f=await fixture(t,{rescanMs:25,onScan:async()=>{scans++;if(fail)throw Object.assign(Error('fixture retry'),{code:'FIXTURE_RETRY'});}});
  await f.observer.start();assert.equal(f.observer.status().lastError,'FIXTURE_RETRY');
  fail=false;await until(()=>scans>=2&&!f.observer.status().lastError);
  assert.equal(f.events().length,0);
  await f.observer.close();const stopped=scans;await delay(45);assert.equal(scans,stopped);
});
async function until(predicate) {
  const end = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > end) assert.fail('Timed out waiting for native Vault notification');
    await delay(10);
  }
}
function fakeWatch() {
  const handles = [];
  function watch(full, _options, callback) {
    const handle = new EventEmitter();
    handle.full = full; handle.callback = callback; handle.closed = false;
    handle.close = () => { handle.closed = true; };
    handles.push(handle);
    return handle;
  }
  return {watch, handles};
}

test('only explicit absolute Vault and relative selected paths are accepted', () => {
  const onChange = () => {};
  for (const vaultPath of [undefined, '', 'relative']) assert.throws(() => createMemoryVaultWatch({vaultPath, onChange}), /absolute vaultPath/);
  const vaultPath = path.resolve(os.tmpdir(), 'selected-vault');
  for (const includePaths of [[], ['../outside'], ['models'], ['.obsidian'], [path.resolve(os.tmpdir())]]) {
    assert.throws(() => createMemoryVaultWatch({vaultPath, onChange, includePaths}), TypeError);
  }
});

test('existing Markdown remains byte-identical; notifications contain metadata hints, never body or revision', async t => {
  const f = await fixture(t, {batchSize: 2});
  const text = '---\ncustom: 保留\n---\n# 手写日记\n[[朋友]]\n<!-- arbitrary -->\n';
  for (const file of ['dafeiyu/thoughts/a.md', 'dafeiyu/diary/b.md', 'manual/c.MD']) await f.write(file, text);
  await f.write('manual/image.png', 'not Markdown');
  await f.observer.start();
  assert.equal(f.events().length, 3);
  assert.ok(f.batches.every(batch => batch.length <= 2));
  for (const event of f.events()) {
    assert.equal(event.operation, 'added'); assert.equal(event.previous, null);
    assert.deepEqual(Object.keys(event.current).sort(), ['mtimeMs', 'size']);
    assert.equal('checksum' in event, false); assert.equal('revision' in event, false);
    assert.equal(await fs.readFile(path.join(f.vaultPath, event.path), 'utf8'), text);
  }
  assert.equal(JSON.stringify(f.events()).includes('手写日记'), false);
  const count = f.events().length;
  await f.observer.scan(); assert.equal(f.events().length, count);
});

test('native watches detect create, edit, new nested directory, rename and delete', async t => {
  const f = await fixture(t);
  await f.observer.start();
  const first = await f.write('manual/first.md', 'first');
  await until(() => f.events().some(row => row.path === 'manual/first.md' && row.operation === 'added'));
  await fs.appendFile(first, '\nEdited by Obsidian');
  await until(() => f.events().some(row => row.path === 'manual/first.md' && row.operation === 'modified'));
  await fs.rename(first, path.join(f.vaultPath, 'manual/renamed.md'));
  await until(() => f.events().some(row => row.path === 'manual/first.md' && row.operation === 'deleted') && f.events().some(row => row.path === 'manual/renamed.md' && row.operation === 'added'));
  await fs.rm(path.join(f.vaultPath, 'manual/renamed.md'));
  await until(() => f.events().some(row => row.path === 'manual/renamed.md' && row.operation === 'deleted'));
  const modified = f.events().find(row => row.operation === 'modified');
  assert.ok(modified.current.size > modified.previous.size);
  // Rename is deliberately delete+add; this adapter does not invent identity.
  assert.equal(f.events().some(row => row.operation === 'renamed'), false);
});

test('management, models, hidden directories, attachments and unselected trees are not traversed', async t => {
  const native = fakeWatch();
  const f = await fixture(t, {...native, includePaths: ['dafeiyu/thoughts', 'manual/chosen.md']});
  for (const file of ['dafeiyu/thoughts/a.md', 'manual/chosen.md', 'manual/other.md', 'elsewhere/a.md',
    'management/a.md', 'models/a.md', '.obsidian/a.md', 'attachments/a.md', 'dafeiyu/thoughts/management/a.md']) await f.write(file, 'fixture');
  await f.observer.start();
  assert.deepEqual(f.events().map(row => row.path).sort(), ['dafeiyu/thoughts/a.md', 'manual/chosen.md']);
  assert.ok(!native.handles.some(handle => /management|models|elsewhere|attachments|\.obsidian/.test(handle.full)));
});

test('foreground/resource busy leaves work pending without scanning; wake retries without phantom deletion', async t => {
  let allowed = true;
  const f = await fixture(t, {canRun: () => ({allowed, reason: 'foreground-busy'}), retryMs: 10_000});
  const full = await f.write('a.md', 'initial'); await f.observer.start();
  const before = f.observer.status().scans;
  allowed = false;
  await fs.rm(full); await f.write('b.md', 'new');
  await f.observer.scan();
  assert.equal(f.observer.status().scans, before);
  assert.equal(f.observer.status().files, 1);
  assert.equal(f.observer.status().pending, true);
  assert.equal(f.observer.status().waitingReason, 'foreground-busy');
  assert.equal(f.events().length, 1);
  allowed = true; await f.observer.wake();
  assert.ok(f.events().some(row => row.path === 'a.md' && row.operation === 'deleted'));
  assert.ok(f.events().some(row => row.path === 'b.md' && row.operation === 'added'));
});

test('mid-scan yield never publishes an incomplete inventory as deletes', async t => {
  let allowance = Infinity;
  const f = await fixture(t, {batchSize: 1, retryMs: 10_000, canRun: () => --allowance >= 0});
  await f.write('a.md', 'a'); await f.write('b.md', 'b'); await f.observer.start();
  const initial = f.events().length;
  await f.write('a.md', 'a changed');
  allowance = 2; await f.observer.scan();
  assert.equal(f.events().length, initial);
  assert.equal(f.observer.status().files, 2);
  assert.equal(f.observer.status().pending, true);
  allowance = Infinity; await f.observer.wake();
  assert.equal(f.events().filter(row => row.operation === 'modified').length, 1);
  assert.equal(f.events().some(row => row.operation === 'deleted'), false);
});

test('delivery failures retain unacknowledged hints, and consumer mutation cannot alter the baseline', async t => {
  let fail = true;
  const accepted = [];
  const f = await fixture(t, {retryMs: 10_000, onChange: async batch => {
    if (fail) throw Object.assign(Error('queue unavailable'), {code: 'QUEUE_BUSY'});
    accepted.push(structuredClone(batch)); batch[0].current.size = -100;
  }});
  await f.write('a.md', 'original'); await f.observer.start();
  assert.equal(f.observer.status().files, 0);
  assert.equal(f.observer.status().lastError, 'QUEUE_BUSY');
  fail = false; await f.observer.wake();
  assert.equal(accepted.length, 1); assert.equal(f.observer.status().files, 1);
  await f.observer.scan(); assert.equal(accepted.length, 1);
});

test('event storms debounce into one scan; status reads perform no filesystem work', async t => {
  const native = fakeWatch();
  const f = await fixture(t, {...native, debounceMs: 30});
  await f.observer.start(); const before = f.observer.status().scans;
  const metadata = f.observer.status();
  for (let n = 0; n < 100; n++) assert.deepEqual(f.observer.status(), metadata);
  await f.write('a.md', 'one');
  for (let n = 0; n < 100; n++) native.handles[0].callback('change', 'a.md');
  await until(() => f.observer.status().scans > before);
  assert.equal(f.observer.status().scans, before + 1);
  assert.equal(f.events().length, 1);
});

test('a named native hint requests authoritative reread even if size/mtime did not change', async t => {
  const native = fakeWatch();
  const f = await fixture(t, {...native, debounceMs: 10_000});
  await f.write('a.md', 'unchanged'); await f.observer.start();
  native.handles[0].callback('change', 'a.md');
  await f.observer.wake();
  const hint = f.events().at(-1);
  assert.equal(hint.operation, 'modified');
  assert.deepEqual(hint.current, hint.previous);
  await f.observer.scan(); assert.equal(f.events().length, 2);
});

test('failed native watch is visible and a later scan reattaches it', async t => {
  const native = fakeWatch();
  const f = await fixture(t, {...native, debounceMs: 10_000});
  await f.observer.start();
  native.handles[0].emit('error', Object.assign(Error('watch lost'), {code: 'WATCH_LOST'}));
  assert.equal(f.observer.status().lastError, 'WATCH_LOST');
  await f.observer.wake();
  assert.equal(f.observer.status().watchers, 1);
  assert.equal(native.handles[0].closed, true); assert.equal(native.handles.length, 2);
});

test('close cancels pending work and closes watches; later writes/wake/scan emit nothing', async t => {
  const native = fakeWatch();
  const f = await fixture(t, {...native});
  await f.observer.start();
  await f.write('a.md', 'a'); native.handles[0].callback('rename', 'a.md');
  await f.observer.close();
  assert.ok(native.handles.every(handle => handle.closed));
  native.handles[0].callback('change', 'a.md');
  await f.observer.scan(); await f.observer.wake(); await delay(35);
  assert.equal(f.events().length, 0);
  assert.equal(f.observer.status().closed, true);
  assert.equal(f.observer.status().watchers, 0);
});

test('close aborts the current delivery context and starts no later batch', async t => {
  let enter, release, signal, calls = 0;
  const entered = new Promise(resolve => { enter = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, {batchSize: 1, onChange: async (_batch, context) => {
    calls++; signal = context.signal; enter(); await pending;
  }});
  await f.write('a.md', 'a'); await f.write('b.md', 'b');
  const starting = f.observer.start(); await entered;
  const closing = f.observer.close(); assert.equal(signal.aborted, true);
  release(); await closing; await starting;
  assert.equal(calls, 1); assert.equal(f.observer.status().files, 0);
});

test('symlink/junction files and directories are never followed; replacing a known subtree invalidates its paths', async t => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside'); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.md'), 'outside fixture, not a real private library');
  const original = await f.write('normal/a.md', 'inside');
  await f.observer.start();
  try {
    await fs.symlink(outside, path.join(f.vaultPath, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) return t.skip('Environment cannot create directory links: ' + error.code);
    throw error;
  }
  await fs.rm(original); await fs.rmdir(path.dirname(original));
  await fs.symlink(outside, path.dirname(original), process.platform === 'win32' ? 'junction' : 'dir');
  await f.observer.scan();
  assert.equal(f.events().some(row => row.path.includes('secret')), false);
  assert.ok(f.events().some(row => row.path === 'normal/a.md' && row.operation === 'deleted'));
  // File symlinks need separate privileges on Windows; directory boundary above
  // is still exercised even when file links are unavailable.
  try { await fs.symlink(path.join(outside, 'secret.md'), path.join(f.vaultPath, 'file.md'), 'file'); }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
    t.diagnostic('File-link subcase unavailable: ' + error.code); return;
  }
  await f.observer.scan(); assert.equal(f.events().some(row => row.path === 'file.md'), false);
});

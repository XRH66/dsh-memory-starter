import { createUnifiedStateStore } from './state-store.js';
import { memoryError, requiredText } from './contract.js';

const clone = value => structuredClone(value);
const codeOf = error => /^[A-Z][A-Z0-9_]{0,79}$/u.test(error?.code) ? error.code : 'VECTOR_UPDATE_FAILED';
const denied = () => memoryError('MEMORY_NOT_AUTHORIZED', '原向量来源未获准处理', 403);
const manual = row => row.kind === 'document' && row.authority === 'manual';
const sourceKeys = ['id', 'revision', 'ownerSubject', 'project', 'sessionId', 'rootSessionId',
  'messageId', 'sequence', 'turn', 'rootTurn', 'role', 'kind', 'authority'];
const keyOf = row => JSON.stringify([row.ownerSubject, row.project, row.id, row.revision,
  row.profile?.id, row.profile?.revision, row.intentId]);
const catalogueKey = row => JSON.stringify([row.ownerSubject, row.project, row.id, row.revision]);
const sameScope = (a, b) => a.ownerSubject === b.ownerSubject && a.project === b.project;
const terminal = new Set(['completed', 'cancelled', 'superseded', 'error']);
const unavailable = new Set(['MEMORY_NOT_AUTHORIZED', 'MEMORY_ACCESS_DENIED', 'MEMORY_DISABLED', 'MEMORY_NOT_READY']);

/** Durable vector-only work. ready/status never read source text or load models.
 * notify(row) accepts trusted source metadata (text/targets/signals are ignored).
 * The original active profile + intent are frozen at notification time.
 * acquire(row) is a host callback returning a fresh grant (or null to hold).
 * For chat it is called ONLY while the original session is present and enabled;
 * management grants are accepted only for explicitly selected manual documents.
 * resume() rechecks held work, e.g. on original agent-created/opt-in events.
 * flush({sessionId?}) runs currently due work, respecting retry deadlines/limits.
 * Retry timers are independent of semantic scheduling; no core.process calls.
 * config: debounceMs=300,retryMs=1000,maxAttempts=3,maxJobs=32,timers?.
 */
export function createVectorQueue({ file, runtime, profiles, findAgent, listAgents = () => [],
  acquire, now = Date.now, config = {} }) {
  if (!runtime?.sources || !runtime.policy || !profiles || typeof profiles.vectorIntent !== 'function' ||
      typeof findAgent !== 'function' || typeof acquire !== 'function') throw new TypeError('Vector queue dependencies required');
  const options = { debounceMs: 300, retryMs: 1000, maxAttempts: 3, maxJobs: 32, ...config };
  for (const name of ['debounceMs', 'retryMs', 'maxAttempts', 'maxJobs']) {
    if (!Number.isSafeInteger(options[name]) || options[name] < (name === 'debounceMs' ? 0 : 1)) throw new TypeError(`Invalid vector queue ${name}`);
  }
  const timers = config.timers ?? { setTimeout, clearTimeout };
  const states = new Set(['pending', 'running', 'held', ...terminal]);
  const store = createUnifiedStateStore({ file, initial: () => ({ jobs: [] }), validate: value => {
    if (!Array.isArray(value.jobs) || value.jobs.some(row => !row || !states.has(row.state) ||
        typeof row.id !== 'string' || !['string', 'number'].includes(typeof row.revision) ||
        !Number.isSafeInteger(row.attempts) || row.attempts < 0 || !Number.isFinite(row.nextAt) ||
        Object.keys(row).some(key => ![...sourceKeys, 'profile', 'intentId', 'state', 'attempts', 'nextAt', 'error', 'delivery'].includes(key))) ||
        new Set(value.jobs.map(keyOf)).size !== value.jobs.length) throw memoryError('INVALID_VECTOR_QUEUE', '向量队列元数据无效');
    if (value.catalogues !== undefined && (!Array.isArray(value.catalogues) || value.catalogues.some(row => !manual(row) ||
        !row.id || !row.ownerSubject || !row.project || !Number.isSafeInteger(row.delivery) || !Number.isSafeInteger(row.acknowledged) ||
        row.acknowledged < 0 || row.delivery < row.acknowledged ||
        row.maintenanceRevision !== undefined && typeof row.maintenanceRevision !== 'string') || new Set(value.catalogues.map(catalogueKey)).size !== value.catalogues.length))
      throw memoryError('INVALID_VECTOR_QUEUE', '目录变更记录无效');
  } });
  const shutdown = new AbortController();
  let readyTask, stopped = false, timer, nextWake = null, pump, lastError = null;
  function clearTimer() { if (timer !== undefined) timers.clearTimeout(timer); timer = undefined; nextWake = null; }
  function assertOpen() { if (stopped) throw memoryError('VECTOR_QUEUE_CLOSED', '向量队列已关闭'); }
  function summary() {
    const counts = { pending: 0, running: 0, held: 0, completed: 0, cancelled: 0, superseded: 0, error: 0 };
    const jobs = store.ready ? store.snapshot().jobs : [];
    for (const row of jobs) counts[row.state]++;
    return { ready: Boolean(readyTask) && store.ready, closed: stopped, busy: Boolean(pump), nextWake,
      errorCode: lastError, ...counts, jobs,
      pendingCatalogues: store.ready ? (store.snapshot().catalogues ?? []).filter(row => row.delivery > row.acknowledged).length : 0 };
  }
  // Catalogue changes outlive a preparation intent. They carry only a dirty
  // watermark; every runnable job still freezes the active profile and intent.
  function enqueueCatalogue(value, boundary) {
    if (boundary.delivery <= boundary.acknowledged) return;
    const intent = profiles.vectorIntent(boundary);
    if (!intent.profile || intent.preparing || intent.state === 'cancelled') return;
    const item = Object.fromEntries(sourceKeys.filter(key => boundary[key] !== undefined).map(key => [key, clone(boundary[key])]));
    Object.assign(item, { profile: intent.profile, intentId: intent.intentId, state: 'pending', attempts: 0,
      nextAt: now() + options.debounceMs, error: null, delivery: boundary.delivery });
    const existing = value.jobs.find(row => keyOf(row) === keyOf(item));
    if (!existing) value.jobs.push(item);
    else if (!['cancelled', 'error', 'superseded'].includes(existing.state) && existing.delivery < boundary.delivery) {
      existing.delivery = boundary.delivery;
      if (existing.state === 'completed') { existing.state = 'pending'; existing.nextAt = item.nextAt; existing.attempts = 0; }
    }
  }
  async function reconcileCatalogues() {
    const pending = (store.snapshot().catalogues ?? []).filter(row => row.delivery > row.acknowledged);
    if (!pending.length) return;
    await store.update(value => { for (const boundary of value.catalogues ?? []) enqueueCatalogue(value, boundary); });
  }
  async function settleCatalogue({ checkpoint, profile }) {
    if (!checkpoint.length || !profile) return;
    await store.update(value => {
      for (const captured of checkpoint) {
        const current = profiles.vectorIntent(captured).profile;
        if (!current || current.id !== profile.id || current.revision !== profile.revision || current.indexId !== profile.indexId) continue;
        const boundary = value.catalogues?.find(row => catalogueKey(row) === catalogueKey(captured));
        if (boundary) boundary.acknowledged = Math.max(boundary.acknowledged, Math.min(captured.delivery, boundary.delivery));
      }
    });
  }
  function arm() {
    clearTimer();
    if (stopped || pump || !store.ready) return;
    const due = store.snapshot().jobs.filter(row => row.state === 'pending').map(row => row.nextAt);
    if (!due.length) return;
    nextWake = Math.min(...due);
    timer = timers.setTimeout(() => {
      timer = undefined; nextWake = null;
      void start().catch(error => { lastError = codeOf(error); });
    }, Math.min(2_147_483_647, Math.max(0, nextWake - now())));
    timer?.unref?.();
  }
  const update = (key, action) => store.update(value => {
    const job = value.jobs.find(row => keyOf(row) === key);
    if (job) action(job);
  });
  function originalAgent(row) {
    const agent = findAgent(row.sessionId) ?? listAgents().find(agent => runtime.policy.check(agent)?.sessionId === row.sessionId);
    const check = agent && runtime.policy.check(agent);
    return check?.enabled && check.sessionId === row.sessionId && check.ownerSubject === row.ownerSubject &&
      check.project === row.project && (!row.rootSessionId || check.rootSessionId === row.rootSessionId) ? agent : null;
  }
  function grantValid(row, grant) {
    if (!grant || grant.signal?.aborted || grant.ownerSubject !== row.ownerSubject || grant.project !== row.project || !runtime.authorize(grant)) return false;
    if (manual(row)) return grant.kind === 'management';
    return grant.kind !== 'management' && Boolean(originalAgent(row)) && runtime.policy.validate(grant, row) &&
      (!row.rootSessionId || grant.rootSessionId === row.rootSessionId);
  }
  function intentValid(row) {
    const current = profiles.vectorIntent(row);
    return row.profile && current.profile && row.profile.id === current.profile.id && row.profile.revision === current.profile.revision &&
      row.intentId === current.intentId && current.state !== 'cancelled';
  }
  async function execute(row) {
    const key = keyOf(row);
    if (!intentValid(row)) {
      await update(key, item => { item.state = row.profile ? 'cancelled' : 'held'; item.error = row.profile ? 'PROFILE_CANCELLED' : 'PROFILE_NOT_ACTIVE'; });
      return;
    }
    if (!manual(row) && !originalAgent(row)) {
      await update(key, item => { item.state = 'held'; item.error = 'MEMORY_NOT_AUTHORIZED'; }); return;
    }
    let grant;
    try {
      grant = await acquire(clone(row));
      if (stopped) return;
      if (!grantValid(row, grant)) throw denied();
      const latest = runtime.sources.get({ id: row.id, revision: row.revision, grant });
      if (!latest || latest.revision !== row.revision || latest.state !== 'live') {
        await update(key, item => { item.state = 'superseded'; item.error = 'SOURCE_REVISION_CONFLICT'; }); return;
      }
      const current = runtime.sources.get({ id: row.id, revision: row.revision, grant });
      if (!current || current.revision !== row.revision || current.state !== 'live') {
        await update(key, item => { item.state = 'superseded'; item.error = 'SOURCE_REVISION_CONFLICT'; }); return;
      }
      if (manual(row) && !manual(current)) throw denied();
      if (!intentValid(row)) throw memoryError('PROFILE_CANCELLED', '原向量任务已取消');
      await update(key, item => { item.state = 'running'; item.error = null; });
      const result = await profiles.incremental({ grant, signal: AbortSignal.any([shutdown.signal, grant.signal].filter(Boolean)),
        profileId: row.profile.id, profile: row.profile, intentId: row.intentId, changes: [{ id: row.id, revision: row.revision }] });
      if (stopped) return;
      if (!grantValid(row, grant)) throw denied();
      if (store.snapshot().catalogues?.some(boundary => catalogueKey(boundary) === catalogueKey(row)))
        await settleCatalogue({ checkpoint: [row], profile: result.profile });
      await update(key, item => {
        // A semantic delivery arriving while this pass ran must get its own
        // reconciliation boundary, even when the source version is unchanged.
        item.state = item.delivery === row.delivery ? 'completed' : 'pending';
        item.attempts = 0; item.nextAt = now(); item.error = null;
      });
    } catch (error) {
      if (stopped) return; // durable running state becomes pending on ready()
      const code = codeOf(error); lastError = code;
      await update(key, item => {
        item.error = code;
        if (code === 'PROFILE_CANCELLED' || code === 'PROFILE_CHANGED' || code === 'PROFILE_NOT_ACTIVE' || code === 'EMBEDDING_IDENTITY_MISMATCH') item.state = 'cancelled';
        else if (unavailable.has(code)) item.state = 'held';
        else {
          item.attempts++;
          item.state = item.attempts >= options.maxAttempts ? 'error' : 'pending';
          item.nextAt = now() + options.retryMs * 2 ** Math.min(item.attempts - 1, 10);
        }
      });
    } finally { grant?.cancel?.(); }
  }
  async function run(sessionId) {
    await reconcileCatalogues();
    let count = 0;
    while (!stopped && count++ < options.maxJobs) {
      const row = store.snapshot().jobs.find(row => row.state === 'pending' && row.nextAt <= now() && (!sessionId || row.sessionId === sessionId));
      if (!row) break;
      await execute(row);
      if (!stopped) await reconcileCatalogues();
    }
  }
  function start(sessionId) {
    if (pump) return pump;
    clearTimer();
    pump = run(sessionId).finally(() => { pump = undefined; arm(); });
    return pump;
  }
  const api = {
    ready() {
      assertOpen();
      return readyTask ||= (async () => {
        await store.read();
        if (store.snapshot().jobs.some(row => row.state === 'running')) await store.update(value => {
          for (const row of value.jobs) if (row.state === 'running') { row.state = 'pending'; row.nextAt = now(); }
        });
        return summary();
      })();
    },
    async notify(row) {
      assertOpen(); await api.ready(); assertOpen();
      for (const key of ['id', 'ownerSubject', 'project']) requiredText(row?.[key], key);
      if (!(typeof row.revision === 'string' && row.revision || Number.isSafeInteger(row.revision) && row.revision >= 0)) throw memoryError('INVALID_SOURCE', '来源版本无效');
      if (!manual(row)) requiredText(row.sessionId, '原来源会话');
      const item = Object.fromEntries(sourceKeys.filter(key => row[key] !== undefined).map(key => [key, clone(row[key])]));
      const intent = profiles.vectorIntent(item);
      Object.assign(item, { profile: intent.profile, intentId: intent.intentId, state: 'pending', attempts: 0,
        nextAt: now() + options.debounceMs, error: null, delivery: 1 });
      if (!item.profile) { item.state = 'held'; item.error = 'PROFILE_NOT_ACTIVE'; }
      if (intent.state === 'cancelled') { item.state = 'cancelled'; item.error = 'PROFILE_CANCELLED'; }
      await store.update(value => {
        const existing = value.jobs.find(row => keyOf(row) === keyOf(item));
        if (!existing) value.jobs.push(item);
        else if (!['cancelled', 'error', 'superseded'].includes(existing.state)) {
          existing.delivery++;
          if (existing.state === 'completed') { existing.state = 'pending'; existing.nextAt = item.nextAt; existing.attempts = 0; }
        }
      });
      arm(); return summary();
    },
    async notifyCatalogue(row,{maintenanceRevision}={}) {
      assertOpen(); await api.ready(); assertOpen();
      for (const key of ['id', 'ownerSubject', 'project']) requiredText(row?.[key], key);
      if (!manual(row) || !(typeof row.revision === 'string' && row.revision || Number.isSafeInteger(row.revision) && row.revision >= 0))
        throw memoryError('INVALID_SOURCE', '目录变更必须来自管理入口');
      if (maintenanceRevision !== undefined) {
        requiredText(maintenanceRevision,'维护版本');
        if (store.snapshot().catalogues?.find(item=>catalogueKey(item)===catalogueKey(row))?.maintenanceRevision===maintenanceRevision) return summary();
      }
      await store.update(value => {
        const boundaries = value.catalogues ??= [];
        let boundary = boundaries.find(item => catalogueKey(item) === catalogueKey(row));
        if (maintenanceRevision !== undefined && boundary?.maintenanceRevision === maintenanceRevision) return;
        if (!boundary) {
          // Continue the existing delivery sequence when adopting an old queue.
          const delivery = Math.max(0, ...value.jobs.filter(item => catalogueKey(item) === catalogueKey(row)).map(item => item.delivery ?? 0));
          boundary = { ...Object.fromEntries(sourceKeys.filter(key => row[key] !== undefined).map(key => [key, clone(row[key])])), delivery, acknowledged: 0 };
          boundaries.push(boundary);
        }
        boundary.delivery++;
        if (maintenanceRevision !== undefined) boundary.maintenanceRevision = maintenanceRevision;
        enqueueCatalogue(value, boundary);
      });
      arm(); return summary();
    },
    catalogueCheckpoint(scope) {
      return store.ready ? (store.snapshot().catalogues ?? []).filter(row => sameScope(row, scope)) : [];
    },
    settleCatalogue,
    async reconcileCatalogues() { assertOpen(); await api.ready(); await reconcileCatalogues(); arm(); return summary(); },
    async resume() {
      assertOpen(); await api.ready(); assertOpen();
      await store.update(value => {
        for (const row of value.jobs) if (row.state === 'held' && row.profile && (manual(row) || originalAgent(row))) {
          if (intentValid(row)) { row.state = 'pending'; row.nextAt = Math.max(row.nextAt, now()); }
          else { row.state = 'cancelled'; row.error = 'PROFILE_CANCELLED'; }
        }
      });
      await reconcileCatalogues();
      arm(); return summary();
    },
    async flush({ sessionId } = {}) {
      assertOpen(); await api.ready(); assertOpen();
      await start(sessionId); return summary();
    },
    status: summary,
    async close() {
      if (stopped) return;
      stopped = true; clearTimer(); shutdown.abort();
      await readyTask; await pump; await store.idle();
    },
  };
  return api;
}

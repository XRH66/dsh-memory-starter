import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createEmbeddingBackend } from '../raw-rag/backend.js';
import { planRawEmbeddingChunk } from '../raw-rag/embedding-material.js';
import { rawModelSpec, modelContract, embeddingEndpoint } from '../raw-rag/models.js';
import { memoryError, requiredText } from './contract.js';
import { createProfileStore, createVectorIndex, profileScopeKey, profileIndexIdentity, checkedPlan,
  checkedVector } from './vector-index.js';
import { createProfileUsage } from './profiles-usage.js';

const clone = value => structuredClone(value);
const RUNTIME_KEYS = new Set(['rawRecallDevice','rawRecallCpuThreads','rawRecallGpuThreads','rawRecallLlamaCpuServer',
  'rawRecallLlamaCudaServer','rawRecallLlamaServer','rawRecallLlamaGpuLayers','rawRecallThreads','rawRecallIdleMs',
  'rawRecallPrepareTimeoutMs','rawRecallIndexTimeoutMs']);
const encodingDefinition = definition => ({...definition,backend:{...definition.backend,
  config:Object.fromEntries(Object.entries(definition.backend.config).filter(([key])=>!RUNTIME_KEYS.has(key)))}});
const CONFIG_KEYS = new Set(['rawRecallPython', 'rawRecallCacheDir', 'rawRecallOnnxModel', 'rawRecallOnnxTokenizer',
  'rawRecallBgeModelDir', 'rawRecallThreads', 'rawRecallIdleMs', 'rawRecallMaxTokens', 'rawRecallQueryInstruction',
  'rawRecallPrepareTimeoutMs', 'rawRecallIndexTimeoutMs', 'rawRecallGgufModel', 'rawRecallLlamaServer',
  'rawRecallDevice', 'rawRecallCpuThreads', 'rawRecallGpuThreads', 'rawRecallLlamaCpuServer', 'rawRecallLlamaCudaServer',
  'rawRecallLlamaContext', 'rawRecallLlamaGpuLayers', 'rawRecallAllowCloud', 'rawRecallApiBase',
  'rawRecallApiKeyEnv', 'rawRecallApiKeyFile', 'rawRecallApiKeyService', 'rawRecallApiRevision']);
const NUMBERS = { rawRecallThreads: [1, 32], rawRecallIdleMs: [0, 3600000], rawRecallMaxTokens: [1, 128000],
  rawRecallCpuThreads: [1, 32], rawRecallGpuThreads: [1, 32],
  rawRecallPrepareTimeoutMs: [1000, 300000], rawRecallIndexTimeoutMs: [1000, 300000],
  rawRecallLlamaContext: [512, 32768], rawRecallLlamaGpuLayers: [-1, 128] };
const fail = (code, message) => { throw memoryError(code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
function keys(value, supported, label) {
  if (!plain(value)) fail('INVALID_PROFILE', `${label}必须为结构化对象`);
  const unknown = Object.keys(value).filter(key => !supported.includes(key));
  if (unknown.length) fail('UNSUPPORTED_PROFILE_FIELDS', `${label}不支持：${unknown.join(', ')}`);
}

/** Existing adapters only: generated code, arbitrary prefixes and pooling are
 * deliberately not interpreted. Accepted encoding fields must match the real
 * backend contract exactly, rather than merely being saved as unused settings. */
function normalizeProfile(input) {
  keys(input, ['id', 'label', 'model', 'dimensions', 'encoding', 'backend', 'adapter'], 'profile');
  const id = requiredText(input.id, '档位标识');
  if (input.label !== undefined) requiredText(input.label, '档位名称');
  requiredText(input.model, '向量模型');
  const backend = input.backend ?? {};
  keys(backend, ['engine', 'config'], 'backend');
  const config = backend.config ?? {}; keys(config, [...CONFIG_KEYS], 'backend.config');
  for (const [key, value] of Object.entries(config)) {
    if (NUMBERS[key]) {
      if (!Number.isSafeInteger(value) || value < NUMBERS[key][0] || value > NUMBERS[key][1]) fail('INVALID_PROFILE', `${key}超出支持范围`);
    } else if (key === 'rawRecallDevice') {
      if (!['auto', 'cpu', 'cuda'].includes(value)) fail('INVALID_PROFILE', '运行设备必须为 auto/cpu/cuda');
    } else if (key === 'rawRecallAllowCloud') {
      if (typeof value !== 'boolean') fail('INVALID_PROFILE', `${key}必须为 boolean`);
    } else if (typeof value !== 'string' || /[\u0000-\u001f]/u.test(value)) fail('INVALID_PROFILE', `${key}必须为单行字符串`);
  }
  const settings = { ...config, rawRecallModel: input.model, rawRecallDimensions: input.dimensions };
  if (input.dimensions !== undefined && (!Number.isSafeInteger(input.dimensions) || input.dimensions < 1)) fail('INVALID_PROFILE', '维数无效');
  const spec = rawModelSpec(settings), contract = modelContract(spec, settings);
  // A retained legacy API URL must not smuggle inline credentials even when
  // the currently selected local engine does not consume that setting.
  if (config.rawRecallApiBase) embeddingEndpoint(config.rawRecallApiBase);
  if (config.rawRecallMaxTokens !== undefined && config.rawRecallMaxTokens !== spec.maxTokens) fail('UNSUPPORTED_PROFILE_FIELDS', '此模型的 token 上限由现有后端固定，不能覆盖');
  if (config.rawRecallQueryInstruction && spec.family !== 'qwen3-embedding') fail('UNSUPPORTED_PROFILE_FIELDS', '此模型不支持自定义查询指令');
  if (backend.engine !== undefined && backend.engine !== spec.engine) fail('UNSUPPORTED_PROFILE_FIELDS', 'backend.engine 与现有模型不一致');
  const adapter = input.adapter ?? { type: 'existing-embedding', version: 1 };
  keys(adapter, ['type', 'version'], 'adapter');
  if (adapter.type !== 'existing-embedding' || adapter.version !== 1) fail('UNSUPPORTED_ADAPTER', '仅支持 existing-embedding v1 结构化适配');
  const encoding = input.encoding ?? {};
  const supported = ['query', 'document', 'pooling', 'normalization', 'maxTokens', 'windowing', 'tokenCounting'];
  keys(encoding, supported, 'encoding');
  for (const [key, value] of Object.entries(encoding)) if (value !== contract[key]) fail('UNSUPPORTED_PROFILE_FIELDS', `encoding.${key} 与实际后端不一致；实际值为 ${JSON.stringify(contract[key])}`);
  return { id, ...(input.label ? { label: input.label } : {}), model: spec.id, dimensions: spec.dimensions,
    encoding: Object.fromEntries(supported.map(key => [key, contract[key]])),
    backend: { engine: spec.engine, config: clone(config) }, adapter: clone(adapter) };
}

/** Convert installer/legacy settings to register input using the SAME allowlist
 * and actual model contract. Never copy the whole settings object (it may carry
 * old DB paths, unrelated switches or inline credentials). Disabled booleans
 * and zero idle time are meaningful; missing/blank values are not copied.
 */
export function profileFromLegacy({ id, label, settings } = {}) {
  if (!plain(settings)) fail('INVALID_PROFILE', '旧模型设置必须为结构化对象');
  requiredText(settings.rawRecallModel, '向量模型');
  const config = {};
  for (const key of CONFIG_KEYS) {
    const value = settings[key];
    if (value === undefined || value === null || typeof value === 'string' && !value.trim()) continue;
    config[key] = value;
  }
  const spec = rawModelSpec({ ...config, rawRecallModel: settings.rawRecallModel, rawRecallDimensions: settings.rawRecallDimensions });
  // Legacy configurations retain default knobs even for models whose backend
  // fixes their values. Represent the encoding actually used by that backend.
  if (config.rawRecallMaxTokens !== undefined) config.rawRecallMaxTokens = spec.maxTokens;
  if (spec.family !== 'qwen3-embedding') delete config.rawRecallQueryInstruction;
  return normalizeProfile({ id, ...(label !== undefined ? { label } : {}), model: spec.id,
    dimensions: spec.dimensions, backend: { config } });
}

function scopeEntry(state, scope, create = false) {
  let entry = state.scopes.find(row => row.ownerSubject === scope.ownerSubject && row.project === scope.project);
  if (!entry && create) {
    entry = { ...scope, assetCacheId: randomUUID(), profiles: [], selectedProfileId: null, active: null, progress: [] }; state.scopes.push(entry);
  }
  return entry;
}
function versionOf(entry, profileId, revision) {
  const group = entry?.profiles.find(row => row.id === profileId);
  const profile = group?.versions.find(row => row.revision === (revision ?? group.currentRevision));
  if (!profile) fail('PROFILE_NOT_FOUND', '档位或档位版本不存在');
  return profile;
}
function sameScope(row, scope) { return row.ownerSubject === scope.ownerSubject && row.project === scope.project; }
function publicSnapshot(generation) {
  return { id: generation.profileId, revision: generation.profileRevision, indexId: generation.id,
    indexIdentity: generation.indexIdentity, modelKey: generation.modelKey, dimensions: generation.dimensions,
    ownerSubject: generation.ownerSubject, project: generation.project };
}
function publicProgress(progress) {
  return progress ? clone(progress) : { state: 'unprepared', completed: 0, total: 0 };
}

/**
 * All methods take one options object. grant is mandatory except peek/ready/close.
 * ready({signal?}); register({profile,profileId?,grant,signal?,expectedRevision?});
 * select/prepare/load/release/cancel/status({profileId?,grant,signal?,expectedRevision?});
 * activeSnapshot({profileId?,grant,signal?,expectedRevision?});
 * query({query,profile?,profileId?,grant,signal?,expectedRevision?,limit=5});
 * incremental({profileId?,grant,signal?,expectedRevision?,changes?});
 * close({signal?}). prepare({resume:false}) discards a checkpoint, not old indices.
 * inspectRemoval({profileId,grant,signal?,expectedRevision?}) is host-only:
 * its cross-scope file references must NOT be forwarded to an HTTP/model tool.
 * removeMetadata({profileId,grant,signal?,expectedRevision?,detach?,clearIndex?,perform?})
 * holds an exclusive metadata lease; perform is a trusted host callback invoked
 * before metadata changes. dropIndex(common) calls it with clearIndex=true.
 * Non-management activeSnapshot/query grants pin the model until grant.cancel().
 * peek({ownerSubject?,project?}={}) is synchronous, unauthenticated metadata
 * only. With no scope it reports the sole configured scope, otherwise null
 * when several scopes are present. It never opens files or claims index-ready.
 * prepare defaults resume=true. Repeating prepare resumes after restart/cancel.
 * incremental changes=[{id,revision?}] is an optional hint; it reconciles all
 * currently listed documents, so omissions cannot leave withdrawn vectors active.
 * expectedRevision is always the configuration revision returned by status.
 * One file can contain isolated owner/project scopes. Each scope has ONE active
 * profile for ALL domains; no scope is inferred from caller-supplied profile data.
 */
export function createUnifiedProfiles({ file, indexFile, authorize, listDocuments, resolveDocument,
  listDocumentMetadata, createBackend = createEmbeddingBackend, now = Date.now, maxCatchUpPasses = 4,
  singleBackend = false, queryCandidateLimit } = {}) {
  if (file === indexFile) throw new TypeError('Profile and index files must differ');
  for (const fn of [authorize, listDocuments, resolveDocument, createBackend, now]) if (typeof fn !== 'function') throw new TypeError('Missing profile dependency');
  if (!Number.isSafeInteger(maxCatchUpPasses) || maxCatchUpPasses < 1 || maxCatchUpPasses > 64) throw new TypeError('Invalid catch-up bound');
  if (queryCandidateLimit !== undefined && (!Number.isSafeInteger(queryCandidateLimit) || queryCandidateLimit < 1)) throw new TypeError('Invalid query candidate bound');
  const settings = createProfileStore({ file, initial: () => ({ scopes: [] }) });
  const index = createVectorIndex({ file: indexFile });
  const usage = createProfileUsage({ file: file + '.embedding-usage.jsonl' });
  const backends = new Map(), jobs = new Map(), modelErrors = new Map(), shutdown = new AbortController();
  const retiringBackends = new Set();
  const queryPins = new Map(), pendingQueries = new Map(), removalToken = Symbol('profile-removal');
  let removing;
  let closed = false;
  let backendConstruction = Promise.resolve();

  function context(options = {}) {
    const { grant, signal, deadline, profileId, profileRevision } = options, permission = options[removalToken];
    const scope = { ownerSubject: grant?.ownerSubject, project: grant?.project };
    const combined = AbortSignal.any([signal, grant?.signal, shutdown.signal].filter(Boolean));
    const guard = () => {
      if (closed) fail('PROFILES_CLOSED', '档位管理已关闭');
      if (removing && permission !== removing) throw memoryError('MODEL_REMOVAL_BUSY', '正在移除模型，请稍后重试', 409);
      combined.throwIfAborted();
      if (authorize(grant) !== true || grant?.ownerSubject !== scope.ownerSubject || grant?.project !== scope.project) fail('MEMORY_ACCESS_DENIED', '记忆授权已失效');
      // The synchronous SQLite rank loop also checks this clock: a timer alone
      // cannot fire while a large vector scan owns the JavaScript thread.
      if (deadline !== undefined && (!Number.isFinite(deadline) || now() >= deadline)) fail('MEMORY_SEARCH_TIMEOUT', '向量查询超过共同截止时间');
      if (profileRevision !== undefined) {
        const saved=settings.peek();
        if(saved){
          const entry=scopeEntry(saved,scope),id=profileId??entry?.selectedProfileId;
          const current=entry?.profiles.find(row=>row.id===id);
          if(!current||current.currentRevision!==profileRevision)fail('PROFILE_CHANGED','管理操作的档位版本已变化，请刷新后重试');
        }
      }
    };
    guard(); requiredText(scope.ownerSubject, '授权主体'); requiredText(scope.project, '授权项目');
    return { scope, grant, signal: combined, guard, deadline, profileId, profileRevision };
  }
  async function stateFor(ctx, expectedRevision) {
    const state = await settings.read(ctx.guard); ctx.guard();
    if (!Array.isArray(state.scopes)) fail('INVALID_PROFILE_STORE', '档位作用域无效');
    if (expectedRevision !== undefined && state.revision !== expectedRevision) fail('MEMORY_REVISION_CONFLICT', '档位设置已变化');
    return { state, entry: scopeEntry(state, ctx.scope) };
  }
  function selected(entry, profileId) { return versionOf(entry, profileId ?? entry?.selectedProfileId); }
  function pinSnapshot(ctx, snapshot) {
    if (!snapshot || ctx.grant.kind === 'management' || !ctx.grant.signal) return;
    let pin = queryPins.get(ctx.grant);
    if (!pin) {
      const abort = () => queryPins.delete(ctx.grant);
      pin = { scope: ctx.scope, ids: new Set(), abort };
      ctx.grant.signal.addEventListener('abort', abort, { once: true }); queryPins.set(ctx.grant, pin);
    }
    pin.ids.add(snapshot.id);
  }
  async function inspectRemoval(ctx, profileId, expectedRevision) {
    const { state, entry } = await stateFor(ctx, expectedRevision), profile = versionOf(entry, profileId);
    const active = entry.active && versionOf(entry, entry.active.id, entry.active.revision);
    const reasons = [];
    if (active && (active.id === profileId || active.model === profile.model)) reasons.push('MODEL_ACTIVE');
    const job = jobs.get(profileScopeKey(ctx.scope));
    if (job?.profileId === profileId) reasons.push('MODEL_JOB_RUNNING');
    if ([...backends].some(([key, row]) => {
      const [owner, project, id] = JSON.parse(key);
      return owner === ctx.scope.ownerSubject && project === ctx.scope.project && id === profileId && row.users > 0;
    }) || retiringBackends.size > 0) reasons.push('MODEL_IN_USE');
    if ([...queryPins.values()].some(pin => sameScope(pin.scope, ctx.scope) && pin.ids.has(profileId)) ||
        [...pendingQueries.values()].some(pin => sameScope(pin, ctx.scope) && (!pin.profileId || pin.profileId === profileId))) reasons.push('MODEL_QUERY_PINNED');
    const referenceKeys = ['rawRecallPython', 'rawRecallCacheDir', 'rawRecallOnnxModel', 'rawRecallOnnxTokenizer',
      'rawRecallBgeModelDir', 'rawRecallGgufModel', 'rawRecallLlamaServer', 'rawRecallApiKeyFile'];
    const references = [];
    for (const scope of state.scopes) for (const group of scope.profiles) {
      if (sameScope(scope, ctx.scope) && group.id === profileId) continue;
      for (const version of group.versions) for (const key of referenceKeys) {
        const value = version.backend.config[key];
        if (typeof value === 'string' && value) references.push({ path: value, directory: ['rawRecallCacheDir', 'rawRecallBgeModelDir'].includes(key) });
      }
    }
    ctx.guard();
    return { revision: state.revision, profile: clone(profile), references, reasons: [...new Set(reasons)],
      index: index.profileStats({ scope: ctx.scope, profileId, guard: ctx.guard }) };
  }
  function backendKey(scope, profile) { return JSON.stringify([scope.ownerSubject, scope.project, profile.id, profile.revision]); }
  function cloudAllowed(scope, profile) {
    if (profile.backend.engine !== 'api') return;
    // Active snapshots intentionally survive normal edits. Explicit cloud
    // permission is different: the latest persisted opt-in is authoritative.
    const latest = versionOf(scopeEntry(settings.peek(), scope), profile.id);
    if (latest.backend.engine === 'api' && latest.backend.config.rawRecallAllowCloud !== true) {
      throw memoryError('CLOUD_PERMISSION_REVOKED', '此档位的云端使用许可已关闭', 403);
    }
  }
  function retireBackend(key, handle) {
    if (handle.disposal) return handle.disposal;
    if (backends.get(key) === handle) backends.delete(key);
    const task = Promise.resolve().then(() => handle.backend.dispose());
    handle.disposal = task;
    retiringBackends.add(task);
    task.then(() => retiringBackends.delete(task), () => retiringBackends.delete(task));
    return task;
  }
  async function revokeCloudBackends(scope, profileId, saved) {
    const group = scopeEntry(saved, scope).profiles.find(row => row.id === profileId);
    const revisions = new Set(group.versions.filter(row => row.backend.engine === 'api').map(row => row.revision));
    const disposals = [];
    for (const [key, handle] of backends) {
      const [owner, project, id, revision] = JSON.parse(key);
      if (owner !== scope.ownerSubject || project !== scope.project || id !== profileId || !revisions.has(revision)) continue;
      handle.retiring = true;
      for (const controller of handle.operations.keys()) controller.abort(memoryError('CLOUD_PERMISSION_REVOKED', '此档位的云端使用许可已关闭', 403));
      // Unlike ordinary release, revocation cancels in-flight queries too.
      // dispose drains the real backend's finally/onUsage receipt callbacks.
      disposals.push(retireBackend(key, handle));
    }
    await Promise.all(disposals);
  }
  async function interrupted(ctx, action) {
    ctx.guard(); let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(ctx.signal.reason ?? memoryError('PROFILE_CANCELLED', '操作已取消'));
      ctx.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const result = await Promise.race([Promise.resolve().then(() => { ctx.guard(); return action(); }), aborted]);
      ctx.guard(); return result;
    } finally { ctx.signal.removeEventListener('abort', onAbort); }
  }
  async function usingBackend(ctx, profile, action, kind = 'query') {
    const query = ctx.query;
    const operation = new AbortController();
    ctx = context({ grant: ctx.grant, signal: AbortSignal.any([ctx.signal, operation.signal]), deadline:ctx.deadline,
      profileId:ctx.profileId,profileRevision:ctx.profileRevision });
    if (query !== undefined) ctx.query = query;
    const authorized = ctx.guard;
    ctx.guard = () => { authorized(); cloudAllowed(ctx.scope, profile); };
    ctx.guard(); const key = backendKey(ctx.scope, profile);
    let handle, releaseConstruction;
    const previousConstruction = backendConstruction;
    if (singleBackend) backendConstruction = new Promise(resolve => { releaseConstruction = resolve; });
    try {
    if (singleBackend) {
      await previousConstruction; ctx.guard();
      await Promise.all([...retiringBackends]); ctx.guard();
    }
    // A device update may have completed while this operation waited for the
    // construction lease. Its encoding revision is stable; use fresh runtime.
    profile = versionOf(scopeEntry(settings.peek(), ctx.scope), profile.id, profile.revision);
    handle = backends.get(key);
    if (!handle) {
      // Portable owns one physical model. Do not retain an old profile process
      // while preparing another profile (or load two models concurrently).
      if (singleBackend) for (const [otherKey, other] of backends) if (otherKey !== key) {
        if (other.users) fail('EMBEDDING_BUSY', '另一个档位仍有在途任务，请稍后重试');
        other.retiring = true;
        await retireBackend(otherKey, other); ctx.guard();
      }
      let { entry } = await stateFor(ctx);
      if (!entry.assetCacheId) {
        const { value } = await settings.update(state => {
          scopeEntry(state, ctx.scope).assetCacheId ||= randomUUID();
        }, { guard: ctx.guard });
        entry = scopeEntry(value, ctx.scope);
      }
      ctx.guard();
      // The durable opaque scope ID avoids filesystem-unsafe owner/project
      // names. Profile revision is persistent and isolates every encoding.
      if (!/^[a-f0-9-]{36}$/i.test(entry.assetCacheId) || !/^[a-f0-9-]{36}$/i.test(profile.revision)) fail('INVALID_PROFILE_STORE', '模型缓存持久标识无效');
      const cacheFile = path.join(path.dirname(file), 'profile-assets', entry.assetCacheId, profile.revision, 'asset-fingerprints.json');
      const identity = { scope: clone(ctx.scope), profile: { id: profile.id, revision: profile.revision } };
      const onUsage = receipt => usage.record(receipt, identity);
      // Another operation may have constructed this adapter during metadata I/O.
      handle = backends.get(key);
      if (!handle) {
        const backend = createBackend({ config: { ...clone(profile.backend.config), rawRecallModel: profile.model,
          rawRecallDimensions: profile.dimensions }, profile: clone(profile), scope: clone(ctx.scope), cacheFile, onUsage });
        // The backend factory constructs an adapter; prepare() owns asynchronous
        // model loading. Keeping construction synchronous avoids duplicate models.
        if (!backend || !['prepare', 'planChunks', 'embed', 'dispose'].every(name => typeof backend[name] === 'function')) fail('INVALID_EMBEDDING_BACKEND', '向量后端接口不完整');
        handle = { backend, users: 0, retiring: false, operations: new Map() }; backends.set(key, handle);
      }
    }
    if (handle.retiring) fail('EMBEDDING_RELEASING', '模型正在释放，请稍后重新加载');
    handle.users++;
    handle.operations.set(operation, kind);
    } finally { releaseConstruction?.(); }
    try {
      ctx.guard();
      let identity;
      try {
        identity = await interrupted(ctx, () => handle.backend.prepare()); modelErrors.delete(key);
      } catch (error) {
        if (!ctx.signal.aborted) modelErrors.set(key, error.code || 'MODEL_NOT_READY');
        throw error;
      }
      ctx.guard();
      if (!identity || typeof identity.modelKey !== 'string' || !identity.modelKey || identity.dimensions !== profile.dimensions) fail('EMBEDDING_IDENTITY_MISMATCH', '模型身份或维数不一致');
      return await interrupted(ctx, () => action(handle.backend, identity, ctx));
    } catch (error) {
      if(error.code==='PROFILE_CHANGED'&&ctx.profileRevision!==undefined)handle.retiring=true;
      throw error;
    } finally {
      handle.users--;
      handle.operations.delete(operation);
      if (ctx.signal.aborted && (kind !== 'query' || ctx.queryDispatched)) handle.retiring = true;
      if (handle.retiring && !handle.users) await retireBackend(key, handle);
    }
  }
  async function documents(ctx) {
    ctx.guard(); const rows = [], ids = new Set();
    const iterable = await listDocuments({ grant: ctx.grant, signal: ctx.signal }); ctx.guard();
    for await (const row of iterable) {
      ctx.guard(); requiredText(row?.id, '文档标识');
      if (!(typeof row.revision === 'string' && row.revision || Number.isSafeInteger(row.revision) && row.revision >= 0)) fail('INVALID_DOCUMENT', '文档缺少持久版本');
      requiredText(row.domain, '文档领域');
      if (typeof row.text !== 'string' || !Array.isArray(row.sourceIds) || !row.sourceIds.length || row.sourceIds.some(id => typeof id !== 'string' || !id)) fail('INVALID_DOCUMENT', '文档缺少原文或来源');
      if (row.ownerSubject !== undefined && row.ownerSubject !== ctx.scope.ownerSubject || row.project !== undefined && row.project !== ctx.scope.project) fail('MEMORY_SCOPE_CONFLICT', '文档范围与授权不一致');
      if (ids.has(row.id)) fail('DUPLICATE_DOCUMENT', '全域文档标识必须唯一');
      ids.add(row.id); rows.push(clone(row));
    }
    ctx.guard(); return rows;
  }
  async function resolve(ctx, document) {
    ctx.guard();
    const result = await resolveDocument({ id: document.id, revision: document.revision, grant: ctx.grant, signal: ctx.signal,
      ...(document.anchor !== undefined ? { anchor: document.anchor } : {}),
      ...(ctx.query !== undefined ? {query:ctx.query} : {}) }); ctx.guard();
    if (result == null) return null;
    const records = Array.isArray(result) ? result : Array.isArray(result.records) ? result.records : [result];
    if (!records.length) return null;
    const embedding = document.anchor?.embedding;
    let matched = false;
    for (const record of records) {
      if (!record || typeof record.id !== 'string' || typeof record.text !== 'string' || record.revision === undefined ||
          record.ownerSubject !== undefined && record.ownerSubject !== ctx.scope.ownerSubject ||
          record.project !== undefined && record.project !== ctx.scope.project) fail('INVALID_RESOLVED_DOCUMENT', '来源复核结果无效');
      if (record.id === document.id) {
        if (record.revision !== document.revision || embedding && !isDeepStrictEqual(record.anchor?.embedding, embedding)) return null;
        matched = true;
      }
    }
    return embedding && !matched ? null : clone(records);
  }
  async function updateProgress(ctx, profile, patch) {
    const { value } = await settings.update(state => {
      const entry = scopeEntry(state, ctx.scope, true);
      let progress = entry.progress.find(row => row.profileId === profile.id && row.profileRevision === profile.revision);
      if (!progress) { progress = { profileId: profile.id, profileRevision: profile.revision }; entry.progress.push(progress); }
      Object.assign(progress, patch, { updatedAt: now() });
    }, { guard: ctx.guard });
    return value;
  }
  const sameDocument = (a, b) => a && b && a.id === b.id && a.revision === b.revision && a.domain === b.domain &&
    isDeepStrictEqual(a.sourceIds, b.sourceIds) && isDeepStrictEqual(a.anchor, b.anchor);
  function intentFor(entry, profile) {
    const progress = entry?.progress.find(row => row.profileId === profile?.id && row.profileRevision === profile?.revision);
    return { profile: clone(profile ?? null), intentId: progress?.intentId ?? null, state: progress?.state ?? 'unprepared' };
  }
  function stopJob(scope, profileId, profileRevision) {
    const job = jobs.get(profileScopeKey(scope));
    if (!job || profileId && job.profileId !== profileId || profileRevision!==undefined&&job.profileRevision!==profileRevision) return null;
    job.controller.abort(memoryError('PROFILE_CANCELLED', '档位准备已取消'));
    return job;
  }

  async function build(options = {}, incremental = false) {
    const outer = context(options);
    const { entry } = await stateFor(outer, options.expectedRevision);
    if (incremental && (!entry?.active || options.profileId && options.profileId !== entry.active.id)) fail('PROFILE_NOT_ACTIVE', '增量更新只作用于已生效档位');
    const profile = incremental ? versionOf(entry, entry.active.id, entry.active.revision) : selected(entry, options.profileId);
    if (options.profile && (options.profile.id !== profile.id || options.profile.revision !== profile.revision)) fail('PROFILE_CHANGED', '原向量档位版本已变化');
    const previousIntent = intentFor(entry, profile);
    if (options.intentId !== undefined && (previousIntent.intentId !== options.intentId || previousIntent.state === 'cancelled')) fail('PROFILE_CANCELLED', '原准备意图已取消或被替换');
    if (incremental && previousIntent.state === 'cancelled') fail('PROFILE_CANCELLED', '向量任务已取消，需明确重新准备');
    if (!incremental && entry.selectedProfileId !== profile.id) fail('PROFILE_NOT_SELECTED', '请先选择待准备档位');
    const jobKey = profileScopeKey(outer.scope);
    if (jobs.has(jobKey)) fail('PROFILE_BUSY', '该资料范围正在准备索引');
    const controller = new AbortController();
    const ctx = context({ ...options, signal: AbortSignal.any([outer.signal, controller.signal]) });
    const job = { controller, profileId: profile.id, profileRevision:profile.revision, done: null }; jobs.set(jobKey, job);
    job.done = (async () => {
      try {
        let initialRows;
        if(incremental&&previousIntent.state==='ready'){
          initialRows=await documents(ctx);
          const activeDocuments=index.documents({scope:ctx.scope,snapshotId:entry.active.indexId,guard:ctx.guard});
          const byId=new Map(activeDocuments.map(row=>[row.id,row]));
          if(activeDocuments.length===initialRows.length&&initialRows.every(row=>sameDocument(byId.get(row.id),row)))
            return {profile:clone(entry.active),state:'ready',completed:initialRows.length,unchanged:true};
        }
        await updateProgress(ctx, profile, { state: 'preparing', error: null,
          intentId: incremental || options.intentId !== undefined ? previousIntent.intentId ?? randomUUID() : randomUUID() });
        return await usingBackend(ctx, profile, async (backend, identity, ctx) => {
          const indexIdentity = profileIndexIdentity({ profileId: profile.id, profileRevision: profile.revision, modelKey: identity.modelKey });
          if (options.profile?.modelKey && options.profile.modelKey !== identity.modelKey) fail('EMBEDDING_IDENTITY_MISMATCH', '原向量模型资源身份已变化');
          const rows = initialRows??await documents(ctx); // Existing authorized raw+derived nodes at this boundary.
          const checkpoint = index.checkpoint({ scope: ctx.scope, profile, modelKey: identity.modelKey,
            indexIdentity, resume: options.resume, now: now(), guard: ctx.guard });
          const checkpointArgs = { scope: ctx.scope, snapshotId: checkpoint.id, guard: ctx.guard };
          async function encode(row) {
            if (!await resolve(ctx, row)) { index.remove({ ...checkpointArgs, id: row.id }); return; }
            const old = index.document({ ...checkpointArgs, id: row.id });
            if (sameDocument(old, row)) return;
            // Run inside the backend queue as well as the chunk planner, after
            // any loading/waiting and before each source-bearing request.
            const authorize = async () => {
              if (!await resolve(ctx, row)) fail('EMBEDDING_SOURCE_CHANGED', '向量来源已改版或撤回');
              return true;
            };
            try {
              const timeoutMs = profile.backend.config.rawRecallIndexTimeoutMs ?? 30000;
              const planOptions = { signal: ctx.signal, authorize, scope: ctx.scope, timeoutMs };
              const maxTokens = profile.encoding.maxTokens;
              const plan = checkedPlan(row.text, await backend.planChunks(row.text, planOptions), maxTokens); ctx.guard();
              const contextual = row.domain === 'raw' && row.embedding?.prefix;
              const chunks = [];
              const batchSize = Math.max(1, Math.min(16, backend.batchSize || 1));
              for (let offset = 0; offset < plan.length; offset += batchSize) {
                ctx.guard(); const parts = plan.slice(offset, offset + batchSize);
                if (contextual) for (let i = 0; i < parts.length; i++) {
                  parts[i] = await planRawEmbeddingChunk(parts[i], row.embedding, (text, maxChars) =>
                    backend.planChunks(text, { ...planOptions, maxChars }), maxTokens);
                  ctx.guard();
                }
                const vectors = await backend.embed(parts.map(part => part.text), { kind: 'document', signal: ctx.signal,
                  authorize, scope: ctx.scope, timeoutMs }); ctx.guard();
                if (!Array.isArray(vectors) || vectors.length !== parts.length || backend.modelKey !== identity.modelKey) fail('EMBEDDING_IDENTITY_MISMATCH', '文档编码身份已变化');
                chunks.push(...parts.map((part, i) => ({ start: part.start, end: part.end, tokenBound: part.tokenBound,
                  ...(part.textHash ? { textHash: part.textHash } : {}), vector: checkedVector(vectors[i], identity.dimensions) })));
              }
              if (!await resolve(ctx, row)) { index.remove({ ...checkpointArgs, id: row.id }); return; }
              index.put({ ...checkpointArgs, dimensions: identity.dimensions, document: {
                id: row.id, revision: row.revision, domain: row.domain, sourceIds: row.sourceIds,
                ...(row.anchor !== undefined ? { anchor: row.anchor } : {}), chunks } });
            } catch (error) {
              if (error.code !== 'EMBEDDING_SOURCE_CHANGED') throw error;
              ctx.guard();
              // Drop just this document's old result. The existing bounded
              // catch-up passes/notifications reconcile its current version.
              index.remove({ ...checkpointArgs, id: row.id });
            }
          }
          await updateProgress(ctx, profile, { completed: 0, total: rows.length, checkpointId: checkpoint.id });
          let current = rows, caughtUp = false;
          for (let pass = 0; pass < maxCatchUpPasses; pass++) {
            const ids = new Set(current.map(row => row.id));
            for (const old of index.documents(checkpointArgs)) if (!ids.has(old.id)) index.remove({ ...checkpointArgs, id: old.id });
            let completed = 0;
            for (const row of current) {
              await encode(row);
              if (sameDocument(index.document({ ...checkpointArgs, id: row.id }), row)) completed++;
              await updateProgress(ctx, profile, { completed, total: current.length, pass: pass + 1 });
            }
            // Include every currently existing domain. Future semantic output is
            // never awaited. A changing boundary keeps the durable checkpoint.
            current = await documents(ctx);
            const members = index.documents(checkpointArgs), byId = new Map(members.map(row => [row.id, row]));
            caughtUp = members.length === current.length && current.every(row => sameDocument(byId.get(row.id), row));
            if (caughtUp) {
              for (const row of current) if (!await resolve(ctx, row)) { caughtUp = false; break; }
              // Re-scan after async source proof checks, which may themselves yield.
              const boundary = await documents(ctx);
              caughtUp &&= boundary.length === current.length && boundary.every(row => sameDocument(byId.get(row.id), row));
              current = boundary;
            }
            if (caughtUp) break;
          }
          if (!caughtUp) {
            await updateProgress(ctx, profile, { total: current.length,
              completed: current.filter(row => sameDocument(index.document({ ...checkpointArgs, id: row.id }), row)).length });
            fail('DOCUMENTS_CHANGED', '资料持续变化，保留检查点等待有界续接');
          }
          ctx.guard();
          if (backend.modelKey !== identity.modelKey) fail('EMBEDDING_IDENTITY_MISMATCH', '索引编码身份已变化');
          const generation = index.finish(checkpointArgs);
          const snapshot = publicSnapshot(generation);
          const { value } = await settings.update(state => {
            const latest = scopeEntry(state, ctx.scope), currentProfile = versionOf(latest, profile.id);
            if (currentProfile.revision !== profile.revision) fail('PROFILE_CHANGED', '档位适配已变化');
            if (!incremental && latest.selectedProfileId !== profile.id) fail('PROFILE_CHANGED', '所选档位已变化');
            if (incremental && latest.active && (latest.active.id !== profile.id || latest.active.revision !== profile.revision)) fail('PROFILE_CHANGED', '活动档位已切换');
            latest.active = snapshot;
            const progress = latest.progress.find(row => row.profileId === profile.id && row.profileRevision === profile.revision);
            Object.assign(progress, { state: 'ready', completed: current.length, total: current.length, error: null, updatedAt: now() });
          }, { guard: ctx.guard });
          ctx.guard(); return { revision: value.revision, profile: snapshot, state: 'ready', completed: current.length };
        }, 'document');
      } catch (error) {
        // A shutdown preserves the original intent. Revocation cannot write on
        // its own behalf; resuming always requires a fresh authorized grant.
        try {
          outer.guard(); await updateProgress(outer, profile, { state: controller.signal.aborted || outer.signal.aborted ? 'cancelled' : error.code === 'DOCUMENTS_CHANGED' ? 'paused' : 'error', error: error.code || 'PROFILE_PREPARATION_FAILED' });
        } catch { /* authorization loss leaves last persisted checkpoint intact */ }
        throw error;
      } finally { if (jobs.get(jobKey) === job) jobs.delete(jobKey); }
    })();
    return job.done;
  }

  const api = {
    async inspectRemoval(options = {}) {
      const ctx = context(options); requiredText(options.profileId, '档位标识');
      return inspectRemoval(ctx, options.profileId, options.expectedRevision);
    },
    async removeMetadata(options = {}) {
      context(options); requiredText(options.profileId, '档位标识');
      if (options.perform !== undefined && typeof options.perform !== 'function') throw new TypeError('Removal callback must be a trusted function');
      const token = {}; removing = token;
      const ctx = context({ ...options, [removalToken]: token });
      let operation, indexCleared = false, metadataUpdated = false, dropped = { snapshots: 0, documents: 0, chunks: 0 };
      try {
        const inspected = await inspectRemoval(ctx, options.profileId, options.expectedRevision);
        if (inspected.reasons.length) throw memoryError(inspected.reasons[0], '型号仍在使用，不能移除', 409);
        for (const [key, handle] of [...backends]) {
          const [owner, project, id] = JSON.parse(key);
          if (owner === ctx.scope.ownerSubject && project === ctx.scope.project && id === options.profileId) await retireBackend(key, handle);
        }
        ctx.guard();
        operation = await options.perform?.({ ...inspected, guard: ctx.guard }); ctx.guard();
        if (options.clearIndex === true) { dropped = index.dropProfile({ scope: ctx.scope, profileId: options.profileId, guard: ctx.guard }); indexCleared = true; }
        let revision = inspected.revision, profileRevision = inspected.profile.revision;
        if (options.detach === true || options.clearIndex === true) {
          const saved = await settings.update(state => {
            const entry = scopeEntry(state, ctx.scope), group = entry.profiles.find(row => row.id === options.profileId);
            if (options.clearIndex === true) entry.progress = entry.progress.filter(row => row.profileId !== options.profileId);
            if (options.detach === true) {
              const old = versionOf(entry, options.profileId), config = clone(old.backend.config);
              for (const key of ['rawRecallPython', 'rawRecallCacheDir', 'rawRecallOnnxModel', 'rawRecallOnnxTokenizer',
                'rawRecallBgeModelDir', 'rawRecallGgufModel', 'rawRecallLlamaServer', 'rawRecallApiKeyFile', 'rawRecallApiKeyEnv']) delete config[key];
              if (old.backend.engine === 'api') config.rawRecallAllowCloud = false;
              if (!isDeepStrictEqual(config, old.backend.config)) {
                const next = normalizeProfile({ id: old.id, ...(old.label ? { label: old.label } : {}), model: old.model,
                  dimensions: old.dimensions, encoding: old.encoding, adapter: old.adapter, backend: { config } });
                group.versions.push({ ...next, revision: randomUUID(), createdAt: now() });
                group.currentRevision = group.versions.at(-1).revision;
              }
              profileRevision = group.currentRevision;
            }
          }, { guard: ctx.guard, expectedRevision: inspected.revision });
          revision = saved.value.revision;
          metadataUpdated = true;
        }
        ctx.guard(); return { revision, profileRevision, detached: options.detach === true,
          indexCleared: options.clearIndex === true, index: dropped, operation };
      } catch (error) {
        if (operation !== undefined || error.operation !== undefined) error.operation = { ...(error.operation ?? operation),
          indexCleared, detached: metadataUpdated && options.detach === true, index: dropped };
        throw error;
      } finally { if (removing === token) removing = undefined; }
    },
    dropIndex(options = {}) { return api.removeMetadata({ ...options, clearIndex: true, detach: false, perform: undefined }); },
    peek({ ownerSubject, project } = {}) {
      const state = settings.peek();
      const scopes = state?.scopes ?? [];
      const explicit = ownerSubject !== undefined || project !== undefined;
      const entry = explicit ? scopes.find(row => row.ownerSubject === ownerSubject && row.project === project)
        : scopes.length === 1 ? scopes[0] : null;
      const active = entry?.active;
      const definition = active ? entry.profiles?.find(row => row.id === active.id)?.versions?.find(row => row.revision === active.revision) : null;
      return { loaded: Boolean(state), revision: state?.revision ?? null,
        selectedProfileId: entry?.selectedProfileId ?? null,
        activeProfile: definition ? { id: definition.id, revision: definition.revision,
          model: definition.model, dimensions: definition.dimensions } : null };
    },
    async ready({ signal } = {}) {
      if (closed) fail('PROFILES_CLOSED', '档位管理已关闭'); signal?.throwIfAborted();
      const state = await settings.read(() => signal?.throwIfAborted());
      if (!Array.isArray(state.scopes)) fail('INVALID_PROFILE_STORE', '档位作用域无效');
      return { revision: state.revision }; // Never read the vector index or personal source DB.
    },
    async register(options = {}) {
      const ctx = context(options), normalized = normalizeProfile(options.profile);
      if (options.profileId !== undefined && options.profileId !== normalized.id) fail('INVALID_PROFILE', 'profileId 与 profile.id 不一致');
      const before = await stateFor(ctx, options.expectedRevision);
      const existingGroup = before.entry?.profiles.find(row => row.id === normalized.id);
      const existing = existingGroup?.versions.find(row => row.revision === existingGroup.currentRevision);
      if (existing) {
        const {revision,createdAt,...definition} = existing;
        if (!isDeepStrictEqual(definition, normalized) && isDeepStrictEqual(encodingDefinition(definition),encodingDefinition(normalized))) {
          return api.updateRuntime({...options,profileId:existing.id,profileRevision:revision,
            config:Object.fromEntries(Object.entries(normalized.backend.config).filter(([key])=>RUNTIME_KEYS.has(key))),replace:true});
        }
      }
      const { value, result } = await settings.update(state => {
        const entry = scopeEntry(state, ctx.scope, true);
        let group = entry.profiles.find(row => row.id === normalized.id);
        const current = group?.versions.find(row => row.revision === group.currentRevision);
        if (current) {
          const { revision, createdAt, ...definition } = current;
          if (isDeepStrictEqual(definition, normalized)) return current;
          stopJob(ctx.scope, normalized.id);
        }
        const profile = { ...normalized, revision: randomUUID(), createdAt: now() };
        if (!group) { group = { id: profile.id, versions: [] }; entry.profiles.push(group); }
        group.versions.push(profile); group.currentRevision = profile.revision;
        return profile;
      }, { guard: ctx.guard, expectedRevision: options.expectedRevision });
      if (result.backend.engine === 'api' && result.backend.config.rawRecallAllowCloud !== true) await revokeCloudBackends(ctx.scope, result.id, value);
      ctx.guard(); return { revision: value.revision, profile: clone(result) };
    },
    async updateRuntime(options = {}) {
      const ctx=context(options);requiredText(options.profileId,'档位标识');
      keys(options.config,[...RUNTIME_KEYS],'runtime config');
      const {entry}=await stateFor(ctx,options.expectedRevision),profile=versionOf(entry,options.profileId,options.profileRevision);
      const config=options.replace?Object.fromEntries(Object.entries(profile.backend.config).filter(([key])=>!RUNTIME_KEYS.has(key))):{...profile.backend.config};
      Object.assign(config,options.config);
      const {revision,createdAt,...definition}=profile;
      const normalized=normalizeProfile({...definition,backend:{...definition.backend,config}});
      const previous=backendConstruction;let release;
      backendConstruction=new Promise(resolve=>{release=resolve;});
      try {
        await previous;ctx.guard();
        const key=backendKey(ctx.scope,profile),handle=backends.get(key);
        if(handle){
          // Existing requests finish using their frozen encoding. New loads
          // wait behind this lease; a cancelled update never mutates settings.
          while(handle.users){await interrupted(ctx,()=>new Promise(resolve=>setTimeout(resolve,10)));ctx.guard();}
          handle.retiring=true;await retireBackend(key,handle);ctx.guard();
        }
        const {value,result}=await settings.update(state=>{
          const current=versionOf(scopeEntry(state,ctx.scope),profile.id,profile.revision);
          const {revision:currentRevision,createdAt:currentTime,...currentDefinition}=current;
          if(!isDeepStrictEqual(encodingDefinition(currentDefinition),encodingDefinition(normalized)))fail('PROFILE_CHANGED','档位编码配置已变化');
          current.backend.config=clone(normalized.backend.config);return current;
        },{guard:ctx.guard,expectedRevision:options.expectedRevision});
        ctx.guard();return {revision:value.revision,profile:clone(result),runtimeOnly:true,indexPreserved:true};
      } finally {release();}
    },
    async select(options = {}) {
      const ctx = context(options); requiredText(options.profileId, '档位标识');
      await settings.update(state => {
        const entry = scopeEntry(state, ctx.scope); versionOf(entry, options.profileId);
        stopJob(ctx.scope); entry.selectedProfileId = options.profileId;
      }, { guard: ctx.guard, expectedRevision: options.expectedRevision });
      ctx.guard(); return api.status({ ...options, expectedRevision: undefined });
    },
    prepare(options = {}) { return build(options); },
    incremental(options = {}) { return build(options, true); },
    // Trusted host metadata for freezing queue work; no source/index read.
    vectorIntent({ ownerSubject, project } = {}) {
      const entry = scopeEntry(settings.peek() ?? { scopes: [] }, { ownerSubject, project });
      return { ...intentFor(entry, entry?.active), preparing: jobs.has(profileScopeKey({ ownerSubject, project })) };
    },
    async resumePreparation(options = {}) {
      const ctx = context(options), { entry } = await stateFor(ctx, options.expectedRevision);
      requiredText(options.intentId, '原准备意图'); requiredText(options.profileRevision, '原档位版本');
      const profile = selected(entry, options.profileId), original = intentFor(entry, profile);
      if (profile.revision !== options.profileRevision || original.intentId !== options.intentId ||
          !['preparing', 'paused', 'error'].includes(original.state)) fail('PROFILE_CANCELLED', '原准备意图已取消、完成或配置已变化');
      return build({ ...options, profile, resume: true });
    },
    async coverage(options = {}) {
      const ctx = context(options), { entry } = await stateFor(ctx, options.expectedRevision);
      if (typeof listDocumentMetadata !== 'function') fail('COVERAGE_METADATA_UNAVAILABLE', '需接入只含来源版本的全域元数据枚举');
      const snapshot = clone(Object.hasOwn(options, 'profile') ? options.profile : entry?.active ?? null);
      let members = [];
      if (snapshot) {
        const generation = index.generation({ scope: ctx.scope, snapshotId: snapshot.indexId, guard: ctx.guard });
        if (!isDeepStrictEqual(publicSnapshot(generation), snapshot)) fail('INVALID_PROFILE_SNAPSHOT', '覆盖快照身份无效');
        members = index.documents({ scope: ctx.scope, snapshotId: snapshot.indexId, guard: ctx.guard });
      }
      const byId = new Map(members.map(row => [row.id, row])), ids = new Set();
      let total = 0, completed = 0;
      const domains = Object.create(null);
      for await (const row of await listDocumentMetadata({ grant: ctx.grant, signal: ctx.signal })) {
        ctx.guard(); requiredText(row?.id, '文档标识'); requiredText(row.domain, '文档领域');
        if (row.revision === undefined || !Array.isArray(row.sourceIds) || !row.sourceIds.length || ids.has(row.id)) fail('INVALID_DOCUMENT', '来源版本元数据无效');
        if (row.ownerSubject !== undefined && row.ownerSubject !== ctx.scope.ownerSubject || row.project !== undefined && row.project !== ctx.scope.project) fail('MEMORY_SCOPE_CONFLICT', '来源元数据范围不一致');
        ids.add(row.id); total++;
        const count = domains[row.domain] ??= { total: 0, completed: 0, pending: 0 };
        count.total++;
        if (sameDocument(byId.get(row.id), row)) { completed++; count.completed++; } else count.pending++;
      }
      const removed = members.filter(row => !ids.has(row.id)).length;
      const outdated = members.filter(row => ids.has(row.id)).length - completed;
      const progress = snapshot ? intentFor(entry, snapshot) : null;
      ctx.guard(); return { profile: snapshot, total, completed, pending: total - completed, stale: removed + outdated,
        removed, outdated, domains, caughtUp: Boolean(snapshot) && completed === total && removed === 0,
        state: !snapshot ? 'unprepared' : completed === total && removed === 0 ? 'ready' : 'pending',
        lastPreparation: progress ? publicProgress(entry.progress.find(row => row.profileId === snapshot.id && row.profileRevision === snapshot.revision)) : publicProgress(null) };
    },
    async load(options = {}) {
      const ctx = context(options), { state, entry } = await stateFor(ctx, options.expectedRevision);
      const profile = selected(entry, options.profileId);
      return usingBackend(ctx, profile, async (backend, identity, ctx) => {
        ctx.guard(); return { revision: state.revision, profileId: profile.id, profileRevision: profile.revision,
          loaded: true, modelKey: identity.modelKey, dimensions: identity.dimensions };
      }, 'load');
    },
    async release(options = {}) {
      const ctx = context(options), { state, entry } = await stateFor(ctx, options.expectedRevision);
      const profileId = options.profileId ?? entry?.selectedProfileId; versionOf(entry, profileId);
      stopJob(ctx.scope, profileId, options.profileRevision);
      for (const [key, handle] of backends) {
        const [owner, project, id, revision] = JSON.parse(key);
        if (owner === ctx.scope.ownerSubject && project === ctx.scope.project && id === profileId &&
          (options.profileRevision===undefined||revision===options.profileRevision)) {
          handle.retiring = true;
          for (const [controller, kind] of handle.operations) if (kind !== 'query') controller.abort(memoryError('PROFILE_RELEASED', '模型已释放'));
          if (!handle.users) { await retireBackend(key, handle); ctx.guard(); }
        }
      }
      return { revision: state.revision, profileId, state: 'released', queriesMayStillBeDraining: [...backends].some(([key, row]) => {
        const [owner, project, id, revision] = JSON.parse(key); return owner === ctx.scope.ownerSubject && project === ctx.scope.project && id === profileId &&
          (options.profileRevision===undefined||revision===options.profileRevision)&&row.users > 0;
      }) };
    },
    async cancel(options = {}) {
      const ctx = context(options), { state: before, entry } = await stateFor(ctx, options.expectedRevision);
      const profile = selected(entry, options.profileId); const job = stopJob(ctx.scope, profile.id, options.profileRevision);
      const handle = backends.get(backendKey(ctx.scope, profile));
      let cancelledLoad = false;
      for (const [controller, kind] of handle?.operations ?? []) if (kind === 'load') { controller.abort(memoryError('PROFILE_CANCELLED', '加载已取消')); cancelledLoad = true; }
      // Cancellation does not release a backend needed by pinned queries.
      const progress = entry.progress.find(row => row.profileId === profile.id && row.profileRevision === profile.revision);
      const state = job || progress
        ? await updateProgress(ctx, profile, { state: 'cancelled', intentId: randomUUID(), error: null }) : before;
      ctx.guard();
      return { revision: state.revision, profileId: profile.id, cancelled: Boolean(job) || cancelledLoad };
    },
    async status(options = {}) {
      const ctx = context(options), { state, entry } = await stateFor(ctx, options.expectedRevision);
      if (options.profileId) versionOf(entry, options.profileId);
      const profiles = await Promise.all((entry?.profiles ?? []).filter(row => !options.profileId || row.id === options.profileId).map(async group => {
        const profile = versionOf(entry, group.id), handle = backends.get(backendKey(ctx.scope, profile));
        const progress = publicProgress(entry.progress.find(row => row.profileId === profile.id && row.profileRevision === profile.revision));
        // No live process after restart; an interrupted checkpoint needs resume.
        if (progress.state === 'preparing' && !jobs.has(profileScopeKey(ctx.scope))) progress.state = 'paused';
        const error = modelErrors.get(backendKey(ctx.scope, profile)) ?? null;
        const loaded = Boolean(handle?.backend.modelKey);
        const modelState = handle?.retiring ? 'releasing' : loaded ? 'loaded' : error ? 'unavailable' : handle?.users ? 'loading' : 'unloaded';
        let embeddingUsage;
        try {
          ctx.guard(); embeddingUsage = await usage.summary({ ...ctx.scope, profileId: profile.id }); ctx.guard();
        } catch (cause) {
          ctx.guard(); embeddingUsage = { calls: null, reportedTokens: null, unknownUsageCalls: null,
            totalTokens: null, recordingError: cause.code || 'EMBEDDING_USAGE_READ_FAILED' };
        }
        const runtimeStatus = handle?.backend.status?.() ?? {};
        const deviceFields = Object.fromEntries(['requestedDevice','actualDevice','fallbackReason','runtime','idleReleaseMs'].filter(key=>runtimeStatus[key]!==undefined).map(key=>[key,clone(runtimeStatus[key])]));
        return { ...clone(profile), progress, loaded, modelState, modelError: error, releasing: Boolean(handle?.retiring), embeddingUsage,
          requestedDevice:profile.backend.config.rawRecallDevice??'auto',actualDevice:null,...deviceFields };
      }));
      ctx.guard(); return { revision: state.revision, selectedProfileId: entry?.selectedProfileId ?? null,
        activeProfileId: entry?.active?.id ?? null, active: clone(entry?.active ?? null), profiles };
    },
    async activeSnapshot(options = {}) {
      const ctx = context(options), { entry } = await stateFor(ctx, options.expectedRevision); ctx.guard();
      if (options.profileId && entry?.active?.id !== options.profileId) fail('PROFILE_NOT_ACTIVE', '请求档位尚未生效');
      const snapshot = clone(entry?.active ?? null); pinSnapshot(ctx, snapshot); return snapshot;
    },
    async query(options = {}) {
      const ctx = context(options), requestId = randomUUID();
      ctx.query = options.query;
      pendingQueries.set(requestId, { ...ctx.scope, profileId: options.profile?.id ?? options.profileId ?? null });
      try {
      const { entry } = await stateFor(ctx, options.expectedRevision);
      requiredText(options.query, '查询', 2000);
      const limit = options.limit ?? 5;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 40) fail('INVALID_QUERY_LIMIT', '查询条数应为 1–40');
      const { minSimilarity } = options;
      if (minSimilarity !== undefined && !Number.isFinite(minSimilarity)) fail('INVALID_QUERY_SIMILARITY', '查询相似度下限必须为有限数值');
      const matchesReference = record => options.referenceOnly !== true ||
        (['entry', 'note'].includes(record.anchor?.ref?.storage) && record.state?.validity === 'current');
      const snapshot = clone(Object.hasOwn(options, 'profile') ? options.profile : entry?.active);
      if (!snapshot) return { records: [], profile: null, state: 'unprepared' };
      if (!sameScope(snapshot, ctx.scope) || options.profileId && options.profileId !== snapshot.id) fail('MEMORY_SCOPE_CONFLICT', '档位快照不属于当前授权范围');
      const snapshotArgs = { scope: ctx.scope, snapshotId: snapshot.indexId, guard: ctx.guard };
      const generation = index.generation(snapshotArgs); ctx.guard();
      if (!generation || !isDeepStrictEqual(publicSnapshot(generation), snapshot)) fail('INVALID_PROFILE_SNAPSHOT', '档位快照无效');
      pinSnapshot(ctx, snapshot);
      const profile = versionOf(entry, snapshot.id, snapshot.revision);
      const domainDocuments=options.domains?index.documents(snapshotArgs).filter(document=>options.domains.includes(document.domain)):null;
      if(domainDocuments&&!domainDocuments.length)return {records:[],profile:snapshot,state:'ready'};
      return await usingBackend(ctx, profile, async (backend, identity, ctx) => {
        if (identity.modelKey !== snapshot.modelKey) fail('EMBEDDING_IDENTITY_MISMATCH', '原模型编码身份已变化，请重新准备档位');
        const documents = domainDocuments??index.documents(snapshotArgs);
        const currentDocuments = queryCandidateLimit === undefined ? [] : documents;
        if (queryCandidateLimit === undefined) for (const document of documents) if (await resolve(ctx, document)) currentDocuments.push(document);
        // Preserve in-flight cleanup for injected adapters without job states.
        ctx.queryDispatched = true;
        const vectors = await backend.embed([options.query], { kind: 'query', signal: ctx.signal, scope: ctx.scope,
          onJobState: state => { ctx.queryDispatched = state === 'dispatched'; },
          authorize: () => { ctx.guard(); return true; } });
        ctx.queryDispatched = false;
        ctx.guard();
        if (!Array.isArray(vectors) || vectors.length !== 1 || backend.modelKey !== snapshot.modelKey) fail('EMBEDDING_IDENTITY_MISMATCH', '查询编码身份已变化');
        const vector = checkedVector(vectors[0], snapshot.dimensions), candidates = [];
        const ordered = index.rank({ ...snapshotArgs, documents: currentDocuments, vector });
        const bounded = queryCandidateLimit === undefined ? ordered : ordered.slice(0, queryCandidateLimit);
        const concurrency = queryCandidateLimit === undefined ? 1 : 4;
        const target = queryCandidateLimit === undefined ? Infinity : Math.max(8,limit*2);
        let examined = 0, lastReadMs = 0;
        for (let offset = 0; offset < bounded.length; offset += concurrency) {
          ctx.guard();
          if(candidates.length && ctx.deadline!==undefined && ctx.deadline-now()<=lastReadMs*2+25)break;
          const batch=bounded.slice(offset,offset+concurrency).map(item=>({
            ...item, similarity:Math.max(-1,Math.min(1,item.score)),
          })),started=now();
          const resolved=await Promise.all(batch.map(item=>
            minSimilarity!==undefined&&item.similarity<minSimilarity?null:resolve(ctx,item.document)));ctx.guard();
          lastReadMs=Math.max(1,now()-started);examined+=batch.length;
          for(let i=0;i<batch.length;i++)for(const record of resolved[i]??[]){
            if(matchesReference(record))candidates.push({...batch[i],record});
          }
          if(candidates.length>=target)break;
        }
        // Resolving later candidates may yield to edits/retractions. Recheck
        // every chosen document, including the earliest one, before returning.
        const weighted = item => {
          const weight=item.record.weight??1;
          if(!Number.isFinite(weight)||weight<0||weight>1)fail('INVALID_DOCUMENT_WEIGHT','来源权重必须为 0..1');
          // Shift cosine before weakening so that a negative cosine cannot be promoted.
          return (item.similarity+1)*weight-1;
        };
        if(queryCandidateLimit!==undefined)candidates.sort((a,b)=>weighted(b)-weighted(a));
        const records = [], chosen = new Set();
        for(let offset=0;offset<candidates.length;){
          const size=queryCandidateLimit===undefined?1:Math.min(concurrency,limit-records.length);
          if(size<=0)break;
          const batch=candidates.slice(offset,offset+size);offset+=batch.length;
          const checked=await Promise.all(batch.map(item=>resolve(ctx,item.document)));ctx.guard();
          for(let i=0;i<batch.length;i++){
          const item=batch[i],current=checked[i];
          const record=current?.find(row=>row.id===item.record.id&&row.revision===item.record.revision);
          if (record && matchesReference(record)) {
            const identity=JSON.stringify([record.id,record.revision]);if(chosen.has(identity))continue;chosen.add(identity);
            const { similarity } = item, score = weighted({ ...item, record });
            // Raw/document offsets refer to the original source text. Suzu memory
            // anchors instead expand their proof sources through the core adapter.
            if (!record.id.startsWith('suzu:') && item.chunk) {
              const { start: hitStart, end: hitEnd } = item.chunk;
              if (!Number.isSafeInteger(hitStart) || !Number.isSafeInteger(hitEnd)
                || hitStart < 0 || hitEnd <= hitStart || hitEnd > record.text.length) continue;
              // Preserve the whole matched chunk. The answer session applies its
              // shared character budget and marks any necessary truncation.
              let start = Math.max(0, hitStart - 100), end = Math.min(record.text.length, hitEnd + 100);
              if (start > 0 && /[\uDC00-\uDFFF]/u.test(record.text[start])) start--;
              if (end < record.text.length && /[\uD800-\uDBFF]/u.test(record.text[end - 1])) end--;
              records.push({ ...record, text: record.text.slice(start, end), similarity, score,
                anchor: { ...record.anchor, id: record.id, revision: record.revision,
                  range: { start, end }, match: { start: hitStart, end: hitEnd } } });
            } else records.push({ ...record, similarity, score });
          }
          }
        }
        const seen = new Set();
        const ranked = records.sort((a, b) => b.score - a.score).filter(record => {
          const key = JSON.stringify([record.id, record.revision]);
          if (seen.has(key)) return false;
          seen.add(key); return true;
        }).slice(0, limit);
        ctx.guard(); return { records: ranked, profile: snapshot,
          ...(examined < ordered.length ? {degraded:true,candidateLimit:queryCandidateLimit,candidatesExamined:examined} : {}) };
      });
      } finally { pendingQueries.delete(requestId); }
    },
    async close({ signal } = {}) {
      signal?.throwIfAborted(); if (closed) return;
      closed = true;
      shutdown.abort();
      for (const [grant, pin] of queryPins) grant.signal.removeEventListener('abort', pin.abort);
      queryPins.clear();
      const running = [...jobs.values()]; for (const job of running) job.controller.abort();
      const handles = [...backends.values()]; backends.clear();
      await Promise.all(handles.map(handle => handle.backend.dispose()));
      await Promise.allSettled(running.map(job => job.done));
      await Promise.all([...retiringBackends]);
      await Promise.all([settings.idle(), usage.idle()]); index.close(); signal?.throwIfAborted();
    },
  };
  return api;
}

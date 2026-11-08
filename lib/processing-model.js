import { randomUUID } from 'node:crypto';

export const MEMORY_PROCESSING_PURPOSES = Object.freeze(['memory-capture', 'memory-maintenance']);
export const MEMORY_PROCESSING_POLICY_VERSION = 1;
const text = value => typeof value === 'string' ? value.trim() : '';
const scopeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Omitted legacy mode preserves a complete or incomplete fixed selection. */
export function processingTargetMode(config = {}) {
  return text(config.captureTargetMode) ||
    (text(config.captureProvider) || text(config.captureModel) ? 'fixed' : 'follow');
}

function targetPair(value) {
  const provider = text(value?.provider), model = text(value?.model);
  return provider && model ? { provider, model } : null;
}

/** Never completes a half-configured fixed target from another connection. */
export function resolveProcessingTarget(config = {}, agent) {
  const mode = processingTargetMode(config);
  if (mode === 'fixed') return targetPair({ provider: config.captureProvider, model: config.captureModel });
  if (mode !== 'follow') return null;
  try {
    const target = targetPair(agent?.session?.requestHeader?.()?.config);
    if (target) return target;
  } catch { /* The same agent's options remain the legacy fallback. */ }
  return targetPair(agent?.options);
}

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

/** One opaque library identity, committed in the existing recovery store. */
export async function ensureProcessingScope(store) {
  if (!store?.read || !store?.update) throw failure('MEMORY_PROCESSING_STORE_UNAVAILABLE', 'Memory recovery store unavailable');
  const previous = (await store.read()).processingScopeId;
  if (previous !== undefined) {
    if (!scopeIdPattern.test(previous)) throw failure('MEMORY_PROCESSING_SCOPE_INVALID', 'Invalid saved processing scope');
    return previous;
  }
  let id;
  await store.update(state => {
    if (state.processingScopeId !== undefined && !scopeIdPattern.test(state.processingScopeId)) {
      throw failure('MEMORY_PROCESSING_SCOPE_INVALID', 'Invalid saved processing scope');
    }
    id = state.processingScopeId ||= randomUUID();
  });
  return id;
}

/** The namespace contains only an opaque scope, fixed purpose and rule version. */
export function processingCacheNamespace({ scopeId, purpose, promptVersion = '1' }) {
  if (!MEMORY_PROCESSING_PURPOSES.includes(purpose)) {
    throw failure('MEMORY_PROCESSING_PURPOSE_INVALID', 'Unknown background memory purpose');
  }
  if (!/^[a-z0-9._-]{1,40}$/i.test(text(promptVersion))) {
    throw failure('MEMORY_PROCESSING_POLICY_INVALID', 'A fixed prompt version is required');
  }
  // Direct legacy callers without a durable store keep their former routing.
  // Mounted workers always supply the persisted library scope.
  if (scopeId === undefined || scopeId === '') return undefined;
  if (!scopeIdPattern.test(scopeId)) throw failure('MEMORY_PROCESSING_SCOPE_INVALID', 'Invalid processing scope');
  return `dsh-memory/${MEMORY_PROCESSING_POLICY_VERSION}/${scopeId}/${purpose}/${text(promptVersion)}`;
}

export function memoryProcessingCapabilities(llm) {
  const value = llm?.memoryProcessingCapabilities;
  return {
    version: Number.isInteger(value?.version) ? value.version : 0,
    cacheNamespace: value?.version >= 1 && value.cacheNamespace === true,
    catalogProvider: value?.version >= 1 && value.catalogProvider === true,
  };
}

/** Provider-reported values only; an omitted field remains unknown. */
export function memoryProcessingUsage(usage) {
  const receipt = {};
  for (const [host, standard] of [['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
    ['totalTokens', 'total_tokens'], ['cacheReadTokens', 'cache_read_input_tokens'], ['cacheWriteTokens', 'cache_creation_input_tokens']]) {
    if (Number.isSafeInteger(usage?.[host]) && usage[host] >= 0) receipt[standard] = usage[host];
  }
  return receipt;
}

/** Preserve the real session and generation options until the host adapter. */
export function streamMemoryProcessing({ llm, config = {}, agent, target, sessionId, purpose,
  scopeId = config.processingScopeId, promptVersion = '1', ...generation }) {
  if (!llm || typeof llm.stream !== 'function') {
    throw failure('MEMORY_PROCESSING_SERVICE_UNAVAILABLE', 'Background LLM service unavailable');
  }
  if (!text(sessionId)) {
    throw failure('MEMORY_PROCESSING_SESSION_REQUIRED', 'The real source session is required');
  }
  const mode = processingTargetMode(config);
  const selected = target === undefined ? resolveProcessingTarget(config, agent) : targetPair(target);
  if (!selected) {
    const invalid = target === undefined && !['follow', 'fixed'].includes(mode);
    const incomplete = target === undefined && mode === 'fixed';
    throw failure(invalid ? 'MEMORY_PROCESSING_MODE_INVALID' : incomplete ? 'MEMORY_PROCESSING_TARGET_INCOMPLETE' : 'MEMORY_PROCESSING_TARGET_UNAVAILABLE',
      invalid ? 'Unknown background target mode' : incomplete ? 'Fixed background service and model must both be configured' : 'Background service and model unavailable');
  }
  return llm.stream({ ...generation, ...selected, sessionId, purpose,
    cacheNamespace: processingCacheNamespace({ scopeId, purpose, promptVersion }) });
}

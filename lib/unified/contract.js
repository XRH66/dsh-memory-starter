import path from 'node:path';

export const UNIFIED_MEMORY_VERSION = 1;
export const UNIFIED_MEMORY_API = '/api/dsh-memory';
export const MEMORY_SEARCH_LIMITS = Object.freeze({ calls: 4, records: 5, chars: 6000, totalChars: 12000, timeoutMs: 10000 });
export const MEMORY_PROCESSING_DEFAULTS = Object.freeze({ batchChars: 8000, batchSources: 40, idleMs: 5 * 60_000, maxWaitMs: 30 * 60_000 });
export const MEMORY_LANES = Object.freeze(['saved', 'embedding', 'semantic']);

export function memoryError(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

export function requiredText(value, label, max = 300) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[\u0000-\u001f]/u.test(value)) {
    throw memoryError('INVALID_MEMORY_VALUE', `${label}无效`);
  }
  return value;
}

export function sourcePosition(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw memoryError('INVALID_SOURCE_POSITION', '需要可信的来源位置');
  return value;
}

/** Shared source identity is independent of the embedding model and DSH transport. */
export function sourceIdentity({ sessionId, messageId }) {
  return `dsh:${encodeURIComponent(requiredText(sessionId, '会话'))}:${encodeURIComponent(requiredText(messageId, '消息'))}`;
}

export function unifiedPaths(directory) {
  if (!path.isAbsolute(directory || '')) throw memoryError('INVALID_MEMORY_DIRECTORY', '需要明确的记忆目录');
  const root = path.join(directory, 'management', 'unified-memory');
  return Object.freeze({ root, policy: path.join(root, 'policy.json'), configuration: path.join(root, 'configuration.json'),
    sources: path.join(root, 'sources.sqlite'), migration: path.join(root, 'migration.json') });
}

/** Missing old opt-out settings never create new opt-in authorization. */
export function migrationPolicy(legacy = {}) {
  return { enabled: false, historyUserOnly: legacy.enabled === true || legacy.historyUserOnly !== false,
    authorizationRequired: true };
}

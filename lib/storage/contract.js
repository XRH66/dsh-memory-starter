export const MEMORY_SEARCH_LIMITS = Object.freeze({ calls: 4, records: 5, chars: 6000, totalChars: 12000, timeoutMs: 10000 });

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

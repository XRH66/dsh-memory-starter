/** Common embedding service protocol; authorization belongs to its adapter.
 * Only one final vector per input is accepted, never chat/token-level output.
 */
export function embeddingServiceUrl(baseUrl, { allowLocal = true } = {}) {
  const url = new URL(baseUrl);
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (allowLocal && local && url.protocol === 'http:'))) {
    throw new Error('Embedding service requires HTTPS, or an explicitly local loopback HTTP address');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/embeddings') ? pathname : pathname + '/embeddings';
  return url.toString();
}

export async function requestEmbeddingService({ baseUrl, model, texts, dimensions, sendDimensions = false,
  apiKey, signal, kind, scope, onUsage, fetchImpl = fetch }) {
  if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== 'string')) throw new Error('Embedding service needs an array of text strings');
  if (!Number.isInteger(dimensions) || dimensions <= 0) throw new Error('Embedding service needs explicit expected dimensions');
  const endpoint = embeddingServiceUrl(baseUrl);
  signal?.throwIfAborted();
  const started = Date.now();
  const receipt = { at: new Date().toISOString(), scope, model, dimensions, kind, inputs: texts.length,
    outcome: 'unknown', tokens: null, requestId: null };
  try {
    const body = { model, input: texts, encoding_format: 'float' };
    // This is a capability of the service/model profile, not a universal field.
    if (sendDimensions) body.dimensions = dimensions;
    const headers = { 'content-type': 'application/json' };
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', headers, body: JSON.stringify(body), signal });
    receipt.httpStatus = response.status;
    receipt.requestId = response.headers.get('x-request-id') || null;
    if (!response.ok) {
      receipt.outcome = 'http-error';
      throw Object.assign(new Error('Embedding service HTTP ' + response.status), {
        code: 'EMBEDDING_HTTP_ERROR',
        status: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }
    const payload = await response.json();
    receipt.requestId = payload.id || receipt.requestId;
    const tokens = payload.usage?.total_tokens ?? payload.usage?.prompt_tokens;
    if (Number.isSafeInteger(tokens) && tokens >= 0) receipt.tokens = tokens;
    const rows = [...(payload.data || [])].sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length || rows.some((row, i) => row.index !== i)) throw new Error('Embedding service result count or input order mismatch');
    if (rows.some(row => !Array.isArray(row.embedding) || row.embedding.length !== dimensions ||
        row.embedding.some(value => !Number.isFinite(value)) || !row.embedding.some(value => value !== 0))) {
      throw new Error('Embedding service returned invalid vector dimensions or values');
    }
    receipt.outcome = 'ok';
    return rows.map(row => row.embedding);
  } finally {
    receipt.durationMs = Date.now() - started;
    // Only metadata goes to the usage ledger; no input, secret, or response text.
    await onUsage?.(receipt);
  }
}

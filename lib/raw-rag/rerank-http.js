const localHosts = new Set(['localhost', '127.0.0.1', '::1']);

export function rerankServiceUrl(baseUrl) {
  const url = new URL(baseUrl);
  const local = localHosts.has(url.hostname.replace(/^\[|\]$/g, ''));
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || (local && url.protocol === 'http:'))) {
    throw new Error('Rerank service requires HTTPS, or a loopback HTTP address');
  }
  const pathname = url.pathname.replace(/\/+$/, '').replace(/\/embeddings$/u, '');
  url.pathname = pathname.endsWith('/rerank') ? pathname : pathname + '/rerank';
  return url.toString();
}

function rerankError(message, code, httpStatus) {
  return Object.assign(new Error(message), {code, ...(httpStatus === undefined ? {} : {httpStatus})});
}

export async function requestRerank({baseUrl, model, query, documents, apiKey, signal,
  fetchImpl = fetch, onUsage}) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('Rerank service needs a query string');
  if (!Array.isArray(documents) || !documents.length ||
      documents.some(document => typeof document !== 'string')) {
    throw new Error('Rerank service needs an array of document strings');
  }
  const endpoint = rerankServiceUrl(baseUrl);
  signal?.throwIfAborted();
  const started = Date.now();
  const receipt = {
    at: new Date().toISOString(),
    model,
    documents: documents.length,
    tokens: null,
    outcome: 'unknown',
    httpStatus: null,
    durationMs: 0,
  };
  try {
    const headers = {'content-type': 'application/json'};
    if (apiKey) headers.authorization = 'Bearer ' + apiKey;
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers,
      body: JSON.stringify({model, query, documents, return_documents: false}),
      signal,
    });
    receipt.httpStatus = response.status;
    if (!response.ok) {
      receipt.outcome = 'http-error';
      throw rerankError('Rerank service HTTP ' + response.status, 'RERANK_HTTP_ERROR', response.status);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      receipt.outcome = 'invalid-response';
      throw rerankError('Rerank service returned invalid JSON', 'RERANK_INVALID_RESPONSE');
    }
    receipt.tokens = payload?.meta?.tokens ?? payload?.usage ?? null;
    const rows = payload?.results;
    if (!Array.isArray(rows)) {
      receipt.outcome = 'invalid-response';
      throw rerankError('Rerank service returned invalid results', 'RERANK_INVALID_RESPONSE');
    }
    const seen = new Set();
    const results = rows.map(row => {
      const index = row?.index;
      const score = row?.relevance_score;
      if (!Number.isInteger(index) || index < 0 || index >= documents.length || seen.has(index) ||
          !Number.isFinite(score)) {
        receipt.outcome = 'invalid-response';
        throw rerankError('Rerank service returned invalid result indexes or scores', 'RERANK_INVALID_RESPONSE');
      }
      seen.add(index);
      return {index, score};
    }).sort((left, right) => right.score - left.score || left.index - right.index);
    receipt.outcome = 'ok';
    return results;
  } catch (error) {
    if (receipt.outcome === 'unknown') {
      receipt.outcome = signal?.aborted ? 'aborted' :
        error?.code === 'RERANK_INVALID_RESPONSE' ? 'invalid-response' :
          error?.code === 'RERANK_HTTP_ERROR' ? 'http-error' : 'request-error';
    }
    throw error;
  } finally {
    receipt.durationMs = Math.max(0, Date.now() - started);
    await onUsage?.(receipt);
  }
}

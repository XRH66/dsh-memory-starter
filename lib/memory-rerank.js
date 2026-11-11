import fs from 'node:fs/promises';
import {requestRerank,rerankServiceUrl} from './raw-rag/rerank-http.js';

const PAUSE_MS = 10 * 60 * 1000;
const localHosts = new Set(['localhost', '127.0.0.1', '::1']);

const errorWithCode = (message, code, cause) => Object.assign(new Error(message, cause ? {cause} : undefined), {code});

function tokenTotal(tokens) {
  if (Number.isFinite(tokens)) return tokens;
  if (!tokens || typeof tokens !== 'object') return 0;
  const input = Number(tokens.input_tokens ?? tokens.prompt_tokens);
  const output = Number(tokens.output_tokens ?? tokens.completion_tokens);
  const total = Number(tokens.total_tokens);
  if (Number.isFinite(total)) return Math.max(0, total);
  return Math.max(0, Number.isFinite(input) ? input : 0) + Math.max(0, Number.isFinite(output) ? output : 0);
}

export function createMemoryReranker({config = {}, fetchImpl = fetch, now = Date.now, logger} = {}) {
  const configured = config.memoryRerank === true;
  const apiBase = typeof config.memoryRerankApiBase === 'string' ? config.memoryRerankApiBase.trim() : '';
  const apiKeyFile = typeof config.memoryRerankApiKeyFile === 'string' ? config.memoryRerankApiKeyFile.trim() : '';
  const model = typeof config.memoryRerankModel === 'string' && config.memoryRerankModel.trim()
    ? config.memoryRerankModel.trim() : 'BAAI/bge-reranker-v2-m3';
  const clock = () => {
    const value = now();
    return value instanceof Date ? value.getTime() : Number(value);
  };
  let keyRead = !apiKeyFile;
  let apiKey = '';
  let addressValid = Boolean(apiBase);
  let local = false;
  let state = !configured ? 'off' : 'unavailable';
  let reason = !configured ? '' : apiBase ? '' : '重排服务地址未配置';
  let pausedUntil = 0;
  let calls = 0;
  let failures = 0;
  let lastState = '';
  let lastAt = null;
  let tokens = 0;
  let service = '';
  try {
    if(apiBase){
      const endpoint=new URL(rerankServiceUrl(apiBase));
      service=endpoint.hostname;
      local=localHosts.has(service.replace(/^\[|\]$/g,''));
    }
  } catch {
    addressValid=false;
    if(configured){
      reason = '重排服务地址无效';
      state = 'unavailable';
    }
  }
  const canRun=()=>addressValid&&(Boolean(apiKeyFile)||local);
  if(configured&&addressValid){
    state=canRun()?'ready':'unavailable';
    reason=canRun()?'':'重排密钥不可用';
  }

  function refreshPause() {
    if (state === 'paused' && clock() >= pausedUntil) {
      state = canRun() ? 'ready' : 'unavailable';
      reason = state === 'ready' ? '' : reason;
      pausedUntil = 0;
    }
  }

  function enabled() {
    refreshPause();
    return Boolean(configured && canRun() && state !== 'unavailable');
  }

  async function readKey() {
    if (!apiKeyFile) return '';
    if (keyRead) return apiKey;
    keyRead = true;
    try {
      apiKey = String(await fs.readFile(apiKeyFile, 'utf8')).trim();
      if (!apiKey) throw Error('empty');
      return apiKey;
    } catch {
      apiKey = '';
      state = 'unavailable';
      reason = '重排密钥不可用';
      lastState = 'disabled';
      lastAt = new Date(clock()).toISOString();
      logger?.warn?.('[memory-rerank] disabled: key unavailable');
      throw errorWithCode(reason, 'RERANK_UNAVAILABLE');
    }
  }

  async function rerank({query, documents, signal}) {
    refreshPause();
    if (!enabled()) throw errorWithCode(reason || '重排服务未启用', 'RERANK_UNAVAILABLE');
    if (state === 'paused') throw errorWithCode('重排服务暂停中', 'RERANK_PAUSED');
    const key = await readKey();
    calls++;
    try {
      const results = await requestRerank({
        baseUrl: apiBase,
        model,
        query,
        documents,
        apiKey: key,
        signal,
        fetchImpl,
        onUsage: receipt => {
          tokens += tokenTotal(receipt.tokens);
        },
      });
      state = 'ready';
      reason = '';
      lastState = 'applied';
      lastAt = new Date(clock()).toISOString();
      return results;
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
        failures++;
        lastState = 'timeout';
        lastAt = new Date(clock()).toISOString();
        logger?.warn?.('[memory-rerank] timeout');
        throw errorWithCode('重排请求超时', 'RERANK_TIMEOUT', error);
      }
      failures++;
      if (error?.code === 'RERANK_HTTP_ERROR' || error?.code === 'RERANK_INVALID_RESPONSE') {
        state = 'paused';
        pausedUntil = clock() + PAUSE_MS;
        reason = '重排服务调用失败，暂停 10 分钟';
        lastState = 'failed';
        logger?.warn?.('[memory-rerank] failed' + (Number.isFinite(error.httpStatus) ? ' http=' + error.httpStatus : ''));
      } else {
        reason = '重排服务暂时不可用';
        lastState = 'failed';
        logger?.warn?.('[memory-rerank] failed');
      }
      lastAt = new Date(clock()).toISOString();
      throw error;
    }
  }

  function status() {
    refreshPause();
    return {enabled:configured, model, service, state, reason, calls, failures, lastState, lastAt, tokens,
      ...(state === 'paused' ? {pausedUntil: new Date(pausedUntil).toISOString()} : {})};
  }

  // Ends a pause early after the user has checked the service; a key that could not be read
  // is read again on the next call. A missing address or key setting stays unavailable.
  function resume() {
    if (state === 'paused' || (state === 'unavailable' && configured && canRun())) {
      state = 'ready'; reason = ''; pausedUntil = 0;
      if (apiKeyFile) { keyRead = false; apiKey = ''; }
    }
    return status();
  }

  return {enabled, rerank, status, resume};
}

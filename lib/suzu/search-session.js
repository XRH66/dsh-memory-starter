import { isDeepStrictEqual } from 'node:util';
import { MEMORY_SEARCH_LIMITS } from '../unified/contract.js';
import {MEMORY_QUERY_DEFAULTS,MEMORY_ENTRY_TYPES,MEMORY_VALIDITY,MEMORY_PROGRESS} from '../memory-contract.js';
import {estimateRecentTokens} from '../recent-context.js';

const MESSAGES = {
  DENIED: '当前回答的记忆授权已关闭或失效。',
  CANCELLED: '本次记忆检索已取消。',
  TIMEOUT: '本回答的记忆检索时间预算已用完。',
  CALLS: '本回答的记忆检索调用次数已用完。',
  CHARS: '记忆结果已达到字符预算，请使用更具体的查询。',
  TOKENS: '记忆结果已达到本次或本回答的 token 预算，可按已返回的定位继续核对。',
  RECORDS: '本次记忆结果已达到条数上限。',
  INPUT: '参数无效；检索只接受 query、limit，展开只接受已返回的 anchor。',
  PROFILE: '后端没有保持本回答固定的向量档位，请在新回答中重试。',
  BACKEND: '记忆后端暂时无法返回有效结果。',
  PARTIAL: '部分检索暂不可用，以下是仍可核实的结果。',
};
const stop = code => Object.assign(new Error(code), { memorySearchCode: code });
const jsonCopy = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const keyOf = record => JSON.stringify([record.id, record.revision,
  record.anchor?.range?.start ?? null, record.anchor?.range?.end ?? null, record.anchor?.nextOffset ?? null]);

/**
 * One instance per answer. search({query,limit?},{signal?}),
 * expand({anchor},{signal?}), cancel(), dispose(), budget().
 * Backends receive {scope,grant,signal,profile,...}; only policy grants identity.
 * Optional getProfile pins before the first read in character mode. In portable
 * token mode, only a backend calling request.getProfile() starts the shared
 * answer snapshot. The caller bounds its own wait without cancelling the snapshot.
 * Without a loader, the first result pins its profile (missing/null pins text-only).
 * A backend may omit profile on later results, but must use the passed snapshot.
 * Calls are serialized. The shared timeout accumulates active search/expansion
 * work (including profile preparation); queue waits and time between calls do
 * not consume it. Each backend is bounded by the remaining shared work budget.
 * Nonempty responses, including metadata and budget, consume serialized UTF-16
 * characters. Empty control replies consume no content budget, so exhaustion can
 * still be explained. Expansion has its own source/version/range dedup set:
 * distinct issued excerpts and continuation pages share the same answer budget.
 * Passing tokenLimits opts into the portable P05 contract: estimated serialized
 * tokens, separate search/open caps, typed filters/metadata and one absolute
 * deadline per invocation (including queue time). A timeout then aborts only
 * that invocation; the answer retains its remaining shared calls/token budget.
 */
export function createMemorySearchSession({ policy, agent, search, expand, recent, getProfile, validateResult, searchWaitMs,
  limits = {}, tokenLimits, countTokens=estimateRecentTokens, now = Date.now } = {}) {
  if (!policy || typeof policy.grant !== 'function' || typeof policy.validate !== 'function' ||
      typeof search !== 'function' || (expand !== undefined && typeof expand !== 'function') ||
      (recent !== undefined && typeof recent !== 'function') ||
      (getProfile !== undefined && typeof getProfile !== 'function') ||
      (validateResult !== undefined && typeof validateResult !== 'function')) {
    throw new TypeError('需要策略及注入的检索后端');
  }
  const tokenMode=tokenLimits!==undefined,queryCap=tokenMode?{...MEMORY_QUERY_DEFAULTS,...tokenLimits}:null;
  if(searchWaitMs!==undefined&&(!Number.isSafeInteger(searchWaitMs)||searchWaitMs<1))throw new TypeError('无效检索等待时间');
  if(tokenMode){
    if(typeof countTokens!=='function')throw new TypeError('需要 token 计量方法');
    for(const key of Object.keys(MEMORY_QUERY_DEFAULTS))if(!Number.isSafeInteger(queryCap[key])||queryCap[key]<0)throw new TypeError('无效检索预算：'+key);
  }
  const cap = { ...MEMORY_SEARCH_LIMITS, ...limits,...tokenMode?{calls:queryCap.calls,records:queryCap.records,chars:queryCap.searchTokens,totalChars:queryCap.totalTokens,timeoutMs:queryCap.waitMs}:{} };
  const units=text=>tokenMode?countTokens(text):text.length;
  const budgetCode=tokenMode?'TOKENS':'CHARS';
  for (const name of Object.keys(MEMORY_SEARCH_LIMITS)) {
    if (!Number.isSafeInteger(cap[name]) || cap[name] < 0) throw new TypeError(`无效检索预算：${name}`);
  }
  let calls = 0, chars = 0, workMs = 0, activeSince, activeTimeoutMs, grant, scope, profile = null, profilePinned = false, profileTask;
  let queue = Promise.resolve(), unsubscribe, grantAbort, disposed = false, requestController,responseMeta={};
  const controller = new AbortController();
  const seen = new Set(), expanded = new Set(), anchors = new Map();
  const elapsed = () => (tokenMode?0:workMs) + (activeSince === undefined ? 0 : Math.max(0, now() - activeSince));
  const budget = (usedChars = chars) => ({ calls, remainingCalls: Math.max(0, cap.calls - calls),
    ...tokenMode?{tokens:usedChars,remainingTokens:Math.max(0,cap.totalChars-usedChars),counting:'estimated',perSearchTokens:cap.chars,perOpenTokens:queryCap.openTokens}:
      {chars:usedChars,remainingChars:Math.max(0,cap.totalChars-usedChars)},
    remainingMs: Math.max(0, (activeTimeoutMs??cap.timeoutMs) - elapsed()) });
  const reply = (code, records = []) => ({ status: code === 'DENIED' ? 'denied' :
    code === 'CANCELLED' ? 'cancelled' : code === 'TIMEOUT' ? 'timeout' : code === 'PARTIAL' ? 'partial' :
    code === 'CALLS' || code === 'CHARS' || code === 'TOKENS' || code === 'RECORDS' ? 'budget' : code ? 'error' : records.length ? 'ok' : 'empty',
  records, ...(code ? { error: { code, message: tokenMode&&code==='TIMEOUT'?'本次检索等待已到限，可用已返回结果或在剩余次数内补查。':tokenMode&&code==='INPUT'?'请使用工具声明的检索字段，展开只接受已经返回的 anchor。':MESSAGES[code] } } : {}),...(tokenMode&&code!=='DENIED'?responseMeta:{}), budget: budget() });
  function authorized() {
    try { return Boolean(grant && policy.validate(grant)); } catch { return false; }
  }
  function guard(checkTime=true) {
    if (grant && (!authorized() || grant.signal?.aborted)) throw stop('DENIED');
    if (controller.signal.aborted) throw stop(controller.signal.reason || 'CANCELLED');
    if (checkTime&&(requestController?.signal.aborted||elapsed() >= (activeTimeoutMs??cap.timeoutMs))) throw stop('TIMEOUT');
  }
  function cancel() {
    if (!controller.signal.aborted) controller.abort('CANCELLED');
  }
  async function acquire() {
    if (!grant) {
      try { grant = policy.grant(agent); } catch { throw stop('DENIED'); }
      if (!authorized()) throw stop('DENIED');
      const identity = grant.scope || grant;
      scope = {};
      for (const field of ['ownerSubject', 'project', 'sessionId', 'rootSessionId', 'epoch', 'historyUserOnly']) {
        if (identity[field] !== undefined) scope[field] = identity[field];
        else if (grant[field] !== undefined) scope[field] = grant[field];
      }
      if (!['ownerSubject', 'project', 'sessionId', 'rootSessionId', 'epoch']
        .every(field => typeof scope[field] === 'string' && scope[field].length)) throw stop('DENIED');
      scope = freeze(jsonCopy(scope));
      grantAbort = () => { if (!controller.signal.aborted) controller.abort('DENIED'); };
      grant.signal?.addEventListener('abort', grantAbort, { once: true });
      if (typeof policy.subscribe === 'function') {
        unsubscribe = policy.subscribe(() => {
          if (!authorized() && !controller.signal.aborted) controller.abort('DENIED');
        });
      }
    }
    if (!scope || !Object.isFrozen(scope)) throw stop('DENIED');
    guard();
  }
  function pin(value) {
    const snapshot = value == null ? null : freeze(jsonCopy(value));
    if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot) ||
        typeof snapshot.id !== 'string' || !snapshot.id || snapshot.revision === undefined)) throw stop('PROFILE');
    if (profilePinned) {
      if (!isDeepStrictEqual(snapshot, profile)) throw stop('PROFILE');
      return profile;
    }
    profile = snapshot;
    profilePinned = true;
    return profile;
  }
  function loadProfile() {
    return profileTask ??= Promise.resolve().then(() => {
      guard(false);
      return getProfile({scope, grant, signal:controller.signal});
    }).then(snapshot => {
      guard(false);
      return pin(snapshot);
    });
  }
  async function bounded(action) {
    guard();
    const signal = tokenMode?AbortSignal.any([controller.signal,requestController.signal]):controller.signal;
    let timer, abort;
    const interrupted = new Promise((_, reject) => {
      abort = () => reject(stop(signal.reason || 'CANCELLED'));
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        if (!signal.aborted) (tokenMode?requestController:controller).abort('TIMEOUT');
      }, Math.max(0, (activeTimeoutMs??cap.timeoutMs) - elapsed()));
    });
    try {
      // Attach handlers even if an injected backend ignores abort and finishes late.
      const result = await Promise.race([Promise.resolve().then(() => { guard(); return action(); }), interrupted]);
      guard(!tokenMode);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  function envelope(records, reason) {
    const result = reply(reason, records);
    let size = 0;
    // Budget numbers are themselves part of the serialized result.
    for (let attempt = 0; attempt < 12; attempt++) {
      result.budget = budget(chars + size);
      const next = units(JSON.stringify(result));
      if(tokenMode&&next<=size)return {result,size};
      if (next === size) return { result, size };
      size = next;
    }
    throw stop('BACKEND');
  }
  function fit(records, limit, kind, initialReason) {
    const output = [], identities = [], local = new Set();
    const already = kind === 'expand' ? expanded : seen;
    const ceiling = Math.min(tokenMode&&kind==='expand'?queryCap.openTokens:cap.chars, cap.totalChars - chars);
    let reason = initialReason;
    for (const raw of records) {
      if (!raw || typeof raw.id !== 'string' || !raw.id ||
          !((typeof raw.revision === 'string' && raw.revision.length) || Number.isSafeInteger(raw.revision)) ||
          typeof raw.text !== 'string') throw stop('BACKEND');
      if (!raw.text.trim()) continue;
      const key = keyOf(raw);
      if (already.has(key) || local.has(key)) continue;
      if (output.length >= limit) { reason ||= 'RECORDS'; break; }
      const record = { id: raw.id, revision: raw.revision, text: raw.text };
      for (const name of ['anchor', 'sourceIds', 'source',...tokenMode?['label','localTime','kind','role','time','type','subject_ref','state','tags','importance','evidence_basis','speaker_ref','viewpoint_holder_ref','inferred_by_ref','source_refs','sourceStatus','truncated']:[]]) if (raw[name] !== undefined) record[name] = jsonCopy(raw[name]);
      record.anchor ??= { id: record.id, revision: record.revision };
      let candidate = record;
      if (envelope([...output, candidate], budgetCode).size > ceiling) {
        let low = 0, high = record.text.length, best;
        while (low <= high) {
          const length = Math.floor((low + high) / 2);
          let text = record.text.slice(0, length);
          if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
          const shortened = { ...record, text, truncated: true };
          if (record.anchor.range) {
            const end = record.anchor.range.start + text.length;
            shortened.anchor = { ...record.anchor, range: { start: record.anchor.range.start, end },
              // The next issued page starts after what was actually delivered.
              ...(kind === 'expand' ? { nextOffset: end } : {}) };
          }
          if (envelope([...output, shortened], budgetCode).size <= ceiling) { best = shortened; low = length + 1; }
          else high = length - 1;
        }
        if (!best || !best.text) { reason = budgetCode; continue; }
        candidate = best;
        reason = budgetCode;
      }
      output.push(candidate);
      identities.push(keyOf(candidate));
      local.add(keyOf(candidate));
    }
    if (!output.length) {
      if(tokenMode&&Object.keys(responseMeta).length){
        const packed=envelope([],reason);
        if(packed.size<=ceiling)return {...packed,identities};
        responseMeta={};return {result:reply(budgetCode),size:0,identities};
      }
      return { result: reply(reason), size: 0, identities };
    }
    return { ...envelope(output, reason), identities };
  }
  function input(kind, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw stop('INPUT');
    const filterKeys=tokenMode?['type','validity','progress','subject','tag','since','until']:[];
    const keys = kind === 'search' ? ['query', 'limit',...filterKeys] : kind === 'recent' ? ['limit'] : ['anchor'];
    if (Object.keys(value).some(key => !keys.includes(key))) throw stop('INPUT');
    if (kind === 'recent') {
      if (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1)) throw stop('INPUT');
      return { limit: Math.min(value.limit ?? cap.records, cap.records) };
    }
    if (kind === 'search') {
      if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > 2000 ||
          (value.limit !== undefined && (!Number.isSafeInteger(value.limit) || value.limit < 1))) throw stop('INPUT');
      const filters={};
      for(const [field,values] of [['type',MEMORY_ENTRY_TYPES],['validity',MEMORY_VALIDITY],['progress',MEMORY_PROGRESS]])if(value[field]!==undefined){if(!values.includes(value[field]))throw stop('INPUT');filters[field]=value[field];}
      for(const field of ['subject','tag'])if(value[field]!==undefined){if(typeof value[field]!=='string'||!value[field].trim()||value[field].length>300)throw stop('INPUT');filters[field]=value[field].trim();}
      for(const field of ['since','until'])if(value[field]!==undefined){if(typeof value[field]!=='string'||!Number.isFinite(Date.parse(value[field])))throw stop('INPUT');filters[field]=value[field];}
      if(filters.since&&filters.until&&Date.parse(filters.since)>Date.parse(filters.until))throw stop('INPUT');
      return { query: value.query.trim(), limit: Math.min(value.limit ?? cap.records, cap.records),...filters };
    }
    const record = anchors.get(JSON.stringify(value.anchor)) ||
      [...anchors.values()].find(item => isDeepStrictEqual(item.anchor, value.anchor));
    if (!record) throw stop('INPUT');
    return { ...record, limit: cap.records,...tokenMode?{maxTokens:Math.min(queryCap.openTokens,cap.totalChars-chars)}:{maxChars:Math.min(cap.chars,cap.totalChars-chars)} };
  }
  async function run(kind, value,queuedAt) {
    activeSince = tokenMode?queuedAt:now();
    activeTimeoutMs=kind==='search'&&searchWaitMs!==undefined?searchWaitMs:cap.timeoutMs;
    requestController=tokenMode?new AbortController():undefined;responseMeta={};
    try {
      if(!tokenMode)guard();
      const args = input(kind, value);
      if(tokenMode){if(calls>=cap.calls)throw stop('CALLS');calls++;guard();}
      await acquire();
      if (!tokenMode&&calls >= cap.calls) throw stop('CALLS');
      if (cap.records === 0 || cap.chars === 0 || chars >= cap.totalChars) throw stop(budgetCode);
      if (envelope([{ id: 'x', revision: 0, text: '', anchor: '' }]).size >
          Math.min(tokenMode&&kind==='expand'?queryCap.openTokens:cap.chars, cap.totalChars - chars)) throw stop(budgetCode);
      const backend = kind === 'search' ? search : kind === 'recent' ? recent : expand;
      if (!backend) throw stop('BACKEND');
      if(!tokenMode)calls++;
      if (!tokenMode && !profilePinned && getProfile) pin(await bounded(() => getProfile({ scope, grant, signal:controller.signal })));
      const request={ ...args, scope, grant, signal:tokenMode?AbortSignal.any([controller.signal,requestController.signal]):controller.signal, profile,
        getRemainingMs: () => Math.max(0, tokenMode?queuedAt+activeTimeoutMs-now():activeTimeoutMs-elapsed()),
        ...tokenMode?{deadline:queuedAt+activeTimeoutMs,hasSeen:record=>seen.has(keyOf(record)),...(getProfile?{getProfile:loadProfile}:{})}:{} };
      let result = await bounded(() => backend(request));
      if (!result || !Array.isArray(result.records)) throw stop('BACKEND');
      if (Object.hasOwn(result, 'profile') || (!profilePinned && !(tokenMode && getProfile))) pin(result.profile);
      // A fast lane can become obsolete while another lane is pending. Check
      // synchronous source state at delivery, without another async gap before fit.
      if(validateResult){result=validateResult(result,request);if(!result||!Array.isArray(result.records)||typeof result.then==='function')throw stop('BACKEND');}
      if(tokenMode){for(const field of ['channels','timings','coverage','nextPage'])if(result[field]!==undefined)responseMeta[field]=jsonCopy(result[field]);}
      const packed = fit(result.records, args.limit, kind, result.degraded === true ? 'PARTIAL' : undefined);
      guard(!tokenMode);
      chars += packed.size;
      for (const key of packed.identities) (kind === 'expand' ? expanded : seen).add(key);
      for (const record of packed.result.records) anchors.set(JSON.stringify(record.anchor),
        freeze({ id: record.id, revision: record.revision, anchor: record.anchor }));
      return packed.result;
    } catch (error) {
      // Never echo backend errors: they can contain source text or private paths.
      const code = grant && (!authorized() || grant.signal?.aborted) ? 'DENIED' : error?.memorySearchCode;
      return reply(Object.hasOwn(MESSAGES, code) ? code : 'BACKEND');
    } finally {
      if(!tokenMode)workMs = elapsed();
      activeSince = undefined;
      activeTimeoutMs=undefined;
      requestController=undefined;
    }
  }
  function enqueue(kind, value, options = {}) {
    const signal = options.signal;
    if (signal?.aborted) cancel();
    const abort = () => cancel();
    signal?.addEventListener('abort', abort, { once: true });
    // Capture model arguments before waiting behind another tool invocation.
    let captured;
    try { captured = jsonCopy(value); } catch {
      signal?.removeEventListener('abort', abort);
      return Promise.resolve(reply('INPUT'));
    }
    const queuedAt=now(),result = queue.then(() => run(kind, captured,queuedAt));
    queue = result.catch(() => {});
    return result.finally(() => signal?.removeEventListener('abort', abort));
  }
  return Object.freeze({
    search: (value, options) => enqueue('search', value, options),
    expand: (value, options) => enqueue('expand', value, options),
    recent: (value = {}, options) => enqueue('recent', value, options),
    budget: () => budget(),
    cancel,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      if (typeof unsubscribe === 'function') unsubscribe();
      grant?.signal?.removeEventListener('abort', grantAbort);
      anchors.clear(); seen.clear(); expanded.clear();
      // Read grants belong to this answer; do not leave a live policy credential.
      // A policy persistence failure is surfaced to the host caller of dispose().
      grant?.cancel?.();
    },
  });
}

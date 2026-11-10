import path from 'node:path';
import { existsSync } from 'node:fs';
import { sourceTextHash } from '../source-lineage.js';
import { buildTurn, RawMemoryStore } from './store.js';
import { createEmbeddingBackend } from './backend.js';
import { RAW_WINDOW_CHARS, minSimilarityFor } from './models.js';
import { rawEvidenceKey as candidateKey } from '../evidence.js';
import { selectEvidence } from './select.js';
import { managementDirectory } from '../review.js';
import { setImmediate as nextTick } from 'node:timers/promises';
import {syncFactualPriorities} from './fact-priority.js';
import {createRawQueryReader} from './query-reader.js';

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / Math.sqrt(na * nb);
}

function refreshCandidate(hit, source) {
  const ratio = source.weight / hit.weight;
  return { ...hit, ...source, score: hit.score * ratio,
    fusion: hit.fusionRank * source.weight,
    ...(hit.lexicalScoreBase == null ? {} : { lexicalScore: hit.lexicalScoreBase * source.weight }) };
}

function cancelError(signal) {
  const error = new Error('raw recall cancelled');
  error.code = 'RAW_RECALL_CANCELLED';
  error.name = 'AbortError';
  error.cause = signal?.reason;
  return error;
}

async function withDeadline(promise, timeoutMs, signal) {
  if (signal?.aborted) throw cancelError(signal);
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('raw recall exceeded ' + timeoutMs + 'ms');
          error.code = 'RAW_RECALL_TIMEOUT';
          reject(error);
        }, Math.max(50, timeoutMs));
        if (signal) {
          onAbort = () => reject(cancelError(signal));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

export function createRawRecall({
  config,
  logger = console,
  now = () => new Date(),
  ownerSubject,
  store,
  embedder,
} = {}) {
  const configured = Boolean(config?.rawRecall);
  const minSimilarity = () => minSimilarityFor(config || {});
  let modelKey = null;
  let registeredModelKey = null;
  const dbFile = config?.rawRecallDbPath
    ? path.resolve(config.rawRecallDbPath)
    : path.join(managementDirectory(config || {}), 'raw-recall', 'raw-recall.sqlite');

  const readScope = () => {
    const value = typeof ownerSubject === 'function' ? ownerSubject() : ownerSubject;
    return String(value ?? '').trim();
  };
  let memoryStore = store || null;
  let backend = embedder || null;
  let writeChain = Promise.resolve();
  let indexChain = Promise.resolve();
  let lastError = null;
  let lastWarned = '';
  let closing = false;
  let disposed = false;
  let closingTask = null;
  let recovering = null;
  let priorityScope=null;
  let externalVectors=false;

  const warn = (error) => {
    lastError = error;
    const message = error?.message || String(error);
    if (message === lastWarned) return;
    lastWarned = message;
    logger.warn?.('[raw-recall] ' + message);
  };

  // The portable host may switch owner or be started before its backend is
  // ready. Opening late keeps pure mode, an invalid path, or a missing model
  // from taking down the old bridge at construction time.
  function ensureStore(priorities = true) {
    if (disposed) throw new Error('raw recall is disposed');
    if (!memoryStore) memoryStore = new RawMemoryStore(dbFile, logger);
    const scope=readScope();
    if(priorities&&scope&&priorityScope!==scope){
      try{syncFactualPriorities(memoryStore,{scope,vaultPath:config.vaultPath,captureFolder:config.captureFolder});priorityScope=scope;}
      catch(error){warn(error);}
    }
    return memoryStore;
  }
  function ensureBackend() {
    if (disposed) throw new Error('raw recall is disposed');
    if (!backend) backend = createEmbeddingBackend({ config, logger,
      cacheFile: path.join(path.dirname(dbFile), 'asset-fingerprints.json'),
      onUsage: receipt => memoryStore?.recordEmbeddingUsage(receipt) });
    return backend;
  }

  async function ensureModel() {
    if(externalVectors)throw Object.assign(Error('Vectors are owned by the unified memory profile'),{code:'RAW_VECTOR_OWNER_CHANGED'});
    const worker = ensureBackend();
    if(typeof worker.prepare!=='function'||typeof worker.planChunks!=='function'||typeof worker.embed!=='function')throw new Error('Embedding adapter must implement prepare, planChunks and embed');
    const identity = await worker.prepare();
    if (disposed) throw new Error('raw recall is disposed');
    if(!identity?.modelKey)throw new Error('Embedding adapter did not return a model identity');
    modelKey = identity.modelKey;
    if (registeredModelKey !== modelKey) { ensureStore().registerModel(identity); registeredModelKey = modelKey; }
    return worker;
  }

  function sourceState(ref = {},priorities=true) {
    const scope = readScope();
    if (!scope) return { state: ref.legacy ? 'unknown' : 'blocked', reason: 'no-source-owner' };
    if (ref.scope && ref.scope!==scope) return { state: 'blocked', reason: 'scope-changed' };
    if (disposed || closing) return { state: 'blocked', reason: 'closing' };
    if (!memoryStore && !existsSync(dbFile)) return { state: ref.sourceVersion ? 'blocked' : 'unknown', reason: 'source-not-archived' };
    try { return ensureStore(priorities).sourceState(ref, scope); }
    catch (error) { warn(error); return { state: 'blocked', reason: 'source-store-unavailable' }; }
  }

  function captureSource({ sessionId, turn, messageId, userText, expected, context = false } = {}) {
    const scope = readScope();
    if (!messageId && !expected) return { allowed: true, ref: null, reason: 'legacy-source-id' };
    if (!scope) return expected?.scope ? { allowed: false, reason: 'source-owner-changed' } : { allowed: true, ref: null, reason: 'legacy-owner' };
    const ref = expected || { scope, sessionId, turn, messageId, ...context?{}:{textHash:sourceTextHash(userText)} };
    const current = sourceState(ref);
    if (context && !expected && current.state==='live' && current.text.trim()!==String(userText || '').trim()) {
      return {allowed:false,reason:'context-source-changed',ref};
    }
    if (context && !expected && current.state==='unknown') ref.textHash=sourceTextHash(userText);
    return { allowed: ['live','unknown'].includes(current.state), reason: current.reason || current.state,
      ref: current.state==='live' ? { ...ref, ...current.ref } : ref };
  }

  function indexScope(scope, options = {}) {
    // Archive, repair and explicit rebuild share this writer. In particular a
    // paid API must not embed the same pending batch concurrently twice.
    const task = indexChain.then(() => doIndexScope(scope, options));
    indexChain = task.catch(() => {});
    return task;
  }

  async function doIndexScope(scope, { limit = 200,signal,authorize } = {}) {
    if(externalVectors)return {embedded:0,reason:'unified-vector-owner'};
    const check=()=>{signal?.throwIfAborted();if(authorize&&!authorize())throw Object.assign(Error('Raw memory authorization changed'),{code:'RAW_RECALL_CANCELLED'});};
    check();
    if (!scope || scope !== readScope() || disposed) return { embedded: 0 };
    const memory = ensureStore();
    const worker = await ensureModel();
    check();
    if (scope !== readScope() || disposed) return { embedded: 0 };
    const indexModelKey = modelKey;
    let plannedSources = 0;
    for(const source of memory.sourcesNeedingChunks(indexModelKey,{scope,limit:10})){
      check();
      if(scope!==readScope()||disposed)break;
      const chunks=await worker.planChunks(source.docText,{timeoutMs:config.rawRecallIndexTimeoutMs||30000,
        signal,scope,authorize:()=>scope===readScope()&&!disposed&&!signal?.aborted&&(!authorize||authorize())});
      check();
      if(scope!==readScope()||disposed)break;
      if(memory.putChunks(indexModelKey,source,chunks))plannedSources+=1;
    }
    if(scope!==readScope()||disposed)return {embedded:0,plannedSources};
    const pending = memory.pendingWindows(indexModelKey, { scope, limit });
    if (!pending.length) return { embedded: 0,plannedSources };
    let embedded = 0;
    const size = Math.max(1, Math.min(4, worker.batchSize || 4));
    for (let offset = 0; offset < pending.length; offset += size) {
      check();
      if (scope !== readScope() || disposed) break;
      const batch = pending.slice(offset, offset + size);
      const vectors = await worker.embed(batch.map((item) => item.text), {
        kind: 'document',
        timeoutMs: config.rawRecallIndexTimeoutMs || 30000,
        signal, scope, authorize: () => scope === readScope() && !disposed&&!signal?.aborted&&(!authorize||authorize()),
      });
      check();
      if(scope!==readScope()||disposed)break;
      if (vectors.length !== batch.length) throw new Error('Embedding result count does not match pending windows');
      embedded += memory.putVectors(indexModelKey, batch.map((item, index) => ({
        namespace: 'default',
        turnId: item.turnId,
        windowId: item.windowId,
        textHash: item.textHash,
        sourceVersion: item.sourceVersion,
        vector: vectors[index],
      })));
      await nextTick();
    }
    return { embedded,plannedSources };
  }

  async function archiveTurn(input) {
    if(input.signal?.aborted||input.authorize&&!input.authorize())return {skipped:'authorization-revoked'};
    if(!configured)return {skipped:'disabled'};
    if (closing || disposed) return { skipped: 'closing' };
    const scope = readScope();
    if (!scope) return { skipped: 'no-scope' };
    try {
      const turn = buildTurn({
        namespace: 'default',
        scope,
        sessionId: input.sessionId,
        turn: input.turn,
        completedAt: input.completedAt,
        messages: input.messages,
        windowChars: RAW_WINDOW_CHARS,
      });
      const result = ensureStore().archiveTurn(turn);
      if (result.pending > 0) {
        writeChain = writeChain.then(() => indexScope(scope,{signal:input.signal,authorize:input.authorize})).catch((error) => warn(error));
      }
      return { ...result, turnId: turn.turnId, scope };
    } catch (error) {
      warn(error);
      return { skipped: 'failed', error: error?.message || String(error), scope };
    }
  }

  function messageScope(input,authorize){
    if(closing||disposed)throw Error('Raw message store is closing');
    if(typeof authorize!=='function'||authorize()!==true)throw Object.assign(Error('Message authorization changed'),{code:'MEMORY_NOT_AUTHORIZED'});
    const scope=readScope();
    if(!scope||input.ownerSubject!==scope||input.project!==String(config.project))throw Object.assign(Error('Message scope changed'),{code:'MEMORY_NOT_AUTHORIZED'});
    return scope;
  }
  function recordMessage(input,{authorize}={}){
    messageScope(input,authorize);
    return ensureStore(false).messages.record(input,{authorize});
  }
  function completeMessageTurn(input,{authorize}={}){
    messageScope(input,authorize);
    return ensureStore(false).messages.completeTurn(input,{authorize});
  }
  function messageReader(scope,{authorize}={}){
    messageScope(scope,authorize);
    return {get:input=>{messageScope(scope,authorize);return ensureStore(false).messages.get({...input,...scope});},
      proof:input=>{messageScope(scope,authorize);return ensureStore(false).messages.proof({...input,...scope});},
      list:input=>{messageScope(scope,authorize);return ensureStore(false).messages.list({...input,...scope});},
      changes:input=>{messageScope(scope,authorize);return ensureStore(false).messages.changes({...input,...scope});}};
  }
  function entryRepository(scope,{authorize}={}){
    messageScope(scope,authorize);
    return Object.fromEntries(['get','project','remove','list','search','operation','prepare','checkpoint','approveReview','reviews'].map(name=>[name,input=>{
      messageScope(scope,authorize);return ensureStore(false).entries[name]({...input,...scope});
    }]));
  }
  function queryReader(scope,{authorize}={}){
    messageScope(scope,authorize);
    const reader=()=>{messageScope(scope,authorize);return createRawQueryReader(ensureStore(false),scope,{authorize});};
    return {search:input=>reader().search(input),recent:input=>reader().recent(input),get:ref=>reader().get(ref),neighbors:ref=>reader().neighbors(ref),embeddingContext:(ref,options)=>reader().embeddingContext(ref,options),legacyPage:input=>reader().legacyPage(input),fromTurns:(turns,input)=>reader().fromTurns(turns,input)};
  }
  function projectMessage(input,{authorize}={}){
    const scope=messageScope(input,authorize),memory=ensureStore(false);
    const source=memory.messages.get(input);
    if(!source||!source.isCurrent)return {skipped:'source-changed'};
    if(!source.text.trim())return {skipped:'no-text',sourceSaved:true};
    const turnId='message:'+JSON.stringify([scope,input.project,source.id]);
    const previous=memory.messageTurn(scope,source.messageId);
    if(previous&&previous.turn_id!==turnId)return {skipped:'legacy-message-binding',sourceSaved:true};
    const turn=buildTurn({namespace:memory.namespace,scope,turnId,sessionId:source.sessionId,turn:source.turn,
      completedAt:source.time??source.recordedAt,messages:[{id:source.messageId,role:source.role,text:source.text,seq:source.sequence,ts:source.time??source.recordedAt}],windowChars:RAW_WINDOW_CHARS});
    const result=memory.archiveTurn(turn);
    // Original commit and text projection never wait for the vector lane.
    if(configured&&result.pending>0)writeChain=writeChain.then(()=>indexScope(scope,{signal:input.signal,authorize})).catch(warn);
    return {...result,turnId};
  }
  function messageProjectionWork(input,{authorize}={}){
    const scope={ownerSubject:readScope(),project:String(config.project)};
    messageScope(scope,authorize);
    if(!memoryStore&&!existsSync(dbFile))return [];
    return ensureStore(false).messages.projectionWork({...input,...scope});
  }
  function messageProjectionReceipt(input,{authorize}={}){
    messageScope(input,authorize);
    return ensureStore(false).messages.projectionReceipt(input,{authorize});
  }

  // A crash or a model switch can leave archived windows without vectors.
  // Recover a bounded batch on the first authorized read instead of requiring
  // the user to send another turn.
  async function recoverScope(scope,{signal}={}) {
    if (recovering) return recovering;
    recovering = (async () => {
      await writeChain;
      if (!scope || scope !== readScope() || disposed) return { embedded: 0 };
      return indexScope(scope, { limit: 40,signal });
    })().catch((error) => warn(error)).finally(() => { recovering = null; });
    return recovering;
  }

  async function retrieve({ query, asOf = now().getTime(), since = 0, mode = 'hybrid', messageId = '', sessionId = '', signal, repair=true, deadline:externalDeadline, expectedModelKey, authorize } = {}) {
    if(!configured)return {turns:[],reason:'disabled'};
    if (disposed) return { turns: [], reason: 'disposed' };
    if (closing) return { turns: [], reason: 'closing' };
    if (signal?.aborted) throw cancelError(signal);
    if (!['hybrid', 'text', 'vector'].includes(mode)) throw new Error('Unknown raw retrieval mode');
    const allowed=()=>!authorize||authorize()===true;
    if(!allowed())throw cancelError(signal);
    if(!repair&&mode!=='text'&&(!backend?.status?.().prepared||!modelKey||expectedModelKey!==modelKey))return {turns:[],reason:'vector-unavailable'};
    const scope = readScope();
    if (!scope) return { turns: [], reason: 'no-scope' };
    const question = String(query ?? '').trim();
    if (!question && !messageId) return { turns: [], reason: 'empty-query' };
    const cutoff = Number(asOf), lower = Number(since);
    if (!Number.isFinite(cutoff) || !Number.isFinite(lower) || lower > cutoff) return { turns: [], reason: 'invalid-time-range' };
    const deadline=externalDeadline??Date.now()+config.rawRecallTimeoutMs;
    if(deadline<=Date.now())return {turns:[],reason:'partial-timeout',partial:true};
    const remaining=()=>Math.max(1,deadline-Date.now());
    const memory = ensureStore(repair), capacity = Math.max(1, config.rawRecallCandidates);
    const textHits = mode==='vector'?[]:memory.searchText(question, { scope, asOf: cutoff, since: lower, messageId, sessionId, limit: capacity });
    const best = new Map();
    const order=(a,b)=>b.score-a.score||b.completedAt-a.completedAt||a.turnId.localeCompare(b.turnId);
    let scannedWindows = 0, partial = false, vectorState = 'not-requested';
    if (mode !== 'text' && question && !messageId) {
      try {
        // A searchable source never waits for its background vector repair.
        // Retain the former repair-on-read path when text has no candidate.
        const recovery = repair?recoverScope(scope,{signal}):Promise.resolve();
        const timeoutMs = remaining();
        const querySignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
        const worker = repair?await withDeadline(ensureModel(), timeoutMs, signal):backend;
        if (scope !== readScope() || disposed||!allowed()||expectedModelKey&&expectedModelKey!==modelKey) return { turns: [], reason: 'scope-changed', scope };
        const queryModelKey = modelKey;
        if (!memory.hasVectors(queryModelKey, { scope, asOf: cutoff }) && !textHits.length) await withDeadline(recovery, remaining(), signal);
        if (!memory.hasVectors(queryModelKey, { scope, asOf: cutoff })) vectorState = 'missing';
        else {
          // Respect the configured vector budget even when text hits exist.
          // If it expires, return those already-collected text candidates.
          const [vector] = await withDeadline(worker.embed([question], { kind: 'query', timeoutMs: remaining(), signal, queueSignal: querySignal,
            scope, authorize: () => scope === readScope() && !disposed&&allowed()&&(!expectedModelKey||expectedModelKey===modelKey) }), Math.min(timeoutMs, remaining()), signal);
          vectorState = vector?.length ? 'ok' : 'empty';
          if (vector?.length) for (const page of memory.windowPages(queryModelKey, { scope, asOf: cutoff })) {
            if (signal?.aborted) throw cancelError(signal);
            if (scope !== readScope()||!allowed()||expectedModelKey&&expectedModelKey!==modelKey) return { turns: [], reason: 'scope-changed', scope };
            if (Date.now() >= deadline) { partial = true; break; }
            for (const row of page) {
              scannedWindows += 1;
              if (row.completedAt < lower || (sessionId && row.session_id !== sessionId) || row.vector.length !== vector.length) continue;
              const score = cosine(vector, row.vector) * row.weight;
              const key = candidateKey(row);
              if (score < minSimilarity() || score <= (best.get(key)?.score ?? -1)) continue;
              best.set(key, { turnId: row.turnId, sourceVersion: row.sourceVersion, score, weight: row.weight, completedAt: row.completedAt,
                matchedRanges: [{ start: Number(row.start_offset), end: Number(row.end_offset) }] });
              if (best.size > capacity) { const sorted = [...best.values()].sort(order); best.delete(candidateKey(sorted.at(-1))); }
            }
            await nextTick();
          }
        }
      } catch (error) {
        if (error?.code === 'RAW_RECALL_CANCELLED') throw error;
        vectorState = error?.code === 'RAW_RECALL_TIMEOUT' ? 'timeout' : 'failed';
        partial = true;
        if (!(textHits.length && error?.code === 'RAW_RECALL_TIMEOUT')) warn(error);
      }
    }
    if(signal?.aborted)throw cancelError(signal);
    if(scope!==readScope()||!allowed()||expectedModelKey&&expectedModelKey!==modelKey)return {turns:[],reason:'scope-changed',scope};
    const vectorHits = [...best.values()].sort(order);
    const merged = new Map();
    // Rank fusion combines two different scoring scales; BM25 is not a
    // probability and must never be compared directly with cosine scores.
    for (const [route, hits] of [['text', textHits], ['vector', vectorHits]]) hits.forEach((hit, index) => {
      const key = candidateKey(hit);
      const previous = merged.get(key);
      const fusionRank = (previous?.fusionRank || 0) + 1 / (60 + index + 1);
      const entry = { ...previous, ...hit, routes: [...(previous?.routes || []), route],
        fusionRank, fusion: fusionRank * hit.weight };
      if (route === 'text') entry.lexicalScoreBase = hit.lexicalScore / hit.weight;
      if (route === 'vector' && previous) entry.lexicalScore = previous.lexicalScore;
      merged.set(key, entry);
    });
    const bounds = Object.freeze({ scope, asOf: cutoff, since: lower, sessionId, messageId });
    const candidates = [...merged.values()];
    const byVersion = new Map(candidates.map(hit => [candidateKey(hit), hit]));
    // Validate the bounded pool BEFORE top-N: changed sources must not occupy
    // the slots of still-valid evidence. Do not retry against a moving source.
    const current = memory.loadTurns(candidates, bounds);
    const turns = current.map(turn => ({ ...refreshCandidate(byVersion.get(candidateKey(turn)), turn), retrievalBounds: bounds }))
      .sort((a, b) => b.fusion - a.fusion || order(a, b)).slice(0, config.rawRecallTop);
    const retrieval = { textTurns: textHits.length, vectorTurns: vectorHits.length, vectorState,
      staleTurns: candidates.length - current.length };
    const reason = turns.length ? (partial && vectorState === 'ok' ? 'partial-timeout' : 'ok')
      : partial ? 'partial-timeout' : memory.stats(modelKey, scope).turns ? 'no-candidate' : 'empty-store';
    return { turns, reason, scope, scannedWindows, partial, retrieval };
  }

  function select({ turns, query, budget, existingMessages = [] } = {}) {
    if(!configured)return {text:'',chars:0,reason:'disabled'};
    if (closing || disposed) return {text:'',chars:0,reason:'closing'};
    const limitChars = Math.max(0, Math.min(Number(budget) || 0, config.rawRecallMaxChars));
    if (limitChars <= 0) return { text: '', chars: 0, reason: 'no-budget', groups: [], turnIds: [], messageIds: [], skippedCovered: 0, skippedBudget: 0 };
    const scope = readScope();
    // The caller may compose facts between retrieve and select. Read again at
    // the final quote boundary so edits/revocations during that work take effect.
    const current = [];
    const refs = turns || [];
    if (scope && refs.length) {
      const memory = ensureStore();
      const batches = new Map();
      for (const hit of refs) {
        if (!hit.sourceVersion || hit.scope !== scope || hit.retrievalBounds?.scope !== scope) continue;
        const batch = batches.get(hit.retrievalBounds) || [];
        batch.push(hit);
        batches.set(hit.retrievalBounds, batch);
      }
      for (const [bounds, hits] of batches) {
        const byVersion = new Map(hits.map(hit => [candidateKey(hit), hit]));
        for (const source of memory.loadTurns(hits, bounds)) {
          current.push(refreshCandidate(byVersion.get(candidateKey(source)), source));
        }
      }
    }
    const selected = selectEvidence({
      turns: current,
      query,
      existingMessages,
      budget: limitChars,
      minScore: minSimilarity(),
    });
    return { ...selected, staleTurns: refs.length - current.length,
      reason: selected.text ? 'ok' : (refs.length && !current.length ? 'source-changed' : current.length ? 'no-selection' : 'no-candidate') };
  }

  async function recall({ query, budget, asOf = now().getTime(), since = 0, mode = 'hybrid', messageId = '', sessionId = '', existingMessages = [], signal } = {}) {
    if(!configured)return {text:'',reason:'disabled'};
    if (closing || disposed) return { text: '', reason: 'closing' };
    if (!String(query ?? '').trim() && !messageId) return { text: '', reason: 'empty-query' };
    try {
      const retrieved = await retrieve({ query, asOf, since, mode, messageId, sessionId, signal });
      if (!retrieved.turns.length) return { text: '', reason: retrieved.reason, modelKey, scope: retrieved.scope,partial:retrieved.partial,scannedWindows:retrieved.scannedWindows,retrieval:retrieved.retrieval };
      const selected = select({ turns: retrieved.turns, query, budget, existingMessages });
      return { ...selected, modelKey, scope: retrieved.scope,partial:retrieved.partial,scannedWindows:retrieved.scannedWindows,retrieval:retrieved.retrieval };
    } catch (error) {
      if (error?.code === 'RAW_RECALL_CANCELLED') {
        return { text: '', reason: 'cancelled', error: error.message, modelKey };
      }
      warn(error);
      return { text: '', reason: 'failed', error: error?.message || String(error), modelKey };
    }
  }

  return {
    enabled: configured,
    configured,
    useExternalVectors(){externalVectors=true;},
    get modelKey() { return modelKey; },
    dbFile,
    maintenanceRevision(){
      const scope=readScope();
      return scope&&(memoryStore||existsSync(dbFile))?ensureStore(false).maintenanceRevision(scope):null;
    },
    archiveTurn,
    recordMessage,
    completeMessageTurn,
    messageReader,
    entryRepository,
    queryReader,
    projectMessage,
    messageProjectionWork,
    messageProjectionReceipt,
    sourceState,
    querySourceState:ref=>sourceState(ref,false),
    captureSource,
    retrieve,
    select,
    recall,
    async flush() {
      await writeChain;
    },
    async indexPending({signal}={}){
      if(!configured)return {embedded:0,reason:'disabled'};
      await writeChain;
      const scope=readScope();let embedded=0;
      while(scope&&scope===readScope()&&!disposed){signal?.throwIfAborted();const r=await indexScope(scope,{limit:200,signal});embedded+=r.embedded;if(!r.embedded&&!r.plannedSources)break;}
      return {embedded,modelKey,stats:scope&&memoryStore?memoryStore.stats(modelKey,scope):null};
    },
    control(input){
      const scope=readScope();if(!scope)throw new Error('No authorized raw memory owner');
      return ensureStore().setControl({...input,scope});
    },
    softenSources({sources=[],weight=0.5,memoryId=''}){
      const scope=readScope();if(!scope)return {affected:0,reason:'no-scope'};
      const ids=[...new Set(sources.map(s=>s.message_id||s.messageId).filter(Boolean))];
      let affected=0;
      for(const id of ids)affected+=ensureStore().setControl({scope,targetType:'message',targetId:id,origin:'memory:'+memoryId,weight,reason:'linked factual memory softened'}).affected;
      return {affected,sources:ids.length,reason:ids.length?'ok':'no-traceable-source'};
    },
    softenMessage(messageId){
      const scope=readScope();if(!scope)return {ok:false,reason:'target-not-found'};
      const memory=ensureStore();
      if(!memory.messageTurn(scope,messageId))return {ok:false,reason:'target-not-found'};
      const old=memory.getControl({scope,targetType:'message',targetId:messageId});
      const weight=Math.max(0.01,old.weight*config.softenFactor);
      return {ok:true,...memory.setControl({scope,targetType:'message',targetId:messageId,weight,reason:'explicit raw message downweight'})};
    },
    scope() {
      return readScope();
    },

    status() {
      const scope = readScope();
      let stats = null;
      let embeddingUsage = null;
      let error = lastError?.message || null;
      if (memoryStore) {
        try { stats = memoryStore.stats(modelKey, scope); embeddingUsage = memoryStore.embeddingUsageSummary?.(scope) || null; } catch (cause) { error = cause?.message || String(cause); }
      }
      return {
        enabled: configured&&Boolean(scope),
        configured,
        vectorOwner:externalVectors?'unified':'raw',
        modelKey,
        backend: backend?.status?.() || { requestedModel: config?.rawRecallModel || 'BAAI/bge-small-zh-v1.5', prepared: false, modelKey },
        dbFile,
        scope,
        stats,
        embeddingUsage,
        textSearchAvailable: memoryStore?.textSearchAvailable ?? null,
        lastError: error,
      };
    },
    dispose() {
      if (closingTask) return closingTask;
      if (disposed) return Promise.resolve();
      closing = true;
      closingTask = (async () => {
        // Keep the store open through in-flight API usage receipts as well as
        // accepted indexing. Every concurrent close waits for this same task.
        try { await writeChain; } catch (error) { warn(error); }
        try { await recovering; } catch { /* already recorded */ }
        disposed = true;
        await indexChain;
        await backend?.dispose?.();
        memoryStore?.close?.();
      })();
      return closingTask;
    },
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Config, resolveConfig } from './config.js';
import {createMessageRecorder} from './message-recorder.js';
import {createMemoryEntryAccess} from './memory-entry-access.js';
import {createMemoryQueryAnswer,createMemoryQueryTools,createMemoryReferenceLoader} from './memory-query.js';
import {createMemoryPipeline} from './memory-pipeline.js';
import {createMemoryOrganizer} from './memory-organizer.js';
import {createMemoryVectors} from './memory-vectors.js';
import {createMemoryVaultWatch} from './memory-vault-watch.js';
import {resolveProcessingTarget} from './processing-model.js';
import {createHandoffController,selectHandoff} from './handoff.js';
import {MEMORY_CHANGE_KINDS,MEMORY_HANDOFF_SOURCE,normalizeHandoffTokens} from './memory-contract.js';
import { createMemoryWorker, hasSessionMemory, memoryJobSource, authorizedTools } from './worker.js';
import { createPermanentDeleteGuard } from './delete-guard.js';
import { makeRecallMessage, collectFactRecall } from './recall.js';
import { createRecordsTool, collectPersonalRecall } from './records.js';
import { createSoftenTool } from './memory.js';
import { compileSpec } from './tool-schema.js';
import { contentText, isDirectUserMessage } from './text.js';
import { collectNavigation } from './navigation.js';
import { CONTEXT_SOURCE, composeMemoryContext, expireMemoryContext, recallConversation } from './context.js';
import { createMemoryStatus } from './status.js';
import { DEFAULT_VAULT_PATH,managementDirectory } from './review.js';
import { createTimelineReader } from './timeline.js';
import { createRecentConversationStore, createRecentConversationTool, recentContextFile, RECENT_SOURCE } from './recent-context.js';
import { createPersonalAccess } from './personal-access.js';
import { createRawRecall } from './raw-rag/index.js';
import { RAW_RECALL_SOURCE } from './raw-rag/constants.js';
import { memorySourceState } from './source-lineage.js';

export const name = 'basic-memory-bridge';
export const inject = ['tools', 'llm', 'agents'];

const MAX_TRACKED_KEYS = 1000;

/** Explicit session-memory hosts must not read old recent history at startup. */
export function createLazyRecentConversationStore(options) {
  let store;
  return new Proxy({}, {get(_target,key) {
    if(key==='file')return recentContextFile(options.config);
    if(key==='idle')return ()=>store?store.idle():Promise.resolve();
    return (...args)=>{store??=createRecentConversationStore(options);return store[key](...args);};
  }});
}

function trimSet(set, maxSize) {
  while (set.size > maxSize) {
    const oldest = set.values().next().value;
    set.delete(oldest);
  }
}

/**
 * Build the bridge's hook handlers with injected services, so the same logic is
 * usable from the Cordis plugin and from unit tests.
 */
export function createBridge({ config, tools, llm, logger, now, findAgent, listAgents, semanticOrganizer, pipelineResources, pipelineCommitted, recentStore, recoveryStore, captureSubject, maintenanceOwnerAllowed, access, ownerSubject, rawRecallStore, rawRecallEmbedder, resolveChatConnection } = {}) {
  const resolved = resolveConfig(config);
  const sessions = new Map();
  const agents = new Map();
  const recalledTurns = new Set();
  const enqueuedTurns = new Set();
  const recentWrites = new Set();
  const deleteGuard = createPermanentDeleteGuard({ tools, logger });
  const gated = hasSessionMemory(access);
  const recentMode = gated&&typeof access.admitMessage==='function'?'originals':'cache';
  const memoryStatus = createMemoryStatus(resolved, logger, {recentMode});
  const statusReady = memoryStatus.get('__bridge_initialization__').catch(()=>{});
  const statusWrites = new Set();
  const timeline = createTimelineReader({ config: resolved, logger, now });
  const recentContext = recentStore || (gated?createLazyRecentConversationStore:createRecentConversationStore)({config:resolved,logger});
  const rawRecall = createRawRecall({ config: resolved, logger, now, ownerSubject:ownerSubject??access?.ownerSubject, store: rawRecallStore, embedder: rawRecallEmbedder });
  const report = (id, turn, patch) => {
    const task=memoryStatus.set(id, turn, patch).catch(() => {});
    statusWrites.add(task);task.finally(()=>statusWrites.delete(task));return task;
  };
  let pipeline,vectors;
  const messageRecorder=gated&&typeof access.admitMessage==='function'?createMessageRecorder({access,raw:rawRecall,recent:recentContext,recentMode,
    refreshRecentStats:memoryStatus.refreshRecentStats,report,logger,
    processingContextFor:source=>({owner:pipeline?.enabled?'pipeline-v1':'legacy',target:resolveProcessingTarget(resolved,findAgent?.(source.sessionId))})}):null;
  const priorityConfig=async()=>({...resolved,naturalDecayStartedAt:(await worker.store.read()).naturalDecayStartedAt});
  const entries=messageRecorder?createMemoryEntryAccess({access,raw:rawRecall,tools,config:resolved,getPriorityConfig:()=>worker.getConfig()}):null;
  const listLiveAgents=()=>listAgents?.()??[...agents.values()];
  const backgroundAvailable=()=>!listLiveAgents().some(agent=>agent.status==='running');
  const managementAgent=()=>listLiveAgents()[0]??{id:'memory-management',session:{id:'memory-management'}};
  if(entries&&resolved.rawRecall&&resolved.vaultPath){
    vectors=createMemoryVectors({directory:path.join(managementDirectory(resolved),'vectors'),access,raw:rawRecall,entries,tools,config:resolved,
      findAgent,listAgents:listLiveAgents,ownerSubject:rawRecall.scope(),canRun:backgroundAvailable,
      managementAgent,getPriorityConfig:priorityConfig});
    rawRecall.useExternalVectors();
  }
  const organizer=semanticOrganizer??(entries&&typeof llm?.stream==='function'?createMemoryOrganizer({entries,llm,config:resolved,
    loadReferences:createMemoryReferenceLoader({access,tools,vectors,config:resolved,now})}):undefined);
  pipeline=entries&&resolved.vaultPath?createMemoryPipeline({file:path.join(managementDirectory(resolved),'pipeline','state.json'),raw:rawRecall,access,findAgent,
    listAgents:listLiveAgents,organizer:resolved.autoCapture?organizer:undefined,canRun:pipelineResources,
    onCommitted:async(result,context)=>{await pipelineCommitted?.(result,context);await vectors?.notifyChanged({...context.scope,id:result.batchId,revision:result.batchId,kind:'semantic'});}}):null;
  const pipelineRegistration=pipeline&&messageRecorder?.subscribe(notice=>pipeline.notify(notice));
  const vectorRegistration=vectors&&messageRecorder?.subscribe(notice=>vectors.notifyChanged(notice));
  const pipelineRecovery=()=>pipeline?.resume().catch(cause=>logger?.warn?.('[memory-pipeline] '+(cause.code??'MEMORY_PIPELINE_FAILED')));
  if(pipeline?.enabled)pipelineRecovery();
  const vectorSetup=vectors?(async()=>{const grant=vectors.managementGrant();try{await vectors.registerCurrentConfig({grant});}finally{grant.cancel();}})():Promise.resolve();
  vectorSetup.catch(cause=>logger?.warn?.('[memory-vectors] '+(cause.code??'MEMORY_VECTOR_SETUP_FAILED')));
  const notifyVault=()=>vectors.notifyChanged({ownerSubject:rawRecall.scope(),project:resolved.project,id:'vault',revision:randomUUID(),kind:'vault'});
  const vaultWatch=vectors?createMemoryVaultWatch({vaultPath:resolved.vaultPath,canRun:backgroundAvailable,logger,onChange:notifyVault,onScan:()=>vectors.reconcileMaintenance()}):null;
  const vaultStartup=vaultWatch?vectorSetup.then(async()=>{
    const grant=vectors.managementGrant();
    try{
      if(!await vectors.getSnapshot({grant})||vaultWatch.status().closed)return;
      const observed=await vaultWatch.start();
      if(!observed.closed&&!observed.files)await notifyVault();
      if(!observed.closed)await vectors.resume();
    }finally{grant.cancel();}
  }).catch(error=>logger?.warn?.('[memory-vault] '+(error.code??'VAULT_START_FAILED'))):null;
  let runtimeOperation={state:'idle'},runtimeTask;
  async function getMemoryRuntime(){
    await vectorSetup;let vectorState=null;
    if(vectors){const grant=vectors.managementGrant();try{vectorState=await vectors.status({grant});}finally{grant.cancel();}}
    const legacy=new Map();
    if(pipeline?.enabled){
      const state=await worker.store.read();
      const count=(id,key)=>{
        if(typeof id!=='string'||!/^session-[a-zA-Z0-9_-]+$/.test(id))return;
        const row=legacy.get(id)??{sessionId:id,capture:0,maintenance:0};row[key]++;legacy.set(id,row);
      };
      for(const job of state.jobs)if(!job.channel)count(job.sessionId,'capture');
      for(const item of state.pending)for(const id of new Set(item.owners?.map(owner=>owner.sessionId)))count(id,'maintenance');
    }
    return {pipeline:pipeline?.status()??null,vectors:vectorState,vault:vaultWatch?.status()??null,legacy:[...legacy.values()],operation:{...runtimeOperation}};
  }
  async function runMemoryRuntime(input={}){
    const action=input.action;
    if(!['load','release','prepare','resume-prepare','cancel','resume','flush','retry','legacy-recover'].includes(action))throw Error('未知记忆运行操作');
    await vectorSetup;
    let target;
    if(['load','release','prepare','resume-prepare','cancel'].includes(action)){
      if(!vectors)throw Error('向量服务尚未接入');const grant=vectors.managementGrant();
      try{
        const state=await vectors.status({grant}),id=input.profileId??state.selectedProfileId,profile=state.profiles.find(row=>row.id===id);
        if(!profile)throw Error('当前型号尚未登记，请先保存并应用模型设置');
        if(input.profileRevision!==undefined&&String(input.profileRevision)!==String(profile.revision))throw Error('运行配置已变化，请刷新后再操作');
        target={profileId:id,profileRevision:profile.revision};
        if(action==='resume-prepare'){
          if(!input.intentId||input.intentId!==profile.progress?.intentId)throw Error('原准备任务已变化，请刷新后再操作');
          target.intentId=input.intentId;
        }
      }finally{grant.cancel();}
    }
    if(action==='cancel'){
      const grant=vectors.managementGrant();try{return await vectors.cancel({grant,...target});}finally{grant.cancel();}
    }
    if(runtimeOperation.state==='running')throw Error('当前记忆操作尚未结束');
    if(['load','release','prepare'].includes(action)&&!vectors)throw Error('向量服务尚未接入');
    if(action==='retry'&&(typeof input.batchId!=='string'||!input.batchId))throw Error('需要明确的整理批次');
    if(action==='legacy-recover'){
      if(!pipeline?.enabled||!backgroundAvailable()||pipeline.status().busy)throw Error('请等待对话和后台整理空闲后再恢复旧任务');
      if(typeof input.sessionId!=='string'||!/^session-[a-zA-Z0-9_-]+$/.test(input.sessionId))throw Error('请选择旧任务原会话');
    }
    const id=randomUUID();runtimeOperation={id,action,...target,state:'running',startedAt:Date.now()};
    runtimeTask=(async()=>{
      if(['load','release','prepare','resume-prepare'].includes(action)){
        const grant=vectors.managementGrant();
        try{
          if(action==='prepare'||action==='resume-prepare')void vaultWatch?.start();
          return await vectors[action==='resume-prepare'?'resumePreparation':action]({grant,...target});
        }finally{grant.cancel();}
      }
      if(action==='retry')return pipeline?.retry(input.batchId);
      if(action==='legacy-recover')return worker.resumeLegacyRecovery({sessionId:input.sessionId});
      if(action==='resume'){await pipeline?.resume();await vectors?.resume();return pipeline?.wake();}
      return pipeline?.wake({force:true});
    })().then(result=>{runtimeOperation={...runtimeOperation,state:'completed',finishedAt:Date.now(),...(action==='legacy-recover'?{receipt:result}:{})};return result;},cause=>{
      runtimeOperation={...runtimeOperation,state:'failed',finishedAt:Date.now(),error:cause.code??'MEMORY_RUNTIME_FAILED'};
      logger?.warn?.('[memory-runtime] '+(cause.code??'MEMORY_RUNTIME_FAILED'));
    });
    return {started:true,id,action};
  }
  async function manageMemoryReview(input,check){
    if(!entries)throw Error('当前记忆框架尚未启用人工审核');
    const reviews=entries.forManagement({agent:managementAgent(),check});
    if(input.action==='list')return reviews.list(input);
    if(input.action==='read')return {review:await reviews.read(input.operationId)};
    const result=await reviews.decide(input);
    if(result.state==='committed')await vectors?.notifyChanged({ownerSubject:rawRecall.scope(),project:resolved.project,
      id:result.id,revision:result.revision,kind:'semantic'});
    return {result};
  }
  async function manageMemoryDocuments(input,check){
    if(!vectors)throw Error('当前记忆框架尚未启用资料选择');
    check();
    const grant=vectors.managementGrant();
    try{
      if(input.identifiers===undefined)return await vectors.documentSelection({grant});
      return await vectors.selectDocuments({grant,identifiers:input.identifiers,expectedRevision:input.revision,check});
    }finally{grant.cancel();}
  }
  const queryAnswers=new Map();
  function closeQueryAnswer(sessionId){
    const answer=queryAnswers.get(sessionId);if(!answer)return;
    queryAnswers.delete(sessionId);
    const state=sessions.get(sessionId);if(state)state.lastQueryBudget=answer.session.budget();
    try{answer.session.dispose();}catch(error){logger?.warn?.('[memory-query] release: '+error.message);}
  }
  function queryAnswer(agent){
    const id=agent?.session?.id,state=sessions.get(id);
    if(!entries||!state||!personalAllowed(agent).allowed)throw Error('本回答的记忆入口不可用');
    let current=queryAnswers.get(id);
    if(current&&(current.turn!==state.turn||current.agent!==agent)){closeQueryAnswer(id);current=null;}
    if(!current){current={agent,turn:state.turn,session:createMemoryQueryAnswer({access,agent,answerTurn:state.turn,raw:rawRecall,entries,tools,config:resolved,vectors,getPriorityConfig:priorityConfig})};queryAnswers.set(id,current);}
    return current.session;
  }
  const queryTools=entries?createMemoryQueryTools({answer:queryAnswer}):[];
  const memoryChangeTool=pipeline?.enabled?{
    name:'memory_mark_change',
    description:'按 memory-capture Skill，在用户明确要求长期记住、更正或确认／取消决定时，提示后台优先整理本轮。回执表示已受理。',
    parameters:{kind:{type:'string',enum:MEMORY_CHANGE_KINDS,required:true}},
    output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    execute({kind},{agent,signal}){
      signal?.throwIfAborted();
      const state=sessions.get(agent?.session?.id);
      if(!MEMORY_CHANGE_KINDS.includes(kind))throw Error('整理提示类型无效');
      if(!state||!readAllowed(state,agent)||!turnAllowed(state,agent))throw Error('本轮未获得记忆整理授权');
      const duplicate=Boolean(state.memoryChangeKind);
      state.memoryChangeKind??=kind;
      return {accepted:true,state:'awaiting-turn-completion',duplicate};
    },
  }:null;
  const handoff=messageRecorder&&resolved.vaultPath?createHandoffController({config:resolved}):null;
  let handoffTokens=resolved.handoffTokens;
  const handoffWrites=new Set();
  function finishHandoff(sessionId,state,completed){
    if(!handoff)return;
    const agent=state.agent??findAgent?.(sessionId),authorize=()=>{
      if(state.memoryReadAuthorization)return access.validate(state.memoryReadAuthorization);
      const current=personalAllowed(agent);return Boolean(state.memoryStart?.allowed&&current.allowed&&state.memoryStart.epoch===current.epoch);
    };
    if(!authorize()||!state.handoffAttempt&&completed)return;
    const operation=state.handoffAttempt?handoff.finish({sessionId,turn:state.turn,completed,delivered:state.handoffDelivered===true},{authorize}):handoff.failed({sessionId,turn:state.turn},{authorize});
    const work=operation.catch(error=>{
      logger?.warn?.('[memory-handoff] completion: '+error.message);
    });
    handoffWrites.add(work);work.finally(()=>handoffWrites.delete(work));
  }
  function reportRecall(id, turn, recall) {
    const state = sessions.get(id);
    if (state?.turn === turn) state.recall = recall;
    return report(id, turn, { recall });
  }

  /**
   * Portable mode owns its own Basic Memory client, so ctx.tools restriction
   * cannot prove anything here. Ask the host-owned pure-mode state (the
   * `access` gate) before any personal recall, capture or short-term read.
   */
  function personalAllowed(agent) {
    if (typeof access?.check !== 'function') return { allowed: true, installed: false, reason: 'no-gate' };
    try { return access.check(agent); }
    catch (error) { logger?.warn?.('[basic-memory-bridge] pure-mode gate failed: ' + (error instanceof Error ? error.message : String(error))); return { allowed: false, reason: 'gate-failed' }; }
  }
  function turnAllowed(state, agent) {
    if(!gated)return personalAllowed(agent).allowed;
    try{return Boolean(state?.memoryAuthorization && access.validate(state.memoryAuthorization,memoryJobSource({...state,sessionId:agent?.session?.id})));}catch{return false;}
  }
  function readAllowed(state,agent){
    if(!gated)return personalAllowed(agent).allowed;
    try{return Boolean(state?.memoryReadAuthorization&&access.validate(state.memoryReadAuthorization));}catch{return false;}
  }
  function bindTurn(state,agent) {
    if(!gated || state.memoryResolved)return;
    state.memoryResolved=true;
    const current=personalAllowed(agent);
    if(!state.memoryStart?.allowed || !current.allowed || state.memoryStart.epoch!==current.epoch)return;
    try {
      const grant=access.grant(agent,memoryJobSource({...state,sessionId:agent.session.id}));
      if(grant && access.validate(grant))state.memoryAuthorization=grant;
    } catch(error) {
      logger?.warn?.('[basic-memory-bridge] source grant unavailable: '+(error.code||error.message));
    }
  }

  /**
   * Ask the host-owned pure-mode service whether this session's background
   * memory is allowed to use conversational history. An installed service that
   * advertises historyPolicy but cannot answer is treated as userOnly, and a
   * mixed-version service that lacks the method is also strict. Only a
   * completely absent pure plugin keeps the existing normal flow.
   */
  function historyPolicyFor(agent) {
    if (typeof access?.historyPolicy !== 'function') return { userOnly: false, installed: false, reason: 'no-policy' };
    try {
      const state = access.historyPolicy(agent);
      if (!state || typeof state.userOnly !== 'boolean') return { installed:true, userOnly:true, reason:'invalid-policy' };
      return state;
    } catch (error) {
      logger?.warn?.('[basic-memory-bridge] history policy failed: ' + (error instanceof Error ? error.message : String(error)));
      return { userOnly: true, installed: true, reason: 'policy-failed', error };
    }
  }

  /** Resolve once per turn, but never undo an already-strict decision. */
  function applyHistoryPolicy(state, agent, accessState) {
    if (!agent) return { userOnly: state?.historyUserOnly === true, reason: 'no-agent' };
    if (state?.historyResolved) return { userOnly: state.historyUserOnly === true, reason: state.historyReason || '' };
    const allowed = accessState || personalAllowed(agent);
    if (!allowed.allowed) return { userOnly: state?.historyUserOnly === true, reason: allowed.reason };
    const policy = historyPolicyFor(agent);
    if (state) {
      state.historyResolved = true;
      state.historyUserOnly = policy.userOnly === true;
      state.historyReason = policy.reason || '';
    }
    return policy;
  }

  /**
   * Resolve one MCP definition through the live agent scope. This is a
   * read-only probe: it never mounts a server or rewrites session settings.
   * Missing runtimes, missing definitions, thrown lookups and definitions
   * without execute are all treated as unavailable.
   */
  function visibleTool(toolName, agent) {
    if (!agent || typeof tools?.get !== 'function') return null;
    try {
      const definition = tools.get(toolName, agent);
      return definition && typeof definition.execute === 'function' ? definition : null;
    } catch {
      return null;
    }
  }

  function recallToolsAvailable(agent) {
    return Boolean(visibleTool('mcp__basic_memory__search_notes', agent));
  }

  function captureToolsAvailable(agent) {
    return Boolean(
      visibleTool('mcp__basic_memory__read_note', agent)
      && visibleTool('mcp__basic_memory__write_note', agent),
    );
  }

  function softenerAvailable(agent) {
    return Boolean(visibleTool('soften_memory', agent));
  }

  function recentAvailable(agent) {
    // Short-term context writes are personal memory too: the same host-owned
    // gate covers the user/message path that runs before the first pre-step and
    // the manual recent tool, not only the pre-step read.
    return personalAllowed(agent).allowed
      && resolved.recentContext && Boolean(resolved.vaultPath)
      && recallToolsAvailable(agent) && captureToolsAvailable(agent);
  }
  function recentReport(id,turn,stats,extra={}) {
    const {text,rows,messages,coverage,...metadata}=stats;
    return report(id,turn,{recentContext:{...metadata,...extra}});
  }
  function saveRecent(sessionId,state,input) {
    if(messageRecorder)return;
    if(!state.recentAllowed || !turnAllowed(state,state.agent))return;
    // The recent store owns its disk queue; recheck after its earlier work drains.
    const record=async()=>{if(gated)await recentContext.idle();if(!turnAllowed(state,state.agent))return {enabled:false,reason:'memory-authorization-revoked'};return recentContext.record({sessionId,turn:state.turn,...input,
      ...(gated?{signal:state.memoryAuthorization.signal,authorize:()=>turnAllowed(state,state.agent)}:{})});};
    const task=record()
      .then(stats=>recentReport(sessionId,state.turn,stats,{...state.recentSelection}))
      .catch(error=>recentReport(sessionId,state.turn,{enabled:true,storage:'error',reason:'storage-error',error:error.message}));
    recentWrites.add(task);task.finally(()=>recentWrites.delete(task));
  }

  /** Keep only direct user words from before the current user/message event. */
  function earlierDirectUserMessages(session, currentId, { includeHistory = true, withIds = false } = {}) {
    if (!includeHistory) return [];
    try {
      const messages = session?.deriveMessages?.();
      if (!Array.isArray(messages)) return [];
      const direct = messages.filter((message) => isDirectUserMessage(message));
      const current = currentId ? direct.findIndex((message) => String(message.id) === String(currentId)) : -1;
      const earlier = current >= 0 ? direct.slice(0, current) : (currentId ? direct : direct.slice(0, -1));
      return earlier
        .map((message) => ({messageId:String(message.id || ''),text:contentText(message.content).trim()}))
        .filter(message=>message.text)
        .slice(-3).map(message=>withIds?message:message.text);
    } catch {
      return [];
    }
  }

  function makeControlPolicyMessage() {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: [
          '<memory_control_policy source="dafeiyu">',
          'When the user explicitly asks to stop bringing up, downweight, soften, or forget one specific stored memory, use the soften_memory tool.',
          'First locate the exact target with search/read or an id/permalink already in context. If several notes match, ask which one.',
          'Call soften_memory only after the target is unambiguous, and do not confirm a downweight before the tool succeeds.',
          'A phrase such as 别忘了 or 我忘了 by itself is not a downweight request.',
          'Ordinary user facts and events are handled by the existing automatic turn-end capture; do not call write_note, edit_note, or move_note on bridge-managed notes under chats/facts, chats/events, or chats/history in the foreground, because that bypasses the bridge history and versioning. Search and read are allowed.',
          'This restriction does not apply to dafeiyu_records subjective notes or to soften_memory; a downweight must still be executed and succeed in the foreground before you confirm it.',
          'When the user corrects something, acknowledge it naturally and let the turn-end capture persist it; do not claim the disk has already been updated.',
          'This policy is not user memory and must never be stored as a fact.',
          '</memory_control_policy>',
        ].join('\n'),
      }],
      source: { kind: 'dafeiyu-memory-control', form: 'policy' },
    };
  }

  /**
   * A successful soften call belongs to the current turn. Capture must not
   * turn that memory-control instruction into a new fact for the same turn.
   * This is an in-memory turn marker, not a disable switch for later turns.
   */
  async function markSoftened(sessionId,result) {
    const state = sessions.get(sessionId);
    if (!state)return;
    state.captureSuppressed = true;
    await pipeline?.suppressTurn({sessionId,turn:state.turn,ownerSubject:rawRecall.scope(),project:resolved.project});
    if(result?.softenedAt&&result.permalink)await vectors?.notifyChanged({ownerSubject:rawRecall.scope(),project:resolved.project,
      id:result.memoryId||result.permalink,revision:result.softenedAt,kind:'semantic'});
  }

  const worker = createMemoryWorker({
    access,
    captureSubject, maintenanceOwnerAllowed,
    recoveryStore,
    config: resolved, tools, llm, logger, now, status: memoryStatus, findAgent,
    canProcess:()=>!pipeline?.enabled,
    available: (agent) => !pipeline?.enabled && resolved.autoCapture && personalAllowed(agent).allowed && captureToolsAvailable(agent),
    historyPolicy: (agent) => historyPolicyFor(agent),
    accessAllowed: (agent) => personalAllowed(agent).allowed,
    sourceAccess: input => rawRecall.captureSource(input),
  });

  async function onPreStep(payload, next) {
    if(!gated)return onPreStepInner(payload,next);
    const state=sessions.get(payload?.agent?.session?.id);
    if(!state||state.turn!==payload.turn)return next();
    // rc5 calls pre-step before committing pending user/message events. Reading
    // uses the selected turn's grant; writing waits for the actual source event.
    if(!state.memoryReadAuthorization){
      const current=personalAllowed(payload.agent);
      if(!state.memoryStart?.allowed||!current.allowed||state.memoryStart.epoch!==current.epoch)return next();
      try{state.memoryReadAuthorization=access.grant(payload.agent);}catch{return next();}
    }
    if(!readAllowed(state,payload.agent))return next();
    return access.withGrant(state.memoryReadAuthorization,()=>onPreStepInner(payload,next));
  }
  async function onPreStepInner(payload, next) {
    const decision = await next();
    if (!decision || decision.kind !== 'enter') return decision;

    const sessionId = payload?.agent?.session?.id;
    const agent = payload?.agent;
    if (!sessionId || !agent) return decision;
    deleteGuard.protect(agent);
    worker.attach(agent);

    const base = decision;
    const accessState = personalAllowed(agent);
    const turnState = sessions.get(sessionId);
    const grant=gated?turnState?.memoryReadAuthorization:null;
    const scopedTools=authorizedTools(tools,access,grant,agent);
    if(gated&&!readAllowed(turnState,agent))return base;
    if(queryTools.length){
      // Only the model's explicit tool invocation reads the personal library.
      // Handoff stays in onRequest; capture still attaches independently.
      agents.set(sessionId,agent);if(turnState)turnState.agent=agent;
      if(payload.step!==1)return base;
      reportRecall(sessionId,payload.turn,{reason:'on-demand',totalChars:0,channels:{},expired:{messages:0,chars:0}});
      if(!softenerAvailable(agent))return base;
      const policy=makeControlPolicyMessage(),messages=[...base.messages,policy];
      if(turnState){turnState.pendingMemoryMessages=messages;turnState.pendingMemoryIds=new Set([policy.id]);}
      return {...base,messages};
    }
    const history = applyHistoryPolicy(turnState?.turn === payload.turn ? turnState : undefined, agent, accessState);
    const searchReady = accessState.allowed && recallToolsAvailable(agent);
    const wantFact = searchReady && resolved.autoRecall;
    const wantPersonal = searchReady && resolved.personalRecall;
    const wantPolicy = searchReady && softenerAvailable(agent);
    const wantTimeline = searchReady && resolved.autoRecall && resolved.maxTimelineEntries > 0
      && Boolean(visibleTool('mcp__basic_memory__read_note', agent));
    const wantRecent = !handoff && accessState.allowed && recentAvailable(agent);
    const wantRaw = accessState.allowed && rawRecall.enabled;
    if (wantFact || wantPersonal || wantPolicy || resolved.autoCapture || wantRecent || wantRaw) {
      agents.set(sessionId, agent);
      const state = sessions.get(sessionId);
      if (state && state.turn === payload.turn) {state.agent = agent;if(payload.step===1)state.recentAllowed=wantRecent;}
    }
    if (payload.step !== 1) return base;
    // Pre-step precedes step/start. Count only replacements actually committed later.
    const expired = { messages: 0, chars: 0 };
    if (!wantFact && !wantPersonal && !wantPolicy && !wantTimeline && !wantRecent && !wantRaw) {
      await recentReport(sessionId,payload.turn,{enabled:false,storage:'disabled',reason:accessState.allowed?(resolved.recentContext?'memory-unavailable':'disabled'):'pure-mode',capacityTokens:resolved.recentContextTokens,injectedChars:0,items:[]});
      await reportRecall(sessionId, payload.turn, { reason: accessState.allowed ? (searchReady ? 'disabled' : 'memory-unavailable') : 'pure-mode', totalChars: 0, channels: {}, expired });
      return base;
    }
    const pending = Array.isArray(payload.messages) ? payload.messages.filter(isDirectUserMessage) : [];
    if (pending.length === 0) return base;
    // After a pure-mode turn in this same session, only the current direct user
    // input may steer background recall; earlier host messages are private.
    const directMessages = recallConversation(agent.session, pending, { includeHistory: !history.userOnly });

    const key = `${sessionId}:${payload.turn}`;
    if (recalledTurns.has(key)) return base;
    recalledTurns.add(key);
    trimSet(recalledTurns, MAX_TRACKED_KEYS);

    if (payload.signal?.aborted) return base;
    try {
      const runtimeConfig = await worker.getConfig();
      const fact = { reason: 'disabled' }, personal = { reason: 'disabled' }, navigation = { reason: 'disabled' };
      const [factNotes, personalNotes, navigationNotes, recent, profile] = await Promise.all([
        wantFact
          ? collectFactRecall({
              sourcePolicy:{scope:rawRecall.scope(),sourceState:rawRecall.sourceState},
              diagnostics: fact,
              messages: directMessages,
              sessionId,
              agent: payload.agent,
              config: runtimeConfig,
              tools:scopedTools,
              logger,
            })
          : Promise.resolve([]),
        wantPersonal
          ? collectPersonalRecall({
              diagnostics: personal,
              messages: directMessages,
              sessionId,
              agent: payload.agent,
              config: runtimeConfig,
              tools:scopedTools,
              logger,
            })
          : Promise.resolve([]),
        wantFact && resolved.maxIndexNotes > 0
          ? collectNavigation({ diagnostics: navigation, messages: directMessages, sessionId, agent, config: runtimeConfig, tools:scopedTools, logger,
              sourcePolicy:{scope:rawRecall.scope(),sourceState:rawRecall.sourceState} })
          : Promise.resolve([]),
        wantTimeline
          ? timeline.read({ sessionId, config: runtimeConfig, signal: payload.signal })
          : Promise.resolve({ text: '', stats: { state: 'disabled', entries: 0, chars: 0 } }),
        resolved.vaultPath ? readFile(path.join(resolved.vaultPath,'dafeiyu/thoughts/自我档案.md'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;}) : Promise.resolve(''),
      ]);
      if(gated)access.assertCurrent(agent);
      if (payload.signal?.aborted) return base;
      const appended = [];
      const visibleMessages=[...(agent.session.deriveMessages?.()||[]),...pending];
      const recentPage=wantRecent?await recentContext.page({sessionId,turn:payload.turn,
        excludeMessageIds:visibleMessages.map(m=>m.id).filter(Boolean),maxChars:Math.floor(resolved.maxContextChars*0.6)})
        .catch(error=>({enabled:true,storage:'error',reason:'storage-error',error:error.message,text:'',items:[]})):null;
      const recentChars=recentPage?.text.length||0;
      const rawQuery=contentText(directMessages.at(-1)?.content || '').trim();
      let rawResult={text:'',reason:wantRaw?'empty-query':'disabled'};
      let rawTurns=[];
      if(wantRaw&&rawQuery){
        try{
          if(gated)access.assertCurrent(agent);
          const retrieved=await rawRecall.retrieve({query:rawQuery,asOf:(now?now():new Date()).getTime(),signal:gated?AbortSignal.any([payload.signal,grant.signal].filter(Boolean)):payload.signal});
          rawTurns=retrieved.turns||[];
          rawResult={text:'',reason:retrieved.reason||'no-candidate',scope:retrieved.scope,modelKey:rawRecall.modelKey,partial:Boolean(retrieved.partial),scannedWindows:retrieved.scannedWindows??0,retrieval:retrieved.retrieval};
        }catch(error){
          rawResult={text:'',reason:error?.code==='RAW_RECALL_CANCELLED'?'cancelled':'failed',error:error?.message||String(error),modelKey:rawRecall.modelKey};
        }
      }
      if (payload.signal?.aborted) return base;
      // Reserve part of the context only when there are candidates to render.
      // Disabled, cold or failed recall must leave the old fact budget intact.
      let rawBudget=rawTurns.length?Math.min(resolved.rawRecallMaxChars,Math.max(0,resolved.maxContextChars-recentChars-600)):0;
      const fullPackedBudget=Math.max(0,resolved.maxContextChars-recentChars);
      const composePacked=budget=>composeMemoryContext({facts:factNotes,personal:personalNotes,navigation:navigationNotes,timeline:recent.entries||[],
        messages:directMessages,sourcePolicy:{scope:rawRecall.scope(),sourceState:rawRecall.sourceState},
        profilePresent:profile.includes('<!-- dafeiyu-record kind=thoughts -->'),config:{...runtimeConfig,sessionId,maxContextChars:budget}});
      let packedBudgetUsed=Math.max(0,fullPackedBudget-rawBudget);
      let packed=composePacked(packedBudgetUsed);
      if(rawTurns.length&&rawBudget>0){
        // Facts cover only their verbatim, currently versioned source quote.
        // Rewritten summaries and manual/legacy notes have no such coverage.
        const coverage=[...visibleMessages,...(recentPage?.coverage||[]),...packed.coverage];
        rawResult={...rawResult,...rawRecall.select({turns:rawTurns,query:rawQuery,budget:rawBudget,existingMessages:coverage})};
      }
      // The owner or access mode may have changed while vectors were loading.
      // Never inject a quote that the current session is no longer allowed to see.
      const accessAfter=personalAllowed(agent);
      if(rawResult.text&&(!accessAfter.allowed||rawRecall.scope()!==rawResult.scope)){
        rawResult={...rawResult,text:'',reason:accessAfter.allowed?'scope-changed':'access-revoked'};
      }
      if(!rawResult.text){
        rawBudget=0;
        if(packedBudgetUsed!==fullPackedBudget){packedBudgetUsed=fullPackedBudget;packed=composePacked(fullPackedBudget);}
      }
      const rawChars=rawResult.text.length;
      if(packed.text)appended.push(makeRecallMessage(packed.text,CONTEXT_SOURCE));
      if(rawResult.text)appended.push(makeRecallMessage(rawResult.text,RAW_RECALL_SOURCE));
      if (wantPolicy) appended.push(makeControlPolicyMessage());
      if(recentPage?.text)appended.push(makeRecallMessage(recentPage.text,RECENT_SOURCE));
      const recentSelection={injectedChars:recentChars,items:recentPage?.items||[],olderAvailable:recentPage?.olderAvailable||false,beforeId:recentPage?.beforeId||null,reason:recentPage?.reason||(wantRecent?'empty':'disabled')};
      const state=sessions.get(sessionId);if(state)state.recentSelection=recentSelection;
      await recentReport(sessionId,payload.turn,recentPage||{enabled:false,storage:'disabled',capacityTokens:resolved.recentContextTokens},recentSelection);
      if (wantTimeline) {
        report(sessionId, payload.turn, { timeline: recent.stats });
      }
      const previous = (await memoryStatus.get(sessionId)).jobs.filter(j => j.turn < payload.turn).at(-1)?.recall;
      const channel = (details, text, budget) => ({ ...details, chars: text.length,
        count: details.items?.length ?? details.entries ?? 0, budget,
        fingerprint: text ? createHash('sha256').update(text).digest('hex') : null });
      const channels = {
        policy: channel({ reason: wantPolicy ? 'control-rules' : 'disabled' }, wantPolicy ? contentText(makeControlPolicyMessage().content) : '', null),
        recentContext:channel({...recentSelection,count:recentSelection.items.length},recentPage?.text||'',resolved.maxContextChars),
        rawRecall:channel({reason:rawResult.reason,modelKey:rawRecall.modelKey,partial:rawResult.partial||false,scannedWindows:rawResult.scannedWindows||0,turns:rawResult.turnIds?.length||0,
          messages:rawResult.messageIds?.length||0,skippedCovered:rawResult.skippedCovered||0,skippedBudget:rawResult.skippedBudget||0,
          trimmedTurns:rawResult.trimmedTurns||0,retrieval:rawResult.retrieval},
          rawResult.text||'',rawBudget),
      };
      const diagnostic={facts:fact,personal,navigation,timeline:{...recent.stats,reason:recent.stats.state==='ready'?'recent-window':recent.stats.state==='disabled'?'disabled':'timeline-unavailable'}};
      for(const name of ['facts','personal','navigation','timeline']){
        const selected=packed.channels[name];
        channels[name]={...diagnostic[name],...selected,count:selected.items.length,budget:resolved.maxContextChars,
          fingerprint:selected.items.length?createHash('sha256').update(JSON.stringify(selected.items)+packed.text).digest('hex'):null};
      }
      for (const [name, detail] of Object.entries(channels)) detail.repeatedChars = detail.fingerprint && detail.fingerprint === previous?.channels?.[name]?.fingerprint ? detail.chars : 0;
      await reportRecall(sessionId, payload.turn, { channels, totalChars:appended.reduce((n,m)=>n+contentText(m.content).length,0),contextChars:packed.text.length+recentChars+rawChars,
        contextBudget:resolved.maxContextChars,expired,overheadChars:packed.overheadChars,repeatedChars: Object.values(channels).reduce((n,c) => n+c.repeatedChars,0) });
      if (appended.length === 0) return base;
      // Reporting above can yield. Recheck before handing our additions to the
      // host; a late exclusion must not reuse a previously packed fact or quote.
      const discardAdditions = async reason => {
        await reportRecall(sessionId,payload.turn,{reason,totalChars:0,contextChars:0,contextBudget:resolved.maxContextChars,
          channels:{},expired,overheadChars:0,repeatedChars:0});
        return base;
      };
      if (!readAllowed(turnState,agent) || packed.sourceChecks.some(note => !memorySourceState(note,
        {scope:rawRecall.scope(),sourceState:rawRecall.sourceState}).eligible)) return discardAdditions('source-or-access-changed');
      if (rawResult.text) {
        const finalRaw=rawRecall.select({turns:rawTurns,query:rawQuery,budget:rawBudget,
          existingMessages:[...visibleMessages,...(recentPage?.coverage||[]),...packed.coverage]});
        if (finalRaw.text!==rawResult.text || rawRecall.scope()!==rawResult.scope) return discardAdditions('raw-source-changed');
      }
      // Native pre-step commits this array in order: contextual additions first,
      // actual human messages last, with their existing identities untouched.
      const original=base.messages||[];
      const messages=[...original.filter(m=>!isDirectUserMessage(m)),...appended,...original.filter(isDirectUserMessage)];
      if(handoff&&turnState){turnState.pendingMemoryMessages=messages;turnState.pendingMemoryIds=new Set(appended.map(message=>message.id));}
      return { ...base, messages };
    } catch (error) {
      logger?.warn?.(`[basic-memory-bridge] recall hook failed for ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return base;
    }
  }

  async function onRequest(payload, next) {
    const session = payload?.agent?.session;
    const state = sessions.get(session?.id);
    const revokePending=()=>{
      if(state?.pendingMemoryMessages){const list=state.pendingMemoryMessages;for(let index=list.length-1;index>=0;index--)if(state.pendingMemoryIds.has(list[index].id))list.splice(index,1);}
      expireMemoryContext(session,payload,{includeHandoff:true});
    };
    if (payload.step === 1 && state?.turn === payload.turn && !state.expired) {
      // Native agent/request runs after step/start publication, before new input
      // is admitted. session/event itself forbids reentrant append. Clean once
      // per turn, including pure mode, so retries retain this turn's additions.
      state.expired = expireMemoryContext(session, payload,{includeHandoff:Boolean(handoff&&!readAllowed(state,payload.agent))});
      await reportRecall(session.id, payload.turn, { ...state.recall, expired: state.expired });
    }
    const config=await next();
    if(handoff&&state?.turn===payload.turn&&!readAllowed(state,payload.agent))revokePending();
    if(!handoff||payload.step!==1||state?.turn!==payload.turn)return config;
    if(!config?.provider||!config?.model)return config;
    let connection;
    try{connection=resolveChatConnection?.(config);}catch(error){logger?.warn?.('[memory-handoff] connection metadata: '+error.message);}
    const target={sessionId:session.id,provider:config.provider,model:config.model,...connection};
    if(!readAllowed(state,payload.agent)||resolved.recentContext===false){handoff.observeTarget(target);return config;}
    const authorize=()=>readAllowed(state,payload.agent)&&!payload.signal?.aborted;
    try{
      const attempt=await handoff.begin({...target,turn:payload.turn},{authorize});state.handoffAttempt=attempt;
      const alreadyDelivered=attempt.ready&&(attempt.receipt?.messageId?
        state.handoffMessageId===attempt.receipt.messageId||session.deriveMessages?.().some(message=>message.id===attempt.receipt.messageId):state.handoffPreparedEmpty);
      if(!attempt.required||alreadyDelivered){state.handoffDelivered=Boolean(alreadyDelivered);return config;}
      const selected=selectHandoff(messageRecorder.forAgent(payload.agent,{trackRecent:true}),{tokens:handoffTokens,sessionId:session.id,turn:payload.turn});
      const messageId=selected.text?randomUUID():null;
      await handoff.prepared(attempt,{messageId,tokens:selected.tokens,items:selected.items.length,counting:selected.counting},{authorize});
      if(!authorize()){revokePending();return config;}
      if(selected.text){
        session.append('user/message',{id:messageId,role:'user',source:{kind:MEMORY_HANDOFF_SOURCE,form:'handoff',attemptId:attempt.id},content:[{type:'text',text:selected.text}]},{surfaceOp:'append'});
        state.handoffMessageId=messageId;
      }
      state.handoffPreparedEmpty=!selected.text;state.handoffDelivered=true;
      report(session.id,payload.turn,{handoff:{state:selected.text?'injected':'empty',reasons:attempt.reasons,generation:attempt.generation,
        tokens:selected.tokens,budgetTokens:selected.budgetTokens,counting:selected.counting,items:selected.items,connectionCoverage:target.coverage??'provider-model-only'}});
    }catch(error){
      logger?.warn?.('[memory-handoff] prepare: '+error.message);
      await report(session.id,payload.turn,{handoff:{state:'pending',error:error.message}});
    }
    if(!authorize())revokePending();
    return config;
  }

  function onSessionEvent(session, event) {
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return;
    if (!event || typeof event.type !== 'string') return;
    const data = event.data ?? {};
    const ending=event.type==='turn/end'?sessions.get(sessionId):null;
    const changeKind=ending&&ending.turn===data.turn&&!ending.assistantInterrupted&&readAllowed(ending,ending.agent)
      ?ending.memoryChangeKind:undefined;
    messageRecorder?.observe(session,event,changeKind);

    if (event.type === 'turn/start') {
      closeQueryAnswer(sessionId);
      if(pipeline?.enabled)pipelineRecovery();
      if(vectors&&access.check(findAgent?.(sessionId)??agents.get(sessionId)).allowed){
        void vaultWatch?.wake();void vectors.resume().catch(cause=>logger?.warn?.('[memory-vectors] '+(cause.code??'MEMORY_VECTOR_RESUME_FAILED')));
      }
      sessions.set(sessionId, {
        turn: data.turn,
        agent: agents.get(sessionId),
        userText: '',
        assistantText: '',
        assistantInterrupted: false,
        assistantEventTime: 0,
        startedAt: Number(event.time ?? 0) || (now ? now().getTime() : Date.now()),
        captureSuppressed: false,
        sourceMessageId: '',
        sourceEventSeq: 0,
        sourceEventTime: 0,
        priorUserMessages: [],
        priorUserSourceIds: [],
        recentAllowed:false,
        historyUserOnly:false,
        historyResolved:false,
        historyReason:'',
        ...(gated?{memoryStart:personalAllowed(agents.get(sessionId)||findAgent?.(sessionId)||{session}),memoryResolved:false,memoryAuthorization:null}:{}),
      });
      return;
    }

    const state = sessions.get(sessionId);
    if (!state) return;
    if(['tool/call','tool/ptc-dispatch','tool/ptc-dispatch-start'].includes(event.type)&&data.name==='soften_memory')state.rawControlTurn=true;

    if (event.type === 'user/message') {
      if (isDirectUserMessage(data)) {
        const text = contentText(data.content).trim();
        if (text.length > 0) {
          state.userText = text;
          state.sourceMessageId = String(data.id ?? data.message?.id ?? '');
          state.sourceEventSeq = Number(event.seq ?? 0) || 0;
          const eventTime = Number(event.time ?? 0);
          state.sourceEventTime = Number.isFinite(eventTime) && eventTime > 0 ? eventTime : 0;
          const agent=state.agent||findAgent?.(sessionId);
          // The first user event of a turn can arrive before its pre-step: decide
          // the short-term gate here too, instead of inheriting a stale default.
          if(agent){
            state.agent=agent;
            bindTurn(state,agent);
            const accessState=personalAllowed(agent);
            const history=applyHistoryPolicy(state,agent,accessState);
            if(!state.recentAllowed)state.recentAllowed=turnAllowed(state,agent)&&recentAvailable(agent);
            const earlier=earlierDirectUserMessages(session,state.sourceMessageId,{includeHistory:!history.userOnly,withIds:true});
            state.priorUserMessages=earlier.map(message=>message.text);
            state.priorUserSourceIds=earlier.map(message=>message.messageId);
          }else{
            const earlier=earlierDirectUserMessages(session,state.sourceMessageId,{withIds:true});
            state.priorUserMessages=earlier.map(message=>message.text);
            state.priorUserSourceIds=earlier.map(message=>message.messageId);
          }
          saveRecent(sessionId,state,{user:{id:state.sourceMessageId,text,seq:state.sourceEventSeq,
            time:new Date(state.sourceEventTime||(now?now():new Date()).getTime()).toISOString(),timeKind:state.sourceEventTime?'message':'recorded'}});
        }
      }
      return;
    }

    if (event.type === 'assistant/message') {
      if (data.turn === state.turn) {
        state.assistantText = contentText(data.message?.content).trim();
        state.assistantInterrupted = data.interrupted === true;
        state.assistantMessageId=String(data.message?.id||`${sessionId}:event:${event.seq}`);
        state.assistantEventSeq=Number(event.seq??0);
        state.assistantEventTime=Number(event.time??0)||0;
      }
      return;
    }

    if (event.type !== 'turn/end') return;
    closeQueryAnswer(sessionId);
    if (data.turn !== state.turn) return;

    const agent = state.agent;
    closeQueryAnswer(sessionId);
    sessions.delete(sessionId);
    agents.delete(sessionId);

    const completed = data.reason?.kind === 'completed';
    if(handoff&&access.observe(session,event))finishHandoff(sessionId,state,completed&&!state.assistantInterrupted);
    const completedAt=Number(event.time??0)||state.assistantEventTime||state.startedAt||(now?now().getTime():Date.now());
    const accessState = agent ? {...personalAllowed(agent),allowed:turnAllowed(state,agent)} : { allowed:false, installed:false, reason:'no-agent' };
    applyHistoryPolicy(state, agent, accessState);
    const historyUserOnly = state.historyUserOnly === true;
    saveRecent(sessionId,state,{status:completed&&!state.assistantInterrupted?'completed':'interrupted',
      assistant:historyUserOnly?null:(state.assistantText?{id:state.assistantMessageId,text:state.assistantText,seq:state.assistantEventSeq}:null)});
    // Original-turn recall is independent of fact capture. It only keeps the
    // completed, uninterrupted, non-pure turn the host actually showed. When the
    // session's history policy is user-only, the assistant body is not archived.
    if (!messageRecorder && rawRecall.enabled && completed && !state.assistantInterrupted && !state.captureSuppressed && !state.rawControlTurn && agent && accessState.allowed) {
      const rawUser = {id: state.sourceMessageId, role: 'user', text: state.userText,
        ts: state.sourceEventTime || completedAt, seq: state.sourceEventSeq};
      const rawAssistant = {id: state.assistantMessageId, role: 'assistant', text: state.assistantText,
        ts: state.assistantEventTime || completedAt, seq: state.assistantEventSeq};
      const canArchive = historyUserOnly
        ? Boolean(state.userText.length > 0 && state.sourceMessageId)
        : Boolean(state.userText.length > 0 && state.assistantText.length > 0);
      if (canArchive) {
        rawRecall.archiveTurn({
          ...(gated?{signal:state.memoryAuthorization?.signal,authorize:()=>turnAllowed(state,agent)}:{}),
          sessionId,
          turn: state.turn,
          completedAt,
          messages: historyUserOnly ? [rawUser] : [rawUser, rawAssistant],
        }).then(result => {
          if (result?.skipped) {
            if (historyUserOnly) report(sessionId, state.turn, { rawRecall: { state: 'skipped', reason: result.skipped, userOnly: true,
              ...(result.error ? { error: result.error } : {}) } });
            return;
          }
          report(sessionId, state.turn, { rawRecall: { state: 'archived', turnId: result.turnId, embedded: result.embedded ?? null,
            ...(historyUserOnly ? { scope: 'user-only' } : {}) } });
        }).catch(error => {
          logger?.warn?.('[basic-memory-bridge] raw recall archive failed: ' + (error instanceof Error ? error.message : String(error)));
        });
      } else if (historyUserOnly) {
        report(sessionId, state.turn, { rawRecall: { state: 'skipped', reason: 'user-only-unavailable', userOnly: true } });
      }
    }
    if(pipeline?.enabled){
      void pipeline.wake().catch(cause=>logger?.warn?.('[memory-pipeline] '+(cause.code??'MEMORY_PIPELINE_FAILED')));
      return;
    }
    if (!resolved.autoCapture || !completed || state.assistantInterrupted || state.userText.length === 0
        || (!historyUserOnly && state.assistantText.length === 0)) {
      report(sessionId, state.turn, { state: 'skipped', reason: completed ? 'disabled-or-empty' : 'turn-interrupted' });
      return;
    }
    if (state.captureSuppressed) {
      report(sessionId, state.turn, { state: 'skipped', reason: 'memory-control' });
      return;
    }
    if (!agent) {
      report(sessionId, state.turn, { state: 'skipped', reason: 'no-agent' });
      logger?.warn?.(`[basic-memory-bridge] capture skipped for ${sessionId}: no agent was observed before the turn ended`);
      return;
    }
    if (!captureToolsAvailable(agent)) {
      report(sessionId, state.turn, { state: 'skipped', reason: 'memory-disabled' });
      logger?.warn?.(`[basic-memory-bridge] capture skipped for ${sessionId}: basic_memory read_note/write_note are not visible`);
      return;
    }

    // A turn that ran under pure mode (or an unresolvable mode) must not enter
    // the queue at all, and its status must say so instead of "waiting".
    if (!accessState.allowed) {
      report(sessionId, state.turn, { state: 'skipped', reason: 'pure-mode' });
      return;
    }
    const key = `${sessionId}:${state.turn}`;
    if (enqueuedTurns.has(key)) return;
    enqueuedTurns.add(key);
    trimSet(enqueuedTurns, MAX_TRACKED_KEYS);
    worker.accept({ ...state, sessionId,
      assistantText: historyUserOnly ? '' : state.assistantText,
      priorUserMessages: historyUserOnly ? [] : state.priorUserMessages,
      priorUserSourceIds: historyUserOnly ? [] : state.priorUserSourceIds,
      historyUserOnly }, agent).catch((error) => {
      logger?.warn?.('[basic-memory-bridge] capture queued in RAM; persistence retry pending: ' + error.message);
      report(sessionId, state.turn, { state: 'failed', reason: 'queue-write-failed', count: null });
    });
  }

  async function waitForIdle() { await messageRecorder?.idle();await Promise.allSettled([...handoffWrites]);await handoff?.idle();await Promise.allSettled([...recentWrites]);await recentContext.idle();await worker.idle();await pipeline?.idle();await rawRecall.flush();await statusReady;await Promise.allSettled([...statusWrites]); }

  return {
    config: resolved,
    onPreStep,
    onRequest,
    onSessionEvent,
    waitForIdle,
    retryPending: worker.wake,
    getRecoveryState: worker.store.read,
    getMemoryConfig: worker.getConfig,
    getRawRecallStatus: () => rawRecall.status(),
    getMemoryRuntime,
    runMemoryRuntime,
    manageMemoryReview,
    manageMemoryDocuments,
    vectors,
    messageSources:messageRecorder,
    entries,
    pipeline,
    wakePipeline:()=>pipeline?.wake(),
    queryTools,
    memoryChangeTool,
    getQueryState:sessionId=>queryAnswers.get(sessionId)?.session.budget()??sessions.get(sessionId)?.lastQueryBudget??null,
    handoff,
    setHandoffTokens:value=>{handoffTokens=normalizeHandoffTokens(value);},
    getHandoffState:async()=>({activeTokens:handoffTokens,counting:'estimated',state:handoff?await handoff.status():null}),
    memorySourcePolicy: () => ({scope:rawRecall.scope(),sourceState:rawRecall.sourceState}),
    softenRawSources:input=>rawRecall.softenSources(input),
    softenRawMessage:id=>rawRecall.softenMessage(id),
    async resolveStructuredEntry(id,{agent,signal}){
      if(!entries)return null;
      const grant=access.grant(agent);
      try{return await entries.forGrant(agent,grant,{signal}).read(id);}finally{grant.cancel?.();}
    },
    dispose: async()=>{for(const id of queryAnswers.keys())closeQueryAnswer(id);pipelineRegistration?.();vectorRegistration?.();await vaultWatch?.close();await vaultStartup;await pipeline?.close();await messageRecorder?.close();await vectors?.close();await runtimeTask;await Promise.allSettled([vectorSetup]);await Promise.allSettled([...handoffWrites]);await handoff?.idle();await Promise.allSettled([...recentWrites]);await recentContext.idle();await worker.dispose();await rawRecall.dispose();await statusReady;await Promise.allSettled([...statusWrites]);},
    recentContext,
    recentTool:createRecentConversationTool({store:recentContext,available:recentAvailable,config:resolved,
      onRead:async(agent,page)=>{const state=sessions.get(agent?.session?.id);if(state)await report(agent.session.id,state.turn,{recentRead:{items:page.items,beforeId:page.beforeId,chars:page.text?.length||0}});}}),
    markSoftened,
    getMemoryStatus: memoryStatus.get,
    refreshPermanentDeleteProtection: deleteGuard.refresh,
  };
}

/** Register the bridge on a Cordis context. */
export function apply(ctx, rawConfig) {
  // Use the same existing default Vault as records/review when production omits it.
  // Core-only tests can still use createBridge without a filesystem store.
  const config = resolveConfig({ ...rawConfig, vaultPath: rawConfig?.vaultPath || DEFAULT_VAULT_PATH });
  const access = createPersonalAccess({
    getService: () => typeof ctx.get === 'function' ? ctx.get('pureMode', false) : undefined,
    logger: ctx.logger,
  });
  const bridge = createBridge({
    config,
    tools: ctx.tools,
    llm: ctx.llm,
    logger: ctx.logger,
    findAgent: (id) => ctx.agents?.get?.(id),
    access,
  });

  const recordsTool = createRecordsTool({
    tools: ctx.tools,
    config,
    getConfig: bridge.getMemoryConfig,
    logger: ctx.logger,
    now: () => new Date(),
  });
  const softenTool = createSoftenTool({
    tools: ctx.tools,
    config,
    getConfig: bridge.getMemoryConfig,
    logger: ctx.logger,
    now: () => new Date(),
    onSoftened: (sessionId) => bridge.markSoftened(sessionId),
    onSourcesSoftened:input=>bridge.softenRawSources(input),
    softenRawMessage:id=>bridge.softenRawMessage(id),
  });
  for (const tool of [recordsTool, softenTool, bridge.recentTool]) {
    const disposeTool = ctx.tools.register({
      ...tool,
      parameters: compileSpec(tool.parameters),
    });
    if (typeof disposeTool === 'function') {
      ctx.on('dispose', () => {
        try {
          disposeTool();
        } catch {
          // ignore double-dispose
        }
      });
    }
  }
  ctx.on('agent/pre-step', bridge.onPreStep, { prepend: true });
  ctx.on('agent/request', bridge.onRequest, { prepend: true });
  ctx.on('session/event', bridge.onSessionEvent);
  ctx.on('tools/change', bridge.refreshPermanentDeleteProtection);
  ctx.on('basic-memory/retry-session', request => {
    if (!/^session-[a-zA-Z0-9-]{1,100}$/.test(request.sessionId || '')) return;
    request.accepted = true;
    bridge.retryPending({ resumeSessionId: request.sessionId }).catch(error => ctx.logger?.warn?.('[basic-memory-bridge] manual retry pending: ' + error.message));
  });
  ctx.on('dispose', bridge.dispose);
  return bridge;
}

export { Config };

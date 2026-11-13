import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Config, resolveConfig } from './config.js';
import {createMessageRecorder} from './message-recorder.js';
import {createMemoryEntryAccess} from './memory-entry-access.js';
import {ANSWER_RULES,createMemoryQueryAnswer,createMemoryQueryTools,createMemoryReferenceLoader,selectPrefetch,shouldPrefetch} from './memory-query.js';
import {minSimilarityFor} from './raw-rag/models.js';
import {currentLocalTime,localTime} from './local-time.js';
import {createMemoryPipeline} from './memory-pipeline.js';
import {createMemoryOrganizer} from './memory-organizer.js';
import {createMemoryVectors} from './memory-vectors.js';
import {createMemoryReranker} from './memory-rerank.js';
import {createMemoryVaultWatch} from './memory-vault-watch.js';
import {resolveProcessingTarget} from './processing-model.js';
import {createHandoffController,selectHandoff} from './handoff.js';
import {MEMORY_CHANGE_KINDS,MEMORY_HANDOFF_SOURCE,normalizeHandoffTokens} from './memory-contract.js';
import { createMemoryWorker, hasSessionMemory, memoryJobSource } from './worker.js';
import { contentText, isDirectUserMessage } from './text.js';
import { expireHandoffMessages, expireMemoryContext } from './context.js';
import { createMemoryStatus } from './status.js';
import {measuredLlm} from './usage.js';
import { managementDirectory } from './review.js';
import { createRawRecall } from './raw-rag/index.js';
import { setPersonalTimeZone } from './personal-namespace.js';
import {createLegacyImport} from './legacy-import.js';

function rawMessageExcerpt(value,query,max=200){
  const text=String(value??'').replace(/\s+/g,' ').trim();
  if(text.length<=max)return text;
  const lower=text.toLowerCase(),candidates=[String(query??'').trim(),...(String(query??'').match(/[\p{Script=Han}]+|[a-z0-9]+(?:[._:/-][a-z0-9]+)*/giu)??[])]
    .map(item=>item.toLowerCase()).filter(Boolean).sort((a,b)=>b.length-a.length);
  let offset=-1;
  for(const item of candidates){offset=lower.indexOf(item);if(offset>=0)break;}
  if(offset<0)return text.slice(0,max)+'…';
  let start=Math.max(0,offset-Math.floor(max/3)),end=Math.min(text.length,start+max);
  start=Math.max(0,end-max);
  return `${start?'…':''}${text.slice(start,end)}${end<text.length?'…':''}`;
}

/**
 * Build the bridge's hook handlers with injected services, so the same logic is
 * usable from the portable host and from unit tests.
 */
export function createBridge({ config, tools, llm, logger, now, findAgent, listAgents, semanticOrganizer, pipelineResources, pipelineCommitted, recoveryStore, access, ownerSubject, rawRecallStore, rawRecallEmbedder, resolveChatConnection } = {}) {
  const resolved = resolveConfig(config);
  if(!hasSessionMemory(access)||typeof access.admitMessage!=='function')throw Error('对话记忆授权未接入');
  const lifecycle=new AbortController();
  setPersonalTimeZone(resolved.timeZone);
  const sessions = new Map();
  const agents = new Map();
  const memoryStatus = createMemoryStatus(resolved, logger);
  const statusReady = memoryStatus.get('__bridge_initialization__').catch(()=>{});
  const statusWrites = new Set();
  const rawRecall = createRawRecall({ config: resolved, logger, now, ownerSubject:ownerSubject??access?.ownerSubject, store: rawRecallStore, embedder: rawRecallEmbedder });
  const reranker = createMemoryReranker({config:resolved,logger,now});
  const report = (id, turn, patch) => {
    const task=memoryStatus.set(id, turn, patch).catch(() => {});
    statusWrites.add(task);task.finally(()=>statusWrites.delete(task));return task;
  };
  let pipeline,vectors;
  const messageRecorder=createMessageRecorder({access,raw:rawRecall,
    refreshRecentStats:memoryStatus.refreshRecentStats,report,logger,
    processingContextFor:source=>pipeline?.enabled?{owner:'pipeline-v1',target:resolveProcessingTarget(resolved,findAgent?.(source.sessionId))}:undefined});
  const priorityConfig=async()=>({...resolved,naturalDecayStartedAt:(await worker.store.read()).naturalDecayStartedAt});
  const entries=createMemoryEntryAccess({access,raw:rawRecall,tools,config:resolved,getPriorityConfig:()=>worker.getConfig()});
  const listLiveAgents=()=>listAgents?.()??[...agents.values()];
  const backgroundAvailable=()=>!listLiveAgents().some(agent=>agent.status==='running');
  const managementAgent=()=>listLiveAgents()[0]??{id:'memory-management',session:{id:'memory-management'}};
  if(resolved.rawRecall&&resolved.vaultPath){
    vectors=createMemoryVectors({directory:path.join(managementDirectory(resolved),'vectors'),access,raw:rawRecall,entries,tools,config:resolved,
      findAgent,listAgents:listLiveAgents,ownerSubject:rawRecall.scope(),canRun:backgroundAvailable,
      managementAgent,getPriorityConfig:priorityConfig});
    rawRecall.useExternalVectors();
  }
  const migrationLlm=llm?measuredLlm(llm,record=>memoryStatus.usage(managementAgent().session.id,0,record),{phase:'legacy-import'}):llm;
  const legacyImporter=resolved.vaultPath?createLegacyImport({config:resolved,llm:migrationLlm,signal:lifecycle.signal,logger,
    agent:managementAgent,canRun:backgroundAvailable,
    getEntries:()=>entries.forMigration({agent:managementAgent(),check:()=>{
      if(lifecycle.signal.aborted)throw Object.assign(Error('记忆框架已关闭'),{code:'MEMORY_NOT_AUTHORIZED'});
    }}),
    notifyChanged:notice=>vectors?.notifyChanged({ownerSubject:rawRecall.scope(),project:resolved.project,...notice})}):null;
  void legacyImporter?.resumeOnStart().catch(cause=>logger?.warn?.('[legacy-import] '+(cause.code??cause.message??'LEGACY_IMPORT_RESUME_FAILED')));
  const organizer=semanticOrganizer??(typeof llm?.stream==='function'?createMemoryOrganizer({entries,llm,config:resolved,
    loadReferences:createMemoryReferenceLoader({access,tools,vectors,config:resolved,now})}):undefined);
  pipeline=resolved.vaultPath?createMemoryPipeline({file:path.join(managementDirectory(resolved),'pipeline','state.json'),raw:rawRecall,access,findAgent,
    listAgents:listLiveAgents,organizer:resolved.autoCapture?organizer:undefined,canRun:pipelineResources,
    onCommitted:async(result,context)=>{await pipelineCommitted?.(result,context);await vectors?.notifyChanged({...context.scope,id:result.batchId,revision:result.batchId,kind:'semantic'});}}):null;
  const pipelineRegistration=pipeline&&messageRecorder.subscribe(notice=>pipeline.notify(notice));
  const vectorRegistration=vectors&&messageRecorder.subscribe(notice=>vectors.notifyChanged(notice));
  const pipelineRecovery=()=>pipeline?.resume().catch(cause=>logger?.warn?.('[memory-pipeline] '+(cause.code??'MEMORY_PIPELINE_FAILED')));
  if(pipeline?.enabled)pipelineRecovery();
  const vectorSetup=vectors?(async()=>{const grant=vectors.managementGrant();try{await vectors.registerCurrentConfig({grant});}finally{grant.cancel();}})():Promise.resolve();
  vectorSetup.catch(cause=>logger?.warn?.('[memory-vectors] '+(cause.code??'MEMORY_VECTOR_SETUP_FAILED')));
  const switchStartup=vectors?vectorSetup.then(()=>resumeSwitch()).catch(cause=>logger?.warn?.('[memory-vectors] switch: '+(cause.code??cause.message??'MEMORY_SWITCH_FAILED'))):Promise.resolve();
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
  // The last searches since start, in memory only: timings and counts, never the query or results.
  const recentSearches=[],recordSearch=summary=>{recentSearches.push(summary);if(recentSearches.length>20)recentSearches.shift();};
  async function getMemoryRuntime(){
    await vectorSetup;let vectorState=null;
    if(vectors){const grant=vectors.managementGrant();try{
      vectorState=await vectors.status({grant});
      vectorState.archives=await vectors.listArchives({grant});
    }finally{grant.cancel();}}
    return {pipeline:pipeline?.status()??null,vectors:vectorState,rerank:reranker.status(),searches:recentSearches.map(row=>({...row})),
      vault:vaultWatch?.status()??null,operation:{...runtimeOperation}};
  }
  // Model switching. plan is read-only and does not take the runtime slot.
  async function switchRuntime(action,input){
    if(!vectors)throw Error('向量服务尚未接入');
    const grant=vectors.managementGrant();
    try{
      const state=await vectors.status({grant}),id=input.profileId??state.selectedProfileId,profile=state.profiles.find(row=>row.id===id);
      if(action==='cancel-switch'){
        const intent=state.switchIntent;await vectors.clearSwitchIntent({grant});
        const cancelled=intent?await vectors.cancel({grant,profileId:intent.profileId}).catch(()=>null):null;
        return {cleared:Boolean(intent),cancelled:Boolean(cancelled?.cancelled)};
      }
      if(!profile)throw Error('当前型号尚未登记，请先保存并应用模型设置');
      if(input.profileRevision!==undefined&&String(input.profileRevision)!==String(profile.revision))throw Error('运行配置已变化，请刷新后再操作');
      if(action==='plan')return {plan:await vectors.plan({grant,profileId:id})};
      if(action==='drop-index'){
        if(state.active?.id===id)throw Error('正在使用的模型不能清理索引');
        if(state.switchIntent?.profileId===id)throw Error('该模型有待完成的切换，请先取消切换');
        if(['preparing'].includes(profile.progress?.state)||runtimeOperation.state==='running'&&runtimeOperation.profileId===id)throw Error('该模型正在准备索引，不能清理');
        const result=await vectors.dropIndex({grant,profileId:id});return {dropped:true,index:result.index};
      }
      // switch
      const cloud=profile.backend?.engine==='api';
      if(cloud&&input.cloudConfirmed!==true)throw Error('切换到云端模型需要明确确认本次发送范围');
      if(cloud&&profile.backend.config.rawRecallAllowCloud!==true)throw Error('云端检索总开关未开启');
      if(runtimeOperation.state==='running')throw Error('当前记忆操作尚未结束');
      if(state.selectedProfileId!==id)await vectors.select({grant,profileId:id});
      await vectors.setSwitchIntent({grant,profileId:id,cloudConfirmed:input.cloudConfirmed===true});
    }finally{grant.cancel();}
    return runMemoryRuntime({action:'prepare',profileId:input.profileId});
  }
  // Startup: only a confirmed, still valid switch intent prepares on its own.
  // No intent -> returns at once without any I/O. Failures are not retried.
  async function resumeSwitch(){
    if(!vectors?.switchIntent())return null;
    const grant=vectors.managementGrant();let target;
    try{target=await vectors.switchTarget({grant});}finally{grant.cancel();}
    return target?runMemoryRuntime({action:'prepare',...target}):null;
  }
  async function runMemoryRuntime(input={}){
    const action=input.action;
    if(!['load','release','prepare','resume-prepare','cancel','resume','flush','retry','plan','switch','cancel-switch','drop-index','probe','resume-rerank'].includes(action))throw Error('未知记忆运行操作');
    await vectorSetup;
    if(action==='resume-rerank')return {rerank:reranker.resume()};
    if(action==='probe'){
      // One real encoding on the current model; it loads the model first when needed.
      if(!vectors)throw Error('向量服务尚未接入');const grant=vectors.managementGrant();
      try{return {probe:await vectors.probe({grant,profileId:input.profileId,signal:AbortSignal.timeout(60000)})};}finally{grant.cancel();}
    }
    if(['plan','switch','cancel-switch','drop-index'].includes(action))return switchRuntime(action,input);
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
      if(action==='resume'){await pipeline?.resume();await vectors?.resume();return pipeline?.wake();}
      return pipeline?.wake({force:true});
    })().then(result=>{runtimeOperation={...runtimeOperation,state:'completed',finishedAt:Date.now()};return result;},cause=>{
      runtimeOperation={...runtimeOperation,state:'failed',finishedAt:Date.now(),error:cause.code??'MEMORY_RUNTIME_FAILED'};
      logger?.warn?.('[memory-runtime] '+(cause.code??'MEMORY_RUNTIME_FAILED'));
    });
    return {started:true,id,action};
  }
  async function manageMemoryReview(input,check){
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
  async function manageRawMessages(input,check){
    const agent=managementAgent(),scope={ownerSubject:rawRecall.scope(),project:resolved.project};
    const authorize=()=>{
      if(!agent)return false;
      try{check();return true;}catch{return false;}
    };
    const reader=rawRecall.messageReader(scope,{authorize});
    if(input?.action==='search'){
      const query=typeof input.query==='string'?input.query.trim():'',length=Array.from(query).length,limit=input.limit??20;
      if(length<1||length>100)throw Error('搜索关键词须为 1–100 个字');
      if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('原话搜索数量须为 1–50 条');
      const page=reader.search({query,limit});
      return {messages:page.sources.filter(source=>source?.id&&source.sessionId&&['user','assistant'].includes(source.role)).map(source=>({
        id:source.id,revision:source.revision,sessionId:source.sessionId,role:source.role,
        time:localTime(source.time??source.recordedAt),excerpt:rawMessageExcerpt(source.text,query),
      })),partial:page.partial===true};
    }
    if(input?.action==='withdraw'){
      if(typeof input.id!=='string'||!input.id||input.id.length>512||!Number.isSafeInteger(input.revision)||input.revision<1)
        throw Error('原话或版本无效');
      const current=reader.get({id:input.id});
      if(!current||!current.isCurrent||current.revision!==input.revision)
        throw Object.assign(Error('这条原话已经变化，请重新搜索'),{code:'MEMORY_REVISION_CONFLICT'});
      const result=rawRecall.withdrawMessage({...scope,id:input.id},{authorize});
      if(!result.withdrawn)throw Object.assign(Error('这条原话已经变化，请重新搜索'),{code:'MEMORY_REVISION_CONFLICT'});
      if(result.notice)await vectors?.notifyChanged(result.notice);
      return {withdrawn:true,removed:result.removed,entries:null};
    }
    throw Error('未知原话操作');
  }
  async function manageLegacyImport(input,check){
    if(!legacyImporter)throw Error('当前记忆框架尚未启用旧记忆迁移');
    check();const value=await legacyImporter.handle(input);check();return value;
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
    if(!state||!personalAllowed(agent).allowed)throw Error('本回答的记忆入口不可用');
    let current=queryAnswers.get(id);
    if(current&&(current.turn!==state.turn||current.agent!==agent)){closeQueryAnswer(id);current=null;}
    if(!current){current={agent,turn:state.turn,session:createMemoryQueryAnswer({access,agent,answerTurn:state.turn,raw:rawRecall,entries,tools,
      config:resolved,vectors,reranker,logger,getPriorityConfig:priorityConfig,onSearch:recordSearch})};queryAnswers.set(id,current);}
    return current.session;
  }
  const queryTools=createMemoryQueryTools({answer:queryAnswer});
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

  /** Ask the host-owned conversation grant before any personal read or write. */
  function personalAllowed(agent) {
    try { return access.check(agent); }
    catch (error) { logger?.warn?.('[basic-memory-bridge] authorization check failed: ' + (error instanceof Error ? error.message : String(error))); return { allowed: false, reason: 'gate-failed' }; }
  }
  function turnAllowed(state, agent) {
    try{return Boolean(state?.memoryAuthorization && access.validate(state.memoryAuthorization,memoryJobSource({...state,sessionId:agent?.session?.id})));}catch{return false;}
  }
  function readAllowed(state,agent){
    try{return Boolean(state?.memoryReadAuthorization&&access.validate(state.memoryReadAuthorization));}catch{return false;}
  }
  function bindTurn(state,agent) {
    if(state.memoryResolved)return;
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

  function softenerAvailable(agent) {
    return Boolean(visibleTool('soften_memory', agent));
  }


  // Benchmark failures were mostly answers that stated unconfirmed things as fact or shifted dates,
  // not missing memories. Kept short: it rides along on every memory-enabled turn.
  function makeAnswerGuidanceMessage() {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: [
        '<memory_answer_rules>',
        '当前本地时间：'+currentLocalTime(),
        '本轮整个回答（包括闲聊、建议和续写）都要遵守：',
        ...ANSWER_RULES.map(rule=>'- '+rule+'。'),
        '这些规则不是用户记忆，不得保存为事实。',
        '</memory_answer_rules>',
      ].join('\n') }],
      source: { kind: 'memory-answer-rules', form: 'policy' },
    };
  }

  function makeControlPolicyMessage() {
    return {
      id: randomUUID(),
      role: 'user',
      content: [{
        type: 'text',
        text: [
          '<memory_control_policy source="dafeiyu">',
          '只有在用户明确要求不再提起、淡化或忘掉某一条已存记忆时，才使用 soften_memory。',
          '先用搜索、读取或上下文中已有的 id/permalink 定位唯一目标；命中多条时先问是哪一条。',
          '目标不唯一时不要调用；工具成功后才能确认已经淡化。',
          '“别忘了”“我忘了”本身不算淡化请求。',
          'dafeiyu_records 主观笔记仍按它自己的工具说明使用；soften_memory 必须在当前前台真正执行并成功后才能确认。',
          '用户更正时自然回应，由后台整理落盘；不要说已经写入磁盘。',
          '这条策略不是用户记忆，不得保存为事实。',
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
    state.memoryControlSuppressed = true;
    await pipeline?.suppressTurn({sessionId,turn:state.turn,ownerSubject:rawRecall.scope(),project:resolved.project});
    if(result?.softenedAt&&result.permalink)await vectors?.notifyChanged({ownerSubject:rawRecall.scope(),project:resolved.project,
      id:result.memoryId||result.permalink,revision:result.softenedAt,kind:'semantic'});
  }

  const worker = createMemoryWorker({
    recoveryStore,
    config: resolved, now,
  });

  async function onPreStep(payload, next) {
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
  // Half of the benchmark misses were answers given without searching, so known preferences and
  // boundaries went unused. Before the first step, run one bounded search on the user's own words
  // through the same query service and read grant as memory_search, and attach the top results.
  // The search deadline sits inside the hard timeout, so vector and rerank steps that run late
  // fall back to what is already found instead of the abort discarding the whole prefetch.
  const PREFETCH_SOURCE='memory-prefetch',PREFETCH_LIMIT=4,PREFETCH_TIMEOUT_MS=1500,PREFETCH_SEARCH_MS=1300;
  function prefetchCandidates(records){
    const candidates={original:0,entry:0,legacy:0,vector:0};
    for(const record of records){
      if(record.signals?.lanes?.includes('vector'))candidates.vector++;
      else if(record.kind==='original')candidates.original++;
      else if(String(record.id??'').startsWith('legacy-note:'))candidates.legacy++;
      else candidates.entry++;
    }
    return candidates;
  }
  async function prefetchMessage(agent,messages){
    const begun=Date.now(),emptyCandidates={original:0,entry:0,legacy:0,vector:0};
    const emptyStats={candidates:0,admitted:0,rejected:0,folded:0,injected:0,chars:0,lexical:0,vector:0,agree:0,correction:0};
    const report=(outcome,{reason,candidates=emptyCandidates,stats=emptyStats}={})=>{
      try{recordSearch({kind:'prefetch',at:new Date(begun).toISOString(),outcome,...(reason!==undefined?{reason}:{}),candidates,
        admitted:stats.admitted,rejected:stats.rejected,folded:stats.folded,lexical:stats.lexical,vector:stats.vector,agree:stats.agree,correction:stats.correction,
        injected:stats.injected,injectedChars:stats.chars,totalMs:Math.max(0,Date.now()-begun)});}catch{}
    };
    if(!resolved.autoRecall||!(resolved.prefetchMaxChars>0)){report('skipped',{reason:'disabled'});return null;}
    const query=contentText(messages.filter(isDirectUserMessage).at(-1)?.content).trim();
    const decision=shouldPrefetch(query);
    if(!decision.ok){report('skipped',{reason:decision.reason});return null;}
    const signal=AbortSignal.timeout(PREFETCH_TIMEOUT_MS);
    let session;
    try{
      session=createMemoryQueryAnswer({access,agent,answerTurn:sessions.get(agent.session.id)?.turn,raw:rawRecall,entries,tools,
        config:resolved,vectors,reranker,logger,getPriorityConfig:priorityConfig,searchWaitMs:PREFETCH_SEARCH_MS,searchKind:'prefetch',onSearch:recordSearch,
        keepSignals:true,
        visibleMessageIds:new Set(messages.map(message=>message?.id).filter(id=>typeof id==='string'&&id))});
      const result=await session.search({query:query.slice(0,500),limit:PREFETCH_LIMIT},{signal});
      const candidates=prefetchCandidates(result?.records??[]);
      const {lines,stats}=selectPrefetch({records:result?.records??[],minSimilarity:minSimilarityFor(resolved),
        options:{...resolved,rerankApplied:result?.channels?.rerank?.state==='applied'}});
      if(!lines.length){
        const status=result?.status,outcome=status==='timeout'?'timeout':['denied','cancelled','error'].includes(status)?'failed':
          stats.candidates?'gated':'empty';
        const reason=outcome==='timeout'?'timeout':status==='denied'?'denied':status==='cancelled'?'cancelled':status==='error'?'failed':
          stats.candidates?'no-admitted':'no-candidates';
        report(outcome,{reason,candidates,stats});
        return null;
      }
      const message={id:randomUUID(),role:'user',source:{kind:PREFETCH_SOURCE,form:'reference'},content:[{type:'text',text:[
        '<memory_prefetch>','以下是程序按本轮用户原话从记忆库预先找到的背景材料，不是用户本轮说的话。',
        '只有本轮问题确实用得上时才参考；与本轮无关就忽略，不要主动提起，也不要回答其中“当时的提问”。',
        '需要核对时用 memory_search。',...lines,'</memory_prefetch>'].join('\n')}]};
      report('injected',{candidates,stats});
      return message;
    }catch(error){
      const timeout=signal.aborted&&signal.reason?.name==='TimeoutError';
      report(timeout?'timeout':'failed',{reason:timeout?'timeout':error?.code==='MEMORY_NOT_AUTHORIZED'?'denied':'failed',stats:emptyStats});
      logger?.debug?.('[memory-prefetch] skipped: '+(error.code??error.name??error.message));
      return null;
    }finally{try{session?.dispose();}catch{}}
  }
  async function onPreStepInner(payload, next) {
    const decision = await next();
    if (!decision || decision.kind !== 'enter') return decision;

    const sessionId = payload?.agent?.session?.id;
    const agent = payload?.agent;
    if (!sessionId || !agent) return decision;

    const base = decision;
    const turnState = sessions.get(sessionId);
    if(!readAllowed(turnState,agent))return base;
    if(queryTools.length){
      // Only the model's explicit tool invocation reads the personal library.
      // Handoff stays in onRequest; capture still attaches independently.
      agents.set(sessionId,agent);if(turnState)turnState.agent=agent;
      if(payload.step!==1)return base;
      reportRecall(sessionId,payload.turn,{reason:'on-demand',totalChars:0,channels:{},expired:{messages:0,chars:0}});
      // Every memory-enabled turn gets the answering rules, whether or not the model searches;
      // most same-day answers come from the handoff alone (benchmark: ~10% of them searched).
      const prefetched=readAllowed(turnState,agent)?await prefetchMessage(agent,base.messages||[]):null;
      // The grant may have been revoked while searching; nothing is attached then.
      const guidance=makeAnswerGuidanceMessage(),added=[...prefetched&&readAllowed(turnState,agent)?[prefetched]:[],
        guidance,...softenerAvailable(agent)?[makeControlPolicyMessage()]:[]];
      const messages=[...base.messages,...added];
      if(turnState){turnState.pendingMemoryMessages=messages;turnState.pendingMemoryIds=new Set(added.map(message=>message.id));}
      return {...base,messages};
    }
    return base;
  }

  function hasProtectedSystemHead(session){
    try{
      const headSeq=session?.surface?.nodes?.[0];
      const event=Number.isSafeInteger(headSeq)?session?.log?.[headSeq]:null;
      return event?.type==='system/message'&&event?.data?.message?.source?.kind==='system-prompt';
    }catch{
      return false;
    }
  }

  // Start loading the embedding model as soon as a user turn arrives, so a cold model is usually
  // ready by the time the model calls memory_search (its 2 s budget cannot cover a 10-15 s load).
  let lastWarm=0;
  function warmVectors(){
    if(!vectors||Date.now()-lastWarm<30_000)return;lastWarm=Date.now();
    void (async()=>{const grant=vectors.managementGrant();try{if(await vectors.getSnapshot({grant}))await vectors.load({grant});}catch{}finally{grant.cancel();}})();
  }
  async function onRequest(payload, next) {
    const session = payload?.agent?.session;
    if(payload?.step===1)warmVectors();
    const state = sessions.get(session?.id);
    const revokePending=()=>{
      if(state?.pendingMemoryMessages){const list=state.pendingMemoryMessages;for(let index=list.length-1;index>=0;index--)if(state.pendingMemoryIds.has(list[index].id))list.splice(index,1);}
      expireMemoryContext(session,payload,{includeHandoff:true});
    };
    if (payload.step === 1 && state?.turn === payload.turn && !state.expired) {
      // Native agent/request runs after step/start publication, before new input
      // is admitted. session/event itself forbids reentrant append. Clean once
      // per turn, so retries retain this turn's additions.
      state.expired = expireMemoryContext(session, payload,{includeHandoff:Boolean(handoff&&!readAllowed(state,payload.agent))});
      await reportRecall(session.id, payload.turn, { ...state.recall, expired: state.expired });
    }
    const config=await next();
    if(handoff&&state?.turn===payload.turn&&!readAllowed(state,payload.agent))revokePending();
    if(!handoff||payload.step!==1||state?.turn!==payload.turn)return config;
    if(!config?.provider||!config?.model)return config;
    if(typeof access?.isRootAgent==='function'&&!access.isRootAgent(payload.agent))return config;
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
      if(!hasProtectedSystemHead(session)){
        state.handoffDelivered=false;
        await report(session.id,payload.turn,{handoff:{state:'deferred',reasons:attempt.reasons,generation:attempt.generation,
          tokens:0,budgetTokens:handoffTokens,counting:'estimated',items:[],connectionCoverage:target.coverage??'provider-model-only'}});
        return config;
      }
      const selected=selectHandoff(messageRecorder.forAgent(payload.agent,{trackRecent:true}),{tokens:handoffTokens,sessionId:session.id,turn:payload.turn});
      const delivered=attempt.lastDelivered??null;
      const live=Boolean(delivered?.messageId&&session.deriveMessages?.().some(message=>message.id===delivered.messageId));
      const unchanged=live&&(selected.newest?.id??null)===(delivered.newest?.id??null)&&(selected.newest?.revision??null)===(delivered.newest?.revision??null);
      if(unchanged){
        await handoff.prepared(attempt,{messageId:delivered.messageId,newest:selected.newest,tokens:0,items:0,counting:selected.counting},{authorize});
        if(!authorize()){revokePending();return config;}
        state.handoffMessageId=delivered.messageId;
        state.handoffPreparedEmpty=false;
        state.handoffDelivered=true;
        report(session.id,payload.turn,{handoff:{state:'unchanged',reasons:attempt.reasons,generation:attempt.generation,
          tokens:0,budgetTokens:selected.budgetTokens,counting:selected.counting,items:[],connectionCoverage:target.coverage??'provider-model-only'}});
        return config;
      }
      const messageId=selected.text?randomUUID():null;
      await handoff.prepared(attempt,{messageId,newest:selected.newest,tokens:selected.tokens,items:selected.items.length,counting:selected.counting},{authorize});
      if(!authorize()){revokePending();return config;}
      if(selected.text){
        try{expireHandoffMessages(session,payload);}
        catch(error){logger?.warn?.('[memory-handoff] replace: '+error.message);}
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
        memoryControlSuppressed: false,
        sourceMessageId: '',
        sourceEventSeq: 0,
        sourceEventTime: 0,
        memoryStart:personalAllowed(agents.get(sessionId)||findAgent?.(sessionId)||{session}),memoryResolved:false,memoryAuthorization:null,
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
          }
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
    if(pipeline?.enabled){
      void pipeline.wake().catch(cause=>logger?.warn?.('[memory-pipeline] '+(cause.code??'MEMORY_PIPELINE_FAILED')));
    }
  }

  async function waitForIdle() { await messageRecorder.idle();await Promise.allSettled([...handoffWrites]);await legacyImporter?.idle();await handoff?.idle();await worker.idle();await pipeline?.idle();await rawRecall.flush();await statusReady;await Promise.allSettled([...statusWrites]); }

  return {
    config: resolved,
    onPreStep,
    onRequest,
    onSessionEvent,
    waitForIdle,
    retryPending: worker.wake,
    getMemoryConfig: worker.getConfig,
    getRawRecallStatus: () => rawRecall.status(),
    getMemoryRuntime,
    runMemoryRuntime,
    manageMemoryReview,
    manageMemoryDocuments,
    manageRawMessages,
    manageLegacyImport,
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
      const grant=access.grant(agent);
      try{return await entries.forGrant(agent,grant,{signal}).read(id);}finally{grant.cancel?.();}
    },
    dispose: async()=>{for(const id of queryAnswers.keys())closeQueryAnswer(id);lifecycle.abort();pipelineRegistration?.();vectorRegistration?.();await vaultWatch?.close();await vaultStartup;await legacyImporter?.close();await pipeline?.close();await messageRecorder.close();await vectors?.close();await runtimeTask;await Promise.allSettled([vectorSetup,switchStartup]);await Promise.allSettled([...handoffWrites]);await handoff?.idle();await worker.dispose();await rawRecall.dispose();await statusReady;await Promise.allSettled([...statusWrites]);},
    markSoftened,
    getMemoryStatus: memoryStatus.get,
  };
}

export { Config };

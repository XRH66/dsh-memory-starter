import path from 'node:path';
import {createPersonalMemoryRuntime} from './personal-runtime.js';
import {createRecordsTool} from './records.js';
import {createSoftenTool} from './memory.js';
import {compileSpec} from './tool-schema.js';
import {createPersonaRenderer,addSelectedPersona} from './persona-source.js';
import {createPureGate} from './pure-gate.js';
import {createPersonalAccess} from './personal-access.js';
import {registerSettingsRoutes} from './settings-host.js';
import {deploymentStaticFingerprint} from './deployment-config.js';
import {createSessionMemory} from './session-memory.js';
import {createChatConnectionResolver} from './chat-connection.js';

// The bridge no longer talks to Basic Memory, but a host may still have that MCP server mounted on the
// same Vault. Keep hiding it behind the session gate so a closed session cannot read notes through it.
const legacyQueryTool=name=>String(name).startsWith('mcp__basic_memory__')||name==='recent_conversation';
const legacyResource=exec=>['list_mcp_resources','read_mcp_resource','list_mcp_resource_templates'].includes(exec.name)&&exec.arguments?.server==='basic_memory';
const personalTool=name=>legacyQueryTool(name)||['dafeiyu_records','soften_memory','memory_search','memory_open','memory_recent','memory_mark_change'].includes(name);

/** Explicit personal host: the backend provider is independent of chat platforms. */
export const name='basic-memory-personal-host';
export const inject=['llm','tools','agents','sessions'];
export async function apply(ctx,options={}){
  if(!path.isAbsolute(options.directory??'')||!Array.isArray(options.sessionIds)||options.sessionIds.some(id=>typeof id!=='string'||!/^session-[a-zA-Z0-9_-]+$/.test(id)))throw Error('An explicit personal directory and native DSH session list are required');
  if(options.ownerSubject!==undefined&&(typeof options.ownerSubject!=='string'||!options.ownerSubject.trim()))throw Error('Invalid personal subject');
  const selected=new Set(options.sessionIds),pinned=new Map();let liveOwnerSubject=options.ownerSubject??null;
  // One host-owned reader for both persona suppression and personal-backend
  // access; portable mode never infers mode from prompt text.
  const sessionMemory=options.sessionMemory===true?await createSessionMemory({directory:options.directory,ownerSubject:liveOwnerSubject||'用户',agents:ctx.agents,sessions:ctx.sessions??ctx.get?.('sessions',false),logger:ctx.logger}):null;
  if(sessionMemory){ctx.provide('sessionMemory',sessionMemory);ctx.effect(()=>()=>sessionMemory.close());}
  const accessGate=sessionMemory??createPersonalAccess({getService:()=>typeof ctx.get==='function'?ctx.get('pureMode',false):undefined,logger:ctx.logger});
  const personal=await createPersonalMemoryRuntime({directory:options.directory,config:options.memory,llm:ctx.llm,logger:ctx.logger,access:accessGate,resolveChatConnection:sessionMemory?createChatConnectionResolver(ctx):undefined,
    findAgent:id=>ctx.agents?.get?.(id),listAgents:()=>ctx.agents?.list?.()??[],ownerSubject:()=>liveOwnerSubject});
  const accepts=id=>sessionMemory?(()=>{try{return sessionMemory.status(id).requested;}catch{return false;}})():(pinned.has(id)?pinned.get(id):selected.has(id)),dsh=personal.dsh;
  const tracks=id=>sessionMemory?/^session-[a-zA-Z0-9_-]+$/.test(id??''):accepts(id);
  const common={tools:personal.memory.tools,config:personal.config,getConfig:dsh.getMemoryConfig,logger:ctx.logger,now:()=>new Date(),onSourcesSoftened:input=>dsh.softenRawSources(input),softenRawMessage:id=>dsh.softenRawMessage(id)};
  for(const tool of [createRecordsTool(common),createSoftenTool({...common,resolveStructuredEntry:dsh.resolveStructuredEntry,onSoftened:(id,result)=>dsh.markSoftened(id,result)}),...dsh.queryTools,...(dsh.memoryChangeTool?[dsh.memoryChangeTool]:[])]){
    const execute=tool.execute;
    const dispose=ctx.tools.register({...tool,parameters:compileSpec(tool.parameters),async execute(args,exec){
      if(!accepts(exec?.agent?.session?.id))throw Error('This memory tool is limited to selected DSH sessions');
      // Foreground personal tools share the same host-owned mode state as the
      // portable backend, so an installed-but-not-ready pure plugin cannot leave
      // them open before its tool restriction lands.
      const accessState=accessGate.check(exec?.agent);
      if(!accessState.allowed)throw Error('Personal memory tools are unavailable while pure mode is '+String(accessState.reason));
      if(!sessionMemory)return execute(args,exec);
      const grant=sessionMemory.grant(exec.agent);
      return sessionMemory.withGrant(grant,async()=>{const value=await execute(args,{...exec,signal:AbortSignal.any([exec.signal,grant.signal].filter(Boolean))});sessionMemory.assertCurrent(exec.agent);return value;});
    }});
    if(typeof dispose==='function')ctx.effect(()=>dispose);
  }
  const scopes=new Map();let refreshing=false;
  // Runtime ownership selects which scopes to revisit. The policy still checks
  // each agent against the live registry before any memory tool is exposed.
  function trackScope(agent,liveAgents){
    if(scopes.has(agent))return;
    const owner=liveAgents.find(other=>other!==agent&&ctx.agents.isOwnedBy(agent.session.id,other));
    scopes.set(agent,{owner,children:new Set()});
    if(owner){
      trackScope(owner,liveAgents);
      scopes.get(owner).children.add(agent);
    }
  }
  function family(agent){
    const affected=new Set([agent]);
    for(const member of affected)for(const child of scopes.get(member)?.children??[])affected.add(child);
    return affected;
  }
  function refreshScopes(affected,catalogChanged=false){
    if(refreshing)return;refreshing=true;
    try{for(const agent of affected){
      const scope=scopes.get(agent);
      if(!scope)continue;
      if(ctx.agents.get(agent.session.id)!==agent){
        scopes.delete(agent);
        scopes.get(scope.owner)?.children.delete(agent);
        for(const child of scope.children)scopes.get(child).owner=undefined;
        scope.release?.();
        continue;
      }
      const scoped=agent.ctx?.get?.('tools')??agent.ctx?.tools;
      if(!scoped?.restrict)continue;
      const allowed=sessionMemory.check(agent).allowed;
      if(!catalogChanged&&scope.allowed===allowed)continue;
      const denied=[...(ctx.tools.view?.(agent)?.restrictableNames??[])].filter(name=>allowed?dsh.queryTools.length&&legacyQueryTool(name):personalTool(name)).sort();
      const key=denied.join('\0');
      if(scope.key!==key){
        const release=scope.release;
        scope.release=null;
        scope.key=undefined;
        scope.allowed=undefined;
        release?.();
        scope.release=denied.length?scoped.restrict({deny:denied}):null;
        scope.key=key;
      }
      scope.allowed=allowed;
    }}finally{refreshing=false;}
  }
  if(sessionMemory){
    if(ctx.tools.guard){const unregister=ctx.tools.guard(exec=>{
      const personal=personalTool(exec.name)||legacyResource(exec);
      if(personal&&!sessionMemory.check(exec.agent).allowed)return '本对话尚未开启记忆';
      if(dsh.queryTools.length&&(legacyQueryTool(exec.name)||legacyResource(exec)))return '请使用 memory_search / memory_open / memory_recent 查询记忆';
    });if(typeof unregister==='function')ctx.effect(()=>unregister);}
    const unsubscribe=sessionMemory.subscribe(({rootSessionId,reason})=>{
      const refreshRoot=()=>{
        const agent=ctx.agents.get(rootSessionId);
        if(scopes.has(agent))refreshScopes(family(agent));
      };
      // Opening is published before the policy clears its pending write. A
      // root turn can already have started while the write was in progress.
      if(reason==='authorization-opened')queueMicrotask(()=>{
        try{refreshRoot();}
        catch(error){ctx.logger?.warn?.('[session-memory] 无法刷新工具作用域：'+error.message);}
      });
      else refreshRoot();
    });
    ctx.effect(()=>()=>{
      unsubscribe();
      const released=[...scopes.values()];
      scopes.clear();
      for(const scope of released)scope.release?.();
    });
    ctx.on('tools/change',()=>refreshScopes(scopes.keys(),true));
    ctx.on('agent/created',({agent})=>{
      if(ctx.agents.get(agent.session.id)!==agent)return;
      if(!scopes.has(agent))trackScope(agent,ctx.agents.list());
      refreshScopes(family(agent));
    });
    ctx.on('agent/disposed',({agent})=>refreshScopes(family(agent)));
    const liveAgents=ctx.agents.list();
    for(const agent of liveAgents)trackScope(agent,liveAgents);
    refreshScopes(scopes.keys(),true);
  }
  ctx.on('agent/request',(payload,next)=>tracks(payload.agent.id)?dsh.onRequest(payload,next):next(),{prepend:true});
  ctx.on('agent/pre-step',(payload,next)=>tracks(payload.agent.id)?dsh.onPreStep(payload,next):next(),{prepend:true});
  ctx.on('session/event',(session,event)=>{
    const observed=sessionMemory?.observe(session,event);
    if(observed&&event.type==='turn/start'){
      const agent=ctx.agents.get(session.id),scope=scopes.get(agent);
      if(agent?.session===session&&scope&&!scope.owner)refreshScopes(family(agent));
    }
    if(!sessionMemory&&event.type==='turn/start'&&!pinned.has(session.id)&&/^session-[a-zA-Z0-9_-]+$/.test(session.id))pinned.set(session.id,selected.has(session.id));
    try{if(tracks(session.id))dsh.onSessionEvent(session,event);}
    finally{if(event.type==='turn/end')pinned.delete(session.id);}
  });
  ctx.on('agent/status',({agent,status})=>{if(status==='idle'){pinned.delete(agent.id);void dsh.wakePipeline()?.catch(error=>ctx.logger?.warn?.('[memory-pipeline] '+(error.code??'MEMORY_PIPELINE_FAILED')));}});
  ctx.on('tools/change',dsh.refreshPermanentDeleteProtection);
  ctx.on('basic-memory/retry-session',request=>{
    if(!accepts(request.sessionId))return;
    request.accepted=true;
    dsh.retryPending({resumeSessionId:request.sessionId}).catch(error=>ctx.logger?.warn?.('[basic-memory-bridge] manual retry pending: '+error.message));
  });
  ctx.effect(()=>()=>personal.close());
  // The gate reads the host-owned agent from the prompt context; pure-mode
  // state is never derived from prompt text. Without the plugin the service is
  // absent and memory behaves exactly as before.
  const pureGate=sessionMemory?null:createPureGate({getService:()=>typeof ctx.get==='function'?ctx.get('pureMode',false):undefined,logger:ctx.logger});
  const renderPersona=createPersonaRenderer({...options.persona,directory:options.directory,pure:pureGate,access:sessionMemory??undefined})??(()=> '');
  ctx.on('system-prompt/assemble',async(assembly,context,next)=>{
    const result=await next(),id=context?.agent?.id??context?.scope?.id;
    if(!tracks(id))return result;
    // The prompt hook can carry only a scope id; resolve the real host agent
    // through the agents registry instead of assuming "normal" when it is absent.
    const agent=context?.agent??(id&&typeof ctx.agents?.get==='function'?ctx.agents.get(id):undefined);
    // Suppression happens before any persona file is read.
    const assembled=pureGate?.check(agent).suppressed?pureGate.strip(result):addSelectedPersona(result,renderPersona,agent,pureGate);
    if(!sessionMemory||!Array.isArray(assembled.tools))return assembled;
    const allowed=sessionMemory.check(agent).allowed;
    return {...assembled,tools:assembled.tools.filter(tool=>allowed?!(dsh.queryTools.length&&legacyQueryTool(tool.name)):!personalTool(tool.name))};
  });
  let staticFingerprint=options.configurationStaticFingerprint;
  const service={personal,sessionMemory,ownerSubject:options.ownerSubject??null,configurationFile:options.configurationFile??null,configurationFingerprint:options.configurationFingerprint??null,log:()=>{},renderPersona,acceptsDshSession:accepts};
  const applySessions=async(cfg,revision,change)=>{
    if(!options.deployment||deploymentStaticFingerprint(cfg)!==staticFingerprint)return;
    const next=new Set(cfg.dshSessionIds);
    if(sessionMemory){
      // The compatibility binding list is not consent. Apply only the explicit
      // command that produced this save; unrelated old bindings stay untouched.
      if(!change||!['bind','unbind','replace'].includes(change.action))throw Error('需要明确的对话记忆开启或关闭操作');
      let updates;
      if(change.action==='replace'){
        if(!Array.isArray(change.value))throw Error('会话选择无效');
        const enabled=new Set(change.value);
        updates=[...new Set([...selected,...enabled])].map(id=>[id,enabled.has(id)]);
        // Revoke removed choices before enabling the new explicit selection.
        updates.sort((a,b)=>Number(a[1])-Number(b[1]));
      }else{
        if(typeof change.value!=='string'||!/^session-[a-zA-Z0-9_-]+$/.test(change.value))throw Error('会话选择无效');
        updates=[[change.value,change.action==='bind']];
      }
      for(const [id,enabled] of updates)if(sessionMemory.status(id).requested!==enabled)await sessionMemory.set(id,enabled);
    }
    for(const id of new Set([...selected,...next]))if(!pinned.has(id)&&ctx.agents?.get?.(id)?.status==='running')pinned.set(id,selected.has(id));
    selected.clear();for(const id of next)selected.add(id);
    try{await options.deployment.markApplied(revision);}
    catch(error){ctx.logger?.warn?.('[basic-memory-bridge] session settings were saved but the loaded-state receipt failed: '+error.message);throw error;}
    service.configurationFingerprint=revision;
  };
  service.applySessionSelection=applySessions;
  registerSettingsRoutes(ctx,options.configurationFile,applySessions,async()=>{
    const states=sessionMemory?[...selected].map(id=>{try{return sessionMemory.status(id);}catch{return {sessionId:id,requested:false,active:false,unavailable:true};}}):[];
    const sessionState={...sessionMemory?{sessionMemory:{defaultEnabled:false,effective:'next-user-turn',enabledSessions:states.filter(s=>s.requested).map(s=>s.sessionId),states}}:{},memoryRuntime:await dsh.getMemoryRuntime()};
    const pendingTurns=sessionMemory?states.filter(s=>s.requested&&!s.active).length:[...pinned].filter(([id,wasSelected])=>wasSelected!==selected.has(id)).length;
    try{const state=await personal.recoveryStore.read(),held=state.pending.filter(item=>item.owners?.length?item.owners.some(owner=>!personal.maintenanceAllowed(owner.sessionId,item)):!personal.maintenanceAllowed(state.lastSessionId,item)).length;return {...sessionState,pendingTurns,rawRecall:personal.dsh.getRawRecallStatus(),recovery:{sync:state.pending.length,platformHeld:held}};}
    catch(error){ctx.logger?.warn?.('[basic-memory-bridge] cannot read recovery status: '+error.message);return {...sessionState,pendingTurns,recovery:null};}
  },{sessionMemory,getMemoryRuntime:dsh.getMemoryRuntime,runMemoryRuntime:dsh.runMemoryRuntime,manageMemoryReview:sessionMemory?dsh.manageMemoryReview:undefined,
    manageMemoryDocuments:sessionMemory?dsh.manageMemoryDocuments:undefined,getHandoffState:sessionMemory?dsh.getHandoffState:undefined,afterHandoffSave:async(cfg,revision)=>{
    dsh.setHandoffTokens(cfg.memory.handoffTokens);
    if(!options.deployment)throw Error('请重新加载记忆框架');
    await options.deployment.markApplied(revision);staticFingerprint=deploymentStaticFingerprint(cfg);service.configurationFingerprint=revision;
  },afterSave:async(cfg,revision)=>{
    if(!options.deployment)throw Error('设置已保存；请重新加载记忆框架');
    await options.deployment.markApplied(revision);staticFingerprint=deploymentStaticFingerprint(cfg);service.configurationFingerprint=revision;
  }});
  if(!options.deferProvide)ctx.provide('memoryPersonal',service);
  return service;
}

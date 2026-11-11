import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createUnifiedProfiles,profileFromLegacy} from './unified/profiles.js';
import {createVectorQueue} from './unified/vector-queue.js';
import {createEmbeddingBackend} from './raw-rag/backend.js';
import {createMemoryDocuments} from './memory-documents.js';

const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const catalogueTask='catalog-change:authorized-domain-boundary';

/** Portable composition only: no unified runtime, Suzu core, second raw body
 * store, LLM or fixed BGE lane. The host disables raw's old vector consumer.
 * Management grants are host capabilities: expose them only AFTER authenticating
 * the management route, never as a model tool or an unauthenticated RPC. */
export function createMemoryVectors({directory,access,raw,entries,tools,config,getPriorityConfig=()=>config,findAgent=()=>null,listAgents=()=>[],
  ownerSubject=access?.ownerSubject,project=config?.project??'main',createBackend=createEmbeddingBackend,
  now=Date.now,canRun=()=>true,queueConfig={},managementAgent}={}){
  if(!path.isAbsolute(directory??'')||!ownerSubject||!access?.validate||!raw?.messageReader||!entries?.forGrant)throw TypeError('Portable vector dependencies required');
  const management=new WeakMap(),shutdown=new AbortController();
  let closed=false,readyTask,foreground=0,queue,profiles;
  const authorize=grant=>!closed&&!grant?.signal?.aborted&&grant?.ownerSubject===ownerSubject&&grant?.project===project&&
    (management.has(grant)||access.validate(grant));
  const agentForGrant=grant=>management.get(grant)?.agent??findAgent(grant?.sessionId)??listAgents().find(agent=>agent.session?.id===grant?.sessionId);
  function check(grant){shutdown.signal.throwIfAborted();if(!authorize(grant))fail('MEMORY_NOT_AUTHORIZED','记忆向量授权已失效');}
  async function beforeBackground({signal}={}){
    while(foreground||!canRun()){
      shutdown.signal.throwIfAborted();signal?.throwIfAborted();
      await delay(10,undefined,{signal:AbortSignal.any([signal,shutdown.signal].filter(Boolean))});
    }
    signal?.throwIfAborted();
    // Yield between source pages / document batches, not one foreground turn.
    await delay(0,undefined,{signal:AbortSignal.any([signal,shutdown.signal].filter(Boolean))});
  }
  // Counts queries that had to load a local model first, so their wait is not mistaken for search time.
  let coldLoads=0;
  function managedBackend(options){
    const backend=createBackend({...options,deviceCacheFile:path.join(directory,'device-compatibility.json')});
    return new Proxy(backend,{get(target,key){
      const value=target[key];if(typeof value!=='function')return value;
      if(!['planChunks','embed'].includes(key))return value.bind(target);
      return async(...args)=>{
        const request=args[1]??{};
        if(key==='planChunks'||request.kind==='document')await beforeBackground(request);
        if(key==='embed'&&request.kind==='query'){const state=target.status?.();if(state&&!state.cloud&&!state.prepared)coldLoads++;}
        return value.apply(target,args);
      };
    }});
  }
  const documents=createMemoryDocuments({directory,access,raw,entries,tools,config,getPriorityConfig,authorize,agentForGrant,beforeBackground});
  profiles=createUnifiedProfiles({file:path.join(directory,'profiles.json'),indexFile:path.join(directory,'vectors.sqlite'),authorize,
    listDocuments:documents.listDocuments,listDocumentMetadata:documents.listDocumentMetadata,
    resolveDocument:documents.resolveDocument,createBackend:managedBackend,now,singleBackend:true,queryCandidateLimit:120});

  function managementGrant({agent}={}){
    if(closed)fail('MEMORY_VECTORS_CLOSED','向量服务已关闭');
    const controller=new AbortController();
    const grant=Object.freeze({kind:'management',ownerSubject,project,signal:controller.signal,
      cancel(){management.delete(grant);controller.abort();}});
    management.set(grant,{agent:agent??(typeof managementAgent==='function'?managementAgent():managementAgent)??listAgents()[0]});
    return grant;
  }
  const withOptions=async(options,action)=>{
    await api.ready();check(options?.grant);return action(options);
  };
  function pendingBoundaries(){
    const scope={ownerSubject,project},intent=profiles.vectorIntent(scope),state=queue.status();
    const dirty=queue.catalogueCheckpoint(scope).filter(row=>row.delivery>row.acknowledged).length;
    const pending=state.jobs.filter(row=>row.profile?.id===intent.profile?.id&&row.profile?.revision===intent.profile?.revision&&
      row.intentId===intent.intentId&&['pending','running','held','error'].includes(row.state)).length;
    return Math.max(dirty,pending);
  }
  async function prepare(current,resume=false){
    await beforeBackground(current);
    await api.reconcileMaintenance();
    // Only changes known before enumeration can be acknowledged by this pass.
    const checkpoint=queue.catalogueCheckpoint({ownerSubject,project});
    let result;
    try{
      result=await profiles[resume?'resumePreparation':'prepare'](current);
      await queue.settleCatalogue({checkpoint,profile:result.profile});
    }finally{
      // A failed switch may leave the old active space usable. Cancellation of
      // that active intent stays cancelled; the queue checks it before binding.
      if(!closed)await queue.reconcileCatalogues();
    }
    const pending=pendingBoundaries();
    return {...result,catalogueFresh:pending===0,...(pending?{state:'pending',caughtUp:false,pendingBoundaries:pending}:{})};
  }
  function forGrant(agent,grant){
    if(grant?.sessionId!==agent?.session?.id||!access.validate(grant))fail('MEMORY_NOT_AUTHORIZED','会话读取授权无效');
    const validate=()=>{check(grant);if(grant.sessionId!==agent?.session?.id||!access.validate(grant))fail('MEMORY_NOT_AUTHORIZED','会话读取授权已失效');};
    return {
      getSnapshot:options=>{validate();return api.getSnapshot({...options,grant});},
      query:options=>{validate();return api.query({...options,grant});},
      close(){/* caller owns this shared answer grant */},
    };
  }
  const api={
    ready(){return readyTask??=(async()=>{await Promise.all([profiles.ready(),documents.ready()]);await queue.ready();return {ready:true};})();},
    managementGrant,
    async registerCurrentConfig(options={}){
      return withOptions(options,async({grant,settings=config,profileId,label,select=true,signal})=>{
        const profile=profileFromLegacy({id:profileId??settings.rawRecallModel,label,settings});
        const result=await profiles.register({profile,grant,signal});
        if(select)await profiles.select({profileId:profile.id,grant,signal});
        // A confirmed switch staged before reload becomes this profile's intent
        // exactly once. Without a confirmation nothing else happens here.
        const confirmation=settings.rawRecallSwitch;
        if(select&&confirmation?.confirmedAt)try{
          await profiles.setSwitchIntent({profileId:profile.id,grant,signal,confirmedAt:confirmation.confirmedAt,cloudConfirmed:confirmation.cloudConfirmed===true});
        }catch(error){if(error.code!=='CLOUD_PERMISSION_REVOKED')throw error;}
        return result;
      });
    },
    forGrant,
    forAgent(agent){const grant=access.grant(agent),reader=forGrant(agent,grant);return {...reader,close(){grant.cancel?.();}};},
    async getSnapshot(options={}){return withOptions(options,current=>profiles.activeSnapshot(current));},
    activeSnapshot(grant){return api.getSnapshot(grant?.grant?grant:{grant});},
    resolveDocument:options=>withOptions(options,current=>documents.resolveDocument(current)),
    async query(options={}){
      await api.ready();check(options.grant);
      const deadline=options.deadline??now()+2000;
      if(!Number.isFinite(deadline)||deadline<=now())return {records:[],state:'unavailable',reason:'deadline',degraded:true};
      const timerController=new AbortController();
      const signal=AbortSignal.any([options.signal,options.grant.signal,shutdown.signal,timerController.signal].filter(Boolean));
      const timer=setTimeout(()=>timerController.abort(Object.assign(Error('Shared vector deadline reached'),{code:'MEMORY_SEARCH_TIMEOUT'})),Math.max(1,deadline-now()));
      foreground++;
      let abort;
      try{
        // Cold queries never prepare/reconcile a library. Loading the active
        // model is still bounded by the caller's one absolute deadline.
        const cancelled=new Promise((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
        return await Promise.race([profiles.query({...options,signal,deadline}),cancelled]);
      }catch(error){
        check(options.grant);options.signal?.throwIfAborted();shutdown.signal.throwIfAborted();
        return {records:[],state:'unavailable',reason:error.code??'VECTOR_QUERY_UNAVAILABLE',...error.code?{}:{detail:String(error?.message??error).slice(0,200)},degraded:true};
      }finally{foreground--;clearTimeout(timer);signal.removeEventListener('abort',abort);}
    },
    prepare:options=>withOptions(options,current=>prepare(current)),
    resumePreparation:options=>withOptions(options,current=>prepare(current,true)),
    load:options=>withOptions(options,current=>profiles.load(current)),
    probe:options=>withOptions(options,current=>profiles.probe(current)),
    coldLoads:()=>coldLoads,
    release:options=>withOptions(options,current=>profiles.release(current)),
    cancel:options=>withOptions(options,current=>profiles.cancel(current)),
    select:options=>withOptions(options,current=>profiles.select(current)),
    plan:options=>withOptions(options,current=>profiles.plan(current)),
    setSwitchIntent:options=>withOptions(options,current=>profiles.setSwitchIntent(current)),
    clearSwitchIntent:options=>withOptions(options,current=>profiles.clearSwitchIntent(current)),
    dropIndex:options=>withOptions(options,current=>profiles.dropIndex(current)),
    // Synchronous, no I/O: the valid confirmed switch for this scope, or null.
    switchIntent(){return profiles.switchIntent({ownerSubject,project});},
    /** Decide whether a confirmed switch should prepare now: only for the
     * selected profile, not yet active+ready, and for cloud only with both the
     * per-switch confirmation and the cloud opt-in. Clears a finished intent. */
    switchTarget:options=>withOptions(options,async({grant,signal})=>{
      const intent=profiles.switchIntent({ownerSubject,project});if(!intent)return null;
      const state=await profiles.status({grant,signal}),profile=state.profiles.find(row=>row.id===intent.profileId);
      if(!profile||state.selectedProfileId!==intent.profileId)return null;
      if(state.active?.id===profile.id&&state.active?.revision===profile.revision&&profile.progress?.state==='ready'){await profiles.clearSwitchIntent({grant,signal});return null;}
      if(profile.backend?.engine==='api'&&(intent.cloudConfirmed!==true||profile.backend.config.rawRecallAllowCloud!==true))return null;
      return {profileId:profile.id,profileRevision:profile.revision};
    }),
    register:options=>withOptions(options,current=>profiles.register(current)),
    updateRuntime:options=>withOptions(options,current=>profiles.updateRuntime(current)),
    documentSelection:options=>withOptions(options,current=>documents.documentSelection(current)),
    selectDocuments:options=>withOptions(options,async current=>{
      const result=await documents.selectDocuments(current);
      await api.notifyChanged({kind:'document',id:'selected-documents',revision:result.revision,ownerSubject,project});
      return result;
    }),
    coverage:options=>withOptions(options,async current=>{
      await api.reconcileMaintenance();
      const result=await profiles.coverage(current),pending=pendingBoundaries();
      return {...result,coverageSource:'last-background-catalogue',pendingBoundaries:pending,catalogueFresh:pending===0,
        caughtUp:result.caughtUp&&pending===0,state:pending&&result.profile?'pending':result.state};
    }),
    async status(options){
      if(!options?.grant)return {ready:Boolean(readyTask),closed,foreground,profiles:profiles.peek({ownerSubject,project}),queue:queue.status()};
      return withOptions(options,async current=>{
        await api.reconcileMaintenance();
        const result=await profiles.status(current),pending=pendingBoundaries();
        for(const profile of result.profiles)if(profile.id===result.active?.id&&profile.revision===result.active?.revision&&profile.progress.state==='ready'&&pending)
          profile.progress={...profile.progress,state:'pending',pendingBoundaries:pending};
        return {...result,queue:queue.status(),foreground,pendingBoundaries:pending,catalogueFresh:pending===0,coverageSource:'last-background-catalogue'};
      });
    },
    async notifyChanged(notice){
      await api.ready();
      if(closed)fail('MEMORY_VECTORS_CLOSED','向量服务已关闭');
      if(notice?.ownerSubject!==ownerSubject||notice.project!==project||typeof notice.id!=='string'||notice.revision===undefined)fail('INVALID_SOURCE','向量变更范围或版本无效');
      // A catalogue reconciliation task, not a new manual claim about the
      // changed fact. Actual document authority/proofs are re-read by profiles.
      // profiles.incremental reconciles the whole authorized boundary, so one
      // durable delivery counter can coalesce many source notifications. A new
      // notification DURING a pass forces another pass; it is not lost on crash.
      return queue.notifyCatalogue({id:catalogueTask,revision:1,ownerSubject,project,kind:'document',authority:'manual'});
    },
    async reconcileMaintenance(){
      await api.ready();
      if(closed)fail('MEMORY_VECTORS_CLOSED','向量服务已关闭');
      const maintenanceRevision=raw.maintenanceRevision?.();
      if(maintenanceRevision==null)return;
      return queue.notifyCatalogue({id:catalogueTask,revision:1,ownerSubject,project,kind:'document',authority:'manual'},{maintenanceRevision});
    },
    async flush(options={}){await api.reconcileMaintenance();return queue.flush(options);},
    async resume(){await api.reconcileMaintenance();return queue.resume();},
    async close(){if(closed)return;closed=true;shutdown.abort();await queue.close();await profiles.close();await documents.close();},
  };
  queue=createVectorQueue({file:path.join(directory,'vector-queue.json'),profiles,findAgent,listAgents,now,
    config:{debounceMs:300,maxJobs:1,...queueConfig},
    runtime:{authorize,policy:{check:()=>({enabled:false}),validate:()=>false},sources:{get({id,revision,grant}){
      check(grant);return id.startsWith('catalog-change:')?{id,revision,ownerSubject,project,kind:'document',authority:'manual',state:'live'}:null;
    }}},
    acquire:async()=>{
      await beforeBackground();
      const agent=(typeof managementAgent==='function'?managementAgent():managementAgent)??listAgents()[0];
      return managementGrant({agent});
    },
  });
  return api;
}

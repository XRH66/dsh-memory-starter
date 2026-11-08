import {randomUUID} from 'node:crypto';
import {createUnifiedStateStore} from './unified/state-store.js';
import {MEMORY_CHANGE_KINDS,MEMORY_PIPELINE_DEFAULTS} from './memory-contract.js';
import {estimateRecentTokens} from './recent-context.js';
import {pipelineKey,pipelineGroup,memoryBatchDue,packMemoryBatch} from './memory-batch.js';

const error=(code)=>Object.assign(Error(code),{code});
const codeOf=cause=>/^[A-Z][A-Z0-9_]{0,79}$/u.test(cause?.code)?cause.code:'MEMORY_PIPELINE_FAILED';
const route=value=>value&&typeof value.provider==='string'&&value.provider.trim()&&typeof value.model==='string'&&value.model.trim()?{provider:value.provider,model:value.model}:null;
const terminal=new Set(['completed','superseded']);
const indexJobs=jobs=>new Map(jobs.map(job=>[pipelineKey(job),job]));
const fragmentJobs=(batch,index)=>batch.fragments.map(fragment=>index.get(fragment.key));
const abortable=async(action,signal)=>{
  signal.throwIfAborted();let abort;
  try{return await Promise.race([Promise.resolve().then(()=>{signal.throwIfAborted();return action();}),new Promise((_,reject)=>{abort=()=>reject(signal.reason??error('MEMORY_CANCELLED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();})]);}
  finally{signal.removeEventListener('abort',abort);}
};

/** One per-library semantic queue, over the existing original authority.
 * prepare -> durable result -> commit -> durable delivery are independent
 * checkpoints. No Suzu core, extra classifier or vector model is created here.
 * The new writer takes ownership only when both organizer ports are mounted. */
export function createMemoryPipeline({file,raw,access,findAgent,listAgents=()=>[],organizer,canRun=()=>true,onCommitted,now=Date.now,timers={setTimeout,clearTimeout},settings={}}){
  const options={...MEMORY_PIPELINE_DEFAULTS,maxAttempts:3,retryMs:1000,...settings};
  for(const key of ['batchTokens','batchTurns','idleMs','maxWaitMs','referenceTokens','semanticConcurrency','maxAttempts','retryMs'])if(!Number.isSafeInteger(options[key])||options[key]<1)throw TypeError('Invalid pipeline setting: '+key);
  if(options.semanticConcurrency!==1)throw TypeError('This library requires one semantic writer');
  const enabled=typeof organizer?.prepare==='function'&&typeof organizer?.commit==='function';
  const store=createUnifiedStateStore({file,initial:()=>({jobs:[],batches:[]}),validate:state=>{
    if(!Array.isArray(state.jobs)||!Array.isArray(state.batches)||new Set(state.jobs.map(pipelineKey)).size!==state.jobs.length)throw error('INVALID_PIPELINE_STATE');
    for(const job of state.jobs)if(!job.id||!job.ownerSubject||!job.project||!['pending','held','running','completed','superseded'].includes(job.state)||!Number.isSafeInteger(job.tokens)||job.tokens<0||!Number.isSafeInteger(job.offset)||job.offset<0)throw error('INVALID_PIPELINE_JOB');
    for(const batch of state.batches)if(!batch.id||!Array.isArray(batch.fragments)||!['pending','running','prepared','committed','held','error'].includes(batch.state))throw error('INVALID_PIPELINE_BATCH');
  }});
  let readyTask,resumeTask,stopped=false,timer,nextWake=null,pump,active,reason=null,heldNotices=0;
  const deliveries=new Map(),registrations=new Set();
  const assertOpen=()=>{if(stopped)throw error('MEMORY_PIPELINE_CLOSED');};
  function prove(job){
    assertOpen();
    if(!job)throw error('MEMORY_SOURCE_CHANGED');
    const scope={ownerSubject:job.ownerSubject,project:job.project};
    const proof=raw.messageReader(scope,{authorize:()=>!stopped&&access.ready}).proof(job);
    if(!proof?.isCurrent||proof.withdrawn)throw error('MEMORY_SOURCE_CHANGED');
    const grant=proof.authorization,agent=findAgent(job.sessionId);
    if(!agent||!access.validateMessage(grant)||job.grantId&&grant.id!==job.grantId||job.epoch&&grant.epoch!==job.epoch)throw error('MEMORY_NOT_AUTHORIZED');
    return {scope,grant};
  }
  function read(job){
    const {scope,grant}=prove(job);
    const source=raw.messageReader(scope,{authorize:()=>!stopped&&access.validateMessage(grant)}).get(job);
    if(!source?.isCurrent||source.withdrawn)throw error('MEMORY_SOURCE_CHANGED');
    return source;
  }
  function snapshot(){
    const value=store.ready?store.snapshot(({batches,...state})=>{
      const priority=batches.findLast(batch=>batch.changeKind);
      return {...state,deliveryPending:batches.filter(batch=>batch.state==='committed'&&batch.delivery!=='done').length,
        latestPriority:priority?{id:priority.id,kind:priority.changeKind,state:priority.state,applied:priority.receipt?.applied,reviews:priority.receipt?.reviews}:null,
        batches:batches.map(({prepared,receipt,...batch})=>({...batch,hasPrepared:Boolean(prepared),committed:receipt?.committed===true}))};
    }):{jobs:[],batches:[],deliveryPending:0,latestPriority:null},counts={pending:0,held:0,running:0,completed:0,superseded:0};
    for(const job of value.jobs)counts[job.state]++;
    return {enabled,ready:store.ready,closed:stopped,busy:Boolean(pump),waitingReason:reason,nextWake,...counts,
      heldNotices,...value};
  }
  function ensureReady(){
    return readyTask??=(async()=>{
      const interrupted=await store.read(state=>state.batches.some(batch=>batch.state==='running'||batch.delivery==='running'));
      if(interrupted)await store.update(state=>{
        const index=indexJobs(state.jobs);
        for(const batch of state.batches){
          if(batch.state==='running'){
            batch.state=batch.prepared?'prepared':'held';batch.error=batch.prepared?null:'MEMORY_INTERRUPTED_REVIEW_REQUIRED';
            for(const job of fragmentJobs(batch,index))if(job&&!terminal.has(job.state)){job.state=batch.prepared?'pending':'held';job.reason=batch.error;}
          }
          if(batch.delivery==='running')batch.delivery='pending';
        }
      });
    })();
  }
  async function ready(){if(enabled)await ensureReady();return snapshot();}
  const clear=()=>{if(timer!==undefined)timers.clearTimeout(timer);timer=undefined;nextWake=null;};
  function groups(jobs){
    const grouped=new Map();
    for(const job of jobs)if(job.state==='pending'&&job.turnState!=='pending'&&!job.batchId){const key=pipelineGroup(job),items=grouped.get(key)??[];items.push(job);grouped.set(key,items);}
    return [...grouped.values()].map(items=>{
      items.sort((a,b)=>a.sequence-b.sequence);
      return {items,due:memoryBatchDue(items,options)};
    }).sort((a,b)=>a.due-b.due||a.items[0].createdAt-b.items[0].createdAt);
  }
  function arm(floor=0){
    clear();if(stopped||!enabled||!store.ready||pump)return;
    const due=store.snapshot(({jobs,batches})=>{
      let earliest=groups(jobs)[0]?.due??Infinity;
      for(const batch of batches){
        if(batch.state==='pending'||batch.state==='prepared')earliest=Math.min(earliest,batch.nextAt??0);
        if(typeof onCommitted==='function'&&batch.state==='committed'&&batch.delivery==='pending')earliest=Math.min(earliest,batch.deliveryAt??0);
      }
      return earliest;
    });
    if(due===Infinity)return;
    const delay=Math.max(floor,0,due-now());nextWake=now()+delay;
    timer=timers.setTimeout(()=>{timer=undefined;nextWake=null;void wake().catch(cause=>{reason=codeOf(cause);});},Math.min(delay,2_147_483_647));timer?.unref?.();
  }
  function admitted(job){
    if(listAgents().some(agent=>agent.status==='running')||findAgent(job.sessionId)?.status==='running')return {allowed:false,reason:'foreground-busy'};
    const result=canRun({lane:'semantic',target:job.target,ownerSubject:job.ownerSubject,project:job.project});
    return typeof result==='boolean'?{allowed:result,reason:result?null:'resource-busy'}:result;
  }
  async function register(notice){
    if(!enabled||stopped)return {accepted:false,reason:'consumer-not-mounted'};
    await ensureReady();const ref={ownerSubject:notice.ownerSubject,project:notice.project,id:notice.id,revision:notice.revision};
    if(notice.operation==='withdrawn'){
      if(active?.ids.has(notice.id))active.controller.abort(error('MEMORY_SOURCE_CHANGED'));
      await store.update(state=>{for(const job of state.jobs)if(job.id===notice.id&&!terminal.has(job.state)){job.state='superseded';job.reason='MEMORY_SOURCE_CHANGED';}});arm();return {accepted:false,reason:'withdrawn'};
    }
    let source;
    try{source=read({...ref,sessionId:notice.sessionId});}catch(cause){return {accepted:false,reason:codeOf(cause)};}
    if(source.processingContext?.owner!=='pipeline-v1')return {accepted:false,reason:'not-processing-owner'};
    const changeKind=source.turnState==='completed'&&MEMORY_CHANGE_KINDS.includes(source.processingContext.changeKind)
      ?source.processingContext.changeKind:null;
    const authorize=()=>!stopped&&access.validateMessage(source.authorization);
    const acknowledge=()=>{
      if(!authorize())return {accepted:false,reason:'authorization-revoked'};
      raw.messageProjectionReceipt({...ref,position:source.position,consumer:'pipeline-v1'},{authorize});
      return {accepted:true};
    };
    const key=pipelineKey(ref),saved=store.snapshot(state=>state.jobs.find(job=>pipelineKey(job)===key));
    if(saved&&source.position<=saved.position){
      return {...acknowledge(),duplicate:true};
    }
    if(active?.ids.has(source.id)&&!active.keys.has(key))active.controller.abort(error('MEMORY_SOURCE_CHANGED'));
    await store.update(state=>{
      const suppressed=state.suppressedTurns?.some(turn=>turn.sessionId===source.sessionId&&turn.turn===source.turn&&turn.ownerSubject===ref.ownerSubject&&turn.project===ref.project);
      for(const job of state.jobs)if(job.id===source.id&&pipelineKey(job)!==key&&!terminal.has(job.state)){job.state='superseded';job.reason='MEMORY_SOURCE_CHANGED';}
      const job=state.jobs.find(item=>pipelineKey(item)===key);
      if(job){job.position=source.position;job.turnState=source.turnState;job.updatedAt=now();
        if(changeKind){job.important=true;job.changeKind=changeKind;}return;}
      const tokens=estimateRecentTokens(source.text),frozen=route(source.processingContext.target);
      state.jobs.push({...ref,sessionId:source.sessionId,rootSessionId:source.authorization.rootSessionId,epoch:source.authorization.epoch,grantId:source.authorization.id,
        sequence:source.sequence,turn:source.turn,role:source.role,position:source.position,turnState:source.turnState,target:frozen,topic:'',
        tokens,offset:0,...changeKind?{important:true,changeKind}:{},state:suppressed?'superseded':frozen&&tokens?'pending':'held',
        reason:suppressed?'MEMORY_CONTROL':!frozen?'MEMORY_TARGET_REQUIRED':!tokens?'NO_SEMANTIC_TEXT':null,createdAt:now(),updatedAt:now()});
    });
    arm();return acknowledge();
  }
  function notify(notice){
    const task=register(notice);registrations.add(task);task.then(()=>registrations.delete(task),()=>registrations.delete(task));return task;
  }
  function context(batch,jobs,controller){
    const check=()=>{controller.signal.throwIfAborted();for(const job of jobs){if(job?.state==='superseded')throw error('MEMORY_SOURCE_CHANGED');prove(job);}};
    check();const release=access.subscribe?.(()=>{try{check();}catch(cause){controller.abort(cause);}});
    return {jobs,check,release,context:{batchId:batch.id,agent:findAgent(jobs[0].sessionId),target:structuredClone(jobs[0].target),signal:controller.signal,check,
      referenceTokens:options.referenceTokens,scope:{ownerSubject:jobs[0].ownerSubject,project:jobs[0].project}}};
  }
  async function process(batch,jobs){
    const controller=new AbortController();active={controller,ids:new Set(batch.fragments.map(item=>item.id)),keys:new Set(batch.fragments.map(item=>item.key))};let held;
    const change=fn=>store.update(state=>fn(state.batches.find(item=>item.id===batch.id),state));
    try{
      held=context(batch,jobs,controller);const ctx=held.context;
      if(!batch.prepared){
        const gate=admitted(held.jobs[0]);if(!gate?.allowed){reason=gate?.reason??'resource-busy';return false;}
        if(batch.prepareAttempts>=options.maxAttempts)throw error('MEMORY_RETRY_EXHAUSTED');
        await change((saved,state)=>{saved.state='running';saved.prepareAttempts++;for(const job of fragmentJobs(batch,indexJobs(state.jobs)))job.state='running';});held.check();
        const sources=batch.fragments.map((fragment,index)=>{
          const source=read(held.jobs[index]);return {id:source.id,revision:source.revision,role:source.role,sessionId:source.sessionId,messageId:source.messageId,
            sequence:source.sequence,turn:source.turn,time:source.time??source.recordedAt,completion:source.turnState,range:{start:fragment.start,end:fragment.end,total:fragment.total},text:source.text.slice(fragment.start,fragment.end)};
        });
        const prepared=await abortable(()=>organizer.prepare({sources,tokens:batch.tokens,counting:'estimated'},ctx),controller.signal);held.check();
        if(!prepared||typeof prepared!=='object'||Array.isArray(prepared))throw error('INVALID_PREPARED_MEMORY');
        const durable=JSON.parse(JSON.stringify(prepared));
        await change(saved=>{saved.prepared=durable;saved.state='prepared';saved.error=null;});batch={...batch,prepared:durable};
      }
      held.check();
      if(batch.commitAttempts>=options.maxAttempts)throw error('MEMORY_RETRY_EXHAUSTED');
      await change((saved,state)=>{saved.commitAttempts++;for(const job of fragmentJobs(batch,indexJobs(state.jobs)))job.state='running';});
      const receipt=await abortable(()=>organizer.commit(batch.prepared,ctx),controller.signal);held.check();
      if(!receipt||receipt.committed!==true)throw error('MEMORY_COMMIT_RECEIPT_REQUIRED');
      await change((saved,state)=>{
        saved.state='committed';saved.receipt=JSON.parse(JSON.stringify(receipt));saved.delivery='pending';saved.error=null;
        const index=indexJobs(state.jobs);
        for(const fragment of batch.fragments){const job=index.get(fragment.key);job.offset=fragment.end;job.tokens=Math.max(0,job.tokens-fragment.tokens);
          job.state=fragment.end>=fragment.total?'completed':'pending';job.continuation=job.state==='pending';delete job.batchId;}
      });reason=null;return true;
    }catch(cause){
      const code=codeOf(cause);
      await change((saved,state)=>{
        saved.error=code;const attempts=saved.prepared?saved.commitAttempts:saved.prepareAttempts;
        const holding=stopped||['MEMORY_NOT_AUTHORIZED','MEMORY_SOURCE_CHANGED','MEMORY_PIPELINE_CLOSED'].includes(code);
        saved.state=holding?'held':attempts>=options.maxAttempts||code==='MEMORY_RETRY_EXHAUSTED'?'error':saved.prepared?'prepared':'pending';
        saved.nextAt=now()+options.retryMs*2**Math.max(0,attempts-1);
        for(const job of fragmentJobs(batch,indexJobs(state.jobs)))if(job&&!terminal.has(job.state))job.state=holding?'held':'pending';
      });return true;
    }finally{held?.release?.();active=null;}
  }
  function deliver(batch,jobs){
    if(stopped||typeof onCommitted!=='function'||deliveries.has(batch.id))return;
    const controller=new AbortController();let held;
    const task=(async()=>{
      try{
        held=context(batch,jobs,controller);await store.update(state=>{state.batches.find(item=>item.id===batch.id).delivery='running';});
        await abortable(()=>onCommitted({batchId:batch.id,receipt:batch.receipt,sources:batch.fragments.map(({id,revision})=>({id,revision}))},held.context),controller.signal);held.check();
        await store.update(state=>{const saved=state.batches.find(item=>item.id===batch.id);saved.delivery='done';saved.deliveryError=null;});
      }catch(cause){await store.update(state=>{const saved=state.batches.find(item=>item.id===batch.id),code=codeOf(cause);saved.deliveryError=code;
        if(stopped||['MEMORY_NOT_AUTHORIZED','MEMORY_SOURCE_CHANGED','MEMORY_PIPELINE_CLOSED'].includes(code)){saved.delivery='held';return;}
        saved.deliveryAttempts=(saved.deliveryAttempts??0)+1;saved.delivery=saved.deliveryAttempts>=options.maxAttempts?'error':'pending';saved.deliveryAt=now()+options.retryMs*2**(saved.deliveryAttempts-1);});}
      finally{held?.release?.();}
    })().finally(()=>{deliveries.delete(batch.id);arm();});deliveries.set(batch.id,{controller,task});
  }
  async function run(force){
    let blocked=false;
    while(!stopped){
      const plan=store.snapshot(state=>{
        const time=now();
        const batch=state.batches.find(item=>['pending','prepared'].includes(item.state)&&(item.nextAt??0)<=time);
        const due=typeof onCommitted==='function'?state.batches.filter(item=>item.state==='committed'&&item.delivery==='pending'&&(item.deliveryAt??0)<=time&&!deliveries.has(item.id)):[];
        const index=batch||due.length?indexJobs(state.jobs):null;
        return {batch,jobs:batch?fragmentJobs(batch,index):undefined,
          deliveries:due.map(item=>({batch:item,jobs:fragmentJobs(item,index)})),
          choices:batch?[]:groups(state.jobs).filter(group=>force||group.due<=time)};
      });
      let {batch,jobs}=plan;
      for(const delivery of plan.deliveries)deliver(delivery.batch,delivery.jobs);
      if(!batch){
        if(!plan.choices.length)break;
        let selected;
        for(const {items} of plan.choices){const gate=admitted(items[0]);if(gate?.allowed){selected=items;break;}reason=gate?.reason??'resource-busy';}
        if(!selected){blocked=true;break;}
        let packed;try{packed=packMemoryBatch(selected,read,options);}catch(cause){
          const keys=new Set(selected.map(pipelineKey));
          await store.update(saved=>{for(const job of saved.jobs)if(keys.has(pipelineKey(job))){job.state='held';job.reason=codeOf(cause);}});continue;
        }
        if(!packed.fragments.length)break;
        const packedKeys=new Set(packed.fragments.map(fragment=>fragment.key));
        const changeKind=selected.find(job=>job.changeKind&&packedKeys.has(pipelineKey(job)))?.changeKind;
        batch={id:randomUUID(),...packed,...changeKind?{changeKind}:{},state:'pending',prepareAttempts:0,commitAttempts:0,createdAt:now(),nextAt:0};
        await store.update(saved=>{saved.batches.push(batch);for(const job of fragmentJobs(batch,indexJobs(saved.jobs))){job.batchId=batch.id;job.state='pending';}});
        jobs=store.snapshot(state=>fragmentJobs(batch,indexJobs(state.jobs)));
      }
      if(await process(batch,jobs)===false){blocked=true;break;}
    }
    return blocked;
  }
  async function wake({force=false}={}){
    if(stopped||!enabled)return snapshot();await ensureReady();
    // A native turn-end delivers both speakers before waking the queue, but
    // their metadata commits can still be pending. Pack the accepted cohort.
    await Promise.all([...registrations]);
    if(!pump){clear();pump=run(force).finally(()=>{pump=null;arm(reason?options.retryMs:0);});}
    await pump;return snapshot();
  }
  function recoverable(state){
    const allowed=jobs=>{
      try{for(const job of jobs)prove(job);return true;}catch{return false;}
    };
    const held=state.batches.filter(batch=>
      (batch.state==='held'&&batch.error!=='MEMORY_INTERRUPTED_REVIEW_REQUIRED')||
      (batch.state==='committed'&&batch.delivery==='held'));
    const index=held.length?indexJobs(state.jobs):null;
    return {batches:held.filter(batch=>allowed(fragmentJobs(batch,index))),
      jobs:state.jobs.filter(job=>job.state==='held'&&job.reason!=='MEMORY_TARGET_REQUIRED'&&job.reason!=='NO_SEMANTIC_TEXT'&&!job.batchId&&allowed([job]))};
  }
  async function recover(){
    await ensureReady();
    heldNotices=0;let after=0;
    while(!stopped){
      const page=raw.messageProjectionWork({consumer:'pipeline-v1',after,limit:24},{authorize:()=>!stopped&&access.ready});if(!page.length)break;
      for(const ref of page){after=ref.position;
        if(!access.validateMessage(ref.authorization)){heldNotices++;continue;}
        const receipt=await notify({...ref,sessionId:ref.authorization.source.sessionId,operation:'saved'});if(!receipt.accepted)heldNotices++;
      }
    }
    if(!stopped&&await store.read(state=>{
      const {batches,jobs}=recoverable(state);
      return batches.length>0||jobs.length>0;
    })){
      // Recheck live proofs and queue state after waiting for the writer.
      const unchanged=Symbol();
      try{
        await store.update(state=>{
          if(stopped)throw unchanged;
          const {batches,jobs}=recoverable(state);
          if(!batches.length&&!jobs.length)throw unchanged;
          for(const batch of batches){
            if(batch.state==='committed'){batch.delivery='pending';batch.deliveryAt=now();}
            else{batch.state=batch.prepared?'prepared':'pending';batch.nextAt=now();}
          }
          for(const job of jobs){job.state='pending';job.reason=null;}
        });
      }catch(cause){if(cause!==unchanged)throw cause;}
    }
    arm();return snapshot();
  }
  function resume(){
    if(stopped||!enabled)return Promise.resolve(snapshot());
    return resumeTask??=recover().finally(()=>{resumeTask=undefined;});
  }
  async function retry(batchId){
    if(enabled)await ensureReady();
    const {batch,jobs}=store.snapshot(state=>{
      const batch=state.batches.find(item=>item.id===batchId);
      return {batch,jobs:batch?fragmentJobs(batch,indexJobs(state.jobs)):[]};
    });
    if(!batch)throw error('MEMORY_BATCH_NOT_FOUND');
    const attempts=batch.prepared?batch.commitAttempts:batch.prepareAttempts;if(attempts>=options.maxAttempts)throw error('MEMORY_RETRY_EXHAUSTED');
    for(const job of jobs)prove(job);
    await store.update(state=>{const saved=state.batches.find(item=>item.id===batchId);saved.state=saved.prepared?'prepared':'pending';saved.nextAt=now();saved.error=null;});
    return wake({force:true});
  }
  async function markChange(sessionId,turn,{kind,topic}={}){
    if(!enabled||!['correction','decision','remember','topic'].includes(kind))return;
    await ensureReady();await store.update(state=>{for(const job of state.jobs)if(job.sessionId===sessionId&&job.state==='pending'&&!job.batchId){
      if(kind==='topic'&&job.turn<turn)job.boundary=true;
      if(job.turn===turn){if(kind!=='topic')job.important=true;if(typeof topic==='string'&&topic.length<=200)job.topic=topic;}
    }});arm();
  }
  async function suppressTurn({sessionId,turn,ownerSubject,project}){
    if(!enabled||stopped)return;
    await ensureReady();
    const matches=job=>job.sessionId===sessionId&&job.turn===turn&&job.ownerSubject===ownerSubject&&job.project===project;
    await store.update(state=>{
      const turns=state.suppressedTurns??=[];
      if(!turns.some(matches))turns.push({sessionId,turn,ownerSubject,project});
      for(const job of state.jobs)if(matches(job)&&!job.batchId&&!terminal.has(job.state)){
        job.state='superseded';job.reason='MEMORY_CONTROL';
      }
    });
    arm();
  }
  return {enabled,ready,notify,wake,resume,retry,markChange,suppressTurn,status:snapshot,
    async idle(){await readyTask;await Promise.allSettled([resumeTask,...registrations]);await store.idle();await pump;await Promise.allSettled([...deliveries.values()].map(item=>item.task));await store.idle();},
    async close(){if(stopped)return;stopped=true;clear();active?.controller.abort(error('MEMORY_PIPELINE_CLOSED'));for(const item of deliveries.values())item.controller.abort(error('MEMORY_PIPELINE_CLOSED'));
      await Promise.allSettled([resumeTask,...registrations]);await pump;await Promise.allSettled([...deliveries.values()].map(item=>item.task));await store.idle();},
  };
}

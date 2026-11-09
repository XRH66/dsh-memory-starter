import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {resolveConfig} from '../lib/config.js';
import {createMemoryPipeline} from '../lib/memory-pipeline.js';
import {createMemoryOrganizer} from '../lib/memory-organizer.js';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};

async function fixture(t,overrides={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-pipeline-')),file=path.join(directory,'pipeline.json'),memory=new RawMemoryStore(path.join(directory,'raw.sqlite'),{warn(){}});
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecall:false}),raw=createRawRecall({config,store:memory,ownerSubject:'owner'});
  const agent={session:{id:'session-qa'},status:'idle'},listeners=new Set(),made=[],prepared=[],committed=[];let clock=0,epoch='one',enabled=true,seq=0;
  const access={ready:true,validateMessage:grant=>enabled&&grant?.epoch===epoch,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
  const organizer={async prepare(input,context){prepared.push({input,target:context.target,id:context.batchId});return {items:[]};},async commit(value,context){committed.push({value,id:context.batchId});return {committed:true};}};
  function make(options={}){const value=createMemoryPipeline({file,raw,access,findAgent:id=>id===agent.session.id?agent:null,listAgents:()=>[agent],organizer,now:()=>clock,
    timers:{setTimeout(){return {unref(){}};},clearTimeout(){}},...overrides,...options});made.push(value);return value;}
  const pipeline=make();
  function save(patch={}){
    seq++;const messageId=patch.messageId??'message-'+seq,turn=patch.turn??seq,role=patch.role??'user';
    const text=patch.text??'虚构原文短句。';
    const source={ownerSubject:'owner',project:'main',sessionId:agent.session.id,messageId,role,sequence:seq,turn,rootTurn:turn,text,content:[{type:'text',text}],time:1000+seq,
      turnState:'completed',processingContext:{owner:'pipeline-v1',target:{provider:'original-provider',model:'original-model'}},...patch};
    source.authorization={id:'grant-'+seq,kind:'message-source',rootSessionId:agent.session.id,epoch,source:{sessionId:agent.session.id,messageId,role,sequence:seq,turn,rootTurn:turn}};
    return memory.messages.record(source,{authorize:()=>enabled});
  }
  t.after(async()=>{for(const item of made)await item.close();await raw.dispose();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  return {directory,file,memory,raw,agent,access,pipeline,make,save,prepared,committed,setTime:time=>{clock=time;},revoke(){enabled=false;for(const fn of listeners)fn();},reopen(){enabled=true;epoch='two';}};
}

test('eight completed turns count both roles once and produce one semantic batch without storing original bodies in queue metadata',async t=>{
  const f=await fixture(t);
  for(let turn=1;turn<=8;turn++){
    for(const role of ['user','assistant']){const saved=f.save({turn,role});await f.pipeline.notify(saved.notice);}
    if(turn<8){await f.pipeline.wake();assert.equal(f.prepared.length,0);}
  }
  await f.pipeline.wake();assert.equal(f.prepared.length,1);assert.equal(f.committed.length,1);assert.equal(f.prepared[0].input.sources.length,16);
  assert.equal(f.pipeline.status().completed,16);assert.equal((await fs.readFile(f.file,'utf8')).includes('虚构原文短句'),false);
});

test('a turn-end wake waits for accepted speaker registrations before packing the eighth turn',async t=>{
  const f=await fixture(t);
  for(let turn=1;turn<=7;turn++)for(const role of ['user','assistant'])await f.pipeline.notify(f.save({turn,role}).notice);
  await f.pipeline.notify(f.save({turn:8,role:'user'}).notice);
  const assistant=f.pipeline.notify(f.save({turn:8,role:'assistant'}).notice);
  await f.pipeline.wake();await assistant;
  assert.equal(f.prepared.length,1);assert.equal(f.prepared[0].input.sources.length,16);
  assert.equal(f.pipeline.status().completed,16);assert.equal(f.pipeline.status().pending,0);
});

test('scheduling one batch does not clone the full queue for each source fragment',async t=>{
  const fullQueueClones=[];
  for(const size of [2,16]){
    const f=await fixture(t);
    for(let n=0;n<size;n++)await f.pipeline.notify(f.save().notice);
    const clone=t.mock.method(globalThis,'structuredClone');
    try{
      await f.pipeline.wake({force:true});
      fullQueueClones.push(clone.mock.calls.filter(({arguments:[value]})=>value?.version===1&&Array.isArray(value.jobs)&&Array.isArray(value.batches)).length);
    }finally{clone.mock.restore();}
    assert.equal(f.prepared.length,1);
    assert.equal(f.prepared[0].input.sources.length,size);
  }
  assert.equal(fullQueueClones[1],fullQueueClones[0]);
});

test('a priority hint is recovered from completed originals if the process stopped before consuming notices',async t=>{
  const f=await fixture(t);
  const scope={ownerSubject:'owner',project:'main',sessionId:f.agent.session.id,turn:1};
  for(const role of ['user','assistant'])await f.pipeline.notify(f.save({turn:1,role,turnState:'pending'}).notice);
  await f.pipeline.wake();assert.equal(f.prepared.length,0);
  f.memory.messages.completeTurn({...scope,state:'completed',changeKind:'correction'},{authorize:()=>true});
  await f.pipeline.close();
  const recovered=f.make();
  await recovered.resume();
  await recovered.wake();
  assert.equal(f.prepared.length,1);
  assert.deepEqual(f.prepared[0].input.sources.map(source=>source.role),['user','assistant']);
  assert.equal(recovered.status().latestPriority.kind,'correction');
  assert.equal(recovered.status().latestPriority.state,'committed');
  await recovered.resume();await recovered.wake();assert.equal(f.prepared.length,1);
});

test('idle is ninety seconds and repeated new messages cannot postpone the five-minute scheduling attempt',async t=>{
  const f=await fixture(t);await f.pipeline.notify(f.save().notice);f.setTime(89_999);await f.pipeline.wake();assert.equal(f.prepared.length,0);
  f.setTime(90_000);await f.pipeline.wake();assert.equal(f.prepared.length,1);
  const g=await fixture(t);for(let time=0;time<300_000;time+=60_000){g.setTime(time);await g.pipeline.notify(g.save().notice);await g.pipeline.wake();assert.equal(g.prepared.length,0);}
  g.setTime(300_000);await g.pipeline.wake();assert.equal(g.prepared.length,1);
});

test('a chat stuck in running stops blocking background organizing after the stale window',async t=>{
  let calls=0;
  const f=await fixture(t,{organizer:{async prepare(){calls++;return {items:[]};},async commit(){return {committed:true};}}});
  await f.pipeline.notify(f.save().notice);f.agent.status='running';f.setTime(0);
  await f.pipeline.wake({force:true});assert.equal(calls,0);assert.equal(f.pipeline.status().waitingReason,'foreground-busy');
  f.setTime(599_000);await f.pipeline.wake({force:true});assert.equal(calls,0);
  f.setTime(600_000);await f.pipeline.wake({force:true});assert.equal(calls,1);assert.equal(f.pipeline.status().completed,1);
});

test('forced flush still yields to foreground work; a new chat never cancels an already dispatched organizer',async t=>{
  const entered=deferred(),release=deferred();let calls=0,signal;
  const f=await fixture(t,{organizer:{async prepare(_input,ctx){calls++;signal=ctx.signal;entered.resolve();await release.promise;return {items:[]};},async commit(){return {committed:true};}}});
  await f.pipeline.notify(f.save().notice);f.agent.status='running';await f.pipeline.wake({force:true});assert.equal(calls,0);assert.equal(f.pipeline.status().waitingReason,'foreground-busy');
  f.agent.status='idle';const running=f.pipeline.wake({force:true});await entered.promise;f.agent.status='running';
  assert.equal(signal.aborted,false);release.resolve();await running;assert.equal(f.pipeline.status().completed,1);
});

test('large originals are processed with bounded continued ranges and remain completely unchanged in the authority',async t=>{
  const f=await fixture(t),text='保留全部条件。'.repeat(2000),saved=f.save({text});await f.pipeline.notify(saved.notice);await f.pipeline.wake({force:true});
  assert.ok(f.prepared.length>1);assert.ok(f.prepared.every(batch=>batch.input.tokens<=4096));
  const fragments=f.prepared.flatMap(batch=>batch.input.sources);assert.equal(fragments.map(source=>source.text).join(''),text);
  assert.equal(fragments[0].range.start,0);for(let n=1;n<fragments.length;n++)assert.equal(fragments[n].range.start,fragments[n-1].range.end);
  assert.equal(f.memory.messages.get({ownerSubject:'owner',project:'main',id:saved.source.id}).text,text);
});

test('prepared semantic output survives commit failure and restart without a second generation or route change',async t=>{
  let generation=0,commits=0;
  const f=await fixture(t,{organizer:{async prepare(){generation++;return {items:[{content:'仅在私有准备结果中保存的内容'}]};},async commit(){commits++;throw Object.assign(Error('disk'),{code:'TEST_DISK_FAILURE'});}}});
  await f.pipeline.notify(f.save().notice);await f.pipeline.wake({force:true});assert.equal(f.pipeline.status().batches[0].state,'prepared');await f.pipeline.close();
  assert.equal(JSON.stringify(f.pipeline.status()).includes('仅在私有准备结果中保存的内容'),false);assert.ok((await fs.readFile(f.file,'utf8')).includes('仅在私有准备结果中保存的内容'));
  f.setTime(1000);let target;
  const recovered=f.make({organizer:{async prepare(){throw Error('must not generate again');},async commit(_value,ctx){commits++;target=ctx.target;return {committed:true};}}});
  await recovered.wake({force:true});assert.equal(generation,1);assert.equal(commits,2);assert.equal(recovered.status().completed,1);
  assert.deepEqual(target,{provider:'original-provider',model:'original-model'});
});

test('persisted original outbox recovers only the new owner, keeps the frozen route and acknowledges duplicate deliveries',async t=>{
  const f=await fixture(t),newSource=f.save(),oldSource=f.save({processingContext:{owner:'legacy',target:{provider:'old',model:'old'}}});
  assert.equal('text' in f.raw.messageReader({ownerSubject:'owner',project:'main'},{authorize:()=>true}).proof(newSource.source),false);
  await f.pipeline.resume();assert.equal(f.pipeline.status().jobs.length,1);assert.equal(f.pipeline.status().jobs[0].id,newSource.source.id);
  await f.pipeline.notify(newSource.notice);assert.equal(f.pipeline.status().jobs.length,1);
  assert.equal(f.raw.messageProjectionWork({consumer:'pipeline-v1'},{authorize:()=>true}).length,0);
  await f.pipeline.wake({force:true});assert.equal(f.prepared.length,1);assert.ok(!f.prepared[0].input.sources.some(source=>source.id===oldSource.source.id));
});

test('concurrent resumes share one original outbox scan and unchanged recovery keeps the durable revision',async t=>{
  const f=await fixture(t),saved=f.save();
  const outbox=t.mock.method(f.raw,'messageProjectionWork');
  const first=f.pipeline.resume(),second=f.pipeline.resume();
  assert.equal(first,second);
  await Promise.all([first,second]);
  assert.equal(outbox.mock.callCount(),2,'one non-empty page and one empty page');
  assert.deepEqual(f.pipeline.status().jobs.map(job=>job.id),[saved.source.id]);
  const revision=async()=>JSON.parse(await fs.readFile(f.file,'utf8')).revision;
  const registered=await revision();
  await f.pipeline.resume();
  assert.equal(await revision(),registered);

  const denied=t.mock.method(f.access,'validateMessage',()=>false);
  await f.pipeline.wake({force:true});
  assert.equal(f.pipeline.status().held,1);
  const held=await revision();
  await f.pipeline.resume();
  assert.equal(await revision(),held,'an unauthorized hold is not a state change');
  denied.mock.restore();
  await f.pipeline.resume();
  const restored=await revision();
  assert.notEqual(restored,held);
  assert.equal(f.pipeline.status().pending,1);
  await f.pipeline.resume();
  assert.equal(await revision(),restored);
  await f.pipeline.wake({force:true});
  assert.equal(f.pipeline.status().completed,1);
});

for(const change of ['revision','withdrawal','authorization']){
  test(`organizer stream checks every fragment without loading bodies and stops on a live ${change} change`,async t=>{
    const f=await fixture(t),saved=f.save({turn:1});
    const get=t.mock.method(f.memory.messages,'get'),proof=t.mock.method(f.memory.messages,'proof');
    const checks=[];
    let commits=0,afterChange;
    const organizer=createMemoryOrganizer({referenceReadLimit:0,entries:{forBatch(){return {};}},
      llm:{async *stream(){
        const reads=get.mock.callCount();
        let proofs=proof.mock.callCount();
        for(const part of ['{"items":', '[],"changes":']){
          yield {type:'text-delta',text:part};
          checks.push({reads:get.mock.callCount()-reads,proofs:proof.mock.callCount()-proofs});
          proofs=proof.mock.callCount();
        }
        if(change==='revision'){
          // Change the authority without sending a pipeline notification.
          const updated=f.save({turn:1,messageId:saved.source.messageId,text:'虚构修订。'});
          assert.equal(updated.source.id,saved.source.id);
          assert.equal(updated.source.revision,2);
        }else if(change==='withdrawal'){
          assert.equal(f.memory.messages.withdraw(saved.source,{authorize:()=>true}).operation,'withdrawn');
        }else t.mock.method(f.access,'validateMessage',()=>false);
        afterChange=get.mock.callCount();
        yield {type:'text-delta',text:'[]}'};
        yield {type:'finish',reason:{kind:'stop'}};
      }}});
    const pipeline=f.make({organizer:{...organizer,async commit(...args){commits++;return organizer.commit(...args);}}});
    await pipeline.notify(saved.notice);
    await pipeline.notify(f.save({turn:1,role:'assistant'}).notice);
    await pipeline.wake({force:true});
    assert.deepEqual(checks,[{reads:0,proofs:2},{reads:0,proofs:2}]);
    assert.equal(get.mock.callCount(),afterChange);
    assert.equal(commits,0);
    const [batch]=pipeline.status().batches;
    assert.equal(batch.state,'held');
    assert.equal(batch.hasPrepared,false);
    assert.equal(batch.error,change==='authorization'?'MEMORY_NOT_AUTHORIZED':'MEMORY_SOURCE_CHANGED');
  });
}

test('closing and reopening cannot reauthorize an in-flight original batch or accept an ignoring late generator',async t=>{
  const entered=deferred(),release=deferred();let commits=0;
  const f=await fixture(t,{organizer:{async prepare(){entered.resolve();await release.promise;return {items:[]};},async commit(){commits++;return {committed:true};}}});
  await f.pipeline.notify(f.save().notice);const work=f.pipeline.wake({force:true});await entered.promise;f.revoke();await work;f.reopen();release.resolve();
  await f.pipeline.resume();await f.pipeline.wake({force:true});assert.equal(commits,0);assert.equal(f.pipeline.status().held,1);
});

test('slow or failed vector delivery neither blocks later semantic batches nor replays generation and commit',async t=>{
  const entered=deferred(),release=deferred();let notifications=0;
  const f=await fixture(t,{onCommitted:async()=>{notifications++;if(notifications===1){entered.resolve();await release.promise;throw Object.assign(Error('vector'),{code:'TEST_VECTOR_UNAVAILABLE'});}}});
  await f.pipeline.notify(f.save().notice);await f.pipeline.wake({force:true});await entered.promise;
  await f.pipeline.notify(f.save().notice);await f.pipeline.wake({force:true});assert.equal(f.prepared.length,2);assert.equal(f.committed.length,2);
  release.resolve();await f.pipeline.idle();f.setTime(1000);await f.pipeline.wake();await f.pipeline.idle();
  assert.equal(f.prepared.length,2);assert.equal(f.committed.length,2);assert.equal(notifications,3);assert.equal(f.pipeline.status().deliveryPending,0);
});

test('unknown frozen targets stay held and cannot borrow the current caller route',async t=>{
  const f=await fixture(t);await f.pipeline.notify(f.save({processingContext:{owner:'pipeline-v1',target:null}}).notice);await f.pipeline.resume();await f.pipeline.wake({force:true});
  assert.equal(f.prepared.length,0);assert.equal(f.pipeline.status().jobs[0].reason,'MEMORY_TARGET_REQUIRED');
});

test('important change waits for the current full turn to end instead of running in front of the answer',async t=>{
  const f=await fixture(t),saved=f.save({turnState:'pending'});await f.pipeline.notify(saved.notice);await f.pipeline.markChange('session-qa',1,{kind:'remember'});
  await f.pipeline.wake();assert.equal(f.prepared.length,0);
  const notices=f.memory.messages.completeTurn({ownerSubject:'owner',project:'main',sessionId:'session-qa',turn:1,state:'completed'},{authorize:()=>true});
  for(const notice of notices)await f.pipeline.notify(notice);await f.pipeline.wake();assert.equal(f.prepared.length,1);
});

test('a large pending turn cannot be organized by a threshold, timer or forced flush before its completion event',async t=>{
  const f=await fixture(t),saved=f.save({turnState:'pending',text:'这是尚未回答完毕的长消息。'.repeat(1200)});
  await f.pipeline.notify(saved.notice);f.setTime(600000);await f.pipeline.wake({force:true});
  assert.equal(f.prepared.length,0);assert.equal(f.pipeline.status().completed,0);
  const notices=f.memory.messages.completeTurn({ownerSubject:'owner',project:'main',sessionId:'session-qa',turn:1,state:'interrupted'},{authorize:()=>true});
  for(const notice of notices)await f.pipeline.notify(notice);await f.pipeline.wake({force:true});
  assert.ok(f.prepared.length>0);assert.ok(f.prepared.every(batch=>batch.input.sources.every(source=>source.completion==='interrupted')));
});

test('exhausted failures stay paused across resume and explicit retry cannot reset the request allowance',async t=>{
  let calls=0;const f=await fixture(t,{organizer:{async prepare(){calls++;throw Object.assign(Error('provider'),{code:'TEST_PROVIDER_UNAVAILABLE'});},async commit(){throw Error('not prepared');}}});
  await f.pipeline.notify(f.save().notice);await f.pipeline.wake({force:true});f.setTime(1000);await f.pipeline.wake();f.setTime(3000);await f.pipeline.wake();
  assert.equal(calls,3);const batch=f.pipeline.status().batches[0];assert.equal(batch.state,'error');f.setTime(300000);await f.pipeline.resume();await f.pipeline.wake({force:true});assert.equal(calls,3);
  await assert.rejects(f.pipeline.retry(batch.id),{code:'MEMORY_RETRY_EXHAUSTED'});
  // Exhausted work is visible as held with its failure code, not as ordinary pending work.
  const status=f.pipeline.status();assert.equal(status.pending,0);assert.equal(status.held,1);
  assert.equal(status.jobs[0].reason,'TEST_PROVIDER_UNAVAILABLE');
});

test('a crash during generation is held until explicit retry and is never automatically charged again on resume',async t=>{
  let generations=0;
  const entered=deferred(),release=deferred();const f=await fixture(t,{organizer:{async prepare(){generations++;entered.resolve();await release.promise;return {items:[]};},async commit(){return {committed:true};}}});
  await f.pipeline.notify(f.save().notice);const work=f.pipeline.wake({force:true});await entered.promise;
  const diskAtCrash=await fs.readFile(f.file,'utf8');assert.equal(JSON.parse(diskAtCrash).batches[0].state,'running');
  await f.pipeline.close();await work;release.resolve();await fs.writeFile(f.file,diskAtCrash);
  const recovered=f.make();await recovered.ready();assert.equal(recovered.status().held,1,'interrupted job must be held immediately after restart');
  await recovered.resume();assert.equal(recovered.status().held,1,'ordinary resume must preserve interrupted job hold');await recovered.wake({force:true});
  assert.equal(generations,1);assert.equal(recovered.status().held,1);const batch=recovered.status().batches[0];assert.equal(batch.error,'MEMORY_INTERRUPTED_REVIEW_REQUIRED');
  await recovered.retry(batch.id);assert.equal(generations,2);assert.equal(recovered.status().completed,1);
  await recovered.resume();await recovered.wake({force:true});assert.equal(generations,2,'completed explicit retry must not generate again');
});

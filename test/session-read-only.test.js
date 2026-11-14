import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSessionMemory} from '../lib/session-memory.js';
import {createBridge} from '../lib/index.js';
import {resolveConfig} from '../lib/config.js';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {MEMORY_HANDOFF_SOURCE} from '../lib/memory-contract.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent,fakeLlm,runPreStep,directUser} from './helpers.js';

const ownerSubject='fixture-owner';
const logger={warn(){}};
const scope={ownerSubject,project:'main'};

async function fixture(t,overrides={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'session-read-only-'));
  const actors=new Map(),sessions=new Map();
  const agents={get:id=>actors.get(id),list:()=>[...actors.values()],isOwnedBy:()=>false};
  const options={directory,ownerSubject,agents,sessions:{get:id=>sessions.get(id)},logger};
  let access=await createSessionMemory(options);
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecallDbPath:path.join(directory,'raw.sqlite'),
    autoRecall:true,personalRecall:false,recentContext:true,maxTimelineEntries:0,maxIndexNotes:0,rawRecall:false,...overrides});
  await fs.mkdir(config.vaultPath,{recursive:true});
  const memory=memoryStore({project:'main'}),disposals=[];
  t.after(async()=>{
    for(const dispose of disposals.reverse())await dispose();
    access.close();
    await fs.rm(directory,{recursive:true,force:true});
  });
  function actor(id='session-read-only'){
    const events=[],denied=new Set(),restrictions=[];
    const agent=fakeAgent(id);
    Object.defineProperty(agent.session,'seq',{configurable:true,get:()=>events.length});
    agent.session.log=events;
    agent.session.snapshotEvents=(from=0,to=events.length)=>events.slice(from,to);
    agent.session.deriveMessages=()=>[];
    agent.status='idle';
    agent.ctx={tools:{
      restrict({deny=[]}={}){
        for(const name of deny)denied.add(name);
        restrictions.push([...deny]);
        return ()=>{for(const name of deny)denied.delete(name);};
      },
      view(){return {restrictableNames:new Set([...denied,'soften_memory','memory_search','memory_open','memory_recent'])};},
    }};
    agent.events=events;
    agent.denied=denied;
    agent.restrictions=restrictions;
    actors.set(id,agent);
    sessions.set(id,agent.session);
    return agent;
  }
  function emit(agent,type,data,bridge,{surfaceOp}={}){
    surfaceOp??=['user/message','assistant/message','system/message'].includes(type)?'append':undefined;
    const event={seq:agent.events.length,time:Date.now(),type,data,...surfaceOp===undefined?{}:{surfaceOp}};
    agent.events.push(event);
    assert.equal(access.observe(agent.session,event),true);
    bridge?.onSessionEvent(agent.session,event);
    return event;
  }
  function begin(agent,turn,bridge,text='READ_ONLY_USER_'+turn,id='u-'+turn){
    emit(agent,'turn/start',{turn},bridge);
    return emit(agent,'user/message',directUser(text,id),bridge);
  }
  function finish(agent,turn,bridge,text='READ_ONLY_ASSISTANT_'+turn){
    emit(agent,'assistant/message',{turn,message:{id:'a-'+turn,role:'assistant',
      source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text}]}},bridge);
    return emit(agent,'turn/end',{turn,reason:{kind:'completed'}},bridge);
  }
  function attachSurface(agent,bridge,{system=true}={}){
    if(system)emit(agent,'system/message',{turn:1,step:1,message:{id:'system-'+agent.session.id,role:'system',
      content:[{type:'text',text:'system prompt'}],source:{kind:'system-prompt'}}},undefined,{surfaceOp:'append'});
    const surface=()=>{
      let active=[];
      for(const event of agent.events){
        if(event.surfaceOp==='append')active.push(event.seq);
        else if(event.surfaceOp?.op==='replace'){
          active=active.filter(seq=>seq<event.surfaceOp.startSeq||seq>event.surfaceOp.endSeq);
          active.push(event.seq);
        }
      }
      return active;
    };
    Object.defineProperty(agent.session,'surface',{configurable:true,get:()=>({nodes:surface()})});
    agent.session.deriveEventMessage=event=>event.type==='user/message'?event.data:event.data?.message;
    agent.session.deriveMessages=()=>surface().map(seq=>agent.events[seq]).filter(Boolean)
      .map(event=>event.type==='user/message'?event.data:event.data?.message).filter(Boolean);
    agent.session.append=(type,data,options={})=>emit(agent,type,data,bridge,{surfaceOp:options.surfaceOp??'append'});
  }
  function bridge({raw,llm=fakeLlm('{"items":[],"changes":[]}'),extra={}}={}){
    const result=createBridge({config,tools:memory.tools,llm,access,findAgent:id=>actors.get(id),listAgents:()=>[...actors.values()],
      logger,semanticOrganizer:false,...raw?{rawRecallStore:raw}:{},...extra});
    disposals.push(()=>result.dispose());
    return result;
  }
  async function reload(){
    access.close();
    access=await createSessionMemory(options);
    return access;
  }
  return {directory,config,memory,actors,sessions,actor,emit,begin,finish,attachSurface,bridge,reload,
    get access(){return access;}};
}

function handoffMessages(agent){
  return agent.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE);
}

test('controller persists read-only independently from memory enablement',async t=>{
  const f=await fixture(t),agent=f.actor('session-read-only-controller');
  assert.equal(f.access.status(agent.session.id).readOnly,false);
  assert.equal(f.access.isReadOnly(agent.session.id),false);

  await f.access.set(agent.session.id,false);
  const saved=await f.access.setReadOnly(agent.session.id,true);
  assert.equal(saved.enabled,false);
  assert.equal(saved.readOnly,true);
  assert.equal(f.access.isReadOnly(agent.session.id),true);

  const file=path.join(f.directory,'management','session-memory','read-only.json');
  assert.deepEqual(JSON.parse(await fs.readFile(file,'utf8')),{version:1,sessions:[agent.session.id]});
  assert.deepEqual((await fs.readdir(path.dirname(file))).filter(name=>name.endsWith('.tmp')),[]);

  await f.reload();
  assert.equal(f.access.status(agent.session.id).enabled,false);
  assert.equal(f.access.status(agent.session.id).readOnly,true);
  assert.equal(f.access.isReadOnly(agent.session.id),true);
  await f.access.setReadOnly(agent.session.id,false);
  assert.equal((await f.reload()).isReadOnly(agent.session.id),false);
});

test('a read-only turn cannot admit originals, authorize sources, notify queues, complete handoff, observe targets or mark changes',async t=>{
  const f=await fixture(t,{recentContext:false,rawRecall:true});
  const agent=f.actor(),raw=new RawMemoryStore(f.config.rawRecallDbPath,logger);
  const organizer={async prepare(){throw Error('must not organize');},async commit(){throw Error('must not commit');}};
  const bridge=f.bridge({raw,extra:{semanticOrganizer:organizer,pipelineResources:()=>({allowed:false,reason:'fixture'})}});
  await bridge.waitForIdle();
  const handoffCalls=[],observedTargets=[];
  bridge.handoff.finish=async()=>{handoffCalls.push('finish');};
  bridge.handoff.failed=async()=>{handoffCalls.push('failed');};
  bridge.handoff.observeTarget=target=>observedTargets.push(target);
  const semantic=[],vector=[];
  const pipelineNotify=bridge.pipeline.notify.bind(bridge.pipeline);
  bridge.pipeline.notify=notice=>{semantic.push(notice);return pipelineNotify(notice);};
  bridge.vectors.notifyChanged=notice=>{vector.push(notice);return {accepted:true};};
  const before={
    raw:raw.messages.list(scope).sources.length,
    jobs:bridge.pipeline.status().jobs.length,
    handoff:await bridge.handoff.status(),
  };

  await f.access.set(agent.session.id,true);
  await f.access.setReadOnly(agent.session.id,true);
  const user=f.begin(agent,1,bridge,'READ_ONLY_ORIGINAL');
  const decision=await runPreStep(bridge,{agent,turn:1,messages:[user.data]});
  assert.ok(agent.denied.has('memory_mark_change'));
  assert.ok(agent.denied.has('soften_memory'));
  assert.ok(!decision.messages.some(message=>message.source?.kind==='dafeiyu-memory-control'));
  assert.throws(()=>bridge.memoryChangeTool.execute({kind:'remember'},{agent}),/只读/);
  await assert.rejects(bridge.markSoftened(agent.session.id,{softenedAt:new Date().toISOString(),permalink:'fixture'}),{code:'MEMORY_READ_ONLY'});
  await bridge.onRequest({agent,turn:1,step:1,signal:new AbortController().signal},
    async()=>({provider:'fixture',model:'fixture'}));
  f.finish(agent,1,bridge,'READ_ONLY_ANSWER');
  await bridge.waitForIdle();

  assert.equal(raw.messages.list(scope).sources.length,before.raw);
  assert.equal(bridge.pipeline.status().jobs.length,before.jobs);
  assert.deepEqual(await bridge.handoff.status(),before.handoff);
  assert.deepEqual(handoffCalls,[]);
  assert.deepEqual(observedTargets,[]);
  assert.deepEqual(semantic,[]);
  assert.deepEqual(vector,[]);
  const journal=await fs.readFile(path.join(f.directory,'management','session-memory','policy.json.grants.jsonl'),'utf8');
  assert.equal(journal.split('\n').filter(Boolean).some(line=>{
    const entry=JSON.parse(line);
    return entry.grant?.sessionId===agent.session.id&&['source','message-source'].includes(entry.grant?.kind);
  }),false);
});

test('read-only keeps prefetch, memory_search and first-turn handoff while suppressing the current turn',async t=>{
  const f=await fixture(t,{autoRecall:true,recentContext:true,rawRecall:true});
  const source=f.actor('session-read-source'),reader=f.actor('session-read-only-reader');
  const raw=new RawMemoryStore(f.config.rawRecallDbPath,logger),bridge=f.bridge({raw});
  f.attachSurface(source,bridge);
  f.attachSurface(reader,bridge,{system:false});
  await f.access.set(source.session.id,true);
  f.begin(source,1,bridge,'茶具使用的普通会话约定标记是 ORYX_TEA。','source-user');
  f.finish(source,1,bridge,'ORDINARY_SESSION_ANSWER');
  await bridge.waitForIdle();

  await f.access.set(reader.session.id,true);
  await f.access.setReadOnly(reader.session.id,true);
  f.emit(reader,'turn/start',{turn:1},bridge);
  const user=directUser('茶具使用什么约定？','reader-user');
  const decision=await bridge.onPreStep({agent:reader,turn:1,step:1,messages:[user],
    signal:new AbortController().signal},async()=>({kind:'enter',messages:[user]}));
  assert.equal(decision.messages[0].source?.kind,MEMORY_HANDOFF_SOURCE);
  assert.match(decision.messages[0].content[0].text,/ORYX_TEA/);
  assert.match(decision.messages[1].content[0].text,/茶具使用什么约定/);
  const prefetched=decision.messages.find(message=>message.source?.kind==='memory-prefetch');
  assert.ok(prefetched,JSON.stringify((await bridge.getMemoryRuntime()).searches));
  assert.match(prefetched.content[0].text,/ORYX_TEA/);

  const searched=await bridge.queryTools.find(tool=>tool.name==='memory_search')
    .execute({query:'ORYX_TEA'},{agent:reader,signal:new AbortController().signal});
  assert.ok(searched.records.some(record=>record.text.includes('ORYX_TEA')));

  const handoffBefore=await bridge.handoff.status();
  f.emit(reader,'step/start',{turn:1,step:1},bridge);
  await bridge.onRequest({agent:reader,turn:1,step:1,signal:new AbortController().signal},
    async()=>({provider:'fixture',model:'fixture'}));
  f.emit(reader,'system/message',{turn:1,step:1,message:{id:'system-'+reader.session.id,role:'system',
    content:[{type:'text',text:'system prompt'}],source:{kind:'system-prompt'}}},bridge);
  for(const message of decision.messages)f.emit(reader,'user/message',message,bridge);
  const handoffs=handoffMessages(reader);
  assert.equal(handoffs.length,1);
  assert.match(handoffs[0].content[0].text,/ORYX_TEA/);
  assert.deepEqual(reader.session.deriveMessages().slice(0,3).map(message=>message.source?.kind),
    ['system-prompt',MEMORY_HANDOFF_SOURCE,'user']);
  assert.deepEqual(await bridge.handoff.status(),handoffBefore);
  f.finish(reader,1,bridge,'READ_ONLY_READER_ANSWER');
  await bridge.waitForIdle();
  assert.equal(raw.messages.list(scope).sources.filter(item=>item.sessionId===reader.session.id).length,0);

  const second=f.begin(reader,2,bridge,'第二回合仍只读。','reader-user-2');
  const secondDecision=await bridge.onPreStep({agent:reader,turn:2,step:1,messages:[second.data],
    signal:new AbortController().signal},async()=>({kind:'enter',messages:[second.data]}));
  f.emit(reader,'step/start',{turn:2,step:1},bridge);
  await bridge.onRequest({agent:reader,turn:2,step:1,signal:new AbortController().signal},
    async()=>({provider:'fixture',model:'fixture'}));
  for(const message of secondDecision.messages)f.emit(reader,'user/message',message,bridge);
  assert.equal(handoffMessages(reader).length,1);
  f.finish(reader,2,bridge,'READ_ONLY_READER_ANSWER_2');
  await bridge.waitForIdle();
});

test('two concurrent read-only turns cannot retrieve each other',async t=>{
  const f=await fixture(t,{autoRecall:false,recentContext:false,rawRecall:false});
  const a=f.actor('session-read-only-a'),b=f.actor('session-read-only-b'),bridge=f.bridge();
  await f.access.set(a.session.id,true);
  await f.access.set(b.session.id,true);
  await f.access.setReadOnly(a.session.id,true);
  await f.access.setReadOnly(b.session.id,true);
  const userA=f.begin(a,1,bridge,'A_ONLY_PRIVATE_QUESTION','a-private'),userB=f.begin(b,1,bridge,'B_ONLY_PRIVATE_QUESTION','b-private');
  await Promise.all([
    runPreStep(bridge,{agent:a,turn:1,messages:[userA.data]}),
    runPreStep(bridge,{agent:b,turn:1,messages:[userB.data]}),
  ]);
  const [searchA,searchB]=await Promise.all([
    bridge.queryTools.find(tool=>tool.name==='memory_search').execute({query:'B_ONLY_PRIVATE_QUESTION'},{agent:a,signal:new AbortController().signal}),
    bridge.queryTools.find(tool=>tool.name==='memory_search').execute({query:'A_ONLY_PRIVATE_QUESTION'},{agent:b,signal:new AbortController().signal}),
  ]);
  assert.equal(searchA.records.some(record=>record.text.includes('B_ONLY_PRIVATE_QUESTION')),false);
  assert.equal(searchB.records.some(record=>record.text.includes('A_ONLY_PRIVATE_QUESTION')),false);
  f.finish(a,1,bridge,'A_ONLY_PRIVATE_ANSWER');
  f.finish(b,1,bridge,'B_ONLY_PRIVATE_ANSWER');
  await bridge.waitForIdle();
  const raw=new RawMemoryStore(f.config.rawRecallDbPath,logger);
  try{assert.equal(raw.messages.list(scope).sources.length,0);}finally{raw.close();}
});

test('changing read-only during a turn takes effect on the next turn',async t=>{
  const f=await fixture(t,{autoRecall:false,recentContext:false,rawRecall:false});
  const agent=f.actor(),raw=new RawMemoryStore(f.config.rawRecallDbPath,logger),bridge=f.bridge({raw});
  await bridge.waitForIdle();
  await f.access.set(agent.session.id,true);

  f.begin(agent,1,bridge,'FIRST_WRITABLE');
  await f.access.setReadOnly(agent.session.id,true);
  f.finish(agent,1,bridge,'FIRST_WRITABLE_ANSWER');
  await bridge.waitForIdle();
  assert.equal(raw.messages.list(scope).sources.length,2);

  f.begin(agent,2,bridge,'SECOND_READ_ONLY');
  assert.ok(agent.denied.has('memory_mark_change'));
  assert.ok(agent.denied.has('soften_memory'));
  await f.access.setReadOnly(agent.session.id,false);
  assert.ok(agent.denied.has('soften_memory'));
  f.finish(agent,2,bridge,'SECOND_READ_ONLY_ANSWER');
  await bridge.waitForIdle();
  assert.equal(raw.messages.list(scope).sources.length,2);

  f.begin(agent,3,bridge,'THIRD_WRITABLE');
  assert.equal(agent.denied.has('memory_mark_change'),false);
  assert.equal(agent.denied.has('soften_memory'),false);
  f.finish(agent,3,bridge,'THIRD_WRITABLE_ANSWER');
  await bridge.waitForIdle();
  assert.equal(raw.messages.list(scope).sources.length,4);
});

test('a memory-disabled session keeps the marker without reading or writing memory',async t=>{
  const f=await fixture(t,{autoRecall:false,recentContext:false,rawRecall:false});
  const agent=f.actor(),bridge=f.bridge();
  await f.access.set(agent.session.id,false);
  await f.access.setReadOnly(agent.session.id,true);
  assert.equal(f.access.status(agent.session.id).enabled,false);
  assert.equal(f.access.status(agent.session.id).readOnly,true);

  const user=f.begin(agent,1,bridge,'DISABLED_READ_ONLY');
  const decision=await runPreStep(bridge,{agent,turn:1,messages:[user.data]});
  f.finish(agent,1,bridge,'DISABLED_READ_ONLY_ANSWER');
  await bridge.waitForIdle();
  assert.deepEqual(decision.messages,[]);
  await assert.rejects(fs.access(f.config.rawRecallDbPath),{code:'ENOENT'});
  const files=await fs.readdir(f.config.vaultPath,{recursive:true});
  assert.deepEqual(files.filter(file=>file.endsWith('.md')),[]);
});

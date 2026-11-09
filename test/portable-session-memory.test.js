import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSessionMemory} from '../lib/session-memory.js';
import {createBridge} from '../lib/index.js';
import {createPersonalMemoryRuntime} from '../lib/personal-runtime.js';
import {authorizedTools} from '../lib/worker.js';
import {resolveConfig} from '../lib/config.js';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent,fakeLlm,runPreStep,directUser} from './helpers.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const USER='我今后改用青瓷杯喝茶，这是新的独立约定。';
const logger={warn(){}};
async function fixture(t,overrides={}) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'portable-session-memory-'));
  const actors=new Map(),sessions=new Map();
  const agents={get:id=>actors.get(id),list:()=>[...actors.values()],isOwnedBy:()=>false};
  const options={directory,ownerSubject:'用户',agents,sessions:{get:id=>sessions.get(id)},logger};
  let access=await createSessionMemory(options);
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecallDbPath:path.join(directory,'raw.sqlite'),autoRecall:false,personalRecall:false,recentContext:false,maxTimelineEntries:0,maxIndexNotes:0,rawRecall:false,...overrides});
  await fs.mkdir(config.vaultPath,{recursive:true});
  const memory=memoryStore({project:'main'});
  const disposals=[];
  t.after(async()=>{for(const close of disposals.reverse())await close();access.close();await fs.rm(directory,{recursive:true,force:true});});
  function actor(id='session-primary') {
    const events=[],agent=fakeAgent(id);
    Object.defineProperty(agent.session,'seq',{get:()=>events.length});
    agent.session.snapshotEvents=(from=0,to=events.length)=>events.slice(from,to);
    agent.session.deriveMessages=()=>[directUser('CLOSED_USER_ECHO','old-user'),{role:'assistant',content:[{type:'text',text:'CLOSED_ASSISTANT_ECHO'}]}];
    agent.events=events;actors.set(id,agent);sessions.set(id,agent.session);return agent;
  }
  function emit(agent,type,data,bridge) {
    const event={seq:agent.events.length,time:Date.now(),type,data,...['user/message','assistant/message'].includes(type)?{surfaceOp:'append'}:{}};
    agent.events.push(event);assert.equal(access.observe(agent.session,event),true);bridge?.onSessionEvent(agent.session,event);return event;
  }
  function begin(agent,turn,bridge){emit(agent,'turn/start',{turn},bridge);return emit(agent,'user/message',directUser(USER,'u-'+turn),bridge);}
  function finish(agent,turn,bridge){emit(agent,'assistant/message',{turn,message:{id:'a-'+turn,role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'CLOSED_ASSISTANT_ECHO 好，我记住了。'}]}},bridge);emit(agent,'turn/end',{turn,reason:{kind:'completed'}},bridge);}
  function bridge(llm=fakeLlm('{"actions":[]}'),extra={}) {
    // These cases retain the legacy per-turn writer as a compatibility seam.
    // The default mounted batch organizer is covered by the pipeline integration.
    const result=createBridge({config,tools:memory.tools,llm,access,findAgent:id=>actors.get(id),logger,semanticOrganizer:false,...extra});
    disposals.push(()=>result.dispose());return result;
  }
  return {directory,config,memory,actor,emit,begin,finish,bridge,disposals,get access(){return access;},async reload(){access.close();access=await createSessionMemory(options);},source(agent,event,turn){return {sessionId:agent.session.id,sourceMessageId:event.data.id,sourceEventSeq:event.seq,turn};}};
}

test('explicit access is lazy: default-off initialization and tools never acquire or warm the old backend',async t=>{
  const f=await fixture(t,{recentContext:true}),agent=f.actor();let acquisitions=0;
  const personal=await createPersonalMemoryRuntime({directory:f.directory,config:f.config,access:f.access,acquireMemory:async()=>{acquisitions++;return {tools:f.memory.tools};},llm:fakeLlm('{"actions":[]}'),findAgent:id=>id===agent.session.id?agent:null,logger});
  f.disposals.push(()=>personal.close());assert.ok(personal.dsh);assert.equal(acquisitions,0);
  const tool=personal.memory.tools.get('mcp__basic_memory__read_note',agent);assert.ok(tool);
  await assert.rejects(tool.execute({project:'main'},{agent}));
  const event=f.begin(agent,1,personal.dsh);await runPreStep(personal.dsh,{turn:1,agent,messages:[event.data]});f.finish(agent,1,personal.dsh);await personal.dsh.waitForIdle();
  assert.equal(acquisitions,0);assert.equal(f.memory.tools.calls.length,0);
  await assert.rejects(fs.access(personal.recentStore.file),{code:'ENOENT'});
  await assert.rejects(fs.access(f.config.rawRecallDbPath),{code:'ENOENT'});
});

test('management and retained helpers cannot silently query the legacy hybrid model after unified vectors take ownership',async t=>{
  const f=await fixture(t,{rawRecall:true}),agent=f.actor();let args,opens=0;
  const tools={get(name){return {name,async execute(input){args=input;return {content:[{type:'text',text:'{}'}]};}};}};
  const runtime=await createPersonalMemoryRuntime({directory:f.directory,config:f.config,access:f.access,llm:fakeLlm('{"items":[],"changes":[]}'),
    acquireMemory:async()=>{opens++;return {tools};},findAgent:id=>id===agent.session.id?agent:null,listAgents:()=>[agent],logger});
  f.disposals.push(()=>runtime.close());
  assert.equal(f.access.check(agent).allowed,false);await runtime.dsh.getMemoryRuntime();assert.equal(opens,0);
  await runtime.memory.tools.forManagement(()=>{}).get('mcp__basic_memory__search_notes',agent).execute({project:'main',query:'虚构',search_type:'hybrid'},{agent});
  assert.equal(args.search_type,'text');assert.equal(f.access.check(agent).allowed,false);
  assert.equal(runtime.dsh.getRawRecallStatus().vectorOwner,'unified');
});

test('native message commits save both message bodies immediately without vector or semantic generation',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),agent=f.actor();
  const raw=new RawMemoryStore(f.config.rawRecallDbPath,logger),llm=fakeLlm('{"actions":[]}');
  let embeddingCalls=0;const bridge=f.bridge(llm,{rawRecallStore:raw,rawRecallEmbedder:{prepare(){embeddingCalls++;throw Error('must not prepare');},dispose(){}}});
  const notices=[];bridge.messageSources.subscribe(notice=>notices.push(notice));
  await f.access.set(agent.session.id,true);f.emit(agent,'turn/start',{turn:1},bridge);
  const text='  这是保留空白的测试原话。\n',user=f.emit(agent,'user/message',directUser(text,'whole-user'),bridge);
  const scope={ownerSubject:'用户',project:'main'};
  assert.equal(raw.messages.list(scope).sources.length,1);
  assert.equal(raw.messages.list(scope).sources[0].text,text);
  assert.equal(embeddingCalls,0);assert.equal(llm.calls.length,0);
  const body=[{type:'text',text:'CLOSED_ASSISTANT_ECHO 是当前新回复。'}];
  const content=[{type:'reasoning',text:'qa-only-reasoning'},{...body[0],extra:'qa-only-extra'},
    {type:'image',url:'qa-only://saved-reference'},{type:'tool-call',name:'search',input:'qa-only-search'},
    {type:'tool-result',text:'qa-only-result'}];
  const assistant=f.emit(agent,'assistant/message',{turn:1,interrupted:true,message:{id:'whole-assistant',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content}},bridge);
  assert.equal(raw.messages.list(scope).sources.length,2);
  const saved=raw.messages.list(scope).sources.find(source=>source.role==='assistant');
  assert.deepEqual(saved.content,body);assert.equal(saved.messageState,'interrupted');
  assert.equal(raw.db.prepare('SELECT core_json FROM raw_message_versions WHERE id=?').get(saved.id).core_json.includes('qa-only'),false);
  bridge.onSessionEvent(agent.session,user);bridge.onSessionEvent(agent.session,assistant);
  assert.equal(raw.messages.list(scope).sources.length,2);assert.equal(notices.length,2);
  f.emit(agent,'turn/end',{turn:1,reason:{kind:'cancelled'}},bridge);await bridge.waitForIdle();
  assert.ok(raw.messages.list(scope).sources.every(source=>source.turnState==='interrupted'));
  const page=bridge.messageSources.forAgent(agent).list({});
  assert.equal(page.sources.length,2);assert.ok(page.sources.every(source=>!('authorization' in source)));
  await assert.rejects(fs.access(bridge.recentContext.file),{code:'ENOENT'});
  assert.ok(page.sources.every(source=>source.turnState==='interrupted'));
  assert.deepEqual(new Set(page.sources.map(source=>source.role)),new Set(['user','assistant']));
  assert.equal(page.sources.find(source=>source.role==='user').text,text);assert.ok(raw.searchText('当前新回复',{scope:'用户'}).length>0);
  assert.equal(notices.length,4);assert.ok(notices.every(notice=>!('text' in notice)&&!('authorization' in notice)));
  assert.equal(embeddingCalls,0);assert.equal(llm.calls.length,0);assert.equal(bridge.messageSources.status().lastError,null);
});

test('raw commits notify vector and semantic consumers independently of delay and failure',async t=>{
  const f=await fixture(t,{rawRecall:true,autoCapture:false}),agent=f.actor(),warnings=[];
  const bridge=f.bridge(undefined,{logger:{warn:message=>warnings.push(message)}});
  const pending=deferred(),semantic=[],vector=[];
  bridge.pipeline.notify=notice=>{
    semantic.push(notice.id);
    if(semantic.length===1)return pending.promise.then(()=>{throw Error('semantic registration failed');});
  };
  bridge.vectors.notifyChanged=notice=>{
    vector.push(notice.id);
    if(vector.length===2)throw Error('vector registration failed');
  };
  await f.access.set(agent.session.id,true);
  f.begin(agent,1,bridge);
  const [source]=bridge.messageSources.forAgent(agent).list({}).sources;
  pending.resolve();
  assert.deepEqual(vector,[source.id],'vector notification is delivered while semantic registration is still pending');
  f.finish(agent,1,bridge);
  await bridge.waitForIdle();
  assert.equal(vector.length,4);
  assert.deepEqual(semantic,vector);
  assert.ok(warnings.some(message=>message.includes('semantic registration failed')));
  assert.ok(warnings.some(message=>message.includes('vector registration failed')));
  assert.ok(bridge.messageSources.forAgent(agent).list({}).sources.every(item=>item.turnState==='completed'));
});

test('closing before projections preserves committed original but cancels old reads and does not backfill the closed interval',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),agent=f.actor(),raw=new RawMemoryStore(f.config.rawRecallDbPath,logger);
  const bridge=f.bridge(undefined,{rawRecallStore:raw}),scope={ownerSubject:'用户',project:'main'};
  await f.access.set(agent.session.id,true);const committed=f.begin(agent,1,bridge),reader=bridge.messageSources.forAgent(agent);
  assert.equal(raw.messages.list(scope).sources.length,1);
  await f.access.set(agent.session.id,false);f.finish(agent,1,bridge);await bridge.waitForIdle();
  assert.equal(raw.messages.list(scope).sources.length,1);assert.throws(()=>reader.list({}));
  await assert.rejects(fs.access(bridge.recentContext.file),{code:'ENOENT'});
  f.begin(agent,2,bridge);f.finish(agent,2,bridge);
  await f.access.set(agent.session.id,true);f.begin(agent,3,bridge);
  bridge.onSessionEvent(agent.session,committed);f.finish(agent,3,bridge);await bridge.waitForIdle();
  const sources=raw.messages.list(scope).sources;
  assert.equal(sources.length,3);assert.deepEqual(new Set(sources.map(source=>source.turn)),new Set([1,3]));
  assert.equal(sources.filter(source=>source.role==='assistant').length,1);
  assert.equal(bridge.messageSources.forAgent(agent).list({}).sources.length,3);
  assert.throws(()=>bridge.messageSources.forAgent({...agent}));
});

test('restart repairs unfinished text projections from original proofs without reviving the old recent cache',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),agent=f.actor(),raw=new RawMemoryStore(f.config.rawRecallDbPath,logger);
  raw.archiveTurn=()=>{throw Error('fixture text projection unavailable');};
  const first=f.bridge(undefined,{rawRecallStore:raw}),scope={ownerSubject:'用户',project:'main'};
  await f.access.set(agent.session.id,true);f.begin(agent,1,first);f.finish(agent,1,first);await first.waitForIdle();
  const unfinished=raw.messages.projectionWork({...scope,consumer:'raw-text-v1'});
  assert.equal(unfinished.length,2);assert.ok(unfinished.every(ref=>!('text' in ref)&&ref.error==='fixture text projection unavailable'));
  const events=raw.messages.changes(scope).length;
  await first.dispose();await f.reload();
  const llm=fakeLlm('{"actions":[]}'),restored=f.bridge(llm);await restored.waitForIdle();
  await assert.rejects(fs.access(restored.recentContext.file),{code:'ENOENT'});
  const read=new RawMemoryStore(f.config.rawRecallDbPath,logger);
  try{
    assert.equal(read.messages.projectionWork({...scope,consumer:'raw-text-v1'}).length,0);
    assert.equal(read.messages.projectionWork({...scope,consumer:'recent-v1'}).length,2);
    const sources=read.messages.list(scope).sources;
    assert.deepEqual(new Set(sources.map(source=>source.role)),new Set(['user','assistant']));
    assert.ok(sources.every(source=>source.turnState==='completed'));
    assert.equal(read.messages.changes(scope).length,events);
  }finally{read.close();}
  assert.equal(llm.calls.length,0);assert.equal(restored.messageSources.status().lastError,null);
  assert.equal(restored.messageSources.status().recovery.restored,2);
});

test('request hook injects one handoff only after a change, reuses HTTP retries and retains it on later normal turns',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),a=f.actor(),b=f.actor('session-next');let connection='qa-connection-one';
  const bridge=f.bridge(undefined,{resolveChatConnection:()=>({connection,coverage:'fixture'})});
  const injected=[];
  for(const agent of [a,b])agent.session.append=(type,data,options)=>{
    assert.equal(type,'user/message');assert.equal(options.surfaceOp,'append');
    const event=f.emit(agent,type,data,bridge);injected.push(event);return event;
  };
  async function request(agent,turn){return bridge.onRequest({agent,turn,step:1,signal:new AbortController().signal},async()=>({provider:'fixture',model:'fixture'}));}
  await f.access.set(a.session.id,true);let user=f.begin(a,1,bridge);await runPreStep(bridge,{agent:a,turn:1,messages:[user.data]});await request(a,1);f.finish(a,1,bridge);await bridge.waitForIdle();
  assert.equal(injected.length,0);
  await f.access.set(b.session.id,true);user=f.begin(b,1,bridge);await runPreStep(bridge,{agent:b,turn:1,messages:[user.data]});await request(b,1);
  assert.equal(injected.length,1);assert.ok(JSON.stringify(injected[0]).includes(USER));
  const id=injected[0].data.id;await request(b,1);assert.equal(injected.length,1);
  f.finish(b,1,bridge);await bridge.waitForIdle();
  user=f.begin(b,2,bridge);await runPreStep(bridge,{agent:b,turn:2,messages:[user.data]});await request(b,2);assert.equal(injected.length,1);
  f.finish(b,2,bridge);await bridge.waitForIdle();
  connection='qa-connection-two';user=f.begin(b,3,bridge);await runPreStep(bridge,{agent:b,turn:3,messages:[user.data]});await request(b,3);assert.equal(injected.length,2);
  f.emit(b,'turn/end',{turn:3,reason:{kind:'error'}},bridge);await bridge.waitForIdle();
  user=f.begin(b,4,bridge);await runPreStep(bridge,{agent:b,turn:4,messages:[user.data]});await request(b,4);assert.equal(injected.length,3);
  assert.notEqual(injected.at(-1).data.id,id);
  assert.ok(!bridge.messageSources.forAgent(b).list({}).sources.some(source=>source.content.some(block=>block.text?.includes('<memory_handoff>'))));
});

test('closing during handoff preparation removes pending memory additions and still admits the actual user message',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),a=f.actor(),b=f.actor('session-close-during-handoff'),bridge=f.bridge();
  let appends=0;
  for(const agent of [a,b])agent.session.append=(type,data)=>{appends++;return f.emit(agent,type,data,bridge);};
  async function prepare(agent,turn,user){return bridge.onPreStep({agent,turn,step:1,messages:[user.data],signal:new AbortController().signal},async()=>({kind:'enter',messages:[user.data]}));}
  const request=(agent,turn)=>bridge.onRequest({agent,turn,step:1,signal:new AbortController().signal},async()=>({provider:'fixture',model:'fixture'}));
  await f.access.set(a.session.id,true);let user=f.begin(a,1,bridge);await prepare(a,1,user);await request(a,1);f.finish(a,1,bridge);await bridge.waitForIdle();
  await f.access.set(b.session.id,true);user=f.begin(b,1,bridge);const decision=await prepare(b,1,user);
  assert.ok(decision.messages.some(message=>message.source?.kind==='dafeiyu-memory-control'));
  const entered=deferred(),release=deferred(),original=bridge.handoff.prepared;
  bridge.handoff.prepared=async(...args)=>{await original(...args);entered.resolve();await release.promise;};
  const running=request(b,1);await entered.promise;await f.access.set(b.session.id,false);release.resolve();await running;
  assert.equal(appends,0);assert.deepEqual(decision.messages,[user.data]);
});

test('structured writers use original message proofs while later authorized chats can read already committed notes',async t=>{
  const f=await fixture(t,{autoCapture:false}),a=f.actor(),b=f.actor('session-other-entry-reader'),bridge=f.bridge();
  await f.access.set(a.session.id,true);f.begin(a,1,bridge);
  const source=bridge.messageSources.forAgent(a).list({}).sources[0],refs=[{id:source.id,revision:source.revision}],writer=bridge.entries.forBatch(a,refs);
  const input={operationId:'native-proof-entry',proposed:{type:'preference',content:'QA虚构偏好：用青瓷杯喝茶。',subject_ref:'u1',source_refs:['s1'],state:{validity:'current',progress:null},tags:['测试'],importance:null},sources:new Map([['s1',source]]),subjects:new Map([['u1','用户']])};
  const saved=await writer.commit(input);assert.equal(saved.state,'committed');
  await f.access.set(b.session.id,true);f.begin(b,1,bridge);
  assert.throws(()=>bridge.entries.forBatch(b,refs),{code:'MEMORY_NOT_AUTHORIZED'});
  await f.access.set(a.session.id,false);
  await assert.rejects(writer.commit({...input,operationId:'late-write'}),{code:'MEMORY_NOT_AUTHORIZED'});
  const record=await bridge.entries.forAgent(b).read(saved.id);assert.equal(record.content,input.proposed.content);assert.equal(record.sourceStatus.eligible,true);
  await f.access.set(a.session.id,true);f.begin(a,2,bridge);
  assert.throws(()=>bridge.entries.forBatch(a,refs),{code:'MEMORY_NOT_AUTHORIZED'});
  assert.equal(f.memory.notes.size,1);
});

test('native pre-step does not presearch; an explicit memory tool can read before the user source is committed',async t=>{
  const f=await fixture(t,{autoRecall:true}),agent=f.actor();await f.access.set(agent.session.id,true);
  let searches=0;
  const tools={get(name,owner){const tool=f.memory.tools.get(name,owner);if(name!=='mcp__basic_memory__search_notes')return tool;return {...tool,async execute(args,exec){searches++;return tool.execute(args,exec);}};}};
  const bridge=f.bridge(undefined,{tools});f.emit(agent,'turn/start',{turn:1},bridge);
  assert.equal(agent.events.some(event=>event.type==='user/message'),false);
  await runPreStep(bridge,{turn:1,agent,messages:[directUser('我喜欢什么杯子？','pending-user')]});
  assert.equal(searches,0);assert.equal(bridge.getQueryState(agent.session.id),null);
  const result=await bridge.queryTools.find(tool=>tool.name==='memory_search').execute({query:'杯子'},{agent,signal:new AbortController().signal});
  assert.ok(searches>0);assert.equal(result.budget.calls,1);assert.equal((await bridge.getRecoveryState()).jobs.length,0);
  f.emit(agent,'turn/end',{turn:1,reason:{kind:'completed'}},bridge);assert.equal(bridge.getQueryState(agent.session.id),null);
});

test('a delayed recall result is discarded after close and reopen rather than using the new epoch',async t=>{
  const f=await fixture(t,{autoRecall:true}),agent=f.actor();await f.access.set(agent.session.id,true);
  const entered=deferred(),release=deferred();
  const tools={get(name,owner){const tool=f.memory.tools.get(name,owner);if(name!=='mcp__basic_memory__search_notes')return tool;return {...tool,async execute(args,exec){entered.resolve();await release.promise;return tool.execute(args,exec);}};}};
  const bridge=f.bridge(undefined,{tools});const user=f.begin(agent,1,bridge);
  await runPreStep(bridge,{turn:1,agent,messages:[user.data]});
  const pending=bridge.queryTools.find(tool=>tool.name==='memory_search').execute({query:'青瓷杯'},{agent,signal:new AbortController().signal});await entered.promise;
  await f.access.set(agent.session.id,false);await f.access.set(agent.session.id,true);f.begin(agent,2);
  release.resolve();const result=await pending;assert.equal(result.status,'denied');assert.deepEqual(result.records,[]);
});

test('authorized tool checks both before execution and after asynchronous return',async t=>{
  const f=await fixture(t),agent=f.actor();await f.access.set(agent.session.id,true);f.begin(agent,1);
  const grant=f.access.grant(agent),entered=deferred(),release=deferred();let calls=0;
  const tools=authorizedTools({get:()=>({async execute(){calls++;entered.resolve();await release.promise;return 'late';}})},f.access,grant,agent);
  const pending=tools.get('read',agent).execute({}, {agent});await entered.promise;await f.access.set(agent.session.id,false);await f.access.set(agent.session.id,true);f.begin(agent,2);release.resolve();await assert.rejects(pending);assert.equal(calls,1);
  await assert.rejects(tools.get('write',agent).execute({}, {agent}));assert.equal(calls,1);
});

test('the new batch owner consumes real committed source proofs and P02 writes without running the old per-turn generator',async t=>{
  const f=await fixture(t),agent=f.actor(),llm=fakeLlm('{"actions":[]}');let bridge,preparedTarget;
  bridge=f.bridge(llm,{semanticOrganizer:{
    async prepare(input,context){
      preparedTarget=context.target;
      assert.deepEqual(input.sources.map(source=>source.role),['user','assistant']);
      return {refs:input.sources.map(({id,revision})=>({id,revision})),proposed:{type:'preference',content:'QA虚构偏好：改用青瓷杯喝茶。',subject_ref:'u',source_refs:['s0'],state:{validity:'current',progress:null},tags:['QA'],importance:null}};
    },
    async commit(result,context){
      const writer=bridge.entries.forBatch(context.agent,result.refs),saved=await writer.commit({operationId:context.batchId+':0',proposed:result.proposed,
        sources:new Map(result.refs.map((ref,index)=>['s'+index,ref])),subjects:new Map([['u','用户']])});
      return {committed:saved.state==='committed',entries:[{id:saved.id,revision:saved.revision}]};
    },
  }});
  await f.access.set(agent.session.id,true);const user=f.begin(agent,1,bridge);await runPreStep(bridge,{turn:1,agent,messages:[user.data]});f.finish(agent,1,bridge);await bridge.waitForIdle();
  const sources=bridge.messageSources.forAgent(agent).list({}).sources;assert.equal(sources.length,2);assert.ok(sources.every(source=>source.processingContext.owner==='pipeline-v1'));
  const frozen=sources[0].processingContext.target;agent.options={provider:'another-provider',model:'another-model'};
  await bridge.pipeline.wake({force:true});await bridge.waitForIdle();await bridge.retryPending({force:true});
  assert.equal(llm.calls.length,0);assert.equal(f.memory.notes.size,1);assert.equal(bridge.pipeline.status().completed,2);assert.deepEqual(preparedTarget,frozen);
  assert.equal((await bridge.getRecoveryState()).jobs.length,0);assert.equal(bridge.pipeline.status().batches[0].state,'committed');
});

test('the default mounted organizer waits for eight full turns, yields to chatting and writes once through P02',async t=>{
  const f=await fixture(t),agent=f.actor();
  const llm=fakeLlm(JSON.stringify({items:[{type:'preference',content:'用户今后使用青瓷杯喝茶。',subject_ref:'p1',source_refs:['s1'],
    state:{validity:'current',progress:null},tags:['杯具'],importance:null,evidence_basis:'self_report',speaker_ref:'p1'}],changes:[]}));
  const bridge=f.bridge(llm,{semanticOrganizer:undefined,listAgents:()=>[agent]});assert.equal(bridge.pipeline.enabled,true);
  await f.access.set(agent.session.id,true);agent.status='running';
  for(let turn=1;turn<=8;turn++){
    const user=f.begin(agent,turn,bridge);await runPreStep(bridge,{turn,agent,messages:[user.data]});f.finish(agent,turn,bridge);
  }
  await bridge.waitForIdle();assert.equal(llm.calls.length,0,'foreground work retains execution capacity');
  agent.status='idle';await bridge.pipeline.wake();await bridge.waitForIdle();
  assert.equal(llm.calls.length,1);assert.equal(llm.calls[0].purpose,'memory-capture');
  assert.equal(f.memory.notes.size,1);assert.equal(bridge.pipeline.status().completed,16);
  const prompt=JSON.parse(llm.calls[0].messages[0].content[0].text);assert.equal(prompt.sources.length,16);
  assert.deepEqual([...new Set(prompt.sources.map(source=>source.role))].sort(),['assistant','user']);
  await bridge.pipeline.resume();await bridge.pipeline.wake({force:true});assert.equal(llm.calls.length,1);
  assert.equal((await bridge.getRecoveryState()).jobs.length,0,'old writer never owns the batch');
});

test('the foreground memory signal is scoped to its completed authorized turn',async t=>{
  const f=await fixture(t),agent=f.actor();
  const llm=fakeLlm('{"items":[],"changes":[]}');
  const bridge=f.bridge(llm,{semanticOrganizer:undefined,listAgents:()=>[agent]});
  const mark=kind=>bridge.memoryChangeTool.execute({kind},{agent});
  await f.access.set(agent.session.id,true);agent.status='running';
  const begin=async turn=>{const event=f.begin(agent,turn,bridge);await runPreStep(bridge,{turn,agent,messages:[event.data]});};

  await begin(1);
  assert.equal(mark('remember').duplicate,false);
  assert.equal(mark('remember').duplicate,true);
  assert.throws(()=>mark('topic'),/类型无效/);
  await bridge.pipeline.wake({force:true});assert.equal(llm.calls.length,0);
  f.finish(agent,1,bridge);agent.status='idle';
  await bridge.pipeline.wake();
  assert.equal(llm.calls.length,1);
  assert.equal(bridge.pipeline.status().latestPriority.kind,'remember');

  agent.status='running';await begin(2);mark('correction');
  f.emit(agent,'turn/end',{turn:2,reason:{kind:'cancelled'}},bridge);
  agent.status='idle';await bridge.pipeline.wake();
  assert.equal(llm.calls.length,1);
  assert.equal(bridge.pipeline.status().jobs.find(job=>job.turn===2).changeKind,undefined);

  agent.status='running';await begin(3);mark('decision');
  await f.access.set(agent.session.id,false);
  assert.throws(()=>mark('decision'),/授权/);
  f.finish(agent,3,bridge);agent.status='idle';
  await f.access.set(agent.session.id,true);await begin(4);f.finish(agent,4,bridge);
  await bridge.pipeline.wake();
  assert.equal(llm.calls.length,1);
  assert.ok(bridge.pipeline.status().jobs.filter(job=>job.turn>=3).every(job=>!job.changeKind));
});

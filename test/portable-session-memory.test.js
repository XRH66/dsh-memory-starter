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
import {MEMORY_HANDOFF_SOURCE} from '../lib/memory-contract.js';
import {recentContextFile} from '../lib/recent-context.js';
import {ANSWER_RULES} from '../lib/memory-query.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent,fakeLlm,runPreStep,directUser,toolVaultBackend} from './helpers.js';

const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const USER='我今后改用青瓷杯喝茶，这是新的独立约定。';
const logger={warn(){}};
const notesIn=(memory,directory)=>[...memory.notes.values()].filter(note=>note.directory===directory);
function assertTopicPage(memory,label){
  const note=notesIn(memory,'chats/topics').find(item=>item.title===label);
  assert.ok(note,'missing topic page: '+label);
  assert.equal(note.filePath,'chats/topics/'+label+'.md');
  assert.deepEqual(note.frontmatter,{title:label,type:'note',tags:['dsh-topic'],embed:false});
  assert.equal(note.content,'# '+label+'\n\n本页由记忆框架自动维护，可在下方自由补充\n');
}
async function fixture(t,overrides={}) {
  const {isOwnedBy=()=>false,...configOverrides}=overrides;
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'portable-session-memory-'));
  const actors=new Map(),sessions=new Map();
  const agents={get:id=>actors.get(id),list:()=>[...actors.values()],isOwnedBy};
  const options={directory,ownerSubject:'用户',agents,sessions:{get:id=>sessions.get(id)},logger,
    subagentMemory:configOverrides.subagentMemory===true};
  let access=await createSessionMemory(options);
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecallDbPath:path.join(directory,'raw.sqlite'),autoRecall:false,personalRecall:false,recentContext:false,maxTimelineEntries:0,maxIndexNotes:0,rawRecall:false,...configOverrides});
  await fs.mkdir(config.vaultPath,{recursive:true});
  const memory=memoryStore({project:'main'});
  const disposals=[];
  t.after(async()=>{for(const close of disposals.reverse())await close();access.close();await fs.rm(directory,{recursive:true,force:true});});
  function actor(id='session-primary') {
    const events=[],agent=fakeAgent(id);
    Object.defineProperty(agent.session,'seq',{get:()=>events.length});
    agent.session.log=events;
    agent.session.snapshotEvents=(from=0,to=events.length)=>events.slice(from,to);
    agent.session.deriveMessages=()=>[directUser('CLOSED_USER_ECHO','old-user'),{role:'assistant',content:[{type:'text',text:'CLOSED_ASSISTANT_ECHO'}]}];
    agent.events=events;actors.set(id,agent);sessions.set(id,agent.session);return agent;
  }
  function emit(agent,type,data,bridge,options={}) {
    const surfaceOp=Object.hasOwn(options,'surfaceOp')?options.surfaceOp:['user/message','assistant/message'].includes(type)?'append':undefined;
    const event={seq:agent.events.length,time:Date.now(),type,data,...surfaceOp===undefined?{}:{surfaceOp}};
    agent.events.push(event);assert.equal(access.observe(agent.session,event),true);bridge?.onSessionEvent(agent.session,event);return event;
  }
  function begin(agent,turn,bridge,text=USER,id='u-'+turn){emit(agent,'turn/start',{turn},bridge);return emit(agent,'user/message',directUser(text,id),bridge);}
  function finish(agent,turn,bridge,text='CLOSED_ASSISTANT_ECHO 好，我记住了。'){emit(agent,'assistant/message',{turn,message:{id:'a-'+turn,role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text}]}},bridge);emit(agent,'turn/end',{turn,reason:{kind:'completed'}},bridge);}
  function bridge(llm=fakeLlm('{"actions":[]}'),extra={}) {
    const result=createBridge({config,tools:memory.tools,llm,access,findAgent:id=>actors.get(id),logger,semanticOrganizer:false,...extra});
    disposals.push(()=>result.dispose());return result;
  }
  return {directory,config,memory,actor,emit,begin,finish,bridge,disposals,get access(){return access;},async reload(){access.close();access=await createSessionMemory(options);},source(agent,event,turn){return {sessionId:agent.session.id,sourceMessageId:event.data.id,sourceEventSeq:event.seq,turn};}};
}

function attachSurface(f,bridge,agent) {
  seedSystemHead(f,agent);
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
  agent.session.deriveEventMessage=event=>event.type==='user/message'?event.data:event.type==='assistant/message'?event.data.message:event.data?.message;
  agent.session.deriveMessages=()=>surface().map(seq=>agent.events.find(event=>event.seq===seq))
    .filter(Boolean).map(event=>event.type==='user/message'?event.data:event.data?.message).filter(Boolean);
  agent.session.append=(type,data,options={})=>f.emit(agent,type,data,bridge,{surfaceOp:options.surfaceOp??'append'});
}

function seedSystemHead(f,agent){
  if(agent.events[0]?.type==='system/message')return;
  f.emit(agent,'system/message',{
    turn:1,
    step:1,
    message:{
      id:'system-'+agent.session.id,
      role:'system',
      content:[{type:'text',text:'system prompt'}],
      source:{kind:'system-prompt'},
    },
  },undefined,{surfaceOp:'append'});
  agent.session.log=agent.events;
  agent.session.deriveEventMessage??=(event=>event.type==='user/message'?event.data:event.data?.message);
  if(!Object.getOwnPropertyDescriptor(agent.session,'surface')){
    Object.defineProperty(agent.session,'surface',{configurable:true,get:()=>({nodes:agent.events
      .filter(event=>event.surfaceOp==='append').map(event=>event.seq)})});
  }
}

test('explicit access is lazy: default-off initialization and a closed session never create stores or touch the Vault',async t=>{
  const f=await fixture(t,{recentContext:true}),agent=f.actor();
  const personal=await createPersonalMemoryRuntime({directory:f.directory,config:f.config,access:f.access,llm:fakeLlm('{"actions":[]}'),findAgent:id=>id===agent.session.id?agent:null,logger});
  f.disposals.push(()=>personal.close());assert.ok(personal.dsh);
  // No note tools are exposed any more: the core reads and writes the Vault directly.
  assert.equal(personal.memory.tools.get('mcp__basic_memory__read_note',agent),undefined);
  const event=f.begin(agent,1,personal.dsh);await runPreStep(personal.dsh,{turn:1,agent,messages:[event.data]});f.finish(agent,1,personal.dsh);await personal.dsh.waitForIdle();
  assert.deepEqual(await fs.readdir(f.config.vaultPath),[]);
  await assert.rejects(fs.access(recentContextFile(f.config)),{code:'ENOENT'});
  await assert.rejects(fs.access(f.config.rawRecallDbPath),{code:'ENOENT'});
});

test('retired organizer settings are ignored while originals continue to save',async t=>{
  const f=await fixture(t),agent=f.actor(),bridge=f.bridge(undefined,{config:{...f.config,autoCapture:true,
    captureProvider:'retired-provider',captureModel:'retired-model',organizerReasoningEffort:'high'}});
  await f.access.set(agent.session.id,true);
  f.begin(agent,1,bridge);
  f.finish(agent,1,bridge);
  await bridge.waitForIdle();
  assert.equal(bridge.pipeline,undefined);assert.equal(bridge.memoryChangeTool,undefined);
  assert.equal(bridge.messageSources.forAgent(agent).list({}).sources.length,2);
  const files=await fs.readdir(f.config.vaultPath,{recursive:true});
  assert.deepEqual(files.filter(file=>file.endsWith('.md')),[]);
});

test('unified vectors own retrieval without opening any session grant',async t=>{
  // The fresh cloud default with no model name yet: the runtime status must still load.
  const f=await fixture(t,{rawRecall:true}),agent=f.actor();assert.equal(f.config.rawRecallModel,'custom-api');
  const runtime=await createPersonalMemoryRuntime({directory:f.directory,config:f.config,access:f.access,llm:fakeLlm('{"items":[],"changes":[]}'),
    findAgent:id=>id===agent.session.id?agent:null,listAgents:()=>[agent],logger});
  f.disposals.push(()=>runtime.close());
  assert.equal(f.access.check(agent).allowed,false);await runtime.dsh.getMemoryRuntime();
  assert.equal(f.access.check(agent).allowed,false);
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
  await assert.rejects(fs.access(recentContextFile(f.config)),{code:'ENOENT'});
  assert.ok(page.sources.every(source=>source.turnState==='interrupted'));
  assert.deepEqual(new Set(page.sources.map(source=>source.role)),new Set(['user','assistant']));
  assert.equal(page.sources.find(source=>source.role==='user').text,text);assert.ok(raw.searchText('当前新回复',{scope:'用户'}).length>0);
  assert.equal(notices.length,4);assert.ok(notices.every(notice=>!('text' in notice)&&!('authorization' in notice)));
  assert.equal(embeddingCalls,0);assert.equal(llm.calls.length,0);assert.equal(bridge.messageSources.status().lastError,null);
});

test('raw commits keep notifying vector consumers when a notification fails',async t=>{
  const f=await fixture(t,{rawRecall:true,rawRecallModel:'BAAI/bge-small-zh-v1.5',autoCapture:false}),agent=f.actor(),warnings=[];
  const bridge=f.bridge(undefined,{logger:{warn:message=>warnings.push(message)}});
  const vector=[];
  bridge.vectors.notifyChanged=notice=>{
    vector.push(notice.id);
    if(vector.length===2)throw Error('vector registration failed');
  };
  await f.access.set(agent.session.id,true);
  f.begin(agent,1,bridge);
  const [source]=bridge.messageSources.forAgent(agent).list({}).sources;
  assert.deepEqual(vector,[source.id]);
  f.finish(agent,1,bridge);
  await bridge.waitForIdle();
  assert.equal(vector.length,4);
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
  await assert.rejects(fs.access(recentContextFile(f.config)),{code:'ENOENT'});
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
  await assert.rejects(fs.access(recentContextFile(f.config)),{code:'ENOENT'});
  const read=new RawMemoryStore(f.config.rawRecallDbPath,logger);
  try{
    assert.equal(read.messages.projectionWork({...scope,consumer:'raw-text-v1'}).length,0);
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
  seedSystemHead(f,a);seedSystemHead(f,b);
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

test('handoff excludes the current conversation, replaces old context and reuses an unchanged live delivery',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),a=f.actor(),b=f.actor('session-next'),bridge=f.bridge();
  attachSurface(f,bridge,a);attachSurface(f,bridge,b);
  const handoffs=agent=>agent.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE);
  const request=(agent,turn,model='fixture')=>bridge.onRequest({agent,turn,step:1,signal:new AbortController().signal},async()=>({provider:'fixture',model}));
  const openStep=(agent,turn)=>f.emit(agent,'step/start',{turn,step:1},bridge);
  const runRequest=async(agent,turn,model)=>{
    const user=f.begin(agent,turn,bridge,agent===a?'A_SELF_ORIGINAL_'+turn:'B_ONLY_ORIGINAL_'+turn,'u-'+turn);
    await runPreStep(bridge,{agent,turn,messages:[user.data]});openStep(agent,turn);await request(agent,turn,model);
    return user;
  };
  await f.access.set(a.session.id,true);await f.access.set(b.session.id,true);

  f.begin(b,1,bridge,'B_ONLY_OLD','b-old-user');
  f.finish(b,1,bridge,'B_ANSWER_OLD');
  await bridge.waitForIdle();

  await runRequest(a,1);
  assert.equal(handoffs(a).length,1);
  const firstId=handoffs(a)[0].id;
  f.finish(a,1,bridge);await bridge.waitForIdle();

  let user=f.begin(b,2,bridge,'B_ONLY_NEW','b-new-user');
  await runPreStep(bridge,{agent:b,turn:2,messages:[user.data]});openStep(b,2);await request(b,2);
  f.finish(b,2,bridge,'B_ANSWER_NEW');
  await bridge.waitForIdle();

  await runRequest(a,2);
  let messages=handoffs(a);
  assert.equal(messages.length,1);
  assert.notEqual(messages[0].id,firstId);
  assert.match(messages[0].content[0].text,/B_ONLY_NEW/);
  assert.match(messages[0].content[0].text,/B_ANSWER_NEW/);
  assert.doesNotMatch(messages[0].content[0].text,/A_SELF_ORIGINAL/);
  f.finish(a,2,bridge);await bridge.waitForIdle();

  f.emit(b,'turn/start',{turn:3},bridge);await runPreStep(bridge,{agent:b,turn:3,messages:[]});
  openStep(b,3);await request(b,3);f.emit(b,'turn/end',{turn:3,reason:{kind:'completed'}},bridge);await bridge.waitForIdle();

  await runRequest(a,3);
  assert.equal(handoffs(a).length,1);
  assert.equal(handoffs(a)[0].id,messages[0].id);
  await bridge.waitForIdle();
  let status=(await bridge.getMemoryStatus(a.session.id)).jobs.find(job=>job.turn===3)?.handoff;
  assert.equal(status?.state,'unchanged');
  f.finish(a,3,bridge);await bridge.waitForIdle();

  await runRequest(a,4,'fixture-next');
  assert.equal(handoffs(a).length,1);
  assert.equal(handoffs(a)[0].id,messages[0].id);
  await bridge.waitForIdle();
  status=(await bridge.getMemoryStatus(a.session.id)).jobs.find(job=>job.turn===4)?.handoff;
  assert.equal(status?.state,'unchanged');
});

test('handoff replacement failure is logged and still appends the new delivery',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),a=f.actor(),b=f.actor('session-next'),warnings=[];
  const bridge=f.bridge(undefined,{logger:{warn:message=>warnings.push(message)}});
  attachSurface(f,bridge,a);attachSurface(f,bridge,b);
  const handoffs=agent=>agent.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE);
  const request=(agent,turn)=>bridge.onRequest({agent,turn,step:1,signal:new AbortController().signal},async()=>({provider:'fixture',model:'fixture'}));
  await f.access.set(a.session.id,true);await f.access.set(b.session.id,true);

  f.begin(b,1,bridge,'B_REPLACE_OLD','b-old');f.finish(b,1,bridge,'B_REPLACE_OLD_ANSWER');await bridge.waitForIdle();
  let user=f.begin(a,1,bridge,'A_FIRST','a-first');await runPreStep(bridge,{agent:a,turn:1,messages:[user.data]});
  f.emit(a,'step/start',{turn:1,step:1},bridge);await request(a,1);assert.equal(handoffs(a).length,1);f.finish(a,1,bridge);await bridge.waitForIdle();

  user=f.begin(b,2,bridge,'B_REPLACE_NEW','b-new');await runPreStep(bridge,{agent:b,turn:2,messages:[user.data]});
  f.emit(b,'step/start',{turn:2,step:1},bridge);await request(b,2);f.finish(b,2,bridge,'B_REPLACE_NEW_ANSWER');await bridge.waitForIdle();
  user=f.begin(a,2,bridge,'A_SECOND','a-second');await runPreStep(bridge,{agent:a,turn:2,messages:[user.data]});
  await request(a,2);
  assert.equal(handoffs(a).length,2);
  assert.match(handoffs(a).at(-1).content[0].text,/B_REPLACE_NEW/);
  assert.ok(warnings.some(message=>message.startsWith('[memory-handoff] replace:')));
});

test('three consecutive deferred handoffs warn once per session and reset after a successful delivery',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false});
  const source=f.actor('session-deferral-source'),target=f.actor('session-deferral-target'),warnings=[];
  let connection='fixture';
  const dsh=f.bridge(undefined,{logger:{warn:message=>warnings.push(message)},resolveChatConnection:()=>({connection})});
  await f.access.set(source.session.id,true);await f.access.set(target.session.id,true);
  f.begin(source,1,dsh,'DEFERRAL_PRIVATE_ORIGINAL','deferral-source-user');f.finish(source,1,dsh,'DEFERRAL_PRIVATE_ANSWER');
  await dsh.waitForIdle();
  assert.ok(dsh.messageSources.forAgent(source).list({}).sources.some(source=>source.text==='DEFERRAL_PRIVATE_ORIGINAL'));
  const signal=new AbortController().signal;
  const states=[];
  const requestTurn=async turn=>{
    f.emit(target,'turn/start',{turn},dsh);
    const user=directUser('目标会话第 '+turn+' 轮','deferral-target-'+turn);
    await runPreStep(dsh,{agent:target,turn,step:1,messages:[user],signal},async()=>({kind:'enter',messages:[user]}));
    f.emit(target,'step/start',{turn,step:1},dsh);
    await dsh.onRequest({agent:target,turn,step:1,signal},async()=>({provider:'fixture',model:'fixture'}));
    const status=await dsh.getMemoryStatus(target.session.id);
    states.push({turn,handoff:status.jobs.at(-1)?.handoff});
  };
  const finishTurn=async turn=>{
    f.emit(target,'assistant/message',{turn,message:{id:'deferral-assistant-'+turn,role:'assistant',
      source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'fixture answer'}]}},dsh,{surfaceOp:undefined});
    f.emit(target,'turn/end',{turn,reason:{kind:'completed'}},dsh);await dsh.waitForIdle();
  };
  for(const turn of [1,2,3]){await requestTurn(turn);await finishTurn(turn);}
  await requestTurn(4);
  const deferredWarnings=()=>warnings.filter(message=>message.startsWith('[memory-handoff] deferred'));
  assert.equal(deferredWarnings().length,1);
  assert.match(deferredWarnings()[0],/session-deferral-target/);
  assert.match(deferredWarnings()[0],/consecutive=3/);
  assert.doesNotMatch(deferredWarnings()[0],/DEFERRAL_PRIVATE/);

  target.session.append=(type,data,options={})=>f.emit(target,type,data,dsh,{surfaceOp:options.surfaceOp??'append'});
  seedSystemHead(f,target);
  target.session.deriveMessages=()=>target.session.surface.nodes.map(seq=>target.session.log[seq])
    .filter(Boolean).map(target.session.deriveEventMessage).filter(Boolean);
  assert.equal(target.session.log[target.session.surface.nodes[0]].type,'system/message');
  await dsh.onRequest({agent:target,turn:4,step:1,signal},async()=>({provider:'fixture',model:'fixture'}));
  assert.equal(target.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE).length,1);
  await finishTurn(4);

  connection='fixture-two';
  f.begin(source,2,dsh,'DEFERRAL_PRIVATE_SECOND','deferral-source-next');f.finish(source,2,dsh,'DEFERRAL_PRIVATE_SECOND_ANSWER');
  await dsh.waitForIdle();
  Object.defineProperty(target.session,'surface',{configurable:true,get:()=>({nodes:[]})});
  for(const turn of [5,6,7]){await requestTurn(turn);await finishTurn(turn);}
  assert.equal(deferredWarnings().length,2,JSON.stringify(states));
  assert.match(deferredWarnings()[1],/consecutive=3/);
});

test('child-agent requests neither inject handoffs nor change the root conversation baseline',async t=>{
  const rootId='session-primary',childId='session-child';
  const f=await fixture(t,{recentContext:true,autoCapture:false,subagentMemory:true,
    isOwnedBy:(id,other)=>id===childId&&other.session.id===rootId});
  const root=f.actor(rootId),other=f.actor('session-other'),child=f.actor(childId),bridge=f.bridge();
  for(const agent of [root,other,child])attachSurface(f,bridge,agent);
  const request=(agent,turn)=>bridge.onRequest({agent,turn,step:1,signal:new AbortController().signal},async()=>({provider:'fixture',model:'fixture'}));
  const handoffs=agent=>agent.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE);
  await f.access.set(root.session.id,true);await f.access.set(other.session.id,true);

  f.begin(other,1,bridge,'OTHER_ORIGINAL','other-u1');f.finish(other,1,bridge,'OTHER_ANSWER');await bridge.waitForIdle();
  let user=f.begin(root,1,bridge,'ROOT_ORIGINAL','root-u1');await runPreStep(bridge,{agent:root,turn:1,messages:[user.data]});
  f.emit(root,'step/start',{turn:1,step:1},bridge);await request(root,1);assert.equal(handoffs(root).length,1);
  f.finish(root,1,bridge);await bridge.waitForIdle();
  const generation=(await bridge.handoff.status()).sessions[root.session.id].generation;

  user=f.begin(child,1,bridge,'CHILD_ORIGINAL','child-u1');await runPreStep(bridge,{agent:child,turn:1,messages:[user.data]});
  f.emit(child,'step/start',{turn:1,step:1},bridge);await request(child,1);
  assert.equal(handoffs(child).length,0);
  assert.equal((await bridge.handoff.status()).sessions[child.session.id],undefined);
  f.emit(child,'turn/end',{turn:1,reason:{kind:'completed'}},bridge);

  user=f.begin(root,2,bridge,'ROOT_SECOND','root-u2');await runPreStep(bridge,{agent:root,turn:2,messages:[user.data]});
  f.emit(root,'step/start',{turn:2,step:1},bridge);await request(root,2);
  assert.equal(handoffs(root).length,1);
  assert.equal((await bridge.handoff.status()).sessions[root.session.id].generation,generation);
});

test('subagent memory defaults off without changing prefetch or rules for the root conversation',async t=>{
  const rootId='session-primary',childId='session-child';
  const f=await fixture(t,{autoRecall:true,recentContext:true,isOwnedBy:(id,other)=>id===childId&&other.session.id===rootId});
  const root=f.actor(rootId),child=f.actor(childId),bridge=f.bridge();
  await f.access.set(root.session.id,true);
  const rootUser=f.begin(root,1,bridge,'我平时喜欢用什么杯子？','root-default-u1');
  const rootDecision=await runPreStep(bridge,{agent:root,turn:1,messages:[rootUser.data]});
  assert.ok(rootDecision.messages.some(message=>message.source?.kind==='memory-answer-rules'));
  f.finish(root,1,bridge);await bridge.waitForIdle();

  const before=(await bridge.getMemoryRuntime()).searches.length;
  const childUser=f.begin(child,1,bridge,'我平时喜欢用什么杯子？','child-default-u1');
  const childDecision=await runPreStep(bridge,{agent:child,turn:1,messages:[childUser.data]});
  assert.equal(f.access.check(child).allowed,false);
  assert.deepEqual(childDecision.messages,[]);
  assert.equal(childDecision.messages.some(message=>message.source?.kind==='memory-prefetch'),false);
  assert.equal((await bridge.getMemoryRuntime()).searches.length,before);
  f.finish(child,1,bridge);await bridge.waitForIdle();
});

test('explicit subagent memory restores read prefetch and rules while child output stays out of the original store',async t=>{
  const rootId='session-primary',childId='session-child';
  const f=await fixture(t,{autoRecall:true,recentContext:true,subagentMemory:true,
    isOwnedBy:(id,other)=>id===childId&&other.session.id===rootId});
  const root=f.actor(rootId),child=f.actor(childId),raw=new RawMemoryStore(f.config.rawRecallDbPath,logger),bridge=f.bridge(undefined,{rawRecallStore:raw});
  await f.access.set(root.session.id,true);
  f.begin(root,1,bridge,'根对话先建立一个已开启回合。','root-open-u1');
  f.finish(root,1,bridge);await bridge.waitForIdle();

  assert.equal(f.access.check(child).allowed,true);
  const before=(await bridge.getMemoryRuntime()).searches.length;
  const childUser=f.begin(child,1,bridge,'我平时喜欢用什么杯子？','child-open-u1');
  const childDecision=await runPreStep(bridge,{agent:child,turn:1,messages:[childUser.data]});
  assert.ok(childDecision.messages.some(message=>message.source?.kind==='memory-answer-rules'));
  assert.equal((await bridge.getMemoryRuntime()).searches.length,before+1);
  f.finish(child,1,bridge);await bridge.waitForIdle();
  const scope={ownerSubject:'用户',project:'main'};
  assert.equal(raw.messages.list(scope).sources.filter(source=>source.sessionId===child.session.id).length,0);
});

test('closing during handoff preparation removes pending memory additions and still admits the actual user message',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),a=f.actor(),b=f.actor('session-close-during-handoff'),bridge=f.bridge();
  attachSurface(f,bridge,a);attachSurface(f,bridge,b);
  let appends=0;
  for(const agent of [a,b])agent.session.append=(type,data)=>{appends++;return f.emit(agent,type,data,bridge);};
  async function prepare(agent,turn,user){return bridge.onPreStep({agent,turn,step:1,messages:[user.data],signal:new AbortController().signal},async()=>({kind:'enter',messages:[user.data]}));}
  const request=(agent,turn)=>bridge.onRequest({agent,turn,step:1,signal:new AbortController().signal},async()=>({provider:'fixture',model:'fixture'}));
  await f.access.set(a.session.id,true);let user=f.begin(a,1,bridge);await prepare(a,1,user);await request(a,1);f.finish(a,1,bridge);await bridge.waitForIdle();
  await f.access.set(b.session.id,true);user=f.begin(b,1,bridge);const decision=await prepare(b,1,user);
  assert.ok(decision.messages.some(message=>message.source?.kind==='memory-answer-rules'));
  const entered=deferred(),release=deferred(),original=bridge.handoff.prepared;
  bridge.handoff.prepared=async(...args)=>{await original(...args);entered.resolve();await release.promise;};
  const running=request(b,1);await entered.promise;await f.access.set(b.session.id,false);release.resolve();await running;
  assert.equal(appends,0);assert.deepEqual(decision.messages,[user.data]);
});

test('pre-step prefetch never spends the model query budget; an explicit memory tool can read before the user source is committed',async t=>{
  const f=await fixture(t,{autoRecall:true}),agent=f.actor();await f.access.set(agent.session.id,true);
  const bridge=f.bridge();f.emit(agent,'turn/start',{turn:1},bridge);
  assert.equal(agent.events.some(event=>event.type==='user/message'),false);
  await runPreStep(bridge,{turn:1,agent,messages:[directUser('我喜欢什么杯子？','pending-user')]});
  assert.equal(bridge.getQueryState(agent.session.id),null);
  const result=await bridge.queryTools.find(tool=>tool.name==='memory_search').execute({query:'杯子'},{agent,signal:new AbortController().signal});
  assert.equal(result.budget.calls,1);assert.equal(result.status,'empty');
  assert.equal(Object.hasOwn(result.channels,'legacy'),false);assert.equal(result.channels.structured,undefined);
  f.emit(agent,'turn/end',{turn:1,reason:{kind:'completed'}},bridge);assert.equal(bridge.getQueryState(agent.session.id),null);
});

test('a delayed recall result is discarded after close and reopen rather than using the new epoch',async t=>{
  const f=await fixture(t,{rawRecall:true,rawRecallModel:'BAAI/bge-small-zh-v1.5',autoRecall:false}),agent=f.actor();await f.access.set(agent.session.id,true);
  const entered=deferred(),release=deferred();
  const bridge=f.bridge(),user=f.begin(agent,1,bridge);
  assert.ok(bridge.vectors,'raw recall mounts the vector index');
  // Hold the search inside the vector lane: with the entry lane gone it is the awaited step of memory_search.
  bridge.vectors.getSnapshot=async()=>{entered.resolve();await release.promise;return null;};
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

test('a memory-enabled turn carries one merged answer-rules message',async t=>{
  const f=await fixture(t,{recentContext:true,autoCapture:false}),on=f.actor(),off=f.actor('session-answer-rules-off'),bridge=f.bridge();
  const prepare=(agent,turn,user)=>bridge.onPreStep({agent,turn,step:1,messages:[user.data],signal:new AbortController().signal},async()=>({kind:'enter',messages:[user.data]}));
  await f.access.set(on.session.id,true);
  const enabled=await prepare(on,1,f.begin(on,1,bridge));
  const rules=enabled.messages.filter(message=>message.source?.kind==='memory-answer-rules');
  assert.equal(rules.length,1);
  assert.match(rules[0].content[0].text,/^<memory_answer_rules>\n当前本地时间：.+\n回答涉及用户过去说过的事时：\n/u);
  assert.doesNotMatch(rules[0].content[0].text,/<memory_clock>/u);
  for(const rule of ANSWER_RULES)assert.ok(rules[0].content[0].text.includes(rule),rule);
  assert.ok(!enabled.messages.some(message=>message.source?.kind==='dafeiyu-memory-control'));
  const disabled=await prepare(off,1,f.begin(off,1,bridge));
  assert.ok(!(disabled.messages??[]).some(message=>message.source?.kind==='memory-answer-rules'));
});

test('softener rules join the same message only when the tool is available',async t=>{
  const f=await fixture(t,{autoCapture:false,recentContext:false}),agent=f.actor();
  const get=f.memory.tools.get.bind(f.memory.tools);
  const tools=new Proxy(f.memory.tools,{get(target,property){
    if(property==='get')return (name,owner)=>name==='soften_memory'?{execute:async()=>({ok:true})}:get(name,owner);
    const value=Reflect.get(target,property,target);return typeof value==='function'?value.bind(target):value;
  }});
  const bridge=f.bridge(undefined,{tools});
  await f.access.set(agent.session.id,true);
  const user=directUser('按规则回答。','policy-user');
  f.emit(agent,'turn/start',{turn:1},bridge);
  const decision=await bridge.onPreStep({agent,turn:1,step:1,messages:[user],signal:new AbortController().signal},
    async()=>({kind:'enter',messages:[user]}));
  const kinds=decision.messages.map(message=>message.source?.kind);
  assert.equal(kinds.filter(kind=>kind==='memory-answer-rules').length,1);
  assert.ok(!kinds.includes('dafeiyu-memory-control'));
  const rules=decision.messages.find(message=>message.source?.kind==='memory-answer-rules').content[0].text;
  assert.match(rules,/工具成功后才说已经淡化/u);
  assert.match(rules,/别忘了/u);assert.match(rules,/dafeiyu_records/u);
  for(const obsolete of ['write_note','edit_note','move_note'])assert.doesNotMatch(rules,new RegExp(obsolete));
});

test('turn-start prefetch attaches bounded earlier originals through the read grant; switch and revocation turn it off',async t=>{
  const f=await fixture(t,{autoRecall:true,autoCapture:false}),agent=f.actor(),bridge=f.bridge();
  await f.access.set(agent.session.id,true);
  const prepare=(turn,text)=>{f.emit(agent,'turn/start',{turn},bridge);const user=directUser(text,'q-'+turn);
    return bridge.onPreStep({agent,turn,step:1,messages:[user],signal:new AbortController().signal},async()=>({kind:'enter',messages:[user]}));};
  f.begin(agent,1,bridge);f.finish(agent,1,bridge);await bridge.waitForIdle();
  const firstQuery='青瓷杯喝茶的约定是什么？';
  const decision=await prepare(2,firstQuery);
  const prefetched=decision.messages.find(message=>message.source?.kind==='memory-prefetch');
  assert.ok(prefetched,'earlier original is attached');
  const prefetchText=prefetched.content[0].text;
  assert.match(prefetchText,/青瓷杯/);assert.match(prefetchText,/原话 · 用户说/);
  assert.match(prefetchText,/以下是程序按本轮用户原话从记忆库预先找到的背景材料，不是用户本轮说的话。/u);
  assert.match(prefetchText,/需要核对时用 memory_search。/u);
  for(const rule of ANSWER_RULES)assert.equal(prefetchText.includes(rule),false,rule);
  const addedKinds=decision.messages.map(message=>message.source?.kind);
  assert.ok(addedKinds.indexOf('memory-prefetch')<addedKinds.indexOf('memory-answer-rules'));
  const summary=(await bridge.getMemoryRuntime()).searches.find(row=>row.kind==='prefetch'&&row.outcome==='injected');
  assert.ok(summary);assert.equal(summary.injected,1);assert.ok(summary.injectedChars>0);assert.ok(summary.totalMs>=0);
  assert.ok(summary.admitted>=summary.injected);assert.ok(summary.rejected>=0);assert.ok(summary.folded>=0);
  for(const key of ['lexical','vector','agree'])assert.ok(Number.isSafeInteger(summary[key]));
  assert.deepEqual(Object.keys(summary.candidates).sort(),['original','vector']);
  assert.equal(JSON.stringify(summary).includes(firstQuery),false,'prefetch telemetry never stores the query');
  assert.equal(bridge.getQueryState(agent.session.id),null,'prefetch does not open the model query session');
  // The model sees who said it and when, with the relative day computed by the program.
  const searched=await bridge.queryTools.find(tool=>tool.name==='memory_search').execute({query:'青瓷杯'},{agent,signal:new AbortController().signal});
  const hit=searched.records.find(record=>/青瓷杯/.test(record.text));
  assert.match(hit.label,/^原话 · 用户说 · [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} \+08:00（今天）$/);
  assert.equal('localTime' in hit,false);
  f.emit(agent,'turn/end',{turn:2,reason:{kind:'completed'}},bridge);

  const small=f.bridge(undefined,{config:{...f.config,prefetchMaxChars:30}});
  f.emit(agent,'turn/start',{turn:3},small);const user=directUser('青瓷杯喝茶约定','q-3');
  const bounded=await small.onPreStep({agent,turn:3,step:1,messages:[user],signal:new AbortController().signal},async()=>({kind:'enter',messages:[user]}));
  const materials=bounded.messages.find(message=>message.source?.kind==='memory-prefetch')?.content[0].text.split('</memory_prefetch>')[0];
  const line=materials.split('\n').filter(row=>row.startsWith('- '));
  assert.ok(line.length>=1);assert.ok(line.join('').length<=30,JSON.stringify(line));
  f.emit(agent,'turn/end',{turn:3,reason:{kind:'completed'}},small);

  const off=f.bridge(undefined,{config:{...f.config,autoRecall:false}});
  f.emit(agent,'turn/start',{turn:4},off);const again=directUser('我现在用什么杯子喝茶？','q-4');
  const disabled=await off.onPreStep({agent,turn:4,step:1,messages:[again],signal:new AbortController().signal},async()=>({kind:'enter',messages:[again]}));
  assert.ok(!disabled.messages.some(message=>message.source?.kind==='memory-prefetch'));
  assert.ok(disabled.messages.some(message=>message.source?.kind==='memory-answer-rules'));
  const disabledSummary=(await off.getMemoryRuntime()).searches.find(row=>row.kind==='prefetch'&&row.outcome==='skipped');
  assert.equal(disabledSummary?.reason,'disabled');assert.equal(JSON.stringify(disabledSummary).includes('我现在用什么杯子喝茶'),false);
  f.emit(agent,'turn/end',{turn:4,reason:{kind:'completed'}},off);

  await f.access.set(agent.session.id,false);
  f.emit(agent,'turn/start',{turn:5},bridge);const closed=directUser('我现在用什么杯子喝茶？','q-5');
  const revoked=await bridge.onPreStep({agent,turn:5,step:1,messages:[closed],signal:new AbortController().signal},async()=>({kind:'enter',messages:[closed]}));
  assert.ok(!(revoked.messages??[]).some(message=>message.source?.kind==='memory-prefetch'));
});

test('prefetch and handoff omit rules while one standalone message carries them',async t=>{
  const f=await fixture(t,{autoRecall:true,recentContext:true,autoCapture:false});
  const source=f.actor('session-rules-source'),target=f.actor('session-rules-target'),bridge=f.bridge();
  attachSurface(f,bridge,target);
  await f.access.set(source.session.id,true);await f.access.set(target.session.id,true);
  f.begin(source,1,bridge,'另一个对话约定下周带蓝色雨伞。','rules-source-user');
  f.finish(source,1,bridge,'记得带蓝色雨伞。');
  f.begin(target,1,bridge,USER,'rules-target-history');
  f.finish(target,1,bridge,'记得青瓷杯的约定。');await bridge.waitForIdle();

  const user=f.begin(target,2,bridge,'青瓷杯喝茶的约定是什么？','rules-target-user');
  const decision=await bridge.onPreStep({agent:target,turn:2,step:1,messages:[user.data],
    signal:new AbortController().signal},async()=>({kind:'enter',messages:[user.data]}));
  const prefetched=decision.messages.find(message=>message.source?.kind==='memory-prefetch');
  assert.ok(prefetched);
  for(const rule of ANSWER_RULES)assert.equal(prefetched.content[0].text.includes(rule),false,rule);
  const rules=decision.messages.filter(message=>message.source?.kind==='memory-answer-rules');
  assert.equal(rules.length,1);
  assert.equal(rules[0].content[0].text.split(ANSWER_RULES[0]).length-1,1);
  assert.ok(decision.messages.indexOf(prefetched)<decision.messages.indexOf(rules[0]));

  f.emit(target,'step/start',{turn:2,step:1},bridge);
  await bridge.onRequest({agent:target,turn:2,step:1,signal:new AbortController().signal},
    async()=>({provider:'fixture',model:'fixture'}));
  const handoff=target.session.deriveMessages().find(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE);
  assert.ok(handoff);
  for(const rule of ANSWER_RULES)assert.equal(handoff.content[0].text.includes(rule),false,rule);
  assert.match(handoff.content[0].text,/计量：估算 tokens/u);
  f.finish(target,2,bridge);await bridge.waitForIdle();
});

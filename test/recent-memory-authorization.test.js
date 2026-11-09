import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRecentConversationStore,recentContextFile} from '../lib/recent-context.js';
import {resolveConfig} from '../lib/config.js';
import {createBridge} from '../lib/index.js';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {managementDirectory} from '../lib/review.js';
import {createSessionMemory} from '../lib/session-memory.js';
import {directUser,fakeAgent,runPreStep} from './helpers.js';

test('closing memory during a queued recent write leaves no disk or in-memory record',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'recent-auth-'));
  const store=createRecentConversationStore({config:resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),recentContext:true}),logger:{warn(){}}});
  await store.idle();
  let entered,release,allowed=true;
  const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const writeFile=fs.writeFile;
  fs.writeFile=async function(file,...args){
    const result=await writeFile.call(this,file,...args);
    if(String(file).startsWith(store.file+'.')&&String(file).endsWith('.tmp')){entered();await held;}
    return result;
  };
  try{
    const writing=store.record({sessionId:'session-fixture',turn:1,authorize:()=>allowed,user:{id:'u1',text:'不能迟到提交的原话',time:new Date().toISOString()}});
    await started;allowed=false;release();
    await assert.rejects(writing,{code:'MEMORY_AUTHORIZATION_REVOKED'});
    await assert.rejects(fs.access(store.file),{code:'ENOENT'});
    assert.equal((await store.page({maxChars:2000})).items.length,0);
  }finally{fs.writeFile=writeFile;release();await store.idle();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});}
});

async function handoffFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'handoff-sample-'));
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecallDbPath:path.join(directory,'raw.sqlite'),
    recentContext:true,rawRecall:false,autoCapture:false});
  const logger={warn(){}},agent=fakeAgent('session-handoff-sample'),events=[],appended=[];
  const findAgent=id=>id===agent.session.id?agent:undefined;
  Object.defineProperty(agent.session,'seq',{get:()=>events.length});
  agent.session.snapshotEvents=(from,to)=>events.slice(from,to);
  agent.session.deriveMessages=()=>appended.map(event=>event.data);
  const listCalls=[];
  async function openRuntime(){
    const access=await createSessionMemory({directory,ownerSubject:'fixture-owner',logger,
      agents:{get:findAgent,list:()=>[agent],isOwnedBy:()=>false},sessions:{get:id=>findAgent(id)?.session}});
    const raw=new RawMemoryStore(config.rawRecallDbPath,logger);
    const list=raw.messages.list.bind(raw.messages);
    raw.messages.list=input=>{listCalls.push(input);return list(input);};
    const bridge=createBridge({config,access,rawRecallStore:raw,findAgent,logger,semanticOrganizer:false,
      llm:{stream(){throw Error('handoff sample must not call a model');}}});
    await bridge.waitForIdle();
    return {access,raw,bridge};
  }
  let current=await openRuntime();
  async function closeRuntime(){await current.bridge.dispose();current.access.close();}
  t.after(async()=>{
    await closeRuntime();
    assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
    await fs.rm(directory,{recursive:true,force:true});
  });
  const emit=(type,data,dispatch=true)=>{
    const event={seq:events.length,time:Date.UTC(2026,10,8)+events.length*1000,type,data,surfaceOp:'append'};
    events.push(event);if(dispatch)current.bridge.onSessionEvent(agent.session,event);return event;
  };
  agent.session.append=(type,data)=>{const event=emit(type,data);appended.push(event);return event;};
  const scope={ownerSubject:'fixture-owner',project:'main'};
  const statusDir=path.join(managementDirectory(config),'memory-status');
  const runtime=JSON.parse(await fs.readFile(path.join(statusDir,'runtime.json'),'utf8'));
  const statsFile=runtime.recentContext.file;
  const readStats=async()=>JSON.parse(await fs.readFile(statsFile,'utf8')).stats;
  return {get access(){return current.access;},get bridge(){return current.bridge;},get raw(){return current.raw;},
    async restart(){await closeRuntime();current=await openRuntime();},
    agent,config,scope,emit,appended,listCalls,statsFile,readStats,runtime};
}

test('portable handoff samples only its existing first page and leaves the legacy cache and receipts alone',async t=>{
  const f=await handoffFixture(t),id=f.agent.session.id;
  const oldFile=recentContextFile(f.config),oldCache=createRecentConversationStore({config:f.config});
  await oldCache.record({sessionId:'session-legacy',turn:1,user:{id:'legacy',time:'2026-10-01T00:00:00Z',text:'LEGACY_BODY'}});
  const oldBytes=await fs.readFile(oldFile,'utf8');
  assert.notEqual(f.statsFile,oldFile);
  assert.equal(f.runtime.recentContext.source,'original-handoff-sample');
  assert.equal((await f.readStats()).sampledAt,null);

  await f.access.set(id,true);
  f.emit('turn/start',{turn:1});
  for(let n=0;n<25;n++)f.emit('user/message',directUser('FIXTURE_BODY '+n,'source-'+n));
  f.emit('user/message',directUser('REVISED_FIXTURE_BODY','source-24'));
  f.emit('turn/end',{turn:1,reason:{kind:'cancelled'}});
  await f.bridge.waitForIdle();
  assert.deepEqual(f.listCalls,[]);
  assert.equal((await f.readStats()).sampledAt,null);
  assert.equal(f.raw.messages.projectionWork({...f.scope,consumer:'raw-text-v1'}).length,0);
  const recentWork=f.raw.messages.projectionWork({...f.scope,consumer:'recent-v1',limit:40});
  assert.equal(recentWork.length,25,'the original mode neither projects nor marks the legacy consumer complete');

  f.emit('turn/start',{turn:2});
  await runPreStep(f.bridge,{agent:f.agent,turn:2});
  const request=()=>f.bridge.onRequest({agent:f.agent,turn:2,step:1},async()=>({provider:'fixture',model:'fixture'}));
  await request();
  await request();
  await f.bridge.waitForIdle();
  assert.deepEqual(f.listCalls.map(({limit,beforePosition})=>[limit,beforePosition===undefined]),[[24,true],[24,false]]);
  assert.equal(f.appended.length,1);
  const handoff=f.appended[0].data.content[0].text;
  assert.match(handoff,/revision=2[^\n]*interrupted\]\nREVISED_FIXTURE_BODY/);
  assert.match(handoff,/FIXTURE_BODY 0\n/,'the second page is still used by handoff');
  const stats=await f.readStats();
  assert.equal(stats.sampledMessages,24);
  assert.equal(stats.turns,1);
  assert.ok(Number.isFinite(Date.parse(stats.sampledAt)));
  assert.equal(stats.capacityTokens,null);
  assert.equal(stats.evictedTurns,null);
  assert.doesNotMatch(JSON.stringify(stats),/FIXTURE_BODY|LEGACY_BODY|session-handoff-sample/);
  assert.equal(await fs.readFile(oldFile,'utf8'),oldBytes);
});

test('portable restart resumes unfinished text work without rebuilding the old recent projection or sampling originals',async t=>{
  const f=await handoffFixture(t);
  await f.access.set(f.agent.session.id,true);
  f.emit('turn/start',{turn:1});
  await f.bridge.waitForIdle();
  const event=f.emit('user/message',directUser('RECOVERY_FIXTURE_BODY','recover-user'),false);
  const {source,grant}=f.access.admitMessage(f.agent.session,event);
  const {source:saved}=f.raw.messages.record(source,{authorize:()=>f.access.validateMessage(grant)});
  assert.equal(f.raw.messages.projectionWork({...f.scope,consumer:'raw-text-v1'}).length,1);
  await f.restart();
  assert.equal(f.bridge.messageSources.status().recovery.restored,1);
  assert.equal(f.raw.messages.projectionWork({...f.scope,consumer:'raw-text-v1'}).length,0);
  assert.equal(f.raw.messages.projectionWork({...f.scope,consumer:'recent-v1'}).length,1);
  assert.equal(f.raw.messages.get(saved).revision,saved.revision);
  assert.equal(f.raw.messages.changes(f.scope).length,1);
  assert.deepEqual(f.listCalls,[]);
  assert.equal((await f.readStats()).sampledAt,null);
  await assert.rejects(fs.access(recentContextFile(f.config)),{code:'ENOENT'});
});

test('revocation during sample persistence keeps the previous snapshot and does not replay the read',{timeout:5000},async t=>{
  const f=await handoffFixture(t),id=f.agent.session.id;
  await f.access.set(id,true);
  f.emit('turn/start',{turn:1});
  f.emit('user/message',directUser('REVOKED_FIXTURE_BODY','source-1'));
  await f.bridge.waitForIdle();
  const before=await fs.readFile(f.statsFile,'utf8');
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),held=new Promise(resolve=>{release=resolve;});
  const writeFile=fs.writeFile;
  fs.writeFile=async function(file,...args){
    const result=await writeFile.call(this,file,...args);
    if(String(file).startsWith(f.statsFile+'.')&&String(file).endsWith('.tmp')){entered();await held;}
    return result;
  };
  try{
    const reader=f.bridge.messageSources.forAgent(f.agent,{trackRecent:true});
    assert.equal(reader.list({limit:24}).sources.length,1);
    await started;
    await f.access.set(id,false);
    assert.throws(()=>reader.list({limit:24}),{code:'MEMORY_NOT_AUTHORIZED'});
  }finally{fs.writeFile=writeFile;release();await f.bridge.waitForIdle();}
  assert.equal(await fs.readFile(f.statsFile,'utf8'),before);
  assert.equal(f.listCalls.length,1);
  assert.equal((await fs.readdir(path.dirname(f.statsFile))).some(name=>name.endsWith('.tmp')),false);
});

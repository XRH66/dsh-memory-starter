import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zstdCompressSync, zstdDecompressSync} from 'node:zlib';
import {Context} from '@deepseek-ai/cordis';
import {Session, SessionStore} from '@deepseek-ai/dsh-session';
import {sessionFormatCatalog} from '@deepseek-ai/dsh-session-format-catalog';
import {createSessionMemory} from '../lib/session-memory.js';
import {createBridge} from '../lib/index.js';
import {resolveConfig} from '../lib/config.js';
import {MEMORY_HANDOFF_SOURCE} from '../lib/memory-contract.js';
import {directUser, fakeAgent} from './helpers.js';

const logger={warn(){}};

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'handoff-head-replay-'));
  const ctx=new Context(),store=new SessionStore(ctx),actors=new Map(),sessions=new Map();
  const agents={get:id=>actors.get(id),list:()=>[...actors.values()],isOwnedBy:()=>false};
  const actor=id=>{
    const session=store.prepare(id,{meta:{delegationDepth:0}});
    const agent=fakeAgent(id);agent.session=session;
    actors.set(id,agent);sessions.set(id,session);return agent;
  };
  const source=actor('session-handoff-source'),target=actor('session-handoff-target');
  const access=await createSessionMemory({directory:path.join(directory,'access'),ownerSubject:'用户',agents,sessions,logger});
  const config=resolveConfig({
    project:'main',
    vaultPath:path.join(directory,'vault'),
    autoCapture:false,
    autoRecall:false,
    personalRecall:false,
    recentContext:true,
    rawRecall:false,
    maxTimelineEntries:0,
    maxIndexNotes:0,
  });
  await fs.mkdir(config.vaultPath,{recursive:true});
  const bridge=createBridge({
    config,
    tools:{get:()=>null},
    llm:{stream(){throw Error('handoff replay fixture must not call a model');}},
    access,
    findAgent:id=>actors.get(id),
    logger,
  });
  t.after(async()=>{
    await bridge.dispose();
    await bridge.waitForIdle();
    access.close();
    assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
    await fs.rm(directory,{recursive:true,force:true});
  });
  const within=async(session,work)=>{
    const leave=store.enter(session);
    try{return await work();}finally{leave();}
  };
  const append=(agent,type,data,options)=>{
    const event=agent.session.append(type,data,options);
    assert.equal(access.observe(agent.session,event),true);
    bridge.onSessionEvent(agent.session,event);
    return event;
  };
  return {directory,source,target,access,bridge,within,append};
}

function systemEvent(agent,turn,step){
  return {
    turn,
    step,
    message:{
      id:'system-'+agent.session.id,
      role:'system',
      content:[{type:'text',text:'system prompt'}],
      source:{kind:'system-prompt'},
    },
  };
}

function assistantEvent(agent,turn,text){
  return {
    turn,
    step:1,
    stream:[],
    message:{
      id:'assistant-'+agent.session.id+'-'+turn,
      role:'assistant',
      content:[{type:'text',text}],
      source:{kind:'model',provider:'fixture',model:'fixture'},
    },
  };
}

async function strictReplay(directory,session){
  const rows=[
    sessionFormatCatalog.encodeCurrentHeader(session.header,session.inheritedEventCount),
    ...session.log.map(event=>sessionFormatCatalog.encodeCurrentEvent(event)),
  ];
  const file=path.join(directory,'session.v4.jsonl.zstd');
  await fs.writeFile(file,zstdCompressSync(Buffer.from(rows.map(row=>JSON.stringify(row)).join('\n')+'\n')));
  const decoded=zstdDecompressSync(await fs.readFile(file)).toString('utf8').trim().split('\n').map(row=>JSON.parse(row));
  const [header,...events]=decoded,restore=sessionFormatCatalog.createRestore(header,{recovery:'strict',validation:'current'});
  for(const event of events)restore.decodeRow(event);
  const artifact=restore.finish();
  return Session.fromRestore(session.id,artifact.events,artifact.header,artifact.inheritedEventCount,'detached');
}

test('first-turn handoff defers until a protected system head exists and strict v4 replay succeeds',async t=>{
  const f=await fixture(t);
  const signal=new AbortController().signal;
  await f.access.set(f.source.session.id,true);
  await f.within(f.source.session,async()=>{
    f.append(f.source,'turn/start',{turn:1});
    const user=directUser('只存在于另一个对话的原文','source-user');
    const decision=await f.bridge.onPreStep({agent:f.source,messages:[user],turn:1,step:1,signal},async()=>({kind:'enter',messages:[user]}));
    f.append(f.source,'step/start',{turn:1,step:1});
    f.append(f.source,'system/message',systemEvent(f.source,1,1),{surfaceOp:'append'});
    for(const message of decision.messages)f.append(f.source,'user/message',message,{surfaceOp:'append'});
    f.append(f.source,'assistant/message',assistantEvent(f.source,1,'另一个对话的回答'),{surfaceOp:'append'});
    f.append(f.source,'step/end',{turn:1,step:1});
    f.append(f.source,'turn/end',{turn:1,reason:{kind:'completed'}});
  });
  await f.bridge.waitForIdle();

  await f.access.set(f.target.session.id,true);
  await f.within(f.target.session,async()=>{
    f.append(f.target,'turn/start',{turn:1});
    const user=directUser('目标对话第一轮','target-user-1');
    const decision=await f.bridge.onPreStep({agent:f.target,messages:[user],turn:1,step:1,signal},async()=>({kind:'enter',messages:[user]}));
    f.append(f.target,'step/start',{turn:1,step:1});
    await f.bridge.onRequest({agent:f.target,turn:1,step:1,signal},async()=>({provider:'fixture',model:'fixture'}));
    f.append(f.target,'system/message',systemEvent(f.target,1,1),{surfaceOp:'append'});
    for(const message of decision.messages)f.append(f.target,'user/message',message,{surfaceOp:'append'});
    f.append(f.target,'assistant/message',assistantEvent(f.target,1,'第一轮回答'),{surfaceOp:'append'});
    f.append(f.target,'step/end',{turn:1,step:1});
    f.append(f.target,'turn/end',{turn:1,reason:{kind:'completed'}});
  });

  const firstTurnHandoffCount=f.target.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE).length;

  await f.within(f.target.session,async()=>{
    f.append(f.target,'turn/start',{turn:2});
    const user=directUser('目标对话第二轮','target-user-2');
    const decision=await f.bridge.onPreStep({agent:f.target,messages:[user],turn:2,step:1,signal},async()=>({kind:'enter',messages:[user]}));
    f.append(f.target,'step/start',{turn:2,step:1});
    await f.bridge.onRequest({agent:f.target,turn:2,step:1,signal},async()=>({provider:'fixture',model:'fixture'}));
    for(const message of decision.messages)f.append(f.target,'user/message',message,{surfaceOp:'append'});
    f.append(f.target,'assistant/message',assistantEvent(f.target,2,'第二轮回答'),{surfaceOp:'append'});
    f.append(f.target,'step/end',{turn:2,step:1});
    f.append(f.target,'turn/end',{turn:2,reason:{kind:'completed'}});
  });
  await f.bridge.waitForIdle();

  const handoffs=f.target.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE);
  assert.equal(handoffs.length,1);
  assert.match(handoffs[0].content[0].text,/只存在于另一个对话的原文/);
  const restored=await strictReplay(f.directory,f.target.session);
  assert.equal(firstTurnHandoffCount,0);
  assert.equal(restored.deriveMessages()[0].source.kind,'system-prompt');
  assert.equal(restored.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE).length,1);
});

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

async function fixture(t,{config:overrides={}}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'handoff-head-replay-'));
  const ctx=new Context(),store=new SessionStore(ctx),actors=new Map(),sessions=new Map();
  const warnings=[];
  const logger={warn(message){warnings.push(String(message));}};
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
    ...overrides,
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
  return {directory,source,target,access,bridge,within,append,warnings};
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

async function replayTurn(f,agent,{turn=1,text='目标对话',answer='回答',model='fixture',system=false}={}){
  const signal=new AbortController().signal;
  let decision;
  await f.within(agent.session,async()=>{
    f.append(agent,'turn/start',{turn});
    const user=directUser(text+'-'+turn,agent.session.id+'-user-'+turn);
    decision=await f.bridge.onPreStep({agent,messages:[user],turn,step:1,signal},async()=>({kind:'enter',messages:[user]}));
    f.append(agent,'step/start',{turn,step:1});
    await f.bridge.onRequest({agent,turn,step:1,signal},async()=>({provider:'fixture',model}));
    if(system)f.append(agent,'system/message',systemEvent(agent,turn,1),{surfaceOp:'append'});
    for(const message of decision.messages)f.append(agent,'user/message',message,{surfaceOp:'append'});
    f.append(agent,'assistant/message',assistantEvent(agent,turn,answer),{surfaceOp:'append'});
    f.append(agent,'step/end',{turn,step:1});
    f.append(agent,'turn/end',{turn,reason:{kind:'completed'}});
  });
  await f.bridge.waitForIdle();
  return decision;
}

const handoffMessages=agent=>agent.session.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE);

test('first-turn handoff is delivered after the protected system head and never repeats',async t=>{
  const f=await fixture(t);
  await f.access.set(f.source.session.id,true);
  await replayTurn(f,f.source,{text:'只存在于另一个对话的原文',answer:'另一个对话的回答',system:true});

  await f.access.set(f.target.session.id,true);
  const first=await replayTurn(f,f.target,{text:'目标对话第一轮',answer:'第一轮回答',system:true});
  const firstTurnHandoffCount=handoffMessages(f.target).length;
  assert.equal(first.messages.filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE).length,1);
  assert.equal(handoffMessages(f.target)[0].source.form,'handoff');
  assert.equal(f.target.session.deriveMessages()[0].source.kind,'system-prompt');
  assert.equal(f.target.session.deriveMessages()[1].source.kind,MEMORY_HANDOFF_SOURCE);

  const second=await replayTurn(f,f.target,{turn:2,text:'目标对话第二轮',answer:'第二轮回答',model:'fixture-next'});
  assert.equal(second.messages.some(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE),false);
  assert.equal(handoffMessages(f.target).length,1);
  const third=await replayTurn(f,f.target,{turn:3,text:'目标对话第三轮',answer:'第三轮回答',model:'fixture-next'});
  assert.equal(third.messages.some(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE),false);

  const handoffs=handoffMessages(f.target);
  assert.equal(handoffs.length,1);
  assert.match(handoffs[0].content[0].text,/只存在于另一个对话的原文/);
  const restored=await strictReplay(f.directory,f.target.session);
  assert.equal(firstTurnHandoffCount,1);
  assert.equal(restored.deriveMessages()[0].source.kind,'system-prompt');
  assert.equal(restored.deriveMessages()[1].source.kind,MEMORY_HANDOFF_SOURCE);
  assert.equal(restored.deriveMessages().filter(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE).length,1);
  assert.equal(f.warnings.some(message=>message.includes('[memory-handoff] deferred:')),false);
});

test('first turn without any other conversation source stays empty without deferring',async t=>{
  const f=await fixture(t);
  await f.access.set(f.target.session.id,true);
  const decision=await replayTurn(f,f.target,{text:'没有历史材料的目标对话',answer:'空接续回答',system:true});

  assert.equal(decision.messages.some(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE),false);
  assert.equal(handoffMessages(f.target).length,0);
  const attempt=(await f.bridge.handoff.status()).sessions[f.target.session.id].attempt;
  assert.equal(attempt.ready,true);
  assert.equal(attempt.delivered,true);
  assert.equal(attempt.completed,true);
  assert.equal(f.warnings.some(message=>message.includes('[memory-handoff] deferred:')),false);
});

test('first-turn handoff honors memory, authorization, recent-context and root-agent gates',async t=>{
  const disabled=await fixture(t);
  await disabled.access.set(disabled.target.session.id,false);
  const disabledDecision=await replayTurn(disabled,disabled.target,{text:'记忆关闭',answer:'不应接续',system:true});
  assert.equal(disabledDecision.messages.some(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE),false);

  const unauthorized=await fixture(t);
  await unauthorized.access.set(unauthorized.target.session.id,true);
  unauthorized.access.validate=()=>false;
  const unauthorizedDecision=await replayTurn(unauthorized,unauthorized.target,{text:'授权已撤销',answer:'不应接续',system:true});
  assert.equal(unauthorizedDecision.messages.some(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE),false);

  const noRecent=await fixture(t,{config:{recentContext:false}});
  await noRecent.access.set(noRecent.target.session.id,true);
  const noRecentDecision=await replayTurn(noRecent,noRecent.target,{text:'关闭近期接续',answer:'不应接续',system:true});
  assert.equal(noRecentDecision.messages.some(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE),false);

  const child=await fixture(t);
  await child.access.set(child.source.session.id,true);
  await replayTurn(child,child.source,{text:'父会话材料',answer:'父会话回答',system:true});
  await child.access.set(child.target.session.id,true);
  child.access.isRootAgent=agent=>agent===child.source;
  assert.equal(child.access.isRootAgent(child.target),false);
  const childDecision=await replayTurn(child,child.target,{text:'子智能体首轮',answer:'子智能体回答',system:true});
  assert.equal(childDecision.messages.some(message=>message.source?.kind===MEMORY_HANDOFF_SOURCE),false);
});

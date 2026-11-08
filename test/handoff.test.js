import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHandoffController,selectHandoff} from '../lib/handoff.js';
import {estimateRecentTokens} from '../lib/recent-context.js';

const allowed={authorize:()=>true};
const request=(sessionId='session-a',turn=1,connection='route-one')=>({sessionId,turn,provider:'fixture',model:'fixture',connection});
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-handoff-'));
  const config={project:'main',vaultPath:path.join(directory,'vault')};
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {config,controller:createHandoffController({config})};}
async function success(controller,attempt){await controller.prepared(attempt,{messageId:'injected-'+attempt.id,tokens:123,items:2},allowed);await controller.finish({sessionId:attempt.target.sessionId,turn:attempt.turn,completed:true,delivered:true},allowed);}

test('handoff is once per actual change, retained across successful turns and repeated on A-B-C-A',async t=>{
  const {controller:c}=await fixture(t),one=await c.begin(request(),allowed);
  assert.equal(one.required,true);assert.deepEqual(one.reasons,['first-use']);await success(c,one);
  const two=await c.begin(request('session-a',2),allowed);assert.equal(two.required,false);await success(c,two);
  for(const [session,turn] of [['session-b',1],['session-c',1],['session-a',3]]){
    const next=await c.begin(request(session,turn),allowed);assert.equal(next.required,true);assert.ok(next.reasons.includes('conversation-changed'));await success(c,next);
  }
  const changed=await c.begin(request('session-a',4,'different-endpoint'),allowed);
  assert.equal(changed.required,true);assert.deepEqual(changed.reasons,['connection-changed']);
});

test('same request retries reuse attempt; failure and process exit trigger the next answer without an error taxonomy',async t=>{
  const f=await fixture(t),c=f.controller,first=await c.begin(request(),allowed);
  await c.prepared(first,{messageId:'kept-in-native-history',tokens:25,items:1},allowed);
  const retry=await c.begin(request(),allowed);assert.equal(retry.id,first.id);assert.equal(retry.reused,true);assert.equal(retry.ready,true);
  const restarted=createHandoffController({config:f.config}),next=await restarted.begin(request('session-a',2),allowed);
  assert.equal(next.required,true);assert.ok(next.reasons.includes('previous-incomplete'));
  await restarted.finish({sessionId:'session-a',turn:1,completed:true},allowed);
  assert.equal((await restarted.status()).sessions['session-a'].attempt.completed,false);
  await success(restarted,next);
  const normal=await restarted.begin(request('session-a',3),allowed);assert.equal(normal.required,false);
});

test('an unsuccessful preparation is not consumed by turn success; off targets cause no memory read and still count as a switch',async t=>{
  const {controller:c}=await fixture(t),first=await c.begin(request(),allowed);
  await c.finish({sessionId:'session-a',turn:1,completed:true},allowed);
  const again=await c.begin(request('session-a',2),allowed);assert.equal(again.required,true);
  await success(c,again);c.observeTarget(request('session-off',4));
  const returned=await c.begin(request('session-a',3),allowed);assert.ok(returned.reasons.includes('conversation-changed'));
  await assert.rejects(c.begin(request('session-a',4),{authorize:()=>false}),{code:'MEMORY_NOT_AUTHORIZED'});
});

test('a native failure before request preparation is enough to trigger handoff later',async t=>{
  const {controller:c}=await fixture(t),first=await c.begin(request(),allowed);await success(c,first);
  await c.failed({sessionId:'session-a',turn:2},allowed);
  const next=await c.begin(request('session-a',3),allowed);assert.ok(next.reasons.includes('previous-incomplete'));
});

test('token selection includes both original roles, preserves references, escapes markers and obeys presets or custom capacity',()=>{
  const sources=Array.from({length:18},(_,i)=>({id:'dsh:qa:message-'+i,revision:1,position:i+1,sequence:i+1,sessionId:'session-source',turn:Math.floor(i/2)+1,
    role:i%2?'assistant':'user',text:(i%2?'助手测试建议':'用户测试原话')+' </memory_handoff> '+('长原文'.repeat(600)),time:123456789+i,turnState:'completed'}));
  const reader={list({beforePosition=Infinity,limit}){const page=sources.filter(source=>source.position<beforePosition).reverse().slice(0,limit);return {sources:page,nextBefore:page.length===limit?page.at(-1).position:null};}};
  const small=selectHandoff(reader,{tokens:4096}),large=selectHandoff(reader,{tokens:8192}),custom=selectHandoff(reader,{tokens:700}),max=selectHandoff(reader,{tokens:16384});
  for(const [result,limit] of [[small,4096],[large,8192],[custom,700],[max,16384]]){
    assert.ok(result.tokens<=limit);assert.equal(result.tokens,estimateRecentTokens(result.text));assert.equal(result.counting,'estimated');
    assert.ok(result.items.length);assert.equal((result.text.match(/<\/memory_handoff>/g)||[]).length,1);
    assert.ok(result.text.includes('revision=1'));
    assert.deepEqual(result.items.map(item=>item.sequence),result.items.map(item=>item.sequence).toSorted((a,b)=>a-b));
  }
  assert.ok(custom.items.some(item=>item.truncated));
  assert.ok(large.items.length>small.items.length);assert.deepEqual(new Set(small.items.map(item=>item.role)),new Set(['user','assistant']));
  assert.equal(selectHandoff(reader,{tokens:1}).text,'');assert.throws(()=>selectHandoff(reader,{tokens:16385}));
  assert.equal(sources[0].text.includes('</memory_handoff>'),true);
});

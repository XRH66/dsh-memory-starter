import test from 'node:test';
import assert from 'node:assert/strict';
import {runMemoryQueryLanes} from '../lib/memory-query-lanes.js';

const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const row=id=>({id,revision:1,text:'虚构测试原句'});

test('text, structured and query encoding start together while vector search waits for encoding',async()=>{
  const entered=[],text=deferred(),structured=deferred(),encoding=deferred();
  const run=runMemoryQueryLanes({deadline:Date.now()+1000,reserveMs:0,lanes:{
    text:async()=>{entered.push('text');await text.promise;return {records:[row('text')]};},
    structured:async()=>{entered.push('structured');await structured.promise;return {records:[row('note')]};},
    vector:async()=>{entered.push('encoding');await encoding.promise;entered.push('vector-search');return {records:[row('vector')]};},
  }});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(entered,['text','structured','encoding']);
  text.resolve();structured.resolve();encoding.resolve();const result=await run;
  assert.equal(result.degraded,false);assert.deepEqual(Object.keys(result.results).sort(),['structured','text','vector']);assert.equal(entered.at(-1),'vector-search');
});

test('one shared deadline returns ready branches, aborts slow work and ignores late results',async()=>{
  const late=deferred();let slowSignal;
  const result=await runMemoryQueryLanes({deadline:Date.now()+30,reserveMs:0,lanes:{
    text:async()=>({records:[row('already-ready')]}),vector:async({signal})=>{slowSignal=signal;return late.promise;},
  }});
  assert.equal(result.results.text.records[0].id,'already-ready');assert.equal('vector' in result.results,false);assert.equal(result.channels.vector.state,'timeout');assert.equal(slowSignal.aborted,true);assert.equal(result.degraded,true);
  assert.ok(result.channels.vector.elapsedMs>0);
  late.resolve({records:[row('late-must-not-deliver')]});await new Promise(resolve=>setImmediate(resolve));assert.equal('vector' in result.results,false);
});

test('a failed or unavailable channel cannot erase other ready results or expose its private exception',async()=>{
  const result=await runMemoryQueryLanes({deadline:Date.now()+1000,lanes:{
    text:async()=>({records:[row('kept')]}),structure:async()=>{throw Error('private-source-body-and-path');},vector:async()=>({state:'unavailable',records:[]}),
  }});
  assert.equal(result.channels.structure.state,'failed');assert.equal(result.channels.vector.state,'unavailable');assert.equal(result.results.text.records.length,1);assert.doesNotMatch(JSON.stringify(result),/private-source/);
});

test('a channel completing past the cutoff cannot publish before the timer callback',async()=>{
  let clock=0,lateSignal;
  const ready=deferred();
  const result=await runMemoryQueryLanes({deadline:1000,now:()=>clock,reserveMs:0,lanes:{
    text:async()=>({records:[row('kept')]}),
    vector:async({signal})=>{lateSignal=signal;setImmediate(ready.resolve);await ready.promise;clock=1000;return {records:[row('late')]};},
  }});
  assert.equal(result.channels.text.state,'ready');assert.equal(result.channels.vector.state,'timeout');
  assert.equal(lateSignal.aborted,true);assert.equal(result.results.vector,undefined);
});

test('an expired queued request starts no backend and outer cancellation releases an uncooperative lane',async()=>{
  let calls=0;
  const expired=await runMemoryQueryLanes({deadline:Date.now()-1,lanes:{text:async()=>{calls++;return {records:[]};}}});assert.equal(calls,0);assert.equal(expired.channels.text.state,'timeout');
  const controller=new AbortController(),entered=deferred();let laneSignal;
  const pending=runMemoryQueryLanes({deadline:Date.now()+1000,signal:controller.signal,lanes:{text:async({signal})=>{laneSignal=signal;entered.resolve();return new Promise(()=>{});}}});
  await entered.promise;controller.abort(Error('fixture cancelled'));await assert.rejects(pending,/fixture cancelled/);assert.equal(laneSignal.aborted,true);
});

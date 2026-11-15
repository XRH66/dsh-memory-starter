import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {createMemoryQueryAnswer} from '../lib/memory-query.js';
import {runMemoryQueryLanes} from '../lib/memory-query-lanes.js';
import {createStopwatch,deadlineSignal,deadlineTimer,hostStalledMs} from '../lib/monotonic.js';

const spin=ms=>{const until=performance.now()+ms;while(performance.now()<until){}};
const row=id=>({id,revision:1,text:'fictional host stall candidate'});

function memoryQueryFixture({stallMs=0,reports=[]}={}){
  const records=Array.from({length:4},(_,index)=>{
    const id='stall-candidate-'+index;
    return {id,revision:1,text:'fictional host stall candidate '+index,kind:'original',role:'user',
      time:1000+index,sessionId:'stall-session',messageId:id,sequence:index+1,turn:index+1,completion:'completed',
      ref:{storage:'message',id,revision:1}};
  });
  const access={
    ownerSubject:'stall-owner',
    grant(){return {kind:'read',ownerSubject:'stall-owner',project:'main',sessionId:'stall-session',
      rootSessionId:'stall-session',epoch:'one',signal:new AbortController().signal};},
    validate:()=>true,
  };
  const raw={
    status:()=>({backend:{actualDevice:null}}),
    queryReader(){return {
      search({limit}){spin(stallMs);return {sources:records.slice(0,limit),partial:false};},
      get(ref){return records.find(record=>record.id===ref.id)??null;},
      neighbors(){return [];},
    };},
  };
  const reranker={
    enabled:()=>true,
    status:()=>({enabled:true,state:'ready'}),
    async rerank({documents}){return documents.map((_document,index)=>({index:documents.length-index-1,score:1-index/10}));},
  };
  const answer=createMemoryQueryAnswer({access,agent:{session:{id:'stall-session'}},answerTurn:99,raw,config:{},
    reranker,searchWaitMs:900,onSearch:report=>reports.push(report)});
  return {answer,reports};
}

test('host stall meter records synchronous stalls and ignores idle time',async()=>{
  const before=hostStalledMs();
  spin(400);
  const during=hostStalledMs();
  assert.ok(during-before>=250,'busy wait was not accounted as a host stall');
  assert.ok(during-before<=550,'host stall measurement exceeded the busy-wait tolerance');
  await delay(180);
  assert.ok(hostStalledMs()-during<150,'idle timer progress was mistaken for a host stall');
});

test('stopwatch stall exclusion preserves the plain clock and respects its credit cap',()=>{
  const plainStarted=performance.now(),plain=createStopwatch(),
    excluded=createStopwatch(undefined,{excludeHostStalls:true});
  spin(420);
  const wall=performance.now()-plainStarted;
  assert.ok(plain()>=400);
  const credited=excluded();
  assert.ok(credited<wall-250,'excludeHostStalls did not remove the busy-wait stall');

  const cappedStarted=performance.now(),
    capped=createStopwatch(undefined,{excludeHostStalls:true,maxStallCreditMs:80});
  spin(240);
  const cappedWall=performance.now()-cappedStarted,cappedElapsed=capped();
  assert.ok(cappedElapsed>=cappedWall-140,'stall credit exceeded its configured cap');
  assert.ok(cappedElapsed<cappedWall-60,'stall credit did not apply the configured cap');
});

test('deadline timer extends only when its remaining clock excludes the stall',async()=>{
  const plain=createStopwatch(),excluded=createStopwatch(undefined,{excludeHostStalls:true});
  let plainExpiredAt,excludedExpiredAt;let resolveExcluded;
  const excludedDone=new Promise(resolve=>{resolveExcluded=resolve;});
  const plainTimer=deadlineTimer(()=>Math.max(0,200-plain()),()=>{plainExpiredAt=performance.now();});
  const excludedTimer=deadlineTimer(()=>Math.max(0,200-excluded()),()=>{
    excludedExpiredAt=performance.now();resolveExcluded();
  });
  try{
    spin(400);
    const stallEndedAt=performance.now();
    await delay(30);
    assert.ok(Number.isFinite(plainExpiredAt),'the plain deadline did not expire after the stall');
    assert.equal(excludedExpiredAt,undefined,'the stall-excluding deadline expired during the stall');
    await Promise.race([excludedDone,delay(700).then(()=>assert.fail('stall-excluding deadline did not expire'))]);
    assert.ok(excludedExpiredAt-stallEndedAt>=140,'the stall-excluding deadline did not keep its remaining time');
  }finally{
    plainTimer();excludedTimer();
  }
});

test('query lanes publish a lane that finishes during a host stall',async()=>{
  const elapsed=createStopwatch(undefined,{excludeHostStalls:true});
  const pending=runMemoryQueryLanes({deadline:Date.now()+300,reserveMs:0,elapsed,lanes:{
    text:async()=>{await delay(150);return {records:[row('ready-after-stall')]};},
  }});
  await delay(20);
  spin(500);
  const result=await pending;
  assert.equal(result.channels.text.state,'ready');
  assert.equal(result.results.text.records[0].id,'ready-after-stall');
});

test('a lane stall leaves enough time for a simulated rerank to apply',async t=>{
  const {answer,reports}=memoryQueryFixture({stallMs:700});
  t.after(()=>answer.dispose());
  const result=await answer.search({query:'fictional host stall',limit:4});
  assert.equal(result.channels.originals.state,'ready');
  assert.equal(result.channels.rerank.state,'applied');
  assert.equal(reports.length,1);
  assert.ok(reports[0].timings.hostStallMs>=500);
});

test('a host stall beyond the credit cap still reaches the lane deadline',async()=>{
  const elapsed=createStopwatch(undefined,{excludeHostStalls:true,maxStallCreditMs:80});
  const result=await runMemoryQueryLanes({deadline:Date.now()+100,reserveMs:0,elapsed,lanes:{
    text:async()=>{spin(260);return {records:[row('must-time-out')]};},
  }});
  assert.equal(result.channels.text.state,'timeout');
  assert.equal(result.results.text,undefined);
});

test('timeout signal keeps the prefetch TimeoutError reason',async()=>{
  const started=performance.now(),{signal,cancel}=deadlineSignal(()=>Math.max(0,20-(performance.now()-started)));
  try{
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    assert.equal(signal.reason?.name,'TimeoutError');
  }finally{
    cancel();
  }
});

test('search reports zero host stall timing without a stall',async t=>{
  const {answer,reports}=memoryQueryFixture();
  t.after(()=>answer.dispose());
  const result=await answer.search({query:'fictional host stall',limit:4});
  assert.equal(result.status,'ok');
  assert.equal(reports.length,1);
  assert.equal(reports[0].timings.hostStallMs,0);
});

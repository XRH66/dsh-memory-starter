import test from 'node:test';
import assert from 'node:assert/strict';
import {createMemorySearchSession} from '../lib/suzu/search-session.js';
import {estimateRecentTokens} from '../lib/recent-context.js';

function fixture(options={}){
  const controller=new AbortController(),listeners=new Set();let enabled=true;
  const grant={ownerSubject:'owner',project:'main',sessionId:'session-qa',rootSessionId:'session-qa',epoch:'one',signal:controller.signal};
  const policy={grant:()=>grant,validate:()=>enabled,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);}};
  const session=createMemorySearchSession({policy,agent:{},tokenLimits:{},search:async()=>({records:[record()]}),...options});
  return {session,close(){enabled=false;controller.abort();for(const listener of listeners)listener();}};
}
const record=(id='qa',text='虚构原文')=>({id,revision:1,text,anchor:{id,revision:1,range:{start:0,end:text.length}},type:'plan',state:{validity:'current',progress:'completed'},importance:{level:'high',basis:'user_explicit',reason:'虚构明确说明'}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('search and open share four calls and 4K estimated tokens while keeping structured fields and channel state',async t=>{
  const text='虚构历史原句。'.repeat(2500),channels={text:{state:'ready'},vector:{state:'unavailable'}};
  const {session}=fixture({search:async()=>({records:[record('long',text)],degraded:true,channels}),expand:async request=>{
    const start=request.anchor.nextOffset??request.anchor.range.start;
    assert.ok(request.maxTokens<=2048);assert.equal('maxChars' in request,false);
    return {records:[{...record('long',text.slice(start)),anchor:{id:'long',revision:1,range:{start,end:text.length}}}],channels:{source:{state:'ready'}}};
  }});t.after(()=>session.dispose());
  const search=await session.search({query:'虚构'});assert.ok(estimateRecentTokens(JSON.stringify(search))<=1024);assert.ok(search.records[0].text.length<text.length);
  assert.equal(search.records[0].type,'plan');assert.equal(search.records[0].state.progress,'completed');assert.equal(search.records[0].importance.level,'high');assert.deepEqual(search.channels,channels);
  const opened=await session.expand({anchor:search.records[0].anchor});assert.ok(estimateRecentTokens(JSON.stringify(opened))<=2048);
  assert.ok(opened.records[0].text.length>search.records[0].text.length);assert.equal(opened.records[0].anchor.nextOffset,opened.records[0].anchor.range.end);
  const continued=await session.expand({anchor:opened.records[0].anchor});
  assert.ok(continued.records.length);assert.equal(continued.records[0].anchor.range.start,opened.records[0].anchor.nextOffset);
  const fourth=await session.search({query:'另一问法'});assert.ok(session.budget().tokens<=4096);
  const actual=[search,opened,continued,fourth].filter(result=>result.records.length).reduce((sum,result)=>sum+estimateRecentTokens(JSON.stringify(result)),0);
  assert.ok(actual<=session.budget().tokens);assert.equal(session.budget().calls,4);
  assert.equal((await session.search({query:'第五次'})).error.code,'CALLS');
});

test('2-second waiting budget is fresh for each request rather than shared active time for the whole answer',async t=>{
  let clock=0,n=0;const {session}=fixture({now:()=>clock,search:async request=>{assert.equal(request.deadline,clock+2000);clock+=1500;return {records:[record('r'+(++n))]};}});t.after(()=>session.dispose());
  assert.equal((await session.search({query:'first'})).status,'ok');
  clock+=100000;assert.equal((await session.search({query:'second'})).status,'ok');assert.equal(session.budget().remainingMs,2000);
});

test('search total wait is separate from the open budget',async t=>{
  let clock=0;const deadlines=[];
  const {session}=fixture({tokenLimits:{waitMs:20},searchWaitMs:50,now:()=>clock,
    search:async()=>({records:[record()]}),expand:async()=>({records:[record()]})});t.after(()=>session.dispose());
  const found=await session.search({query:'first'});
  deadlines.push(found.budget.remainingMs);
  const opened=await session.expand({anchor:found.records[0].anchor});
  deadlines.push(opened.budget.remainingMs);
  assert.deepEqual(deadlines,[50,20]);
});

test('one timed out query aborts its own work without poisoning later calls in the same answer',async t=>{
  let calls=0,signal;const late=deferred();
  const {session}=fixture({tokenLimits:{waitMs:20},search:async request=>{calls++;signal=request.signal;return calls===1?late.promise:{records:[record('ready')]};}});t.after(()=>session.dispose());
  const first=await session.search({query:'cold'});assert.equal(first.error.code,'TIMEOUT');assert.equal(signal.aborted,true);
  const second=await session.search({query:'ready'});assert.equal(second.status,'ok');assert.equal(second.records[0].id,'ready');
  late.resolve({records:[record('must-not-deliver')]});assert.equal(session.budget().calls,2);
});

test('queue delay belongs to the same absolute per-call deadline',async t=>{
  let clock=0,calls=0;const entered=deferred(),release=deferred();
  const {session}=fixture({tokenLimits:{waitMs:50},now:()=>clock,search:async()=>{calls++;if(calls===1){entered.resolve();await release.promise;clock=100;}return {records:[record('r'+calls)]};}});t.after(()=>session.dispose());
  const first=session.search({query:'first'});await entered.promise;const queued=session.search({query:'queued'});release.resolve();await first;
  assert.equal((await queued).error.code,'TIMEOUT');assert.equal(calls,1);assert.equal(session.budget().calls,2);
  assert.equal((await session.search({query:'fresh'})).status,'ok');assert.equal(calls,2);
});

test('filters reach the backend while owner, profile and invented types never come from model parameters',async t=>{
  let request;const {session}=fixture({search:async value=>{request=value;return {records:[record()]};}});t.after(()=>session.dispose());
  assert.equal((await session.search({query:'q',ownerSubject:'other'})).error.code,'INPUT');
  assert.equal((await session.search({query:'q',type:'history'})).error.code,'INPUT');
  const result=await session.search({query:'q',type:'plan',progress:'completed',validity:'current',subject:'测试主体',tag:'测试',since:'2026-01-01',until:'2026-12-31'});
  assert.equal(result.status,'ok');assert.equal(request.type,'plan');assert.equal(request.progress,'completed');assert.equal(request.scope.ownerSubject,'owner');assert.equal(session.budget().calls,1);
});

test('empty channel diagnostics cannot bypass token packing or leak an unbounded metadata payload',async t=>{
  const {session}=fixture({tokenLimits:{searchTokens:512},search:async()=>({records:[],degraded:true,channels:{text:{state:'failed',unbounded:'x'.repeat(10000)}}})});t.after(()=>session.dispose());
  const result=await session.search({query:'q'});assert.equal(result.error.code,'TOKENS');assert.equal('channels' in result,false);assert.ok(estimateRecentTokens(JSON.stringify(result))<=512);
});

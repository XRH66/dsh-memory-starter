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
const record=(id='qa',text='虚构原文')=>({id,revision:1,text,anchor:{id,revision:1,range:{start:0,end:text.length}},label:'原话 · 用户说 · 2026-11-11 09:00 -08:00',kind:'original',role:'user',time:1762870800000,type:'plan',state:{validity:'current',progress:'completed'},importance:{level:'high',basis:'user_explicit',reason:'虚构明确说明'}});
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};

test('search and open share four calls and 4K estimated tokens while keeping only the compact model view and channel state',async t=>{
  const text='虚构历史原句。'.repeat(2500),channels={text:{state:'ready'},vector:{state:'unavailable'}};
  const {session}=fixture({search:async()=>({records:[record('long',text)],degraded:true,channels}),expand:async request=>{
    const start=request.anchor.nextOffset??request.anchor.range.start;
    assert.ok(request.maxTokens<=2048);assert.equal('maxChars' in request,false);
    return {records:[{...record('long',text.slice(start)),anchor:{id:'long',revision:1,range:{start,end:text.length}}}],channels:{source:{state:'ready'}}};
  }});t.after(()=>session.dispose());
  const search=await session.search({query:'虚构'});assert.ok(estimateRecentTokens(JSON.stringify(search))<=1024);assert.ok(search.records[0].text.length<text.length);
  assert.deepEqual(Object.keys(search.records[0]).sort(),['label','ref','text','truncated']);assert.deepEqual(search.channels,channels);
  const searchLocation=session.resolve(search.records[0].ref);
  assert.equal(searchLocation.id,'long');assert.equal(searchLocation.anchor.range.end,search.records[0].text.length);
  const opened=await session.expand({ref:search.records[0].ref});assert.ok(estimateRecentTokens(JSON.stringify(opened))<=2048);
  const openedLocation=session.resolve(opened.records[0].ref);
  assert.ok(opened.records[0].text.length>search.records[0].text.length);assert.equal(openedLocation.anchor.nextOffset,openedLocation.anchor.range.end);
  const continued=await session.expand({ref:opened.records[0].ref});
  const continuedLocation=session.resolve(continued.records[0].ref);
  assert.ok(continued.records.length);assert.equal(continuedLocation.anchor.range.start,openedLocation.anchor.nextOffset);
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
  const opened=await session.expand({ref:found.records[0].ref});
  deadlines.push(opened.budget.remainingMs);
  assert.deepEqual(deadlines,[50,20]);
});

test('one timed out query aborts its own work without poisoning later calls in the same answer',async t=>{
  let calls=0,signal;const late=deferred();
  const {session}=fixture({tokenLimits:{waitMs:20},search:async request=>{calls++;signal=request.signal;return calls===1?late.promise:{records:[record('ready')]};}});t.after(()=>session.dispose());
  const first=await session.search({query:'cold'});assert.equal(first.error.code,'TIMEOUT');
  assert.match(first.error.message,/不要提后端、接口、错误码或超时/u);assert.equal(signal.aborted,true);
  const second=await session.search({query:'ready'});assert.equal(second.status,'ok');assert.equal(session.resolve(second.records[0].ref).id,'ready');
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

test('twelve short related records fit at least eight compact results with refs and server-only locations',async t=>{
  const records=Array.from({length:12},(_,index)=>record('short-'+index,`虚构短原话${index}：周末整理书架并核对清单。`));
  const {session}=fixture({search:async()=>({records})});t.after(()=>session.dispose());
  const result=await session.search({query:'周末书架'});
  assert.ok(result.records.length>=8);
  const allowed=new Set(['ref','label','text','truncated','correction','subject_ref','tags']);
  for(const item of result.records)assert.ok(Object.keys(item).every(key=>allowed.has(key)),JSON.stringify(item));
  result.records.forEach((item,index)=>{
    assert.equal(item.ref,'m'+(index+1));
    assert.equal(session.resolve(item.ref).id,'short-'+index);
  });
  const serialized=JSON.stringify(result.records);
  for(const field of ['"anchor"','"revision"','"sourceIds"'])assert.equal(serialized.includes(field),false);
});

test('issued refs open the same evidence, continue long text, and reject an unknown ref',async t=>{
  const text='虚构长原文。'.repeat(1000);
  const {session}=fixture({search:async()=>({records:[record('long',text)]}),expand:async request=>{
    const start=request.anchor.nextOffset??request.anchor.range.start;
    return {records:[{...record('long',text.slice(start)),anchor:{id:'long',revision:1,range:{start,end:text.length}}}]};
  }});t.after(()=>session.dispose());
  const search=await session.search({query:'虚构'});
  const opened=await session.expand({ref:search.records[0].ref});
  assert.ok(opened.records[0].text.length>search.records[0].text.length);
  assert.equal(session.resolve(search.records[0].ref).id,session.resolve(opened.records[0].ref).id);
  const continued=await session.expand({ref:opened.records[0].ref});
  assert.deepEqual([search.records[0].ref,opened.records[0].ref,continued.records[0].ref],['m1','m2','m3']);
  assert.equal(session.resolve(continued.records[0].ref).anchor.range.start,session.resolve(opened.records[0].ref).anchor.nextOffset);
  assert.equal((await session.expand({ref:'m999'})).error.code,'INPUT');
});

test('correction and nonempty entry metadata are the only conditional model view fields',async t=>{
  const corrected={...record('correction','虚构更正原话'),source:{kind:'original',changeKind:'correction'}};
  const entry={...record('entry','虚构记忆条目'),kind:'entry',subject_ref:'owner',tags:['虚构']};
  const {session}=fixture({search:async()=>({records:[corrected,entry]})});t.after(()=>session.dispose());
  const result=await session.search({query:'虚构'});
  assert.equal(result.records[0].correction,true);
  assert.equal(result.records[1].subject_ref,'owner');assert.deepEqual(result.records[1].tags,['虚构']);
  assert.equal('source' in result.records[0],false);assert.equal('type' in result.records[1],false);
});

test('internal relevance signals are copied only when the caller asks for them',async t=>{
  const signals={lexical:.75,similarity:.62,rerank:.41,lanes:['text','vector']};
  const {session:keeping}=fixture({keepSignals:true,search:async()=>({records:[{...record(),_signals:signals}]})});
  const {session:hidden}=fixture({keepSignals:false,search:async()=>({records:[{...record(),_signals:signals}]})});
  t.after(()=>{keeping.dispose();hidden.dispose();});
  assert.deepEqual((await keeping.search({query:'虚构'})).records[0].signals,signals);
  const publicRecord=(await hidden.search({query:'虚构'})).records[0];
  assert.equal('signals' in publicRecord,false);assert.equal('_signals' in publicRecord,false);
});

test('technical failures tell the model how to speak without exposing internals',async t=>{
  const {session:backend}=fixture({search:async()=>{throw Object.assign(Error('private backend detail'),{code:'PRIVATE'});}});
  const {session:profile}=fixture({getProfile:async()=>({id:'',revision:1}),search:async request=>{
    await request.getProfile();return {records:[record()]};
  }});
  const {session:partial}=fixture({search:async()=>({records:[],degraded:true})});
  t.after(()=>{backend.dispose();profile.dispose();partial.dispose();});
  const backendReply=await backend.search({query:'虚构'});
  assert.equal(backendReply.error.code,'BACKEND');assert.match(backendReply.error.message,/自然地说这次没查到相关记录/u);
  assert.doesNotMatch(backendReply.error.message,/private backend detail/u);
  assert.equal((await profile.search({query:'虚构'})).error.code,'PROFILE');
  const partialReply=await partial.search({query:'虚构'});
  assert.equal(partialReply.error.code,'PARTIAL');
  assert.equal(partialReply.error.message,'部分检索没有完成，以下是已核实的结果；若不足以回答，就说没查到更多记录，不要提技术原因。');
});

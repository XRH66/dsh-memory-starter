import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {performance} from 'node:perf_hooks';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {ANSWER_RULES,createMemoryQueryAnswer,createMemoryQueryTools,selectPrefetch,vectorQueryText} from '../lib/memory-query.js';
import {createBridge} from '../lib/index.js';
import {createUnifiedProfiles} from '../lib/storage/profiles.js';
import {resolveConfig} from '../lib/config.js';
import {applyInheritRecords} from '../lib/inherit/importer.js';
import {convertLegacyVault} from '../lib/inherit/vault.js';
import {personalTimeZone,setPersonalTimeZone} from '../lib/personal-namespace.js';
import {estimateTokens} from '../lib/token-estimate.js';
import {memoryStore} from './fake-memory.js';
import {directUser,fakeAgent,fakeLlm,runPreStep} from './helpers.js';

const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
const resultIds=(answer,result)=>result.records.map(record=>answer.resolve(record.ref)?.id);
const legacyVaultNote=`---
title: 用户 - 虚构宠物
permalink: personal/chats/facts/用户-虚构宠物
memory_id: vault-legacy-qa
memory_kind: fact
status: active
subject: 用户
attribute: 养的宠物
value: 养了一只叫阿岑的猫
recorded_at: '2026-10-25T04:21:07.668Z'
tags:
- dsh-memory
- dsh-fact
---

<!-- dsh-fact-memory -->
# 用户 - 虚构宠物

- [fact] 养了一只叫阿岑的猫
`;

async function fixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'portable-query-')),memory=new RawMemoryStore(path.join(directory,'existing.sqlite'),{warn(){}});
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),
    rawRecallModel:'BAAI/bge-small-zh-v1.5',rawRecall:false,...options.config}),
    notes=memoryStore({project:'main'}),agent=fakeAgent('session-query');
  let enabled=true,grants=0;const controllers=[];
  const access={ownerSubject:'owner',grant(){grants++;const controller=new AbortController();controllers.push(controller);return {kind:'read',ownerSubject:'owner',project:'main',sessionId:agent.session.id,rootSessionId:agent.session.id,epoch:'one',signal:controller.signal,cancel:()=>controller.abort()};},
    validate:grant=>enabled&&!grant.signal?.aborted,validateMessage:()=>enabled,assertCurrent(){if(!enabled)throw Error('closed');},withGrant:(_grant,work)=>work()};
  const raw=createRawRecall({config,store:memory,ownerSubject:'owner'});
  const source=({text='只有周末有空才整理书架。',content=[{type:'text',text}],...patch}={})=>({ownerSubject:'owner',project:'main',sessionId:agent.session.id,messageId:'qa-user',role:'user',sequence:1,turn:1,rootTurn:1,
    text,content,time:1000,authorization:{rootSessionId:agent.session.id},...patch});
  const save=patch=>memory.messages.record(source(patch),{authorize:()=>enabled}).source;
  const answer=createMemoryQueryAnswer({access,agent,raw,tools:notes.tools,config,...options});
  t.after(async()=>{answer.dispose();await raw.dispose();await fs.rm(directory,{recursive:true,force:true});});
  return {answer,save,raw,memory,access,agent,notes,config,grants:()=>grants,revoke(){enabled=false;for(const c of controllers)c.abort();}};
}

test('real vector index excerpts retain absolute positions through search, open and continuation',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'query-vector-offset-'));
  const marker='QA789：只有完成验收才能启动。',text='很久以前。'.repeat(2000)+marker+'后续说明😀。'.repeat(2000);
  const document={id:'late-vector-hit',revision:'one',domain:'fact',kind:'entry',text,weight:1,
    state:{validity:'current',progress:null},sourceStatus:{eligible:true,manualBody:true},sourceIds:['fictional-source'],
    anchor:{id:'late-vector-hit',revision:'one',ref:{storage:'document',id:'late-vector-hit'}}};
  let profiles;
  const vectors={getSnapshot:input=>profiles.activeSnapshot(input),query:input=>profiles.query(input),
    async resolveDocument({id,revision}){return id===document.id&&revision===document.revision?structuredClone(document):null;}};
  const f=await fixture(t,{vectors}),grant=f.access.grant();
  profiles=createUnifiedProfiles({file:path.join(directory,'profiles.json'),indexFile:path.join(directory,'index.sqlite'),authorize:f.access.validate,
    async *listDocuments(){yield structuredClone(document);},resolveDocument:vectors.resolveDocument,
    createBackend(){return {batchSize:8,modelKey:'synthetic-offset-512',dimensions:512,async prepare(){return {modelKey:'synthetic-offset-512',dimensions:512};},
      async planChunks(value){return Array.from({length:Math.ceil(value.length/200)},(_,i)=>{
        const start=i*200,end=Math.min(value.length,start+200);return {start,end,text:value.slice(start,end),tokenBound:end-start};});},
      async embed(texts,{kind}){return texts.map(value=>Array.from({length:512},(_,i)=>i===(kind==='query'||value.includes('QA789')?0:1)?1:0));},async dispose(){}};}});
  t.after(async()=>{await profiles.close();await fs.rm(directory,{recursive:true,force:true});});
  await profiles.register({profile:{id:'fixture',model:'BAAI/bge-small-zh-v1.5'},grant});
  await profiles.select({profileId:'fixture',grant});await profiles.prepare({grant});
  const found=await f.answer.search({query:'QA789'}),hit=found.records[0];
  const hitLocation=f.answer.resolve(hit.ref);
  assert.ok(hit.text.includes(marker));assert.ok(hitLocation.anchor.range.start>9000);
  assert.equal(hit.text,text.slice(hitLocation.anchor.range.start,hitLocation.anchor.range.end));
  const opened=(await f.answer.expand({ref:hit.ref})).records[0],openLocation=f.answer.resolve(opened.ref);
  assert.ok(opened.text.includes(marker));assert.equal(openLocation.revision,hitLocation.revision);
  assert.equal(opened.text,text.slice(openLocation.anchor.range.start,openLocation.anchor.range.end));
  assert.ok(openLocation.anchor.nextOffset);assert.ok(!/[\uD800-\uDBFF]$/u.test(opened.text));
  const continued=(await f.answer.expand({ref:opened.ref})).records[0],continuedLocation=f.answer.resolve(continued.ref);
  assert.equal(continuedLocation.anchor.range.start,openLocation.anchor.nextOffset);
  assert.equal(continued.text,text.slice(continuedLocation.anchor.range.start,continuedLocation.anchor.range.end));
});

test('actual original reader and native tools share the answer ledger without model or vector preparation',async t=>{
  const f=await fixture(t);f.save();f.save({messageId:'qa-assistant',role:'assistant',sequence:2,text:'我建议先量尺寸。',content:[{type:'text',text:'我建议先量尺寸。'}]});
  assert.equal(f.grants(),0);assert.equal(f.raw.status().backend.prepared,false);
  const tools=createMemoryQueryTools({answer:()=>f.answer}),exec={agent:f.agent,signal:new AbortController().signal};
  const found=await tools[0].execute({query:'书架'},exec);assert.equal(found.status,'ok');assert.equal(found.records.length,1);
  assert.match(found.records[0].label,/用户说/u);assert.ok(found.records[0].text.includes('只有周末'));assert.equal(found.channels.vector.state,'unavailable');
  assert.equal(Object.hasOwn(found.channels,'legacy'),false);assert.equal(found.error,undefined);
  const opened=await tools[1].execute({ref:found.records[0].ref},exec);assert.deepEqual(opened.records.map(item=>item.label.match(/(用户说|助手说)/u)?.[0]),['用户说','助手说']);
  await tools[2].execute({},exec);await tools[0].execute({query:'尺寸'},exec);
  assert.equal((await tools[0].execute({query:'第五次'},exec)).error.code,'CALLS');assert.equal(f.grants(),1);
  assert.equal(f.raw.status().backend.prepared,false);assert.ok(f.notes.tools.calls.filter(call=>call.name.endsWith('search_notes')).every(call=>call.arguments.search_type==='text'));
});

test('short originals stay out of search ranking but remain available to recent and open',async t=>{
  const f=await fixture(t);
  const shortUser=f.save({messageId:'short-user',sequence:1,text:'好的',content:[{type:'text',text:'好的'}]});
  const shortAssistant=f.save({messageId:'short-assistant',sequence:2,role:'assistant',text:'😀😀',
    content:[{type:'text',text:'😀😀'}]});
  const long=f.save({messageId:'long-user',sequence:3,text:'好的，我周末整理书架。',
    content:[{type:'text',text:'好的，我周末整理书架。'}]});
  const search=await f.answer.search({query:'好的'});
  const ids=search.records.map(record=>f.answer.resolve(record.ref)?.id);
  assert.ok(ids.includes(long.id));
  assert.ok(!ids.includes(shortUser.id));
  assert.ok(!ids.includes(shortAssistant.id));

  const recent=(await f.answer.recent({})).records;
  assert.ok(recent.some(record=>f.answer.resolve(record.ref)?.id===shortUser.id));
  assert.ok(recent.some(record=>f.answer.resolve(record.ref)?.id===shortAssistant.id));
  const short=recent.find(record=>f.answer.resolve(record.ref)?.id===shortUser.id);
  const opened=await f.answer.expand({ref:short.ref});
  assert.equal(f.answer.resolve(opened.records[0].ref)?.id,shortUser.id);
  assert.equal(opened.records[0].text,'好的');
});

test('recent bypasses vector configuration and later searches share a pending answer snapshot',async t=>{
  let release,entered,textEntered=false,snapshots=0;
  const pendingProfile=new Promise(resolve=>release=resolve),textStarted=new Promise(resolve=>entered=resolve);
  const profiles=[];
  const vectors={getSnapshot(){snapshots++;return pendingProfile;},async query({profile}){profiles.push(profile);return {records:[]};}};
  const f=await fixture(t,{vectors});
  const first=f.save({text:'只有周末有空才整理书架。'});
  const queryReader=f.raw.queryReader.bind(f.raw);
  f.raw.queryReader=(...args)=>{const reader=queryReader(...args);return {...reader,search(input){textEntered=true;entered();return reader.search(input);}};};
  t.after(()=>release(null));
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const recent=await Promise.race([f.answer.recent({}),nextTurn()]);
  assert.equal(f.answer.resolve(recent?.records[0].ref)?.id,first.id);assert.equal(snapshots,0);

  const second=f.save({messageId:'second',sequence:2,text:'明天整理桌面。'});
  const waiting=f.answer.search({query:'桌面'});
  for(let index=0;index<6&&!textEntered;index++)await nextTurn();
  assert.equal(textEntered,true,'text lanes continue while the vector profile is pending');
  t.mock.timers.tick(2450);
  const partial=await Promise.race([waiting,nextTurn()]);
  assert.equal(partial?.channels.vector.state,'timeout');assert.deepEqual(resultIds(f.answer,partial),[second.id]);
  assert.equal(snapshots,1);assert.equal(profiles.length,0);

  const active={id:'fixture',revision:1,nested:{version:1}};
  release(active);
  await f.answer.search({query:'新的问法'});
  active.nested.version=2;
  await f.answer.search({query:'另一个问法'});
  assert.equal(snapshots,1);assert.equal(profiles.length,2);assert.equal(profiles[0],profiles[1]);
  assert.equal(profiles[1].nested.version,1);assert.equal(Object.isFrozen(profiles[1].nested),true);
});

test('a slow vector lane keeps literal results as partial under frozen and backward wall clocks',async t=>{
  for(const [label,wallClock] of [['frozen',()=>0],['backward-one-day',()=>-86400000]]){
    await t.test(label,async st=>{
      let monotonic=0;const reports=[];
      const vectors={
        async getSnapshot(){return {id:'fixture',revision:1};},
        async query(){
          await new Promise(resolve=>setTimeout(resolve,5));
          monotonic=1000;
          return {records:[],state:'ready'};
        },
      };
      const f=await fixture(st,{vectors,searchWaitMs:1300,now:wallClock,elapsed:()=>monotonic,onSearch:row=>reports.push(row)});
      const source=f.save();
      const started=performance.now(),found=await f.answer.search({query:'书架'});
      assert.equal(found.status,'partial');assert.deepEqual(resultIds(f.answer,found),[source.id]);
      assert.ok(performance.now()-started<1300);assert.ok(monotonic>=1000);
      assert.equal(reports.length,1);assert.equal(reports[0].fallback,false);assert.equal(reports[0].vector.state,'timeout');
    });
  }
});

test('prefetch still admits a lexical result when the vector lane is slow',async t=>{
  let monotonic=0;
  const vectors={
    async getSnapshot(){return {id:'fixture',revision:1};},
    async query(){
      await new Promise(resolve=>setTimeout(resolve,5));
      monotonic=1000;
      return {records:[],state:'ready'};
    },
  };
  const f=await fixture(t,{vectors,searchWaitMs:1300,searchKind:'prefetch',keepSignals:true,now:()=>0,elapsed:()=>monotonic});
  f.save();
  const found=await f.answer.search({query:'书架',limit:4});
  assert.equal(found.status,'partial');assert.equal(found.records.length,1);
  const selected=selectPrefetch({records:found.records,minSimilarity:.45,options:{maxRecords:4}});
  assert.equal(selected.lines.length,1);assert.match(selected.lines[0],/书架/u);
});

test('a stalled rerank keeps fused order with a real timeout duration under a frozen wall clock',async t=>{
  const reports=[];
  const reranker={enabled:()=>true,status:()=>({enabled:true,state:'ready'}),
    rerank:({signal})=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))};
  const f=await fixture(t,{reranker,config:{memoryRerankTimeoutMs:250},searchWaitMs:1300,now:()=>0,onSearch:row=>reports.push(row)});
  for(let index=1;index<=4;index++)f.save({messageId:'timeout-'+index,sequence:index,text:'虚构超时候选 '+index});
  const scope={ownerSubject:'owner',project:'main'},expected=f.raw.queryReader(scope,{authorize:()=>true}).search({query:'虚构超时候选',limit:40}).sources.map(source=>source.id);
  const started=performance.now(),found=await f.answer.search({query:'虚构超时候选',limit:4});
  assert.deepEqual(resultIds(f.answer,found),expected);
  assert.equal(found.channels.rerank.state,'timeout');assert.ok(performance.now()-started<1000);
  assert.equal(reports.length,1);assert.equal(reports[0].rerank.state,'timeout');assert.ok(reports[0].timings.rerankMs>=200);
});

test('all timed-out lanes without a record still return TIMEOUT',async t=>{
  let monotonic=0;const reports=[];
  const vectors={
    async getSnapshot(){return {id:'fixture',revision:1};},
    async query(){
      await new Promise(resolve=>setTimeout(resolve,5));
      monotonic=1000;
      return {records:[],state:'ready'};
    },
  };
  const f=await fixture(t,{vectors,searchWaitMs:1300,now:()=>0,elapsed:()=>monotonic,onSearch:row=>reports.push(row)});
  const found=await f.answer.search({query:'没有结果'});
  assert.equal(found.status,'timeout');assert.equal(found.error.code,'TIMEOUT');assert.deepEqual(found.records,[]);
  assert.equal(reports.length,1);assert.equal(reports[0].state,'timeout');assert.equal(reports[0].fallback,false);
  assert.ok(Number.isFinite(reports[0].timings.totalMs));
});

test('slow final validation falls back through the same visibility, withdrawal, auth and budget path',async t=>{
  const reports=[];let delayed=false;
  const f=await fixture(t,{searchWaitMs:500,now:()=>0,visibleMessageIds:new Set(['visible-message']),onSearch:row=>reports.push(row)});
  const kept=f.save({messageId:'kept-message',sequence:2,text:'书架计划：周末先量尺寸。'});
  f.save({messageId:'excluded-message',sequence:3,text:'书架计划：这条已经被撤回。'});
  f.save({messageId:'visible-message',sequence:4,text:'书架计划：这条已经在眼前。'});
  f.memory.setControl({scope:'owner',targetType:'message',targetId:'excluded-message',excluded:true});
  const baseReader=f.raw.queryReader.bind(f.raw);
  f.raw.queryReader=(...args)=>{
    const reader=baseReader(...args),wrapped=Object.create(reader);
    wrapped.get=ref=>{
      if(!delayed){
        delayed=true;
        const until=performance.now()+520;
        while(performance.now()<until){}
      }
      return reader.get(ref);
    };
    return wrapped;
  };
  const found=await f.answer.search({query:'书架'});
  assert.equal(found.status,'partial');assert.equal(found.error.code,'PARTIAL');
  assert.deepEqual(resultIds(f.answer,found),[kept.id]);assert.equal(found.records[0].text.includes('撤回'),false);
  assert.equal(reports.length,1);assert.equal(reports[0].fallback,true);
  const charged=f.answer.budget();
  assert.ok(charged.tokens>0);
  const again=await f.answer.search({query:'书架'});
  assert.equal(again.records.some(record=>f.answer.resolve(record.ref)?.id===kept.id),false);
  assert.ok(f.answer.budget().tokens>=charged.tokens);
});

test('a revoked grant cannot use the timeout fallback to deliver an offered result',async t=>{
  const f=await fixture(t,{searchWaitMs:500,now:()=>0});
  f.save();
  const baseReader=f.raw.queryReader.bind(f.raw);let revoked=false;
  f.raw.queryReader=(...args)=>{
    const reader=baseReader(...args),wrapped=Object.create(reader);
    wrapped.get=ref=>{
      if(!revoked){
        revoked=true;
        const until=performance.now()+520;
        while(performance.now()<until){}
        f.revoke();
      }
      return reader.get(ref);
    };
    return wrapped;
  };
  const found=await f.answer.search({query:'书架'});
  assert.equal(found.status,'denied');assert.deepEqual(found.records,[]);
});

test('a rejected profile is isolated to the vector channel',async t=>{
  let snapshots=0,queries=0;
  const vectors={async getSnapshot(){snapshots++;throw Error('private config location');},async query(){queries++;return {records:[]};}};
  const f=await fixture(t,{vectors}),source=f.save();
  const found=await f.answer.search({query:'书架'});
  assert.equal(found.status,'partial');assert.equal(found.channels.vector.state,'failed');assert.deepEqual(resultIds(f.answer,found),[source.id]);
  assert.doesNotMatch(JSON.stringify(found),/private config location/);
  assert.equal((await f.answer.search({query:'再查'})).channels.vector.state,'failed');assert.equal(snapshots,1);
  assert.equal((await f.answer.recent({})).status,'empty');assert.equal(queries,0);
});

test('vector query encoding dispatches before synchronous text lanes',async t=>{
  const order=[];
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){order.push('vector');return {records:[]};}};
  const f=await fixture(t,{vectors});f.save();
  const queryReader=f.raw.queryReader.bind(f.raw);
  f.raw.queryReader=(...args)=>{const reader=queryReader(...args);return {...reader,search(input){order.push('originals');return reader.search(input);}};};
  await f.answer.search({query:'书架'});
  assert.ok(order.indexOf('vector')>=0);assert.ok(order.indexOf('originals')>order.indexOf('vector'));
});

test('revocation cancels the shared profile load and prevents late vector work',async t=>{
  let entered,release,profileSignal,queries=0;
  const started=new Promise(resolve=>entered=resolve),profile=new Promise(resolve=>release=resolve);
  const vectors={getSnapshot({signal}){profileSignal=signal;entered();return profile;},async query(){queries++;return {records:[]};}};
  const f=await fixture(t,{vectors});f.save();
  const pending=f.answer.search({query:'书架'});await started;f.revoke();
  const found=await pending;assert.equal(found.status,'denied');assert.deepEqual(found.records,[]);assert.equal(profileSignal.aborted,true);
  release({id:'late',revision:1});await nextTurn();assert.equal(queries,0);
});

test('vectors.query results are treated as already verified without another resolve pass',async t=>{
  let resolves=0;
  const row={id:'vector-only',revision:'one',kind:'document',domain:'document',text:'虚构向量候选',
    anchor:{id:'vector-only',revision:'one',ref:{storage:'document',id:'vector-only'}}};
  const oldEntry={id:'old-entry',revision:'entry-v1',kind:'entry',domain:'entry',text:'旧条目向量',
    anchor:{id:'old-entry',revision:'entry-v1',ref:{storage:'entry',id:'old-entry'}}};
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){return {records:[oldEntry,row]};},
    async resolveDocument(){resolves++;return row;}};
  const f=await fixture(t,{vectors});
  const found=await f.answer.search({query:'虚构',limit:2});
  assert.deepEqual(resultIds(f.answer,found),['vector-only']);
  assert.equal(resolves,0);assert.equal(Object.hasOwn(found.channels,'vectorValidation'),false);
});

test('final delivery source validation still falls back when a vector source becomes stale',async t=>{
  let resolves=0,row;
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){return {records:[row]};},
    async resolveDocument(){resolves++;return row;}};
  const f=await fixture(t,{vectors});
  const source=f.save();row={...source,kind:'entry',text:'不应交付的向量旧正文',_vector:true,
    sourceStatus:{eligible:true,manualBody:false},source_refs:[{id:source.id,revision:source.revision,role:'assistant'}],
    anchor:{id:source.id,revision:source.revision,ref:{storage:'document',id:source.id}}};
  const found=await f.answer.search({query:'书架',limit:2});
  assert.equal(resolves,0);assert.equal(found.status,'partial');
  assert.equal(Object.hasOwn(found.channels,'vectorValidation'),false);
  assert.deepEqual(resultIds(f.answer,found),[source.id]);assert.equal(found.records[0].text,source.text);
  assert.equal(found.channels.sourceValidation.state,'source_changed');assert.equal(found.channels.sourceValidation.fallbacks,1);
});

test('vector similarity is ranked once and final merge applies weight once',async t=>{
  const f=await fixture(t);
  f.save({messageId:'high',text:'书架高层候选',time:1000});
  f.save({messageId:'low',text:'书架低层候选',time:2000});
  const {sources}=f.raw.queryReader({ownerSubject:'owner',project:'main'},{authorize:()=>true}).search({query:'书架',limit:40});
  const high=sources.find(source=>source.messageId==='high'),low=sources.find(source=>source.messageId==='low');
  const row=(source,similarity,weight)=>({...source,similarity,score:similarity,weight,
    anchor:{id:source.id,revision:source.revision,ref:source.ref}});
  const rows=[row(high,.9,.5),row(low,.3,1)];
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){return {records:rows};},
    async resolveDocument({id,revision}){return rows.find(item=>item.id===id&&item.revision===revision);}};
  const answer=createMemoryQueryAnswer({access:f.access,agent:f.agent,raw:f.raw,tools:f.notes.tools,config:f.config,vectors});
  t.after(()=>answer.dispose());
  const found=await answer.search({query:'书架',limit:2});
  assert.deepEqual(resultIds(answer,found),[low.id,high.id]);
});

test('memory search total wait derives from the configured model and device',async t=>{
  const f=await fixture(t);
  const config=resolveConfig({...f.config,rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallDevice:'cpu'});
  const answer=createMemoryQueryAnswer({access:f.access,agent:f.agent,raw:f.raw,tools:f.notes.tools,config});
  t.after(()=>answer.dispose());
  const found=await answer.search({query:'书架',limit:1});
  assert.ok(found.budget.remainingMs>3900&&found.budget.remainingMs<=4000);
});

test('search excludes the active question',async t=>{
  const f=await fixture(t,{answerTurn:3});
  f.save({messageId:'old',sequence:2,turn:2,rootTurn:2,text:'以后每周五不排会。'});
  const question=f.save({messageId:'current-question',sequence:4,turn:3,rootTurn:3,time:3000,text:'我每周哪天不排会？'});
  const found=await f.answer.search({query:'排会',limit:2});
  assert.ok(!resultIds(f.answer,found).includes(question.id));
});

test('an original edit or exclusion invalidates an issued anchor; a new body never impersonates its old revision',async t=>{
  const f=await fixture(t);f.save();const found=await f.answer.search({query:'书架'});
  f.save({sequence:3,text:'改为整理工具箱。',content:[{type:'text',text:'改为整理工具箱。'}]});
  const old=await f.answer.expand({ref:found.records[0].ref});assert.equal(old.records.length,0);assert.equal(old.channels.source.state,'source_changed');
  const current=await f.answer.search({query:'工具箱'});assert.equal(f.answer.resolve(current.records[0].ref).revision,2);
  f.memory.setControl({scope:'owner',targetType:'message',targetId:'qa-user',excluded:true});
  assert.equal((await f.answer.expand({ref:current.records[0].ref})).records.length,0);
});

test('long messages begin near a late hit and continuation uses the delivered source offset',async t=>{
  const f=await fixture(t);f.save({text:'很久以前。'.repeat(2000)+'QA789：只有完成验收才能启动。'+'后续说明。'.repeat(2000)});
  const found=await f.answer.search({query:'QA789'}),foundLocation=f.answer.resolve(found.records[0].ref);
  assert.ok(found.records[0].text.includes('QA789'));assert.ok(foundLocation.anchor.range.start>9000);
  const opened=await f.answer.expand({ref:found.records[0].ref}),openLocation=f.answer.resolve(opened.records[0].ref);
  assert.ok(opened.records[0].text.includes('只有完成验收'));assert.ok(openLocation.anchor.nextOffset);
  const continued=await f.answer.expand({ref:opened.records[0].ref}),continuedLocation=f.answer.resolve(continued.records[0].ref);
  assert.equal(continuedLocation.anchor.range.start,openLocation.anchor.nextOffset);
});

test('revocation and unissued paths cannot reveal originals or bypass the answer grant',async t=>{
  const f=await fixture(t);f.save();assert.equal((await f.answer.expand({ref:'m999'})).error.code,'INPUT');
  const found=await f.answer.search({query:'书架'});f.revoke();assert.equal((await f.answer.expand({ref:found.records[0].ref})).status,'denied');
});

test('0.3 Vault notes enter memory_search and prefetch only after inheritance import',async t=>{
  const f=await fixture(t),directory=path.join(f.config.vaultPath,'chats/facts');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'pet.md'),legacyVaultNote);
  const prefetchAnswer=createMemoryQueryAnswer({access:f.access,agent:f.agent,raw:f.raw,tools:f.notes.tools,
    config:f.config,searchKind:'prefetch',keepSignals:true});
  t.after(()=>prefetchAnswer.dispose());

  const before=await f.answer.search({query:'阿岑'}),beforePrefetch=await prefetchAnswer.search({query:'阿岑',limit:4});
  assert.deepEqual(before.records,[]);assert.deepEqual(beforePrefetch.records,[]);
  assert.equal(Object.hasOwn(before.channels,'legacy'),false);assert.equal(Object.hasOwn(beforePrefetch.channels,'legacy'),false);

  const converted=await convertLegacyVault(f.config.vaultPath);
  const applied=applyInheritRecords({store:f.memory,scope:'owner',records:converted.records,
    batchId:'fixture-vault-inherit',source:{kind:'vault',path:converted.vault},clock:()=>1000});
  assert.deepEqual({inserted:applied.inserted,conflicts:applied.conflicts},{inserted:1,conflicts:0});

  const found=await f.answer.search({query:'阿岑'}),prefetched=await prefetchAnswer.search({query:'阿岑',limit:4});
  assert.equal(found.records.length,1);assert.equal(prefetched.records.length,1);
  assert.match(found.records[0].label,/^旧笔记（整理摘要） · 写于 /u);
  assert.equal(found.records[0].text,'养了一只叫阿岑的猫');
  assert.equal(prefetched.records[0].text,'养了一只叫阿岑的猫');
  assert.equal(Object.hasOwn(found.channels,'legacy'),false);
  const selected=selectPrefetch({records:prefetched.records,minSimilarity:.45,options:{maxRecords:4}});
  assert.equal(selected.lines.length,1,JSON.stringify(selected.stats));
  assert.equal((selected.lines[0].match(/阿岑/gu)??[]).length,1,selected.lines[0]);
});

test('legacy note vectors are filtered by identity and note anchors before ranking',async t=>{
  const current={id:'current-document',revision:'v1',kind:'document',domain:'document',text:'虚构当前资料',
    sourceStatus:{eligible:true,manualBody:true},anchor:{id:'current-document',revision:'v1',ref:{storage:'document',id:'current-document'}}};
  const legacyById={id:'legacy-note:old',revision:'v1',kind:'entry',domain:'fact',text:'虚构旧笔记甲',
    anchor:{id:'legacy-note:old',revision:'v1',ref:{storage:'document',id:'legacy-note:old'}}};
  const legacyByAnchor={id:'old-note-anchor',revision:'v1',kind:'entry',domain:'fact',text:'虚构旧笔记乙',
    anchor:{id:'old-note-anchor',revision:'v1',ref:{storage:'note',id:'legacy-note:old'}}};
  let resolves=0;
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},
    async query(){return {records:[legacyById,legacyByAnchor,current]};},
    async resolveDocument(){resolves++;return null;}};
  const f=await fixture(t,{vectors});
  const found=await f.answer.search({query:'虚构'});
  assert.deepEqual(resultIds(f.answer,found),['current-document']);
  assert.equal(found.channels.vector.records,1);assert.equal(resolves,0);
});

test('memory_open receives an old note ref without reading the Vault and reports source_changed',async t=>{
  const f=await fixture(t),sessionId=f.agent.session.id;
  const oldSource={id:'legacy-note:old',revision:'v1',role:'summary',text:'虚构旧笔记正文',
    sessionId,messageId:'legacy-old',sequence:1,turn:1,time:1000,ref:{storage:'note',id:'legacy-note:old'}};
  let noteReads=0;
  const base=f.raw.queryReader.bind(f.raw);
  f.raw.queryReader=(...args)=>{
    const reader=base(...args);
    return {...reader,search:()=>({sources:[oldSource],partial:false}),
      get:ref=>ref.storage==='note'?(noteReads++,oldSource):reader.get(ref)};
  };
  const found=await f.answer.search({query:'虚构旧笔记'});
  assert.equal(found.records.length,1);
  const readsAfterSearch=noteReads;
  const opened=await f.answer.expand({ref:found.records[0].ref});
  assert.deepEqual(opened.records,[]);assert.equal(opened.channels.source.state,'source_changed');
  assert.equal(noteReads,readsAfterSearch);
});

test('an original excluded while another search channel is pending cannot leave in the final result',async t=>{
  const f=await fixture(t);f.save();let enter,release;
  const entered=new Promise(resolve=>enter=resolve),waiting=new Promise(resolve=>release=resolve);
  t.after(()=>release());
  const queryReader=f.raw.queryReader.bind(f.raw);
  f.raw.queryReader=(...args)=>{const reader=queryReader(...args);return {...reader,async search(input){enter();await waiting;return reader.search(input);}};};
  const pending=f.answer.search({query:'书架'});await entered;
  f.memory.setControl({scope:'owner',targetType:'message',targetId:'qa-user',excluded:true});release();
  const result=await pending;assert.deepEqual(result.records,[]);assert.equal(result.coverage.complete,false);
});

test('portable vectors pin the answer profile, resolve issued anchors and revalidate original evidence at delivery',async t=>{
  const firstProfile={id:'Qwen/Qwen3-Embedding-4B',revision:1,modelKey:'fixture-vector-space-one'};
  let activeProfile=firstProfile,snapshots=0,source,staleRevision=false;
  const calls=[];
  const vectors={
    async getSnapshot(input){snapshots++;calls.push({kind:'snapshot',...input});return activeProfile;},
    async query(input){
      calls.push({kind:'query',...input});
      assert.deepEqual(input.profile,{id:'Qwen/Qwen3-Embedding-4B',revision:1,modelKey:'fixture-vector-space-one'});
      assert.equal(Object.isFrozen(input.profile),true);assert.notEqual(input.profile,activeProfile);
      assert.equal(input.limit,10);assert.ok(Number.isFinite(input.deadline));assert.equal(input.signal.aborted,false);
      return {records:[{id:'vector-document',revision:staleRevision?'old-revision':'document-v1',kind:'document',domain:'document',
        text:staleRevision?'虚构旧正文':source.text,sourceStatus:{eligible:true,manualBody:true},
        anchor:{id:'vector-document',revision:staleRevision?'old-revision':'document-v1',ref:{storage:'document',id:'vector-document'}},similarity:1}]};
    },
    async resolveDocument(input){
      if(staleRevision)return null;
      return {id:'vector-document',revision:'document-v1',kind:'document',domain:'document',text:source.text,
        sourceStatus:{eligible:true,manualBody:true},anchor:{id:'vector-document',revision:'document-v1',ref:{storage:'document',id:'vector-document'}}};
    },
  };
  const f=await fixture(t,{vectors});source=f.save();
  const tools=createMemoryQueryTools({answer:()=>f.answer}),exec={agent:f.agent,signal:new AbortController().signal};
  assert.equal(snapshots,0);
  const found=await tools[0].execute({query:'搬运箱子'},exec);
  assert.deepEqual(resultIds(f.answer,found),['vector-document'],JSON.stringify(found));assert.equal(found.channels.vector.state,'ready');

  // Changing the active service profile cannot replace the encoding snapshot
  // already pinned to this answer, including an edit to the original object.
  firstProfile.revision=99;
  activeProfile={id:'Qwen/Qwen3-Embedding-0.6B',revision:2,modelKey:'fixture-vector-space-two'};
  const opened=await tools[1].execute({ref:found.records[0].ref},exec);
  assert.match(opened.records[0].label,/记忆条目/u);assert.equal(opened.records[0].text,source.text);
  staleRevision=true;
  const next=await tools[0].execute({query:'换一组线索'},exec);
  assert.deepEqual(resultIds(f.answer,next),['vector-document']);
  const staleOpen=await tools[1].execute({ref:next.records[0].ref},exec);
  assert.deepEqual(staleOpen.records,[]);assert.equal(staleOpen.channels.source.state,'source_changed');
  assert.equal(snapshots,1);assert.equal(f.grants(),1);assert.equal(f.answer.budget().calls,4);
  const grant=calls.find(call=>call.kind==='snapshot').grant;
  assert.ok(calls.every(call=>call.grant===grant));assert.equal(calls.filter(call=>call.kind==='query').length,2);
  assert.equal(f.raw.status().backend.prepared,false);
});

test('vector lane folds multi-line and padded queries the vector service would reject',async t=>{
  assert.equal(vectorQueryText('  填个表\n我全名咋写\r\n\t多大来着  '),'填个表 我全名咋写 多大来着');
  assert.equal(vectorQueryText('\n\t '),'');
  assert.equal(vectorQueryText('x'.repeat(2100)).length,2000);
});

test('search records carry a readable personal time next to epoch milliseconds',async t=>{
  const original=personalTimeZone();t.after(()=>setPersonalTimeZone(original));setPersonalTimeZone('Asia/Shanghai');
  const {localTime,VECTOR_LANE_LIMIT}=await import('../lib/memory-query.js');
  const ms=Date.UTC(2026,2,22,6,5);const text=localTime(ms);
  assert.match(text,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/u);
  assert.equal(text,'2026-03-22 14:05 +08:00');// personal zone Asia/Shanghai, independent of the host zone
  assert.equal(localTime(undefined),undefined);assert.equal(VECTOR_LANE_LIMIT,10);
});

test('records carry a label saying original or entry, speaker, progress and time',async()=>{
  const {recordLabel}=await import('../lib/memory-query.js');
  assert.match(recordLabel({kind:'original',role:'user',time:Date.UTC(2026,4,8,6)}),/^原话 · 用户说 · 2026-05-0\d /u);
  assert.equal(recordLabel({kind:'entry',type:'plan',state:{validity:'current',progress:'planned'}}),'记忆条目 · 计划（尚未发生） · 当前有效 · 依据时间 时间未知');
  assert.match(recordLabel({kind:'original',role:'user',text:'我以前的杯子是什么？  ',time:0}),/ · 当时的提问$/u);
  assert.doesNotMatch(recordLabel({kind:'original',role:'assistant',text:'你想问什么？',time:0}),/当时的提问/u);
});

test('a memory-enabled turn carries one merged answer-rules message',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'answer-guidance-')),agent=fakeAgent('guidance-session');
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecallDbPath:path.join(directory,'raw.sqlite'),
    autoRecall:false,autoCapture:false,personalRecall:false,recentContext:false,rawRecall:false});
  const notes=memoryStore({project:'main'}),grant={kind:'read',ownerSubject:'owner',project:'main',sessionId:agent.session.id,
    rootSessionId:agent.session.id,epoch:'one',signal:new AbortController().signal};
  const access={ownerSubject:'owner',ready:true,grant:()=>grant,validate:()=>true,validateMessage:()=>true,
    check:()=>({allowed:true,installed:true,epoch:'one'}),withGrant:(_grant,work)=>work(),admitMessage:()=>null,
    observe:()=>true,status:()=>({requested:false,epoch:'one'})};
  const bridge=createBridge({config,tools:notes.tools,llm:fakeLlm('{"actions":[]}'),access,findAgent:()=>agent,
    logger:{warn(){}},semanticOrganizer:false});
  t.after(async()=>{await bridge.dispose();await fs.rm(directory,{recursive:true,force:true});});
  bridge.onSessionEvent(agent.session,{type:'turn/start',data:{turn:1},seq:0,time:1000});
  const user=directUser('按规则回答。','guidance-user');
  bridge.onSessionEvent(agent.session,user);
  const decision=await runPreStep(bridge,{agent,turn:1,messages:[user.data]});
  const messages=decision.messages.filter(message=>message.source?.kind==='memory-answer-rules');
  assert.equal(messages.length,1);
  const rules=messages[0].content[0].text;
  assert.match(rules,/^<memory_answer_rules>\n当前本地时间：.+\n回答涉及用户过去说过的事时：\n/u);
  assert.doesNotMatch(rules,/<memory_clock>/u);
  for(const rule of ANSWER_RULES)assert.ok(rules.includes(rule),rule);
  assert.match(rules,/soften_memory/u);
  assert.ok(!decision.messages.some(message=>message.source?.kind==='dafeiyu-memory-control'));
});

test('memory_search description is compact and does not repeat the material rules',()=>{
  const [search]=createMemoryQueryTools({answer:()=>({})});
  assert.match(search.description,/只把结果里实际写到的内容当事实；本轮如附有记忆使用规则，照规则回答。/u);
  assert.match(search.description,/原话还是旧笔记、谁说的、何时说的/u);
  assert.match(search.description,/memory_open/u);
  assert.doesNotMatch(search.description,/correction|记忆条目/u);
  assert.match(search.description,/1K tokens/u);
  assert.ok(estimateTokens(search.description)<=200,String(estimateTokens(search.description)));
  for(const rule of ANSWER_RULES)assert.equal(search.description.includes(rule),false,rule);
  assert.doesNotMatch(ANSWER_RULES.join('\n'),/包括闲聊|说明这是建议/u);
});

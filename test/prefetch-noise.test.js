import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createMemoryEntryAccess} from '../lib/memory-entry-access.js';
import {createMemoryQueryAnswer,createMemoryQueryTools,recordLabel} from '../lib/memory-query.js';
import {selectPrefetch,shouldPrefetch} from '../lib/memory-prefetch.js';
import {resolveConfig} from '../lib/config.js';
import {memoryDirectory} from '../lib/memory.js';
import {createSessionMemory} from '../lib/session-memory.js';
import {createBridge} from '../lib/index.js';
import {memoryStore} from './fake-memory.js';
import {directUser,fakeAgent,fakeLlm} from './helpers.js';

const LEGACY_ID='legacy-noise-current';
const rerankCandidate=(id,rerank,patch={})=>({
  id,revision:1,kind:'entry',text:'rerank candidate '+id,label:'虚构重排标签',
  signals:{lexical:0,similarity:null,rerank,lanes:['vector']},
  state:{validity:'current',progress:null},...patch,
});

test('relative rerank admission keeps the top half and enforces the absolute floor',()=>{
  const records=[.9,.5,.3,.01].map((score,index)=>rerankCandidate('score-'+index,score));
  const selected=selectPrefetch({records,options:{minRerank:.02,rerankRatio:.5,rerankApplied:true,maxRecords:4}});
  assert.deepEqual(selected.lines.map(line=>line.split(' ').at(-1)),['score-0','score-1']);
  const low=[.04,.03,.015].map((score,index)=>rerankCandidate('low-'+index,score));
  const lowSelected=selectPrefetch({records:low,options:{minRerank:.02,rerankRatio:.5,rerankApplied:true,maxRecords:4}});
  assert.deepEqual(lowSelected.lines.map(line=>line.split(' ').at(-1)),['low-0','low-1']);
});

test('correction discounts both rerank floors',()=>{
  const floorSelected=selectPrefetch({records:[
    rerankCandidate('ordinary-floor',.3),
    rerankCandidate('corrected-floor',.3,{source:{changeKind:'correction'}}),
  ],options:{minRerank:.4,rerankRatio:.5,rerankApplied:true,maxRecords:4}});
  assert.deepEqual(floorSelected.lines.map(line=>line.split(' ').at(-1)),['corrected-floor']);
  assert.equal(floorSelected.stats.correction,1);

  const ratioSelected=selectPrefetch({records:[
    rerankCandidate('top',1),
    rerankCandidate('ordinary-ratio',.35),
    rerankCandidate('corrected-ratio',.35,{source:{changeKind:'correction'}}),
  ],options:{minRerank:.02,rerankRatio:.5,rerankApplied:true,maxRecords:4}});
  assert.deepEqual(ratioSelected.lines.map(line=>line.split(' ').at(-1)),['top','corrected-ratio']);
  assert.equal(ratioSelected.stats.correction,1);
});

test('historical and disputed rerank scores do not set the relative top',()=>{
  const records=[
    rerankCandidate('historical-top',1,{state:{validity:'historical'}}),
    rerankCandidate('disputed-top',1,{state:{validity:'disputed'}}),
    rerankCandidate('active-top',.6),
    rerankCandidate('active-edge',.3),
  ];
  const selected=selectPrefetch({records,options:{minRerank:.02,rerankRatio:.5,rerankApplied:true,maxRecords:4}});
  assert.deepEqual(selected.lines.map(line=>line.split(' ').at(-1)),['active-top','active-edge']);
});

test('invalid rerank ratio configuration falls back to the default',()=>{
  for(const value of [-0.1,1.1,'invalid',NaN]){
    assert.equal(resolveConfig({prefetchRerankRatio:value}).prefetchRerankRatio,.5);
  }
  assert.equal(resolveConfig({prefetchRerankRatio:0}).prefetchRerankRatio,0);
  assert.equal(resolveConfig({prefetchRerankRatio:.7}).prefetchRerankRatio,.7);
  const records=[rerankCandidate('top',.9),rerankCandidate('edge',.3)];
  const selected=selectPrefetch({records,options:{minRerank:.02,rerankRatio:-1,rerankApplied:true,maxRecords:4}});
  assert.deepEqual(selected.lines.map(line=>line.split(' ').at(-1)),['top']);
});

async function queryFixture(t,overrides={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'prefetch-noise-'));
  const memory=new RawMemoryStore(path.join(directory,'raw.sqlite'),{warn(){}});
  const notes=memoryStore({project:'main'}),agent=fakeAgent('session-prefetch-noise');
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),
    rawRecallDbPath:path.join(directory,'raw.sqlite'),rawRecall:false,autoCapture:false,recentContext:false,...overrides});
  await fs.mkdir(config.vaultPath,{recursive:true});
  const controllers=[];
  const access={
    ownerSubject:'owner',
    grant(){
      const controller=new AbortController();controllers.push(controller);
      return {kind:'read',ownerSubject:'owner',project:'main',sessionId:agent.session.id,
        rootSessionId:agent.session.id,epoch:'noise',signal:controller.signal,cancel:()=>controller.abort()};
    },
    validate:grant=>!grant.signal?.aborted,validateMessage:()=>true,assertCurrent(){},
    withGrant:(_grant,work)=>work(),
  };
  const raw=createRawRecall({config,store:memory,ownerSubject:'owner'});
  const entries=createMemoryEntryAccess({access,raw,tools:notes.tools,config});
  const answers=[];
  const answer=(options={})=>{
    const value=createMemoryQueryAnswer({access,agent,raw,entries,tools:notes.tools,config,...options});
    answers.push(value);return value;
  };
  const save=(patch={})=>{
    const sequence=patch.sequence??1,text=patch.text??'虚构原话';
    return memory.messages.record({ownerSubject:'owner',project:'main',sessionId:agent.session.id,
      messageId:patch.messageId??'message-'+sequence,role:patch.role??'user',sequence,turn:patch.turn??sequence,
      rootTurn:patch.rootTurn??patch.turn??sequence,text,content:[{type:'text',text}],time:patch.time??sequence*1000,
      authorization:{rootSessionId:agent.session.id},...patch},{authorize:()=>true}).source;
  };
  const entry=(source,proposed,operationId)=>entries.forBatch(agent,[{id:source.id,revision:source.revision}])
    .commit({operationId,sources:new Map([['s1',source]]),subjects:new Map([['owner','owner']]),proposed});
  const correction=source=>memory.messages.completeTurn({ownerSubject:'owner',project:'main',
    sessionId:agent.session.id,turn:source.turn,state:'completed',changeKind:'correction'},{authorize:()=>true});
  t.after(async()=>{
    for(const value of answers)value.dispose();
    await raw.dispose();await fs.rm(directory,{recursive:true,force:true});
  });
  return {directory,config,agent,memory,notes,access,raw,entries,answer,save,entry,correction};
}

async function writeLegacy(config,{id=LEGACY_ID,value='用户继续用靛蓝色杯子喝白茶。'}){
  const facts=memoryDirectory(config,'fact'),relative=path.join(facts,id+'.md');
  await fs.mkdir(path.join(config.vaultPath,facts),{recursive:true});
  await fs.writeFile(path.join(config.vaultPath,relative),`---
title: 虚构当前偏好
permalink: main/${facts}/${id}
memory_id: ${id}
memory_kind: fact
status: active
subject: 用户
attribute: 杯子颜色
value: ${value}
recorded_at: '2026-10-25T04:21:07.668Z'
tags:
- dsh-memory
---

<!-- dsh-fact-memory -->
# 虚构当前偏好

- [fact] ${value}
`,'utf8');
  return relative;
}

test('real retrieval folds a current entry, its source original and a similar legacy note into one slot',async t=>{
  const f=await queryFixture(t);
  const text='用户继续用靛蓝色杯子喝白茶，这是当前偏好。';
  const source=f.save({messageId:'indigo-source',text});
  await f.entry(source,{type:'preference',content:text,subject_ref:'owner',source_refs:['s1'],
    state:{validity:'current',progress:null},tags:['杯子'],
    importance:{level:'normal',basis:'user_explicit',reason:'虚构偏好'},evidence_basis:'self_report',speaker_ref:'owner'},
  'noise-entry');
  await writeLegacy(f.config,{value:text});
  const answer=f.answer({keepSignals:true});
  const found=await answer.search({query:'靛蓝色杯子喝白茶',limit:4});
  const selected=selectPrefetch({records:found.records,minSimilarity:0.45,options:{}});
  assert.equal(selected.lines.length,1,JSON.stringify(selected.stats));
  assert.match(selected.lines[0],/记忆条目/u,JSON.stringify(found.records));assert.match(selected.lines[0],/靛蓝色杯子/u);
  assert.doesNotMatch(selected.lines[0],/旧笔记/u);
  assert.ok(selected.stats.folded>=2);
});

test('historical entries are rejected and a newer correction is admitted',async t=>{
  const f=await queryFixture(t);
  const old=f.save({messageId:'old-preference',text:'很早以前记录过一条不再使用的内容。',sequence:1});
  await f.entry(old,{type:'preference',content:'用户喜欢墨绿色杯子，这是旧偏好。',subject_ref:'owner',source_refs:['s1'],
    state:{validity:'historical',progress:null},tags:['杯子'],
    importance:{level:'normal',basis:'user_explicit',reason:'虚构旧偏好'},evidence_basis:'self_report',speaker_ref:'owner'},
  'noise-historical');
  const corrected=f.save({messageId:'corrected-preference',text:'更正一下，我现在更喜欢墨绿色杯子。',
    sequence:2,time:3000,processingContext:{owner:'pipeline-v1',target:{provider:'fixture',model:'fixture'}}});
  f.save({messageId:'correction-ack',role:'assistant',text:'好的，已按更正后的偏好理解。',sequence:3,turn:2,rootTurn:2,
    time:3001,processingContext:{owner:'pipeline-v1',target:{provider:'fixture',model:'fixture'}}});
  f.correction(corrected);
  const answer=f.answer({keepSignals:true});
  const found=await answer.search({query:'墨绿色杯子偏好',limit:4});
  const selected=selectPrefetch({records:found.records,minSimilarity:0.45,options:{}});
  assert.equal(selected.lines.length,1,JSON.stringify({stats:selected.stats,records:found.records}));
  assert.match(selected.lines[0],/更正一下/u);assert.doesNotMatch(selected.lines[0],/旧偏好/u);
  assert.ok(selected.stats.correction>=1,JSON.stringify(found.records));
});

test('legacy-note and old-question labels identify provenance and past questions',async t=>{
  const f=await queryFixture(t);
  await writeLegacy(f.config,{id:'legacy-question',value:'旧笔记里保存着虚构问题'});
  const answer=f.answer({keepSignals:true});
  const found=await answer.search({query:'虚构问题',limit:4});
  const record=found.records.find(item=>answer.resolve(item.ref)?.id?.startsWith('legacy-note:'));
  assert.ok(record,JSON.stringify(found));assert.match(record.label,/^旧笔记（未迁移）/u);
  assert.match(recordLabel({kind:'original',role:'user',text:'我以前的杯子是什么？'}),/ · 当时的提问$/u);
  f.save({messageId:'old-question',sequence:2,text:'我以前是不是说过靛蓝色杯子？'});
  const questionAnswer=f.answer({keepSignals:true});
  const questionFound=await questionAnswer.search({query:'靛蓝色杯子',limit:4});
  const question=selectPrefetch({records:questionFound.records,minSimilarity:.45,options:{}});
  assert.equal(question.lines.length,1,JSON.stringify(question.stats));
  assert.match(question.lines[0],/当时的提问/u);
});

test('relevance signals merge text and vector lanes and use the complete body before excerpting',async t=>{
  const f=await queryFixture(t);
  const source=f.save({messageId:'signal-source',text:'背景描述'.repeat(300)+'靛蓝色杯子放在书桌'});
  const row={...source,similarity:.77,score:.77,anchor:{id:source.id,revision:source.revision,ref:source.ref}};
  const vectors={async getSnapshot(){return {id:'fixture',revision:'v1'};},
    async query(){return {records:[row]};}};
  const answer=f.answer({vectors,keepSignals:true});
  const found=await answer.search({query:'靛蓝色杯子',limit:4});
  const record=found.records.find(item=>answer.resolve(item.ref)?.id===source.id);
  assert.ok(record,JSON.stringify(found));
  assert.equal(record.signals.lexical,1);assert.equal(record.signals.similarity,.77);
  assert.deepEqual(record.signals.lanes,['text','vector']);assert.equal(record.signals.rerank,null);
});

test('weak vector candidates remain visible to memory_search but automatic prefetch gates them',async t=>{
  const row={id:'weak-vector',revision:'v1',kind:'entry',text:'这是一条弱相关的虚构向量候选',
    similarity:.5,state:{validity:'current',progress:null},sourceStatus:{eligible:true,manualBody:true},
    anchor:{id:'weak-vector',revision:'v1',ref:{storage:'entry',id:'weak-vector'}}};
  const vectors={async getSnapshot(){return {id:'fixture',revision:'v1'};},
    async query(){return {records:[row]};}};
  const f=await queryFixture(t),answer=f.answer({vectors,keepSignals:true});
  const found=await answer.search({query:'解释一下快速排序',limit:4});
  assert.ok(found.records.some(record=>answer.resolve(record.ref)?.id===row.id),JSON.stringify(found));
  const selected=selectPrefetch({records:found.records,minSimilarity:.45,options:{}});
  assert.deepEqual(selected.lines,[]);assert.equal(selected.stats.admitted,0);
  const publicAnswer=f.answer({vectors});
  const tools=createMemoryQueryTools({answer:()=>publicAnswer});
  const searched=await tools[0].execute({query:'解释一下快速排序'},{agent:f.agent,signal:new AbortController().signal});
  assert.ok(searched.records.some(record=>publicAnswer.resolve(record.ref)?.id===row.id));
  assert.equal(JSON.stringify(searched).includes('"signals"'),false);
  assert.equal(JSON.stringify(searched).includes('"_signals"'),false);
});

function fakeReranker(scoreDocument,{fail=false}={}){
  const calls=[];
  return {calls,enabled:()=>true,status:()=>({enabled:true,state:'ready'}),
    async rerank({documents}){
      calls.push(documents);
      if(fail)throw Object.assign(Error('fixture timeout'),{code:'RERANK_TIMEOUT'});
      return documents.map((document,index)=>({index,score:scoreDocument(document,index)}));
    }};
}

test('one prefetch rerank uses the configured candidate and text limits and keeps absolute scores',async t=>{
  const f=await queryFixture(t,{prefetchRerankCandidates:4});
  for(let index=1;index<6;index++)f.save({messageId:'rerank-'+index,sequence:index,
    text:`虚构排序普通候选 ${index} ${'短'.repeat(20)}`});
  f.save({messageId:'rerank-target',sequence:6,text:'虚构排序目标青瓷杯 '+'长'.repeat(650)});
  const reranker=fakeReranker(document=>document.includes('目标青瓷杯')?.9:.1);
  const answer=f.answer({reranker,keepSignals:true,searchKind:'prefetch'});
  const found=await answer.search({query:'虚构排序',limit:4});
  assert.equal(reranker.calls.length,1);assert.equal(reranker.calls[0].length,4);
  assert.ok(reranker.calls[0].every(document=>Array.from(document).length<=500));
  const scored=found.records.find(record=>record.text.includes('目标青瓷杯'));
  assert.ok(scored,JSON.stringify(found.records));assert.equal(scored.signals.rerank,.9);assert.deepEqual(scored.signals.lanes,['text']);
  const selected=selectPrefetch({records:found.records,minSimilarity:.45,
    options:{rerankApplied:found.channels.rerank.state==='applied',minRerank:.35}});
  assert.equal(selected.lines.length,1,JSON.stringify(selected.stats));assert.match(selected.lines[0],/目标青瓷杯/u);
  const publicAnswer=f.answer({reranker});
  const tools=createMemoryQueryTools({answer:()=>publicAnswer});
  const searched=await tools[0].execute({query:'虚构排序'},{agent:f.agent,signal:new AbortController().signal});
  assert.equal(JSON.stringify(searched).includes('"signals"'),false);
  assert.equal(JSON.stringify(searched).includes('"_signals"'),false);
});

test('rerank failure falls back to lexical admission and still injects a strong record',async t=>{
  const f=await queryFixture(t,{prefetchRerankCandidates:4});
  f.save({messageId:'fallback-target',text:'虚构回退目标青瓷杯放在书桌上'});
  f.save({messageId:'fallback-other',sequence:2,text:'虚构回退普通候选放在窗台边'});
  const reranker=fakeReranker(()=>0,{fail:true});
  const answer=f.answer({reranker,keepSignals:true,searchKind:'prefetch'});
  const found=await answer.search({query:'虚构回退目标青瓷杯',limit:4});
  assert.equal(found.channels.rerank.state,'timeout');
  const selected=selectPrefetch({records:found.records,minSimilarity:.45,
    options:{rerankApplied:found.channels.rerank.state==='applied',minRerank:.35}});
  assert.equal(reranker.calls.length,1);assert.equal(selected.lines.length,1);
  assert.match(selected.lines[0],/回退目标青瓷杯/u);
});

async function bridgeFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'prefetch-message-'));
  const agents=new Map(),sessions=new Map(),agent=fakeAgent('session-prefetch-message');
  const events=[];
  Object.defineProperty(agent.session,'seq',{get:()=>events.length});
  agent.session.log=events;
  agent.session.snapshotEvents=(from=0,to=events.length)=>events.slice(from,to);
  agents.set(agent.session.id,agent);sessions.set(agent.session.id,agent.session);
  const access=await createSessionMemory({directory,ownerSubject:'owner',
    agents:{get:id=>agents.get(id),list:()=>[...agents.values()],isOwnedBy:()=>false},
    sessions:{get:id=>sessions.get(id)},logger:{warn(){}}});
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),
    rawRecall:false,autoRecall:true,autoCapture:false,recentContext:false});
  await fs.mkdir(config.vaultPath,{recursive:true});await access.set(agent.session.id,true);
  const bridge=createBridge({config,tools:memoryStore({project:'main'}).tools,llm:fakeLlm('{"actions":[]}'),
    access,findAgent:id=>id===agent.session.id?agent:undefined,logger:{warn(){}},semanticOrganizer:false});
  t.after(async()=>{await bridge.dispose();access.close();await fs.rm(directory,{recursive:true,force:true});});
  const prepare=async(turn,text)=>{
    const event={type:'turn/start',seq:turn-1,time:Date.now(),data:{turn}};
    events.push(event);
    access.observe(agent.session,event);bridge.onSessionEvent(agent.session,event);
    const user=directUser(text,'message-'+turn);
    return bridge.onPreStep({agent,turn,step:1,messages:[user],signal:new AbortController().signal},
      async()=>({kind:'enter',messages:[user]}));
  };
  return {bridge,processor:prepare};
}

test('unrelated and trivial turns attach rules but never attach a prefetch message',async t=>{
  const f=await bridgeFixture(t);
  const unrelated=await f.processor(1,'解释一下快速排序');
  assert.ok(!unrelated.messages.some(message=>message.source?.kind==='memory-prefetch'));
  const unrelatedSummary=(await f.bridge.getMemoryRuntime()).searches.find(row=>row.kind==='prefetch'&&row.outcome);
  assert.ok(['gated','empty'].includes(unrelatedSummary?.outcome),JSON.stringify(await f.bridge.getMemoryRuntime()));
  const trivial=await f.processor(2,'好的');
  assert.ok(!trivial.messages.some(message=>message.source?.kind==='memory-prefetch'));
  const trivialSummary=(await f.bridge.getMemoryRuntime()).searches.find(row=>row.kind==='prefetch'&&row.outcome==='skipped');
  assert.equal(trivialSummary?.reason,'trivial');assert.deepEqual(shouldPrefetch('好的'),{ok:false,reason:'trivial'});
});

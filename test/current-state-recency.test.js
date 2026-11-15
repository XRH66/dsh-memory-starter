import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {applyInheritRecords} from '../lib/inherit/importer.js';
import {resolveConfig} from '../lib/config.js';
import {
  ASSISTANT_RANK_WEIGHT,
  CURRENT_STATE_RECENCY_BOOST,
  CURRENT_STATE_TERMS,
  SUMMARY_RERANK_WEIGHT,
  createMemoryQueryAnswer,
  isCurrentStateQuery,
  selectPrefetch,
} from '../lib/memory-query.js';
import {fakeAgent} from './helpers.js';

const resultIds=(answer,result)=>result.records.map(record=>answer.resolve(record.ref)?.id);

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'current-state-recency-'));
  const memory=new RawMemoryStore(path.join(directory,'raw.sqlite'),{warn(){}});
  const agent=fakeAgent('session-current-state-recency');
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),
    rawRecallDbPath:path.join(directory,'raw.sqlite'),rawRecall:false,autoCapture:false,recentContext:false});
  await fs.mkdir(config.vaultPath,{recursive:true});
  const controllers=[],answers=[];
  const access={
    ownerSubject:'owner',
    grant(){
      const controller=new AbortController();controllers.push(controller);
      return {kind:'read',ownerSubject:'owner',project:'main',sessionId:agent.session.id,
        rootSessionId:agent.session.id,epoch:'current-state-recency',signal:controller.signal,
        cancel:()=>controller.abort()};
    },
    validate:grant=>!grant.signal?.aborted,
    validateMessage:()=>true,
    assertCurrent(){},
    withGrant:(_grant,work)=>work(),
  };
  const raw=createRawRecall({config,store:memory,ownerSubject:'owner'});
  const vectorService=records=>({
    async getSnapshot(){return {id:'current-state-fixture',revision:'v1'};},
    async query(){return {records:records.map(record=>({...record})),state:'ready'};},
  });
  const answer=({vectorRecords,...options}={})=>{
    const value=createMemoryQueryAnswer({access,agent,raw,config,...options,
      ...(vectorRecords?{vectors:vectorService(vectorRecords)}:{})});
    answers.push(value);
    return value;
  };
  const save=(patch={})=>{
    const sequence=patch.sequence??1,text=patch.text??'虚构原话',turn=patch.turn??sequence;
    return memory.messages.record({
      ownerSubject:'owner',project:'main',sessionId:agent.session.id,messageId:patch.messageId??'message-'+sequence,
      role:patch.role??'user',sequence,turn,rootTurn:patch.rootTurn??turn,text,
      content:[{type:'text',text}],time:patch.time??sequence*1000,
      authorization:{rootSessionId:agent.session.id},...patch,
    },{authorize:()=>true}).source;
  };
  t.after(async()=>{
    for(const value of answers)value.dispose();
    await raw.dispose();
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {directory,config,agent,memory,access,raw,answer,save};
}

function originalCandidate(source,{weight=1,...patch}={}){
  return {
    id:source.id,revision:source.revision,kind:'original',role:source.role,text:source.text,
    time:source.time,weight,similarity:.9,
    anchor:{id:source.id,revision:source.revision,
      ref:source.ref??{storage:'message',id:source.id,revision:source.revision}},
    ...patch,
  };
}

function prefetchOriginal(text,time){
  return {
    kind:'original',role:'user',text,
    ...(time===undefined?{}:{time}),
    signals:{lexical:1,similarity:null,lanes:['text']},
  };
}

test('current-state terms are exact and query detection normalizes without tokenization',()=>{
  assert.deepEqual(CURRENT_STATE_TERMS,[
    '现在','目前','如今','眼下','当前','最近','近来','近况','最新','后来','至今',
    '这阵子','这段时间','这些天','这几天',
  ]);
  for(const term of CURRENT_STATE_TERMS)assert.equal(isCurrentStateQuery(`她还${term}住那里`),true);
  assert.equal(isCurrentStateQuery('她现在住哪'),true);
  assert.equal(isCurrentStateQuery('最近怎么样'),true);
  assert.equal(isCurrentStateQuery('后来呢'),true);
  assert.equal(isCurrentStateQuery('你还记得我养的猫吗'),false);
  assert.equal(isCurrentStateQuery('上次说的那本书'),false);
  assert.equal(isCurrentStateQuery(''),false);
  assert.equal(isCurrentStateQuery(null),false);
  assert.equal(isCurrentStateQuery(undefined),false);
});

test('current-state search boosts the newer original to 1.2 times its base rank',async t=>{
  const f=await fixture(t);
  const old=f.save({messageId:'old-home',sequence:1,turn:1,time:1000,text:'北门旧宅记录甲。'});
  const recent=f.save({messageId:'new-home',sequence:2,turn:2,time:2000,text:'南门新居记录乙。'});
  const probe={id:'rank-probe',revision:'v1',kind:'document',domain:'document',text:'基础排名边界记录。',time:1500,
    sourceStatus:{eligible:true,manualBody:true},
    anchor:{id:'rank-probe',revision:'v1',ref:{storage:'document',id:'rank-probe'}}};
  const candidates=[originalCandidate(old,{weight:1.1}),originalCandidate(recent,{weight:1}),
    {...probe,weight:1.05}];
  const baseOld=1.1/61,baseRecent=1/62;
  assert.ok(baseOld>baseRecent&&baseOld/baseRecent<1.2);
  assert.ok(1.05/63>baseRecent&&1.05/63<baseOld);

  const answer=f.answer({vectorRecords:candidates});
  const found=await answer.search({query:'她现在住哪',limit:3});
  assert.equal(CURRENT_STATE_RECENCY_BOOST,.2);
  assert.deepEqual(resultIds(answer,found),[recent.id,old.id,probe.id]);
});

test('ordinary search retains the pre-change fused order and ranks',async t=>{
  const f=await fixture(t);
  const old=f.save({messageId:'plain-old',sequence:1,turn:1,time:1000,text:'北门旧宅记录甲。'});
  const recent=f.save({messageId:'plain-new',sequence:2,turn:2,time:2000,text:'南门新居记录乙。'});
  const probe={id:'plain-probe',revision:'v1',kind:'document',domain:'document',text:'基础排名边界记录。',time:1500,
    sourceStatus:{eligible:true,manualBody:true},weight:1.05,
    anchor:{id:'plain-probe',revision:'v1',ref:{storage:'document',id:'plain-probe'}}};
  const candidates=[originalCandidate(old,{weight:1.1}),originalCandidate(recent,{weight:1}),probe];
  const answer=f.answer({vectorRecords:candidates});
  const found=await answer.search({query:'她住在哪里',limit:3});

  assert.deepEqual(resultIds(answer,found),[old.id,probe.id,recent.id]);
});

test('summaries, persona documents, undated imports and a lone timed original are not boosted',async t=>{
  const f=await fixture(t);
  const old=f.save({messageId:'boundary-old',sequence:1,turn:1,time:1000,text:'北门旧宅记录甲。'});
  const recent=f.save({messageId:'boundary-new',sequence:2,turn:2,time:3000,text:'南门新居记录乙。'});
  const imported=applyInheritRecords({
    store:f.memory,scope:'owner',batchId:'current-state-notes',
    source:{kind:'file',path:'fictional-current-state.jsonl'},clock:()=>5000,
    records:[
      {id:'dated-summary',time:'2026-10-20T10:00:00Z',speaker:'summary',kind:'note',
        text:'旧笔记甲：这条有日期。',source:{system:'fictional-import',file:'dated.md'}},
      {id:'undated-summary',speaker:'summary',kind:'note',
        text:'旧笔记乙：这条没有日期。',source:{system:'fictional-import',file:'undated.md'}},
    ],
  });
  assert.equal(imported.inserted,2);
  const reader=f.raw.queryReader({ownerSubject:'owner',project:'main'},{authorize:()=>true});
  const importedSources=reader.search({query:'旧笔记',limit:10}).sources;
  const datedSummary=importedSources.find(source=>source.text.includes('旧笔记甲'));
  const undatedSummary=importedSources.find(source=>source.text.includes('旧笔记乙'));
  assert.ok(datedSummary&&undatedSummary);
  const persona={id:'persona-current-state',revision:'v1',kind:'document',domain:'thoughts',role:'assistant',
    text:'人设资料标记，只有想法。',time:4000,sourceStatus:{eligible:true,manualBody:true},
    anchor:{id:'persona-current-state',revision:'v1',ref:{storage:'document',id:'persona-current-state'}}};
  const candidates=[
    originalCandidate(old),originalCandidate(recent),originalCandidate(datedSummary),
    originalCandidate(undatedSummary),persona,
  ];
  const answer=f.answer({vectorRecords:candidates});
  const found=await answer.search({query:'目前状态如何',limit:5});
  assert.equal(SUMMARY_RERANK_WEIGHT,.7);
  assert.deepEqual(resultIds(answer,found),[recent.id,old.id,persona.id,datedSummary.id,undatedSummary.id]);

  const single=f.answer({vectorRecords:[persona,originalCandidate(recent)]});
  const singleFound=await single.search({query:'这几天怎么样',limit:2});
  assert.deepEqual(resultIds(single,singleFound),[persona.id,recent.id]);
});

test('current-state recency composes with the existing assistant rank weight',async t=>{
  const f=await fixture(t);
  const old=f.save({messageId:'assistant-old',sequence:1,turn:1,time:1000,role:'assistant',
    text:'北门旧宅助手记录。'});
  const recent=f.save({messageId:'assistant-new',sequence:2,turn:2,time:2000,role:'assistant',
    text:'南门新居助手记录。'});
  const candidates=[originalCandidate(old,{weight:1.1}),originalCandidate(recent,{weight:1})];
  const answer=f.answer({vectorRecords:candidates});
  const found=await answer.search({query:'现在怎么样',limit:2});
  assert.deepEqual(resultIds(answer,found),[recent.id,old.id]);
  assert.equal(ASSISTANT_RANK_WEIGHT,.5);
  assert.ok(found.records.every(record=>/助手说/u.test(record.label)));
});

test('recency reordering does not change the automatic-prefetch admission set',async t=>{
  const f=await fixture(t);
  const old=f.save({messageId:'admission-old',sequence:1,turn:1,time:1000,text:'北门旧宅记录甲。'});
  const recent=f.save({messageId:'admission-new',sequence:2,turn:2,time:2000,text:'南门新居记录乙。'});
  const candidates=[originalCandidate(old,{weight:1.1}),originalCandidate(recent,{weight:1})];
  const current=f.answer({vectorRecords:candidates,searchKind:'prefetch',keepSignals:true});
  const plain=f.answer({vectorRecords:candidates,searchKind:'prefetch',keepSignals:true});
  const currentFound=await current.search({query:'这条消息目前说什么',limit:2});
  const plainFound=await plain.search({query:'这条消息说什么',limit:2});
  const currentSelected=selectPrefetch({records:currentFound.records,options:{maxRecords:3,minLexical:0}});
  const plainSelected=selectPrefetch({records:plainFound.records,options:{maxRecords:3,minLexical:0}});

  assert.equal(currentSelected.stats.admitted,plainSelected.stats.admitted);
  assert.deepEqual([...currentSelected.lines].sort(),[...plainSelected.lines].sort());
});

test('prefetch keeps rank-based admission and limits, then sorts selected lines oldest first',()=>{
  const ranked=[
    prefetchOriginal('第三时间',3000),
    prefetchOriginal('第一时间',1000),
    prefetchOriginal('第二时间',2000),
  ];
  const selected=selectPrefetch({records:ranked,options:{maxRecords:3,minLexical:0,maxChars:1000}});
  assert.deepEqual(selected.lines,['- [记忆] 第一时间','- [记忆] 第二时间','- [记忆] 第三时间']);

  const undated=[
    prefetchOriginal('无时间甲'),
    prefetchOriginal('晚时间乙',2000),
    prefetchOriginal('无时间丙'),
    prefetchOriginal('早时间丁',1000),
  ];
  const undatedSelected=selectPrefetch({records:undated,options:{maxRecords:4,minLexical:0,maxChars:1000}});
  assert.deepEqual(undatedSelected.lines,['- [记忆] 无时间甲','- [记忆] 无时间丙','- [记忆] 早时间丁','- [记忆] 晚时间乙']);

  const tied=[prefetchOriginal('同时间甲',2000),prefetchOriginal('同时间乙',2000)];
  assert.deepEqual(selectPrefetch({records:tied,options:{maxRecords:2,minLexical:0,maxChars:1000}}).lines,
    ['- [记忆] 同时间甲','- [记忆] 同时间乙']);

  const capped=[
    prefetchOriginal('新记录',3000),
    prefetchOriginal('旧记录',1000),
    prefetchOriginal('低排名',2000),
  ];
  const cappedSelected=selectPrefetch({records:capped,options:{maxRecords:3,minLexical:0,maxChars:20}});
  assert.deepEqual(cappedSelected.lines,['- [记忆] 旧记录','- [记忆] 新记录']);
  assert.deepEqual(cappedSelected.stats,{
    candidates:3,admitted:3,rejected:0,folded:0,injected:2,chars:20,assistantSkipped:0,
    lexical:3,vector:0,agree:0,
  });
});

test('search summaries mark current-state handling without reporting the query text',async t=>{
  const f=await fixture(t);
  f.save({messageId:'report-source',sequence:1,text:'周末整理书架。'});
  const currentReports=[],plainReports=[];
  const current=f.answer({onSearch:row=>currentReports.push(row)});
  const plain=f.answer({onSearch:row=>plainReports.push(row)});
  await current.search({query:'最近怎么样'});
  await plain.search({query:'书架怎么样'});

  assert.equal(currentReports.length,1);
  assert.equal(plainReports.length,1);
  assert.equal(currentReports[0].currentState,true);
  assert.equal(plainReports[0].currentState,false);
  assert.equal(Object.hasOwn(currentReports[0],'query'),false);
  assert.equal(Object.hasOwn(plainReports[0],'query'),false);
});

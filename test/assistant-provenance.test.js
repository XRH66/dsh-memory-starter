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
  SUMMARY_RERANK_WEIGHT,
  createMemoryQueryAnswer,
  selectPrefetch,
} from '../lib/memory-query.js';
import {fakeAgent} from './helpers.js';

const resultIds=(answer,result)=>result.records.map(record=>answer.resolve(record.ref)?.id);

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'assistant-provenance-'));
  const memory=new RawMemoryStore(path.join(directory,'raw.sqlite'),{warn(){}});
  const agent=fakeAgent('session-assistant-provenance');
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),
    rawRecallDbPath:path.join(directory,'raw.sqlite'),rawRecall:false,autoCapture:false,recentContext:false});
  await fs.mkdir(config.vaultPath,{recursive:true});
  const controllers=[];
  const access={
    ownerSubject:'owner',
    grant(){
      const controller=new AbortController();controllers.push(controller);
      return {kind:'read',ownerSubject:'owner',project:'main',sessionId:agent.session.id,
        rootSessionId:agent.session.id,epoch:'assistant-provenance',signal:controller.signal,
        cancel:()=>controller.abort()};
    },
    validate:grant=>!grant.signal?.aborted,
    validateMessage:()=>true,
    assertCurrent(){},
    withGrant:(_grant,work)=>work(),
  };
  const raw=createRawRecall({config,store:memory,ownerSubject:'owner'});
  const answers=[];
  const answer=(options={})=>{
    const value=createMemoryQueryAnswer({access,agent,raw,config,...options});
    answers.push(value);
    return value;
  };
  const save=(patch={})=>{
    const sequence=patch.sequence??1,text=patch.text??'虚构原话',turn=patch.turn??sequence,
      sessionId=patch.sessionId??agent.session.id;
    return memory.messages.record({
      ownerSubject:'owner',project:'main',sessionId,messageId:patch.messageId??'message-'+sequence,
      role:patch.role??'user',sequence,turn,rootTurn:patch.rootTurn??turn,text,
      content:[{type:'text',text}],time:patch.time??sequence*1000,
      authorization:{rootSessionId:sessionId},...patch,
    },{authorize:()=>true}).source;
  };
  t.after(async()=>{
    for(const value of answers)value.dispose();
    await raw.dispose();
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {directory,config,agent,memory,access,raw,answer,save};
}

test('user originals rank before equally matching assistant originals and assistant weight is one half',async t=>{
  const f=await fixture(t);
  const user=f.save({messageId:'rank-user',sequence:1,turn:1,time:1000,
    text:'青瓷灯标记：用户确认书架周末整理。'});
  const assistant=f.save({messageId:'rank-assistant',sequence:2,turn:2,time:2000,role:'assistant',
    text:'青瓷灯标记：助手当时建议先量尺寸。'});
  const answer=f.answer();
  const found=await answer.search({query:'青瓷灯标记',limit:4});

  assert.equal(ASSISTANT_RANK_WEIGHT,.5);
  assert.deepEqual(resultIds(answer,found),[user.id,assistant.id]);
  assert.match(found.records[0].label,/用户说/u);
  assert.match(found.records[1].label,/助手说/u);
});

test('same-turn assistant vectors without source metadata fold into the user row and use the highest-ranked reply',async t=>{
  const f=await fixture(t);
  const marker='琥珀尺标记';
  const user=f.save({messageId:'paired-user',sequence:1,turn:12,time:12000,text:marker+'：用户决定先量书架。'});
  const firstReply=marker+'：'+('先量书架再定位置。'.repeat(20));
  const secondReply=marker+'：这条回复排名较低，不应挂到用户记录上。';
  const first=f.save({messageId:'paired-assistant-first',sequence:2,turn:12,time:12001,
    role:'assistant',text:firstReply});
  const second=f.save({messageId:'paired-assistant-second',sequence:3,turn:12,time:12002,
    role:'assistant',text:secondReply});
  const vectorRecord=(source,weight=1)=>({id:source.id,revision:source.revision,kind:'original',role:'assistant',
    text:source.text,time:source.time,weight,similarity:.9,
    anchor:{id:source.id,revision:source.revision,
      ref:{storage:'message',id:source.id,revision:source.revision}}});
  const vectors={
    async getSnapshot(){return {id:'assistant-fixture',revision:'v1'};},
    async query(){return {records:[vectorRecord(first,2),vectorRecord(second)],state:'ready'};},
  };
  const answer=f.answer({vectors});
  const found=await answer.search({query:marker,limit:4});

  assert.equal(found.records.length,1,JSON.stringify(found));
  const record=found.records[0],location=answer.resolve(record.ref);
  assert.equal(location.id,user.id);
  assert.equal(location.revision,user.revision);
  assert.equal(record.text,user.text);
  assert.match(record.label,/用户说/u);
  assert.equal(Object.hasOwn(record,'assistantReply'),false);
  const reply=record['同一回合助手的回复'];
  assert.equal(typeof reply,'object');
  assert.equal(reply.label,record.label.replace('用户说','助手说'));
  assert.match(reply.label,/助手说/u);
  assert.notEqual(reply.label,record.label);
  assert.equal(Object.hasOwn(reply,'text'),true);
  assert.equal(Array.from(reply.text).length,121);
  assert.equal(reply.text,Array.from(firstReply).slice(0,120).join('')+'…');

  const opened=await answer.expand({ref:record.ref});
  assert.deepEqual(opened.records.map(item=>item.label.match(/(用户说|助手说)/u)?.[0]),
    ['用户说','助手说','助手说']);
});

test('pairing stays inside one session and turn and leaves an assistant standalone when its user does not match',async t=>{
  const f=await fixture(t);
  const sameSessionUser=f.save({messageId:'split-user',sequence:1,turn:20,text:'分轮甲乙丙丁：用户原话。'});
  const sameSessionAssistant=f.save({messageId:'split-assistant',sequence:2,turn:21,time:21000,
    role:'assistant',text:'分轮甲乙丙丁：助手另一轮回复。'});
  const crossSessionUser=f.save({messageId:'cross-user',sequence:3,turn:30,time:30000,
    sessionId:'session-cross-a',text:'跨会戊己庚辛：用户原话。'});
  const crossSessionAssistant=f.save({messageId:'cross-assistant',sequence:4,turn:30,time:31000,
    sessionId:'session-cross-b',role:'assistant',text:'跨会戊己庚辛：助手另一会话回复。'});
  const loneUser=f.save({messageId:'lone-user',sequence:5,turn:40,time:40000,
    text:'用户这条正文不包含查询词。'});
  const loneAssistant=f.save({messageId:'lone-assistant',sequence:6,turn:40,time:41000,
    role:'assistant',text:'单独壬癸子丑：助手原话仍应出现。'});
  const answer=f.answer();

  const split=await answer.search({query:'分轮甲乙丙丁',limit:4});
  assert.deepEqual(new Set(resultIds(answer,split)),new Set([sameSessionUser.id,sameSessionAssistant.id]));
  assert.ok(split.records.every(record=>!Object.hasOwn(record,'同一回合助手的回复')));

  const cross=await answer.search({query:'跨会戊己庚辛',limit:4});
  assert.deepEqual(new Set(resultIds(answer,cross)),new Set([crossSessionUser.id,crossSessionAssistant.id]));
  assert.ok(cross.records.every(record=>!Object.hasOwn(record,'同一回合助手的回复')));

  const lone=await answer.search({query:'单独壬癸子丑',limit:4});
  assert.deepEqual(resultIds(answer,lone),[loneAssistant.id]);
  assert.match(lone.records[0].label,/助手说/u);
  assert.ok(!resultIds(answer,lone).includes(loneUser.id));
});

test('an assistant that fails current source validation is not attached',async t=>{
  const f=await fixture(t);
  const marker='失效来源标记';
  const user=f.save({messageId:'invalid-user',sequence:1,turn:50,time:50000,text:marker+'：用户正文有效。'});
  const assistant=f.save({messageId:'invalid-assistant',sequence:2,turn:50,time:50001,
    role:'assistant',text:'助手正文不匹配这个查询。'});
  const stale={id:assistant.id,revision:assistant.revision,kind:'original',role:'assistant',
    text:marker+'：向量候选存在但来源版本已经失效。',time:assistant.time,weight:1,similarity:.9,
    anchor:{id:assistant.id,revision:assistant.revision,
      ref:{storage:'message',id:assistant.id,revision:'stale-revision'}}};
  const vectors={
    async getSnapshot(){return {id:'assistant-fixture',revision:'v1'};},
    async query(){return {records:[stale],state:'ready'};},
  };
  const answer=f.answer({vectors});
  const found=await answer.search({query:marker,limit:4});

  assert.deepEqual(resultIds(answer,found),[user.id]);
  assert.equal(Object.hasOwn(found.records[0],'同一回合助手的回复'),false);
});

test('prefetch skips standalone assistant originals and never emits the paired reply',async t=>{
  const f=await fixture(t);
  const loneMarker='ONLY-ORANGE-ALPHA';
  f.save({messageId:'prefetch-lone-assistant',sequence:1,turn:60,time:60000,
    role:'assistant',text:loneMarker+'：单独助手原话。'});
  const loneAnswer=f.answer({keepSignals:true,searchKind:'prefetch'});
  const loneFound=await loneAnswer.search({query:loneMarker,limit:4});
  const loneSelected=selectPrefetch({records:loneFound.records,minSimilarity:.45,
    options:{maxRecords:3,minLexical:0}});
  assert.deepEqual(loneSelected.lines,[]);
  assert.equal(loneSelected.stats.assistantSkipped,1);
  assert.equal(loneSelected.stats.candidates,0);

  const pairMarker='PAIR-INDIGO-BETA';
  f.save({messageId:'prefetch-pair-user',sequence:2,turn:61,time:61000,text:pairMarker+'：用户原话。'});
  f.save({messageId:'prefetch-pair-assistant',sequence:3,turn:61,time:61001,
    role:'assistant',text:pairMarker+'：助手回复只作为配对上下文。'});
  const pairAnswer=f.answer({keepSignals:true,searchKind:'prefetch'});
  const pairFound=await pairAnswer.search({query:pairMarker,limit:4});
  assert.equal(pairFound.records.length,1);
  assert.match(pairFound.records[0]['同一回合助手的回复'].text,/助手回复只作为配对上下文/u);
  const pairSelected=selectPrefetch({records:pairFound.records,minSimilarity:.45,
    options:{maxRecords:3,minLexical:0}});
  assert.deepEqual(pairSelected.lines,[`- [${pairFound.records[0].label}] ${pairFound.records[0].text}`]);
  assert.equal(pairSelected.lines[0].includes('助手回复只作为配对上下文'),false);
  assert.equal(pairSelected.stats.assistantSkipped,0);
});

test('imported notes and persona documents do not pair and keep their existing ranking weights',async t=>{
  const f=await fixture(t);
  const marker='人设资料边界标记';
  const imported=applyInheritRecords({
    store:f.memory,scope:'owner',batchId:'assistant-provenance-notes',
    source:{kind:'file',path:'fictional-source.jsonl'},clock:()=>1000,
    records:[{id:'old-summary',time:'2026-10-20T10:00:00Z',speaker:'summary',kind:'note',
      text:marker+'：旧笔记摘要正文。',source:{system:'fictional-import',file:'old-summary.md'}}],
  });
  assert.equal(imported.inserted,1);
  const user=f.save({messageId:'persona-user',sequence:1,turn:70,time:70000,
    text:marker+'：用户原话。'});
  const persona={id:'persona-document',revision:'v1',kind:'document',domain:'thoughts',role:'assistant',
    text:marker+'：助手自己的想法。',time:71000,sourceStatus:{eligible:true,manualBody:true},
    anchor:{id:'persona-document',revision:'v1',ref:{storage:'document',id:'persona-document'}}};
  const vectors={
    async getSnapshot(){return {id:'assistant-fixture',revision:'v1'};},
    async query(){return {records:[persona],state:'ready'};},
  };
  const answer=f.answer({vectors});
  const found=await answer.search({query:marker,limit:4}),ids=resultIds(answer,found);

  assert.equal(SUMMARY_RERANK_WEIGHT,.7);
  assert.ok(ids.includes(user.id)&&ids.includes(persona.id));
  assert.ok(ids.indexOf(persona.id)<ids.indexOf(user.id),JSON.stringify(found.records));
  assert.ok(found.records.every(record=>!Object.hasOwn(record,'同一回合助手的回复')));
  const summaryRecord=found.records.find(record=>/旧笔记（整理摘要）/u.test(record.label));
  assert.ok(summaryRecord);
});

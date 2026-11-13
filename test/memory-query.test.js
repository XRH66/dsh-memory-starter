import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createMemoryEntryAccess} from '../lib/memory-entry-access.js';
import {ANSWER_RULES,createMemoryQueryAnswer,createMemoryQueryTools,createMemoryReferenceLoader,vectorQueryText} from '../lib/memory-query.js';
import {createBridge} from '../lib/index.js';
import {createUnifiedProfiles} from '../lib/unified/profiles.js';
import {resolveConfig} from '../lib/config.js';
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
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecall:false}),notes=memoryStore({project:'main'}),agent=fakeAgent('session-query');
  let enabled=true,grants=0;const controllers=[];
  const access={ownerSubject:'owner',grant(){grants++;const controller=new AbortController();controllers.push(controller);return {kind:'read',ownerSubject:'owner',project:'main',sessionId:agent.session.id,rootSessionId:agent.session.id,epoch:'one',signal:controller.signal,cancel:()=>controller.abort()};},
    validate:grant=>enabled&&!grant.signal?.aborted,validateMessage:()=>enabled,assertCurrent(){if(!enabled)throw Error('closed');},withGrant:(_grant,work)=>work()};
  const raw=createRawRecall({config,store:memory,ownerSubject:'owner'}),entries=createMemoryEntryAccess({access,raw,tools:notes.tools,config});
  const source=({text='只有周末有空才整理书架。',content=[{type:'text',text}],...patch}={})=>({ownerSubject:'owner',project:'main',sessionId:agent.session.id,messageId:'qa-user',role:'user',sequence:1,turn:1,rootTurn:1,
    text,content,time:1000,authorization:{rootSessionId:agent.session.id},...patch});
  const save=patch=>memory.messages.record(source(patch),{authorize:()=>enabled}).source;
  const answer=createMemoryQueryAnswer({access,agent,raw,entries,tools:notes.tools,config,...options});
  t.after(async()=>{answer.dispose();await raw.dispose();await fs.rm(directory,{recursive:true,force:true});});
  return {answer,save,raw,memory,access,agent,entries,notes,config,grants:()=>grants,revoke(){enabled=false;for(const c of controllers)c.abort();}};
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

test('organizer requests eligible vector candidates before the limit and thresholds semantic similarity',async t=>{
  const f=await fixture(t),calls=[];
  const vectors={async getSnapshot(){return {id:'fixture'};},async query(input){calls.push(input);return {records:[
    {id:'softened',revision:'one',score:0,similarity:1,state:{validity:'current'},anchor:{ref:{storage:'entry'}}},
    {id:'low-similarity',revision:'one',score:1,similarity:.19,state:{validity:'current'},anchor:{ref:{storage:'entry'}}},
    {id:'historical',revision:'one',score:1,similarity:1,state:{validity:'historical'},anchor:{ref:{storage:'entry'}}}
  ]};}};
  const load=createMemoryReferenceLoader({access:f.access,tools:f.notes.tools,vectors,config:f.config});
  const found=await load({sources:[{role:'user',text:'虚构背景'}]},
    {agent:f.agent,scope:{ownerSubject:'owner',project:'main'},signal:new AbortController().signal,check(){}});
  assert.deepEqual(found,[{id:'softened',revision:'one'}]);
  assert.equal(calls[0].referenceOnly,true);assert.equal(calls[0].minSimilarity,0.45);assert.equal(calls[0].limit,8);
});

test('actual original reader and native tools share the answer ledger without model or vector preparation',async t=>{
  const f=await fixture(t);f.save();f.save({messageId:'qa-assistant',role:'assistant',sequence:2,text:'我建议先量尺寸。',content:[{type:'text',text:'我建议先量尺寸。'}]});
  assert.equal(f.grants(),0);assert.equal(f.raw.status().backend.prepared,false);
  const tools=createMemoryQueryTools({answer:()=>f.answer}),exec={agent:f.agent,signal:new AbortController().signal};
  const found=await tools[0].execute({query:'书架'},exec);assert.equal(found.status,'partial');assert.equal(found.records.length,1);
  assert.match(found.records[0].label,/用户说/u);assert.ok(found.records[0].text.includes('只有周末'));assert.equal(found.channels.vector.state,'unavailable');
  const opened=await tools[1].execute({ref:found.records[0].ref},exec);assert.deepEqual(opened.records.map(item=>item.label.match(/(用户说|助手说)/u)?.[0]),['用户说','助手说']);
  await tools[2].execute({},exec);await tools[0].execute({query:'尺寸'},exec);
  assert.equal((await tools[0].execute({query:'第五次'},exec)).error.code,'CALLS');assert.equal(f.grants(),1);
  assert.equal(f.raw.status().backend.prepared,false);assert.ok(f.notes.tools.calls.filter(call=>call.name.endsWith('search_notes')).every(call=>call.arguments.search_type==='text'));
});

test('recent bypasses vector configuration and later searches share a pending answer snapshot',async t=>{
  let release,entered,textEntered=false,snapshots=0;
  const pendingProfile=new Promise(resolve=>release=resolve),textStarted=new Promise(resolve=>entered=resolve);
  const profiles=[];
  const vectors={getSnapshot(){snapshots++;return pendingProfile;},async query({profile}){profiles.push(profile);return {records:[]};}};
  const f=await fixture(t,{vectors});
  const first=f.save({text:'只有周末有空才整理书架。'});
  const forGrant=f.entries.forGrant.bind(f.entries);
  f.entries.forGrant=(...args)=>{const reader=forGrant(...args);return {...reader,async search(...searchArgs){textEntered=true;entered();return reader.search(...searchArgs);}};};
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
  const forGrant=f.entries.forGrant.bind(f.entries);
  f.entries.forGrant=(...args)=>{const reader=forGrant(...args);return {...reader,async search(...searchArgs){order.push('structured');return reader.search(...searchArgs);}};};
  await f.answer.search({query:'书架'});
  assert.ok(order.indexOf('vector')>=0);assert.ok(order.indexOf('originals')>order.indexOf('vector'));
  assert.ok(order.indexOf('structured')>order.indexOf('vector'));
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
  const row={id:'vector-only',revision:'one',kind:'entry',text:'虚构向量候选',state:{validity:'current',progress:null},
    sourceStatus:{eligible:true,manualBody:true},anchor:{id:'vector-only',revision:'one',ref:{storage:'entry',id:'vector-only'}}};
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){return {records:[row]};},
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
  const answer=createMemoryQueryAnswer({access:f.access,agent:f.agent,raw:f.raw,entries:f.entries,tools:f.notes.tools,config:f.config,vectors});
  t.after(()=>answer.dispose());
  const found=await answer.search({query:'书架',limit:2});
  assert.deepEqual(resultIds(answer,found),[low.id,high.id]);
});

test('memory search total wait derives from the configured model and device',async t=>{
  const f=await fixture(t);
  const config=resolveConfig({...f.config,rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallDevice:'cpu'});
  const answer=createMemoryQueryAnswer({access:f.access,agent:f.agent,raw:f.raw,entries:f.entries,tools:f.notes.tools,config});
  t.after(()=>answer.dispose());
  const found=await answer.search({query:'书架',limit:1});
  assert.ok(found.budget.remainingMs>3900&&found.budget.remainingMs<=4000);
});

test('P02 committed Markdown entries are found with typed state and importance, then expand to their original evidence',async t=>{
  const f=await fixture(t),source=f.save(),writer=f.entries.forBatch(f.agent,[{id:source.id,revision:source.revision}]);
  const saved=await writer.commit({operationId:'query-entry',sources:new Map([['s1',source]]),subjects:new Map([['owner','owner']]),proposed:{
    type:'plan',content:'QA 书架整理计划。',subject_ref:'owner',source_refs:['s1'],state:{validity:'current',progress:'planned'},tags:['书架'],
    importance:{level:'high',basis:'user_explicit',reason:'虚构用户明确优先事项'},evidence_basis:'self_report',speaker_ref:'owner'}});
  const reads=()=>f.notes.tools.calls.filter(call=>call.name.endsWith('read_note')).length;
  let before=reads();
  const found=await f.answer.search({query:'书架',type:'plan',progress:'planned',subject:'owner'});
  assert.equal(found.records.length,1);const foundLocation=f.answer.resolve(found.records[0].ref);
  assert.equal(foundLocation.id,saved.id);assert.match(found.records[0].label,/计划（尚未发生）.*当前有效/u);
  assert.equal(found.records[0].subject_ref,'owner');assert.deepEqual(found.records[0].tags,['书架']);assert.equal(found.coverage.rawTypedFilters,'not_applicable');
  assert.equal(reads()-before,1);assert.equal(foundLocation.revision,saved.revision);
  const opened=await f.answer.expand({ref:found.records[0].ref});
  assert.match(opened.records[0].label,/记忆条目/u);assert.match(opened.records[1].label,/原话 · 用户说/u);
  assert.equal((await f.answer.search({query:'书架',type:'habit'})).records.length,0);

  const manual='人工修订：下周再整理书架。';
  const block=text=>`<!-- dsh-memory-entry:start -->\n${text}\n<!-- dsh-memory-entry:end -->`;
  await f.notes.tools.get('mcp__basic_memory__edit_note',f.agent).execute({project:'main',identifier:saved.permalink,operation:'find_replace',
    find_text:block('QA 书架整理计划。'),content:block(manual),expected_checksum:saved.revision},{agent:f.agent});
  f.memory.setControl({scope:'owner',targetType:'message',targetId:source.messageId,excluded:true});
  before=reads();
  const changed=await f.answer.search({query:'书架',type:'plan'});
  const changedLocation=f.answer.resolve(changed.records[0].ref);
  assert.equal(reads()-before,1);assert.equal(changedLocation.id,saved.id);
  assert.notEqual(changedLocation.revision,saved.revision);assert.equal(changed.records[0].text,manual);
  assert.equal('sourceStatus' in changed.records[0],false);
});

test('the first search slot keeps an unapplied user correction and excludes the active question',async t=>{
  const f=await fixture(t,{answerTurn:3});
  const old=f.save({messageId:'old',text:'以后每周五不排会。'});
  const writer=f.entries.forBatch(f.agent,[{id:old.id,revision:old.revision}]);
  const entry=await writer.commit({operationId:'recall-correction-original',sources:new Map([['s1',old]]),subjects:new Map([['owner','owner']]),proposed:{
    type:'preference',content:'用户每周五不排会。',subject_ref:'owner',source_refs:['s1'],state:{validity:'current',progress:null},tags:['排会'],
    importance:{level:'high',basis:'user_explicit',reason:'用户明确安排'},evidence_basis:'self_report',speaker_ref:'owner'}});
  const processingContext={owner:'pipeline-v1',target:{provider:'fixture',model:'fixture'}};
  const correction=f.save({messageId:'correction',sequence:2,turn:2,rootTurn:2,time:2000,text:'更正一下，以后每周四不排会。',processingContext});
  f.save({messageId:'ack',role:'assistant',sequence:3,turn:2,rootTurn:2,time:2001,text:'已安排优先整理。',processingContext});
  f.memory.messages.completeTurn({ownerSubject:'owner',project:'main',sessionId:f.agent.session.id,turn:2,state:'completed',changeKind:'correction'},{authorize:()=>true});
  const question=f.save({messageId:'current-question',sequence:4,turn:3,rootTurn:3,time:3000,text:'我每周哪天不排会？'});

  const found=await f.answer.search({query:'排会',limit:2});
  assert.deepEqual(resultIds(f.answer,found),[correction.id,entry.id]);
  assert.equal(found.records[0].correction,true);
  assert.match(found.records[1].label,/当前有效/u);
  assert.ok(!resultIds(f.answer,found).includes(question.id));
  const opened=await f.answer.expand({ref:found.records[0].ref});
  assert.equal(opened.records[0].text,correction.text);
});

test('a vector-only correction can still be reviewed for the first slot',async t=>{
  let rows;
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){return {records:rows};},
    async resolveDocument({id}){return rows.find(record=>record.id===id);}};
  const f=await fixture(t,{vectors});
  const processingContext={owner:'pipeline-v1',target:{provider:'fixture',model:'fixture'}};
  const correction=f.save({text:'更正一下，以后周四不排会。',processingContext});
  f.save({messageId:'ack',role:'assistant',sequence:2,text:'收到。',processingContext});
  f.memory.messages.completeTurn({ownerSubject:'owner',project:'main',sessionId:f.agent.session.id,turn:1,state:'completed',changeKind:'correction'},{authorize:()=>true});
  rows=[{id:'vector-top',revision:1,kind:'document',text:'虚构日程说明',anchor:{id:'vector-top',revision:1,ref:{storage:'document',id:'vector-top'}}},
    {id:correction.id,revision:correction.revision,kind:'original',text:correction.text,
      anchor:{id:correction.id,revision:correction.revision,ref:{storage:'message',id:correction.id,revision:correction.revision}}}];
  const found=await f.answer.search({query:'日程安排',limit:1});
  assert.equal(found.channels.originals.state,'empty');assert.equal(f.answer.resolve(found.records[0].ref).id,correction.id);
  assert.equal(found.records[0].correction,true);
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

test('old-format notes in the Vault bypass Basic Memory search_notes',async t=>{
  const f=await fixture(t),directory=path.join(f.config.vaultPath,'chats/facts');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'pet.md'),legacyVaultNote);
  const original=f.notes.tools.get.bind(f.notes.tools);let searches=0;
  f.notes.tools.get=(name,agent)=>{const tool=original(name,agent);if(name!=='mcp__basic_memory__search_notes'||!tool)return tool;
    return {...tool,execute:(...args)=>{searches++;return tool.execute(...args);}};};

  const found=await f.answer.search({query:'阿岑'});
  assert.equal(searches,0);
  assert.equal(found.channels.legacy.records,1);
  assert.equal(f.answer.resolve(found.records[0].ref).id,'legacy-note:vault-legacy-qa');
  assert.equal(found.records[0].text,'养了一只叫阿岑的猫');
});

test('old-format search reports unavailable without falling back to Basic Memory tools',async t=>{
  const f=await fixture(t);
  assert.equal(await fs.stat(path.join(f.config.vaultPath,'chats/facts')).then(()=>true,()=>false),false);
  await f.notes.tools.get('mcp__basic_memory__write_note',f.agent).execute({project:'main',title:'QA旧偏好',directory:'chats/facts',tags:['dsh-memory'],
    content:'<!-- dsh-fact-memory -->\n# QA旧偏好\n\n- [preference] QA用户喜欢靛蓝。\n- subject: owner\n- attribute: 颜色',
    metadata:{memory_id:'memory-legacy-qa',memory_kind:'fact',status:'active',subject:'owner',attribute:'颜色',value:'QA用户喜欢靛蓝。',recorded_at:'2026-11-06T00:00:00Z'}},{agent:f.agent});
  const original=f.notes.tools.get.bind(f.notes.tools);let searches=0;
  f.notes.tools.get=(name,agent)=>{const tool=original(name,agent);if(name!=='mcp__basic_memory__search_notes'||!tool)return tool;
    return {...tool,execute:(...args)=>{searches++;return tool.execute(...args);}};};

  const found=await f.answer.search({query:'靛蓝'});
  assert.equal(searches,0);
  assert.equal(found.channels.legacy.state,'unavailable');
  assert.equal(found.channels.legacy.records,0);
});

test('a migrated personal permalink remains locally searchable and expandable until its source changes',async t=>{
  const f=await fixture(t),relative='chats/facts/migrated.md';
  const content=`---
title: QA旧偏好
permalink: personal/chats/facts/QA旧偏好
memory_id: legacy-qa
memory_kind: fact
status: active
subject: owner
attribute: 颜色
value: QA用户喜欢靛蓝。
recorded_at: '2026-11-06T00:00:00Z'
tags:
- dsh-memory
---

<!-- dsh-fact-memory -->
# QA旧偏好

- [preference] QA用户喜欢靛蓝。
`;
  await fs.mkdir(path.join(f.config.vaultPath,'chats/facts'),{recursive:true});
  await fs.writeFile(path.join(f.config.vaultPath,relative),content);
  const found=await f.answer.search({query:'靛蓝'}),foundLocation=f.answer.resolve(found.records[0].ref);
  assert.equal(found.channels.legacy.records,1);assert.equal(foundLocation.id,'legacy-note:legacy-qa');
  assert.match(found.records[0].label,/^旧笔记（未迁移） · 事实 · 依据时间 /u);
  const opened=await f.answer.expand({ref:found.records[0].ref});assert.equal(opened.records[0].text,'QA用户喜欢靛蓝。');
  await fs.writeFile(path.join(f.config.vaultPath,relative),content.replace('- dsh-memory','- dsh-memory\nmemory_excluded: true'));
  assert.equal((await f.answer.expand({ref:found.records[0].ref})).channels.source.state,'source_changed');
  assert.equal((await f.answer.search({query:'靛蓝'})).records.length,0);
  await fs.mkdir(path.join(f.config.vaultPath,'work'),{recursive:true});
  await fs.rename(path.join(f.config.vaultPath,relative),path.join(f.config.vaultPath,'work/qa-old.md'));
  assert.equal((await f.answer.search({query:'靛蓝'})).records.length,0);
});

test('an excluded structured note is unavailable to text search, an issued anchor and organizer reads',async t=>{
  const f=await fixture(t),source=f.save(),writer=f.entries.forBatch(f.agent,[source]);
  const saved=await writer.commit({operationId:'excluded-structured-note',sources:new Map([['s1',source]]),subjects:new Map([['owner','owner']]),proposed:{
    type:'plan',content:'QA 书架整理计划。',subject_ref:'owner',source_refs:['s1'],state:{validity:'current',progress:'planned'},tags:['书架'],
    importance:{level:'high',basis:'user_explicit',reason:'虚构用户明确优先事项'},evidence_basis:'self_report',speaker_ref:'owner'}});
  const found=await f.answer.search({query:'书架',type:'plan'});
  assert.equal(f.answer.resolve(found.records[0]?.ref)?.id,saved.id);
  const note=f.notes.notes.get(saved.permalink);
  for(const marker of ['qa_fixture','excluded']){
    note.frontmatter[marker]=true;
    assert.equal(await writer.read(saved.id),null);
    assert.equal((await writer.list({includeUnavailable:true})).entries.length,0);
    delete note.frontmatter[marker];
  }
  note.frontmatter.excluded=true;
  assert.equal((await f.answer.expand({ref:found.records[0].ref})).records.length,0);
  assert.equal((await f.answer.search({query:'书架',type:'plan'})).records.length,0);
  delete note.frontmatter.excluded;
  assert.equal((await writer.read(saved.id))?.id,saved.id);
});

test('an original excluded while another search channel is pending cannot leave in the final result',async t=>{
  const f=await fixture(t);f.save();let enter,release;
  const entered=new Promise(resolve=>enter=resolve),waiting=new Promise(resolve=>release=resolve);
  t.after(()=>release());
  const forGrant=f.entries.forGrant.bind(f.entries);
  f.entries.forGrant=(...args)=>{const reader=forGrant(...args);return {...reader,async search(...searchArgs){enter();await waiting;return reader.search(...searchArgs);}};};
  const pending=f.answer.search({query:'书架'});await entered;
  f.memory.setControl({scope:'owner',targetType:'message',targetId:'qa-user',excluded:true});release();
  const result=await pending;assert.deepEqual(result.records,[]);assert.equal(result.coverage.complete,false);
});

test('a deliberately located downweighted fact can still be opened by its issued anchor',async t=>{
  const f=await fixture(t);
  const relative='chats/facts/soft.md',content=`---
title: 青岚山旧行程
permalink: main/chats/facts/青岚山旧行程
memory_id: soft-qa
memory_kind: fact
status: active
subject: owner
attribute: 行程
value: 去过青岚山，需要预约。
base_priority: 0.02
---

<!-- dsh-fact-memory -->
# 青岚山旧行程

- [fact] 去过青岚山，需要预约。
`;
  await fs.mkdir(path.join(f.config.vaultPath,'chats/facts'),{recursive:true});
  await fs.writeFile(path.join(f.config.vaultPath,relative),content);
  const found=await f.answer.search({query:'青岚山'});assert.equal(found.records.length,1);
  const opened=await f.answer.expand({ref:found.records[0].ref});assert.equal(opened.records.length,1);assert.ok(opened.records[0].text.includes('需要预约'));
});

test('portable vectors pin the answer profile, resolve issued anchors and revalidate original evidence at delivery',async t=>{
  const firstProfile={id:'Qwen/Qwen3-Embedding-4B',revision:1,modelKey:'fixture-vector-space-one'};
  let activeProfile=firstProfile,snapshots=0,source,f,changeDuringOpen=false;
  const calls=[],documents=new Map();
  const vectors={
    async getSnapshot(input){snapshots++;calls.push({kind:'snapshot',...input});return activeProfile;},
    async query(input){
      calls.push({kind:'query',...input});
      assert.deepEqual(input.profile,{id:'Qwen/Qwen3-Embedding-4B',revision:1,modelKey:'fixture-vector-space-one'});
      assert.equal(Object.isFrozen(input.profile),true);assert.notEqual(input.profile,activeProfile);
      assert.equal(input.limit,10);assert.ok(Number.isFinite(input.deadline));assert.equal(input.signal.aborted,false);
      return {records:input.query==='搬运箱子'?[documents.get('vector-one'),documents.get('wrong-role'),documents.get('withdrawn')]:[documents.get('vector-two')]};
    },
    async resolveDocument(input){
      calls.push({kind:'resolve',...input});assert.equal(f.access.validate(input.grant),true);
      const row=documents.get(input.id);if(!row||input.revision!==row.revision||input.id==='withdrawn')return null;
      // Simulate a source edit after asynchronous document resolution but before
      // the answer's final synchronous delivery check. No stale evidence escapes.
      if(changeDuringOpen&&input.id==='vector-two'){
        changeDuringOpen=false;
        const edited=f.save({sequence:3,text:'现在改为整理工具箱。',content:[{type:'text',text:'现在改为整理工具箱。'}]});
        assert.equal(edited.revision,source.revision+1);
      }
      return row;
    },
  };
  f=await fixture(t,{vectors});source=f.save();
  function document(id,role='user'){
    return {id,revision:'note-v1',kind:'entry',text:'虚构计划：准备周末搬运与收纳。',type:'plan',subject_ref:'owner',
      state:{validity:'current',progress:'planned'},time:source.time,tags:['收纳'],sourceStatus:{eligible:true,manualBody:false},
      source_refs:[{id:source.id,revision:source.revision,role}],anchor:{id,revision:'note-v1',ref:{storage:'entry',id}}};
  }
  for(const id of ['vector-one','vector-two'])documents.set(id,document(id));
  documents.set('withdrawn',document('withdrawn','assistant'));
  documents.set('wrong-role',document('wrong-role','assistant'));
  const tools=createMemoryQueryTools({answer:()=>f.answer}),exec={agent:f.agent,signal:new AbortController().signal};
  assert.equal(snapshots,0);
  const found=await tools[0].execute({query:'搬运箱子',type:'plan'},exec);
  assert.deepEqual(resultIds(f.answer,found),['vector-one']);assert.equal(found.channels.vector.state,'ready');
  assert.equal(found.channels.sourceValidation.removed,2);assert.equal(found.coverage.complete,false);
  assert.deepEqual(calls.filter(call=>call.kind==='resolve'),[]);

  // Changing the active service profile cannot replace the encoding snapshot
  // already pinned to this answer, including an edit to the original object.
  firstProfile.revision=99;
  activeProfile={id:'Qwen/Qwen3-Embedding-0.6B',revision:2,modelKey:'fixture-vector-space-two'};
  const opened=await tools[1].execute({ref:found.records[0].ref},exec);
  assert.match(opened.records[0].label,/记忆条目/u);assert.match(opened.records[1].label,/原话 · 用户说/u);
  assert.equal(opened.records[1].text,source.text);assert.equal(f.answer.resolve(opened.records[0].ref).revision,'note-v1');
  const next=await tools[0].execute({query:'换一组线索',type:'plan'},exec);
  assert.deepEqual(resultIds(f.answer,next),['vector-two']);
  changeDuringOpen=true;
  const stale=await tools[1].execute({ref:next.records[0].ref},exec);
  assert.deepEqual(stale.records,[]);assert.equal(stale.channels.sourceValidation.state,'source_changed');
  assert.equal(stale.channels.sourceValidation.removed,1);assert.equal(stale.coverage.complete,false);
  assert.equal(snapshots,1);assert.equal(f.grants(),1);assert.equal(f.answer.budget().calls,4);
  const grant=calls.find(call=>call.kind==='snapshot').grant;
  assert.ok(calls.every(call=>call.grant===grant));assert.equal(calls.filter(call=>call.kind==='query').length,2);
  assert.equal(f.raw.status().backend.prepared,false);
});

test('vector lane folds multi-line and padded queries the vector service would reject',async t=>{
  assert.equal(vectorQueryText('  填个表\n我全名咋写\r\n\t多大来着  '),'填个表 我全名咋写 多大来着');
  assert.equal(vectorQueryText('\n\t '),'');
  assert.equal(vectorQueryText('x'.repeat(2100)).length,2000);
  const f=await fixture(t),calls=[];
  const vectors={async getSnapshot(){return {id:'fixture'};},async query(input){calls.push(input);return {records:[]};}};
  const load=createMemoryReferenceLoader({access:f.access,tools:f.notes.tools,vectors,config:f.config});
  await load({sources:[{role:'user',text:'虚构背景第一行\n第二行  '}]},
    {agent:f.agent,scope:{ownerSubject:'owner',project:'main'},signal:new AbortController().signal,check(){}});
  assert.equal(calls.length,1);
  assert.doesNotMatch(calls[0].query,/[\u0000-\u001f]/u);assert.equal(calls[0].query,calls[0].query.trim());
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
  assert.equal(recordLabel({id:'legacy-note:old',kind:'entry',type:'fact',state:{validity:'current'}}),
    '旧笔记（未迁移） · 事实 · 依据时间 时间未知');
  assert.match(recordLabel({kind:'original',role:'user',text:'我以前的杯子是什么？  ',time:0}),/ · 当时的提问$/u);
  assert.doesNotMatch(recordLabel({kind:'original',role:'assistant',text:'你想问什么？',time:0}),/当时的提问/u);
});

test('a memory-enabled turn without material carries only the short clock',async t=>{
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
  const clock=decision.messages.find(message=>message.source?.kind==='memory-answer-rules');
  assert.ok(clock);assert.match(clock.content[0].text,/^<memory_clock>当前本地时间：.+<\/memory_clock>$/u);
  for(const rule of ANSWER_RULES)assert.equal(clock.content[0].text.includes(rule),false,rule);
});

test('memory_search description is compact and does not repeat the material rules',()=>{
  const [search]=createMemoryQueryTools({answer:()=>({})});
  assert.match(search.description,/只把结果里实际写到的内容当事实；本轮如附有记忆使用规则，照规则回答。/u);
  assert.match(search.description,/原话还是记忆条目、谁说的、何时说的/u);
  assert.match(search.description,/memory_open/u);
  assert.match(search.description,/correction/u);
  assert.match(search.description,/1K tokens/u);
  assert.ok(estimateTokens(search.description)<=200,String(estimateTokens(search.description)));
  for(const rule of ANSWER_RULES)assert.equal(search.description.includes(rule),false,rule);
  assert.doesNotMatch(ANSWER_RULES.join('\n'),/包括闲聊|说明这是建议/u);
});

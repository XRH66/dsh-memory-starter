import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createMemoryEntryAccess} from '../lib/memory-entry-access.js';
import {createMemoryQueryAnswer,createMemoryQueryTools,createMemoryReferenceLoader,vectorQueryText} from '../lib/memory-query.js';
import {createUnifiedProfiles} from '../lib/unified/profiles.js';
import {resolveConfig} from '../lib/config.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent} from './helpers.js';

const nextTurn=()=>new Promise(resolve=>setImmediate(resolve));
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
  assert.ok(hit.text.includes(marker));assert.ok(hit.anchor.range.start>9000);
  assert.equal(hit.text,text.slice(hit.anchor.range.start,hit.anchor.range.end));
  const opened=(await f.answer.expand({anchor:hit.anchor})).records[0];
  assert.ok(opened.text.includes(marker));assert.equal(opened.revision,hit.revision);
  assert.equal(opened.text,text.slice(opened.anchor.range.start,opened.anchor.range.end));
  assert.ok(opened.anchor.nextOffset);assert.ok(!/[\uD800-\uDBFF]$/u.test(opened.text));
  const continued=(await f.answer.expand({anchor:opened.anchor})).records[0];
  assert.equal(continued.anchor.range.start,opened.anchor.nextOffset);
  assert.equal(continued.text,text.slice(continued.anchor.range.start,continued.anchor.range.end));
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
  assert.equal(calls[0].referenceOnly,true);assert.equal(calls[0].minSimilarity,f.config.rawRecallMinScore);assert.equal(calls[0].limit,8);
});

test('actual original reader and native tools share the answer ledger without model or vector preparation',async t=>{
  const f=await fixture(t);f.save();f.save({messageId:'qa-assistant',role:'assistant',sequence:2,text:'我建议先量尺寸。',content:[{type:'text',text:'我建议先量尺寸。'}]});
  assert.equal(f.grants(),0);assert.equal(f.raw.status().backend.prepared,false);
  const tools=createMemoryQueryTools({answer:()=>f.answer}),exec={agent:f.agent,signal:new AbortController().signal};
  const found=await tools[0].execute({query:'书架'},exec);assert.equal(found.status,'partial');assert.equal(found.records.length,1);
  assert.equal(found.records[0].role,'user');assert.ok(found.records[0].text.includes('只有周末'));assert.equal(found.channels.vector.state,'unavailable');
  const opened=await tools[1].execute({anchor:found.records[0].anchor},exec);assert.deepEqual(opened.records.map(item=>item.role),['user','assistant']);
  await tools[2].execute({},exec);await tools[0].execute({query:'尺寸'},exec);
  assert.equal((await tools[0].execute({query:'第五次'},exec)).error.code,'CALLS');assert.equal(f.grants(),1);
  assert.equal(f.raw.status().backend.prepared,false);assert.ok(f.notes.tools.calls.filter(call=>call.name.endsWith('search_notes')).every(call=>call.arguments.search_type==='text'));
});

test('recent bypasses vector configuration and later searches share a pending answer snapshot',async t=>{
  let release,entered,snapshots=0;
  const pendingProfile=new Promise(resolve=>release=resolve),textStarted=new Promise(resolve=>entered=resolve);
  const profiles=[];
  const vectors={getSnapshot(){snapshots++;return pendingProfile;},async query({profile}){profiles.push(profile);return {records:[]};}};
  const f=await fixture(t,{vectors});
  const first=f.save({text:'只有周末有空才整理书架。'});
  const get=f.notes.tools.get.bind(f.notes.tools);
  f.notes.tools.get=(name,agent)=>{const tool=get(name,agent);return name.endsWith('search_notes')?{...tool,async execute(...args){entered();return tool.execute(...args);}}:tool;};
  t.after(()=>release(null));
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const recent=await Promise.race([f.answer.recent({}),nextTurn()]);
  assert.equal(recent?.records[0].id,first.id);assert.equal(snapshots,0);

  const second=f.save({messageId:'second',sequence:2,text:'明天整理桌面。'});
  const waiting=f.answer.search({query:'桌面'});
  assert.equal(await Promise.race([textStarted.then(()=>true),nextTurn()]),true);
  await nextTurn();
  t.mock.timers.tick(1950);
  const partial=await Promise.race([waiting,nextTurn()]);
  assert.equal(partial?.channels.vector.state,'timeout');assert.deepEqual(partial.records.map(row=>row.id),[second.id]);
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
  assert.equal(found.status,'partial');assert.equal(found.channels.vector.state,'failed');assert.deepEqual(found.records.map(row=>row.id),[source.id]);
  assert.doesNotMatch(JSON.stringify(found),/private config location/);
  assert.equal((await f.answer.search({query:'再查'})).channels.vector.state,'failed');assert.equal(snapshots,1);
  assert.equal((await f.answer.recent({})).status,'empty');assert.equal(queries,0);
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

test('slow final vector review releases checked text and avoids reading lower ranked vectors',async t=>{
  let entered,release,rows;
  const reviewStarted=new Promise(resolve=>entered=resolve),late=new Promise(resolve=>release=resolve),reads=[];
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){return {records:rows};},
    async resolveDocument({id,signal}){reads.push({id,signal});if(id==='vector-ready')return rows[1];entered();return late;}};
  const f=await fixture(t,{vectors}),source=f.save();
  const row=(id,revision=1)=>({id,revision,kind:'document',text:'未经最终复核的向量文本',anchor:{id,revision,ref:{storage:'document',id}}});
  rows=[row(source.id,source.revision),row('vector-ready'),...Array.from({length:20},(_,i)=>row(`vector-${i}`))];
  t.after(()=>release(rows[0]));
  t.mock.timers.enable({apis:['setTimeout','Date'],now:10000});
  const waiting=f.answer.search({query:'书架',limit:2});
  await reviewStarted;await nextTurn();
  t.mock.timers.tick(500);
  const found=await Promise.race([waiting,nextTurn()]);
  assert.equal(found?.status,'partial');assert.equal(found.channels.vectorValidation.state,'timeout');
  assert.deepEqual(found.records.map(item=>[item.id,item.text]),[[source.id,source.text],['vector-ready',rows[1].text]]);
  assert.deepEqual(reads.map(read=>read.id),[source.id,'vector-ready']);assert.equal(reads[0].signal.aborted,true);
  release(rows[0]);await nextTurn();assert.equal(found.records[0].text,source.text);
});

test('a failed duplicate loses its vector score but keeps its independent text rank',async t=>{
  let rows;
  const reads=[];
  const vectors={async getSnapshot(){return {id:'fixture',revision:1};},async query(){return {records:rows};},
    async resolveDocument({id}){reads.push(id);throw Error('private document path');}};
  const f=await fixture(t,{vectors});
  f.save();f.save({messageId:'other',sequence:2,time:2000,text:'书架旁边有一盏灯。'});
  const {sources:[first,duplicate]}=f.raw.queryReader({ownerSubject:'owner',project:'main'},{authorize:()=>true}).search({query:'书架',limit:40});
  rows=[{id:duplicate.id,revision:duplicate.revision,kind:'document',text:'无法复核的向量文本',
    anchor:{id:duplicate.id,revision:duplicate.revision,ref:{storage:'document',id:duplicate.id}}}];
  const found=await f.answer.search({query:'书架',limit:2});
  assert.equal(found.status,'partial');assert.equal(found.channels.vectorValidation.state,'failed');
  assert.deepEqual(reads,[duplicate.id]);assert.deepEqual(found.records.map(row=>[row.id,row.text]),[[first.id,first.text],[duplicate.id,duplicate.text]]);
  assert.doesNotMatch(JSON.stringify(found),/private document path/);
});

test('P02 committed Markdown entries are found with typed state and importance, then expand to their original evidence',async t=>{
  const f=await fixture(t),source=f.save(),writer=f.entries.forBatch(f.agent,[{id:source.id,revision:source.revision}]);
  const saved=await writer.commit({operationId:'query-entry',sources:new Map([['s1',source]]),subjects:new Map([['owner','owner']]),proposed:{
    type:'plan',content:'QA 书架整理计划。',subject_ref:'owner',source_refs:['s1'],state:{validity:'current',progress:'planned'},tags:['书架'],
    importance:{level:'high',basis:'user_explicit',reason:'虚构用户明确优先事项'},evidence_basis:'self_report',speaker_ref:'owner'}});
  const reads=()=>f.notes.tools.calls.filter(call=>call.name.endsWith('read_note')).length;
  let before=reads();
  const found=await f.answer.search({query:'书架',type:'plan',progress:'planned',subject:'owner'});
  assert.equal(found.records.length,1);assert.equal(found.records[0].id,saved.id);assert.equal(found.records[0].importance.level,'high');assert.equal(found.records[0].state.progress,'planned');
  assert.equal(found.records[0].speaker_ref,'owner');assert.equal(found.coverage.rawTypedFilters,'not_applicable');
  assert.equal(reads()-before,1);assert.equal(found.records[0].revision,saved.revision);assert.equal(found.records[0].sourceStatus.manualBody,false);
  const opened=await f.answer.expand({anchor:found.records[0].anchor});assert.equal(opened.records[0].kind,'entry');assert.equal(opened.records[1].role,'user');
  assert.equal((await f.answer.search({query:'书架',type:'habit'})).records.length,0);

  const manual='人工修订：下周再整理书架。';
  const block=text=>`<!-- dsh-memory-entry:start -->\n${text}\n<!-- dsh-memory-entry:end -->`;
  await f.notes.tools.get('mcp__basic_memory__edit_note',f.agent).execute({project:'main',identifier:saved.permalink,operation:'find_replace',
    find_text:block('QA 书架整理计划。'),content:block(manual),expected_checksum:saved.revision},{agent:f.agent});
  f.memory.setControl({scope:'owner',targetType:'message',targetId:source.messageId,excluded:true});
  before=reads();
  const changed=await f.answer.search({query:'书架',type:'plan'});
  assert.equal(reads()-before,1);assert.equal(changed.records[0].id,saved.id);
  assert.notEqual(changed.records[0].revision,saved.revision);assert.equal(changed.records[0].text,manual);
  assert.equal(changed.records[0].sourceStatus.manualBody,true);
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
  assert.deepEqual(found.records.map(row=>row.id),[correction.id,entry.id]);
  assert.equal(found.records[0].source.changeKind,'correction');
  assert.equal(found.records[1].state.validity,'current');
  assert.ok(!found.records.some(row=>row.id===question.id));
  const opened=await f.answer.expand({anchor:found.records[0].anchor});
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
  assert.equal(found.channels.originals.state,'empty');assert.equal(found.records[0].id,correction.id);
  assert.equal(found.records[0].source.changeKind,'correction');
});

test('an original edit or exclusion invalidates an issued anchor; a new body never impersonates its old revision',async t=>{
  const f=await fixture(t);f.save();const found=await f.answer.search({query:'书架'});
  f.save({sequence:3,text:'改为整理工具箱。',content:[{type:'text',text:'改为整理工具箱。'}]});
  const old=await f.answer.expand({anchor:found.records[0].anchor});assert.equal(old.records.length,0);assert.equal(old.channels.source.state,'source_changed');
  const current=await f.answer.search({query:'工具箱'});assert.equal(current.records[0].revision,2);
  f.memory.setControl({scope:'owner',targetType:'message',targetId:'qa-user',excluded:true});
  assert.equal((await f.answer.expand({anchor:current.records[0].anchor})).records.length,0);
});

test('long messages begin near a late hit and continuation uses the delivered source offset',async t=>{
  const f=await fixture(t);f.save({text:'很久以前。'.repeat(2000)+'QA789：只有完成验收才能启动。'+'后续说明。'.repeat(2000)});
  const found=await f.answer.search({query:'QA789'});assert.ok(found.records[0].text.includes('QA789'));assert.ok(found.records[0].anchor.range.start>9000);
  const opened=await f.answer.expand({anchor:found.records[0].anchor});assert.ok(opened.records[0].text.includes('只有完成验收'));assert.ok(opened.records[0].anchor.nextOffset);
  const continued=await f.answer.expand({anchor:opened.records[0].anchor});assert.equal(continued.records[0].anchor.range.start,opened.records[0].anchor.nextOffset);
});

test('revocation and unissued paths cannot reveal originals or bypass the answer grant',async t=>{
  const f=await fixture(t);f.save();assert.equal((await f.answer.expand({anchor:{ref:{storage:'note',identifier:'private.md'}}})).error.code,'INPUT');
  const found=await f.answer.search({query:'书架'});f.revoke();assert.equal((await f.answer.expand({anchor:found.records[0].anchor})).status,'denied');
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
  assert.equal(found.records[0].id,'legacy-note:vault-legacy-qa');
  assert.equal(found.records[0].text,'养了一只叫阿岑的猫');
});

test('Basic Memory remains the old-format fallback when Vault memory directories are absent',async t=>{
  const f=await fixture(t);
  assert.equal(await fs.stat(path.join(f.config.vaultPath,'chats/facts')).then(()=>true,()=>false),false);
  await f.notes.tools.get('mcp__basic_memory__write_note',f.agent).execute({project:'main',title:'QA旧偏好',directory:'chats/facts',tags:['dsh-memory'],
    content:'<!-- dsh-fact-memory -->\n# QA旧偏好\n\n- [preference] QA用户喜欢靛蓝。\n- subject: owner\n- attribute: 颜色',
    metadata:{memory_id:'memory-legacy-qa',memory_kind:'fact',status:'active',subject:'owner',attribute:'颜色',value:'QA用户喜欢靛蓝。',recorded_at:'2026-11-06T00:00:00Z'}},{agent:f.agent});
  const original=f.notes.tools.get.bind(f.notes.tools);let searches=0;
  f.notes.tools.get=(name,agent)=>{const tool=original(name,agent);if(name!=='mcp__basic_memory__search_notes'||!tool)return tool;
    return {...tool,execute:(...args)=>{searches++;return tool.execute(...args);}};};

  const found=await f.answer.search({query:'靛蓝'});
  assert.equal(searches,1);
  assert.equal(found.channels.legacy.records,1);
  assert.equal(found.records[0].id,'legacy-note:memory-legacy-qa');
  assert.equal(found.records[0].text,'QA用户喜欢靛蓝。');
});

test('a migrated personal permalink remains searchable, expandable and available to the organizer at its real path',async t=>{
  const f=await fixture(t);
  await f.notes.tools.get('mcp__basic_memory__write_note',f.agent).execute({project:'main',title:'QA旧偏好',directory:'chats/facts',tags:['dsh-memory'],
    content:'<!-- dsh-fact-memory -->\n# QA旧偏好\n\n- [preference] QA用户喜欢靛蓝。\n- subject: owner\n- attribute: 颜色',
    metadata:{memory_id:'legacy-qa',memory_kind:'fact',status:'active',subject:'owner',attribute:'颜色',value:'QA用户喜欢靛蓝。',recorded_at:'2026-11-06T00:00:00Z'}},{agent:f.agent});
  const [key,note]=[...f.notes.notes.entries()][0];
  f.notes.notes.delete(key);
  note.permalink=key.replace(/^main\//,'personal/');
  f.notes.notes.set(note.permalink,note);
  const found=await f.answer.search({query:'靛蓝'});assert.equal(found.channels.legacy.records,1);assert.equal(found.records[0].id,'legacy-note:legacy-qa');
  assert.equal(found.records[0].type,'fact');assert.equal(found.records[0].state.validity,'current');
  const opened=await f.answer.expand({anchor:found.records[0].anchor});assert.equal(opened.records[0].text,'QA用户喜欢靛蓝。');
  const source=f.save(),writer=f.entries.forBatch(f.agent,[source]);
  const reference={id:found.records[0].id,revision:found.records[0].revision,legacy:note.permalink};
  assert.equal((await writer.readLegacy(reference))?.content,'QA用户喜欢靛蓝。');
  note.frontmatter.memory_excluded='true';
  assert.equal(await writer.readLegacy(reference),null);
  assert.equal((await f.answer.expand({anchor:found.records[0].anchor})).channels.source.state,'source_changed');
  delete note.frontmatter.memory_excluded;
  note.filePath='work/qa-old.md';
  assert.equal(await writer.readLegacy(reference),null);
  assert.equal((await f.answer.search({query:'靛蓝'})).records.length,0);
});

test('an excluded structured note is unavailable to text search, an issued anchor and organizer reads',async t=>{
  const f=await fixture(t),source=f.save(),writer=f.entries.forBatch(f.agent,[source]);
  const saved=await writer.commit({operationId:'excluded-structured-note',sources:new Map([['s1',source]]),subjects:new Map([['owner','owner']]),proposed:{
    type:'plan',content:'QA 书架整理计划。',subject_ref:'owner',source_refs:['s1'],state:{validity:'current',progress:'planned'},tags:['书架'],
    importance:{level:'high',basis:'user_explicit',reason:'虚构用户明确优先事项'},evidence_basis:'self_report',speaker_ref:'owner'}});
  const found=await f.answer.search({query:'书架',type:'plan'});
  assert.equal(found.records[0]?.id,saved.id);
  const note=f.notes.notes.get(saved.permalink);
  for(const marker of ['qa_fixture','excluded']){
    note.frontmatter[marker]=true;
    assert.equal(await writer.read(saved.id),null);
    assert.equal((await writer.list({includeUnavailable:true})).entries.length,0);
    delete note.frontmatter[marker];
  }
  note.frontmatter.excluded=true;
  assert.equal((await f.answer.expand({anchor:found.records[0].anchor})).records.length,0);
  assert.equal((await f.answer.search({query:'书架',type:'plan'})).records.length,0);
  delete note.frontmatter.excluded;
  assert.equal((await writer.read(saved.id))?.id,saved.id);
});

test('an original excluded while another search channel is pending cannot leave in the final result',async t=>{
  const f=await fixture(t);f.save();let enter,release;
  const entered=new Promise(resolve=>enter=resolve),waiting=new Promise(resolve=>release=resolve),get=f.notes.tools.get.bind(f.notes.tools);
  t.after(()=>release());
  f.notes.tools.get=(name,agent)=>{const tool=get(name,agent);return name.endsWith('search_notes')?{...tool,async execute(...args){enter();await waiting;return tool.execute(...args);}}:tool;};
  const pending=f.answer.search({query:'书架'});await entered;
  f.memory.setControl({scope:'owner',targetType:'message',targetId:'qa-user',excluded:true});release();
  const result=await pending;assert.deepEqual(result.records,[]);assert.equal(result.coverage.complete,false);
});

test('a deliberately located downweighted fact can still be opened by its issued anchor',async t=>{
  const f=await fixture(t);
  await f.notes.tools.get('mcp__basic_memory__write_note',f.agent).execute({project:'main',title:'青岚山旧行程',directory:'chats/facts',tags:['dsh-memory'],
    content:'<!-- dsh-fact-memory -->\n# 青岚山旧行程\n\n- [fact] 去过青岚山，需要预约。\n- subject: owner\n- attribute: 行程',
    metadata:{memory_id:'soft-qa',memory_kind:'fact',status:'active',subject:'owner',attribute:'行程',value:'去过青岚山，需要预约。',base_priority:0.02}},{agent:f.agent});
  const found=await f.answer.search({query:'青岚山'});assert.equal(found.records.length,1);
  const opened=await f.answer.expand({anchor:found.records[0].anchor});assert.equal(opened.records.length,1);assert.ok(opened.records[0].text.includes('需要预约'));
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
  for(const id of ['vector-one','vector-two','withdrawn'])documents.set(id,document(id));
  documents.set('wrong-role',document('wrong-role','assistant'));
  const tools=createMemoryQueryTools({answer:()=>f.answer}),exec={agent:f.agent,signal:new AbortController().signal};
  assert.equal(snapshots,0);
  const found=await tools[0].execute({query:'搬运箱子',type:'plan'},exec);
  assert.deepEqual(found.records.map(row=>row.id),['vector-one']);assert.equal(found.channels.vector.state,'ready');
  assert.equal(found.channels.sourceValidation.removed,1);assert.equal(found.coverage.complete,false);
  assert.deepEqual(calls.filter(call=>call.kind==='resolve').map(call=>call.id).sort(),['vector-one','withdrawn','wrong-role']);

  // Changing the active service profile cannot replace the encoding snapshot
  // already pinned to this answer, including an edit to the original object.
  firstProfile.revision=99;
  activeProfile={id:'Qwen/Qwen3-Embedding-0.6B',revision:2,modelKey:'fixture-vector-space-two'};
  const opened=await tools[1].execute({anchor:found.records[0].anchor},exec);
  assert.deepEqual(opened.records.map(row=>row.kind),['entry','original']);assert.equal(opened.records[1].role,'user');
  assert.equal(opened.records[1].text,source.text);assert.equal(opened.records[0].revision,'note-v1');
  const next=await tools[0].execute({query:'换一组线索',type:'plan'},exec);
  assert.deepEqual(next.records.map(row=>row.id),['vector-two']);
  changeDuringOpen=true;
  const stale=await tools[1].execute({anchor:next.records[0].anchor},exec);
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

test('search records carry a readable host-local time next to epoch milliseconds',async()=>{
  const {localTime,VECTOR_LANE_LIMIT}=await import('../lib/memory-query.js');
  const ms=Date.UTC(2026,2,22,6,5);const text=localTime(ms);
  assert.match(text,/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/u);
  const d=new Date(ms);assert.ok(text.startsWith(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`));
  assert.equal(localTime(undefined),undefined);assert.equal(VECTOR_LANE_LIMIT,10);
});

test('structured and old-format note lanes share a single Basic Memory search per query',async t=>{
  const f=await fixture(t);
  const original=f.notes.tools.get.bind(f.notes.tools);let searches=0;
  f.notes.tools.get=(name,agent)=>{const tool=original(name,agent);if(name!=='mcp__basic_memory__search_notes'||!tool)return tool;
    return {...tool,execute:(...args)=>{searches++;return tool.execute(...args);}};};
  await f.answer.search({query:'靛蓝'});
  assert.equal(searches,1);
});

test('records carry a label saying original or entry, speaker, progress and time',async()=>{
  const {recordLabel}=await import('../lib/memory-query.js');
  assert.match(recordLabel({kind:'original',role:'user',time:Date.UTC(2026,4,8,6)}),/^原话 · 用户说 · 2026-05-0\d /u);
  assert.equal(recordLabel({kind:'entry',type:'plan',state:{validity:'current',progress:'planned'}}),'记忆条目 · 计划（尚未发生） · 当前有效 · 依据时间 时间未知');
});

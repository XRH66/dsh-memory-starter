import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createMemoryVectors} from '../lib/memory-vectors.js';
import {createMemoryQueryAnswer} from '../lib/memory-query.js';
import {createMemoryEntryAccess} from '../lib/memory-entry-access.js';
import {resolveConfig} from '../lib/config.js';
import {embeddingContract} from './embedding-fixture.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent} from './helpers.js';

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'raw-context-vectors-'));
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecall:true,rawRecallModel:'Qwen/Qwen3-Embedding-4B'});
  const store=new RawMemoryStore(path.join(directory,'originals.sqlite'),{warn(){}});
  const raw=createRawRecall({config,ownerSubject:'fictional-owner',store});raw.useExternalVectors();
  const agent=fakeAgent('context-reader'),notes=memoryStore({project:'main'}),calls=[];
  let enabled=true;
  const access={ownerSubject:'fictional-owner',grant(){const controller=new AbortController();return {ownerSubject:this.ownerSubject,project:'main',kind:'read',sessionId:agent.session.id,rootSessionId:agent.session.id,epoch:'one',signal:controller.signal,cancel:()=>controller.abort()};},
    validate:grant=>enabled&&!grant.signal?.aborted,validateMessage:()=>enabled,withGrant:(_g,action)=>action()};
  const entries=createMemoryEntryAccess({access,raw,tools:notes.tools,config});
  const vectors=createMemoryVectors({directory:path.join(directory,'vectors'),access,raw,entries,tools:notes.tools,config,
    findAgent:()=>agent,listAgents:()=>[agent],managementAgent:agent,
    queueConfig:{debounceMs:0,timers:{setTimeout(){return {unref(){}};},clearTimeout(){}}},
    createBackend(){return {...embeddingContract('context-fixture',2560,2048),async embed(texts,{kind,authorize}={}){
      assert.equal(await authorize(),true);calls.push(...texts.map(text=>({text,kind})));
      return texts.map(text=>{const v=Array(2560).fill(0);v[text.includes('温水')?0:1]=1;return v;});
    },async dispose(){}};},
  });
  const grant=vectors.managementGrant({agent});
  const save=({id,role='user',text,sequence,turn=1,sessionId='context-life'})=>store.messages.record({ownerSubject:access.ownerSubject,project:'main',sessionId,messageId:id,role,text,
    content:[{type:'text',text}],sequence,turn,rootTurn:turn,turnState:'completed',time:sequence*1000,authorization:{fixture:true}}, {authorize:()=>enabled}).source;
  const answer=()=>createMemoryQueryAnswer({access,agent,raw,entries,tools:notes.tools,vectors,config});
  t.after(async()=>{grant.cancel();await vectors.close();await raw.dispose();await fs.rm(directory,{recursive:true,force:true});});
  await vectors.ready();await vectors.registerCurrentConfig({grant});
  return {directory,config,store,raw,vectors,grant,save,calls,answer,access,agent};
}

test('contextual raw vectors keep original identity, open preceding evidence, and invalidate on background edit',async t=>{
  const f=await fixture(t);
  const before=f.save({id:'drink-choice',role:'assistant',text:'睡前喝咖啡还是温水？',sequence:2});
  const center=f.save({id:'drink-answer',text:'后者。',sequence:5,turn:2});
  const original=f.store.messages.get({ownerSubject:f.access.ownerSubject,project:'main',id:center.id});
  await f.vectors.prepare({grant:f.grant});
  assert.ok(f.calls.some(call=>call.kind==='document'&&call.text.includes('背景｜助手：睡前喝咖啡还是温水？')&&call.text.endsWith('正文｜用户：后者。')));
  const found=await f.vectors.query({grant:f.grant,query:'睡前选择温水',deadline:Date.now()+2000,limit:40});
  const hit=found.records.find(row=>row.id===center.id);
  assert.ok(hit?.anchor.embedding);assert.equal(hit.text,'后者。');assert.equal(hit.revision,center.revision);
  assert.deepEqual(hit.anchor.match,{start:0,end:3});
  assert.equal('embedding' in hit,false,'encoding text is not copied into returned evidence');
  assert.deepEqual(hit.anchor.embedding.sources.map(row=>row.id),[before.id]);
  assert.deepEqual(f.store.messages.get({ownerSubject:f.access.ownerSubject,project:'main',id:center.id}),original);
  const catalogue=await fs.readFile(path.join(f.directory,'vectors','documents.json'),'utf8');
  assert.equal(catalogue.includes('睡前喝咖啡'),false,'catalogue only stores source proof, not another body');

  const answer=f.answer();t.after(()=>answer.dispose());
  const searched=await answer.search({query:'睡前选择温水',limit:8});
  const issued=searched.records.find(row=>row.id===center.id);assert.ok(issued,JSON.stringify(searched));
  const opened=await answer.expand({anchor:issued.anchor});
  assert.ok(opened.records.some(row=>row.id===before.id&&row.role==='assistant'&&row.text.includes('温水')));
  assert.ok(opened.records.some(row=>row.id===center.id&&row.text==='后者。'));

  const changed=f.save({id:'drink-choice',role:'assistant',text:'睡前喝咖啡还是牛奶？',sequence:3});
  const staleOpen=await answer.expand({anchor:issued.anchor});
  assert.deepEqual(staleOpen.records,[]);assert.equal(staleOpen.channels.source.state,'source_changed');
  assert.equal(await f.vectors.resolveDocument({grant:f.grant,id:center.id,revision:center.revision,anchor:hit.anchor}),null);
  const stale=await f.vectors.query({grant:f.grant,query:'睡前选择温水',deadline:Date.now()+2000,limit:40});
  assert.ok(!stale.records.some(row=>row.id===center.id),'old context vectors cannot represent newly edited evidence');
  await f.vectors.notifyChanged({...changed,kind:'message'});await f.vectors.flush();
  const refreshed=await f.vectors.query({grant:f.grant,query:'睡前选择牛奶',deadline:Date.now()+2000,limit:40});
  const current=refreshed.records.find(row=>row.id===center.id);assert.ok(current);
  assert.equal(current.revision,center.revision,'background changes do not rewrite the center original');
  assert.equal(current.anchor.embedding,undefined,'an edited event with an unproven gap no longer supplies background');
  assert.ok(f.calls.some(call=>call.kind==='document'&&call.text==='后者。'));
  assert.equal((await f.vectors.coverage({grant:f.grant})).caughtUp,true);
});

test('background withdrawal removes stale matches and reindexes only affected material without original edits',async t=>{
  const f=await fixture(t);
  const before=f.save({id:'available-drinks',role:'assistant',text:'你想选咖啡还是温水？',sequence:1});
  const center=f.save({id:'drink-answer',text:'后者。',sequence:2});
  await f.vectors.prepare({grant:f.grant});
  const found=await f.vectors.query({grant:f.grant,query:'温水',deadline:Date.now()+2000,limit:40});
  assert.ok(found.records.find(row=>row.id===center.id)?.anchor.embedding);
  f.store.messages.withdraw({ownerSubject:f.access.ownerSubject,project:'main',id:before.id},{authorize:()=>true});
  const stale=await f.vectors.query({grant:f.grant,query:'温水',deadline:Date.now()+2000,limit:40});
  assert.ok(!stale.records.some(row=>row.id===center.id));
  await f.vectors.notifyChanged({...before,kind:'message'});await f.vectors.flush();
  const refreshed=await f.vectors.query({grant:f.grant,query:'后者',deadline:Date.now()+2000,limit:40});
  assert.equal(refreshed.records.find(row=>row.id===center.id)?.anchor.embedding,undefined);
  assert.equal(f.store.messages.get({ownerSubject:f.access.ownerSubject,project:'main',id:center.id}).text,'后者。');
});

test('four background sources do not crowd the original out of the ordinary search budget',async t=>{
  const f=await fixture(t);
  const save=(sequence,text,role='user')=>f.save({id:'00000000-0000-4000-8000-'+String(sequence).padStart(12,'0'),
    sessionId:'00000000-0000-4000-9000-000000000000',sequence,text,role});
  save(1,'聊聊睡前饮品。');save(2,'咖啡还是温水？','assistant');
  save(3,'我想一下。');save(4,'选好再告诉我。','assistant');
  const center=save(5,'后者。');
  await f.vectors.prepare({grant:f.grant});
  const rawHit=(await f.vectors.query({grant:f.grant,query:'睡前温水',deadline:Date.now()+2000,limit:40})).records.find(r=>r.id===center.id);
  assert.equal(rawHit.anchor.embedding.sources.length,4);
  const answer=f.answer();t.after(()=>answer.dispose());
  const result=await answer.search({query:'睡前温水',limit:8});
  const hit=result.records.find(r=>r.id===center.id);
  assert.ok(hit,JSON.stringify(result));
  assert.equal(hit.text,'后者。');assert.ok(result.budget.tokens<=1024);
  assert.equal(hit.anchor.embedding.sources,undefined);assert.deepEqual(hit.sourceIds,[center.id]);
  const opened=await answer.expand({anchor:hit.anchor});
  assert.ok(opened.records.some(r=>r.id===center.id));
  assert.ok(opened.records.some(r=>r.role==='assistant'&&r.text==='咖啡还是温水？'));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RawMemoryStore, buildTurn, sha256} from '../lib/raw-rag/store.js';
import {createRawQueryReader, displayOriginalSource} from '../lib/raw-rag/query-reader.js';
import {embeddingContract, seedTurnVectors} from './embedding-fixture.js';

const scope = {ownerSubject:'fixture-owner',project:'main'};
const access = {authorize:()=>true};

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'raw-scope-view-'));
  const store = new RawMemoryStore(path.join(dir,'raw.sqlite'));
  t.after(async()=>{store.close();await fs.rm(dir,{recursive:true,force:true});});
  const turn = buildTurn({scope:scope.ownerSubject,sessionId:'session-fixture',turn:1,completedAt:1000,messages:[
    {id:'u1',role:'user',seq:1,text:'LIFE731 去山坡 🌿。WORK904 工单。PARK928 逛公园。'},
    {id:'a1',role:'assistant',seq:2,text:'OPS807 工程建议。可以带野餐垫。'},
    {id:'u2',role:'user',seq:3,text:'WORK888 工程补充。'},
    {id:'a2',role:'assistant',seq:4,text:'公园里还有书摊。'},
  ]});
  store.archiveTurn(turn);
  const key = {scope:turn.scope,turnId:turn.turnId};
  const [first,second,,last] = turn.messages;
  const messages = [
    {messageId:'u1',ranges:[[0,first.text.indexOf('WORK904')],[first.text.indexOf('PARK928'),first.text.length]]},
    {messageId:'a1',ranges:[[second.text.indexOf('可以'),second.text.length]]},
    {messageId:'u2',ranges:[]},
    {messageId:'a2',ranges:[[0,last.text.length]]},
  ];
  const info = ()=>store.getLegacyScopeView(key);
  const review = (next=messages)=>store.setLegacyScopeView({...key,turnRevision:info().turnRevision,messages:next});
  return {store,turn,key,messages,info,review,reader:createRawQueryReader(store,scope,access)};
}

test('mixed legacy text and both speakers keep exact spans and unchanged original proofs',async t=>{
  const {store,turn,key,messages,info,review,reader} = await fixture(t);
  const readOriginal = ()=>store.db.prepare('SELECT doc_text,messages_json,doc_hash,source_revision FROM turns').get();
  const original = readOriginal(),old = reader.search({query:'LIFE731'}).sources[0];
  const proof = store.sourceState({messageId:'u1'},turn.scope).ref;
  assert.equal(info().state,'unreviewed');
  assert.throws(()=>review(messages.slice(1)),/review every message/);
  const invalid = structuredClone(messages);
  invalid[0].ranges = [[0,9],[8,10]];
  assert.throws(()=>review(invalid),/Invalid scope view range/);
  const emoji = turn.messages[0].text.indexOf('🌿');
  invalid[0].ranges = [[emoji,emoji+1]];
  assert.throws(()=>review(invalid),/Invalid scope view range/);
  assert.equal(info().state,'unreviewed');

  const saved = review();
  const reopened = new RawMemoryStore(store.file);
  try { assert.deepEqual(reopened.getLegacyScopeView(key),saved); }
  finally { reopened.close(); }
  assert.deepEqual(readOriginal(),original);
  assert.equal(saved.turnRevision,proof.sourceVersion);
  assert.equal(reader.get(old.ref),null);
  assert.deepEqual(reader.neighbors(old.ref),[]);
  assert.deepEqual(store.sourceState(old.ref,turn.scope).ref,proof);

  const shown = reader.search({query:'PARK928'}).sources[0];
  const neighbors = reader.neighbors(shown.ref);
  assert.deepEqual(neighbors.map(({messageId,role})=>[messageId,role]),[['u1','user'],['a1','assistant'],['a2','assistant']]);
  assert.match(shown.text,/原文片段 UTF-16/);
  assert.match(shown.text,/与前段不连续/);
  assert.match(neighbors[2].text,/本轮选中消息/);
  assert.equal(displayOriginalSource(shown),shown.text);
  assert.equal(shown.ref.turnRevision,proof.sourceVersion);
  assert.equal(shown.ref.scopeViewRevision,saved.scopeViewRevision);
  for (const source of neighbors) {
    const message = turn.messages.find(item=>item.id===source.messageId);
    for (const {start,end,docStart,docEnd,textStart,textEnd} of source.fragment.ranges) {
      const excerpt = source.evidenceText.slice(textStart,textEnd);
      assert.equal(excerpt,message.text.slice(start,end));
      assert.equal(excerpt,turn.docText.slice(docStart,docEnd));
    }
  }
  for (const query of ['WORK904','WORK888','OPS807','LIFE731 PARK928','完整原件保留']) {
    assert.deepEqual(store.searchText(query,{scope:turn.scope}),[]);
    assert.deepEqual(reader.search({query}).sources,[]);
  }
  for (const source of [...reader.recent(),...reader.legacyPage().sources,reader.get(shown.ref)]) {
    assert.doesNotMatch(source.text,/WORK904|WORK888|OPS807/);
  }
  const projected = store.loadTurns([key.turnId],{scope:turn.scope})[0];
  assert.equal(projected.messages[0].text,shown.evidenceText);
  assert.deepEqual(projected.messages[0].fragment,shown.fragment);
  assert.deepEqual(store.loadTurns([key.turnId],{scope:turn.scope,messageId:'u2'}),[]);
  const current = store.sourceState({...proof,evidence:'去山坡'},turn.scope);
  assert.equal(current.text,shown.evidenceText);
  assert.deepEqual(current.ref,proof);
  assert.equal(current.ref.textHash,sha256(turn.messages[0].text));
  assert.equal(store.sourceState({...proof,evidence:'WORK904 工单'},turn.scope).state,'blocked');
  assert.equal(store.sourceState({messageId:'u2'},turn.scope).state,'blocked');
});

test('view revisions retire old open and vector hits, and source edits require a fresh review',async t=>{
  const {store,turn,key,messages,info,review,reader} = await fixture(t);
  await seedTurnVectors(store,embeddingContract('fixture',2),turn,()=>[1,0]);
  const oldVector = store.authorizedTurns('fixture',{scope:turn.scope});
  assert.equal(oldVector.length,1);
  const originalRevision = info().turnRevision;
  const saved = review(),first = reader.legacyPage().sources[0];
  assert.deepEqual(reader.fromTurns(oldVector,{vector:true}),[]);
  assert.equal(store.hasVectors('fixture',{scope:turn.scope}),false);
  assert.deepEqual(store.authorizedTurns('fixture',{scope:turn.scope}),[]);
  assert.deepEqual(store.sourcesNeedingChunks('new-model',{scope:turn.scope}),[]);
  assert.equal(review().scopeViewRevision,saved.scopeViewRevision);

  const changed = structuredClone(messages);
  changed[0].ranges.pop();
  const second = review(changed);
  assert.equal(reader.get(first.ref),null);
  assert.deepEqual(reader.neighbors(first.ref),[]);
  assert.deepEqual(reader.search({query:'PARK928'}).sources,[]);
  assert.throws(()=>store.clearLegacyScopeView({...key,turnRevision:originalRevision,
    expectedScopeViewRevision:saved.scopeViewRevision}),/source or review changed/);
  review();
  assert.equal(reader.get(first.ref),null);
  const beforeEdit = reader.legacyPage().sources[0];
  store.archiveTurn(buildTurn({...turn,messages:[{...turn.messages[0],text:'NEW332 已编辑。'},...turn.messages.slice(1)]}));
  assert.equal(info().state,'stale');
  assert.equal(store.sourceState(beforeEdit.ref,turn.scope).state,'stale');
  assert.equal(reader.get(beforeEdit.ref),null);
  assert.deepEqual(reader.recent(),[]);
  assert.deepEqual(reader.legacyPage().sources,[]);
  assert.deepEqual(reader.search({query:'NEW332'}).sources,[]);
  assert.throws(()=>store.setLegacyScopeView({...key,turnRevision:originalRevision,messages}),/source or review changed/);
  store.archiveTurn(turn);
  assert.equal(info().state,'stale');
  assert.deepEqual(reader.search({query:'LIFE731'}).sources,[]);
  assert.ok(review().scopeViewRevision>second.scopeViewRevision);
  assert.ok(reader.search({query:'LIFE731'}).sources.length);

  const beforeClear = reader.legacyPage().sources[0];
  assert.equal(store.clearLegacyScopeView({...key,turnRevision:info().turnRevision}).state,'cleared');
  assert.equal(reader.get(beforeClear.ref),null);
  assert.equal(reader.search({query:'WORK904'}).sources[0].text,turn.messages[0].text);
});

test('a reviewed view never overrides an operator exclusion or hidden import',async t=>{
  const {store,turn,review,reader} = await fixture(t);
  store.setControl({scope:turn.scope,targetType:'message',targetId:'u2',excluded:true});
  review();
  const hidden = ()=>{
    assert.deepEqual(reader.search({query:'LIFE731'}).sources,[]);
    assert.deepEqual(reader.recent(),[]);
    assert.deepEqual(reader.legacyPage().sources,[]);
    assert.equal(store.sourceState({messageId:'u1'},turn.scope).state,'blocked');
  };
  hidden();
  store.setControl({scope:turn.scope,targetType:'message',targetId:'u2',excluded:false});
  const source = reader.search({query:'LIFE731'}).sources[0];
  store.saveProgress({scope:turn.scope,sourceId:'import',fingerprint:'before',position:1,turnId:turn.turnId});
  store.beginImport(turn.scope,'import','after');
  hidden();
  assert.equal(reader.get(source.ref),null);
  assert.deepEqual(reader.neighbors(source.ref),[]);
});

test('a canonical original bound to a reviewed legacy turn retains its own authority',async t=>{
  const {store,turn,review,reader} = await fixture(t);
  review();
  const input = {...scope,sessionId:turn.sessionId,messageId:'u2',turn:1,rootTurn:1,role:'user',sequence:3,
    text:'CANON733 新原件。',content:[{type:'text',text:'CANON733 新原件。'}],time:1001};
  const {source} = store.messages.record(input,access);
  assert.equal(store.messages.projectionReceipt({...source,consumer:'raw-text-v1'},access),true);
  const found = reader.search({query:'CANON733'}).sources[0];
  assert.equal(found.ref.storage,'message');
  assert.equal(reader.get(found.ref).text,input.text);
  assert.equal(reader.legacyPage().sources.some(item=>item.messageId==='u2'),false);
  store.messages.withdraw({...scope,id:source.id},access);
  assert.equal(reader.get(found.ref),null);
  assert.deepEqual(reader.search({query:'WORK888'}).sources,[]);
});

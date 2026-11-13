import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { performance } from 'node:perf_hooks';
import { buildTurn, canonicalTurnId, rawTurnId, RawMemoryStore, splitClauses } from '../lib/raw-rag/store.js';
import { createRawRecall } from '../lib/raw-rag/index.js';
import { createMemoryVectors } from '../lib/memory-vectors.js';
import { resolveConfig } from '../lib/config.js';
import { embeddingContract, seedTurnVectors } from './embedding-fixture.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);

function fakeEmbedder(modelKey = 'fake-model:4') {
  return {
    ...embeddingContract(modelKey, 4),
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      return texts.map((text) => {
        const v = [0, 0, 0, 0];
        if (String(text).includes('西湖')) v[0] = 1;
        if (String(text).includes('围巾')) v[1] = 1;
        if (String(text).includes('蛋糕')) v[2] = 1;
        if (!v.some(Boolean)) v[3] = 1;
        return v;
      });
    },
    dispose() {},
  };
}

async function tempDb() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-recall-test-'));
  return { dir, db: path.join(dir, 'raw.sqlite') };
}

const turnTables = ['turns', 'windows', 'vectors', 'turn_messages', 'turn_visibility',
  'legacy_scope_views', 'embedding_chunks', 'embedding_chunk_sources', 'import_members'];

const legacyTurnId = value => value.replaceAll('\u001f', '\u0000');
const legacyVersion = value => value.replaceAll('\\u001f', '\\u0000');

function makeTurnIdsLegacy(store,{fromId,toId=fromId}={}) {
  for (const table of turnTables) {
    if(fromId===undefined)store.db.exec(`UPDATE ${table} SET turn_id=replace(turn_id,char(31),char(0))`);
    else store.db.prepare(`UPDATE ${table} SET turn_id=replace(?,char(31),char(0)) WHERE turn_id=?`).run(toId,fromId);
  }
  if(fromId===undefined)store.db.exec(`UPDATE raw_controls SET target_id=replace(target_id,char(31),char(0))
    WHERE target_type='turn'`);
  else store.db.prepare(`UPDATE raw_controls SET target_id=replace(?,char(31),char(0))
    WHERE target_type='turn' AND target_id=?`).run(toId,fromId);
  store.db.exec(`UPDATE legacy_scope_views SET turn_revision=replace(
    turn_revision,char(92)||'u001f',char(92)||'u0000')`);
  store.db.prepare('DELETE FROM raw_schema WHERE key=?').run('turn-id-v2');
}

function turnTableCounts(db) {
  return Object.fromEntries([...turnTables,'raw_controls'].map(table=>[
    table,Number(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n),
  ]));
}

function turnRowsSnapshot(db) {
  const raw=new DatabaseSync(db);
  try {
    const snapshot={};
    for (const table of turnTables) snapshot[table]=raw.prepare(
      `SELECT hex(CAST(turn_id AS BLOB)) id FROM ${table} ORDER BY id`,
    ).all().map(row=>row.id);
    snapshot.raw_controls=raw.prepare(`SELECT hex(CAST(target_id AS BLOB)) id FROM raw_controls
      WHERE target_type='turn' ORDER BY id`).all().map(row=>row.id);
    return snapshot;
  } finally { raw.close(); }
}

function createMigrationVectorHarness({directory,scope,raw,config,calls}) {
  const access={ownerSubject:scope,validate:()=>false};
  const entries={forGrant(){return {async read(){return null;}};}};
  const createBackend=()=>{
    const backend={modelKey:null,batchSize:2,
      async prepare(){calls.push({op:'prepare'});backend.modelKey='turn-id-migration-vectors';return {modelKey:backend.modelKey,dimensions:2560};},
      async planChunks(text,options={}){options.signal?.throwIfAborted();return [{text,start:0,end:text.length,tokenBound:text.length}];},
      async embed(texts,options={}){options.signal?.throwIfAborted();calls.push({op:'embed',kind:options.kind,texts});
        return texts.map(text=>{const pivot=String(text).includes('旧原文')?0:2559;
          return Array.from({length:2560},(_,index)=>index===pivot?1:0);});},
      status(){return {cloud:false,prepared:Boolean(backend.modelKey)};},
      async dispose(){backend.modelKey=null;}};
    return backend;
  };
  return createMemoryVectors({directory,access,raw,entries,tools:{},config,createBackend,
    queueConfig:{debounceMs:60000}});
}

test('turn offsets keep every clause and the last correction', () => {
  const long = Array.from({ length: 14 }, (_, i) => '第' + (i + 1) + '句。').join('');
  const turn = buildTurn({ scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0, messages: [
    { id: 'u1', role: 'user', text: '周六去西湖，记得带伞，改到周日。' },
    { id: 'a1', role: 'assistant', text: long },
  ] });
  assert.equal(turn.docText.slice(turn.messages[0].docStart, turn.messages[0].docEnd), '周六去西湖，记得带伞，改到周日。');
  assert.equal(turn.docText.slice(turn.messages[1].docStart, turn.messages[1].docEnd), long);
  assert.ok(splitClauses('周六去西湖，记得带伞，改到周日。').some((clause) => clause.text.includes('改到周日')));
  assert.equal(splitClauses(long).length, 14);
});

test('store is idempotent, model-isolated and scope/asOf filtered', async (t) => {
  const { dir, db } = await tempDb();
  const store = new RawMemoryStore(db);
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  assert.deepEqual(store.stats('m1', 'owner:a'), { turns: 0, windows: 0, vectors: 0,
    eligibleWindows: 0, indexedWindows: 0, pendingWindows: 0, pendingSources: 0 });
  const turn = buildTurn({ scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0, messages: [
    { id: 'u1', role: 'user', text: '西湖边的蛋糕店。' },
  ] });
  assert.equal(store.archiveTurn(turn).pending, turn.windows.length);
  assert.equal(store.archiveTurn(turn).pending, 0);
  await seedTurnVectors(store, embeddingContract('m1', 2), turn, () => [1, 0]);
  assert.equal(store.authorizedTurns('m1', { scope: 'owner:a', asOf: T0 + 1 }).length, 1);
  assert.equal(store.authorizedTurns('m1', { scope: 'owner:a', asOf: T0 - 1 }).length, 0);
  assert.equal(store.authorizedTurns('m1', { scope: 'owner:b', asOf: T0 + 1 }).length, 0);
  assert.equal(store.authorizedTurns('m2', { scope: 'owner:a', asOf: T0 + 1 }).length, 0);
  store.registerModel(await embeddingContract('m2', 2).prepare());
  const source = store.sourcesNeedingChunks('m2', { scope: 'owner:a' })[0];
  assert.equal(store.putChunks('m2', source, await embeddingContract('m2', 2).planChunks(source.docText)), true);
  const pending = store.pendingWindows('m2', { scope: 'owner:a' });
  assert.equal(pending.length, turn.windows.length);
  assert.equal(store.stats('m1', 'owner:a').vectors, turn.windows.length);
  assert.equal(store.stats('m2', 'owner:a').vectors, 0);
  const indexed = store.stats('m1', 'owner:a'), unindexed = store.stats('m2', 'owner:a');
  assert.equal(indexed.eligibleWindows, turn.windows.length);
  assert.equal(indexed.indexedWindows, turn.windows.length);
  assert.equal(indexed.pendingWindows, 0);
  assert.equal(indexed.pendingSources, 0);
  assert.equal(unindexed.eligibleWindows, pending.length);
  assert.equal(unindexed.indexedWindows, 0);
  assert.equal(unindexed.pendingWindows, pending.length);
  assert.equal(unindexed.pendingSources, 0);
});

test('legacy NUL turn ids migrate with controls, messages and reviewed views intact', async (t) => {
  const { dir, db } = await tempDb();
  let store = new RawMemoryStore(db);
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const scope = 'owner:a';
  const turn = buildTurn({ scope, sessionId: 's1', turn: 1, completedAt: T0, messages: [
    { id: 'u1', role: 'user', text: '旧版标识仍应保留。' },
  ] });
  assert.equal(turn.turnId, rawTurnId(scope, 's1', 1));
  assert.doesNotMatch(turn.turnId, /\u0000/);
  store.archiveTurn(turn);
  const key = { scope, turnId: turn.turnId };
  store.setLegacyScopeView({ ...key, turnRevision: store.getLegacyScopeView(key).turnRevision,
    messages: [{ messageId: 'u1', ranges: [[0, turn.messages[0].text.length]] }] });
  store.setControl({ scope, targetType: 'turn', targetId: turn.turnId, weight: 0.4 });
  const oldId=legacyTurnId(turn.turnId);
  const oldRevision=legacyVersion(store.loadTurns([turn.turnId],{scope})[0].sourceVersion);
  const oldTurnRevision=store.getLegacyScopeView(key).turnRevision;

  makeTurnIdsLegacy(store);
  store.close();

  store = new RawMemoryStore(db);
  assert.deepEqual(store.storedTurn(scope, oldId), turn.messages);
  assert.equal(store.loadTurns([{turnId:oldId,sourceVersion:oldRevision}],{scope}).length,1);
  store.markImportedVisible(scope,oldId);
  store.setControl({scope,targetType:'turn',targetId:oldId,weight:0.4});
  assert.equal(store.getControl({ scope, targetType: 'turn', targetId: oldId }).weight, 0.4);
  assert.equal(store.getLegacyScopeView({scope,turnId:oldId}).state, 'reviewed');
  assert.equal(store.sourceState({scope,turnId:oldId,messageId:'u1',turnRevision:oldTurnRevision},scope).state,'live');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM turns WHERE instr(turn_id,char(0))>0').get().n, 0);
});

test('turn-id migration rolls back as a unit and skips after its marker is durable', async (t) => {
  const { dir, db } = await tempDb();
  let store = new RawMemoryStore(db);
  t.after(async () => {
    store?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const scope='owner:rollback';
  const turn=buildTurn({scope,sessionId:'s-rollback',turn:1,completedAt:T0,messages:[
    {id:'rollback-user',role:'user',text:'事务测试原文。'},
  ]});
  store.archiveTurn(turn);
  store.setControl({scope,targetType:'turn',targetId:turn.turnId,weight:0.3});
  makeTurnIdsLegacy(store);
  store.close();store=null;
  const before=turnRowsSnapshot(db),countDb=new DatabaseSync(db),counts=turnTableCounts(countDb);
  countDb.close();

  let raw=new DatabaseSync(db);
  raw.exec(`CREATE TRIGGER fail_turn_id_migration BEFORE UPDATE ON turn_visibility
    BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;`);
  raw.close();
  assert.throws(()=>new RawMemoryStore(db),/injected migration failure/);
  assert.deepEqual(turnRowsSnapshot(db),before);
  const failed=new DatabaseSync(db);
  assert.equal(failed.prepare('SELECT value FROM raw_schema WHERE key=?').get('turn-id-v2'),undefined);
  failed.exec('DROP TRIGGER fail_turn_id_migration');failed.close();

  store=new RawMemoryStore(db);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM turns WHERE instr(turn_id,char(0))>0').get().n,0);
  assert.deepEqual(turnTableCounts(store.db),counts);
  store.close();store=null;

  raw=new DatabaseSync(db);
  raw.exec(`CREATE TRIGGER fail_repeated_turn_id_migration BEFORE UPDATE ON turns
    BEGIN SELECT RAISE(ABORT,'migration repeated'); END;`);
  raw.close();
  store=new RawMemoryStore(db);
  store.close();store=null;
  raw=new DatabaseSync(db);raw.exec('DROP TRIGGER fail_repeated_turn_id_migration');raw.close();
});

test('conflicting old and new turn ids preserve both bodies and hide the old variant', async (t) => {
  const { dir, db } = await tempDb();
  let store = new RawMemoryStore(db);
  t.after(async () => {
    store?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const scope='owner:conflict';
  const current=buildTurn({scope,sessionId:'s-conflict',turn:3,completedAt:T0,messages:[
    {id:'conflict-new',role:'user',text:'新编号保留的正文。'},
  ]});
  const oldVariant=buildTurn({scope,sessionId:'s-conflict',turn:3,turnId:'conflict-old-temp',completedAt:T0,messages:[
    {id:'conflict-old',role:'user',text:'旧编号也必须保留。'},
  ]});
  store.archiveTurn(current);
  store.archiveTurn(oldVariant);
  store.setControl({scope,targetType:'turn',targetId:current.turnId,weight:0.8});
  store.setControl({scope,targetType:'turn',targetId:oldVariant.turnId,excluded:true,origin:'legacy-rollback'});
  const currentView=store.getLegacyScopeView({scope,turnId:current.turnId});
  const oldView=store.getLegacyScopeView({scope,turnId:oldVariant.turnId});
  store.setLegacyScopeView({scope,turnId:current.turnId,turnRevision:currentView.turnRevision,
    messages:[{messageId:'conflict-new',ranges:[[0,current.messages[0].text.length]]}]});
  store.setLegacyScopeView({scope,turnId:oldVariant.turnId,turnRevision:oldView.turnRevision,
    messages:[{messageId:'conflict-old',ranges:[[0,oldVariant.messages[0].text.length]]}]});
  const counts=turnTableCounts(store.db);
  makeTurnIdsLegacy(store,{fromId:oldVariant.turnId,toId:current.turnId});
  store.close();store=null;

  store=new RawMemoryStore(db);
  assert.deepEqual(store.storedTurn(scope,current.turnId),current.messages);
  const rows=store.db.prepare('SELECT hex(CAST(turn_id AS BLOB)) id,messages_json FROM turns ORDER BY id').all();
  assert.equal(rows.length,2);
  const oldRow=rows.find(row=>JSON.parse(row.messages_json)[0]?.text==='旧编号也必须保留。');
  assert.ok(oldRow);
  const conflictId=Buffer.from(oldRow.id,'hex').toString('utf8');
  assert.ok(conflictId.startsWith('\u001fmigration-conflict\u001f'));
  assert.deepEqual(store.storedTurn(scope,conflictId),oldVariant.messages);
  assert.equal(store.db.prepare('SELECT excluded FROM turn_visibility WHERE namespace=? AND turn_id=?')
    .get(store.namespace,conflictId).excluded,1);
  assert.deepEqual(turnTableCounts(store.db),counts);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM raw_controls WHERE target_type='turn'").get().n,2);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM raw_controls WHERE target_id=?").get(conflictId).n,1);
});

test('canonical turn ids normalize only legacy separators', () => {
  assert.equal(canonicalTurnId('scope\u0000session\u00001'),'scope\u001fsession\u001f1');
  assert.equal(canonicalTurnId('scope\u001fsession\u001f1'),'scope\u001fsession\u001f1');
  assert.equal(canonicalTurnId(7),7);
});

test('twenty thousand old turn ids migrate within a measured reopen window',{timeout:60000},async t=>{
  const { dir, db } = await tempDb();
  let store = new RawMemoryStore(db);
  t.after(async () => {
    store?.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  store.close();store=null;
  const raw=new DatabaseSync(db);
  raw.prepare('DELETE FROM raw_schema WHERE key=?').run('turn-id-v2');
  const insert=raw.prepare(`INSERT INTO turns(
    namespace,turn_id,scope,session_id,turn,completed_at,doc_hash,doc_text,messages_json,created_at,source_revision)
    VALUES('default',replace('perf'||char(31)||?||char(31)||'turn',char(31),char(0)),
      'perf-owner','perf-session',1,?,'perf-hash','perf','[]',0,1)`);
  raw.exec('BEGIN IMMEDIATE');
  for(let i=0;i<20000;i++)insert.run(i,i);
  raw.exec(`INSERT INTO turn_visibility(namespace,turn_id) SELECT namespace,turn_id FROM turns;
    INSERT INTO raw_text_index(rowid,terms,source_hash) SELECT rowid,'perf',doc_hash FROM turns;
    COMMIT;`);
  raw.close();
  const firstStart=performance.now();
  store=new RawMemoryStore(db);
  const firstOpenMs=performance.now()-firstStart;
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM turns WHERE instr(turn_id,char(0))>0').get().n,0);
  store.close();store=null;
  const secondStart=performance.now();
  store=new RawMemoryStore(db);
  const repeatOpenMs=performance.now()-secondStart;
  t.diagnostic(`20000 回合迁移：首次含迁移 ${firstOpenMs.toFixed(1)} ms，仅重开 ${repeatOpenMs.toFixed(1)} ms，估算迁移 ${Math.max(0,firstOpenMs-repeatOpenMs).toFixed(1)} ms`);
});

test('legacy vector anchors survive migration without rewriting or re-encoding documents',{timeout:60000},async t=>{
  const {dir,db}=await tempDb();
  const scope='owner:vector-migration',vectorDirectory=path.join(dir,'vectors');
  const config={rawRecall:true,rawRecallDbPath:db,vaultPath:path.join(dir,'vault'),project:'main',
    rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallGgufModel:'fictional-Q4.gguf',rawRecallDevice:'auto',
    rawRecallCpuThreads:6,rawRecallGpuThreads:4,rawRecallIdleMs:120000};
  await fs.mkdir(config.vaultPath);
  let store=new RawMemoryStore(db),raw,api;
  t.after(async()=>{
    await api?.close();
    await raw?.dispose();
    store?.close();
    assert.equal(path.dirname(dir),path.resolve(os.tmpdir()));
    await fs.rm(dir,{recursive:true,force:true});
  });
  const turn=buildTurn({scope,sessionId:'s-vector-migration',turn:1,completedAt:T0,messages:[
    {id:'vector-user',role:'user',seq:1,text:'旧原文仍应命中向量档案。'},
    {id:'vector-assistant',role:'assistant',seq:2,text:'这是旧回合里的回答。'},
  ]});
  store.archiveTurn(turn);
  const oldId=legacyTurnId(turn.turnId);

  const firstCalls=[];
  raw=createRawRecall({config,ownerSubject:scope,store});raw.useExternalVectors();
  api=createMigrationVectorHarness({directory:vectorDirectory,scope,raw,config,calls:firstCalls});
  let grant=api.managementGrant();
  await api.ready();
  await api.registerCurrentConfig({grant});
  await api.prepare({grant});
  const firstQuery=await api.query({grant,query:'旧原文',limit:5,deadline:Date.now()+2000});
  const preparedRecord=firstQuery.records.find(record=>record.text.includes('旧原文'));
  assert.ok(preparedRecord,JSON.stringify(firstQuery));
  const oldRef=structuredClone(preparedRecord.anchor.ref);
  oldRef.turnId=oldId;
  oldRef.revision=legacyVersion(oldRef.revision);
  if(oldRef.turnRevision!==undefined)oldRef.turnRevision=legacyVersion(oldRef.turnRevision);
  assert.equal(oldRef.turnId,oldId);

  await api.close();api=null;grant.cancel();
  makeTurnIdsLegacy(store);
  await raw.dispose();raw=null;store=null;
  const documentFile=path.join(vectorDirectory,'documents.json');
  const documentsBefore=(await fs.readFile(documentFile,'utf8')).replaceAll('\\u001f','\\u0000');
  assert.match(documentsBefore,/\\u0000/);
  await fs.writeFile(documentFile,documentsBefore);
  const vectorIndex=new DatabaseSync(path.join(vectorDirectory,'vectors.sqlite'));
  vectorIndex.exec(`UPDATE vector_documents SET anchor=replace(
    anchor,char(92)||'u001f',char(92)||'u0000') WHERE anchor IS NOT NULL`);
  assert.ok(vectorIndex.prepare('SELECT anchor FROM vector_documents WHERE anchor IS NOT NULL').all()
    .some(row=>row.anchor.includes('\\u0000')));
  vectorIndex.close();

  store=new RawMemoryStore(db);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM turns WHERE instr(turn_id,char(0))>0').get().n,0);
  const secondCalls=[];
  raw=createRawRecall({config,ownerSubject:scope,store});raw.useExternalVectors();
  api=createMigrationVectorHarness({directory:vectorDirectory,scope,raw,config,calls:secondCalls});
  grant=api.managementGrant();
  await api.ready();
  const embeddedBefore=secondCalls.filter(call=>call.op==='embed'&&call.kind==='document').length;
  const secondQuery=await api.query({grant,query:'旧原文',limit:5,deadline:Date.now()+2000});
  const secondRecord=secondQuery.records.find(record=>record.text.includes('旧原文'));
  assert.ok(secondRecord);
  assert.equal(secondCalls.filter(call=>call.op==='embed'&&call.kind==='document').length,embeddedBefore);
  const secondReader=raw.queryReader({ownerSubject:scope,project:'main'},{authorize:()=>true});
  assert.equal(secondReader.get(oldRef)?.text,secondRecord.text);
  assert.deepEqual(secondReader.neighbors(oldRef).map(source=>source.role),['user','assistant']);
  assert.equal(raw.querySourceState(oldRef).state,'live');
  assert.equal(await fs.readFile(documentFile,'utf8'),documentsBefore);
});

test('dispose drains queued turns before closing the store', async (t) => {
  const { dir, db } = await tempDb();
  const embedder = fakeEmbedder();
  const original = embedder.embed;
  embedder.embed = async function (...args) { await new Promise((resolve) => setTimeout(resolve, 15)); return original.apply(this, args); };
  const recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: db }),
    ownerSubject: () => 'owner:a', embedder, logger: { warn() {} } });
  for (let turn = 1; turn <= 3; turn += 1) {
    await recall.archiveTurn({ sessionId: 's1', turn, completedAt: T0 + turn,
      messages: [{ id: 'u' + turn, role: 'user', text: '第' + turn + '轮西湖。' }] });
  }
  await recall.dispose();
  const store = new RawMemoryStore(db);
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const stats = store.stats('fake-model:4', 'owner:a');
  assert.equal(stats.turns, 3);
  assert.equal(stats.vectors, stats.windows);
});

test('invalid db path is deferred and never breaks construction', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-recall-bad-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const blocker = path.join(dir, 'blocked');
  await fs.writeFile(blocker, 'not a directory');
  const recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: path.join(blocker, 'raw.sqlite') }),
    ownerSubject: () => 'owner:a', embedder: fakeEmbedder(), logger: { warn() {} } });
  t.after(() => recall.dispose());
  assert.equal(recall.status().stats, null);
  const result = await recall.archiveTurn({ sessionId: 's1', turn: 1, completedAt: T0, messages: [{ id: 'u1', role: 'user', text: '西湖。' }] });
  assert.equal(result.skipped, 'failed');
});

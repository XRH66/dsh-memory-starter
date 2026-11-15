import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createRawQueryReader} from '../lib/raw-rag/query-reader.js';
import {createMemoryQueryAnswer,recordLabel,SUMMARY_RERANK_WEIGHT} from '../lib/memory-query.js';
import {createMemoryDocuments} from '../lib/memory-documents.js';
import {resolveConfig} from '../lib/config.js';
import {applyInheritRecords,inheritPreview} from '../lib/inherit/importer.js';
import {listInheritBatches,restoreInheritBatch,undoInheritBatch} from '../lib/inherit/batches.js';
import {embeddingContract} from './embedding-fixture.js';

const scope='fictional-inherit-owner';

function records() {
  return [
    {id:'summary-one',time:'2026-10-25',speaker:'summary',kind:'note',text:'翡翠旧笔记：书架以前放在北墙。',
      source:{system:'basic-memory-0.3',file:'chats/facts/summary.md'},tags:['subject:虚构主体']},
    {id:'user-one',time:'2026-10-20T10:00:00Z',speaker:'user',kind:'message',text:'翡翠原话：书架后来搬到南墙。',
      source:{system:'fixture-import',file:'u1'}},
    {id:'assistant-one',time:'2026-10-20T10:01:00Z',speaker:'assistant',kind:'message',text:'收到，我会记住新的位置。',
      source:{system:'fixture-import',file:'a1'}},
  ];
}

function fakeEmbedder() {
  const contract=embeddingContract('inherit-fixture:4',4);
  return {...contract,async embed(texts){
    return texts.map(text=>String(text).includes('翡翠')?[1,0,0,0]:[0,1,0,0]);
  },async dispose(){}};
}

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-import-'));
  await fs.mkdir(path.join(directory,'vault'),{recursive:true});
  const dbFile=path.join(directory,'raw.sqlite');
  const store=new RawMemoryStore(dbFile,{warn(){}});
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecall:true,
    rawRecallModel:'BAAI/bge-small-zh-v1.5',rawRecallDbPath:dbFile});
  const embedder=fakeEmbedder();
  const recall=createRawRecall({config,ownerSubject:scope,store,embedder,logger:{warn(){}}});
  const observer=new RawMemoryStore(dbFile,{warn(){}});
  t.after(async()=>{
    observer.close();
    await recall.dispose();
    store.close();
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {directory,dbFile,store,observer,config,embedder,recall};
}

function queryAnswer(f,raw=f.recall,config=f.config) {
  const owner=scope;
  let current=true;
  const grant={kind:'read',ownerSubject:owner,project:'main',sessionId:'session-current',rootSessionId:'session-current',epoch:'fixture',signal:new AbortController().signal};
  const access={ownerSubject:owner,grant:()=>grant,validate:()=>current,validateMessage:()=>current,assertCurrent(){if(!current)throw Error('closed');},withGrant:(_grant,work)=>work()};
  const entries={forGrant:()=>({search:async()=>[],read:async()=>null})};
  const answer=createMemoryQueryAnswer({access,agent:{session:{id:'session-current'}},raw,entries,tools:{},config});
  return {answer,revoke(){current=false;grant.signal?.dispatchEvent?.(new Event('abort'));}};
}

test('turns import preserves summary, supports text/open/vector retrieval and reports batch outcomes',async t=>{
  const f=await fixture(t),batch='inherit-fixture-batch-one';
  const applied=applyInheritRecords({store:f.store,scope,records:records(),batchId:batch,
    source:{kind:'file',path:'fixture.jsonl'},clock:()=>1000});
  assert.deepEqual({inserted:applied.inserted,skipped:applied.skipped,conflicts:applied.conflicts,undone:applied.undone},
    {inserted:3,skipped:0,conflicts:0,undone:0});
  await f.recall.indexPending();
  const stats=f.store.stats(f.embedder.modelKey,scope);
  assert.equal(stats.turns,3);
  assert.ok(stats.vectors>0);
  const summaryRow=f.store.db.prepare(`SELECT doc_text,messages_json FROM turns
    WHERE scope=? AND messages_json LIKE ?`).get(scope,'%summary-one%');
  assert.match(summaryRow.doc_text,/^旧笔记：翡翠旧笔记/u);
  assert.doesNotMatch(summaryRow.doc_text,/用户：|助手：/u);
  assert.equal(JSON.parse(summaryRow.messages_json)[0].role,'summary');
  const vectorText=[...f.store.windowPages(f.embedder.modelKey,{scope,includeText:true})]
    .flat().map(row=>row.text).join('\n');
  assert.match(vectorText,/旧笔记：翡翠旧笔记/u);

  const reader=createRawQueryReader(f.observer,{ownerSubject:scope,project:'main'},{authorize:()=>true});
  const text=reader.search({query:'翡翠',limit:10}).sources;
  assert.deepEqual(text.map(source=>source.role).sort(),['summary','user']);
  const summary=text.find(source=>source.role==='summary');
  assert.equal(summary.imported,true);
  assert.equal(summary.import.batchId,batch);
  assert.equal(reader.get(summary.ref).text,summary.text);
  const {answer}=queryAnswer(f);
  t.after(()=>answer.dispose());
  const modelSearch=await answer.search({query:'翡翠',limit:3});
  assert.match(modelSearch.records[0].label,/^原话 · 用户说/u,'same lexical score puts 0.7 summary after original');
  const summaryRecord=modelSearch.records.find(record=>record.label.startsWith('旧笔记（整理摘要）'));
  const userRecord=modelSearch.records.find(record=>record.label.startsWith('原话 · 用户说'));
  assert.match(summaryRecord.label,/^旧笔记（整理摘要） · 写于 2026-10-2\d/u);
  assert.match(userRecord.label,/原话 · 用户说 .* · 导入$/u);
  const opened=await answer.expand({ref:summaryRecord.ref});
  assert.equal(opened.records[0].label,summaryRecord.label);
  assert.equal(opened.records[0].text,summaryRecord.text);
  assert.equal(SUMMARY_RERANK_WEIGHT,0.7);
  assert.equal(recordLabel({kind:'original',role:'summary',time:null}),'旧笔记（整理摘要） · 写于时间不详');

  assert.deepEqual(reader.recent(),[]);
  assert.deepEqual(f.recall.messageReader({ownerSubject:scope,project:'main'},{authorize:()=>true}).list({}).sources,[]);
  assert.equal(listInheritBatches(f.store.db)[0].inserted,3);

  const duplicate=applyInheritRecords({store:f.store,scope,records:records(),batchId:'inherit-fixture-batch-two',
    source:{kind:'file',path:'fixture.jsonl'},clock:()=>2000});
  assert.equal(duplicate.inserted,0);
  assert.equal(duplicate.skipped,3);
  const conflictRecord={...records()[0],text:'同号但正文不同。'};
  const conflict=applyInheritRecords({store:f.store,scope,records:[conflictRecord],batchId:'inherit-fixture-conflict',
    source:{kind:'file',path:'conflict.jsonl'},clock:()=>3000});
  assert.deepEqual({inserted:conflict.inserted,conflicts:conflict.conflicts},{inserted:0,conflicts:1});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM turns WHERE scope=?').get(scope).n,3);

  const preview=inheritPreview(f.store.db,scope,records());
  assert.deepEqual({insert:preview.insert,skip:preview.skip,conflict:preview.conflict,undone:preview.undone},
    {insert:0,skip:3,conflict:0,undone:0});
});

test('imported summary without a written time is labelled undated, not 1970',async t=>{
  const f=await fixture(t);
  const undated={id:'summary-undated',speaker:'summary',kind:'note',text:'琥珀旧笔记：阳台的花每周浇一次。',
    source:{system:'basic-memory-0.3',file:'chats/facts/undated.md'}};
  applyInheritRecords({store:f.store,scope,records:[undated],batchId:'inherit-fixture-undated',
    source:{kind:'file',path:'undated.jsonl'},clock:()=>1000});
  await f.recall.indexPending();
  const {answer}=queryAnswer(f);
  t.after(()=>answer.dispose());
  const found=(await answer.search({query:'琥珀',limit:3})).records.find(record=>record.text.includes('琥珀'));
  assert.equal(found.label,'旧笔记（整理摘要） · 写于时间不详');
  assert.equal(found.time,undefined);
  assert.equal(found.localTime,undefined);
  const opened=await answer.expand({ref:found.ref});
  assert.equal(opened.records[0].label,'旧笔记（整理摘要） · 写于时间不详');
});

test('batch undo blocks search/recent/open, restore revives, and reimport stays non-duplicating',async t=>{
  const f=await fixture(t),batch='inherit-fixture-undo';
  applyInheritRecords({store:f.store,scope,records:records(),batchId:batch,
    source:{kind:'vault',path:'fixture-vault'},clock:()=>1000});
  const reader=createRawQueryReader(f.observer,{ownerSubject:scope,project:'main'},{authorize:()=>true});
  const before=reader.search({query:'翡翠',limit:10}).sources.find(source=>source.role==='summary');
  const undone=undoInheritBatch(f.store,batch);
  assert.equal(undone.state,'undone');
  assert.deepEqual(reader.search({query:'翡翠',limit:10}).sources,[]);
  assert.equal(reader.get(before.ref),null);
  assert.deepEqual(reader.recent(),[]);
  const reimport=applyInheritRecords({store:f.store,scope,records:records(),batchId:'inherit-fixture-reimport',
    source:{kind:'file',path:'reimport.jsonl'},clock:()=>2000});
  assert.deepEqual({inserted:reimport.inserted,undone:reimport.undone},{inserted:0,undone:3});
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM turns WHERE scope=?').get(scope).n,3);
  const restored=restoreInheritBatch(f.store,batch);
  assert.equal(restored.state,'active');
  assert.equal(reader.search({query:'翡翠',limit:10}).sources.length,2);
  assert.equal(reader.get(before.ref)?.role,'summary');
});

test('memory document material gives summary a non-conversational vector heading',async t=>{
  const f=await fixture(t);
  applyInheritRecords({store:f.store,scope,records:[records()[0]],batchId:'inherit-fixture-vector-doc',
    source:{kind:'file',path:'vector.jsonl'},clock:()=>1000});
  const grant={kind:'management',ownerSubject:scope,project:'main'};
  const raw=f.recall;
  const entries={forGrant:()=>({read:async()=>null})};
  const documents=createMemoryDocuments({
    directory:path.join(f.directory,'documents'),
    access:{validate:value=>value===grant},
    raw,entries,tools:{},
    config:f.config,
    authorize:value=>value===grant,
    agentForGrant:()=>null,
  });
  t.after(()=>documents.close());
  const rows=[];
  for await(const row of documents.listDocuments({grant}))rows.push(row);
  const summary=rows.find(row=>row.id===rows.find(item=>item.role==='summary')?.id);
  assert.equal(summary.role,'summary');
  assert.equal(summary.embedding.prefix,'正文｜旧笔记：');
  assert.equal(summary.embedding.heading,'正文｜旧笔记：');
  assert.doesNotMatch(summary.embedding.prefix,/用户：|助手：/u);
});

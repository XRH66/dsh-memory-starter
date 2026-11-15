import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createRawQueryReader} from '../lib/raw-rag/query-reader.js';
import {runInheritCli,INHERIT_HELP} from '../lib/inherit/cli.js';
import {embeddingContract} from './embedding-fixture.js';

function fakeEmbedder() {
  const embedder=embeddingContract('inherit-cli-fixture:4',4);
  return {...embedder,async embed(texts){
    return texts.map(text=>String(text).includes('旧记忆')?[1,0,0,0]:[0,1,0,0]);
  },async dispose(){}};
}

function recorder() {
  const lines=[];
  return {lines,write:line=>lines.push(JSON.parse(line))};
}

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-cli-'));
  const owner=path.join(directory,'owner'),sourceVault=path.join(directory,'source-vault');
  const dbFile=path.join(owner,'management','raw-recall','raw-recall.sqlite');
  const deployment=path.join(directory,'deployment.json');
  await fs.mkdir(path.join(sourceVault,'chats','facts'),{recursive:true});
  await fs.writeFile(path.join(sourceVault,'chats','facts','old.md'),[
    '---',
    'memory_id: cli-old',
    'memory_kind: fact',
    'subject: 虚构主体',
    'value: 旧记忆：虚构花园在河边。',
    'recorded_at: "2026-10-25T00:00:00Z"',
    '---',
    '',
    '正文不覆盖 value',
  ].join('\n'));
  await fs.writeFile(deployment,JSON.stringify({
    ownerDirectory:owner,
    ownerSubject:'fictional-cli-owner',
    memory:{rawRecall:true,rawRecallDbPath:dbFile},
  }));
  await fs.mkdir(path.dirname(dbFile),{recursive:true});
  new RawMemoryStore(dbFile,{warn(){}}).close();
  let clock=0;
  const cli=async(command,...args)=>{
    const output=recorder(),errors=recorder();
    const outcome=await runInheritCli([command,'--deployment',deployment,...args],{
      cwd:directory,
      stdout:output.write,
      stderr:errors.write,
      now:()=>new Date(1_800_000_000_000+clock++*1000),
      createRecall:input=>createRawRecall({...input,embedder:fakeEmbedder()}),
    });
    return {...outcome,output:output.lines,errors:errors.lines};
  };
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return {directory,owner,sourceVault,dbFile,deployment,cli};
}

function readerFor(dbFile) {
  const store=new RawMemoryStore(dbFile,{warn(){}});
  return {
    store,
    reader:createRawQueryReader(store,{ownerSubject:'fictional-cli-owner',project:'main'},{authorize:()=>true}),
  };
}

test('check, apply, list, undo and restore work through the command entry with a fake embedding adapter',async t=>{
  const f=await fixture(t),out=path.join(f.directory,'checked.jsonl');
  const checked=await f.cli('check','--vault',f.sourceVault,'--out',out);
  assert.equal(checked.exitCode,0);
  const checkReport=checked.output[0];
  assert.equal(checkReport.ok,true);
  assert.equal(checkReport.summary.total,1);
  assert.equal(checkReport.summary.byKind.note,1);
  assert.equal(checkReport.summary.bySpeaker.summary,1);
  assert.equal(checkReport.comparison.insert,1);
  const exported=(await fs.readFile(out,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.equal(exported[0].standard,'dsh-memory-inherit');
  assert.equal(exported[1].speaker,'summary');

  const applied=await f.cli('apply','--vault',f.sourceVault);
  assert.equal(applied.exitCode,0,JSON.stringify(applied));
  const applyResult=applied.output[0];
  assert.equal(applyResult.inserted,1);
  assert.equal(applyResult.skipped,0);
  assert.equal(applyResult.conflicts,0);
  assert.ok(applyResult.batchId.startsWith('inherit-'));
  assert.ok(applyResult.backup&&await fs.stat(applyResult.backup).then(stat=>stat.isFile()));
  assert.ok(applyResult.indexing.embedded>0);
  assert.equal(applyResult.verification.passed,true);
  assert.equal(applyResult.runtime.restartRequired,false);

  const listed=await f.cli('list');
  assert.equal(listed.exitCode,0);
  const batch=listed.output[0].batches.find(row=>row.batchId===applyResult.batchId);
  assert.equal(batch.state,'active');
  assert.equal(batch.inserted,1);

  const opened=readerFor(f.dbFile);
  assert.match(opened.reader.search({query:'旧记忆',limit:5}).sources[0].text,/虚构花园/u);
  const undone=await f.cli('undo','--batch',applyResult.batchId);
  assert.equal(undone.exitCode,0,JSON.stringify(undone));
  assert.equal(opened.reader.search({query:'旧记忆',limit:5}).sources.length,0);
  assert.equal((await f.cli('list')).output[0].batches.find(row=>row.batchId===applyResult.batchId).state,'undone');

  const restored=await f.cli('restore','--batch',applyResult.batchId);
  assert.equal(restored.exitCode,0,JSON.stringify(restored));
  assert.equal(opened.reader.search({query:'旧记忆',limit:5}).sources.length,1);
  opened.store.close();
});

test('apply rejects validation errors before backup or import and help documents recovery',async t=>{
  const f=await fixture(t),bad=path.join(f.directory,'bad.jsonl');
  await fs.writeFile(bad,[
    JSON.stringify({standard:'dsh-memory-inherit',version:1,source:'fixture'}),
    JSON.stringify({speaker:'owner',kind:'note',text:'正文',source:{system:'fixture',file:'bad'}}),
  ].join('\n'));
  const attempted=await f.cli('apply','--file',bad);
  assert.equal(attempted.exitCode,1);
  assert.equal(attempted.errors[0].ok,false);
  const store=new RawMemoryStore(f.dbFile,{warn(){}});
  const count=store.db.prepare('SELECT COUNT(*) n FROM turns').get().n;
  store.close();
  assert.equal(count,0);
  assert.match(INHERIT_HELP,/undo 用 raw_controls 按整批排除原话/u);
  assert.match(INHERIT_HELP,/restore 用同一机制恢复/u);
});

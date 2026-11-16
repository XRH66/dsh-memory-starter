import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createRawQueryReader} from '../lib/raw-rag/query-reader.js';
import {runInheritCli,INHERIT_HELP} from '../lib/inherit/cli.js';
import {convertLegacyVault} from '../lib/inherit/vault.js';
import {applyInheritRecords} from '../lib/inherit/importer.js';
import {embeddingContract} from './embedding-fixture.js';

const ENTRY_START='<!-- dsh-memory-entry:start -->';
const ENTRY_END='<!-- dsh-memory-entry:end -->';
const INDEX_NOTICE='运行中的 DSH 要到「状态」页点「准备索引」（或重启），新导入的内容才会进向量索引；全文检索不需要。';

function fakeEmbedder() {
  const embedder=embeddingContract('inherit-cli-fixture:4',4);
  return {...embedder,async embed(texts){
    return texts.map(text=>String(text).includes('翡翠')?[1,0,0,0]:[0,1,0,0]);
  },async dispose(){}};
}

function recorder() {
  const lines=[];
  return {lines,write:line=>lines.push(JSON.parse(line))};
}

async function write(root,relative,content) {
  const file=path.join(root,...relative.split('/'));
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,content);
  return file;
}

function note(metadata,body='') {
  const lines=['---'];
  for(const [key,value] of Object.entries(metadata)) {
    if(Array.isArray(value)) lines.push(key+':',...value.map(item=>'- '+item));
    else lines.push(key+': '+value);
  }
  lines.push('---','',body);
  return lines.join('\n');
}

function appendField(lines,key,value) {
  if(value===undefined) return;
  if(Array.isArray(value)) {
    lines.push(key+':');
    for(const item of value) lines.push('  - '+JSON.stringify(item));
    return;
  }
  lines.push(key+': '+JSON.stringify(value));
}

function renderedNote({title,type='note',permalink,metadata={},tags=[],content=''}) {
  const lines=['---'];
  appendField(lines,'title',title);
  appendField(lines,'type',type);
  appendField(lines,'permalink',permalink);
  for(const [key,value] of Object.entries(metadata)) {
    if(['title','type','permalink','tags'].includes(key)) continue;
    appendField(lines,key,value);
  }
  appendField(lines,'tags',tags);
  lines.push('---');
  return lines.join('\n')+'\n\n'+String(content);
}

async function entryNote(root,relative,{
  title,
  managed,
  sourceRefs=[],
  evidenceBasis='observed',
  validity='current',
  supplement='',
  legacyImportFrom=null,
  recordedAt='2026-10-26T08:00:00Z',
}={}) {
  const metadata={
    embed:false,
    memory_entry_schema:'memory-entry-v1',
    memory_entry_id:'fixture-'+path.posix.basename(relative,'.md'),
    memory_type:'fact',
    subject_ref:'',
    memory_source_refs:JSON.stringify(sourceRefs),
    state_validity:validity,
    state_progress:'',
    importance:'null',
    evidence_basis:evidenceBasis,
    ...(legacyImportFrom?{legacy_import_from:JSON.stringify(legacyImportFrom)}:{}),
    recorded_at:recordedAt,
  };
  const content=[
    '# '+title,
    '',
    ENTRY_START,
    managed,
    ENTRY_END,
    '主题：[[翡翠]]',
    ...(supplement?[supplement]:[]),
  ].join('\n');
  return write(root,relative,renderedNote({
    title,
    permalink:'main/'+relative.replace(/\.md$/u,''),
    metadata,
    tags:['dsh-memory'],
    content,
  }));
}

async function snapshotTree(root) {
  const output=[];
  async function visit(directory,relative='') {
    const entries=await fs.readdir(directory,{withFileTypes:true});
    entries.sort((left,right)=>left.name.localeCompare(right.name));
    for(const entry of entries) {
      const rel=relative?relative+'/'+entry.name:entry.name;
      const full=path.join(directory,entry.name);
      const stat=await fs.stat(full);
      if(entry.isDirectory()) {
        output.push({path:rel,type:'directory',mtimeMs:stat.mtimeMs});
        await visit(full,rel);
      }else {
        output.push({
          path:rel,
          type:'file',
          mtimeMs:stat.mtimeMs,
          content:await fs.readFile(full,'base64'),
        });
      }
    }
  }
  await visit(root);
  return output;
}

async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-cli-'));
  const owner=path.join(directory,'owner'),sourceVault=path.join(directory,'source-vault');
  const ownerVault=path.join(owner,'vault');
  const dbFile=path.join(owner,'management','raw-recall','raw-recall.sqlite');
  const deployment=path.join(directory,'deployment.json');
  await write(sourceVault,'chats/facts/old.md',note({
    memory_id:'cli-old',
    memory_kind:'fact',
    subject:'虚构主体',
    value:'旧记忆：翡翠花园在河边。',
    recorded_at:'2026-10-25T00:00:00Z',
  },'正文不覆盖 value'));
  await entryNote(sourceVault,'chats/entries/current.md',{
    title:'书架条目',
    managed:'条目正文：翡翠书架在南墙。',
    supplement:'用户补充：保留这张照片。',
  });
  await write(ownerVault,'chats/facts/default.md',note({
    memory_id:'cli-default',
    memory_kind:'fact',
    value:'旧记忆：默认库属于部署配置。',
    recorded_at:'2026-10-24',
  },''));
  await write(directory,'deployment.json',JSON.stringify({
    ownerDirectory:owner,
    ownerSubject:'fictional-cli-owner',
    memory:{rawRecall:true,rawRecallModel:'BAAI/bge-small-zh-v1.5',rawRecallDbPath:dbFile},
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
  return {directory,owner,ownerVault,sourceVault,dbFile,deployment,cli};
}

function readerFor(dbFile) {
  const store=new RawMemoryStore(dbFile,{warn(){}});
  return {
    store,
    reader:createRawQueryReader(store,{ownerSubject:'fictional-cli-owner',project:'main'},{authorize:()=>true}),
  };
}

test('mixed 0.3 and 0.6 Vault checks, imports once, searches, opens, undoes and restores',async t=>{
  const f=await fixture(t),out=path.join(f.directory,'checked.jsonl');
  const before=await snapshotTree(f.directory);
  const checked=await f.cli('check','--vault',f.sourceVault);
  assert.equal(checked.exitCode,0,JSON.stringify(checked));
  const checkReport=checked.output[0];
  assert.equal(checkReport.ok,true);
  assert.equal(checkReport.summary.total,2);
  assert.equal(checkReport.summary.byKind.note,2);
  assert.equal(checkReport.summary.bySpeaker.summary,2);
  assert.equal(checkReport.comparison.insert,2);
  assert.deepEqual(checkReport.conversion.basicMemory03,{imported:1,skipped:0});
  assert.equal(checkReport.conversion.entries.imported,1);
  const after=await snapshotTree(f.directory);
  assert.deepEqual(after,before);

  const checkedOut=await f.cli('check','--vault',f.sourceVault,'--out',out);
  assert.equal(checkedOut.exitCode,0,JSON.stringify(checkedOut));
  const exported=(await fs.readFile(out,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.equal(exported[0].standard,'dsh-memory-inherit');
  assert.equal(exported.length,3);
  assert.deepEqual(exported.filter(item=>item.speaker).map(item=>item.source.system).sort(),[
    'basic-memory-0.3','basic-memory-0.6',
  ]);

  const applied=await f.cli('apply','--vault',f.sourceVault);
  assert.equal(applied.exitCode,0,JSON.stringify(applied));
  const applyResult=applied.output[0];
  assert.equal(applyResult.inserted,2);
  assert.equal(applyResult.skipped,0);
  assert.equal(applyResult.conflicts,0);
  assert.equal(applyResult.indexingNotice,INDEX_NOTICE);
  assert.ok(applyResult.backup&&await fs.stat(applyResult.backup).then(stat=>stat.isFile()));
  assert.ok(applyResult.indexing.embedded>0);
  assert.equal(applyResult.verification.passed,true);
  assert.equal(applyResult.verification.total,2);
  assert.equal(applyResult.runtime.restartRequired,false);

  const duplicate=await f.cli('apply','--vault',f.sourceVault);
  assert.equal(duplicate.exitCode,0,JSON.stringify(duplicate));
  assert.equal(duplicate.output[0].inserted,0);
  assert.equal(duplicate.output[0].skipped,2);
  assert.equal(duplicate.output[0].conflicts,0);

  const checkedAgain=await f.cli('check','--vault',f.sourceVault);
  assert.equal(checkedAgain.output[0].comparison.insert,0);
  assert.equal(checkedAgain.output[0].comparison.skip,2);

  const opened=readerFor(f.dbFile);
  const sources=opened.reader.search({query:'翡翠',limit:10}).sources;
  assert.equal(sources.length,2);
  const entrySource=sources.find(source=>source.text.includes('用户补充：保留这张照片。'));
  assert.ok(entrySource);
  assert.equal(opened.reader.get(entrySource.ref)?.text,entrySource.text);

  const undone=await f.cli('undo','--batch',applyResult.batchId);
  assert.equal(undone.exitCode,0,JSON.stringify(undone));
  assert.equal(opened.reader.search({query:'翡翠',limit:10}).sources.length,0);
  assert.equal(opened.reader.get(entrySource.ref),null);

  const restored=await f.cli('restore','--batch',applyResult.batchId);
  assert.equal(restored.exitCode,0,JSON.stringify(restored));
  assert.equal(opened.reader.search({query:'翡翠',limit:10}).sources.length,2);
  assert.equal(opened.reader.get(entrySource.ref)?.text,entrySource.text);
  const listed=await f.cli('list');
  assert.equal(listed.output[0].batches.find(row=>row.batchId===applyResult.batchId).state,'active');
  opened.store.close();
});

test('default Vault, include-derived and source exclusivity follow the command contract',async t=>{
  const f=await fixture(t);
  const defaultChecked=await f.cli('check');
  assert.equal(defaultChecked.exitCode,0,JSON.stringify(defaultChecked));
  assert.equal(defaultChecked.output[0].summary.total,1);
  assert.equal(defaultChecked.output[0].source,'vault:'+f.ownerVault);
  assert.equal(defaultChecked.output[0].comparison.insert,1);

  const defaultApplied=await f.cli('apply');
  assert.equal(defaultApplied.exitCode,0,JSON.stringify(defaultApplied));
  assert.equal(defaultApplied.output[0].inserted,1);
  const defaultAgain=await f.cli('apply');
  assert.equal(defaultAgain.output[0].inserted,0);
  assert.equal(defaultAgain.output[0].skipped,1);

  await entryNote(f.sourceVault,'chats/entries/derived.md',{
    title:'对话整理条目',
    managed:'这段是对话整理摘要。',
    sourceRefs:[{id:'raw-derived',revision:1,role:'user'}],
  });
  const derivedSkipped=await f.cli('check','--vault',f.sourceVault);
  assert.equal(derivedSkipped.output[0].summary.total,2);
  assert.equal(derivedSkipped.output[0].conversion.entries.imported,1);
  assert.equal(derivedSkipped.output[0].conversion.entries.skipped,1);
  assert.deepEqual(derivedSkipped.output[0].conversion.entries.skippedByReason,{
    '由对话整理而来，原话已在原话库':1,
  });

  const derivedIncluded=await f.cli('check','--vault',f.sourceVault,'--include-derived');
  assert.equal(derivedIncluded.exitCode,0,JSON.stringify(derivedIncluded));
  assert.equal(derivedIncluded.output[0].summary.total,3);
  assert.equal(derivedIncluded.output[0].conversion.entries.imported,2);

  const both=await f.cli('check','--vault',f.sourceVault,'--file',path.join(f.directory,'missing.jsonl'));
  assert.equal(both.exitCode,1);
  assert.match(both.errors[0].error,/不能同时给出/u);
  const fileDerived=await f.cli('check','--file',path.join(f.directory,'missing.jsonl'),'--include-derived');
  assert.equal(fileDerived.exitCode,1);
  assert.match(fileDerived.errors[0].error,/只适用于 --vault/u);
  assert.match(INHERIT_HELP,/不给 --vault 或 --file/u);
  assert.match(INHERIT_HELP,/--include-derived 只对 --vault 有效/u);
});

test('a first-run configuration without owner or vector model still imports, and a renamed entry is not imported twice',async t=>{
  const f=await fixture(t);
  // The first-run page writes only these fields: no ownerSubject, 「原话检索」 on, and no vector model yet (the cloud default without a model name).
  await write(f.directory,'deployment.json',JSON.stringify({ownerDirectory:f.owner,socialRoot:path.join(f.directory,'social'),dshSessionIds:[],memory:{rawRecall:true}}));
  await entryNote(f.ownerVault,'chats/entries/书架.md',{title:'书架',managed:'条目正文：翡翠书架在北墙。'});

  const applied=await f.cli('apply');
  assert.equal(applied.exitCode,0,JSON.stringify(applied));
  assert.equal(applied.output[0].inserted,2);
  assert.deepEqual(applied.output[0].indexing,{embedded:0,reason:'vector-model-not-configured'});
  assert.match(applied.output[0].indexingNotice,/向量模型还没配好/u);
  assert.equal(applied.output[0].verification.passed,true);

  // The records belong to the owner the running plugin uses when the configuration names none.
  const store=new RawMemoryStore(f.dbFile,{warn(){}});
  try {
    const reader=createRawQueryReader(store,{ownerSubject:'用户',project:'main'},{authorize:()=>true});
    assert.equal(reader.search({query:'翡翠书架',limit:10}).sources.some(item=>item.text.includes('北墙')),true);
  } finally { store.close(); }

  await fs.rename(path.join(f.ownerVault,'chats','entries','书架.md'),path.join(f.ownerVault,'chats','entries','书架（改名）.md'));
  const again=await f.cli('apply');
  assert.equal(again.exitCode,0,JSON.stringify(again));
  assert.equal(again.output[0].inserted,0);
  assert.equal(again.output[0].skipped,2);
});

test('a configuration with vector search turned off imports without encoding',async t=>{
  const f=await fixture(t);
  // First-run files from 0.7.0 and earlier wrote no memory settings, which leaves 「原话检索」 off.
  await write(f.directory,'deployment.json',JSON.stringify({ownerDirectory:f.owner,socialRoot:path.join(f.directory,'social'),dshSessionIds:[]}));
  const applied=await f.cli('apply');
  assert.equal(applied.exitCode,0,JSON.stringify(applied));
  assert.ok(applied.output[0].inserted>0);
  assert.deepEqual(applied.output[0].indexing,{embedded:0,reason:'vectors-off'});
  assert.match(applied.output[0].indexingNotice,/没有开启向量检索/u);
});

test('check preview reads pending WAL records from a live SQLite writer',async t=>{
  const f=await fixture(t);
  const converted=await convertLegacyVault(f.sourceVault);
  const writer=new RawMemoryStore(f.dbFile,{warn(){}});
  try {
    const applied=applyInheritRecords({
      store:writer,
      scope:'fictional-cli-owner',
      records:converted.records,
      batchId:'live-wal-fixture',
      source:{kind:'vault',path:f.sourceVault},
      clock:()=>1000,
    });
    assert.equal(applied.inserted,2);
    assert.ok((await fs.stat(f.dbFile+'-wal')).size>0);
    const checked=await f.cli('check','--vault',f.sourceVault);
    assert.equal(checked.exitCode,0,JSON.stringify(checked));
    assert.equal(checked.output[0].comparison.insert,0);
    assert.equal(checked.output[0].comparison.skip,2);
  } finally {
    writer.close();
  }
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

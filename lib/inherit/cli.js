import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {resolveConfig} from '../config.js';
import {RawMemoryStore} from '../raw-rag/store.js';
import {createRawRecall} from '../raw-rag/index.js';
import {createRawQueryReader} from '../raw-rag/query-reader.js';
import {
  inheritReport,
  readInheritJsonl,
  writeInheritJsonl,
} from './format.js';
import {convertLegacyVault} from './vault.js';
import {applyInheritRecords,inheritPreview} from './importer.js';
import {
  listInheritBatches,
  newInheritBatchId,
  restoreInheritBatch,
  undoInheritBatch,
} from './batches.js';

const HELP = [
  '旧记忆继承命令：',
  '  check --deployment FILE (--vault DIR | --file FILE.jsonl) [--out FILE.jsonl]',
  '  apply --deployment FILE (--vault DIR | --file FILE.jsonl)',
  '  list --deployment FILE',
  '  undo --deployment FILE --batch BATCH_ID',
  '  restore --deployment FILE --batch BATCH_ID',
  '',
  'check 只读检查；只有加 --out 时才写指定的标准格式 JSONL。',
  'apply 先检查，再备份原话库、整批导入并触发现有向量待编码处理。',
  'undo 用 raw_controls 按整批排除原话；restore 用同一机制恢复。原话和批次记录都不会删除。',
].join('\n');

function parse(argv) {
  return parseArgs({args:argv,allowPositionals:true,options:{
    deployment:{type:'string'},
    vault:{type:'string'},
    file:{type:'string'},
    out:{type:'string'},
    batch:{type:'string'},
    help:{type:'boolean',short:'h'},
  }});
}

function deploymentConfig(deployment) {
  if (!deployment || typeof deployment !== 'object') throw Error('部署配置必须是 JSON 对象');
  if (!path.isAbsolute(deployment.ownerDirectory || '') || typeof deployment.ownerSubject !== 'string'
    || !deployment.ownerSubject.trim()) throw Error('部署配置需要绝对 ownerDirectory 和非空 ownerSubject');
  const config=resolveConfig({
    ...deployment.memory,
    project:'main',
    vaultPath:path.join(deployment.ownerDirectory,'vault'),
  });
  const dbFile=config.rawRecallDbPath||path.join(deployment.ownerDirectory,'management','raw-recall','raw-recall.sqlite');
  return {config,scope:deployment.ownerSubject,dbFile:path.resolve(dbFile)};
}

async function readDeployment(file,cwd) {
  if (!file) throw Error('需要 --deployment');
  const filePath=path.resolve(cwd,file);
  return {file:filePath,value:JSON.parse(await fs.readFile(filePath,'utf8'))};
}

function readonlyDatabase(file) {
  if (!fsSync.existsSync(file)) return null;
  return new DatabaseSync(file,{readOnly:true});
}

function preview(file,scope,records) {
  const db=readonlyDatabase(file);
  if (!db) return {insert:records.length,skip:0,conflict:0,undone:0};
  try {
    const {decisions:_decisions,...comparison}=inheritPreview(db,scope,records);
    return comparison;
  } finally { db.close(); }
}

async function sourceRecords(values,cwd,now) {
  const selected=Number(Boolean(values.vault))+Number(Boolean(values.file));
  if (selected!==1) throw Error('check/apply 必须二选一：--vault 或 --file');
  if (values.vault) {
    const converted=await convertLegacyVault(path.resolve(cwd,values.vault),{now});
    return {...converted,source:'vault:'+converted.vault};
  }
  const parsed=await readInheritJsonl(path.resolve(cwd,values.file));
  return {...parsed,source:'file:'+parsed.file};
}

async function backupDatabase(dbFile) {
  if (!fsSync.existsSync(dbFile)) return null;
  const directory=path.join(path.dirname(dbFile),'backups');
  await fs.mkdir(directory,{recursive:true});
  const backup=path.join(directory,'before-inherit-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid+'.sqlite');
  const db=new DatabaseSync(dbFile,{readOnly:true});
  try { db.prepare('VACUUM INTO ?').run(backup); }
  finally { db.close(); }
  return backup;
}

function verifyWithConnection(store,scope,importedRecords) {
  const reader=createRawQueryReader(store,{ownerSubject:scope,project:'main'},{authorize:()=>true});
  const failures=[];
  let searched=0,opened=0;
  for (const imported of importedRecords) {
    const live=store.loadTurns([imported.turnId],{scope})[0];
    const sources=live?reader.fromTurns([live]):[];
    const source=sources.find(item=>item.messageId===imported.messageId);
    if (!source) { failures.push({file:imported.record.source.file,reason:'source-not-readable'}); continue; }
    const open=reader.get(source.ref);
    if (open?.text===source.text) opened += 1;
    else failures.push({file:imported.record.source.file,reason:'memory-open-failed'});
    const query=Array.from(imported.record.text).slice(0,20).join('');
    if (query.trim()) {
      const hit=reader.search({query,limit:40}).sources.some(item=>item.messageId===source.messageId);
      if (hit) searched += 1;
      else failures.push({file:imported.record.source.file,reason:'full-text-search-missed'});
    }
  }
  return {passed:failures.length===0,searched,opened,total:importedRecords.length,failures};
}

function publicRuntime(verification) {
  return {
    restartRequired:false,
    visibleToNewConnection:verification.passed,
    note:'导入写入共享 SQLite；全文检索和 memory_open 由独立新连接复核。运行中的 DSH 下一次查询直接读取，不需要为全文内容重启。向量编码若由别的后台扫描负责，会在该扫描下一次运行时看到新来源。',
  };
}

function emit(writer,value) {
  writer(JSON.stringify(value,null,2));
}

export async function runInheritCli(argv,{
  cwd=process.cwd(),
  stdout=line=>console.log(line),
  stderr=line=>console.error(line),
  now=()=>new Date(),
  createRecall=createRawRecall,
}={}) {
  let parsed;
  try { parsed=parse(argv); }
  catch (error) {
    emit(stderr,{ok:false,error:error.message,help:HELP});
    return {exitCode:1,result:{ok:false,error:error.message}};
  }
  const {positionals,values}=parsed;
  const command=positionals[0];
  if (values.help||!command) {
    stdout(HELP);
    return {exitCode:values.help?0:1,result:{ok:Boolean(values.help),help:HELP}};
  }
  if (!['check','apply','list','undo','restore'].includes(command)||positionals.length>1) {
    const error='未知或其他参数不完整';
    emit(stderr,{ok:false,error,help:HELP});
    return {exitCode:1,result:{ok:false,error}};
  }
  let deployment;
  try {
    deployment=await readDeployment(values.deployment,cwd);
  } catch (error) {
    emit(stderr,{ok:false,error:error.message});
    return {exitCode:1,result:{ok:false,error:error.message}};
  }
  let resolved;
  try { resolved=deploymentConfig(deployment.value); }
  catch (error) {
    emit(stderr,{ok:false,error:error.message});
    return {exitCode:1,result:{ok:false,error:error.message}};
  }
  if (command==='list') {
    const db=readonlyDatabase(resolved.dbFile);
    if (!db) {
      const result={ok:true,batches:[]};
      emit(stdout,result);
      return {exitCode:0,result};
    }
    try {
      const result={ok:true,batches:listInheritBatches(db)};
      emit(stdout,result);
      return {exitCode:0,result};
    } finally {db.close();}
  }
  if (command==='undo'||command==='restore') {
    if (!values.batch) {
      const error='undo/restore 需要 --batch';
      emit(stderr,{ok:false,error});
      return {exitCode:1,result:{ok:false,error}};
    }
    if (!fsSync.existsSync(resolved.dbFile)) {
      const error='原话库不存在，无法处理批次';
      emit(stderr,{ok:false,error});
      return {exitCode:1,result:{ok:false,error}};
    }
    const store=new RawMemoryStore(resolved.dbFile,{warn:message=>stderr(String(message))});
    try {
      const changed=command==='undo'?undoInheritBatch(store,values.batch):restoreInheritBatch(store,values.batch);
      const result={ok:true,batchId:values.batch,...changed,restartRequired:false};
      emit(stdout,result);
      return {exitCode:0,result};
    } catch (error) {
      emit(stderr,{ok:false,error:error.message});
      return {exitCode:1,result:{ok:false,error:error.message}};
    } finally {store.close();}
  }
  let loaded;
  try { loaded=await sourceRecords(values,cwd,now()); }
  catch (error) {
    emit(stderr,{ok:false,error:error.message});
    return {exitCode:1,result:{ok:false,error:error.message}};
  }
  const comparison=loaded.errors.length?null:preview(resolved.dbFile,resolved.scope,loaded.records);
  const report=inheritReport(loaded.records,{
    source:loaded.source,
    errors:loaded.errors,
    unknownFields:loaded.unknownFields,
    conversionSkipped:loaded.conversionSkipped,
    comparison,
    header:loaded.header,
  });
  if (command==='check') {
    if (values.out&&report.ok) {
      try { report.output=await writeInheritJsonl(path.resolve(cwd,values.out),loaded.header,loaded.records); }
      catch (error) { report.ok=false; report.errors=[...report.errors,{line:0,field:'--out',problem:error.message,fix:'选择一个可写的 .jsonl 路径'}]; }
    }
    emit(report.ok?stdout:stderr,report);
    return {exitCode:report.ok?0:1,result:report};
  }
  if (!report.ok) {
    emit(stderr,report);
    return {exitCode:1,result:report};
  }
  if (!resolved.config.rawRecall) {
    const error='apply 需要部署配置中的 rawRecall=true，以便导入后触发向量编码';
    emit(stderr,{ok:false,error,report});
    return {exitCode:1,result:{ok:false,error,report}};
  }
  let backup;
  try { backup=await backupDatabase(resolved.dbFile); }
  catch (error) {
    emit(stderr,{ok:false,error:'原话库备份失败：'+error.message});
    return {exitCode:1,result:{ok:false,error:error.message}};
  }
  let store,recall,observer;
  try {
    store=new RawMemoryStore(resolved.dbFile,{warn:message=>stderr(String(message))});
    recall=createRecall({config:resolved.config,ownerSubject:resolved.scope,store,logger:{warn:message=>stderr(String(message))}});
    const batchId=newInheritBatchId(now);
    const applied=applyInheritRecords({
      store,
      scope:resolved.scope,
      records:loaded.records,
      batchId,
      source:{kind:values.vault?'vault':'file',path:loaded.source.replace(/^(vault|file):/,'')},
      clock:()=>now().getTime(),
    });
    const indexing=applied.inserted
      ?await recall.indexPending({})
      :{embedded:0,reason:'no-new-records'};
    observer=new RawMemoryStore(resolved.dbFile,{warn:message=>stderr(String(message))});
    const verification=verifyWithConnection(observer,resolved.scope,applied.importedRecords);
    const result={ok:verification.passed,backup,batchId,inserted:applied.inserted,skipped:applied.skipped,
      conflicts:applied.conflicts,undone:applied.undone,total:applied.total,indexing,verification,runtime:publicRuntime(verification)};
    emit(result.ok?stdout:stderr,result);
    return {exitCode:result.ok?0:1,result};
  } catch (error) {
    emit(stderr,{ok:false,backup,error:error.message});
    return {exitCode:1,result:{ok:false,backup,error:error.message}};
  } finally {
    observer?.close();
    if (recall?.dispose)await recall.dispose();
    store?.close();
  }
}

export {HELP as INHERIT_HELP};

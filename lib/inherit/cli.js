import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {DEFAULT_OWNER_SUBJECT,resolveConfig} from '../config.js';
import {RawMemoryStore} from '../raw-rag/store.js';
import {createRawRecall} from '../raw-rag/index.js';
import {createRawQueryReader} from '../raw-rag/query-reader.js';
import {cloudModelUnset} from '../raw-rag/models.js';
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
  '  check --deployment FILE [--vault DIR | --file FILE.jsonl] [--include-derived] [--out FILE.jsonl]',
  '  apply --deployment FILE [--vault DIR | --file FILE.jsonl] [--include-derived]',
  '  list --deployment FILE',
  '  undo --deployment FILE --batch BATCH_ID',
  '  restore --deployment FILE --batch BATCH_ID',
  '',
  '不给 --vault 或 --file 时，check/apply 使用部署配置里的当前记忆库 Vault；两者不能同时给出。',
  '--include-derived 只对 --vault 有效，用于连同对话整理出来的条目标注一起导入。',
  'check 只读检查；只有加 --out 时才写指定的标准格式 JSONL。',
  'apply 先检查，再备份原话库、整批导入并触发现有向量待编码处理；没开向量检索时跳过编码，全文检索照常可用。',
  '部署配置是首次配置页生成的 <DSH 主目录>/profiles/<档案名>/basic-memory-bridge/configuration.json。',
  'undo 用 raw_controls 按整批排除原话；restore 用同一机制恢复。原话和批次记录都不会删除。',
].join('\n');
const INDEX_NOTICE = '运行中的 DSH 要到「状态」页点「准备索引」（或重启），新导入的内容才会进向量索引；全文检索不需要。';
const VECTORS_OFF_NOTICE = '没有开启向量检索，导入的内容现在就能被全文检索找到；以后开启向量检索并点「准备索引」时会一并编码。';
const MODEL_UNSET_NOTICE = '向量模型还没配好，导入的内容现在就能被全文检索找到；在「检索模型」页配好模型后，建索引时会一并编码。';

function parse(argv) {
  return parseArgs({args:argv,allowPositionals:true,options:{
    deployment:{type:'string'},
    vault:{type:'string'},
    file:{type:'string'},
    'include-derived':{type:'boolean'},
    out:{type:'string'},
    batch:{type:'string'},
    help:{type:'boolean',short:'h'},
  }});
}

function deploymentConfig(deployment) {
  if (!deployment || typeof deployment !== 'object') throw Error('部署配置必须是 JSON 对象');
  if (!path.isAbsolute(deployment.ownerDirectory || '')) throw Error('部署配置需要绝对 ownerDirectory');
  // The first-run page writes no ownerSubject; the running plugin then uses the same default.
  const ownerSubject=deployment.ownerSubject??DEFAULT_OWNER_SUBJECT;
  if (typeof ownerSubject !== 'string' || !ownerSubject.trim()) throw Error('部署配置里的 ownerSubject 必须是非空字符串');
  const config=resolveConfig({
    ...deployment.memory,
    project:'main',
    vaultPath:path.join(deployment.ownerDirectory,'vault'),
  });
  const dbFile=config.rawRecallDbPath||path.join(deployment.ownerDirectory,'management','raw-recall','raw-recall.sqlite');
  return {config,scope:ownerSubject,dbFile:path.resolve(dbFile)};
}

async function readDeployment(file,cwd) {
  if (!file) throw Error('需要 --deployment');
  const filePath=path.resolve(cwd,file);
  return {file:filePath,value:JSON.parse(await fs.readFile(filePath,'utf8'))};
}

function readonlyDatabase(file) {
  if (!fsSync.existsSync(file)) return null;
  const hasPendingJournal=['-wal','-journal'].some(suffix=>{
    try { return fsSync.statSync(file+suffix).size>0; }
    catch (error) { if (error.code==='ENOENT') return false; throw error; }
  });
  if (!hasPendingJournal) {
    const location=pathToFileURL(file);
    location.searchParams.set('immutable','1');
    return new DatabaseSync(location.href,{readOnly:true});
  }
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

async function sourceRecords(values,cwd,now,defaultVault) {
  const selected=Number(Boolean(values.vault))+Number(Boolean(values.file));
  if (selected>1) throw Error('check/apply 不能同时给出 --vault 和 --file');
  const sourceKind=values.vault?'vault':values.file?'file':'vault';
  if (values['include-derived']&&sourceKind!=='vault') {
    throw Error('--include-derived 只适用于 --vault');
  }
  if (selected===0) {
    if (!defaultVault) throw Error('部署配置缺少当前记忆库 Vault');
    const converted=await convertLegacyVault(path.resolve(cwd,defaultVault),{
      includeDerived:Boolean(values['include-derived']),
      now,
    });
    return {...converted,source:'vault:'+converted.vault,sourceKind};
  }
  if (values.vault) {
    const converted=await convertLegacyVault(path.resolve(cwd,values.vault),{
      includeDerived:Boolean(values['include-derived']),
      now,
    });
    return {...converted,source:'vault:'+converted.vault,sourceKind};
  }
  const parsed=await readInheritJsonl(path.resolve(cwd,values.file));
  return {...parsed,source:'file:'+parsed.file,sourceKind};
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
  if (values['include-derived']&&!['check','apply'].includes(command)) {
    const error='--include-derived 只适用于 check/apply --vault';
    emit(stderr,{ok:false,error});
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
  try { loaded=await sourceRecords(values,cwd,now(),resolved.config.vaultPath); }
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
    conversion:loaded.conversion,
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
  // Full-text search and memory_open read the raw library directly, so a library without
  // vectors still imports; only the vector encoding step waits until vectors are turned on.
  // A cloud service without a model name cannot encode yet (a fresh install starts this way), so it imports like vectors-off.
  const modelUnset=resolved.config.rawRecall===true&&cloudModelUnset(resolved.config);
  const vectorsOn=resolved.config.rawRecall===true&&!modelUnset;
  let backup;
  try { backup=await backupDatabase(resolved.dbFile); }
  catch (error) {
    emit(stderr,{ok:false,error:'原话库备份失败：'+error.message});
    return {exitCode:1,result:{ok:false,error:error.message}};
  }
  let store,recall,observer;
  try {
    store=new RawMemoryStore(resolved.dbFile,{warn:message=>stderr(String(message))});
    if (vectorsOn) recall=createRecall({config:resolved.config,ownerSubject:resolved.scope,store,logger:{warn:message=>stderr(String(message))}});
    const batchId=newInheritBatchId(now);
    const applied=applyInheritRecords({
      store,
      scope:resolved.scope,
      records:loaded.records,
      batchId,
      source:{kind:loaded.sourceKind,path:loaded.source.replace(/^(vault|file):/,'')},
      clock:()=>now().getTime(),
    });
    const indexing=!applied.inserted?{embedded:0,reason:'no-new-records'}
      :vectorsOn?await recall.indexPending({}):{embedded:0,reason:modelUnset?'vector-model-not-configured':'vectors-off'};
    observer=new RawMemoryStore(resolved.dbFile,{warn:message=>stderr(String(message))});
    const verification=verifyWithConnection(observer,resolved.scope,applied.importedRecords);
    const result={ok:verification.passed,backup,batchId,inserted:applied.inserted,skipped:applied.skipped,
      conflicts:applied.conflicts,undone:applied.undone,total:applied.total,indexing,
      indexingNotice:vectorsOn?INDEX_NOTICE:modelUnset?MODEL_UNSET_NOTICE:VECTORS_OFF_NOTICE,verification,runtime:publicRuntime(verification)};
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createMemoryEntryAccess} from '../lib/memory-entry-access.js';
import {createMemoryEntryService} from '../lib/memory-entry-service.js';
import {normalizeSemanticEntry,readMemoryEntry} from '../lib/memory-entry.js';
import {createLegacyImport,legacyImportFingerprints,legacyImportStateFile} from '../lib/legacy-import.js';
import {memoryDirectory} from '../lib/memory.js';
import {resolveConfig} from '../lib/config.js';
import {createMemoryQueryAnswer} from '../lib/memory-query.js';
import {createSettingsHandler} from '../lib/settings-host.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent,toolVaultBackend} from './helpers.js';

const owner='测试用户';
const original={id:'fixture-message',revision:1,role:'user',isCurrent:true,ownerSubject:owner,project:'main'};
const entry={type:'fact',content:'虚构导入内容',subject_ref:null,source_refs:[],state:{validity:'unverified',progress:'unknown'},
  tags:['fixture'],importance:{level:'unknown',basis:'unassessed',reason:''},evidence_basis:'manual'};
const imported={kind:'legacy-note',memoryId:'fixture-note',path:'chats/facts/fixture.md',checksum:'abc123'};

function legacyNote({id,kind='fact',category='fact',value='虚构事实',subject='用户',attribute='事项',
  occurred='2026-10-01',recorded='2026-10-02T00:00:00.000Z',validFrom='',validUntil='',timeExpression='',
  tags=['dsh-memory'],status='active',tail='',historyEvidence='',broken=false}={}){
  const lines=['---',`title: ${id}`,`permalink: personal/chats/facts/${id}`,`memory_id: ${id}`,`memory_kind: ${kind}`,
    `status: ${status}`,`subject: ${subject}`,`attribute: ${attribute}`,`value: ${value}`,`recorded_at: '${recorded}'`,'tags:'];
  for(const tag of tags)lines.push('- '+tag);
  lines.push('---','');
  if(!broken)lines.push('<!-- dsh-fact-memory -->','# '+id,'');
  lines.push(`- [${kind==='history'?'history':kind==='event'?'event':category}] ${value}`);
  if(subject)lines.push('- subject: '+subject);
  if(attribute)lines.push('- attribute: '+attribute);
  lines.push('- 发生日期: '+(occurred||'日期未明'),'- 记录日期: '+recorded);
  if(validFrom)lines.push('- valid_from: '+validFrom);
  if(validUntil)lines.push('- valid_until: '+validUntil);
  if(timeExpression)lines.push('- time_expression: '+timeExpression);
  if(historyEvidence)lines.push('- 历史证据: [['+historyEvidence+']]');
  if(tail)lines.push('',tail);
  return lines.join('\n')+'\n';
}

function defaultClassification(input){
  return input.notes.map(note=>({id:note.id,type:note.oldType==='event'?'event':note.oldCategory==='preference'?'preference':
    note.oldCategory==='relationship'?'relationship':'fact',validity:note.historical?'historical':'current',progress:'unknown',
    importance:'normal',confident:true,reason:'虚构分类'}));
}

function classifier(work=defaultClassification){
  const calls=[];
  return {calls,stream(options){
    return (async function*(){
      calls.push(options);const input=JSON.parse(options.messages[0].content[0].text),result=await work(input,calls.length);
      if(result instanceof Error)throw result;
      const output=typeof result==='string'?result:JSON.stringify(result);
      for(const part of output.match(/[\s\S]{1,19}/g)??[])yield {type:'text-delta',index:0,text:part};
      yield {type:'finish',reason:{kind:'stop'},usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
    })();
  }};
}

async function writeLegacy(vault,config,note,fileId=note.id){
  const kindFolder=note.kind==='event'?'event':note.kind==='history'?'history':'fact';
  const directory=memoryDirectory(config,kindFolder),relative=`${directory}/${fileId}.md`;
  await fs.mkdir(path.join(vault,directory),{recursive:true});
  await fs.writeFile(path.join(vault,relative),legacyNote({...note,id:note.id}),'utf8');
  return relative;
}

async function fixture(t,{notes=[],llm=classifier(),canRun=()=>true,onNotify}={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-import-')),vault=path.join(directory,'vault');
  await fs.mkdir(vault,{recursive:true});
  const config=resolveConfig({project:'main',vaultPath:vault,rawRecall:false,captureTargetMode:'fixed',captureProvider:'fake-provider',captureModel:'fake-model'});
  for(const note of notes)await writeLegacy(vault,config,note);
  const raw=new RawMemoryStore(path.join(directory,'memory.sqlite'),{warn(){}}),memory=memoryStore({project:'main'});
  const scope={ownerSubject:owner,project:'main'},backend=toolVaultBackend(memory.tools),context={agent:fakeAgent('session-legacy-import'),check(){}};
  const originals=new Map([[original.id,{...original}]]);
  const service=createMemoryEntryService({scope,config,repository:()=>raw.entries,backend,sourceState:ref=>originals.get(ref.id),logger:{warn(){}}});
  const entries={importLegacy:input=>service.importLegacy(input,context),read:id=>service.read(id,context),list:filters=>service.list(filters,context),
    search:(query,filters)=>service.search(query,filters,context)};
  const notifications=[],allow={value:true};
  const importer=createLegacyImport({config,llm,getEntries:()=>entries,agent:()=>fakeAgent('session-legacy-import'),
    target:()=>({provider:'fake-provider',model:'fake-model'}),canRun:()=>allow.value&&canRun(),notifyChanged:value=>{notifications.push(value);onNotify?.(value);},
    logger:{warn(){},info(){}},sleep:()=>new Promise(resolve=>setImmediate(resolve))});
  t.after(async()=>{allow.value=false;await importer.close();raw.close();await fs.rm(directory,{recursive:true,force:true,maxRetries:3,retryDelay:20});});
  return {directory,vault,config,raw,memory,service,entries,importer,llm,notifications,allow,createAnswer:options=>createMemoryQueryAnswer({agent:fakeAgent('session-legacy-import'),
    access:options.access,raw:options.raw,entries:options.entries,tools:memory.tools,config,...options})};
}

async function settled(importer){
  for(let index=0;index<200;index++){
    await importer.idle();
    const status=await importer.handle({action:'status'});
    if(status.task?.state!=='running')return status;
    await new Promise(resolve=>setImmediate(resolve));
  }
  throw Error('旧记忆迁移未结束');
}

async function request(handler,{method='GET',url,body,headers={}}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},aborted:false,
    headers:{host:'127.0.0.1:15680',...(body===undefined?{}:{'content-type':'application/json'}),...headers}});
  const res={statusCode:200,destroyed:false,headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=JSON.parse(value);}};
  await handler(req,res);return res;
}

test('the controlled import proof never relaxes the ordinary commit source contract',()=>{
  assert.throws(()=>normalizeSemanticEntry({...entry,source_refs:[]},{sources:new Map(),subjects:new Map()}),/需要原文依据编号/u);
  assert.throws(()=>normalizeSemanticEntry({...entry,source_refs:['s1']},{sources:new Map(),subjects:new Map(),imported}),/原文依据必须为空/u);
  assert.throws(()=>normalizeSemanticEntry({...entry,evidence_basis:'reported'},{sources:new Map(),subjects:new Map(),imported}),/manual/u);
  assert.throws(()=>normalizeSemanticEntry(entry,{sources:new Map(),subjects:new Map(),imported:{kind:'legacy-note',memoryId:'x'}}),/路径|校验和/u);
  const normalized=normalizeSemanticEntry(entry,{sources:new Map(),subjects:new Map(),imported});
  assert.deepEqual(normalized.source_refs,[]);assert.equal(normalized.evidence_basis,'manual');assert.deepEqual(normalized.imported_from,imported);
});

test('legacy import copies structure, keeps handwritten text, ignores unknown dates and leaves old bytes unchanged',async t=>{
  const note={id:'fact-1',category:'preference',value:'喜欢靛蓝色',subject:'用户',attribute:'颜色',occurred:'日期未明',validFrom:'2026-09-01',
    timeExpression:'去年开始',tags:['dsh-memory','颜色'],tail:'人工附注：保留这一段。',historyEvidence:'旧事件'};
  const f=await fixture(t,{notes:[note,{id:'event-1',kind:'event',category:'event',value:'去公园散步'},
    {id:'broken-1',value:'损坏格式',broken:true}]});
  const paths=[memoryDirectory(f.config,'fact')+'/fact-1.md',memoryDirectory(f.config,'fact')+'/broken-1.md',memoryDirectory(f.config,'event')+'/event-1.md'];
  const hashes=async()=>Promise.all(paths.map(async relative=>createHash('sha256').update(await fs.readFile(path.join(f.vault,relative))).digest('hex')));
  const before=await hashes();
  const started=await f.importer.handle({action:'start'});assert.equal(started.started,true);const final=await settled(f.importer);
  assert.equal(final.task.failed,1);
  const page=await f.importer.handle({action:'migrated'}),preference=page.items.find(item=>item.imported_from.memoryId==='fact-1');
  assert.ok(preference);const saved=await f.service.read(preference.id,{check(){}});
  assert.equal(saved.type,'preference');assert.equal(saved.content,'用户 颜色：喜欢靛蓝色\n\n人工附注：保留这一段。');
  assert.equal(saved.occurred_at,undefined);assert.equal(saved.valid_from,'2026-09-01');assert.equal(saved.time_expression,'去年开始');
  assert.deepEqual(saved.tags,['dsh-memory','颜色','legacy-import']);assert.deepEqual(saved.imported_from,{kind:'legacy-note',
    memoryId:'fact-1',path:preference.imported_from.path,checksum:preference.imported_from.checksum,historyEvidence:'旧事件'});
  assert.deepEqual(await hashes(),before);
});

test('one start runs seventy notes through three batches and writes batch one before batch two begins',async t=>{
  const notes=Array.from({length:70},(_,index)=>({id:'bulk-'+index,value:'虚构批量记忆 '+index,attribute:'批次'}));
  let beforeSecond=null;
  const llm=classifier(async(input,call)=>{
    if(call===2)beforeSecond=(await f.service.list({tag:'legacy-import',limit:100},{check(){}})).entries.length;
    return defaultClassification(input);
  });
  const f=await fixture(t,{notes,llm});
  await f.importer.handle({action:'start'});const status=await settled(f.importer);
  assert.equal(llm.calls.length,3);assert.equal(status.task.state,'completed');assert.equal(status.task.written,70);
  assert.equal(beforeSecond,30);assert.equal((await f.importer.handle({action:'migrated'})).items.length,50);
});

test('an imported entry is searchable through the structured answer lane without source references',async t=>{
  const f=await fixture(t,{notes:[{id:'search-import',category:'preference',value:'喜欢蓝色瓷杯',validFrom:'2026-09-01'}]});
  await f.importer.handle({action:'start'});await settled(f.importer);
  const agent=fakeAgent('session-search-import'),controller=new AbortController();
  const access={ownerSubject:owner,grant(){return {ownerSubject:owner,project:'main',sessionId:agent.session.id,rootSessionId:agent.session.id,
      epoch:'search-fixture',signal:controller.signal,cancel:()=>controller.abort()};},validate:()=>true,validateMessage:()=>true,
    assertCurrent(){},withGrant:(_grant,work)=>work()};
  const recall=createRawRecall({config:f.config,ownerSubject:owner,store:f.raw}),entries=createMemoryEntryAccess({access,raw:recall,tools:f.memory.tools,config:f.config});
  const answer=createMemoryQueryAnswer({access,agent,raw:recall,entries,tools:f.memory.tools,config:f.config});
  try{
    const found=await answer.search({query:'蓝色瓷杯'});
    const record=found.records[0];
    assert.equal(found.channels.structured.records,1,JSON.stringify(found));assert.match(record.label,/记忆条目/u);assert.match(record.label,/2026/u);
    const row=(await f.service.list({tag:'legacy-import'},context())).entries[0],stored=await f.service.read(row.id,context());
    assert.equal(stored.sourceStatus.eligible,true);assert.deepEqual(stored.source_refs,[]);
  }finally{answer.dispose();await recall.dispose();}
});

test('valid model classification is adopted and invalid output falls back conservatively',async t=>{
  const llm=classifier(input=>input.notes.map(note=>({id:note.id,type:note.content.includes('搬家')?'recent_state':'not-a-type',
    validity:note.content.includes('搬家')?'current':'unverified',progress:'unknown',importance:'normal',confident:true,reason:'虚构判断'})));
  const f=await fixture(t,{notes:[{id:'recent-1',value:'这阵子在准备搬家'},{id:'bad-output',value:'普通事实'}],llm});
  await f.importer.handle({action:'start'});const status=await settled(f.importer);
  const page=await f.importer.handle({action:'migrated'}),recent=page.items.find(item=>item.imported_from.memoryId==='recent-1'),
    fallback=page.items.find(item=>item.imported_from.memoryId==='bad-output');
  assert.equal(recent.type,'recent_state');assert.equal(fallback.type,'fact');assert.equal(status.task.modelUnjudged,1);
});

test('uncertain and contradictory classifications wait for explicit decisions',async t=>{
  const llm=classifier(input=>input.notes.map(note=>({id:note.id,type:'fact',validity:note.historical?'current':'historical',
    progress:'unknown',importance:'unknown',confident:!note.content.includes('可能喜欢'),reason:'待确认'})));
  const f=await fixture(t,{notes:[{id:'uncertain',value:'可能喜欢的颜色'},{id:'history-change',kind:'history',value:'旧工作地点'}],llm});
  await f.importer.handle({action:'start'});let status=await settled(f.importer);
  assert.equal(status.task.written,0);assert.equal(status.pending,2);
  const pending=(await f.importer.handle({action:'pending'})).items;
  await f.importer.handle({action:'decide',id:pending[0].id,decision:'write',changes:{type:'preference',validity:'unverified',progress:'unknown',importance:'normal'}});
  await f.importer.handle({action:'decide',id:pending[1].id,decision:'skip'});
  status=await f.importer.handle({action:'status'});assert.equal(status.pending,0);assert.equal(status.migrated,1);
  const migrated=(await f.importer.handle({action:'migrated'})).items;assert.equal(migrated[0].type,'preference');
});

test('a failed batch retries twice, adopts the third result, and a fully failed batch uses conservative values',async t=>{
  let secondBatchAttempts=0;
  const llm=classifier((input,call)=>{
    if(input.notes.some(note=>note.content.includes('虚构重试 0'))&&call<3)return Error('temporary classifier failure');
    if(input.notes.some(note=>note.content.includes('虚构重试 50')))return Error('permanent classifier failure');
    return defaultClassification(input);
  });
  const notes=Array.from({length:64},(_,index)=>({id:(index<30?'batch-a-':'batch-b-')+index,value:'虚构重试 '+index}));
  const f=await fixture(t,{notes,llm});await f.importer.handle({action:'start'});const status=await settled(f.importer);
  assert.equal(status.task.state,'completed');assert.equal(status.task.written,64);assert.ok(llm.calls.length>=6);
  const migrated=(await f.importer.handle({action:'migrated'})).items;assert.ok(migrated.some(item=>item.imported_from.memoryId.startsWith('batch-a-')));
  assert.ok(migrated.some(item=>item.imported_from.memoryId.startsWith('batch-b-')));
});

test('start refuses without an organizer model and writes nothing',async t=>{
  const f=await fixture(t,{notes:[{id:'no-model',value:'不能开始'}]});f.importer.target=()=>null;
  await assert.rejects(f.importer.handle({action:'start'}),/选择整理模型/u);
  assert.equal((await f.service.list({tag:'legacy-import',limit:50},{check(){}})).entries.length,0);
});

test('a running task resumes after restart from the next batch and paused tasks stay paused',async t=>{
  const notes=Array.from({length:70},(_,index)=>({id:'resume-'+index,value:'重启续做 '+index}));
  let allow=true;const llm=classifier();let f;
  f=await fixture(t,{notes,llm,canRun:()=>allow,onNotify(){allow=false;}});
  await f.importer.handle({action:'start'});
  for(let index=0;index<100;index++){
    await new Promise(resolve=>setImmediate(resolve));
    const state=await f.importer.handle({action:'status'});if(state.task.processed>=30)break;
  }
  await f.importer.handle({action:'pause'});await f.importer.close();
  const secondLlm=classifier();
  const second=createLegacyImport({config:f.config,llm:secondLlm,getEntries:()=>f.entries,agent:()=>fakeAgent('session-legacy-import'),
    target:()=>({provider:'fake-provider',model:'fake-model'}),canRun:()=>true,notifyChanged(){},logger:{warn(){},info(){}},sleep:()=>new Promise(resolve=>setImmediate(resolve))});
  const paused=await second.resumeOnStart();assert.equal(paused.state,'paused');await second.idle();assert.equal(secondLlm.calls.length,0);
  await second.handle({action:'resume'});const final=await settled(second);
  assert.equal(final.task.state,'completed');assert.equal(final.task.written,70);assert.equal(secondLlm.calls.length,2);await second.close();
});

test('second start is idempotent, while a changed old note creates a new versioned import update',async t=>{
  const f=await fixture(t,{notes:[{id:'change-me',value:'原始内容'}]});await f.importer.handle({action:'start'});await settled(f.importer);
  const firstCalls=f.llm.calls.length,firstCount=f.memory.notes.size;
  await f.importer.handle({action:'start'});await settled(f.importer);assert.equal(f.llm.calls.length,firstCalls);assert.equal(f.memory.notes.size,firstCount);
  const relative=memoryDirectory(f.config,'fact')+'/change-me.md';
  await fs.writeFile(path.join(f.vault,relative),legacyNote({id:'change-me',value:'用户后来修改了旧笔记'}),'utf8');
  const status=await f.importer.handle({action:'status'});assert.equal(status.changed,1);assert.equal(status.available,1);
  await f.importer.handle({action:'start'});const final=await settled(f.importer);assert.equal(final.task.written,1);
  const page=await f.importer.handle({action:'migrated'}),row=page.items.find(item=>item.imported_from.memoryId==='change-me');
  assert.ok(row.content.includes('用户后来修改了旧笔记'));assert.equal(f.memory.notes.size,firstCount+1);
});

test('edit keeps history and refuses a normal source-backed entry',async t=>{
  const f=await fixture(t,{notes:[{id:'edit-me',value:'可以修改的导入条目'}]});await f.importer.handle({action:'start'});await settled(f.importer);
  let row=(await f.importer.handle({action:'migrated'})).items[0];
  await f.importer.handle({action:'edit',id:row.id,revision:row.revision,type:'recent_state',validity:'current',progress:'in_progress',importance:'high'});
  row=(await f.importer.handle({action:'migrated'})).items[0];assert.equal(row.type,'recent_state');
  const history=await f.service.list({validity:'historical'},context(),);assert.ok(history.entries.length>=1);
  const normal=await f.service.commit({operationId:'normal-entry',proposed:{...entry,source_refs:['s1']},
    sources:new Map([['s1',original]]),subjects:new Map()},context());
  await assert.rejects(f.entries.importLegacy({operationId:'legacy-import:normal',proposed:entry,subjects:new Map(),imported:{...imported,memoryId:'normal'},
    target:{id:normal.id,revision:normal.revision}}),{code:'MEMORY_IMPORT_TARGET_INVALID'});
});

test('organizer updates keep the legacy import proof and may replace it with real sources',async t=>{
  const f=await fixture(t,{notes:[{id:'preserve-proof',value:'导入后还会整理'}]});await f.importer.handle({action:'start'});await settled(f.importer);
  const row=(await f.importer.handle({action:'migrated'})).items[0];
  const updated=await f.service.commit({operationId:'organizer-update',target:{id:row.id,revision:row.revision},
    proposed:{...entry,content:'原话整理后的新正文',source_refs:['s1'],state:{validity:'current',progress:null}},
    sources:new Map([['s1',original]]),subjects:new Map(),allowReplacement:true},context());
  assert.equal(updated.state,'committed');const read=await f.service.read(row.id,context());
  assert.equal(read.imported_from.memoryId,'preserve-proof');assert.deepEqual(read.source_refs,[{id:original.id,revision:1,role:'user'}]);
});

test('legacy search hides an unchanged migrated note but returns it after the old file changes',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-query-')),vault=path.join(directory,'vault');
  await fs.mkdir(vault,{recursive:true});
  const config=resolveConfig({project:'main',vaultPath:vault,rawRecall:false}),raw=new RawMemoryStore(path.join(directory,'raw.sqlite'),{warn(){}}),
    memory=memoryStore({project:'main'}),agent=fakeAgent('session-query');
  let enabled=true;const access={ownerSubject:owner,grant(){const controller=new AbortController();return {ownerSubject:owner,project:'main',sessionId:agent.session.id,
      rootSessionId:agent.session.id,epoch:'fixture',signal:controller.signal,cancel:()=>controller.abort()};},validate:()=>enabled,validateMessage:()=>enabled,assertCurrent(){if(!enabled)throw Error('closed');},withGrant:(_grant,work)=>work()};
  const source={ownerSubject:owner,project:'main',sessionId:agent.session.id,messageId:'source-key',role:'user',sequence:1,turn:1,rootTurn:1,
    text:'蓝色花盆里放着钥匙。',content:[{type:'text',text:'蓝色花盆里放着钥匙。'}],time:1000,authorization:{rootSessionId:agent.session.id}};
  raw.messages.record(source,{authorize:()=>true});
  const recall=createRawRecall({config,ownerSubject:owner,store:raw}),entries=createMemoryEntryAccess({access,raw:recall,tools:memory.tools,config});
  const answer=createMemoryQueryAnswer({access,agent,raw:recall,entries,tools:memory.tools,config});
  t.after(async()=>{answer.dispose();await recall.dispose();raw.close();await fs.rm(directory,{recursive:true,force:true});});
  const relative=await writeLegacy(vault,config,{id:'query-note',value:'蓝色花盆里放着钥匙'});
  const first=await answer.search({query:'蓝色花盆'});assert.ok(first.channels,JSON.stringify(first));assert.equal(first.channels.legacy.records,1);
  const state={version:1,records:{'query-note':{status:'committed',checksum:createHash('sha256').update(await fs.readFile(path.join(vault,relative))).digest('hex'),
    path:relative,entryId:'fixture-entry',revision:'one'}},pending:{},task:null};
  await fs.mkdir(path.dirname(legacyImportStateFile(config)),{recursive:true});await fs.writeFile(legacyImportStateFile(config),JSON.stringify(state));
  const hidden=await answer.search({query:'蓝色花盆'});assert.equal(hidden.channels.legacy.records,0);
  await fs.writeFile(path.join(vault,relative),legacyNote({id:'query-note',value:'蓝色花盆里后来放的是备用钥匙'}),'utf8');
  const changed=await answer.search({query:'蓝色花盆'});assert.equal(changed.channels.legacy.records,1);
});

test('legacy import fingerprints reuse unchanged state and invalidate after migration writes',async t=>{
  const f=await fixture(t,{notes:[{id:'fingerprint-cache',value:'第一版指纹内容'}]});
  await f.importer.handle({action:'start'});await settled(f.importer);
  const relative=memoryDirectory(f.config,'fact')+'/fingerprint-cache.md',file=path.join(f.vault,relative);
  const stateFile=legacyImportStateFile(f.config);
  const firstChecksum=createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const first=await legacyImportFingerprints(f.config);
  assert.equal(first.get('fingerprint-cache'),firstChecksum);

  const originalRead=fs.readFile;
  fs.readFile=async function(...args){
    if(path.resolve(String(args[0]))===path.resolve(stateFile))throw Error('fingerprint cache unexpectedly reread state');
    return originalRead.apply(this,args);
  };
  try{assert.equal((await legacyImportFingerprints(f.config)).get('fingerprint-cache'),firstChecksum);}
  finally{fs.readFile=originalRead;}

  await fs.writeFile(file,legacyNote({id:'fingerprint-cache',value:'第二版指纹内容'}),'utf8');
  await f.importer.handle({action:'start'});await settled(f.importer);
  const secondChecksum=createHash('sha256').update(await fs.readFile(file)).digest('hex');
  const second=await legacyImportFingerprints(f.config);
  assert.notEqual(secondChecksum,firstChecksum);assert.equal(second.get('fingerprint-cache'),secondChecksum);
});

test('legacy import settings routes validate write access and forward all actions',async()=>{
  const calls=[],handler=createSettingsHandler({},'unused.json',undefined,undefined,{manageLegacyImport:async(input,check)=>{
    check();calls.push(input);return input.action==='start'?{started:true,task:{state:'running'}}:{status:'ok'};}});
  const denied=await request(handler,{method:'POST',url:'/api/basic-memory-settings/legacy-import',body:{action:'start'}});
  assert.equal(denied.statusCode,403);
  const started=await request(handler,{method:'POST',url:'/api/basic-memory-settings/legacy-import',body:{action:'start'},
    headers:{'x-basic-memory-settings':'1'}});assert.equal(started.statusCode,200);assert.equal(started.body.started,true);
  const pending=await request(handler,{url:'/api/basic-memory-settings/legacy-import?action=pending'});assert.equal(pending.statusCode,200);
  const decided=await request(handler,{method:'POST',url:'/api/basic-memory-settings/legacy-import',headers:{'x-basic-memory-settings':'1'},
    body:{action:'decide',id:'fixture-note',decision:'write',changes:{type:'preference'}}});assert.equal(decided.statusCode,200);
  assert.deepEqual(calls.map(call=>call.action),['start','pending','decide']);
});

function context(){return {agent:fakeAgent('session-legacy-import'),check(){}};}

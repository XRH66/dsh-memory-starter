import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createMemoryVectors} from '../lib/memory-vectors.js';
import {memoryEntryMetadata} from '../lib/memory-entry.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RawMemoryStore,buildTurn} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {toolVaultBackend} from './helpers.js';

// Synthetic adapters only: no installed DSH, user Vault, downloads or models.
async function maintenanceFixture(t){
  const owner=await fs.mkdtemp(path.join(os.tmpdir(),'vector-maintenance-'));
  const dbFile=path.join(owner,'management','raw-recall','raw-recall.sqlite');
  const store=new RawMemoryStore(dbFile),scope='fictional-owner';
  const config={rawRecall:true,rawRecallDbPath:dbFile,vaultPath:path.join(owner,'vault'),project:'main'};
  await fs.mkdir(config.vaultPath);
  const raw=createRawRecall({config,ownerSubject:scope,store});raw.useExternalVectors();
  const turn=buildTurn({scope,sessionId:'maintenance-session',turn:1,completedAt:1000,messages:[
    {id:'maintenance-user',role:'user',seq:1,text:'Fictional preference: tea. Separate work detail.'},
    {id:'maintenance-assistant',role:'assistant',seq:2,text:'Fictional reply: noted.'},
  ]});store.archiveTurn(turn);
  const original=()=>store.db.prepare('SELECT doc_text,messages_json,doc_hash,source_revision FROM turns ORDER BY turn_id').all();
  const before=original();
  const f=await fixture(t,{raw,directory:path.join(owner,'management','vectors'),queueConfig:{debounceMs:0,timers:{setTimeout(){return {unref(){}};},clearTimeout(){}}}});
  t.after(async()=>{assert.deepEqual(original(),before);await raw.dispose();assert.equal(path.dirname(owner),path.resolve(os.tmpdir()));await fs.rm(owner,{recursive:true,force:true});});
  const deployment=path.join(owner,'deployment.json');
  await fs.writeFile(deployment,JSON.stringify({ownerDirectory:owner,ownerSubject:scope,memory:config}));
  const cli=async(command,...args)=>JSON.parse((await promisify(execFile)(process.execPath,['scripts/raw-memory.mjs',command,'--deployment',deployment,...args],{cwd:path.resolve(import.meta.dirname,'..'),windowsHide:true})).stdout);
  const grant=f.manager();t.after(()=>grant.cancel());
  const query=()=>f.api.query({grant,query:'fictional preference',deadline:Date.now()+2000});
  return {...f, get api(){return f.api;},store,raw,turn,scope,grant,cli,query};
}

test('maintenance CLI exclusion and inclusion reconcile the active index and read-only status',async t=>{
  const f=await maintenanceFixture(t);await f.prepare();
  assert.equal((await f.query()).records.length,2);
  const excluded=await f.cli('control','--session','maintenance-session','--exclude');
  assert.equal(excluded.indexReconciliation.state,'pending');
  assert.equal((await f.query()).records.length,0,'current authority filters before index reconciliation');
  assert.equal((await f.cli('status')).indexReconciliation.state,'pending');
  assert.equal((await f.api.coverage({grant:f.grant})).caughtUp,false);
  await f.api.flush();assert.equal((await f.api.coverage({grant:f.grant})).total,0);
  assert.equal((await f.cli('status')).indexReconciliation.state,'ready');
  await f.cli('control','--session','maintenance-session','--include');
  assert.equal((await f.api.status({grant:f.grant})).catalogueFresh,false);
  await f.api.flush();assert.equal((await f.query()).records.length,2);
  assert.equal((await f.cli('status')).indexReconciliation.state,'ready');
  const queueFile=path.join(f.options.directory,'vector-queue.json'),queueBefore=await fs.readFile(queueFile,'utf8');
  await f.cli('control','--session','maintenance-session','--include');
  await f.api.status({grant:f.grant});await f.api.coverage({grant:f.grant});
  assert.equal(await fs.readFile(queueFile,'utf8'),queueBefore,'unchanged controls do not notify again');
});

test('maintenance weight and reviewed fragments update coverage without changing originals',async t=>{
  const f=await maintenanceFixture(t);await f.prepare();
  const embeds=()=>f.calls.filter(c=>c.op==='embed'&&c.kind==='document').length;
  const initial=embeds();await f.cli('control','--session','maintenance-session','--weight','0.4');
  await f.api.flush();assert.equal(embeds(),initial,'weight-only change does not encode unchanged text');
  assert.equal((await f.query()).records[0].weight,0.4);
  const key={scope:f.scope,turnId:f.turn.turnId};
  f.store.setLegacyScopeView({...key,turnRevision:f.store.getLegacyScopeView(key).turnRevision,messages:[
    {messageId:'maintenance-user',ranges:[[0,26]]},{messageId:'maintenance-assistant',ranges:[]},
  ]});
  assert.equal((await f.api.coverage({grant:f.grant})).caughtUp,false);await f.api.flush();
  const record=(await f.query()).records[0];assert.equal(record.text.includes('Separate work'),false);
  f.store.clearLegacyScopeView({...key,turnRevision:f.store.getLegacyScopeView(key).turnRevision});await f.api.flush();assert.equal((await f.query()).records[0].text.includes('Separate work'),true);
  await f.cli('control','--session','maintenance-session','--weight','0');await f.api.flush();
  assert.equal((await f.api.coverage({grant:f.grant})).total,0);
});

test('offline maintenance survives restart and does not resurrect a cancelled preparation',async t=>{
  const f=await maintenanceFixture(t);await f.prepare();await f.api.close();
  await f.cli('control','--session','maintenance-session','--exclude');await f.restart();
  const grant=f.manager();t.after(()=>grant.cancel());await f.api.resume();await f.api.flush();
  assert.equal((await f.api.coverage({grant})).total,0);
  await f.api.cancel({grant});const calls=f.calls.length;
  await f.cli('control','--session','maintenance-session','--include');await f.api.resume();await f.api.flush();
  assert.equal(f.calls.slice(calls).some(c=>c.op==='embed'),false);
  assert.equal((await f.cli('status')).indexReconciliation.state,'cancelled');
  assert.equal((await f.api.coverage({grant})).caughtUp,false);
});

test('maintenance without active index stays unprepared and does not load a model',async t=>{
  const f=await maintenanceFixture(t);await f.cli('control','--session','maintenance-session','--exclude');
  await f.api.resume();await f.api.flush();assert.equal(f.instances.length,0);
  assert.equal((await f.cli('status')).indexReconciliation.state,'unprepared');
  await f.prepare();assert.equal((await f.cli('status')).indexReconciliation.state,'ready');
});

test('maintenance watermarks distinguish rapid changes, ignore another owner, and retain changes during a pass',async t=>{
  const f=await maintenanceFixture(t);await f.prepare();
  const control=weight=>f.store.setControl({scope:f.scope,targetType:'session',targetId:'maintenance-session',weight});
  const clock=Date.now;const stamps=[];
  try{Date.now=()=>1700000000000;for(const weight of [0.3,0.4,0.3]){control(weight);stamps.push(f.raw.maintenanceRevision());}}
  finally{Date.now=clock;}
  assert.equal(new Set(stamps).size,3);
  f.store.setControl({scope:'another-owner',targetType:'session',targetId:'another-session',excluded:true});
  assert.equal(f.raw.maintenanceRevision(),stamps.at(-1));await f.api.flush();
  const key={scope:f.scope,turnId:f.turn.turnId};
  f.store.setLegacyScopeView({...key,turnRevision:f.store.getLegacyScopeView(key).turnRevision,messages:[
    {messageId:'maintenance-user',ranges:[[0,26]]},{messageId:'maintenance-assistant',ranges:[]},
  ]});
  let changed=false;
  f.hooks.embed=async(_texts,options)=>{if(options.kind==='document'&&!changed){changed=true;control(0);await f.api.reconcileMaintenance();}};
  await f.api.flush();assert.equal(changed,true);
  assert.equal((await f.cli('status')).indexReconciliation.state,'pending','in-flight acknowledgement must not erase the newer maintenance change');
  await f.api.flush();assert.equal((await f.api.coverage({grant:f.grant})).total,0);
  assert.equal((await f.cli('status')).indexReconciliation.state,'ready');
});

async function fixture(t,overrides={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'portable-vectors-'));
  const agent={session:{id:'fictional-session'}},notes=new Map(),messages=new Map(),legacy=new Map(),calls=[],instances=[],hooks={};
  const valid=new WeakSet();let enabled=true,api;
  const access={ownerSubject:'fictional-owner',validate:g=>enabled&&valid.has(g)&&!g.signal.aborted,
    grant(){const controller=new AbortController();const grant={ownerSubject:access.ownerSubject,project:'main',sessionId:agent.session.id,signal:controller.signal,cancel(){valid.delete(grant);controller.abort();}};valid.add(grant);return grant;},
    withGrant:(_grant,run)=>run()};
  const config={project:'main',captureFolder:'chats',rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallGgufModel:'fictional-Q4.gguf',
    rawRecallDevice:'auto',rawRecallCpuThreads:6,rawRecallGpuThreads:4,rawRecallIdleMs:120000};
  const raw={messageReader(){return {list({beforePosition=Number.MAX_SAFE_INTEGER,limit}){
    calls.push({op:'messages',beforePosition});const sources=[...messages.values()].filter(row=>row.position<beforePosition).sort((a,b)=>b.position-a.position).slice(0,limit);
    return {sources,nextBefore:sources.length===limit?sources.at(-1).position:null};
  }};},queryReader(){return {get(ref){
    const row=(ref.storage==='message'?messages:legacy).get(ref.id);return row&&row.revision===ref.revision&&!row.hidden?{...row,ref:{...ref}}:null;
  },legacyPage({after='',limit}){
    calls.push({op:'legacy',after});const all=[...legacy.values()].filter(row=>!row.hidden).sort((a,b)=>a.id.localeCompare(b.id));const offset=after?all.findIndex(row=>row.id===after)+1:0;
    const sources=all.slice(offset,offset+limit);return {sources,nextAfter:offset+limit<all.length?sources.at(-1).id:null};
  }};},entryRepository(){return {operation(){return null;}};},querySourceState(){return {state:'live'};}};
  const entries={forGrant(_agent,grant){return {async read(id){
    assert.equal(access.validate(grant),true);const note=[...notes.values()].find(note=>note.frontmatter.memory_entry_id===id);if(!note)return null;
    const {readMemoryEntry}=await import('../lib/memory-entry.js');
    return {...readMemoryEntry({metadata:note.frontmatter,content:note.content.split('\n')[1]}),id,revision:note.checksum,sourceStatus:{eligible:true,manualBody:false}};
  }};}};
  const toolDefinition=name=>({async execute(args,exec){
    assert.equal(exec.memoryAuthorization(),true);calls.push({op:name,args});
    if(name.endsWith('list_directory')){
      const all=[...notes.values()].filter(note=>note.permalink.startsWith('main/'+args.dir_name+'/')).sort((a,b)=>a.permalink.localeCompare(b.permalink));
      const begin=(args.page-1)*args.page_size;
      return {structuredContent:{result:{nodes:all.slice(begin,begin+args.page_size).map(note=>({permalink:note.permalink,type:'file'})),has_more:begin+args.page_size<all.length}}};
    }
    if(name.endsWith('read_note')){const value=await hooks.read?.(args);return {structuredContent:{result:structuredClone(value??notes.get(args.identifier)??{error:'NOTE_NOT_FOUND'})}};}
    throw Error('Unexpected tool '+name);
  }});
  const tools={get(name){if(!enabled)throw Error('Conversation memory is disabled');return toolDefinition(name);},
    forManagement(check){return {get(name){check();return toolDefinition(name);}};},
    // Management keeps working while chat access is disabled, so the backend reads the double directly.
    vaultBackend:toolVaultBackend({get:toolDefinition})};
  const createBackend=({config:settings,profile,deviceCacheFile})=>{
    const backend={modelKey:null,batchSize:2,async prepare(){calls.push({op:'prepare',device:settings.rawRecallDevice});await hooks.prepare?.();backend.modelKey='same-weight-space';return {modelKey:backend.modelKey,dimensions:2560};},
      async planChunks(text,options){options.signal.throwIfAborted();return [{text,start:0,end:text.length,tokenBound:Math.min(text.length,100)}];},
      async embed(texts,options){calls.push({op:'embed',kind:options.kind,texts});await hooks.embed?.(texts,options);options.signal.throwIfAborted();return texts.map(()=>Array.from({length:2560},(_,i)=>i===0?1:0));},
      status(){return {requestedDevice:settings.rawRecallDevice,actualDevice:backend.modelKey?(settings.rawRecallDevice==='cpu'?'cpu':'cuda'):null,fallbackReason:null,runtime:{threads:settings.rawRecallCpuThreads},idleReleaseMs:settings.rawRecallIdleMs};},
      async dispose(){calls.push({op:'dispose'});backend.modelKey=null;backend.disposed=true;}};
    instances.push({backend,settings,profile,deviceCacheFile});return backend;
  };
  const options={directory,access,raw,entries,tools,config,findAgent:id=>id===agent.session.id?agent:null,listAgents:()=>[agent],createBackend,queueConfig:{debounceMs:60000},...overrides};
  api=createMemoryVectors(options);
  t.after(async()=>{await api.close();await fs.rm(directory,{recursive:true,force:true});});
  function source(id,index,storage='message'){
    return {id,revision:1,position:index+1,role:index%2?'assistant':'user',text:'fictional original '+id,sessionId:agent.session.id,messageId:id,sequence:index,turn:1,
      completion:'completed',weight:1,time:1700000000000,ref:{storage,id,revision:1}};
  }
  function note(identifier,content,frontmatter={}){const row={permalink:identifier,content,checksum:'v1-'+identifier,frontmatter};notes.set(identifier,row);return row;}
  const manager=()=>api.managementGrant({agent});
  return {get api(){return api;},directory,agent,access,config,raw,entries,notes,messages,legacy,calls,instances,hooks,source,note,manager,tools,options,
    disable(){enabled=false;},async restart(){await api.close();api=createMemoryVectors(options);await api.ready();},
    async prepare(){const grant=manager();try{await api.registerCurrentConfig({grant});return await api.prepare({grant});}finally{grant.cancel();}}};
}

test('portable registers 4B without loading and prepares all domains in one active space',async t=>{
  const f=await fixture(t);
  f.messages.set('m1',f.source('m1',0));f.messages.set('m2',f.source('m2',1));f.legacy.set('old',f.source('old',2,'legacy'));
  f.note('main/chats/facts/old','<!-- dsh-fact-memory -->\n- [fact] fictional preference',{memory_id:'old-note',memory_kind:'fact',value:'fictional preference'});
  const semantic={type:'preference',content:'new preference',subject_ref:null,source_refs:[{id:'m1',revision:1,role:'user'}],state:{validity:'current',progress:null},tags:[],importance:null};
  f.note('main/chats/entries/new','<!-- dsh-memory-entry:start -->\nnew preference\n<!-- dsh-memory-entry:end -->',{...memoryEntryMetadata(semantic),memory_entry_id:'entry-id'});
  f.note('main/dafeiyu/thoughts/one','fictional thought');f.note('main/dafeiyu/diary/one','fictional diary');
  f.note('main/manual/chosen','chosen manual');f.note('main/private/not-selected','private body never read');
  const grant=f.manager();await f.api.ready();await f.api.registerCurrentConfig({grant});
  assert.equal(f.instances.length,0);assert.equal(f.calls.some(call=>call.op.includes('read_note')),false);
  await f.api.selectDocuments({grant,identifiers:['main/manual/chosen']});
  const prepared=await f.api.prepare({grant});assert.equal(prepared.completed,8);
  const coverage=await f.api.coverage({grant});assert.equal(coverage.total,8);assert.equal(coverage.caughtUp,true);
  assert.deepEqual(Object.keys(coverage.domains).sort(),['diary','document','entry','fact','raw','thoughts']);
  const reader=f.api.forAgent(f.agent),snapshot=await reader.getSnapshot({});
  const result=await reader.query({query:'fictional',profile:snapshot,limit:40,deadline:Date.now()+2000});
  assert.equal(result.records.length,8);assert.equal(result.profile.modelKey,'same-weight-space');
  assert.equal(f.instances.length,1);assert.equal(f.instances[0].settings.rawRecallModel,'Qwen/Qwen3-Embedding-4B');
  assert.equal(f.calls.some(call=>call.args?.identifier==='main/private/not-selected'),false);
  const catalogue=await fs.readFile(path.join(f.directory,'documents.json'),'utf8');assert.equal(catalogue.includes('chosen manual'),false);
  reader.close();grant.cancel();
});

// Pause the actual profile-file publication, after the last source scan. This
// reaches the handoff window without replacing profiles, SQLite or the queue.
for(const mode of ['first','same','switch'])test(`portable ${mode} preparation retains late catalogue changes and does not report ready`,async t=>{
  const f=await fixture(t,{queueConfig:{debounceMs:0,timers:{setTimeout(){return {unref(){}};},clearTimeout(){}}}});
  for(const [i,id] of ['stable','edited','removed'].entries())f.messages.set(id,f.source(id,i));
  const grant=f.manager();await f.api.ready();await f.api.registerCurrentConfig({grant});
  if(mode!=='first')await f.api.prepare({grant});
  const old=await f.api.getSnapshot({grant});
  if(mode==='switch')await f.api.registerCurrentConfig({grant,profileId:'fictional-new-profile'});
  const rename=fs.rename;let injected=false;
  fs.rename=async function(from,to){
    if(!injected&&to===path.join(f.directory,'profiles.json')){
      const candidate=JSON.parse(await fs.readFile(from,'utf8')).scopes[0];
      if(candidate.active?.indexId&&candidate.active.indexId!==old?.indexId&&candidate.progress.some(p=>p.checkpointId===candidate.active.indexId&&p.state==='ready')){
        injected=true;
        f.messages.set('added',f.source('added',4));
        f.messages.set('edited',{...f.messages.get('edited'),revision:2,text:'new version',ref:{storage:'message',id:'edited',revision:2}});
        f.messages.get('removed').hidden=true;
        for(const id of ['added','edited','removed'])await f.api.notifyChanged({ownerSubject:f.access.ownerSubject,project:'main',id,revision:f.messages.get(id).revision,kind:'message'});
      }
    }
    return rename.call(fs,from,to);
  };
  try{await f.api.prepare({grant});}finally{fs.rename=rename;}
  assert.equal(injected,true);
  const pending=await f.api.coverage({grant});assert.equal(pending.caughtUp,false);assert.equal(pending.catalogueFresh,false);
  const status=await f.api.status({grant});assert.equal(status.profiles.find(p=>p.id===status.activeProfileId).progress.state,'pending');
  await f.api.flush();
  const coverage=await f.api.coverage({grant});assert.equal(coverage.caughtUp,true);assert.equal(coverage.catalogueFresh,true);assert.equal(coverage.total,3);
  const result=await f.api.query({grant,query:'fixture',deadline:Date.now()+2000});
  assert.deepEqual(result.records.map(r=>[r.id,r.revision]).sort(),[['added',1],['edited',2],['stable',1]]);
  assert.equal((await f.api.status({grant})).profiles.find(p=>p.id===status.activeProfileId).progress.state,'ready');
  grant.cancel();
});

test('portable recovers a persisted catalogue change after publication but before handoff is saved',async t=>{
  const f=await fixture(t,{queueConfig:{debounceMs:0,timers:{setTimeout(){return {unref(){}};},clearTimeout(){}}}});
  f.messages.set('old',f.source('old',0));let grant=f.manager();
  await f.api.ready();await f.api.registerCurrentConfig({grant});
  const rename=fs.rename;let published=false,injected=false;
  fs.rename=async function(from,to){
    if(published&&to===path.join(f.directory,'vector-queue.json'))throw Object.assign(Error('fixture publication interruption'),{code:'FIXTURE_INTERRUPTED'});
    if(!injected&&to===path.join(f.directory,'profiles.json')){
      const candidate=JSON.parse(await fs.readFile(from,'utf8')).scopes[0];
      if(candidate.active){
        injected=true;f.messages.set('late',f.source('late',1));
        await f.api.notifyChanged({ownerSubject:f.access.ownerSubject,project:'main',id:'late',revision:1,kind:'message'});
        await rename.call(fs,from,to);published=true;return;
      }
    }
    return rename.call(fs,from,to);
  };
  try{await assert.rejects(f.api.prepare({grant}),{code:'FIXTURE_INTERRUPTED'});}finally{fs.rename=rename;}
  grant.cancel();await f.restart();grant=f.manager();
  const count=f.instances.length;
  assert.equal((await f.api.coverage({grant})).catalogueFresh,false);
  assert.equal((await f.api.status({grant})).profiles[0].progress.state,'pending');
  assert.equal(f.instances.length,count,'Read-only status must not load a model');
  await f.api.resume();await f.api.flush();
  assert.equal((await f.api.coverage({grant})).caughtUp,true);
  const result=await f.api.query({grant,query:'late',deadline:Date.now()+2000});
  assert.equal(result.records.some(row=>row.id==='late'),true);grant.cancel();
});

test('portable cancellation keeps dirty catalogue without reviving the cancelled intent',async t=>{
  const f=await fixture(t,{queueConfig:{debounceMs:0,timers:{setTimeout(){return {unref(){}};},clearTimeout(){}}}});
  f.messages.set('old',f.source('old',0));await f.prepare();const grant=f.manager();
  f.messages.set('late',f.source('late',1));
  await f.api.notifyChanged({ownerSubject:f.access.ownerSubject,project:'main',id:'late',revision:1,kind:'message'});
  const oldJob=(await f.api.status()).queue.jobs[0];
  await f.api.cancel({grant});const embeds=f.calls.filter(c=>c.op==='embed').length;
  await f.api.resume();await f.api.flush();
  assert.equal(f.calls.filter(c=>c.op==='embed').length,embeds);
  assert.equal((await f.api.coverage({grant})).caughtUp,false);
  assert.equal((await f.api.status()).queue.jobs.find(j=>j.intentId===oldJob.intentId).state,'cancelled');
  await f.api.prepare({grant});
  assert.equal((await f.api.coverage({grant})).caughtUp,true);
  assert.equal((await f.api.status()).queue.jobs.find(j=>j.intentId===oldJob.intentId).state,'cancelled');grant.cancel();
});

test('portable notification during incremental work remains pending until a later pass',async t=>{
  const f=await fixture(t,{queueConfig:{debounceMs:0,timers:{setTimeout(){return {unref(){}};},clearTimeout(){}}}});
  f.messages.set('old',f.source('old',0));await f.prepare();const grant=f.manager();
  const notify=id=>f.api.notifyChanged({ownerSubject:f.access.ownerSubject,project:'main',id,revision:1,kind:'message'});
  f.messages.set('first',f.source('first',1));await notify('first');
  f.hooks.embed=async()=>{f.hooks.embed=null;f.messages.set('second',f.source('second',2));await notify('second');};
  await f.api.flush();assert.equal((await f.api.coverage({grant})).catalogueFresh,false);
  await f.api.flush();const coverage=await f.api.coverage({grant});assert.equal(coverage.caughtUp,true);assert.equal(coverage.total,3);grant.cancel();
});

test('portable adopts a pre-watermark queue without resetting its delivery counter',async t=>{
  const f=await fixture(t,{queueConfig:{debounceMs:0,timers:{setTimeout(){return {unref(){}};},clearTimeout(){}}}});
  f.messages.set('old',f.source('old',0));await f.prepare();
  await f.api.notifyChanged({ownerSubject:f.access.ownerSubject,project:'main',id:'old',revision:1,kind:'message'});await f.api.flush();
  await f.api.close();const file=path.join(f.directory,'vector-queue.json'),legacy=JSON.parse(await fs.readFile(file,'utf8'));
  delete legacy.catalogues;legacy.jobs[0].delivery=9;await fs.writeFile(file,JSON.stringify(legacy));
  await f.restart();const grant=f.manager();f.messages.set('late',f.source('late',1));
  await f.api.notifyChanged({ownerSubject:f.access.ownerSubject,project:'main',id:'late',revision:1,kind:'message'});
  assert.equal((await f.api.status()).queue.jobs[0].delivery,10);
  assert.equal((await f.api.coverage({grant})).caughtUp,false);
  await f.api.flush();const coverage=await f.api.coverage({grant});assert.equal(coverage.caughtUp,true);assert.equal(coverage.total,2);grant.cancel();
});

test('portable publication arms the normal timer and catches up without another notification or manual flush',async t=>{
  const f=await fixture(t,{queueConfig:{debounceMs:10}});f.messages.set('old',f.source('old',0));
  const grant=f.manager();await f.api.ready();await f.api.registerCurrentConfig({grant});
  const rename=fs.rename;let injected=false;
  fs.rename=async function(from,to){
    if(!injected&&to===path.join(f.directory,'profiles.json')&&JSON.parse(await fs.readFile(from,'utf8')).scopes[0]?.active){
      injected=true;f.messages.set('late',f.source('late',1));
      await f.api.notifyChanged({ownerSubject:f.access.ownerSubject,project:'main',id:'late',revision:1,kind:'message'});
    }
    return rename.call(fs,from,to);
  };
  try{await f.api.prepare({grant});}finally{fs.rename=rename;}
  assert.equal(injected,true);
  let coverage;const deadline=Date.now()+3000;
  do{coverage=await f.api.coverage({grant});if(coverage.caughtUp)break;await delay(10);}while(Date.now()<deadline);
  assert.equal(coverage.caughtUp,true);assert.equal(coverage.total,2);
  assert.equal((await f.api.status()).queue.completed,1);grant.cancel();
});

test('canonical, legacy and Basic Memory enumeration continue beyond the first 100',async t=>{
  const f=await fixture(t);
  for(let i=0;i<101;i++){
    f.messages.set('m'+i,f.source('m'+i,i));f.legacy.set('l'+i,f.source('l'+i,i,'legacy'));
    f.note('main/dafeiyu/diary/'+String(i).padStart(3,'0'),'diary '+i);
  }
  const prepared=await f.prepare();assert.equal(prepared.completed,303);
  assert.ok(f.calls.some(call=>call.op==='messages'&&call.beforePosition!==Number.MAX_SAFE_INTEGER));
  assert.ok(f.calls.some(call=>call.op==='legacy'&&call.after));
  assert.ok(f.calls.some(call=>call.args?.dir_name==='dafeiyu/diary'&&call.args?.page===2));
});

test('manual edits, unselection, hidden original and broken entry proof invalidate old candidates',async t=>{
  const f=await fixture(t);f.messages.set('m1',f.source('m1',0));
  f.note('main/dafeiyu/diary/edit','before edit');
  f.note('main/manual/chosen','selected body');
  const semantic={type:'fact',content:'derived entry',subject_ref:null,source_refs:[{id:'m1',revision:1}],state:{validity:'current',progress:null},tags:[],importance:null};
  f.note('main/chats/entries/new','<!-- dsh-memory-entry:start -->\nderived entry\n<!-- dsh-memory-entry:end -->',{...memoryEntryMetadata(semantic),memory_entry_id:'entry-id'});
  const manager=f.manager();await f.api.selectDocuments({grant:manager,identifiers:['main/manual/chosen']});await f.prepare();
  const reader=f.api.forAgent(f.agent),profile=await reader.getSnapshot({});
  f.notes.get('main/dafeiyu/diary/edit').content='manual new version';f.notes.get('main/dafeiyu/diary/edit').checksum='v2';
  f.messages.get('m1').hidden=true;await f.api.selectDocuments({grant:manager,identifiers:[]});
  const result=await reader.query({query:'before',profile,deadline:Date.now()+2000});assert.deepEqual(result.records,[]);
  const documentEmbeds=f.calls.filter(call=>call.op==='embed'&&call.kind==='document').length;
  await reader.query({query:'before',profile,deadline:Date.now()+2000});
  assert.equal(f.calls.filter(call=>call.op==='embed'&&call.kind==='document').length,documentEmbeds);
  reader.close();manager.cancel();
});

test('Basic Memory sync lag hides the old anchor and retries without removing a temporarily unlisted note',async t=>{
  let now=Date.now();
  const f=await fixture(t,{now:()=>now});
  const identifier='main/dafeiyu/diary/edit',filePath='dafeiyu/diary/Edit.md',id='document:'+encodeURIComponent(identifier);
  const note=f.note(identifier,'old human body');note.file_path=filePath;
  await f.prepare();
  const grant=f.manager(),before=await f.api.getSnapshot({grant}),revision=note.checksum;
  const open=revision=>f.api.resolveDocument({grant,id,revision});
  const changed=()=>f.api.notifyChanged({kind:'vault',id:'vault',revision:'change',ownerSubject:f.access.ownerSubject,project:'main'});
  assert.equal((await open(revision)).text,'old human body');
  f.notes.delete(identifier);
  f.hooks.read=args=>{
    if(args.identifier!==identifier)return;
    assert.equal(args.known_file_path,filePath);
    return {error:'NOTE_SYNC_PENDING',retryable:true};
  };
  assert.equal(await open(revision),null);
  await changed();now+=60001;
  const waiting=await f.api.flush();
  assert.equal(waiting.pending,1);
  assert.equal(waiting.jobs[0].error,'MEMORY_NOTE_SYNC_PENDING');
  assert.deepEqual(await f.api.getSnapshot({grant}),before);
  assert.equal((await f.api.coverage({grant})).total,1);

  f.hooks.read=null;
  f.notes.set(identifier,{...note,content:'fresh human body',checksum:'fresh'});
  now+=1001;
  assert.equal((await f.api.flush()).completed,1);
  assert.equal((await open('fresh')).text,'fresh human body');
  assert.equal(await open(revision),null);

  f.notes.delete(identifier);
  await changed();now+=60001;
  assert.equal((await f.api.flush()).completed,1);
  assert.equal(await open('fresh'),null);
  assert.equal((await f.api.coverage({grant})).total,0);
  grant.cancel();
});

test('device-only update drains the in-flight request and preserves active index/revision',async t=>{
  const f=await fixture(t);f.messages.set('m1',f.source('m1',0));await f.prepare();
  const reader=f.api.forAgent(f.agent),before=await reader.getSnapshot({});
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  f.hooks.embed=async(_texts,options)=>{if(options.kind==='query'){started();await new Promise(resolve=>{release=resolve;});}};
  const pending=reader.query({query:'hold',profile:before,deadline:Date.now()+2000});await began;
  const manager=f.manager();let updated=false;
  const change=f.api.registerCurrentConfig({grant:manager,settings:{...f.config,rawRecallDevice:'cpu'}}).then(value=>{updated=true;return value;});
  await delay(20);assert.equal(updated,false);assert.equal(f.instances[0].backend.disposed,undefined);
  release();await pending;const result=await change;assert.equal(result.runtimeOnly,true);assert.equal(result.profile.revision,before.revision);
  const after=await reader.getSnapshot({});assert.deepEqual(after,before);
  f.hooks.embed=null;const query=await reader.query({query:'after device switch',profile:after,deadline:Date.now()+2000});
  assert.equal(query.records.length,1);assert.equal(f.instances.length,2);assert.equal(f.instances[0].backend.disposed,true);
  assert.equal(f.instances[1].settings.rawRecallDevice,'cpu');assert.equal(f.instances[1].settings.rawRecallCpuThreads,6);
  assert.equal(f.instances[0].deviceCacheFile,f.instances[1].deviceCacheFile);
  assert.equal(f.instances[0].deviceCacheFile,path.join(f.directory,'device-compatibility.json'));
  const status=await f.api.status({grant:manager});assert.equal(status.profiles[0].actualDevice,'cpu');
  reader.close();manager.cancel();
});

test('cold query has a shared deadline and never enumerates or repairs the library',async t=>{
  const f=await fixture(t);f.messages.set('m1',f.source('m1',0));await f.prepare();
  const manager=f.manager();await f.api.release({grant:manager});f.calls.length=0;
  f.hooks.prepare=()=>delay(120);
  const reader=f.api.forAgent(f.agent),profile=await reader.getSnapshot({});const started=Date.now();
  const result=await reader.query({query:'cold',profile,deadline:Date.now()+25});
  assert.equal(result.state,'unavailable');assert.ok(Date.now()-started<100);
  assert.equal(f.calls.some(call=>call.op==='messages'||call.op==='legacy'||call.op.includes('list_directory')),false);
  reader.close();manager.cancel();
});

test('pending vector work survives restart and reuses the active space without a model at ready',async t=>{
  const f=await fixture(t);f.messages.set('m1',f.source('m1',0));await f.prepare();
  await f.api.notifyChanged({kind:'message',id:'m1',revision:2,ownerSubject:f.access.ownerSubject,project:'main'});
  await f.api.notifyChanged({kind:'document',id:'fictional-second-change',revision:'next',ownerSubject:f.access.ownerSubject,project:'main'});
  const manager=f.manager();const pendingCoverage=await f.api.coverage({grant:manager});assert.equal(pendingCoverage.caughtUp,false);assert.equal(pendingCoverage.pendingBoundaries,1);manager.cancel();
  f.messages.get('m1').revision=2;f.messages.get('m1').ref.revision=2;f.messages.get('m1').text='updated original';
  await f.restart();const instanceCount=f.instances.length;
  assert.equal(f.api.status instanceof Function,true);const state=await f.api.status();assert.equal(state.queue.pending,1);assert.equal(state.queue.jobs[0].delivery,2);assert.equal(f.instances.length,instanceCount);
  // The original debounce is durable; advance only this fictional queue clock.
  const file=path.join(f.directory,'vector-queue.json');await f.api.close();const saved=JSON.parse(await fs.readFile(file,'utf8'));saved.jobs[0].nextAt=0;await fs.writeFile(file,JSON.stringify(saved));
  await f.restart();await f.api.flush();const done=await f.api.status();assert.equal(done.queue.completed,1);
  const reader=f.api.forAgent(f.agent);const result=await reader.query({query:'updated original',deadline:Date.now()+2000});assert.equal(result.records[0].revision,2);reader.close();
});

test('revoked grant cannot return an awaited vector result or expose metadata',async t=>{
  const f=await fixture(t);f.messages.set('m1',f.source('m1',0));await f.prepare();
  const reader=f.api.forAgent(f.agent);f.hooks.embed=async(_texts,options)=>{if(options.kind==='query')f.disable();};
  await assert.rejects(reader.query({query:'fictional',deadline:Date.now()+2000}),{code:'MEMORY_NOT_AUTHORIZED'});
  assert.throws(()=>reader.getSnapshot({}),{code:'MEMORY_NOT_AUTHORIZED'});reader.close();
});

test('authenticated management works without an enabled chat or live agent and remains revocable',async t=>{
  const f=await fixture(t);f.note('main/dafeiyu/diary/manage','management-only diary');
  await f.api.close();f.options.listAgents=()=>[];f.options.findAgent=()=>null;await f.restart();f.disable();
  const grant=f.api.managementGrant();await f.api.registerCurrentConfig({grant});
  const prepared=await f.api.prepare({grant});assert.equal(prepared.completed,1);
  const snapshot=await f.api.activeSnapshot(grant);
  const result=await f.api.query({grant,profile:snapshot,query:'diary',deadline:Date.now()+2000});assert.equal(result.records.length,1);
  assert.equal(f.access.validate(grant),false);grant.cancel();
  await assert.rejects(f.api.resolveDocument({grant,id:result.records[0].id,revision:result.records[0].revision}),{code:'MEMORY_NOT_AUTHORIZED'});
});

test('source withdrawal during a later candidate read removes an earlier valid vector hit',async t=>{
  const f=await fixture(t);f.note('main/dafeiyu/diary/a','first diary');f.note('main/dafeiyu/diary/b','second diary');await f.prepare();
  const reader=f.api.forAgent(f.agent);let reads=0;
  f.hooks.read=({identifier})=>{if(identifier==='main/dafeiyu/diary/b'&&++reads===1)f.notes.get('main/dafeiyu/diary/a').frontmatter.excluded=true;};
  const result=await reader.query({query:'diary',deadline:Date.now()+2000});assert.equal(result.records.length,1);
  assert.equal(result.records[0].source.permalink,'main/dafeiyu/diary/b');reader.close();
});

test('device compatibility mismatch leaves preserved vectors unavailable rather than mixing spaces',async t=>{
  const f=await fixture(t);f.messages.set('m1',f.source('m1',0));await f.prepare();
  const grant=f.manager(),snapshot=await f.api.activeSnapshot(grant);
  await f.api.updateRuntime({grant,profileId:f.config.rawRecallModel,config:{rawRecallDevice:'cpu'}});
  f.hooks.prepare=()=>{const backend=f.instances.at(-1).backend;backend.prepare=async()=>{backend.modelKey='incompatible-space';return {modelKey:backend.modelKey,dimensions:2560};};};
  // First call constructs the adapter; the second prepare uses the deliberately
  // incompatible fixture identity, exercising the preserved snapshot guard.
  await f.api.load({grant});
  const result=await f.api.query({grant,profile:snapshot,query:'fictional',deadline:Date.now()+2000});
  assert.equal(result.reason,'EMBEDDING_IDENTITY_MISMATCH');assert.deepEqual(result.records,[]);grant.cancel();
});

test('indexed CPU work observes the absolute clock deadline without waiting for a timer callback',async t=>{
  const f=await fixture(t);for(let i=0;i<20;i++)f.messages.set('m'+i,f.source('m'+i,i));await f.prepare();
  let clock=1000;f.options.now=()=>clock++;
  await f.restart();const reader=f.api.forAgent(f.agent),start=Date.now();
  const result=await reader.query({query:'fictional',deadline:clock+80});
  assert.equal(result.reason,'MEMORY_SEARCH_TIMEOUT');assert.equal(result.records.length,0);
  assert.ok(Date.now()-start<100);reader.close();
});

test('foreground note verification runs in groups of four and reads only necessary candidates',async t=>{
  const f=await fixture(t);for(let i=0;i<20;i++)f.note('main/dafeiyu/diary/'+String(i).padStart(2,'0'),'diary '+i);await f.prepare();
  const reader=f.api.forAgent(f.agent);let running=0,peak=0,reads=0;
  f.hooks.read=async()=>{reads++;running++;peak=Math.max(peak,running);try{await delay(5);}finally{running--;}};
  f.calls.length=0;const result=await reader.query({query:'diary',limit:5,deadline:Date.now()+2000});
  assert.equal(result.records.length,5);assert.equal(peak,4);assert.ok(reads<20);assert.equal(result.degraded,true);
  assert.equal(f.calls.some(call=>call.op.endsWith('list_directory')),false);reader.close();
});

test('management operations reject an obsolete profile revision before touching another version',async t=>{
  const f=await fixture(t);f.messages.set('m1',f.source('m1',0));await f.prepare();const grant=f.manager();
  const before=await f.api.status({grant}),profileRevision=before.profiles[0].revision,profileId=before.profiles[0].id;
  await f.api.registerCurrentConfig({grant,settings:{...f.config,rawRecallQueryInstruction:'different query encoding'}});
  const calls=f.calls.length;
  for(const action of ['load','prepare','release','cancel','select'])await assert.rejects(f.api[action]({grant,profileId,profileRevision}),{code:'PROFILE_CHANGED'});
  assert.equal(f.calls.length,calls);assert.equal(f.instances[0].backend.disposed,undefined);grant.cancel();
});

test('a load whose target revision changes while starting retires its own instance safely',async t=>{
  const f=await fixture(t),grant=f.manager();await f.api.registerCurrentConfig({grant});
  const state=await f.api.status({grant}),profileId=state.profiles[0].id,profileRevision=state.profiles[0].revision;
  let release,started;const began=new Promise(resolve=>{started=resolve;});
  f.hooks.prepare=async()=>{started();await new Promise(resolve=>{release=resolve;});};
  const loading=f.api.load({grant,profileId,profileRevision});await began;
  await f.api.registerCurrentConfig({grant,settings:{...f.config,rawRecallQueryInstruction:'changed while loading'}});
  release();await assert.rejects(loading,{code:'PROFILE_CHANGED'});assert.equal(f.instances[0].backend.disposed,true);grant.cancel();
});

// Vector model switching: a confirmed switch staged before reload prepares the
// selected profile; without one nothing changes (no backend, no preparation).
const switchSources=f=>{for(let i=0;i<4;i++)f.messages.set('s'+i,f.source('s'+i,i));};
const documentEmbeds=f=>f.calls.filter(call=>call.op==='embed'&&call.kind==='document').flatMap(call=>call.texts);
test('switch: no staged confirmation means no intent, no target and no backend',async t=>{
  const f=await fixture(t);switchSources(f);const grant=f.manager();t.after(()=>grant.cancel());
  await f.api.registerCurrentConfig({grant});
  assert.equal(f.api.switchIntent(),null);assert.equal(await f.api.switchTarget({grant}),null);
  assert.equal(f.instances.length,0);assert.equal((await f.api.status({grant})).active,null);
});
test('switch: confirmed reload prepares without further actions, clears the intent and is consumed once',async t=>{
  const f=await fixture(t);switchSources(f);
  f.options.config={...f.config,rawRecallSwitch:{confirmedAt:'fictional-confirmed-1',cloudConfirmed:false}};await f.restart();
  let grant=f.manager();await f.api.registerCurrentConfig({grant});
  const target=await f.api.switchTarget({grant});
  assert.equal(target.profileId,'Qwen/Qwen3-Embedding-4B');assert.equal(f.instances.length,0);
  assert.equal((await f.api.prepare({grant,...target})).state,'ready');
  const status=await f.api.status({grant});assert.equal(status.switchIntent,null);assert.equal(status.activeProfileId,target.profileId);
  grant.cancel();await f.restart();grant=f.manager();t.after(()=>grant.cancel());
  await f.api.registerCurrentConfig({grant});
  assert.equal(f.api.switchIntent(),null,'the same confirmation is not replayed after another restart');
});
test('switch: an interrupted preparation resumes after restart without re-encoding finished documents',async t=>{
  const f=await fixture(t);switchSources(f);
  f.options.config={...f.config,rawRecallSwitch:{confirmedAt:'fictional-confirmed-2'}};await f.restart();
  let grant=f.manager();await f.api.registerCurrentConfig({grant});
  const controller=new AbortController();let seen=0;
  f.hooks.embed=async(_texts,options)=>{if(options.kind==='document'&&++seen===2)controller.abort();};
  await assert.rejects(f.api.prepare({grant,signal:controller.signal,...await f.api.switchTarget({grant})}));
  f.hooks.embed=undefined;grant.cancel();
  const before=documentEmbeds(f).length;
  await f.restart();grant=f.manager();t.after(()=>grant.cancel());await f.api.registerCurrentConfig({grant});
  const target=await f.api.switchTarget({grant});assert.ok(target,'intent survives the interruption');
  assert.equal((await f.api.prepare({grant,...target})).state,'ready');
  assert.equal(documentEmbeds(f).length-before,4-1,'only unfinished documents are encoded again');
  assert.equal(f.api.switchIntent(),null);
});
test('switch: cloud profiles need the per-switch confirmation and the cloud opt-in',async t=>{
  const f=await fixture(t);switchSources(f);
  const cloudConfig=(cloudConfirmed,allow=true,confirmedAt='c-'+cloudConfirmed+allow)=>({project:'main',captureFolder:'chats',rawRecallModel:'text-embedding-v4',rawRecallDimensions:1024,
    rawRecallAllowCloud:allow,rawRecallSwitch:{confirmedAt,cloudConfirmed}});
  f.options.config=cloudConfig(false);await f.restart();
  let grant=f.manager();await f.api.registerCurrentConfig({grant});
  assert.equal(f.api.switchIntent().cloudConfirmed,false);assert.equal(await f.api.switchTarget({grant}),null);
  grant.cancel();f.options.config=cloudConfig(true);await f.restart();grant=f.manager();t.after(()=>grant.cancel());
  await f.api.registerCurrentConfig({grant});assert.ok(await f.api.switchTarget({grant}));
  f.options.config=cloudConfig(true,false,'c-revoked');await f.api.registerCurrentConfig({grant,settings:f.options.config});
  assert.equal(f.api.switchIntent(),null,'turning the cloud switch off drops the intent');
  assert.equal(f.calls.filter(call=>call.op==='embed').length,0,'no provider request was made');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMemoryOrganizer,ORGANIZER_MAX_TOKENS} from '../lib/memory-organizer.js';
import {createMemoryEntryService} from '../lib/memory-entry-service.js';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {MEMORY_ENTRY_TYPES} from '../lib/memory-contract.js';
import {memoryStore} from './fake-memory.js';
import {toolVaultBackend} from './helpers.js';

const scope={ownerSubject:'虚构用户',project:'main'};
const source=(role,index,text)=>({id:`fixture-${index}`,revision:1,role,sessionId:'original-session',text,range:{start:0,end:text.length,total:text.length}});
const sources=[source('user',1,'我计划周末整理书架，这件事很重要。'),source('assistant',2,'我建议按主题整理，但这只是建议。')];
const item=(patch={})=>({type:'plan',content:'用户计划周末整理书架。',subject_ref:'p1',source_refs:['s1'],
  state:{validity:'current',progress:'planned'},tags:['书架'],importance:{level:'high',basis:'user_explicit',reason:'s1 中用户明确说很重要'},
  evidence_basis:'self_report',speaker_ref:'p1',...patch});
const response=(items=[],changes=[])=>({items,changes});
const notesIn=(memory,directory)=>[...memory.notes.values()].filter(note=>note.directory===directory);
function assertTopicPage(memory,label='书架'){
  const note=notesIn(memory,'chats/topics').find(item=>item.title===label);
  assert.ok(note,'missing topic page: '+label);
  assert.equal(note.filePath,'chats/topics/'+label+'.md');
  assert.deepEqual(note.frontmatter,{title:label,type:'note',tags:['dsh-topic'],embed:false});
  assert.equal(note.content,'# '+label+'\n\n本页由记忆框架自动维护，可在下方自由补充\n');
}
async function fixture(t,{output=response([item()]),finish='stop',chunks,onUsage,backend:decorate}={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'organizer-fixture-'));
  const raw=new RawMemoryStore(path.join(dir,'raw.sqlite'),{warn(){}}),memory=memoryStore({project:'main'});
  t.after(async()=>{raw.close();await fs.rm(dir,{recursive:true,force:true});});
  let allowed=true,generated=0,commits=0;
  const controller=new AbortController(),calls=[],batchRefs=[],receipts=[];
  const ctx={batchId:'batch-one',scope,agent:{session:{id:'original-session'},options:{provider:'changed',model:'changed'}},
    target:{provider:'frozen-provider',model:'frozen-model'},referenceTokens:2048,signal:controller.signal,
    check(){if(!allowed)throw Object.assign(Error('grant revoked'),{code:'MEMORY_NOT_AUTHORIZED'});}};
  const originals=new Map(sources.map(s=>[s.id,{...s,...scope,isCurrent:true}]));
  const initialBackend=toolVaultBackend(memory.tools);
  const service=createMemoryEntryService({scope,config:{project:'main',captureFolder:'memory'},repository:()=>raw.entries,
    backend:decorate?decorate(initialBackend):initialBackend,sourceState:ref=>originals.get(ref.id)});
  const entries={forBatch(agent,refs){assert.equal(agent,ctx.agent);ctx.check();batchRefs.push(refs);
    for(const ref of refs)assert.equal(originals.get(ref.id)?.revision,ref.revision);
    return {read:id=>service.read(id,ctx),list:filters=>service.list(filters,ctx),commit:input=>{commits++;return service.commit(input,ctx);}};}};
  const llm={async *stream(options){generated++;calls.push(options);
    if(chunks){yield* chunks(options);return;}
    const json=typeof output==='string'?output:JSON.stringify(output),mid=Math.floor(json.length/2);
    yield {type:'text-delta',index:0,text:json.slice(0,mid)};yield {type:'text-delta',index:0,text:json.slice(mid)};
    yield {type:'finish',reason:{kind:finish},usage:{inputTokens:80,outputTokens:20,totalTokens:100,cacheReadTokens:12}};
  }};
  const make=(options={})=>createMemoryOrganizer({entries,llm,config:{organizerMaxTokens:2048},onUsage:async receipt=>{receipts.push(receipt);await onUsage?.(receipt);},...options});
  return {ctx,controller,calls,entries,llm,service,raw,memory,originals,batchRefs,receipts,make,
    revoke:()=>{allowed=false;},counts:()=>({generated,commits}),input:{sources}};
}

test('one organizer stream produces twelve types, preserving frozen route, roles, fragments and usage',async t=>{
  const f=await fixture(t,{output:response(MEMORY_ENTRY_TYPES.map(type=>item({type})))}),organizer=f.make();
  const prepared=await organizer.prepare(f.input,f.ctx);
  assert.equal(f.counts().generated,1);assert.deepEqual(prepared.operations.map(op=>op.proposed.type),MEMORY_ENTRY_TYPES);
  const request=f.calls[0];assert.equal(request.sessionId,'original-session');assert.equal(request.provider,'frozen-provider');
  assert.equal(request.model,'frozen-model');assert.equal(request.purpose,'memory-capture');assert.equal(request.maxTokens,2048);
  const prompt=JSON.parse(request.messages[0].content[0].text);
  assert.deepEqual(prompt.sources.map(s=>s.role),['user','assistant']);assert.deepEqual(prompt.sources[0].range,sources[0].range);
  assert.deepEqual(prepared.usage,{input_tokens:80,output_tokens:20,total_tokens:100,cache_read_input_tokens:12});
  assert.equal(f.receipts[0].outcome,'completed');
  const durable=JSON.parse(JSON.stringify(prepared));assert.equal(JSON.stringify(durable).includes(sources[0].text),false);
  assert.equal('text' in durable.sources[0][1],false);
  const result=await organizer.commit(durable,f.ctx);assert.equal(result.applied,12);assert.equal(result.committed,true);
  assert.equal(f.counts().generated,1);assert.equal(notesIn(f.memory,'memory/entries').length,12);assertTopicPage(f.memory);
});

test('zero items is successful, unlike malformed or truncated output',async t=>{
  const f=await fixture(t,{output:response()}),o=f.make(),prepared=await o.prepare(f.input,f.ctx);
  assert.deepEqual(prepared.operations,[]);assert.equal((await o.commit(prepared,f.ctx)).noChanges,true);
  assert.equal(f.counts().commits,0);
  for(const [output,finish,code] of [['{','stop','MEMORY_OUTPUT_INVALID'],[{},'stop','MEMORY_OUTPUT_INVALID'],[response(),'max-tokens','MEMORY_OUTPUT_TRUNCATED'],[response(),'error','MEMORY_GENERATION_FAILED'],[response(),undefined,'MEMORY_GENERATION_FAILED']]){
    const g=await fixture(t,{output,finish:finish??'unknown'});await assert.rejects(g.make().prepare(g.input,g.ctx),{code});
    assert.equal(g.counts().commits,0);assert.equal(g.receipts[0].usage.total_tokens,100);
  }
});

test('block-end text replaces streamed deltas and reasoning never becomes semantic JSON',async t=>{
  const json=JSON.stringify(response([item()]));
  const f=await fixture(t,{chunks:async function*(){
    yield {type:'reasoning-delta',text:'not JSON'};
    yield {type:'text-delta',index:1,text:json.slice(0,10)};
    yield {type:'block-end',index:1,block:{type:'text',text:'```json\n'+json+'\n```'}};
    yield {type:'finish',reason:{kind:'completed'}};
  }});
  const prepared=await f.make().prepare(f.input,f.ctx);assert.equal(prepared.operations.length,1);assert.deepEqual(prepared.usage,{});
});

test('invalid source references, types, attribution and targets never reach P02 writes',async t=>{
  for(const output of [response([item({source_refs:['invented']})]),response([item({type:'invented'})]),
    response([item({evidence_basis:'inferred',inferred_by_ref:'p1'})]),
    response([item({source_refs:['s2']})]),response([item({evidence_basis:'reported',source_refs:['s2'],speaker_ref:'p2'})]),
    response([], [{action:'update',target_ref:'/arbitrary/path',proposed:item()}])]){
    const f=await fixture(t,{output});await assert.rejects(f.make().prepare(f.input,f.ctx));assert.equal(f.counts().commits,0);
  }
});

test('assistant suggestion and model inference preserve assistant attribution without inventing user agreement',async t=>{
  const suggestion=item({type:'reflection',content:'助手建议按主题整理，用户尚未确认。',subject_ref:null,source_refs:['s2'],
    evidence_basis:'reported',speaker_ref:'p2',viewpoint_holder_ref:'p2',importance:null});
  const inferred=item({content:'助手推测用户可能需要更多书架空间，尚未证实。',evidence_basis:'inferred',inferred_by_ref:'p2',state:{validity:'unverified',progress:null}});
  const f=await fixture(t,{output:response([suggestion,inferred])}),o=f.make(),prepared=await o.prepare(f.input,f.ctx);
  const result=await o.commit(prepared,f.ctx),saved=await f.service.read(result.results[0].id,f.ctx);
  assert.equal(saved.subject_ref,null);assert.equal(saved.speaker_ref,'assistant');assert.equal(saved.viewpoint_holder_ref,'assistant');
  assert.equal((await f.service.read(result.results[1].id,f.ctx)).inferred_by_ref,'assistant');
});

test('reference budget bounds existing bodies, and model paths or override permissions are discarded',async t=>{
  const f=await fixture(t,{output:response([item({path:'/unsafe',operationId:'model-owned',allowReplacement:true})])});
  await f.service.commit({operationId:'seed',proposed:item(),sources:new Map([['s1',sources[0]]]),subjects:new Map([['p1',scope.ownerSubject]])},f.ctx);
  f.ctx.referenceTokens=20;const prepared=await f.make().prepare(f.input,f.ctx);
  assert.ok(prepared.referenceTokens<=20);assert.deepEqual(JSON.parse(f.calls[0].messages[0].content[0].text).existing,[]);
  assert.equal('path' in prepared.operations[0].proposed,false);assert.equal('allowReplacement' in prepared.operations[0].proposed,false);
  assert.equal(prepared.operations[0].operationId,'batch-one:1');
});

test('zero reference budget skips entry listing without exceeding its budget',async t=>{
  const f=await fixture(t);let reads=0;
  const entries={forBatch(...args){const service=f.entries.forBatch(...args);return {...service,async list(){reads++;throw Error('must not list');}};}};
  const o=createMemoryOrganizer({entries,llm:f.llm});f.ctx.referenceTokens=0;
  const prepared=await o.prepare(f.input,f.ctx);assert.equal(prepared.referenceTokens,0);assert.equal(reads,0);
});

test('authorized existing third-party subjects remain numbered instead of becoming the user',async t=>{
  const f=await fixture(t,{output:response([], [{action:'update',target_ref:'e1',proposed:item({subject_ref:'p3',evidence_basis:'reported',speaker_ref:'p1'})}])});
  const seed=await f.service.commit({operationId:'seed',proposed:item({subject_ref:'p3',evidence_basis:'reported'}),
    sources:new Map([['s1',sources[0]]]),subjects:new Map([['p1',scope.ownerSubject],['p3','虚构第三方']])},f.ctx);
  const o=f.make(),prepared=await o.prepare(f.input,f.ctx);
  const prompt=JSON.parse(f.calls[0].messages[0].content[0].text);assert.equal(prompt.existing[0].subject_ref,'p3');
  assert.deepEqual(prepared.subjects.find(([name])=>name==='p3'),['p3','虚构第三方']);
  const result=await o.commit(prepared,f.ctx);assert.equal(result.applied,1);assert.equal((await f.service.read(seed.id,f.ctx)).subject_ref,'虚构第三方');
});

test('existing semantic and importance changes persist as review and never overwrite a manual body',async t=>{
  const f=await fixture(t,{output:response([], [{action:'correct',target_ref:'e1',proposed:item({content:'模型提出另一种计划',importance:{level:'low',basis:'contextual',reason:'模型判断'}})}])});
  const seed=await f.service.commit({operationId:'seed',proposed:item(),sources:new Map([['s1',sources[0]]]),subjects:new Map([['p1',scope.ownerSubject]])},f.ctx);
  const note=f.memory.notes.get(seed.permalink);note.content=note.content.replace(item().content,'人工正文：仍保留原计划。');note.checksum='human-revision';
  const o=f.make(),prepared=await o.prepare(f.input,f.ctx);assert.equal(prepared.operations[0].target.revision,'human-revision');
  const result=await o.commit(prepared,f.ctx);assert.equal(result.reviews,1);assert.equal(result.results[0].reason,'content-or-importance-conflict');
  assert.ok(note.content.includes('人工正文'));assert.equal(f.service.reviews(f.ctx).length,1);
  const again=await o.commit(prepared,f.ctx);assert.equal(again.reviews,1);assert.equal(f.counts().generated,1);
});

test('state-only change preserves importance and P02 records history; stale revision becomes review',async t=>{
  for(const stale of [false,true]){
    const f=await fixture(t,{output:response([], [{action:'set_state',target_ref:'e1',proposed:item({state:{validity:null,progress:'completed'},importance:null})}])});
    const seed=await f.service.commit({operationId:'seed',proposed:item(),sources:new Map([['s1',sources[0]]]),subjects:new Map([['p1',scope.ownerSubject]])},f.ctx);
    const o=f.make(),prepared=await o.prepare(f.input,f.ctx);
    if(stale){const note=f.memory.notes.get(seed.permalink);note.content+='\n新人工批注';note.checksum='later';}
    const result=await o.commit(prepared,f.ctx);assert.equal(result.reviews,stale?1:0);
    const current=await f.service.read(seed.id,f.ctx);assert.equal(current.state.progress,stale?'planned':'completed');assert.equal(current.importance.level,'high');
  }
});

test('durable prepared plan resumes after lost write acknowledgement, with no second generation or duplicate note',async t=>{
  let writes=0;
  const f=await fixture(t,{output:response([item(),item({type:'event',content:'另一条独立事件。'})]),backend:backend=>({...backend,async write(...args){
    const value=await backend.write(...args);
    if(args[0]?.directory!=='chats/topics'){writes++;if(writes===2)throw Error('lost acknowledgement');}
    return value;
  }})});
  const prepared=await f.make().prepare(f.input,f.ctx),durable=JSON.parse(JSON.stringify(prepared));
  await assert.rejects(f.make().commit(durable,f.ctx),/lost acknowledgement/);
  assert.equal(notesIn(f.memory,'memory/entries').length,2);assertTopicPage(f.memory);
  const recovered=await f.make().commit(durable,f.ctx);assert.equal(recovered.applied,2);assert.equal(recovered.results[0].duplicate,true);assert.equal(recovered.results[1].recovered,true);
  await f.make().commit(durable,f.ctx);assert.equal(writes,2);assert.equal(notesIn(f.memory,'memory/entries').length,2);assertTopicPage(f.memory);assert.equal(f.counts().generated,1);
});

test('cancellation before generation, during stream and before commit prevents further work',async t=>{
  const before=await fixture(t);before.controller.abort();await assert.rejects(before.make().prepare(before.input,before.ctx),{name:'AbortError'});assert.equal(before.counts().generated,0);
  let abort;
  const during=await fixture(t,{chunks:async function*(){yield {type:'usage',usage:{inputTokens:5}};abort();yield {type:'text-delta',text:'{}'};}});
  abort=()=>during.controller.abort();await assert.rejects(during.make().prepare(during.input,during.ctx),{name:'AbortError'});
  assert.equal(during.receipts[0].outcome,'cancelled');assert.equal(during.receipts[0].usage.input_tokens,5);
  const commit=await fixture(t),prepared=await commit.make().prepare(commit.input,commit.ctx);commit.controller.abort();
  await assert.rejects(commit.make().commit(prepared,commit.ctx),{name:'AbortError'});assert.equal(commit.counts().commits,0);
});

test('cancellation releases a pending stream read even if the host ignores the signal',async t=>{
  let entered,release;
  const started=new Promise(resolve=>{entered=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{chunks:async function*(){entered();await pending;yield {type:'text-delta',text:'{}'};}});
  const work=f.make().prepare(f.input,f.ctx);await started;f.controller.abort();
  try{await assert.rejects(work,{name:'AbortError'});assert.equal(f.counts().commits,0);assert.equal(f.receipts[0].outcome,'cancelled');}
  finally{release();}
});

test('cancellation between commits resumes remaining operations with stable IDs and no regeneration',async t=>{
  const f=await fixture(t,{output:response([item(),item({type:'event',content:'第二条独立事件。'})])});
  const entries={forBatch(...args){const service=f.entries.forBatch(...args);return {...service,async commit(input){
    const result=await service.commit(input);f.controller.abort();return result;
  }};}};
  const o=createMemoryOrganizer({entries,llm:f.llm}),prepared=await o.prepare(f.input,f.ctx);
  await assert.rejects(o.commit(prepared,f.ctx),{name:'AbortError'});
  assert.equal(notesIn(f.memory,'memory/entries').length,1);assertTopicPage(f.memory);
  const resumed={...f.ctx,signal:new AbortController().signal};
  const result=await f.make().commit(JSON.parse(JSON.stringify(prepared)),resumed);
  assert.equal(result.applied,2);assert.equal(result.results[0].duplicate,true);assert.equal(notesIn(f.memory,'memory/entries').length,2);assertTopicPage(f.memory);assert.equal(f.counts().generated,1);
});

test('revocation, changed durable source revision and wrong batch context block recovered submission',async t=>{
  const f=await fixture(t),prepared=await f.make().prepare(f.input,f.ctx);
  await assert.rejects(f.make().commit(prepared,{...f.ctx,batchId:'other-batch'}),{code:'INVALID_PREPARED_MEMORY'});
  f.originals.set(sources[0].id,{...f.originals.get(sources[0].id),revision:2});
  await assert.rejects(f.make().commit(prepared,f.ctx));assert.equal(f.counts().commits,0);
  f.revoke();await assert.rejects(f.make().commit(prepared,f.ctx),{code:'MEMORY_NOT_AUTHORIZED'});
});

test('all prepared entries are validated before any write, including after JSON recovery',async t=>{
  const f=await fixture(t,{output:response([item(),item()])}),o=f.make(),prepared=await o.prepare(f.input,f.ctx);
  prepared.operations[1].proposed.source_refs=['unknown'];await assert.rejects(o.commit(prepared,f.ctx));assert.equal(f.counts().commits,0);
});

test('reference loader preserves relevance order, rereads current bodies and never uses the fallback list',async t=>{
  const f=await fixture(t,{output:response()});
  const seed=async(operationId,content)=>f.service.commit({operationId,proposed:item({content}),sources:new Map([['s1',sources[0]]]),subjects:new Map([['p1',scope.ownerSubject]])},f.ctx);
  const first=await seed('unrelated','不相关的旧计划。'),second=await seed('relevant','相关的旧计划。');
  const note=f.memory.notes.get(second.permalink);note.content=note.content.replace('\n相关的旧计划。\n','\n人工刚更新的相关计划。\n');note.checksum='human-current';
  const readIds=[];let loads=0;
  const entries={forBatch(...args){const service=f.entries.forBatch(...args);return {...service,
    list(){throw Error('selector must bypass fallback');},async read(id){readIds.push(id);return service.read(id);}};}};
  const o=f.make({entries,async loadReferences(input,ctx){loads++;assert.equal(input,f.input);assert.equal(ctx,f.ctx);
    return [{id:second.id,content:'不可信的过期搜索正文'},second.id,first.id];}});
  const prepared=await o.prepare(f.input,f.ctx),prompt=JSON.parse(f.calls[0].messages[0].content[0].text);
  assert.equal(loads,1);assert.deepEqual(readIds,[second.id,first.id]);assert.equal(prepared.referenceReads,2);
  assert.deepEqual(prompt.existing.map(e=>e.content),['人工刚更新的相关计划。','不相关的旧计划。']);
  assert.deepEqual(prompt.existing.map(e=>e.ref),['e1','e2']);assert.equal(f.counts().generated,1);
});

test('loader is read-bounded, skips stale pins and does not replace empty or failed selection with fallback',async t=>{
  const f=await fixture(t,{output:response()});let reads=0,lists=0;
  const entries={forBatch(){return {async read(id){reads++;return {id,revision:'current',content:'旧计划',type:'plan',subject_ref:scope.ownerSubject,state:{validity:'current',progress:'planned'},tags:[],importance:null};},
    async list(){lists++;throw Error('unexpected fallback');}};}};
  const prepared=await f.make({entries,referenceReadLimit:2,loadReferences:async()=>[{id:'old',revision:'stale'},'second','third']}).prepare(f.input,f.ctx);
  assert.equal(reads,2);assert.equal(prepared.referenceReads,2);assert.equal(lists,0);
  assert.equal(JSON.parse(f.calls[0].messages[0].content[0].text).existing.length,1);
  const empty=await f.make({entries,loadReferences:async()=>[]}).prepare(f.input,f.ctx);
  assert.equal(empty.referenceReads,0);assert.equal(reads,2);assert.equal(lists,0);
  const generationCount=f.counts().generated,loadError=Error('selector failed');
  await assert.rejects(f.make({entries,loadReferences:async()=>{throw loadError;}}).prepare(f.input,f.ctx),error=>error===loadError);
  await assert.rejects(f.make({entries,loadReferences:async()=>({})}).prepare(f.input,f.ctx),{code:'INVALID_MEMORY_REFERENCES'});
  assert.equal(f.counts().generated,generationCount);assert.equal(lists,0);
});

test('fallback reads single P02 bodies up to its allowance instead of listing one hundred notes',async t=>{
  let bodyReads=0;
  const f=await fixture(t,{output:response(),backend:backend=>({...backend,async read(...args){bodyReads++;return backend.read(...args);}})});
  for(let index=0;index<12;index++)await f.service.commit({operationId:`seed-${index}`,proposed:item({content:`旧计划${index}`}),
    sources:new Map([['s1',sources[0]]]),subjects:new Map([['p1',scope.ownerSubject]])},f.ctx);
  bodyReads=0;f.ctx.referenceTokens=16384;const pages=[];
  const entries={forBatch(...args){const service=f.entries.forBatch(...args);return {...service,async list(filters){pages.push(filters);return service.list(filters);}};}};
  const prepared=await f.make({entries}).prepare(f.input,f.ctx);
  assert.equal(bodyReads,8);assert.equal(prepared.referenceReads,8);assert.equal(pages.length,8);
  assert.ok(pages.every(page=>page.limit===1&&page.includeUnavailable===true));
  assert.ok(pages.slice(1).every(page=>typeof page.afterId==='string'));
});

test('reference budget exhaustion stops fetching bodies, and zero budget skips the loader',async t=>{
  const f=await fixture(t,{output:response()});let lists=0,reads=0,loads=0;
  const candidate={id:'too-large',revision:'v1',content:'长正文'.repeat(2000),type:'fact',subject_ref:scope.ownerSubject,state:{validity:'current',progress:null},tags:[],importance:null};
  const entries={forBatch(){return {async list(){lists++;return {entries:[candidate],scanned:1,nextAfter:'too-large'};},async read(){reads++;return candidate;}};}};
  f.ctx.referenceTokens=20;
  const fallback=await f.make({entries}).prepare(f.input,f.ctx);assert.equal(lists,1);assert.equal(fallback.referenceTokens,0);assert.equal(fallback.referenceReads,1);
  const loadReferences=async()=>{loads++;return ['one','two','three'];};
  const selected=await f.make({entries,loadReferences}).prepare(f.input,f.ctx);assert.equal(reads,1);assert.equal(loads,1);assert.equal(selected.referenceTokens,0);
  f.ctx.referenceTokens=0;
  await f.make({entries,loadReferences}).prepare(f.input,f.ctx);assert.equal(reads,1);assert.equal(loads,1);assert.equal(lists,1);
});

test('fallback charges internal P02 scans and does not read another page after overscan',async t=>{
  const f=await fixture(t,{output:response()});let lists=0;
  const entries={forBatch(){return {async list(){lists++;return {entries:[],scanned:100,nextAfter:'after-broken-notes'};}};}};
  const prepared=await f.make({entries}).prepare(f.input,f.ctx);
  assert.equal(lists,1);assert.equal(prepared.referenceReads,100);assert.equal(prepared.referenceTokens,0);
});

test('onUsage failure cannot discard successful prepared output or cause a second generation on commit',async t=>{
  for(const asynchronous of [false,true]){
    const f=await fixture(t),callback=receipt=>{receipt.usage.total_tokens=999;
      if(asynchronous)return Promise.reject(Error('statistics unavailable'));
      throw Error('statistics unavailable');
    };
    const o=f.make({onUsage:callback}),prepared=await o.prepare(f.input,f.ctx);
    assert.equal(prepared.usageReportFailed,true);assert.equal(prepared.usage.total_tokens,100);
    const durable=JSON.parse(JSON.stringify(prepared));
    await o.commit(durable,f.ctx);await o.commit(durable,f.ctx);
    assert.equal(f.counts().generated,1);assert.equal(notesIn(f.memory,'memory/entries').length,1);assertTopicPage(f.memory);
  }
});

test('onUsage failure never replaces a generation or parsing error and preserves its receipt',async t=>{
  const generationError=Object.assign(Error('original host failure'),{code:'HOST_GENERATION_FAILED'});
  const f=await fixture(t,{chunks:async function*(){yield {type:'usage',usage:{inputTokens:7}};throw generationError;},onUsage(){throw Error('statistics failure');}});
  await assert.rejects(f.make().prepare(f.input,f.ctx),error=>{
    assert.equal(error,generationError);assert.equal(error.usage.input_tokens,7);assert.equal(error.usageReportFailed,true);return true;
  });
  const invalid=await fixture(t,{output:'{',onUsage:async()=>{throw Error('statistics failure');}});
  await assert.rejects(invalid.make().prepare(invalid.input,invalid.ctx),error=>{
    assert.equal(error.code,'MEMORY_OUTPUT_INVALID');assert.equal(error.usage.total_tokens,100);assert.equal(error.usageReportFailed,true);return true;
  });
  assert.equal(f.counts().generated,1);assert.equal(invalid.counts().generated,1);
});

test('organizer uses its independent output budget',()=>{
  assert.equal(ORGANIZER_MAX_TOKENS,32768);
});

test('organizer has its own generation timeout',async()=>{
  const {ORGANIZER_TIMEOUT_MS}=await import('../lib/memory-organizer.js');
  assert.equal(ORGANIZER_TIMEOUT_MS,600000);
});

test('unsupported reasoning effort retries once without effort and is remembered per model',async t=>{
  const f=await fixture(t),calls=[];
  f.llm.stream=async function*(options){
    calls.push(options);
    if(calls.length===1)throw Object.assign(Error('unsupported effort'),{code:'UNSUPPORTED_REASONING_EFFORT'});
    const json=JSON.stringify(response());
    yield {type:'text-delta',index:0,text:json};
    yield {type:'finish',reason:{kind:'stop'}};
  };
  const organizer=f.make({config:{organizerReasoningEffort:'low'}});
  await organizer.prepare(f.input,f.ctx);
  await organizer.prepare(f.input,f.ctx);
  assert.equal(calls.length,3);
  assert.equal(calls[0].reasoningEffort,'low');
  assert.equal('reasoningEffort' in calls[1],false);
  assert.equal('reasoningEffort' in calls[2],false);
});

test('other organizer generation errors are not retried',async t=>{
  const f=await fixture(t),failure=Object.assign(Error('generation failed'),{code:'HOST_GENERATION_FAILED'});
  let calls=0;
  f.llm.stream=async function*(){calls++;throw failure;};
  await assert.rejects(f.make({config:{organizerReasoningEffort:'low'}}).prepare(f.input,f.ctx),error=>error===failure);
  assert.equal(calls,1);
});

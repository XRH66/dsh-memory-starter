import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {zstdCompressSync} from 'node:zlib';
import {Context} from '@deepseek-ai/cordis';
import {SessionStore} from '@deepseek-ai/dsh-session';
import {sessionFormatCatalog} from '@deepseek-ai/dsh-session-format-catalog';
import {RawMemoryStore,buildTurn} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {resolveConfig} from '../lib/config.js';
import {readSessionHistory,completedHistoryTurns,previewHistory,applyHistory,historyMode} from '../lib/raw-rag/history.js';
import {syncFactualPriorities} from '../lib/raw-rag/fact-priority.js';
import {embeddingContract,seedTurnVectors} from './embedding-fixture.js';

async function temp(t){
  const base=path.resolve(os.tmpdir()),dir=await fs.mkdtemp(path.join(base,'raw-history-test-'));
  t.after(async()=>{assert.equal(path.dirname(dir),base);assert(path.basename(dir).startsWith('raw-history-test-'));await fs.rm(dir,{recursive:true,force:true});});
  return dir;
}
function embedding(modelKey='fixture:m1'){
  return {...embeddingContract(modelKey,2),calls:0,async embed(texts){this.calls+=texts.length;return texts.map(s=>String(s).includes('老物件')?[1,0]:[0,1]);},dispose(){}};
}
function config(dir){return resolveConfig({vaultPath:path.join(dir,'vault'),rawRecall:true,rawRecallTimeoutMs:10000,rawRecallMinScore:0.8});}
async function archive(store,embedder,input){
  const turn=buildTurn(input);store.archiveTurn(turn);
  await seedTurnVectors(store,embedder,turn,text=>text.includes('老物件')?[1,0]:[0,1]);
  return turn;
}

test('formal search reaches the oldest tail beyond 2000 windows, with scope and time intact',async t=>{
  const dir=await temp(t),store=new RawMemoryStore(path.join(dir,'raw.sqlite')),embedder=embedding();
  const old=await archive(store,embedder,{scope:'owner:a',sessionId:'session-fixture-old',turn:0,completedAt:1,messages:[{id:'old-user',role:'user',text:'普通句子。'.repeat(400)+'老物件放在高柜顶层。'}]});
  for(let i=1;i<=2100;i++)await archive(store,embedder,{scope:'owner:a',sessionId:'session-fixture-noise',turn:i,completedAt:i+1,messages:[{id:'noise-'+i,role:'user',text:'今天讨论普通天气。'}]});
  await archive(store,embedder,{scope:'owner:b',sessionId:'session-fixture-other',turn:1,completedAt:1,messages:[{id:'foreign',role:'user',text:'老物件属于别人。'}]});
  await archive(store,embedder,{scope:'owner:a',sessionId:'session-fixture-future',turn:1,completedAt:99999,messages:[{id:'future',role:'user',text:'老物件未来才搬走。'}]});
  const recall=createRawRecall({config:config(dir),store,embedder,ownerSubject:'owner:a'});
  const result=await recall.retrieve({query:'老物件在哪里',asOf:5000});
  assert.equal(result.partial,false);assert(result.scannedWindows>2100);
  assert.deepEqual(result.turns.map(x=>x.turnId),[old.turnId]);
  assert.match(result.turns[0].messages[0].text,/高柜顶层/);
  await recall.dispose();
});

test('exclusion survives restart, reimport and model switch without embedding excluded sources',async t=>{
  const dir=await temp(t),file=path.join(dir,'raw.sqlite');let store=new RawMemoryStore(file);
  const input={scope:'owner:a',sessionId:'session-fixture-excluded',turn:1,completedAt:1,messages:[{id:'excluded-message',role:'user',text:'老物件放这里。'}]};
  store.setControl({scope:'owner:a',targetType:'session',targetId:input.sessionId,excluded:true});
  store.archiveTurn(buildTurn(input));assert.equal(store.pendingWindows('m1',{scope:'owner:a'}).length,0);store.close();
  store=new RawMemoryStore(file);store.archiveTurn(buildTurn({...input,messages:[{...input.messages[0],text:'老物件改了位置。'}]}));
  const embedder=embedding('fixture:m2'),recall=createRawRecall({config:config(dir),store,embedder,ownerSubject:'owner:a'});
  assert.equal((await recall.indexPending()).embedded,0);
  assert.equal((await recall.retrieve({query:'老物件',asOf:10})).turns.length,0);
  assert.throws(()=>store.setControl({scope:'owner:b',targetType:'message',targetId:'excluded-message',excluded:true}),/scope mismatch/);
  await recall.dispose();
});

test('fact softening follows verified message IDs across restart and model identities',async t=>{
  const dir=await temp(t),vault=path.join(dir,'vault'),facts=path.join(vault,'chats','facts');await fs.mkdir(facts,{recursive:true});
  const note=metadata=>'---\n'+Object.entries(metadata).map(([key,value])=>key+': '+(typeof value==='string'?JSON.stringify(value):value)).join('\n')+'\n---\n\n老物件。\n';
  await fs.writeFile(path.join(facts,'softened.md'),note({title:'老物件',memory_id:'memory-fixture',memory_kind:'fact',soften_count:2,soften_factor:0.5,sources:JSON.stringify([{message_id:'linked-message'}])}));
  await fs.writeFile(path.join(facts,'untouched.md'),note({title:'新物件',memory_id:'memory-plain',memory_kind:'fact',sources:JSON.stringify([{message_id:'linked-reply'}])}));
  const file=path.join(dir,'raw.sqlite');let store=new RawMemoryStore(file);
  const input={scope:'owner:a',sessionId:'session-fixture-linked',turn:1,completedAt:1,messages:[{id:'linked-message',role:'user',text:'老物件。'},{id:'linked-reply',role:'assistant',text:'老物件。'}]};
  await archive(store,embedding(),input);assert.equal(syncFactualPriorities(store,{vaultPath:vault,scope:'owner:a'}).sources,1);store.close();
  store=new RawMemoryStore(file);const recall=createRawRecall({config:{...config(dir),rawRecallMinScore:0.1},store,embedder:embedding('fixture:m2'),ownerSubject:'owner:a'});
  await recall.indexPending();const r=await recall.retrieve({query:'老物件',asOf:10});assert.equal(r.turns[0].score,0.25);
  await recall.dispose();
});

async function nativeFixture(home,id,texts,{interrupted=false}={}){
  const ctx=new Context(),sessions=new SessionStore(ctx),s=sessions.prepare(id,{meta:{delegationDepth:0}}),leave=sessions.enter(s);
  for(let i=0;i<texts.length;i++){
    const turn=i+1,step=1;s.append('turn/start',{turn});s.append('step/start',{turn,step});
    s.append('user/message',{id:id+'-u'+turn,role:'user',source:{kind:'user'},content:[{type:'text',text:texts[i]}]},{surfaceOp:'append'});
    s.append('user/message',{id:id+'-context'+turn,role:'user',source:{kind:'basic-memory-context',form:'recall'},content:[{type:'text',text:'不能归档的注入材料。'}]},{surfaceOp:'append'});
    s.append('assistant/message',{turn,step,stream:[],message:{id:id+'-a'+turn,role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'收到。'}]}},{surfaceOp:'append'});
    s.append('step/end',{turn,step});s.append('turn/end',{turn,reason:interrupted?{kind:'aborted',reason:{kind:'user'}}:{kind:'completed'}});
  }
  const header=s.header,events=s.log.map(e=>structuredClone(e));leave();
  const file=path.join(home,'sessions','--fixture--',id,'session.v4.jsonl.zstd');await fs.mkdir(path.dirname(file),{recursive:true});
  const write=async updated=>{
    const lines=[sessionFormatCatalog.encodeCurrentHeader(header,0),...updated.map(e=>sessionFormatCatalog.encodeCurrentEvent(e))].map(x=>JSON.stringify(x)+'\n');
    await fs.writeFile(file,Buffer.concat([zstdCompressSync(Buffer.from(lines[0])),...lines.slice(1).map(s=>zstdCompressSync(Buffer.from(s)))]));
  };
  await write(events);return {file,events,write};
}

test('native multi-frame history excludes injected context and aborted turns',async t=>{
  const dir=await temp(t),f=await nativeFixture(dir,'session-fixture-frames',['第一轮。','第二轮老物件。']);
  const read=await readSessionHistory(f.file),parsed=completedHistoryTurns(read.artifact,'owner:a');
  assert.equal(parsed.turns.length,2);assert(parsed.turns[1].docText.includes('第二轮老物件'));
  assert(!parsed.turns.some(x=>x.docText.includes('注入材料')));
  const abort=await nativeFixture(dir,'session-fixture-abort',['没完成。'],{interrupted:true});
  assert.equal(completedHistoryTurns((await readSessionHistory(abort.file)).artifact,'owner:a').turns.length,0);
  assert.equal(historyMode({enabled:false},true),'legacy-mode-unconfirmed');
  assert.equal(historyMode({enabled:false,historyUserOnly:true},true),'pure-or-mixed-history');
  assert.equal(historyMode(undefined,false),'default-mode-unconfirmed');
  const routed=await nativeFixture(dir,'session-fixture-relay',['[SessionRelay Task: fixture-job] Delivery ID: fixture-delivery\n执行工程任务。']);
  assert.equal(completedHistoryTurns((await readSessionHistory(routed.file)).artifact,'owner:a').turns.length,0);
});

test('import resumes missing vectors, preserves user-only policy, edits only changed turns, and stays idempotent',async t=>{
  const dir=await temp(t),home=path.join(dir,'home'),owner=path.join(dir,'owner');await fs.mkdir(owner,{recursive:true});
  const id='session-fixture-import',f=await nativeFixture(home,id,['第一轮老物件。','第二轮。','第三轮。']);
  const deployment=path.join(dir,'deployment.json');await fs.writeFile(deployment,JSON.stringify({ownerDirectory:owner,ownerSubject:'owner:a',dshHome:home,dshSessionIds:[id],memory:{rawRecall:true}}));
  const plan=await previewHistory(deployment,{normalDefaultConfirmed:true});assert.equal(plan.summary.turns,3);
  const store=new RawMemoryStore(path.join(dir,'raw.sqlite')),embedder=embedding(),recall=createRawRecall({config:config(dir),store,embedder,ownerSubject:'owner:a'});
  const native=completedHistoryTurns((await readSessionHistory(f.file)).artifact,'owner:a').turns;
  store.archiveTurn(buildTurn({...native[0],messages:native[0].messages.filter(m=>m.role==='user')}));
  const first=await applyHistory(plan,{store,recall,maxTurns:1,batchSize:2});assert.equal(first.complete,false);
  store.db.exec('DELETE FROM vectors');
  const second=await applyHistory(plan,{store,recall,batchSize:2});assert.equal(second.complete,true);
  assert.equal(store.stats(embedder.modelKey,'owner:a').turns,3);assert.equal(store.stats(embedder.modelKey,'owner:a').vectors,3);
  assert.deepEqual(store.storedTurn('owner:a',native[0].turnId).map(m=>m.role),['user']);
  const calls=embedder.calls;await applyHistory(plan,{store,recall});assert.equal(embedder.calls,calls);
  const edited=structuredClone(f.events);edited.find(e=>e.type==='user/message'&&e.data.id===id+'-u2').data.content[0].text='第二轮改过。';await f.write(edited);
  const changed=await previewHistory(deployment,{normalDefaultConfirmed:true}),before=embedder.calls;
  const third=await applyHistory(changed,{store,recall});assert.equal(third.updated,1);assert.equal(embedder.calls,before+1);
  assert.match(store.storedTurn('owner:a',native[1].turnId)[0].text,/改过/);
  await fs.writeFile(deployment,JSON.stringify({ownerDirectory:owner,ownerSubject:'owner:a',dshHome:home,dshSessionIds:[],memory:{rawRecall:true}}));
  await assert.rejects(applyHistory(changed,{store,recall}),/no-longer-authorized/);
  await recall.dispose();
});

test('pure and legacy sessions are absent from the reviewed import plan',async t=>{
  const dir=await temp(t),home=path.join(dir,'home');await nativeFixture(home,'session-fixture-private',['私密细节。']);
  await fs.mkdir(path.join(home,'storages'),{recursive:true});await fs.writeFile(path.join(home,'storages','pure_mode.json'),JSON.stringify({unit:{name:'pure_mode',version:1},tables:{sessions:{'session-fixture-private':{enabled:false,historyUserOnly:true}}}}));
  const deployment=path.join(dir,'deployment.json');await fs.writeFile(deployment,JSON.stringify({ownerDirectory:path.join(dir,'owner'),ownerSubject:'owner:a',dshHome:home,dshSessionIds:['session-fixture-private'],memory:{rawRecall:true}}));
  const plan=await previewHistory(deployment,{normalDefaultConfirmed:true});assert.equal(plan.summary.turns,0);assert.equal(plan.sources[0].reason,'pure-or-mixed-history');
});

test('switching mode after preview aborts import before any history is written',async t=>{
  const dir=await temp(t),home=path.join(dir,'home'),id='session-fixture-mode-change';
  await nativeFixture(home,id,['老物件。']);
  const file=path.join(dir,'deployment.json');await fs.writeFile(file,JSON.stringify({ownerDirectory:dir,ownerSubject:'owner:a',dshHome:home,dshSessionIds:[id],memory:{rawRecall:true}}));
  const plan=await previewHistory(file,{normalDefaultConfirmed:true});
  await fs.mkdir(path.join(home,'storages'),{recursive:true});await fs.writeFile(path.join(home,'storages','pure_mode.json'),JSON.stringify({unit:{name:'pure_mode',version:1},tables:{sessions:{[id]:{enabled:true,historyUserOnly:true}}}}));
  const store=new RawMemoryStore(path.join(dir,'raw.sqlite')),embedder=embedding(),recall=createRawRecall({config:config(dir),store,embedder,ownerSubject:'owner:a'});
  await assert.rejects(applyHistory(plan,{store,recall}),/mode-policy-changed/);
  assert.equal(store.stats(embedder.modelKey,'owner:a').turns,0);assert.equal(embedder.calls,0);await recall.dispose();
});

test('cancelling a paged search discards quotes instead of returning a partial answer',async t=>{
  const dir=await temp(t),store=new RawMemoryStore(path.join(dir,'raw.sqlite')),embedder=embedding();
  for(let i=0;i<600;i++)await archive(store,embedder,{scope:'owner:a',sessionId:'session-fixture-cancel',turn:i,completedAt:1,messages:[{id:'cancel-'+i,role:'user',text:'老物件。'}]});
  const controller=new AbortController(),pages=store.windowPages.bind(store);let readPages=0;
  store.windowPages=function*(...args){for(const page of pages(...args)){if(++readPages===1)setImmediate(()=>controller.abort());yield page;}};
  const recall=createRawRecall({config:config(dir),store,embedder,ownerSubject:'owner:a'});
  const result=await recall.recall({query:'老物件',asOf:10,budget:600,signal:controller.signal});
  assert.equal(result.reason,'cancelled');assert.equal(result.text,'');assert(readPages>0&&readPages<3);await recall.dispose();
});

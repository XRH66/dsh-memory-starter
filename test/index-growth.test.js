import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, TARGET_SESSION, directUser, runPreStep, turnStart, userMessage, assistantMessage, turnEnd, toolVaultBackend } from './helpers.js';
import { resolveConfig } from '../lib/config.js';
import { maintainIndexes } from '../lib/maintenance.js';
import { memoryCall } from '../lib/navigation.js';
import { requestedIndexTopic } from '../lib/index-pages.js';
import { createRecoveryStore, mergePending } from '../lib/recovery.js';
import { createBridge } from '../lib/index.js';

const empty={assignments:[],creations:[],removals:[],headings:[],profile:[]};
const plan=(p)=>JSON.stringify({...empty,...p});
async function setup(count=3){
  const memory=memoryStore();
  const ctx={config:resolveConfig({}),tools:memory.tools,agent:fakeAgent(TARGET_SESSION),sessionId:TARGET_SESSION};
  const facts=[];
  for(let i=0;i<count;i++) facts.push(await memoryCall(ctx,'write_note',{
    title:'用户 - '+['摄影练习','摄影器材','摄影课程'][i],directory:'chats/facts',
    content:'<!-- dsh-fact-memory -->\n# 用户的摄影记录\n- [fact] '+['喜欢拍路边的树影','用一台轻便相机拍照','周末去学摄影'][i]+'\n',
    tags:['dsh-memory'],metadata:{memory_id:'f'+i,status:'active'},
  }));
  const overview=await memoryCall(ctx,'write_note',{title:'总览',directory:'index',tags:['index'],content:'# 总览\n\n我的手写说明。\n'});
  return {ctx,memory,facts,overview};
}
const change=(f)=>({action:'ADD',permalink:f.permalink,memoryId:f.memoryId});
const topicPlan=(facts)=>plan({creations:[{title:'摄影',facts:facts.map(f=>f.permalink)}]});

test('requires three distinct memories; new topic backfills older sources and enters overview',async()=>{
  const small=await setup(2);
  await maintainIndexes({...small.ctx,llm:fakeLlm(topicPlan(small.facts))},small.facts.map(change));
  assert.equal([...small.memory.notes.values()].filter(n=>n.directory==='index').length,1);
  const {ctx,memory,facts,overview}=await setup();
  // A single new memory can discover two older related memories.
  const result=await maintainIndexes({...ctx,llm:fakeLlm(topicPlan(facts))},[change(facts[2])]);
  assert.equal(result.created,1);
  const topic=memory.notes.get('personal/index/摄影');
  assert.equal((topic.content.match(/<!-- bm:/g)||[]).length,3);
  assert.match(topic.content,/创建日期: \d{4}-\d\d-\d\d/);
  assert.ok(topic.frontmatter.index_topic_key);assert.ok(topic.tags.includes('index'));
  assert.match(memory.notes.get(overview.permalink).content,/我的手写说明/);
  assert.match(memory.notes.get(overview.permalink).content,/\[\[index\/摄影\|摄影\]\]/);
});

test('full catalog includes topics past twenty; reuses existing title and preserves prose',async()=>{
  const {ctx,memory,facts}=await setup();
  for(let i=0;i<21;i++)await memoryCall(ctx,'write_note',{title:'已有主题'+i,directory:'index',tags:['index'],content:'# 已有主题'+i+'\n'});
  const existing=await memoryCall(ctx,'write_note',{title:'摄影',directory:'index',tags:['index'],content:'# 摄影\n\n不要改掉我这段话。\n'});
  const llm=fakeLlm((opts)=>{
    const data=JSON.parse(opts.messages[0].content[0].text);
    assert.ok(data.catalog.some(n=>n.permalink===existing.permalink));
    assert.ok(data.catalog.length>20);
    return topicPlan(facts);
  });
  const result=await maintainIndexes({...ctx,llm},[change(facts[0])]);
  assert.equal(result.created,0);
  assert.equal([...memory.notes.values()].filter(n=>n.title==='摄影').length,1);
  assert.match(memory.notes.get(existing.permalink).content,/不要改掉我这段话/);
});

test('reclassification verifies destination before removing old link; original facts stay intact',async()=>{
  const {ctx,memory,facts}=await setup();
  const source=await memoryCall(ctx,'write_note',{title:'饮食',directory:'index',tags:['index'],content:'# 饮食\n\n- [[用户 - 摄影练习]] —— 分类放错了\n\n手写段落留下。\n'});
  const dest=await memoryCall(ctx,'write_note',{title:'摄影',directory:'index',tags:['index'],content:'# 摄影\n'});
  const originals=facts.map(f=>structuredClone(memory.notes.get(f.permalink)));
  const removed=[];
  const tools={...ctx.tools,get vaultBackend(){return toolVaultBackend(this);},get(name,agent){const def=ctx.tools.get(name,agent);return {...def,async execute(args,exec){
    if(name.endsWith('__edit_note')&&args.identifier===source.permalink&&!args.content.includes('摄影练习')){
      assert.match(memory.notes.get(dest.permalink).content,/摄影练习/);removed.push(args.identifier);
    }
    return def.execute(args,exec);
  }};}};
  await maintainIndexes({...ctx,tools,llm:fakeLlm(plan({assignments:[{fact:facts[0].permalink,index:dest.permalink}],removals:[{fact:facts[0].permalink,index:source.permalink}]}))},[change(facts[0])]);
  assert.equal(removed.length,1);assert.match(memory.notes.get(source.permalink).content,/手写段落留下/);
  assert.deepEqual(facts.map(f=>memory.notes.get(f.permalink)),originals);
  // A removal without a destination never unlinks the original.
  await maintainIndexes({...ctx,llm:fakeLlm(plan({removals:[{fact:facts[0].permalink,index:dest.permalink}]}))},[change(facts[0])]);
  assert.match(memory.notes.get(dest.permalink).content,/摄影练习/);
});

test('persisted topic plan survives restart after overview failure without another model call',async(t)=>{
  const {ctx,memory,facts,overview}=await setup();
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-index-growth-'));
  const vault=path.join(root,'vault');await fs.mkdir(vault);
  const config=resolveConfig({vaultPath:vault});
  const store=createRecoveryStore(config);
  await store.update(s=>{mergePending(s,{...change(facts[0]),sessionId:TARGET_SESSION,turn:1});});
  let fail=true;
  const tools={...ctx.tools,get vaultBackend(){return toolVaultBackend(this);},get(name,agent){const def=ctx.tools.get(name,agent);return {...def,async execute(args,exec){
    if(fail&&name.endsWith('__edit_note')&&args.identifier===overview.permalink)throw new Error('overview temporarily unavailable');
    return def.execute(args,exec);
  }};}};
  const llm=fakeLlm(topicPlan(facts));
  let bridge=createBridge({config,tools,llm,findAgent:()=>ctx.agent});
  t.after(async()=>{await bridge.dispose();await bridge.getMemoryStatus(TARGET_SESSION);assert.ok(root.startsWith(path.join(os.tmpdir(),'dafeiyu-index-growth-')));await fs.rm(root,{recursive:true,force:true});});
  await bridge.retryPending({force:true});
  assert.ok((await bridge.getRecoveryState()).indexMaintenance.bundle);
  assert.ok(memory.notes.has('personal/index/摄影'));
  await bridge.dispose();fail=false;
  const noModel=fakeLlm(new Error('must resume saved plan'));
  bridge=createBridge({config,tools,llm:noModel,findAgent:()=>ctx.agent});
  await bridge.retryPending({force:true});
  const recovered=await bridge.getRecoveryState();
  assert.equal(recovered.pending.length,0);assert.equal(recovered.indexMaintenance,undefined);
  assert.equal(llm.calls.length,1);assert.equal(noModel.calls.length,0);
  assert.equal([...memory.notes.values()].filter(n=>n.title==='摄影').length,1);
  assert.match(memory.notes.get(overview.permalink).content,/摄影/);
});

test('a suspended platform plan resumes its saved partial edit after unrelated DSH work and restart',async(t)=>{
  const {ctx,memory,facts,overview}=await setup(),root=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-index-growth-'));
  const vault=path.join(root,'vault');await fs.mkdir(vault);const config=resolveConfig({vaultPath:vault}),externalSession='session-platform-maintenance';let platformAllowed=true,fail=true;
  const tools={...ctx.tools,get vaultBackend(){return toolVaultBackend(this);},get(name,agent){const def=ctx.tools.get(name,agent);return {...def,async execute(args,exec){if(fail&&name.endsWith('__edit_note')&&args.identifier===overview.permalink)throw new Error('overview temporarily unavailable');return def.execute(args,exec);}};}};
  const llm=fakeLlm(topicPlan(facts)),findAgent=id=>fakeAgent(id),maintenanceOwnerAllowed=id=>id===TARGET_SESSION||(id===externalSession&&platformAllowed);
  let store=createRecoveryStore(config),bridge=createBridge({config,tools,llm,findAgent,maintenanceOwnerAllowed,recoveryStore:store});
  t.after(async()=>{await bridge.dispose();assert.ok(root.startsWith(path.join(os.tmpdir(),'dafeiyu-index-growth-')));await fs.rm(root,{recursive:true,force:true});});
  await store.update(s=>mergePending(s,{...change(facts[0]),sessionId:externalSession,turn:1}));await bridge.retryPending({force:true});
  let state=await store.read();assert.ok(state.indexMaintenance.bundle);assert.ok(memory.notes.has('personal/index/摄影'));
  platformAllowed=false;fail=false;await store.update(s=>mergePending(s,{...change(facts[1]),sessionId:TARGET_SESSION,turn:2}));
  await bridge.retryPending({force:true});state=await store.read();assert.ok(state.suspendedIndexMaintenance?.[0]?.bundle);assert.ok(!state.pending.some(p=>p.owners.some(o=>o.sessionId===TARGET_SESSION)));assert.ok(state.pending.some(p=>p.owners.some(o=>o.sessionId===externalSession)));
  await bridge.dispose();platformAllowed=true;store=createRecoveryStore(config);const resumed=fakeLlm(new Error('saved platform plan must not call the model'));bridge=createBridge({config,tools,llm:resumed,findAgent,maintenanceOwnerAllowed,recoveryStore:store});
  await bridge.retryPending({force:true});state=await store.read();assert.equal(state.pending.length,0);assert.equal(state.suspendedIndexMaintenance,undefined);assert.equal(resumed.calls.length,0);assert.equal([...memory.notes.values()].filter(n=>n.title==='摄影').length,1);assert.match(memory.notes.get(overview.permalink).content,/摄影/);
});

test('lost create response reuses page; changed source invalidates saved plan',async()=>{
  const {ctx,memory,facts,overview}=await setup();let saved,fail=true;
  const tools={...ctx.tools,get vaultBackend(){return toolVaultBackend(this);},get(name,agent){const def=ctx.tools.get(name,agent);return {...def,async execute(args,exec){
    const result=await def.execute(args,exec);
    if(fail&&name.endsWith('__write_note')&&args.title==='摄影'){fail=false;throw new Error('lost response');}
    return result;
  }};}};
  const llm=fakeLlm(topicPlan(facts));
  await assert.rejects(maintainIndexes({...ctx,tools,llm,recovery:{save:b=>{saved=b;}}},[change(facts[0])]),/MEMORY_TOOL_FAILED/);
  const n=memory.notes.get(facts[0].permalink);n.content=n.content.replace('树影','倒影');n.checksum='manually-changed';
  await maintainIndexes({...ctx,tools,llm,recovery:{saved,save:b=>{saved=b;}}},[change(facts[0])]);
  assert.equal(llm.calls.length,2);assert.equal([...memory.notes.values()].filter(n=>n.title==='摄影').length,1);
  assert.match(memory.notes.get('personal/index/摄影').content,/倒影/);
  assert.match(memory.notes.get(overview.permalink).content,/摄影/);
});


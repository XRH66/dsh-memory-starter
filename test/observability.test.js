import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../lib/index.js';
import { createRecoveryStore, mergePending } from '../lib/recovery.js';
import { measuredLlm, normalizeUsage } from '../lib/usage.js';
import { resolveConfig } from '../lib/config.js';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, runPreStep, directUser, turnStart, userMessage, assistantMessage, turnEnd, TARGET_SESSION } from './helpers.js';

async function fixture(t, llm) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-observability-'));
  const config = resolveConfig({ vaultPath: path.join(root,'vault'), personalRecall: false, maxIndexNotes: 0 });
  await fs.mkdir(config.vaultPath);
  const memory = memoryStore();
  const agent = fakeAgent(TARGET_SESSION);
  const bridges = [];
  const make = () => { const b = createBridge({config, llm, tools:memory.tools, findAgent: () => agent}); bridges.push(b); return b; };
  t.after(async () => { for (const b of bridges) { await b.dispose(); await b.getMemoryStatus(TARGET_SESSION); } await fs.rm(root,{recursive:true,force:true}); });
  return {root,config,memory,agent,make,bridge:make()};
}
test('paused old maintenance batch does not starve a new topic, and is retained for manual retry', async t => {
  const llm=fakeLlm([new Error('bad'),new Error('bad'),new Error('bad'),'{"assignments":[],"headings":[],"profile":[],"creations":[],"removals":[]}']);
  const f=await fixture(t,llm);
  const store=createRecoveryStore(f.config);
  await store.update(s => {mergePending(s,{permalink:'index-request:old',requestedTopic:'旧主题',sessionId:TARGET_SESSION,turn:1});s.lastSessionId=TARGET_SESSION;});
  await f.bridge.retryPending({force:true}); await f.bridge.retryPending({force:true}); await f.bridge.retryPending({force:true});
  assert.equal(llm.calls.length,3);
  await f.bridge.dispose();
  const edit=createRecoveryStore(f.config);
  await edit.update(s => mergePending(s,{permalink:'index-request:new',requestedTopic:'新主题',sessionId:TARGET_SESSION,turn:2}));
  f.bridge=f.make(); await f.bridge.retryPending();
  assert.equal(llm.calls.length,4);
  const pending=(await f.bridge.getRecoveryState()).pending;
  assert.equal(pending.length,1); assert.equal(pending[0].requestedTopic,'旧主题'); assert.equal(pending[0].attempts,3);
});

test('usage uses the final cumulative receipt once, includes cache, and retains missing/failed attempts', async () => {
  const records=[];
  const model={async *stream(){yield {type:'usage',usage:{inputTokens:8,outputTokens:2,totalTokens:10}};
    yield {type:'usage',usage:{inputTokens:20,cacheReadTokens:80,outputTokens:30,totalTokens:130}};
    yield {type:'finish',reason:{kind:'max-tokens'}};}};
  for await (const _ of measuredLlm(model,r=>records.push(r),{phase:'capture',retry:true}).stream({provider:'test',model:'test'})) {}
  assert.equal(records.length,2); assert.equal(records[0].id,records[1].id);
  assert.deepEqual(records[1].usage,{input:100,output:30,total:130,cached:80,cacheWrite:null,uncached:20});
  assert.equal(records[1].retry,true);
  await assert.rejects(async()=>{for await(const _ of measuredLlm(fakeLlm(new Error('offline')),r=>records.push(r),{}).stream({})){}},/offline/);
  assert.equal(records.at(-1).state,'failed'); assert.equal(records.at(-1).usage,null);
  assert.equal(normalizeUsage(undefined),null);
});

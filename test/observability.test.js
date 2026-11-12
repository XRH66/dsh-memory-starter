import test from 'node:test';
import assert from 'node:assert/strict';
import { measuredLlm, normalizeUsage } from '../lib/usage.js';
import { fakeLlm } from './helpers.js';

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

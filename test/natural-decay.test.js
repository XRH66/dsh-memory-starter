import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { priorityFromMetadata, reinforcePriorityPatch, softenPriorityPatch, adjustedRelevance } from '../lib/priority.js';

const START = '2026-10-25T00:00:00.000Z';
const day = n => new Date(Date.parse(START) + n * 86400000);
const opts = n => ({naturalDecayStartedAt:START, now:day(n)});
const value = '晚上看书常喝温的荞麦茶，不加糖';

test('old notes start ageing at rollout; new notes use their later recording date; decay no longer excludes',()=>{
  const old={recorded_at:'2020-01-01T00:00:00Z'};
  assert.equal(priorityFromMetadata(old,opts(0)).effectivePriority,1);
  assert.equal(priorityFromMetadata(old,opts(30)).effectivePriority,.5);
  assert.equal(priorityFromMetadata({recorded_at:day(30).toISOString()},opts(30)).effectivePriority,1);
  assert.equal(priorityFromMetadata(old,opts(1000)).effectivePriority,.01);
  const aged=adjustedRelevance(1,old,{...opts(120),query:'我的习惯是什么',text:value});
  assert.equal(aged.eligible,true);assert.ok(aged.score<1);
  const cue=adjustedRelevance(1,old,{...opts(120),query:'那种荞麦茶还记得吗',text:value});
  assert.equal(cue.eligible,true);assert.equal(cue.strongCue,true);assert.equal(cue.score,1);
  assert.deepEqual(old,{recorded_at:'2020-01-01T00:00:00Z'});
});
test('reaffirmation restores at least 0.9 and doubles the half-life within cap, with a day cooldown',()=>{
  const p=reinforcePriorityPatch({},opts(30));
  assert.equal(p.base_priority,.9);assert.equal(p.half_life_days,60);assert.equal(p.reinforcement_count,1);
  assert.equal(reinforcePriorityPatch(p,opts(30)),null);
  assert.equal(reinforcePriorityPatch(p,opts(29)),null);
  assert.ok(priorityFromMetadata(p,opts(60)).effectivePriority > priorityFromMetadata({},opts(60)).effectivePriority);
  assert.equal(reinforcePriorityPatch({half_life_days:170},opts(30)).half_life_days,340);
  const softened=softenPriorityPatch(p,opts(60));
  assert.ok(softened.base_priority < priorityFromMetadata(p,opts(60)).effectivePriority);
  assert.equal(reinforcePriorityPatch(softened,opts(59)),null);
  assert.ok(reinforcePriorityPatch(softened,opts(90)).base_priority < 1);
});

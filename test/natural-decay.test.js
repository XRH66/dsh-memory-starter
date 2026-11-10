import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { priorityFromMetadata, reinforcePriorityPatch, softenPriorityPatch, adjustedRelevance } from '../lib/priority.js';
import { createBridge } from '../lib/index.js';
import { applyMemoryActions, softenMemory } from '../lib/memory.js';
import { resolveConfig } from '../lib/config.js';
import { updateIndexBody, AUTO_START, AUTO_END } from '../lib/index-pages.js';
import { memoryStore } from './fake-memory.js';
import { fakeAgent, fakeLlm, fakeTools, mcpResult, directUser, runPreStep, turnStart, userMessage, assistantMessage, turnEnd, TARGET_SESSION } from './helpers.js';

const START = '2026-10-25T00:00:00.000Z';
const day = n => new Date(Date.parse(START) + n * 86400000);
const opts = n => ({naturalDecayStartedAt:START, now:day(n)});
const value = '晚上看书常喝温的荞麦茶，不加糖';
const action = {action:'ADD',kind:'fact',category:'preference',subject:'用户',attribute:'晚上饮茶',value,evidence:value,occurredAt:'日期未明'};

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

test('index refresh preserves manual groups before and after the auto region',()=>{
  const note={title:'沟通偏好',permalink:'personal/chats/facts/style',content:'- [preference] 少用套话'};
  const manual='# 索引\n\n## 评价与回应\n- [[沟通偏好]] —— 旧内容\n\n## 其他\n保留这段\n';
  const updated=updateIndexBody(manual,{refresh:[note]});
  assert.match(updated,/## 评价与回应\n- \[\[沟通偏好\]\].*少用套话/);
  assert.ok(!updated.includes(AUTO_START));assert.ok(updated.endsWith('## 其他\n保留这段\n'));
  const withAuto='# 索引\n'+AUTO_START+'\n## 自动整理\n'+AUTO_END+'\n## 手工尾部\n- [[沟通偏好]] —— 旧内容\n';
  const after=updateIndexBody(withAuto,{refresh:[note]});
  assert.match(after,/## 手工尾部\n- \[\[沟通偏好\]\].*少用套话/);
  assert.equal((after.match(/少用套话/g)||[]).length,1);
});

test('duplicate ADD and factual correction reuse reinforcement; history keeps the old decay anchor',async()=>{
  const memory=memoryStore(),config={...resolveConfig({}),...opts(0)};
  const ctx={config,tools:memory.tools,agent:fakeAgent(TARGET_SESSION),project:'personal'};
  await applyMemoryActions(ctx,[action],{sessionId:TARGET_SESSION,turn:1,now:()=>day(0),sourceEventTime:+day(0)});
  const note=[...memory.notes.values()][0];
  const duplicate=await applyMemoryActions(ctx,[action],{sessionId:TARGET_SESSION,turn:2,now:()=>day(30),sourceEventTime:+day(30)});
  assert.equal(duplicate.results[0].metadataOnly,true);assert.equal(note.frontmatter.reinforcement_count,1);
  const currentBefore=priorityFromMetadata(note.frontmatter,opts(60)).effectivePriority;
  const update={...action,action:'CORRECT',targetMemoryId:note.frontmatter.memory_id,value:'其实是温的大麦茶，不加糖'};
  await applyMemoryActions(ctx,[update],{sessionId:TARGET_SESSION,turn:3,now:()=>day(60),sourceEventTime:+day(60)});
  assert.equal(note.frontmatter.reinforcement_count,2);
  assert.ok(priorityFromMetadata(note.frontmatter,opts(60)).effectivePriority>=currentBefore);
  assert.equal(note.frontmatter.recorded_at,START);
  const history=[...memory.notes.values()].find(n=>n.frontmatter.memory_kind==='history');
  assert.equal(priorityFromMetadata(history.frontmatter,opts(60)).effectivePriority,currentBefore);
  assert.equal(history.frontmatter.status,'revoked');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustedRelevance,
  priorityFromMetadata,
} from '../lib/priority.js';

const NOW = new Date('2026-10-24T04:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(NOW.getTime() - n * DAY).toISOString();

test('softened priority halves at the default half-life and never goes below the floor', () => {
  const metadata = { base_priority: 0.5, softened_at: '2026-09-24T04:00:00.000Z' };
  const atThirtyDays = priorityFromMetadata(metadata, { now: NOW });
  assert.equal(atThirtyDays.softened, true);
  assert.equal(atThirtyDays.effectivePriority, 0.25);

  const faint = priorityFromMetadata({ base_priority: 0.02, softened_at: '2025-01-01T00:00:00.000Z' }, { now: NOW });
  assert.equal(faint.effectivePriority, 0.01);
});

test('a date cue only bypasses decay when it matches the target record date', () => {
  const note = '# 2026-10-19 - 交付竹桥\n\n- [event] 交付完成';
  const mismatched = adjustedRelevance(1, {}, { now: NOW, query: '2026-10-18 的交付呢', text: note });
  const matched = adjustedRelevance(1, {}, { now: NOW, query: '2026-10-19 的交付呢', text: note });
  const monthDay = adjustedRelevance(1, {}, { now: NOW, query: '10月19日那次交付', text: note });
  assert.equal(mismatched.strongCue, false);
  assert.equal(matched.strongCue, true);
  assert.equal(monthDay.strongCue, true);
});

test('two-character overlap with a generic word is not a strong cue', () => {
  const note = '# 沟通偏好 - 回答方式\n\n- [preference] 先给结论';
  assert.equal(adjustedRelevance(1, {}, { now: NOW, query: '我的饮品偏好', text: note }).strongCue, false);
  assert.equal(adjustedRelevance(1, {}, { now: NOW, query: '用户偏好记忆', text: note }).strongCue, false);
});

test('generic preference wording does not bypass a soft downweight', () => {
  const note = '# 饮品偏好 - 甜度\n\n- [preference] 不加糖';
  const metadata = { base_priority: 0.25, softened_at: '2026-09-24T04:00:00.000Z' };
  const generic = adjustedRelevance(1, metadata, { query: '我的偏好是什么', text: note, now: NOW });
  assert.equal(generic.strongCue, false);
  assert.equal(generic.score, 0.5625);

  const specific = adjustedRelevance(1, metadata, { query: '饮品偏好 甜度', text: note, now: NOW });
  assert.equal(specific.strongCue, true);
  assert.equal(specific.score, 1);
});

test('configured half-life controls ageing while explicit metadata still overrides it', () => {
  const fact = adjustedRelevance(1, { memory_type: 'fact', decay_anchor_at: daysAgo(200) }, {
    now: NOW, halfLifeDays: 365, query: '生日', text: '生日是三月二日',
  });
  assert.equal(fact.strongCue, false);
  assert.equal(fact.eligible, true);
  assert.ok(fact.score > 0.8);

  const oldEvent = adjustedRelevance(1, { memory_type: 'event', decay_anchor_at: daysAgo(200) }, {
    now: NOW, halfLifeDays: 30, query: '交付', text: '交付了竹桥',
  });
  const freshEvent = adjustedRelevance(1, { memory_type: 'event', decay_anchor_at: NOW.toISOString() }, {
    now: NOW, halfLifeDays: 30, query: '交付', text: '交付了竹桥',
  });
  assert.equal(oldEvent.eligible, true);
  assert.equal(freshEvent.score, 1);
  assert.ok(oldEvent.score < freshEvent.score);
});

test('the configured half-life applies to every type and explicit metadata wins', () => {
  assert.equal(priorityFromMetadata({}, { now: NOW }).halfLifeDays, 30);
  assert.equal(priorityFromMetadata({}, { now: NOW, halfLifeDays: 365 }).halfLifeDays, 365);
  assert.equal(priorityFromMetadata({ memory_type: 'fact', importance: JSON.stringify({ level: 'high' }) }, { now: NOW, halfLifeDays: 30 }).halfLifeDays, 30);
  assert.equal(priorityFromMetadata({ memory_kind: 'history' }, { now: NOW, halfLifeDays: 90 }).halfLifeDays, 90);
  assert.equal(priorityFromMetadata({}, { now: NOW }).halfLifeDays, 30);
  assert.equal(priorityFromMetadata({ memory_type: 'fact', half_life_days: 30 }, { now: NOW, halfLifeDays: 365 }).halfLifeDays, 30);
});

test('only a user-softened record below the recall threshold is excluded, and strong cues still find it', () => {
  const note = '# 书架整理\n\n- [event] 整理了书架';
  const metadata = { memory_type: 'event', base_priority: 0.2, softened_at: daysAgo(120), half_life_days: 30 };
  const generic = adjustedRelevance(1, metadata, { now: NOW, query: '最近怎么样', text: note });
  assert.equal(generic.strongCue, false);
  assert.equal(generic.eligible, false);
  assert.equal(generic.score, 0.50625);

  const strong = adjustedRelevance(1, metadata, { now: NOW, query: '书架整理', text: note });
  assert.equal(strong.strongCue, true);
  assert.equal(strong.eligible, true);
  assert.equal(strong.score, 1);
});

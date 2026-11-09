import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustedRelevance,
  isStrongCue,
  priorityFromMetadata,
  reinforcePriorityPatch,
  softenPriorityPatch,
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

test('softening multiplies the current effective priority instead of resetting it', () => {
  const patch = softenPriorityPatch(
    { base_priority: 0.4, softened_at: '2026-09-24T04:00:00.000Z', half_life_days: 30 },
    { factor: 0.5, now: NOW, reason: 'asked to bring it up less' },
  );
  assert.equal(patch.base_priority, 0.1);
  assert.equal(patch.softened_at, NOW.toISOString());
  assert.equal(patch.soften_count, 1);
  assert.equal(patch.soften_reason, 'asked to bring it up less');
});

test('a date cue only counts when it matches the target record date', () => {
  const note = '# 2026-10-19 - 交付竹桥\n\n- [event] 交付完成';
  assert.equal(isStrongCue('2026-10-18 的交付呢', note), false);
  assert.equal(isStrongCue('2026-10-19 的交付呢', note), true);
  assert.equal(isStrongCue('10月19日那次交付', note), true);
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

test('two-character overlap with a generic word is not a strong cue', () => {
  const note = '# 沟通偏好 - 回答方式\n\n- [preference] 先给结论';
  assert.equal(isStrongCue('我的饮品偏好', note), false);
  assert.equal(isStrongCue('用户偏好记忆', note), false);
});

test('stable facts stay findable after 200 days; ageing events still rank below fresh ones', () => {
  const fact = adjustedRelevance(1, { memory_type: 'fact', decay_anchor_at: daysAgo(200) }, {
    now: NOW, query: '生日', text: '生日是三月二日',
  });
  assert.equal(fact.strongCue, false);
  assert.equal(fact.eligible, true);
  assert.ok(fact.score > 0.8);

  const oldEvent = adjustedRelevance(1, { memory_type: 'event', decay_anchor_at: daysAgo(200) }, {
    now: NOW, query: '交付', text: '交付了竹桥',
  });
  const freshEvent = adjustedRelevance(1, { memory_type: 'event', decay_anchor_at: NOW.toISOString() }, {
    now: NOW, query: '交付', text: '交付了竹桥',
  });
  assert.equal(oldEvent.eligible, true);
  assert.equal(freshEvent.score, 1);
  assert.ok(oldEvent.score < freshEvent.score);
});

test('high importance doubles the type half-life; explicit half_life_days wins over both', () => {
  assert.equal(priorityFromMetadata({ memory_type: 'fact' }, { now: NOW }).halfLifeDays, 365);
  assert.equal(priorityFromMetadata({ memory_type: 'fact', importance: JSON.stringify({ level: 'high' }) }, { now: NOW }).halfLifeDays, 730);
  assert.equal(priorityFromMetadata({ memory_type: 'event', importance: { level: 'high' } }, { now: NOW }).halfLifeDays, 60);
  assert.equal(priorityFromMetadata({ memory_kind: 'history' }, { now: NOW }).halfLifeDays, 30);
  assert.equal(priorityFromMetadata({}, { now: NOW }).halfLifeDays, 30);
  assert.equal(priorityFromMetadata({ memory_type: 'fact', half_life_days: 30, importance: JSON.stringify({ level: 'high' }) }, { now: NOW }).halfLifeDays, 30);
});

test('reaffirmation restores at least 0.9 and doubles the half-life up to 730 days', () => {
  const patch = reinforcePriorityPatch({ memory_type: 'fact', decay_anchor_at: daysAgo(30) }, { now: NOW });
  assert.ok(patch.base_priority >= 0.9);
  assert.equal(patch.half_life_days, 730);
  assert.ok(priorityFromMetadata(patch, { now: NOW }).effectivePriority >= 0.9);

  const capped = reinforcePriorityPatch({ memory_type: 'event', decay_anchor_at: daysAgo(30), half_life_days: 600 }, { now: NOW });
  assert.equal(capped.half_life_days, 730);

  const beyond = reinforcePriorityPatch({ memory_type: 'event', decay_anchor_at: daysAgo(30), half_life_days: 800 }, { now: NOW });
  assert.equal(beyond.half_life_days, 730);
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

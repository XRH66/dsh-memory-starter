import test from 'node:test';
import assert from 'node:assert/strict';
import { composeMemoryContext } from '../lib/context.js';

const messages = [{ id: 'test-query', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '群里谁喜欢茶和咖啡？' }] }];
const config = { maxContextChars: 1200 };
const fact = (id, subject, value) => ({ title: '喜欢的饮品', permalink: `test/facts/${id}`, memoryId: id, kind: 'fact', status: 'active', value, score: 0.8, baseScore: 0.8, priorityMetadata: { memory_id: id, subject } });

test('social recall states both stable member identities beside their preferences', () => {
  const result = composeMemoryContext({ facts: [fact('a', 'qq:710000001', '茶'), fact('b', 'qq:710000002', '咖啡')], messages, config });
  assert.match(result.text, /qq:710000001[^\n]*茶/);
  assert.match(result.text, /qq:710000002[^\n]*咖啡/);
  assert.equal(result.selected, 2);
});

test('different members sharing the same preference are not deduplicated together', () => {
  const result = composeMemoryContext({ facts: [fact('a', 'qq:710000001', '茶'), fact('b', 'qq:710000002', '茶')], messages, config });
  assert.equal(result.selected, 2);
});

test('repeated views of the same member fact still collapse', () => {
  const item = fact('a', 'qq:710000001', '茶');
  const result = composeMemoryContext({ facts: [item], navigation: [item], messages, config });
  assert.equal(result.selected, 1);
});

test('ordinary personal memory keeps its existing body deduplication and labels', () => {
  const result = composeMemoryContext({ facts: [fact('a', '主人', '茶'), fact('b', '主人', '茶')], messages, config });
  assert.equal(result.selected, 1);
  assert.match(result.text, /- 事实：茶/);
  assert.doesNotMatch(result.text, /成员/);
});

test('a semantically retrieved fact keeps retrieval eligibility without a literal topic match', () => {
  const retrieved = { ...fact('activity', 'qq:710000001', '散步'), title: '日常爱好',
    score: 0.4816, baseScore: 0.4816, eligible: true };
  const question = [{ id: 'activity-question', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '我喜欢啥活动' }] }];
  const result = composeMemoryContext({ facts: [retrieved], messages: question, config });
  assert.match(result.text, /qq:710000001[^\n]*散步/);
  assert.equal(composeMemoryContext({ facts: [{ ...retrieved, eligible: false }], messages: question, config }).selected, 0);
  assert.equal(composeMemoryContext({ facts: [{ ...retrieved, status: 'revoked' }], messages: question, config }).selected, 0);
});

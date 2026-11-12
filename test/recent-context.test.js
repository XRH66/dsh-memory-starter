import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateRecentTokens, originalRecentStats, recentContextFile} from '../lib/recent-context.js';

test('handoff sample counts only current nonempty originals and exposes no message bodies', () => {
  const source = { isCurrent: true, sessionId: 'session-A', turn: 1, text: '窗口正文', recordedAt: 2000 };
  const rows = [
    source,
    { ...source, text: '回答', time: 1000 },
    { ...source, sessionId: 'session-B' },
    { ...source, isCurrent: false },
    { ...source, withdrawn: true },
    { ...source, text: '' },
  ];
  const sampledAt = new Date(3000).toISOString();
  assert.equal(originalRecentStats(false, rows, sampledAt).storage, 'disabled');
  assert.equal(originalRecentStats(true).sampledAt, null);
  const stats = originalRecentStats(true, rows, sampledAt);
  assert.equal(stats.source, 'original-handoff-sample');
  assert.equal(stats.sampledAt, sampledAt);
  assert.equal(stats.sampledMessages, 3);
  assert.equal(stats.turns, 2);
  assert.equal(stats.estimatedTokens, 2 * estimateRecentTokens(source.text) + estimateRecentTokens('回答'));
  assert.equal(stats.oldestAt, new Date(1000).toISOString());
  assert.equal(stats.newestAt, new Date(2000).toISOString());
  assert.equal(stats.capacityTokens, null);
  assert.equal(stats.evictedTurns, null);
  assert.doesNotMatch(JSON.stringify(stats), /窗口正文|回答|session-A|session-B/);
});

test('cached recent-context file path remains stable for compatibility', () => {
  assert.match(recentContextFile({ project: 'main', vaultPath: 'fixture-vault' }), /recent-context[\\/][a-f0-9]{20}\.json$/);
  assert.equal(recentContextFile({ project: 'main' }), '');
});

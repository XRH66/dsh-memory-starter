import test from 'node:test';
import assert from 'node:assert/strict';
import { characterTokenCost, estimateTokens } from '../lib/token-estimate.js';
import { estimateRecentTokens } from '../lib/recent-context.js';
import { packMemoryBatch } from '../lib/memory-batch.js';

test('shared token estimation preserves both legacy call patterns', () => {
  const cases = [
    { text: '中文', tokens: 2 },
    { text: 'plain ascii', tokens: 4 },
    { text: '中文abc🙂!', tokens: 4 },
    { text: '🙂', tokens: 1 },
    { text: '', tokens: 0 },
  ];

  assert.deepEqual(
    cases.map(({ text }) => ({ text, tokens: estimateRecentTokens(text) })),
    cases,
  );
  assert.deepEqual(
    cases.map(({ text }) => ({
      text,
      tokens: Math.ceil([...text].reduce((units, char) => units + characterTokenCost(char), 0)),
    })),
    cases,
  );
});

test('memory batch boundaries use the shared character cost', () => {
  const text = '中文abc🙂!';
  const job = { ownerSubject: 'owner', project: 'personal', id: 'source', revision: 1, offset: 0 };
  const packed = packMemoryBatch([job], () => ({ text }), { batchTokens: 3 });

  assert.equal(packed.fragments[0].end, 5);
  assert.equal(packed.fragments[0].tokens, 3);
  assert.equal(packed.fragments[0].tokens, estimateTokens(text.slice(0, 5)));
});

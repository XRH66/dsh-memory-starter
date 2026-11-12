import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTurn, RawMemoryStore, splitClauses } from '../lib/raw-rag/store.js';
import { buildCoverage, coverageOf, selectEvidence } from '../lib/raw-rag/select.js';
import { createRawRecall } from '../lib/raw-rag/index.js';
import { resolveConfig } from '../lib/config.js';
import { createBridge } from '../lib/index.js';
import { fakeAgent, fakeTools, mcpResult, runPreStep } from './helpers.js';
import { embeddingContract, seedTurnVectors } from './embedding-fixture.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);

function fakeEmbedder(modelKey = 'fake-model:4') {
  return {
    ...embeddingContract(modelKey, 4),
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      return texts.map((text) => {
        const v = [0, 0, 0, 0];
        if (String(text).includes('西湖')) v[0] = 1;
        if (String(text).includes('围巾')) v[1] = 1;
        if (String(text).includes('蛋糕')) v[2] = 1;
        if (!v.some(Boolean)) v[3] = 1;
        return v;
      });
    },
    dispose() {},
  };
}

async function tempDb(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-recall-test-'));
  return { dir, db: path.join(dir, 'raw.sqlite') };
}

test('turn offsets keep every clause and the last correction', () => {
  const long = Array.from({ length: 14 }, (_, i) => '第' + (i + 1) + '句。').join('');
  const turn = buildTurn({ scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0, messages: [
    { id: 'u1', role: 'user', text: '周六去西湖，记得带伞，改到周日。' },
    { id: 'a1', role: 'assistant', text: long },
  ] });
  assert.equal(turn.docText.slice(turn.messages[0].docStart, turn.messages[0].docEnd), '周六去西湖，记得带伞，改到周日。');
  assert.equal(turn.docText.slice(turn.messages[1].docStart, turn.messages[1].docEnd), long);
  assert.ok(splitClauses('周六去西湖，记得带伞，改到周日。').some((clause) => clause.text.includes('改到周日')));
  assert.equal(splitClauses(long).length, 14);
});

test('coverage only skips the exact rendered clause from the same source', () => {
  const turn = { turnId: 't1', completedAt: T0, score: 1, messages: [
    { id: 'm1', role: 'user', text: '周六去西湖，记得带伞，改到周日。', ts: T0 },
  ] };
  const same = selectEvidence({ turns: [turn], query: '西湖 周日', budget: 500,
    existingMessages: [{ id: 'm1', role: 'user', text: '记得带伞' }] });
  assert.equal(same.skippedCovered, 1);
  assert.ok(!same.text.includes('记得带伞'));
  assert.ok(same.text.includes('去西湖') && same.text.includes('改到周日'));
  const other = selectEvidence({ turns: [turn], query: '西湖 周日', budget: 500,
    existingMessages: [{ id: 'other', role: 'user', text: '记得带伞' }] });
  assert.equal(other.skippedCovered, 0);
  assert.ok(other.text.includes('记得带伞'));
});

test('coverage requires the same message identity, not just the same string', () => {
  const unlinked = buildCoverage([{ trustedRendered: true, text: '用户：需要预约。' }]);
  assert.equal(coverageOf(unlinked, 'assistant', '需要预约。', 'different-message'), false);
  assert.equal(coverageOf(unlinked, 'user', '需要预约。', 'different-message'), false);
  const linked = buildCoverage([{ id: 'm1', role: 'user', text: '需要预约。' }]);
  assert.equal(coverageOf(linked, 'user', '需要预约。', 'm1'), true);
  assert.equal(coverageOf(linked, 'assistant', '需要预约。', 'm1'), false);
  assert.equal(coverageOf(linked, 'user', '需要预约。', 'm2'), false);
});

test('store is idempotent, model-isolated and scope/asOf filtered', async (t) => {
  const { dir, db } = await tempDb(t);
  const store = new RawMemoryStore(db);
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  assert.deepEqual(store.stats('m1', 'owner:a'), { turns: 0, windows: 0, vectors: 0,
    eligibleWindows: 0, indexedWindows: 0, pendingWindows: 0, pendingSources: 0 });
  const turn = buildTurn({ scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0, messages: [
    { id: 'u1', role: 'user', text: '西湖边的蛋糕店。' },
  ] });
  assert.equal(store.archiveTurn(turn).pending, turn.windows.length);
  assert.equal(store.archiveTurn(turn).pending, 0);
  await seedTurnVectors(store, embeddingContract('m1', 2), turn, () => [1, 0]);
  assert.equal(store.authorizedTurns('m1', { scope: 'owner:a', asOf: T0 + 1 }).length, 1);
  assert.equal(store.authorizedTurns('m1', { scope: 'owner:a', asOf: T0 - 1 }).length, 0);
  assert.equal(store.authorizedTurns('m1', { scope: 'owner:b', asOf: T0 + 1 }).length, 0);
  assert.equal(store.authorizedTurns('m2', { scope: 'owner:a', asOf: T0 + 1 }).length, 0);
  store.registerModel(await embeddingContract('m2', 2).prepare());
  const source = store.sourcesNeedingChunks('m2', { scope: 'owner:a' })[0];
  assert.equal(store.putChunks('m2', source, await embeddingContract('m2', 2).planChunks(source.docText)), true);
  const pending = store.pendingWindows('m2', { scope: 'owner:a' });
  assert.equal(pending.length, turn.windows.length);
  assert.equal(store.stats('m1', 'owner:a').vectors, turn.windows.length);
  assert.equal(store.stats('m2', 'owner:a').vectors, 0);
  const indexed = store.stats('m1', 'owner:a'), unindexed = store.stats('m2', 'owner:a');
  assert.equal(indexed.eligibleWindows, turn.windows.length);
  assert.equal(indexed.indexedWindows, turn.windows.length);
  assert.equal(indexed.pendingWindows, 0);
  assert.equal(indexed.pendingSources, 0);
  assert.equal(unindexed.eligibleWindows, pending.length);
  assert.equal(unindexed.indexedWindows, 0);
  assert.equal(unindexed.pendingWindows, pending.length);
  assert.equal(unindexed.pendingSources, 0);
});

test('owner is read per call and switching scope cannot reuse the old one', async (t) => {
  const { dir, db } = await tempDb(t);
  const embedder = fakeEmbedder();
  let owner = 'owner:a';
  const recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: db }),
    ownerSubject: () => owner, embedder, logger: { warn() {} } });
  t.after(async () => { await recall.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  await recall.archiveTurn({ sessionId: 's1', turn: 1, completedAt: T0, messages: [
    { id: 'a-u1', role: 'user', text: '西湖边的蛋糕店。' },
  ] });
  await recall.flush();
  assert.match((await recall.recall({ query: '西湖', budget: 500 })).text, /西湖/);
  owner = 'owner:b';
  const other = await recall.recall({ query: '西湖', budget: 500 });
  assert.equal(other.reason, 'empty-store');
  owner = '';
  assert.equal((await recall.recall({ query: '西湖', budget: 500 })).reason, 'no-scope');
});

test('dispose drains queued turns before closing the store', async (t) => {
  const { dir, db } = await tempDb(t);
  const embedder = fakeEmbedder();
  const original = embedder.embed;
  embedder.embed = async function (...args) { await new Promise((resolve) => setTimeout(resolve, 15)); return original.apply(this, args); };
  const recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: db }),
    ownerSubject: () => 'owner:a', embedder, logger: { warn() {} } });
  for (let turn = 1; turn <= 3; turn += 1) {
    await recall.archiveTurn({ sessionId: 's1', turn, completedAt: T0 + turn,
      messages: [{ id: 'u' + turn, role: 'user', text: '第' + turn + '轮西湖。' }] });
  }
  await recall.dispose();
  const store = new RawMemoryStore(db);
  t.after(async () => { store.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const stats = store.stats('fake-model:4', 'owner:a');
  assert.equal(stats.turns, 3);
  assert.equal(stats.vectors, stats.windows);
});

test('an authorized read recovers archived windows whose vectors were lost', async (t) => {
  const { dir, db } = await tempDb(t);
  const first = new RawMemoryStore(db);
  const turn = buildTurn({ scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0,
    messages: [{ id: 'lost-u1', role: 'user', text: '西湖边的蛋糕店。' }] });
  first.archiveTurn(turn);
  first.close();
  const recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: db }),
    ownerSubject: () => 'owner:a', embedder: fakeEmbedder(), logger: { warn() {} } });
  t.after(async () => { await recall.dispose(); await fs.rm(dir, { recursive: true, force: true }); });
  const result = await recall.recall({ query: '西湖', budget: 500 });
  assert.equal(result.reason, 'ok');
  assert.match(result.text, /西湖/);
});

test('invalid db path is deferred and never breaks construction', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-recall-bad-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const blocker = path.join(dir, 'blocked');
  await fs.writeFile(blocker, 'not a directory');
  const recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: path.join(blocker, 'raw.sqlite') }),
    ownerSubject: () => 'owner:a', embedder: fakeEmbedder(), logger: { warn() {} } });
  t.after(() => recall.dispose());
  assert.equal(recall.status().stats, null);
  const result = await recall.archiveTurn({ sessionId: 's1', turn: 1, completedAt: T0, messages: [{ id: 'u1', role: 'user', text: '西湖。' }] });
  assert.equal(result.skipped, 'failed');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTurn, RawMemoryStore, splitClauses } from '../lib/raw-rag/store.js';
import { createRawRecall } from '../lib/raw-rag/index.js';
import { resolveConfig } from '../lib/config.js';
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

async function tempDb() {
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

test('store is idempotent, model-isolated and scope/asOf filtered', async (t) => {
  const { dir, db } = await tempDb();
  const store = new RawMemoryStore(db);
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
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

test('dispose drains queued turns before closing the store', async (t) => {
  const { dir, db } = await tempDb();
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
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const stats = store.stats('fake-model:4', 'owner:a');
  assert.equal(stats.turns, 3);
  assert.equal(stats.vectors, stats.windows);
});

test('invalid db path is deferred and never breaks construction', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-recall-bad-'));
  t.after(async () => {
    assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const blocker = path.join(dir, 'blocked');
  await fs.writeFile(blocker, 'not a directory');
  const recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: path.join(blocker, 'raw.sqlite') }),
    ownerSubject: () => 'owner:a', embedder: fakeEmbedder(), logger: { warn() {} } });
  t.after(() => recall.dispose());
  assert.equal(recall.status().stats, null);
  const result = await recall.archiveTurn({ sessionId: 's1', turn: 1, completedAt: T0, messages: [{ id: 'u1', role: 'user', text: '西湖。' }] });
  assert.equal(result.skipped, 'failed');
});

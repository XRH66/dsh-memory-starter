import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTurn, RawMemoryStore, sha256 } from '../lib/raw-rag/store.js';
import { embeddingContract, seedTurnVectors } from './embedding-fixture.js';

const T0 = Date.UTC(2026, 10, 5, 10);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-text-test-'));
  const file = path.join(root, 'raw.sqlite');
  let store = new RawMemoryStore(file);
  t.after(async () => {
    store.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('raw-text-test-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  return {
    file,
    get store() { return store; },
    reopen() { store.close(); store = new RawMemoryStore(file); return store; },
    archive(text, { id = 'u1', turn = 1, scope = 'owner:a', sessionId = 's1', at = T0 } = {}) {
      const value = buildTurn({ scope, sessionId, turn, completedAt: at,
        messages: [{ id, role: 'user', text, ts: at }] });
      store.archiveTurn(value); return value;
    },
  };
}

test('text search survives restart and replaces stale text without duplicating the source', async (t) => {
  const f = await fixture(t);
  f.archive('翡翠钥匙在木匣。');
  f.reopen();
  assert.equal(f.store.searchText('翡翠钥匙', { scope: 'owner:a' }).length, 1);
  f.archive('黄铜钥匙在白盒。');
  assert.equal(f.store.searchText('翡翠', { scope: 'owner:a' }).length, 0);
  assert.equal(f.store.searchText('白盒', { scope: 'owner:a' }).length, 1);
  f.archive('黄铜钥匙在白盒。');
  assert.equal(f.store.searchText('白盒', { scope: 'owner:a' }).length, 1);
});

test('text query filters scope, time, message identity and persistent source exclusions', async (t) => {
  const f = await fixture(t);
  const current = f.archive('纸鹤放木架。');
  f.archive('纸鹤属于另一人。', { scope: 'owner:b', sessionId: 'other', id: 'other-u' });
  f.archive('纸鹤明天才换地方。', { turn: 2, id: 'future-u', at: T0 + 20000 });
  assert.deepEqual(f.store.searchText('纸鹤', { scope: 'owner:a', asOf: T0 + 10 }).map(hit => hit.turnId), [current.turnId]);
  assert.equal(f.store.searchText('纸鹤', { scope: 'owner:a', since: T0 + 1, asOf: T0 + 10 }).length, 0);
  assert.equal(f.store.searchText('', { scope: 'owner:a', messageId: 'u1', asOf: T0 + 10 }).length, 1);
  assert.equal(f.store.searchText('', { scope: 'owner:a', messageId: 'other-u' }).length, 0);
  f.store.setControl({ scope: 'owner:a', targetType: 'message', targetId: 'u1', excluded: true });
  assert.equal(f.store.searchText('纸鹤', { scope: 'owner:a', asOf: T0 + 10 }).length, 0);
});

test('hidden imports, zero weight and lower priorities apply to text retrieval', async (t) => {
  const f = await fixture(t);
  const low = f.archive('青色文件袋在中柜。');
  const high = f.archive('青色文件袋在左柜。', { turn: 2, id: 'u2', at: T0 + 1 });
  f.store.setControl({ scope: 'owner:a', targetType: 'turn', targetId: low.turnId, weight: 0.1 });
  const hits = f.store.searchText('青色文件袋', { scope: 'owner:a' });
  assert.equal(hits[0].turnId, high.turnId);
  f.store.setControl({ scope: 'owner:a', targetType: 'turn', targetId: high.turnId, weight: 0 });
  f.store.beginImport('owner:a', 'history-source', 'first');
  f.store.saveProgress({ scope: 'owner:a', sourceId: 'history-source', fingerprint: 'first', position: 1, turnId: low.turnId });
  f.store.beginImport('owner:a', 'history-source', 'second');
  assert.equal(f.store.searchText('青色文件袋', { scope: 'owner:a' }).length, 0);
});

test('adding the text index to a pre-index database preserves its original data and vectors', async (t) => {
  const f = await fixture(t), saved = f.archive('清露白杯放厨房。');
  await seedTurnVectors(f.store, embeddingContract('kept:2', 2), saved, () => [1, 0]);
  const before = f.store.stats('kept:2', 'owner:a');
  f.store.db.exec('DROP TABLE IF EXISTS raw_text_index');
  f.store.db.prepare("DELETE FROM raw_schema WHERE key='text-index-v1'").run();
  f.reopen();
  assert.deepEqual(f.store.stats('kept:2', 'owner:a'), before);
  assert.equal(f.store.searchText('白杯', { scope: 'owner:a' }).length, 1);
  assert.deepEqual(f.store.storedTurn('owner:a', saved.turnId), saved.messages);
});

test('text search treats quotes and query operators as text', async (t) => {
  const f = await fixture(t);
  f.archive('紫藤信封放抽屉。');
  f.archive('我没有想法，但以前说过夏天适合喝白茶。', { turn: 2, id: 'weak-words' });
  f.archive('我根本没有空，下午只想喝乌龙茶。', { turn: 3, id: 'no-time' });
  f.archive('不是今天出门，我在阳台照料绿植。', { turn: 4, id: 'different-topic' });
  for (const query of ['完全没有的隐形潜艇', '我有没有说过隐形潜艇', '根本没有的水晶飞艇', '不是深海潜航器']) {
    assert.equal(f.store.searchText(query, { scope: 'owner:a' }).length, 0, query);
  }
  assert.doesNotThrow(() => f.store.searchText('" OR * - ()', { scope: 'owner:a' }));
});

test('source hash blocks a stale index and reopening repairs writes made by an older bridge', async (t) => {
  const f = await fixture(t), first = f.archive('靛蓝信封在木箱。');
  const changed = buildTurn({ scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0,
    messages: [{ id: 'u1', role: 'user', text: '珊瑚信封在竹篮。' }] });
  f.store.db.prepare('UPDATE turns SET doc_text=?,doc_hash=?,messages_json=? WHERE turn_id=?')
    .run(changed.docText, sha256(changed.docText), JSON.stringify(changed.messages), first.turnId);
  assert.equal(f.store.searchText('靛蓝', { scope: 'owner:a' }).length, 0);
  f.reopen();
  assert.equal(f.store.searchText('靛蓝', { scope: 'owner:a' }).length, 0);
  assert.equal(f.store.searchText('珊瑚', { scope: 'owner:a' }).length, 1);
});

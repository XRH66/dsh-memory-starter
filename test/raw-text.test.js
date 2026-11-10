import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildTurn, RawMemoryStore, sha256 } from '../lib/raw-rag/store.js';
import { createRawRecall } from '../lib/raw-rag/index.js';
import { selectEvidence, RAW_RECALL_SOURCE } from '../lib/raw-rag/select.js';
import { resolveConfig } from '../lib/config.js';
import { createBridge } from '../lib/index.js';
import { directUser, fakeAgent, runPreStep, turnStart, turnEnd } from './helpers.js';
import { embeddingContract, seedTurnVectors } from './embedding-fixture.js';
import { derivationMetadata } from '../lib/source-lineage.js';

const T0 = Date.UTC(2026, 10, 5, 10);
const quiet = { warn() {} };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-text-test-'));
  const file = path.join(root, 'raw.sqlite');
  let store = new RawMemoryStore(file);
  let recall;
  t.after(async () => {
    if (recall) await recall.dispose(); else store.close();
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
    reader(extra = {}) {
      recall = createRawRecall({ config: resolveConfig({ rawRecall: true, rawRecallDbPath: file }),
        ownerSubject: 'owner:a', now: () => new Date(T0 + 10000), store, logger: quiet, ...extra });
      return recall;
    },
  };
}

function unavailable() {
  return { ...embeddingContract('unavailable:2', 2), calls: 0,
    async embed() { this.calls += 1; throw new Error('embedding deliberately unavailable'); }, dispose() {} };
}

test('text-only search finds Chinese names, two-character words and exact numbers without a model', async t => {
  const f = await fixture(t);
  f.archive('小林的借阅卡尾号 731，放在蓝册里。');
  f.archive('小李的借阅卡尾号 7310，放在红册里。', { turn: 2, id: 'u2' });
  f.archive('岚的小名是阿岚，铜章编号 A.731，放在黄盒里。', { turn: 3, id: 'short-name' });
  f.archive('祁的铜章编号 A.7310，放在黑盒里。', { turn: 4, id: 'other-short-name' });
  const model = unavailable(), r = f.reader({ embedder: model });
  for (const query of ['小林', '蓝册', '731', '借阅卡 731 放哪里']) {
    const result = await r.recall({ query, mode: 'text', budget: 600 });
    assert.match(result.text, /蓝册/);
    assert.doesNotMatch(result.text, /7310|红册/);
    assert.equal(result.reason, 'ok');
  }
  for (const query of ['岚', '阿岚', 'A.731', '编号 A.731 放哪里']) {
    const result = await r.recall({ query, mode: 'text', budget: 600 });
    assert.equal(result.reason, 'ok');
    assert.match(result.text, /黄盒/);
    assert.doesNotMatch(result.text, /A\.7310|黑盒|蓝册|红册/);
  }
  assert.equal(model.calls, 0, 'explicit text search must not start or repair embeddings');
});

test('ordinary recall returns saved text when the embedding provider fails', async t => {
  const f = await fixture(t), saved = f.archive('薄荷蓝线缠在窗台花盆，线尾写着 83017。');
  const model = unavailable();
  await seedTurnVectors(f.store, model, saved, () => [1, 0]);
  const result = await f.reader({ embedder: model }).recall({ query: '83017 线放哪里', budget: 600 });
  assert.match(result.text, /窗台花盆/);
  assert.equal(result.reason, 'ok');
  assert.ok(result.retrieval.textTurns > 0);
  assert.equal(result.retrieval.vectorState, 'failed');
});

test('text search survives restart and replaces stale text without duplicating the source', async t => {
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

test('text query filters scope, time, message identity and persistent source exclusions', async t => {
  const f = await fixture(t);
  f.archive('纸鹤放木架。');
  f.archive('纸鹤属于另一人。', { scope: 'owner:b', sessionId: 'other', id: 'other-u' });
  f.archive('纸鹤明天才换地方。', { turn: 2, id: 'future-u', at: T0 + 20000 });
  const r = f.reader({ embedder: unavailable() });
  assert.equal((await r.retrieve({ query: '纸鹤', mode: 'text', asOf: T0 + 10 })).turns.length, 1);
  assert.equal((await r.retrieve({ query: '纸鹤', mode: 'text', since: T0 + 1, asOf: T0 + 10 })).turns.length, 0);
  assert.equal((await r.retrieve({ query: '', mode: 'text', messageId: 'u1', asOf: T0 + 10 })).turns.length, 1);
  assert.equal((await r.retrieve({ query: '', mode: 'text', messageId: 'other-u' })).turns.length, 0);
  r.control({ targetType: 'message', targetId: 'u1', excluded: true });
  assert.equal((await r.retrieve({ query: '纸鹤', mode: 'text', asOf: T0 + 10 })).turns.length, 0);
});

test('hidden imports, zero weight and lower priorities apply to text retrieval', async t => {
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

test('adding the text index to a pre-index database preserves its original data and vectors', async t => {
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

test('text search treats quotes and query operators as text and never returns a recent fallback', async t => {
  const f = await fixture(t);
  f.archive('紫藤信封放抽屉。');
  f.archive('我没有想法，但以前说过夏天适合喝白茶。', { turn: 2, id: 'weak-words' });
  f.archive('我根本没有空，下午只想喝乌龙茶。', { turn: 3, id: 'no-time' });
  f.archive('不是今天出门，我在阳台照料绿植。', { turn: 4, id: 'different-topic' });
  const r = f.reader({ embedder: unavailable() });
  for (const query of ['完全没有的隐形潜艇', '我有没有说过隐形潜艇', '根本没有的水晶飞艇', '不是深海潜航器']) {
    await t.test(query, async () => {
      const result = await r.recall({ query, mode: 'text', budget: 600 });
      assert.equal(result.text, '');
      assert.equal(result.reason, 'no-candidate');
    });
  }
  await assert.doesNotReject(r.recall({ query: '" OR * - ()', mode: 'text', budget: 600 }));
  const controller = new AbortController(); controller.abort();
  const aborted = await r.recall({ query: '紫藤', mode: 'text', budget: 600, signal: controller.signal });
  assert.equal(aborted.text, '');
  assert.equal(aborted.reason, 'cancelled');
});

test('negated food restrictions retain their topic and full prohibition without unrelated cannot hits', async t => {
  const f = await fixture(t);
  f.archive('我不能吃香菜，点汤时请别放香菜。');
  f.archive('我不能吃花生，外出需要确认酱料。', { turn: 2, id: 'other-food' });
  f.archive('小林可以吃香菜，另用一只碗。', { turn: 3, id: 'other-person' });
  const model = unavailable(), r = f.reader({ embedder: model });
  const result = await r.recall({ query: '不能吃香菜', mode: 'text', budget: 600 });
  assert.equal(result.reason, 'ok');
  assert.match(result.text, /我不能吃香菜/);
  assert.match(result.text, /请别放香菜/);
  assert.doesNotMatch(result.text, /花生|确认酱料/);
  assert.equal(model.calls, 0);
});

test('verbatim quoted negation and framing words remain searchable without a separate topic', async t => {
  const f = await fixture(t);
  f.archive('我没有空，周五再来。');
  f.archive('不是临时决定，这是确定安排。', { turn: 2, id: 'quoted-not' });
  f.archive('请问一下，票据由小林保管。', { turn: 3, id: 'quoted-framing' });
  f.archive('不能在柜台插队，先排到队尾。', { turn: 4, id: 'quoted-cannot' });
  const model = unavailable(), r = f.reader({ embedder: model });
  for (const [query, expected] of [
    ['"没有"', /我没有空/], ["'没有'", /我没有空/], ['“不是”', /不是临时决定/],
    ['「请问」', /请问一下/], ['『不能』', /不能在柜台插队/],
    ['没有', /我没有空/], ['不是', /不是临时决定/],
  ]) {
    const result = await r.recall({ query, mode: 'text', budget: 600 });
    assert.equal(result.reason, 'ok', query);
    assert.match(result.text, expected, query);
  }
  assert.equal(model.calls, 0);
});

test('source hash blocks a stale index and reopening repairs writes made by an older bridge', async t => {
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

test('text hits allow cold prepare and vector query beyond 300ms within the configured budget', async t => {
  const f = await fixture(t), saved = f.archive('荧光纸夹编号 93261，放在侧袋。');
  const contract = embeddingContract('cold-budget:2', 2);
  let queryCalls = 0, queryElapsed = 0, prepareElapsed = 0, preparing;
  const model = { ...contract,
    async embed(texts, { kind } = {}) {
      assert.equal(kind, 'query', 'prebuilt vectors must not require document repair');
      queryCalls += 1;
      const start = performance.now();
      await new Promise(resolve => setTimeout(resolve, 350));
      queryElapsed = performance.now() - start;
      return texts.map(() => [1, 0]);
    }, dispose() {} };
  await seedTurnVectors(f.store, model, saved, () => [1, 0]);
  // Delay only the first recall's preparation, not the fixture's vector seeding.
  // Concurrent foreground/recovery callers share one cold prepare, like the backend.
  model.prepare = () => preparing ||= (async () => {
    const start = performance.now();
    await new Promise(resolve => setTimeout(resolve, 350));
    prepareElapsed = performance.now() - start;
    return contract.prepare();
  })();
  const config = resolveConfig({ rawRecall: true, rawRecallDbPath: f.file, rawRecallTimeoutMs: 1500 });
  const result = await f.reader({ embedder: model, config }).recall({ query: '93261 放哪', budget: 600 });
  assert.ok(prepareElapsed > 300, 'this must exercise a prepare slower than the removed hard cap');
  assert.ok(queryElapsed > 300, 'this must also exercise a query slower than the removed hard cap');
  assert.equal(queryCalls, 1);
  assert.equal(result.reason, 'ok');
  assert.equal(result.retrieval.textTurns, 1);
  assert.equal(result.retrieval.vectorState, 'ok');
  assert.equal(result.retrieval.vectorTurns, 1);
  assert.match(result.text, /侧袋/);
});

test('text hits return when the configured vector budget expires while the provider stalls', async t => {
  const f = await fixture(t), saved = f.archive('荧光纸夹编号 93261，放在侧袋。');
  const model = { ...embeddingContract('stalled:2', 2), async embed() { return new Promise(() => {}); }, dispose() {} };
  await seedTurnVectors(f.store, model, saved, () => [1, 0]);
  const config = resolveConfig({ rawRecall: true, rawRecallDbPath: f.file, rawRecallTimeoutMs: 500 });
  const start = performance.now();
  const result = await f.reader({ embedder: model, config }).recall({ query: '93261 放哪', budget: 600 });
  assert.match(result.text, /侧袋/);
  assert.equal(result.reason, 'ok');
  assert.equal(result.retrieval.textTurns, 1);
  assert.equal(result.retrieval.vectorState, 'timeout');
  assert.equal(result.retrieval.vectorTurns, 0);
  assert.ok(performance.now() - start < 1200, 'text must return promptly after its configured 500ms deadline');
});

const noise = '今天只聊无关天气和路上的风景。'.repeat(80);
function longTurn(text, role = 'user') {
  return { turnId: 'long', score: 1, completedAt: T0,
    messages: [{ id: 'long-source', role, text, ts: T0, docStart: 0 }] };
}

test('long dialogue preserves the relevant tail and all adjacent conditions within the old budget', () => {
  const turn = longTurn(noise + '周日去取围巾，柜台只开到三点，超过时间别去。如果下雨，就改到下周。');
  const result = selectEvidence({ turns: [turn], query: '围巾什么时候取，有什么条件', budget: 600 });
  for (const required of ['周日', '只开到三点', '超过时间别去', '如果下雨', '改到下周']) assert.ok(result.text.includes(required), required);
  assert.ok(result.chars <= 600);
  assert.doesNotMatch(result.text, /风景/);
});

test('an oversized comma-only sentence keeps its relevant proposition and following limit', () => {
  const text = '路上看见很多树叶，'.repeat(100) + '周日去取围巾，柜台三点关门，仅限提前预约的老顾客，超过时间别去。';
  const result = selectEvidence({ turns: [longTurn(text)], query: '围巾怎么取', budget: 600 });
  assert.match(result.text, /周日去取围巾/);
  assert.match(result.text, /柜台三点关门/);
  assert.match(result.text, /仅限提前预约的老顾客/);
  assert.match(result.text, /超过时间别去/);
});

test('source A to B to A invalidates old retrieval, fact support and pending vectors', async t => {
  const f = await fixture(t), text = '周日去取围巾，柜台只开到三点。';
  const saved = f.archive(text), model = { ...embeddingContract('revision:2', 2),
    async embed(texts) { return texts.map(() => [1, 0]); }, dispose() {} };
  const chunks = await seedTurnVectors(f.store, model, saved, () => [1, 0]);
  const r = f.reader({ embedder: model });
  const first = await r.retrieve({ query: '围巾', mode: 'text' });
  assert.equal(first.turns.length, 1);
  const source = r.sourceState({ messageId: 'u1' });
  assert.equal(source.state, 'live');
  f.archive('周四去取围巾，柜台只开到两点。');
  f.archive(text);
  const current = r.sourceState({ messageId: 'u1' });
  assert.equal(current.state, 'live');
  assert.notEqual(current.ref.sourceVersion, source.ref.sourceVersion);
  assert.equal(r.sourceState(source.ref).state, 'stale');
  assert.equal(r.select({ turns: first.turns, query: '围巾', budget: 600 }).text, '');
  assert.equal(f.store.putVectors(model.modelKey, chunks.map(chunk => ({ turnId: saved.turnId,
    windowId: chunk.id, textHash: chunk.textHash, sourceVersion: source.ref.sourceVersion,
    vector: [1, 0] }))), 0, 'an in-flight vector for the first revision cannot attach to the third');
  const fresh = await r.retrieve({ query: '围巾', mode: 'text' });
  assert.equal(fresh.turns.length, 1);
  assert.match(r.select({ turns: fresh.turns, query: '围巾', budget: 600 }).text, /只开到三点/);
});

test('source rewrite while query embedding waits cannot attach an old text hit to the new body', async t => {
  const f = await fixture(t), saved = f.archive('青蓝信封放在木箱。');
  let queryCalls = 0;
  const model = { ...embeddingContract('changing:2', 2),
    async embed(texts, { kind } = {}) {
      if (kind === 'query') {
        queryCalls += 1;
        assert.equal(f.store.searchText('青蓝信封', { scope: 'owner:a' }).length, 1);
        f.archive('橘红文件改放东柜。');
        return [[0, 1]];
      }
      return texts.map(() => [1, 0]);
    }, dispose() {} };
  await seedTurnVectors(f.store, model, saved, () => [1, 0]);
  const result = await f.reader({ embedder: model }).retrieve({ query: '青蓝信封在哪里' });
  assert.equal(queryCalls, 1);
  assert.deepEqual(result.turns, []);
  assert.equal(result.reason, 'no-candidate');
  assert.equal(result.retrieval.vectorTurns, 0);
  assert.equal(result.retrieval.staleTurns, 1);
});

test('a source excluded after retrieval is removed again at the final quote boundary', async t => {
  const f = await fixture(t);
  f.archive('围巾放在木柜，只有周日可领取。');
  const r = f.reader({ embedder: unavailable() });
  const found = await r.retrieve({ query: '围巾', mode: 'text' });
  assert.equal(found.turns.length, 1);
  assert.match(r.select({ turns: found.turns, query: '围巾', budget: 600 }).text, /只有周日/);
  r.control({ targetType: 'message', targetId: 'u1', excluded: true });
  assert.equal(r.select({ turns: found.turns, query: '围巾', budget: 600 }).text, '');
});

test('decimal numbers and dotted identifiers stay intact in evidence', () => {
  const text = noise + '工具版本 0.6B 可以用，编号 A.731 不要改成 A.7310。';
  const result = selectEvidence({ turns: [longTurn(text)], query: '工具版本 0.6B', budget: 600 });
  assert.match(result.text, /0\.6B/);
  assert.match(result.text, /A\.731 不要改成 A\.7310/);
});

test('a rendered main clause does not suppress an unseen deadline from that same long message', () => {
  const turn = longTurn(noise + '周日去取围巾，柜台只开到三点。');
  const result = selectEvidence({ turns: [turn], query: '围巾几点取', budget: 600,
    existingMessages: [{ id: 'long-source', role: 'user', text: '周日去取围巾，' }] });
  assert.doesNotMatch(result.text, /周日去取围巾/);
  assert.match(result.text, /只开到三点/);
  assert.equal(result.skippedCovered, 1);
});

test('assistant evidence keeps the adjacent limitation and its real speaker', () => {
  const result = selectEvidence({ turns: [longTurn('围巾周日取，柜台只开到三点。', 'assistant')],
    query: '围巾什么时候取', budget: 600 });
  assert.match(result.text, /助手/);
  assert.match(result.text, /只开到三点/);
});

test('semantic window hints can select a long passage without requiring literal query overlap', () => {
  const key = '青瓷杯放矮柜，不要放洗碗机。';
  const turn = longTurn(noise + key);
  turn.matchedRanges = [{ start: noise.length - 500, end: noise.length + key.length }];
  const result = selectEvidence({ turns: [turn], query: '那个容易碎的餐具怎么保管', budget: 600 });
  assert.match(result.text, /青瓷杯放矮柜/);
  assert.match(result.text, /不要放洗碗机/);
  assert.ok((result.text.match(/风景/g) || []).length <= 1, 'a repeated sentence from one source adds no extra evidence');
});

test('packing never exceeds its budget or truncates an atomic condition into its opposite', () => {
  const turn = longTurn(noise + '不能带蛋糕，除非小林确认大家都没有忌口。');
  for (const budget of [120, 160, 240, 400, 600]) {
    const r = selectEvidence({ turns: [turn], query: '蛋糕能带吗', budget });
    assert.ok(r.chars <= budget);
    if (r.text) {
      assert.match(r.text, /不能带蛋糕/);
      assert.match(r.text, /除非小林确认大家都没有忌口/);
    }
  }
});

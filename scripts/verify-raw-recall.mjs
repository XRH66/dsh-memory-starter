#!/usr/bin/env node
/**
 * Public, model-free regression for Stage A original-turn recall.
 *
 * It exercises the real formal bridge entry (createBridge.onPreStep) with a
 * deterministic embedding double and a temporary SQLite file. It does not
 * load a model, call a network service, read a personal vault or prove answer
 * quality. For a real local embedding check, see the Stage A deployment notes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBridge } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import { createRawRecall } from '../lib/raw-rag/index.js';
import { buildTurn, RawMemoryStore, splitClauses } from '../lib/raw-rag/store.js';
import { selectEvidence } from '../lib/raw-rag/select.js';

const T0 = Date.UTC(2026, 10, 4, 9, 0, 0);
const checks = [];

function check(name, fn) {
  return Promise.resolve().then(fn).then((detail) => {
    checks.push({ name, ok: true, detail: detail ?? null });
  }, (error) => {
    checks.push({ name, ok: false, error: error?.stack || String(error) });
    throw error;
  });
}

function fakeEmbedder(modelKey = 'public-verify:4') {
  return {
    modelKey,
    calls: 0,
    async embed(texts) {
      this.calls += 1;
      return texts.map((text) => {
        const value = [0, 0, 0, 0];
        if (String(text).includes('西湖')) value[0] = 1;
        if (String(text).includes('围巾')) value[1] = 1;
        if (String(text).includes('蛋糕')) value[2] = 1;
        if (!value.some(Boolean)) value[3] = 1;
        return value;
      });
    },
    dispose() {},
  };
}

function mcpResult(payload) {
  return {
    isError: false,
    value: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: { result: payload },
    },
    content: [],
  };
}

function fakeTools(handler) {
  return {
    get(name) {
      return {
        name,
        description: 'public verification tool',
        parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] },
        async execute(args, exec) {
          const result = await handler({ name, arguments: args, agent: exec.agent, signal: exec.signal });
          if (result?.isError === true) throw new Error(result.error?.message ?? 'fake tool failed');
          return result?.value;
        },
      };
    },
  };
}

function fakeAgent(sessionId) {
  return {
    session: { id: sessionId, requestHeader: () => ({ config: { provider: 'fake', model: 'fake' } }), toolHistory: () => ({}) },
    options: { provider: 'fake', model: 'fake' },
  };
}

async function runPreStep(bridge, sessionId, turn, messages) {
  return bridge.onPreStep({
    agent: fakeAgent(sessionId),
    messages,
    turn,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: 'enter', messages: [] }));
}

function textOf(result) {
  return (result.messages || []).map((message) => (
    Array.isArray(message.content) ? message.content.map((part) => part.text || '').join('') : String(message.content || '')
  )).join('\n');
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-recall-public-'));

try {
  await check('turn offsets preserve every clause and the final correction', () => {
    const long = Array.from({ length: 14 }, (_, index) => '第' + (index + 1) + '句。').join('');
    const turn = buildTurn({
      scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0,
      messages: [
        { id: 'u1', role: 'user', text: '周六去西湖，记得带伞，改到周日。' },
        { id: 'a1', role: 'assistant', text: long },
      ],
    });
    assert.equal(turn.docText.slice(turn.messages[0].docStart, turn.messages[0].docEnd), '周六去西湖，记得带伞，改到周日。');
    assert.equal(turn.docText.slice(turn.messages[1].docStart, turn.messages[1].docEnd), long);
    assert.equal(splitClauses(long).length, 14);
    assert.ok(splitClauses('周六去西湖，记得带伞，改到周日。').some((clause) => clause.text.includes('改到周日')));
    return { clauses: 14, correctionPreserved: true };
  });

  await check('exact rendered clause is skipped but an adjacent correction remains', () => {
    const turn = {
      turnId: 't-coverage', completedAt: T0, score: 1,
      messages: [{ id: 'm1', role: 'user', text: '周六去西湖，记得带伞，改到周日。', ts: T0 }],
    };
    const same = selectEvidence({
      turns: [turn], query: '西湖 周日', budget: 500,
      existingMessages: [{ id: 'm1', role: 'user', text: '记得带伞' }],
    });
    assert.equal(same.skippedCovered, 1);
    assert.ok(!same.text.includes('记得带伞'));
    assert.ok(same.text.includes('去西湖') && same.text.includes('改到周日'));
    const other = selectEvidence({
      turns: [turn], query: '西湖 周日', budget: 500,
      existingMessages: [{ id: 'other', role: 'user', text: '记得带伞' }],
    });
    assert.equal(other.skippedCovered, 0);
    assert.ok(other.text.includes('记得带伞'));
    return { sameSourceSkipped: 1, otherSourceSkipped: 0, adjacentCorrectionKept: true };
  });

  await check('normal shutdown drains all queued turns before closing SQLite', async () => {
    const db = path.join(temp, 'drain.sqlite');
    const embedder = fakeEmbedder();
    const original = embedder.embed;
    embedder.embed = async function (...args) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return original.apply(this, args);
    };
    const recall = createRawRecall({
      config: resolveConfig({ rawRecall: true, rawRecallDbPath: db }),
      ownerSubject: () => 'owner:a', embedder, logger: { warn() {} },
    });
    for (let turn = 1; turn <= 3; turn += 1) {
      await recall.archiveTurn({
        sessionId: 's1', turn, completedAt: T0 + turn,
        messages: [{ id: 'drain-u' + turn, role: 'user', text: '第' + turn + '轮西湖。' }],
      });
    }
    await recall.dispose();
    const store = new RawMemoryStore(db);
    const stats = store.stats('public-verify:4', 'owner:a');
    store.close();
    assert.equal(stats.turns, 3);
    assert.equal(stats.vectors, stats.windows);
    return stats;
  });

  await check('an authorized read recovers archived windows whose vectors were lost', async () => {
    const db = path.join(temp, 'recover.sqlite');
    const first = new RawMemoryStore(db);
    const turn = buildTurn({
      scope: 'owner:a', sessionId: 's1', turn: 1, completedAt: T0,
      messages: [{ id: 'recover-u1', role: 'user', text: '西湖边的蛋糕店。' }],
    });
    first.archiveTurn(turn);
    first.close();
    const recall = createRawRecall({
      config: resolveConfig({ rawRecall: true, rawRecallDbPath: db }),
      ownerSubject: () => 'owner:a', embedder: fakeEmbedder(), logger: { warn() {} },
    });
    const result = await recall.recall({ query: '西湖', budget: 500 });
    await recall.dispose();
    assert.equal(result.reason, 'ok');
    assert.match(result.text, /西湖/);
    return { reason: result.reason, recovered: true };
  });

  await check('scope switching cannot read the previous owner and empty scope is refused', async () => {
    const db = path.join(temp, 'scope.sqlite');
    let owner = 'owner:a';
    const recall = createRawRecall({
      config: resolveConfig({ rawRecall: true, rawRecallDbPath: db }),
      ownerSubject: () => owner, embedder: fakeEmbedder(), logger: { warn() {} },
    });
    await recall.archiveTurn({
      sessionId: 's1', turn: 1, completedAt: T0,
      messages: [{ id: 'scope-u1', role: 'user', text: '西湖边的蛋糕店。' }],
    });
    await recall.flush();
    assert.match((await recall.recall({ query: '西湖', budget: 500 })).text, /西湖/);
    owner = 'owner:b';
    assert.equal((await recall.recall({ query: '西湖', budget: 500 })).reason, 'empty-store');
    owner = '';
    assert.equal((await recall.recall({ query: '西湖', budget: 500 })).reason, 'no-scope');
    await recall.dispose();
    return { ownerSwitchIsolated: true, emptyScopeRefused: true };
  });

  await check('disabled or cold recall leaves the existing fact budget unchanged', async () => {
    const db = path.join(temp, 'budget.sqlite');
    const longFact = '喜欢茉莉花茶，'.repeat(80);
    const tools = fakeTools((input) => {
      if (input.name === 'mcp__basic_memory__search_notes') {
        return mcpResult({ results: [{
          title: '长偏好', permalink: 'personal/facts/long', score: 0.9,
          matched_chunk: longFact, metadata: { memory_id: 'long-1', status: 'active' },
        }] });
      }
      if (input.name === 'mcp__basic_memory__read_note') {
        return mcpResult({
          title: '长偏好', permalink: 'personal/facts/long', checksum: 'c1',
          content: '# 长偏好\n\n- [preference] ' + longFact,
          frontmatter: { memory_id: 'long-1', status: 'active', memory_kind: 'fact' },
        });
      }
      throw new Error('unexpected tool ' + input.name);
    });
    const config = resolveConfig({ autoCapture: false, recentContext: false, maxContextChars: 1200 });
    const make = (extra, sessionId) => createBridge({
      config: { ...config, ...extra }, tools,
      llm: { async *stream() {} }, ownerSubject: () => 'owner:budget',
    });
    const plain = make({ rawRecall: false }, 'session-public-plain');
    const cold = make({ rawRecall: true, rawRecallDbPath: db, rawRecallEmbedder: fakeEmbedder() }, 'session-public-cold');
    const plainText = textOf(await runPreStep(plain, 'session-public-plain', 1, [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }]));
    const coldText = textOf(await runPreStep(cold, 'session-public-cold', 1, [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }]));
    await plain.dispose();
    await cold.dispose();
    assert.equal(coldText.length, plainText.length);
    assert.match(coldText, /茉莉花茶/);
    return { plainChars: plainText.length, coldChars: coldText.length, reservedBudgetWithoutCandidates: 0 };
  });
  await check('text-only retrieval needs no model and long quotes keep their adjacent conditions', async () => {
    const store = new RawMemoryStore(path.join(temp, 'text.sqlite'));
    const turn = buildTurn({ scope: 'owner:a', sessionId: 's-text', turn: 1, completedAt: T0,
      messages: [{ id: 'text-source', role: 'user', text: '沿路看树叶，'.repeat(100) + '围巾周日取，柜台只开到三点，超过时间别去。' }] });
    store.archiveTurn(turn);
    let calls = 0;
    const recall = createRawRecall({ config: resolveConfig({ rawRecall: true }), store, ownerSubject: 'owner:a',
      embedder: { modelKey: 'not-running', async embed() { calls++; throw Error('must not start'); }, dispose() {} } });
    try {
      const result = await recall.recall({ query: '围巾怎么取', mode: 'text', budget: 600 });
      assert.match(result.text, /围巾周日取/);
      assert.match(result.text, /只开到三点/);
      assert.match(result.text, /超过时间别去/);
      assert.ok(result.chars <= 600);
      assert.equal(calls, 0);
      return { chars: result.chars, modelCalls: calls, textTurns: result.retrieval.textTurns };
    } finally { await recall.dispose(); }
  });
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}

const output = {
  ok: checks.every((item) => item.ok),
  checks,
  environment: { node: process.version, platform: process.platform, arch: process.arch },
  note: 'Model-free structural verification; it does not prove embedding quality, answer accuracy or real-model latency.',
};
console.log(JSON.stringify(output, null, 2));
if (!output.ok) process.exitCode = 1;

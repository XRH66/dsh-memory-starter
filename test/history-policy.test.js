import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../lib/index.js';
import { createPersonalAccess } from '../lib/personal-access.js';
import { createPureGate } from '../lib/pure-gate.js';
import { createRecoveryStore } from '../lib/recovery.js';
import { RawMemoryStore } from '../lib/raw-rag/store.js';
import { resolveConfig } from '../lib/config.js';
import { memoryStore } from './fake-memory.js';
import { embeddingContract } from './embedding-fixture.js';
import {
  TARGET_SESSION,
  OTHER_SESSION,
  assistantMessage,
  directUser,
  fakeAgent,
  fakeLlm,
  runPreStep,
  turnEnd,
  turnStart,
  userMessage,
} from './helpers.js';

const CURRENT = '我今后改用青瓷杯喝茶，这是新的独立约定。';
const CURRENT_CAPTURE = JSON.stringify({
  actions: [{
    action: 'ADD', kind: 'fact', category: 'preference', subject: '用户', attribute: '饮茶杯具',
    value: '今后改用青瓷杯喝茶', occurred_at: '日期未明', evidence: CURRENT,
  }],
});
const BEFORE_USER = 'PRIVATE_OLD_USER_MARKER 我以前用玻璃杯。';
const BEFORE_ASSISTANT = 'PRIVATE_ECHO_MARKER 这是以前助手说过的话。';
const ECHO_ANSWER = '你之前说 PRIVATE_OLD_USER_MARKER，也提过 PRIVATE_ECHO_MARKER。好，我记住青瓷杯。';

function fakeEmbedder() {
  return {
    ...embeddingContract('fake-model:4', 4),
    async embed(texts) {
      return texts.map((text) => {
        const value = [0, 0, 0, 0];
        if (String(text).includes('青瓷')) value[0] = 1;
        if (String(text).includes('PRIVATE')) value[1] = 1;
        if (!value.some(Boolean)) value[3] = 1;
        return value;
      });
    },
    dispose() {},
  };
}

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-history-policy-'));
  const vaultPath = path.join(root, 'vault');
  await fs.mkdir(vaultPath);
  const config = resolveConfig({
    vaultPath,
    autoRecall: false,
    personalRecall: false,
    recentContext: false,
    maxTimelineEntries: 0,
    maxIndexNotes: 0,
    captureTimeoutMs: 2000,
    ...overrides,
  });
  const memory = memoryStore();
  t.after(async () => {
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'dafeiyu-history-policy-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, vaultPath, config, memory };
}

function service({ active = false, ready = true, userOnly, withPolicy = true } = {}) {
  return {
    check: () => ({ ready, active }),
    ...(withPolicy ? { historyPolicy: () => ({ userOnly }) } : {}),
  };
}

function accessFor(pureService, logger = { warn() {} }) {
  return createPersonalAccess({ getService: () => pureService, logger });
}

function historyMessages() {
  return [
    directUser(BEFORE_USER, 'prior-user'),
    {
      id: 'prior-assistant',
      role: 'assistant',
      content: [{ type: 'text', text: BEFORE_ASSISTANT }],
      source: { kind: 'model' },
    },
  ];
}

async function runTurn(bridge, agent, { userText = CURRENT, answer = ECHO_ANSWER, turn = 1, history = historyMessages() } = {}) {
  agent.session.deriveMessages = () => history;
  bridge.onSessionEvent(agent.session, turnStart(turn));
  const current = userMessage(userText, { id: 'current-user', time: Date.parse('2026-11-04T10:00:00.000Z') });
  bridge.onSessionEvent(agent.session, current);
  await runPreStep(bridge, { turn, agent, messages: [current.data] });
  bridge.onSessionEvent(agent.session, assistantMessage(turn, answer));
  bridge.onSessionEvent(agent.session, turnEnd(turn));
  await bridge.waitForIdle();
}

function promptOf(call) {
  return call.messages[0].content[0].text;
}

test('history policy is normal without a pure provider, but strict when an installed one cannot prove the session', () => {
  const agent = { session: { id: TARGET_SESSION } };
  const absent = createPureGate({ getService: () => undefined, logger: { warn() {} } }).historyPolicy(agent);
  assert.deepEqual([absent.installed, absent.userOnly, absent.reason], [false, false, 'not-installed']);

  const silent = createPureGate({ getService: () => ({ check: () => ({ ready: true, active: false }) }), logger: { warn() {} } })
    .historyPolicy(agent);
  assert.deepEqual([silent.installed, silent.supported, silent.userOnly, silent.reason], [true, false, true, 'unsupported']);

  const normal = createPureGate({ getService: () => ({ historyPolicy: () => ({ userOnly: false }) }), logger: { warn() {} } })
    .historyPolicy(agent);
  assert.deepEqual([normal.installed, normal.userOnly, normal.reason], [true, false, 'normal']);

  const strict = createPureGate({ getService: () => ({ historyPolicy: () => ({ userOnly: true }) }), logger: { warn() {} } })
    .historyPolicy(agent);
  assert.deepEqual([strict.installed, strict.userOnly, strict.reason], [true, true, 'user-only']);

  const failed = createPureGate({ getService: () => ({ historyPolicy: () => { throw Error('policy exploded'); } }), logger: { warn() {} } })
    .historyPolicy(agent);
  assert.deepEqual([failed.installed, failed.userOnly, failed.reason], [true, true, 'policy-failed']);
  assert.match(failed.error.message, /policy exploded/);

  const invalid = createPureGate({ getService: () => ({ historyPolicy: () => ({}) }), logger: { warn() {} } })
    .historyPolicy(agent);
  assert.deepEqual([invalid.userOnly, invalid.reason], [true, 'invalid-policy']);

  const unreadable = createPureGate({ getService: () => { throw Error('provider exploded'); }, logger: { warn() {} } })
    .historyPolicy(agent);
  assert.deepEqual([unreadable.userOnly, unreadable.reason], [true, 'service-unreadable']);

  const unresolved = createPureGate({ getService: () => ({ historyPolicy: () => ({ userOnly: false }) }), logger: { warn() {} } })
    .historyPolicy(undefined);
  assert.deepEqual([unresolved.userOnly, unresolved.reason], [true, 'unresolved-agent']);
});

test('userOnly keeps recall, capture, near chat, and raw archive on the current user message only', async (t) => {
  const f = await fixture(t, {
    autoRecall: true,
    personalRecall: true,
    recentContext: true,
    rawRecall: true,
  });
  const { root, memory } = f;
  const config = { ...f.config, rawRecallDbPath: path.join(root, 'raw.sqlite') };
  const llm = fakeLlm(CURRENT_CAPTURE);
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    access: accessFor(service({ userOnly: true })),
    findAgent: (id) => id === TARGET_SESSION ? fakeAgent(TARGET_SESSION) : undefined,
    ownerSubject: 'owner:test',
    rawRecallEmbedder: fakeEmbedder(),
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    await runTurn(bridge, fakeAgent(TARGET_SESSION));

    const searches = memory.tools.calls.filter((call) => call.name === 'mcp__basic_memory__search_notes');
    assert.ok(searches.length > 0, 'recall should still run for the new turn');
    for (const call of searches) {
      const query = String(call.arguments.query || '');
      assert.doesNotMatch(query, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);
    }
    assert.ok(searches.some((call) => String(call.arguments.query || '').includes('青瓷杯')));

    assert.equal(llm.calls.length, 1);
    const prompt = promptOf(llm.calls[0]);
    assert.match(prompt, /今后改用青瓷杯喝茶/);
    assert.doesNotMatch(prompt, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);
    assert.doesNotMatch(prompt, /FINAL ASSISTANT ANSWER/);

    const notes = [...memory.notes.values()];
    assert.ok(notes.some((note) => note.content.includes('青瓷杯')));
    for (const note of notes) assert.doesNotMatch(note.content, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);

    const recent = await bridge.recentContext.page({ maxChars: 2400 });
    assert.match(recent.text, /青瓷杯/);
    assert.doesNotMatch(recent.text, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);
    assert.doesNotMatch(recent.text, /助手：/);

    const raw = new RawMemoryStore(config.rawRecallDbPath);
    let turns;
    try { turns = raw.authorizedTurns('fake-model:4', { scope: 'owner:test' }); }
    finally { raw.close(); }
    assert.equal(turns.length, 1);
    assert.deepEqual(turns[0].messages.map((message) => message.role), ['user']);
    const rawText = turns[0].messages.map((message) => message.text).join('\n');
    assert.match(rawText, /青瓷杯/);
    assert.doesNotMatch(rawText, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);

    const status = (await bridge.getMemoryStatus(TARGET_SESSION)).jobs.at(-1);
    assert.equal(status.rawRecall.state, 'archived');
    assert.equal(status.rawRecall.scope, 'user-only');
    assert.equal((await bridge.getRecoveryState()).jobs.length, 0);
  } finally {
    await bridge.dispose();
  }
});

test('an installed pure service without historyPolicy is mixed-version strict, not normal', async (t) => {
  const { config, memory } = await fixture(t);
  const warnings = [];
  const llm = fakeLlm(CURRENT_CAPTURE);
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    access: accessFor(service({ userOnly: false, withPolicy: false }), { warn: (message) => warnings.push(message) }),
    findAgent: (id) => id === TARGET_SESSION ? fakeAgent(TARGET_SESSION) : undefined,
    logger: { warn: (message) => warnings.push(message) },
  });
  t.after(() => bridge.dispose());
  try {
    await runTurn(bridge, fakeAgent(TARGET_SESSION));
    assert.equal(llm.calls.length, 1);
    const prompt = promptOf(llm.calls[0]);
    assert.match(prompt, /今后改用青瓷杯喝茶/);
    assert.doesNotMatch(prompt, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);
    assert.doesNotMatch(prompt, /FINAL ASSISTANT ANSWER/);
    const notes = [...memory.notes.values()];
    assert.ok(notes.some((note) => note.content.includes('青瓷杯')));
    for (const note of notes) assert.doesNotMatch(note.content, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);
    assert.ok(warnings.some((message) => /historyPolicy|历史策略/.test(message)));
  } finally {
    await bridge.dispose();
  }
});

test('a pre-step before turn/start still resolves userOnly before building recall queries', async (t) => {
  const { config, memory } = await fixture(t, { autoRecall: true, personalRecall: false });
  const agent = fakeAgent(TARGET_SESSION);
  agent.session.deriveMessages = () => historyMessages();
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm: fakeLlm(CURRENT_CAPTURE),
    access: accessFor(service({ userOnly: true })),
    findAgent: (id) => id === TARGET_SESSION ? agent : undefined,
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    const current = directUser(CURRENT, 'current-user');
    await runPreStep(bridge, { agent, turn: 1, messages: [current] });
    const searches = memory.tools.calls.filter((call) => call.name === 'mcp__basic_memory__search_notes');
    assert.ok(searches.length > 0);
    for (const call of searches) {
      assert.doesNotMatch(String(call.arguments.query || ''), /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER/);
    }
    assert.ok(searches.some((call) => String(call.arguments.query || '').includes('青瓷杯')));
  } finally {
    await bridge.dispose();
  }
});

test('a new userOnly job is persisted without assistant or earlier history and its retry stays safe', async (t) => {
  const { config, memory } = await fixture(t);
  const llm = fakeLlm([new Error('offline once'), CURRENT_CAPTURE]);
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    access: accessFor(service({ userOnly: true })),
    findAgent: (id) => id === TARGET_SESSION ? fakeAgent(TARGET_SESSION) : undefined,
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    const agent = fakeAgent(TARGET_SESSION);
    await runTurn(bridge, agent);

    const pending = (await bridge.getRecoveryState()).jobs;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].historyPolicy, 'user-only');
    assert.equal(pending[0].historyUserOnly, true);
    assert.equal(pending[0].assistantText, '');
    assert.deepEqual(pending[0].priorUserMessages, []);

    assert.doesNotMatch(promptOf(llm.calls[0]), /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER|FINAL ASSISTANT ANSWER/);
    await bridge.retryPending({ force: true });
    await bridge.waitForIdle();
    assert.equal(llm.calls.length, 2);
    assert.doesNotMatch(promptOf(llm.calls[1]), /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER|FINAL ASSISTANT ANSWER/);
    assert.equal((await bridge.getRecoveryState()).jobs.length, 0);
    assert.ok([...memory.notes.values()].some((note) => note.content.includes('青瓷杯')));
  } finally {
    await bridge.dispose();
  }
});

function legacyJob(overrides = {}) {
  return {
    id: 'legacy-history-job',
    sessionId: TARGET_SESSION,
    turn: 1,
    userText: CURRENT,
    assistantText: BEFORE_ASSISTANT,
    priorUserMessages: [BEFORE_USER],
    sourceMessageId: 'current-user',
    sourceEventSeq: 1,
    sourceEventTime: Date.parse('2026-11-04T10:00:00.000Z'),
    target: { provider: 'fake-provider', model: 'fake-model' },
    attempts: 0,
    nextAttemptAt: 0,
    completed: {},
    ...overrides,
  };
}

function preparedAction(value = 'PRIVATE_ECHO_MARKER', attribute = '旧提取动作') {
  return {
    action: 'ADD', kind: 'fact', category: 'preference', subject: '用户', attribute,
    value, evidence: value, occurredAt: '日期未明',
  };
}

test('a strict legacy job with prepared actions or checkpoints is held instead of replaying them', async (t) => {
  const { config, memory } = await fixture(t);
  const store = createRecoveryStore(config);
  const job = legacyJob({
    actions: [preparedAction()],
    completed: { 0: { permalink: 'personal/chats/facts/legacy', action: 'ADD', value: 'PRIVATE_ECHO_MARKER' } },
  });
  await store.add(job);
  const llm = fakeLlm(CURRENT_CAPTURE);
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    recoveryStore: store,
    access: accessFor(service({ userOnly: true })),
    findAgent: (id) => id === TARGET_SESSION ? fakeAgent(TARGET_SESSION) : undefined,
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    await bridge.retryPending({ force: true });
    assert.equal(llm.calls.length, 0);
    assert.equal(memory.notes.size, 0);

    const held = (await store.read()).jobs.find((item) => item.id === job.id);
    assert.ok(held);
    assert.deepEqual(held.actions, job.actions);
    assert.deepEqual(held.completed, job.completed);
    const status = (await bridge.getMemoryStatus(TARGET_SESSION)).jobs.find((item) => item.turn === 1);
    assert.equal(status.state, 'held');
    assert.equal(status.reason, 'history-policy-legacy-prepared');
  } finally {
    await bridge.dispose();
  }
});

test('a strict legacy job without prepared state is re-extracted from the current user text only', async (t) => {
  const { config, memory } = await fixture(t);
  const store = createRecoveryStore(config);
  await store.add(legacyJob());
  const llm = fakeLlm(CURRENT_CAPTURE);
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    recoveryStore: store,
    access: accessFor(service({ userOnly: true })),
    findAgent: (id) => id === TARGET_SESSION ? fakeAgent(TARGET_SESSION) : undefined,
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    await bridge.retryPending({ force: true });
    await bridge.waitForIdle();
    assert.equal(llm.calls.length, 1);
    const prompt = promptOf(llm.calls[0]);
    assert.match(prompt, /今后改用青瓷杯喝茶/);
    assert.doesNotMatch(prompt, /PRIVATE_OLD_USER_MARKER|PRIVATE_ECHO_MARKER|FINAL ASSISTANT ANSWER/);
    assert.ok([...memory.notes.values()].some((note) => note.content.includes('青瓷杯')));
    assert.equal((await store.read()).jobs.length, 0);
  } finally {
    await bridge.dispose();
  }
});

test('a legacy job cannot borrow another session normal policy when its own agent is unavailable', async (t) => {
  const { config, memory } = await fixture(t);
  const store = createRecoveryStore(config);
  await store.add(legacyJob());
  const llm = fakeLlm(CURRENT_CAPTURE);
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    recoveryStore: store,
    access: accessFor(service({ userOnly: false })),
    // The fallback runner may run tools for the shared project, but it must not
    // decide the original session's history policy.
    findAgent: () => fakeAgent(OTHER_SESSION),
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    await bridge.retryPending({ force: true });
    assert.equal(llm.calls.length, 0);
    assert.equal(memory.notes.size, 0);
    const status = (await bridge.getMemoryStatus(TARGET_SESSION)).jobs.find((item) => item.turn === 1);
    assert.equal(status.state, 'held');
    assert.equal(status.reason, 'history-policy-unavailable');
    assert.equal((await store.read()).jobs.length, 1);
  } finally {
    await bridge.dispose();
  }
});

test('a trusted normal legacy job keeps its persisted actions and checkpoints when no pure plugin is installed', async (t) => {
  const { config, memory } = await fixture(t);
  const store = createRecoveryStore(config);
  const first = preparedAction('已完成旧步骤');
  const second = preparedAction('未完成旧步骤');
  await store.add(legacyJob({
    actions: [first, second],
    completed: { 0: { permalink: 'personal/chats/facts/first', action: 'ADD', value: '已完成旧步骤' } },
    assistantText: BEFORE_ASSISTANT,
  }));
  const llm = fakeLlm(new Error('saved actions must not be synthesized again'));
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    recoveryStore: store,
    findAgent: () => fakeAgent(OTHER_SESSION),
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    await bridge.retryPending({ force: true });
    await bridge.waitForIdle();
    assert.equal(llm.calls.length, 0);
    const notes = [...memory.notes.values()];
    assert.equal(notes.length, 1);
    assert.match(notes[0].content, /未完成旧步骤/);
    assert.doesNotMatch(notes[0].content, /已完成旧步骤/);
    assert.equal((await store.read()).jobs.length, 0);
  } finally {
    await bridge.dispose();
  }
});

test('held legacy jobs are skipped without consuming the five runnable slots, and time order is preserved', async (t) => {
  const { config, memory } = await fixture(t);
  const store = createRecoveryStore(config);
  const sessions = ['session-held', 'session-old-1', 'session-old-2', 'session-old-3', 'session-old-4', 'session-new-late'];
  const pureService = {
    check: () => ({ ready: true, active: false }),
    historyPolicy: (agent) => ({ userOnly: agent.session.id === 'session-held' }),
  };
  await store.add(legacyJob({
    id: 'held-first',
    sessionId: 'session-held',
    sourceEventTime: 1,
    actions: [preparedAction('HELD_PRIVATE')],
    completed: { 0: { permalink: 'personal/chats/facts/held', action: 'ADD', value: 'HELD_PRIVATE' } },
  }));
  const expected = [];
  for (let index = 0; index < 4; index += 1) {
    const value = '旧任务' + (index + 1);
    expected.push(value);
    await store.add(legacyJob({
      id: 'old-' + (index + 1),
      sessionId: 'session-old-' + (index + 1),
      sourceEventTime: 10 + index,
      actions: [preparedAction(value, '任务' + (index + 1))],
    }));
  }
  expected.push('新任务');
  await store.add(legacyJob({
    id: 'new-late',
    sessionId: 'session-new-late',
    sourceEventTime: 20,
    historyPolicy: 'conversation',
    historyUserOnly: false,
    actions: [preparedAction('新任务', '任务-new')],
  }));

  const llm = fakeLlm(new Error('prepared actions must not call the model'));
  const bridge = createBridge({
    config,
    tools: memory.tools,
    llm,
    recoveryStore: store,
    access: accessFor(pureService),
    findAgent: (id) => sessions.includes(id) ? fakeAgent(id) : undefined,
    logger: { warn() {} },
  });
  t.after(() => bridge.dispose());
  try {
    await bridge.retryPending({ force: true });
    await bridge.waitForIdle();
    assert.deepEqual((await store.read()).jobs.map((job) => job.id), ['held-first']);
    const notes = [...memory.notes.values()];
    assert.equal(notes.length, 5, 'held job must not take one of the five slots');
    const contents = notes.map((note) => note.content);
    for (const [index, value] of expected.entries()) assert.match(contents[index], new RegExp(value));
    const held = (await bridge.getMemoryStatus('session-held')).jobs.find((job) => job.turn === 1);
    assert.equal(held.state, 'held');
    assert.equal(held.reason, 'history-policy-legacy-prepared');
  } finally {
    await bridge.dispose();
  }
});

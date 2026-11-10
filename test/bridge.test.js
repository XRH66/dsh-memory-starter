import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../lib/index.js';
import { expireMemoryContext } from '../lib/context.js';
import { RECENT_SOURCE } from '../lib/recent-context.js';
import { resolveConfig } from '../lib/config.js';
import {
  OTHER_SESSION,
  TARGET_SESSION as TARGET_SESSION_ID,
  assistantMessage,
  directUser,
  fakeAgent,
  fakeLlm,
  fakeTools,
  mcpError,
  mcpResult,
  runPreStep,
  syntheticMessage,
  turnEnd,
  turnStart,
  userMessage,
} from './helpers.js';
import { memoryStore } from './fake-memory.js';

const applyRoot=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-apply-test-'));
test.after(async()=>{
  assert.ok(path.resolve(applyRoot).startsWith(path.resolve(os.tmpdir())+path.sep+'dafeiyu-apply-test-'));
  await fs.rm(applyRoot,{recursive:true,force:true});
});

function recallTools() {
  return fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult({
        results: [{
          title: 'Tea preference',
          permalink: 'personal/chats/facts/tea',
          score: 0.9,
          matched_chunk: 'The user prefers jasmine tea.',
          metadata: { memory_id: 'memory-tea', status: 'active' },
        }],
      });
    }
    if (input.name === 'mcp__basic_memory__read_note') {
      return mcpResult({
        title: 'Tea preference',
        permalink: 'personal/chats/facts/tea',
        checksum: 'c1',
        content: '# Tea preference\n\n- [preference] The user prefers jasmine tea.',
        frontmatter: { memory_id: 'memory-tea', status: 'active', memory_kind: 'fact' },
      });
    }
    throw new Error('unexpected tool ' + input.name);
  });
}

function searchCount(tools) {
  return tools.calls.filter((call) => call.name === 'mcp__basic_memory__search_notes').length;
}

function captureTools(writes) {
  return fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') return mcpResult({ results: [] });
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    if (input.name === 'mcp__basic_memory__read_note') {
      return mcpResult({ title: 'Tea preference', permalink: 'personal/chats/facts/tea', checksum: 'c1', content: '# Tea preference\n\n- [preference] The user prefers jasmine tea.', frontmatter: { memory_id: 'memory-tea', status: 'active', memory_kind: 'fact' } });
    }
    if (input.name === 'mcp__basic_memory__write_note') {
      writes.push(input.arguments);
      return mcpResult({ action: 'created', permalink: 'personal/' + String(input.arguments.directory) + '/note', checksum: 'c1', file_path: '/fixture-vault/' + String(input.arguments.directory) + '/note.md' });
    }
    throw new Error('unexpected tool ' + input.name);
  });
}

const CAPTURE_JSON = JSON.stringify({
  actions: [{
    action: 'ADD', kind: 'fact', category: 'preference', subject: '用户', attribute: '茶',
    value: '喜欢茉莉花茶', occurred_at: '日期未明', evidence: 'I prefer jasmine tea.',
  }],
});

function makeBridge(overrides = {}) {
  const writes = [];
  const tools = overrides.tools ?? captureTools(writes);
  const llm = overrides.llm ?? fakeLlm(CAPTURE_JSON);
  const warnings = [];
  const bridge = createBridge({
    config: resolveConfig(overrides.config ?? {}),
    tools,
    llm,
    logger: { warn: (message) => warnings.push(message) },
    now: () => new Date('2026-10-24T03:00:00.000Z'),
  });
  return { bridge, writes, tools, llm, warnings };
}

async function emitTurn(bridge, { turn, userText = 'I prefer jasmine tea.', answer = 'Noted.', reason = 'completed', interrupted = false, messageId, eventSeq }) {
  const agent = fakeAgent(TARGET_SESSION_ID);
  bridge.onSessionEvent(agent.session, turnStart(turn));
  const user = userMessage(userText);
  if (messageId) user.data.id = messageId;
  if (eventSeq !== undefined) user.seq = eventSeq;
  bridge.onSessionEvent(agent.session, user);
  // Associate the real per-turn agent without asking for a recall on empty input.
  await runPreStep(bridge, { turn, agent, messages: [] });
  bridge.onSessionEvent(agent.session, assistantMessage(turn, answer, interrupted));
  bridge.onSessionEvent(agent.session, turnEnd(turn, reason));
  await bridge.waitForIdle(TARGET_SESSION_ID);
}

test('permanent delete is hidden per agent while other Basic Memory tools stay available', async () => {
  const definitions = new Map();
  const hidden = new Set();
  const guards = [];
  const makeDefinition = (toolName) => ({ name: toolName, execute() {} });
  for (const toolName of [
    'mcp__basic_memory__search_notes',
    'mcp__basic_memory__read_note',
    'mcp__basic_memory__write_note',
    'mcp__basic_memory__edit_note',
    'mcp__basic_memory__move_note',
  ]) definitions.set(toolName, makeDefinition(toolName));

  const tools = {
    get(toolName) {
      return hidden.has(toolName) ? undefined : definitions.get(toolName);
    },
  };
  const agent = {
    session: { id: TARGET_SESSION_ID },
    ctx: {
      tools: {
        guard(guard) { guards.push(guard); return () => {}; },
        restrict({ deny }) {
          for (const toolName of deny) hidden.add(toolName);
          return () => {};
        },
      },
    },
  };
  const { bridge } = makeBridge({ tools, config: { autoRecall: false, autoCapture: false } });
  assert.equal(tools.get('mcp__basic_memory__delete_note', agent), undefined);
  assert.equal(tools.get('mcp__basic_memory__delete_project', agent), undefined);

  // Async MCP registration: the turn starts before the delete tools exist. The
  // guard is installed immediately, then tools/change/refresh hides later tools.
  await runPreStep(bridge, { turn: 1, agent, messages: [] });
  assert.equal(guards.length, 1);
  assert.equal(guards[0]({ name: 'mcp__basic_memory__read_note' }), undefined);
  assert.match(guards[0]({ name: 'mcp__basic_memory__delete_note' }), /Permanent deletion is disabled/);
  assert.match(guards[0]({ name: 'mcp__basic_memory__delete_project' }), /Permanent deletion is disabled/);

  definitions.set('mcp__basic_memory__delete_note', makeDefinition('mcp__basic_memory__delete_note'));
  definitions.set('mcp__basic_memory__delete_project', makeDefinition('mcp__basic_memory__delete_project'));
  assert.ok(tools.get('mcp__basic_memory__delete_note', agent));
  assert.ok(tools.get('mcp__basic_memory__delete_project', agent));
  bridge.refreshPermanentDeleteProtection();
  assert.equal(tools.get('mcp__basic_memory__delete_note', agent), undefined);
  assert.equal(tools.get('mcp__basic_memory__delete_project', agent), undefined);
  for (const toolName of [
    'mcp__basic_memory__search_notes',
    'mcp__basic_memory__read_note',
    'mcp__basic_memory__write_note',
    'mcp__basic_memory__edit_note',
    'mcp__basic_memory__move_note',
  ]) assert.ok(tools.get(toolName, agent), toolName);
});

const THIRD_SESSION = 'session-11111111-1111-1111-1111-111111111111';

test('non-target sessions without basic memory never recall or capture', async () => {
  const tools = { get: () => undefined, calls: [] };
  const { bridge } = makeBridge({ tools, config: { autoCapture: false } });
  await runPreStep(bridge, { sessionId: OTHER_SESSION, messages: [directUser('tea')] });
  assert.equal(tools.calls.length, 0);

  bridge.onSessionEvent({ id: OTHER_SESSION }, turnStart(1));
  bridge.onSessionEvent({ id: OTHER_SESSION }, userMessage('I prefer jasmine tea.'));
  bridge.onSessionEvent({ id: OTHER_SESSION }, assistantMessage(1, 'Noted.'));
  bridge.onSessionEvent({ id: OTHER_SESSION }, turnEnd(1));
  await bridge.waitForIdle(OTHER_SESSION);
  assert.equal(tools.calls.length, 0);
});

test('personal recall serves any session with basic memory, without turning on fact recall or capture', async () => {
  for (const sessionId of [OTHER_SESSION, THIRD_SESSION]) {
    const tools = fakeTools((input) => {
      if (input.name === 'mcp__basic_memory__search_notes') {
        return mcpResult({
          results: [{ title: 'Thought', permalink: 'dafeiyu/thoughts/x', score: 1, matched_chunk: '老大更喜欢先看结论。' }],
        });
      }
      if (input.name === 'mcp__basic_memory__read_note') return mcpResult({ content: '老大更喜欢先看结论。', frontmatter: { status: 'active' } });
      throw new Error('unexpected tool ' + input.name);
    });
    const { bridge } = makeBridge({ tools, config: { autoRecall: false, autoCapture: false } });

    const decision = await runPreStep(bridge, {
      sessionId,
      messages: [directUser('老大喜欢先看结论还是过程？')],
    });
    const personal = (decision.messages ?? []).find((message) => message.source.kind === 'basic-memory-context');
    assert.ok(personal, sessionId);
    assert.match(personal.content[0].text, /dafeiyu\/thoughts/);
    assert.equal(tools.calls.length, 2, sessionId);
    assert.equal(tools.calls[1].name, 'mcp__basic_memory__read_note');
    assert.deepEqual(tools.calls[0].arguments.tags, ['subjective'], sessionId);

    bridge.onSessionEvent({ id: sessionId }, turnStart(1));
    bridge.onSessionEvent({ id: sessionId }, userMessage('老大喜欢先看结论还是过程？'));
    bridge.onSessionEvent({ id: sessionId }, assistantMessage(1, 'Noted.'));
    bridge.onSessionEvent({ id: sessionId }, turnEnd(1));
    await bridge.waitForIdle(sessionId);
    assert.equal(tools.calls.length, 2, sessionId + ' must not capture');
  }
});


test('personal recall is skipped when the found notes are unrelated to the turn', async () => {
  const tools = fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult({
        results: [{ title: 'Thought', permalink: 'dafeiyu/thoughts/x', score: 1, matched_chunk: '今天想吃白米饭。' }],
      });
    }
    throw new Error('unexpected tool ' + input.name);
  });
  const { bridge } = makeBridge({ tools, config: { autoRecall: false, autoCapture: false } });
  const decision = await runPreStep(bridge, {
    sessionId: OTHER_SESSION,
    messages: [directUser('这段 Node 代码为什么报错？')],
  });
  const messages = decision.messages ?? [];
  assert.equal(messages.some((message) => message.source.kind === 'basic-memory-context'), false);
  assert.equal(messages.some((message) => message.source.kind === 'basic-memory-context'), false);
  assert.ok(messages.some((message) => message.source.kind === 'dafeiyu-memory-control'));
});

test('fact and index searches each run once per direct-user turn, never later steps', async () => {
  const tools = recallTools();
  const { bridge } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const byChannel = (index) => tools.calls.filter((call) => call.name === 'mcp__basic_memory__search_notes' && Boolean(call.arguments.tags?.includes('index')) === index).length;

  const first = await runPreStep(bridge, { turn: 5, step: 1, messages: [directUser('What tea do I like?')] });
  assert.equal(byChannel(false), 1);
  assert.equal(byChannel(true), 1);
  assert.ok((first.messages ?? []).some((message) => message.source.kind === 'basic-memory-context'));
  assert.ok((first.messages ?? []).some((message) => message.source.kind === 'dafeiyu-memory-control'));

  await runPreStep(bridge, { turn: 5, step: 1, messages: [directUser('What tea do I like?')] });
  await runPreStep(bridge, { turn: 5, step: 2, messages: [] });
  await runPreStep(bridge, { turn: 5, step: 3, messages: [syntheticMessage('runtime context')] });
  assert.equal(byChannel(false), 1);
  assert.equal(byChannel(true), 1);

  await runPreStep(bridge, { turn: 6, step: 1, messages: [directUser('Anything else?')] });
  assert.equal(byChannel(false), 2);
  assert.equal(byChannel(true), 2);
});

test('recall is skipped for synthetic-only steps, disabled config, and rejected decisions', async () => {
  const tools = recallTools();
  const { bridge } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const agent = fakeAgent(TARGET_SESSION_ID);

  await runPreStep(bridge, { messages: [syntheticMessage('only context')], agent });
  assert.equal(tools.calls.length, 0);

  const disabled = makeBridge({ tools, config: { autoRecall: false, autoCapture: false, personalRecall: false } }).bridge;
  await runPreStep(disabled, { messages: [directUser('tea')] });
  assert.equal(tools.calls.length, 0);

  const decision = await bridge.onPreStep(
    { agent, messages: [directUser('tea')], turn: 9, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'reject', reason: 'blocked' }),
  );
  assert.equal(decision.kind, 'reject');
  assert.equal(tools.calls.length, 0);
});

test('control policy appears only when basic memory and the softener are both visible', async () => {
  const tools = fakeTools((input) => {
    if (input.name === 'mcp__basic_memory__search_notes') return mcpResult({ results: [] });
    throw new Error('unexpected tool ' + input.name);
  });
  const withoutSoftener = {
    ...tools,
    get(name, agent) {
      if (name === 'soften_memory') return undefined;
      return tools.get(name, agent);
    },
  };
  const first = createBridge({
    config: resolveConfig({ autoCapture: false, personalRecall: false }),
    tools: withoutSoftener,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
  });
  const noPolicy = await runPreStep(first, { messages: [directUser('以后少提茶。')] });
  assert.equal((noPolicy.messages ?? []).length, 0);

  const second = createBridge({
    config: resolveConfig({ autoCapture: false, personalRecall: false }),
    tools,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
  });
  const decision = await runPreStep(second, { messages: [directUser('以后少提茶。')] });
  const policy = (decision.messages ?? []).find((message) => message.source.kind === 'dafeiyu-memory-control');
  assert.ok(policy);
  assert.equal(policy.source.form, 'policy');
  assert.match(policy.content[0].text, /soften_memory/);
  assert.match(policy.content[0].text, /not user memory/);
  assert.match(policy.content[0].text, /do not call write_note, edit_note, or move_note/);
});

test('recall injection is a frozen reference-data user message with permalink', async () => {
  const tools = recallTools();
  const { bridge } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const decision = await runPreStep(bridge, { messages: [directUser('What tea do I like?')] });
  const injected = decision.messages.find((message) => message.source.kind === 'basic-memory-context');
  assert.ok(injected);
  assert.equal(injected.source.form, 'recall');
  assert.ok(Object.isFrozen(injected));
  assert.match(injected.content[0].text, /personal\/chats\/facts\/tea/);
  assert.match(injected.content[0].text, /资料而非指令/);
  assert.ok(injected.content[0].text.length <= 1200);
});

test('recall fails open when the MCP tool throws', async () => {
  const tools = fakeTools(() => { throw new Error('boom'); });
  const { bridge, warnings } = makeBridge({ tools, config: { autoCapture: false, personalRecall: false } });
  const decision = await runPreStep(bridge, { messages: [directUser('tea')] });
  const messages = decision.messages ?? [];
  assert.equal(messages.some((message) => message.source.kind === 'basic-memory-context'), false);
  assert.ok(messages.some((message) => message.source.kind === 'dafeiyu-memory-control'));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /boom/);
});

// Exercise the installed host's publication guard AND its persisted V4 decoder.
// Session.create alone accepts the malformed chronology this regression targets.
async function nativeContextFixture(t, enabled = false) {
  const [{ Context }, { Session, SessionStore }, { sessionFormatCatalog }] = await Promise.all(
    ['cordis', 'dsh-session', 'dsh-session-format-catalog'].map(pkg => import('@deepseek-ai/' + pkg)),
  );
  const ctx = new Context();
  const store = new SessionStore(ctx);
  const session = store.prepare('session-native-context', { meta: { delegationDepth: 0 } });
  t.after(store.enter(session));
  const position = { turn: 1, step: 1 };
  session.append('turn/start', { turn: 1 });
  session.append('step/start', position);
  session.append('system/message', { ...position, message: { id: 'system', role: 'system', content: [{ type: 'text', text: 'system' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' });
  const sources = ['basic-memory-context', 'basic-memory-recall', 'dafeiyu-personal-recall', 'basic-memory-navigation', 'basic-memory-timeline', 'dafeiyu-memory-control', RECENT_SOURCE];
  const old = sources.map((kind, index) => {
    if (index === 2) session.append('user/message', directUser('previous human', 'human-1'), { surfaceOp: 'append' });
    return session.append('user/message', { ...directUser('old ' + kind, 'old-' + index), source: { kind } }, { surfaceOp: 'append' });
  });
  session.append('user/message', { ...directUser('unrelated context', 'other-context'), source: { kind: 'time-context' } }, { surfaceOp: 'append' });
  session.append('assistant/message', { ...position, stream: [], message: { id: 'answer-1', role: 'assistant', content: [{ type: 'text', text: 'previous answer' }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append' });
  session.append('step/end', position);
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const original = structuredClone([...session.log]);
  const bridge = createBridge({
    config: { vaultPath: '', autoCapture: false, autoRecall: enabled, personalRecall: false, recentContext: false, maxTimelineEntries: 0, maxIndexNotes: 0 },
    tools: enabled ? recallTools() : { get: () => null },
    llm: { stream() { throw new Error('native context regression must not request a model'); } },
  });
  t.after(() => bridge.dispose());
  t.after(ctx.on('session/event', bridge.onSessionEvent));
  const agent = fakeAgent(session.id);
  agent.session = session;
  const payload = (turn = 2, step = 1) => ({ agent, turn, step, messages: [directUser('What tea do I prefer?', 'human-' + turn)] });
  async function preStep(input = payload(), decision = { kind: 'enter', messages: input.messages }) {
    return bridge.onPreStep(input, async () => decision);
  }
  async function replay(label) {
    const file = path.join(applyRoot, 'native-context-' + label + '.jsonl');
    const rows = [sessionFormatCatalog.encodeCurrentHeader(session.header, 0), ...session.log.map(event => sessionFormatCatalog.encodeCurrentEvent(event))];
    await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const [header, ...events] = (await fs.readFile(file, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' });
    for (const row of events) restore.decodeRow(row);
    const artifact = restore.finish();
    return Session.fromRestore(session.id, artifact.events, artifact.header, artifact.inheritedEventCount, 'detached');
  }
  return { session, bridge, ctx, Session, old, original, payload, preStep, replay };
}

test('native context expiry: strict persisted replay rejects the old pre-step chronology', async t => {
  const f = await nativeContextFixture(t);
  await f.replay('valid-seed');
  f.session.append('turn/start', { turn: 2 });
  const source = f.old[0];
  // Exact former producer event, deliberately before step/start.
  f.session.append('developer/message', { turn: 2, step: 1, message: { id: 'old-expiry', role: 'developer', content: [], source: { kind: 'basic-memory-context', form: 'expired' } } },
    { surfaceOp: { op: 'replace', startSeq: source.seq, endSeq: source.seq }, sourceEventSeqs: [source.seq] });
  f.session.append('step/start', { turn: 2, step: 1 });
  assert.doesNotThrow(() => f.Session.create(f.session.id, [...f.session.log], f.session.header));
  await assert.rejects(f.replay('old-timing'), /developer\/message does not match an open turn and step/);
});

for (const enabled of [true, false]) test(`native context expiry: ${enabled ? 'enabled memory' : 'pure mode'} clears at request boundary and survives strict replay`, async t => {
  const f = await nativeContextFixture(t, enabled);
  const input = f.payload();
  f.session.append('turn/start', { turn: 2 });
  const decision = await f.preStep(input);
  await f.replay('pre-step-' + enabled); // Red on the actual former onPreStep producer.
  assert.equal(f.session.log.filter(e => e.type === 'developer/message').length, 0);
  assert.deepEqual((await f.bridge.getMemoryStatus(f.session.id)).jobs.at(-1).recall.expired, { messages: 0, chars: 0 });
  f.session.append('step/start', { turn: 2, step: 1 });
  assert.equal(f.session.log.filter(e => e.type === 'developer/message').length, 0, 'no reentrant append from session/event');
  const requestConfig = { provider: 'fixture', model: 'fixture' };
  assert.equal(await f.bridge.onRequest(input, async () => requestConfig), requestConfig);
  const expected = { messages: f.old.length, chars: f.old.reduce((n, e) => n + e.data.content[0].text.length, 0) };
  const status = (await f.bridge.getMemoryStatus(f.session.id)).jobs.at(-1).recall;
  assert.deepEqual(status.expired, expected);
  assert.ok(status.channels, 'expiry update preserves recall diagnostics');
  assert.equal(status.totalChars, decision.messages.filter(m => m.source.kind !== 'user').reduce((n, m) => n + m.content[0].text.length, 0));
  assert.deepEqual(f.session.deriveMessages().map(m => m.id), ['system', 'human-1', 'other-context', 'answer-1']);
  for (const message of decision.messages) f.session.append('user/message', message, { surfaceOp: 'append' });
  const admitted = structuredClone(f.session.deriveMessages());
  const seq = f.session.seq;
  await f.bridge.onRequest(input, async () => requestConfig); // Adapter retry in the same step.
  assert.equal(f.session.seq, seq, 'retry must not expire current-turn additions');
  f.session.append('step/end', { turn: 2, step: 1 });
  f.session.append('step/start', { turn: 2, step: 2 });
  await f.bridge.onRequest(f.payload(2, 2), async () => requestConfig);
  assert.deepEqual(f.session.deriveMessages(), admitted, 'tool continuation retains current context');
  f.session.append('step/end', { turn: 2, step: 2 });
  f.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  const restored = await f.replay('corrected-' + enabled);
  assert.deepEqual(restored.deriveMessages(), admitted);
  assert.deepEqual([...f.session.log].slice(0, f.original.length), f.original, 'raw history is unchanged');
  const replacements = f.session.log.filter(e => e.type === 'developer/message');
  assert.equal(replacements.length, 2, 'only contiguous bridge-owned groups are replaced');
  assert.ok(replacements.every(e => e.seq > f.session.log.find(e => e.type === 'step/start' && e.data.turn === 2).seq));
  assert.deepEqual((await f.bridge.getMemoryStatus(f.session.id)).jobs.find(j => j.turn === 2).recall.expired, expected);
});

test('native context expiry: rejected and aborted pre-steps leave a valid unentered turn', async t => {
  for (const mode of ['rejected', 'aborted']) {
    const f = await nativeContextFixture(t);
    f.session.append('turn/start', { turn: 2 });
    const input = { ...f.payload(), signal: AbortSignal.abort() };
    await f.preStep(input, mode === 'rejected' ? { kind: 'reject' } : { kind: 'enter', messages: input.messages });
    f.session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } });
    assert.deepEqual((await f.replay(mode)).deriveMessages(), f.session.deriveMessages());
    assert.equal(f.session.log.filter(e => e.type === 'developer/message').length, 0);
    f.session.append('turn/start', { turn: 3 });
    await f.preStep(f.payload(3));
    f.session.append('step/start', { turn: 3, step: 1 });
    await f.bridge.onRequest(f.payload(3), async () => ({}));
    await f.replay(mode + '-next-turn');
    assert.deepEqual((await f.bridge.getMemoryStatus(f.session.id)).jobs.at(-1).recall.expired.messages, f.old.length);
  }
});

test('native context expiry: direct cleanup refuses unopened or closed steps without mutating the log', async t => {
  const f = await nativeContextFixture(t);
  f.session.append('turn/start', { turn: 2 });
  const seq = f.session.seq;
  assert.throws(() => expireMemoryContext(f.session, { turn: 2, step: 1 }), /open turn and step/);
  assert.equal(f.session.seq, seq);
  f.session.append('step/start', { turn: 2, step: 1 });
  f.session.append('step/end', { turn: 2, step: 1 });
  assert.throws(() => expireMemoryContext(f.session, { turn: 2, step: 1 }), /open turn and step/);
  await f.replay('invalid-expiry-refused');
});

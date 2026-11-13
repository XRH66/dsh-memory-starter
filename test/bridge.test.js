import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createBridge} from '../lib/index.js';
import {expireMemoryContext} from '../lib/context.js';
import {RECENT_SOURCE} from '../lib/recent-context.js';
import {directUser, fakeAgent} from './helpers.js';

const applyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-apply-test-'));
test.after(async () => {
  assert.ok(path.resolve(applyRoot).startsWith(path.resolve(os.tmpdir()) + path.sep + 'dafeiyu-apply-test-'));
  await fs.rm(applyRoot, {recursive: true, force: true});
});

function sessionAccess(session) {
  const controller = new AbortController();
  const grantFor = agent => ({
    sessionId: agent?.session?.id ?? session.id,
    ownerSubject: 'fixture-owner',
    project: 'personal',
    epoch: 'fixture-epoch',
    signal: controller.signal,
  });
  return {
    ready: true,
    ownerSubject: 'fixture-owner',
    check: agent => agent?.session?.id === session.id
      ? {allowed: true, requested: true, epoch: 'fixture-epoch'}
      : {allowed: false, requested: false, epoch: 'fixture-epoch'},
    status: id => id === session.id
      ? {sessionId: id, requested: true, active: true, pending: false, epoch: 'fixture-epoch'}
      : {sessionId: id, requested: false, active: false, pending: false, epoch: 'fixture-epoch'},
    grant: agent => grantFor(agent),
    validate: grant => Boolean(grant),
    validateMessage: grant => Boolean(grant),
    withGrant: async (_grant, work) => work(),
    assertCurrent: agent => {
      if (agent?.session?.id !== session.id) throw Error('fixture authorization changed');
    },
    admitMessage: () => null,
    observe: () => true,
    isRootAgent: () => true,
    subscribe: () => () => {},
    assertCurrentSource: () => true,
  };
}

async function nativeContextFixture(t) {
  const [{Context}, {Session, SessionStore}, {sessionFormatCatalog}] = await Promise.all(
    ['cordis', 'dsh-session', 'dsh-session-format-catalog'].map(pkg => import('@deepseek-ai/' + pkg)),
  );
  const ctx = new Context();
  const store = new SessionStore(ctx);
  const session = store.prepare('session-native-context', {meta: {delegationDepth: 0}});
  t.after(store.enter(session));
  const position = {turn: 1, step: 1};
  session.append('turn/start', {turn: 1});
  session.append('step/start', position);
  session.append('system/message', {
    ...position,
    message: {id: 'system', role: 'system', content: [{type: 'text', text: 'system'}], source: {kind: 'system-prompt'}},
  }, {surfaceOp: 'append'});
  const sources = [
    'basic-memory-context',
    'basic-memory-recall',
    'dafeiyu-personal-recall',
    'basic-memory-navigation',
    'basic-memory-timeline',
    'dafeiyu-memory-control',
    'memory-prefetch',
    'memory-answer-rules',
    RECENT_SOURCE,
  ];
  const old = sources.map((kind, index) => {
    if (index === 2) session.append('user/message', directUser('previous human', 'human-1'), {surfaceOp: 'append'});
    return session.append('user/message', {
      ...directUser('old ' + kind, 'old-' + index),
      source: {kind},
    }, {surfaceOp: 'append'});
  });
  session.append('user/message', {...directUser('unrelated context', 'other-context'), source: {kind: 'time-context'}}, {surfaceOp: 'append'});
  session.append('assistant/message', {
    ...position,
    stream: [],
    message: {
      id: 'answer-1',
      role: 'assistant',
      content: [{type: 'text', text: 'previous answer'}],
      source: {kind: 'model', provider: 'fixture', model: 'fixture'},
    },
  }, {surfaceOp: 'append'});
  session.append('step/end', position);
  session.append('turn/end', {turn: 1, reason: {kind: 'completed'}});
  const original = structuredClone([...session.log]);
  const access = sessionAccess(session);
  const bridge = createBridge({
    config: {vaultPath: '', autoCapture: false, autoRecall: false, recentContext: false},
    tools: {get: () => null},
    llm: {stream() {throw new Error('native context regression must not request a model');}},
    access,
  });
  t.after(() => bridge.dispose());
  t.after(ctx.on('session/event', bridge.onSessionEvent));
  const agent = fakeAgent(session.id);
  agent.session = session;
  const payload = (turn = 2, step = 1) => ({agent, turn, step, messages: [directUser('What tea do I prefer?', 'human-' + turn)]});
  async function preStep(input = payload(), decision = {kind: 'enter', messages: input.messages}) {
    return bridge.onPreStep(input, async () => decision);
  }
  async function replay(label) {
    const file = path.join(applyRoot, 'native-context-' + label + '.jsonl');
    const rows = [
      sessionFormatCatalog.encodeCurrentHeader(session.header, 0),
      ...session.log.map(event => sessionFormatCatalog.encodeCurrentEvent(event)),
    ];
    await fs.writeFile(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const [header, ...events] = (await fs.readFile(file, 'utf8')).trim().split('\n').map(row => JSON.parse(row));
    const restore = sessionFormatCatalog.createRestore(header, {recovery: 'strict', validation: 'current'});
    for (const row of events) restore.decodeRow(row);
    const artifact = restore.finish();
    return Session.fromRestore(session.id, artifact.events, artifact.header, artifact.inheritedEventCount, 'detached');
  }
  return {session, bridge, ctx, Session, old, original, payload, preStep, replay};
}

test('native context expiry: strict persisted replay rejects the old pre-step chronology', async t => {
  const f = await nativeContextFixture(t);
  await f.replay('valid-seed');
  f.session.append('turn/start', {turn: 2});
  const source = f.old[0];
  f.session.append('developer/message', {
    turn: 2,
    step: 1,
    message: {id: 'old-expiry', role: 'developer', content: [], source: {kind: 'basic-memory-context', form: 'expired'}},
  }, {
    surfaceOp: {op: 'replace', startSeq: source.seq, endSeq: source.seq},
    sourceEventSeqs: [source.seq],
  });
  f.session.append('step/start', {turn: 2, step: 1});
  assert.doesNotThrow(() => f.Session.create(f.session.id, [...f.session.log], f.session.header));
  await assert.rejects(f.replay('old-timing'), /developer\/message does not match an open turn and step/);
});

test('native context expiry clears at request boundary and survives strict replay in session-memory mode', async t => {
  const f = await nativeContextFixture(t);
  const input = f.payload();
  f.session.append('turn/start', {turn: 2});
  const decision = await f.preStep(input);
  await f.replay('pre-step-session-memory');
  assert.equal(f.session.log.filter(e => e.type === 'developer/message').length, 0);
  f.session.append('step/start', {turn: 2, step: 1});
  assert.equal(f.session.log.filter(e => e.type === 'developer/message').length, 0, 'no reentrant append from session/event');
  const requestConfig = {provider: 'fixture', model: 'fixture'};
  assert.equal(await f.bridge.onRequest(input, async () => requestConfig), requestConfig);
  const expected = {messages: f.old.length, chars: f.old.reduce((n, e) => n + e.data.content[0].text.length, 0)};
  const status = (await f.bridge.getMemoryStatus(f.session.id)).jobs.at(-1).recall;
  assert.deepEqual(status.expired, expected);
  assert.deepEqual(decision.messages.slice(1).map(message => message.source.kind), ['memory-answer-rules']);
  assert.deepEqual(f.session.deriveMessages().map(m => m.id), ['system', 'human-1', 'other-context', 'answer-1']);
  for (const message of decision.messages) f.session.append('user/message', message, {surfaceOp: 'append'});
  const admitted = structuredClone(f.session.deriveMessages());
  const seq = f.session.seq;
  await f.bridge.onRequest(input, async () => requestConfig);
  assert.equal(f.session.seq, seq, 'retry must not expire current-turn additions');
  f.session.append('step/end', {turn: 2, step: 1});
  f.session.append('step/start', {turn: 2, step: 2});
  await f.bridge.onRequest(f.payload(2, 2), async () => requestConfig);
  assert.deepEqual(f.session.deriveMessages(), admitted, 'tool continuation retains current context');
  f.session.append('step/end', {turn: 2, step: 2});
  f.session.append('turn/end', {turn: 2, reason: {kind: 'completed'}});
  const restored = await f.replay('corrected-session-memory');
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
    f.session.append('turn/start', {turn: 2});
    const input = {...f.payload(), signal: AbortSignal.abort()};
    await f.preStep(input, mode === 'rejected' ? {kind: 'reject'} : {kind: 'enter', messages: input.messages});
    f.session.append('turn/end', {turn: 2, reason: {kind: 'blocked'}});
    assert.deepEqual((await f.replay(mode)).deriveMessages(), f.session.deriveMessages());
    assert.equal(f.session.log.filter(e => e.type === 'developer/message').length, 0);
    f.session.append('turn/start', {turn: 3});
    await f.preStep(f.payload(3));
    f.session.append('step/start', {turn: 3, step: 1});
    await f.bridge.onRequest(f.payload(3), async () => ({}));
    await f.replay(mode + '-next-turn');
    assert.deepEqual((await f.bridge.getMemoryStatus(f.session.id)).jobs.at(-1).recall.expired.messages, f.old.length);
  }
});

test('native context expiry: direct cleanup refuses unopened or closed steps without mutating the log', async t => {
  const f = await nativeContextFixture(t);
  f.session.append('turn/start', {turn: 2});
  const seq = f.session.seq;
  assert.throws(() => expireMemoryContext(f.session, {turn: 2, step: 1}), /open turn and step/);
  assert.equal(f.session.seq, seq);
  f.session.append('step/start', {turn: 2, step: 1});
  f.session.append('step/end', {turn: 2, step: 1});
  assert.throws(() => expireMemoryContext(f.session, {turn: 2, step: 1}), /open turn and step/);
  await f.replay('invalid-expiry-refused');
});

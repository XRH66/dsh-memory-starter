import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSessionMemory } from '../lib/session-memory.js';
import { Session } from '@deepseek-ai/dsh-session';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-session-memory-'));
  const actors = new Map(), records = new Map(), owners = new Map();
  const agents = { get: id => actors.get(id), list: () => [...actors.values()], isOwnedBy: (id, owner) => owners.get(id) === owner };
  const sessions = { get: id => records.get(id) };
  const options = { directory, ownerSubject: '测试用户', agents, sessions, logger: { warn() {} } };
  let memory = await createSessionMemory(options);
  t.after(async () => {
    memory.close();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(os.tmpdir()), 'dsh-session-memory-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  function actor(id, { parent, seed = [], inherited = 0, header = {} } = {}) {
    const events = [...seed];
    const session = { id, header: { id, ...header }, inheritedEventCount: inherited,
      get seq() { return events.length; }, snapshotEvents: (from = 0, to = events.length) => events.slice(from, to) };
    const agent = { id, session };
    actors.set(id, agent); records.set(id, session);
    if (parent) owners.set(id, parent);
    return agent;
  }
  function emit(agent, type, data, surfaceOp) {
    const events = agent.session.snapshotEvents();
    const event = { seq: events.length, type, data, ...(surfaceOp ? { surfaceOp } : {}) };
    // Replace the fixture snapshot reader to emulate the immutable native log.
    events.push(event);
    agent.session.snapshotEvents = (from = 0, to = events.length) => events.slice(from, to);
    Object.defineProperty(agent.session, 'seq', { configurable: true, get: () => events.length });
    assert.equal(memory.observe(agent.session, event), true);
    return event;
  }
  const f = { directory, actors, records, owners, sessions, actor, emit, get memory() { return memory; },
    begin(agent, turn) { return emit(agent, 'turn/start', { turn }); },
    user(agent, id = 'u-' + agent.session.seq, source = { kind: 'user' }, surfaceOp = 'append') {
      return emit(agent, 'user/message', { id, role: 'user', source, content: [{ type: 'text', text: '测试原话' }] }, surfaceOp);
    },
    source(agent, event, turn) { return { sessionId: agent.id, messageId: event.data.id, sequence: event.seq, turn, rootTurn: turn, role: 'user' }; },
    job(source, grant) { return { sessionId: source.sessionId, sourceMessageId: source.messageId, sourceEventSeq: source.sequence,
      turn: source.turn, memoryAuthorization: JSON.parse(JSON.stringify(grant)) }; },
    async enable(agent) { await memory.set(agent.id, true); },
    async reload() { memory.close(); memory = await createSessionMemory(options); return memory; },
  };
  return f;
}

test('current original messages admit both roles without widening legacy history credentials',async t=>{
  const f=await fixture(t),a=f.actor('root');
  f.begin(a,1);const closed=f.user(a);
  assert.equal(f.memory.admitMessage(a.session,closed),null);
  await f.enable(a);f.begin(a,2);
  const user=f.emit(a,'user/message',{id:'u-original',role:'user',source:{kind:'user'},content:[{type:'text',text:'  原话不裁剪  '}]},'append');
  const admitted=f.memory.admitMessage(a.session,user);
  assert.equal(admitted.source.text,'  原话不裁剪  ');assert.equal(admitted.grant.kind,'message-source');
  assert.equal(f.memory.validateMessage(admitted.grant),true);
  assert.equal(f.memory.validate(admitted.grant),false,'new message grants do not enter the old capture path');
  const assistant=f.emit(a,'assistant/message',{turn:2,message:{id:'a-original',role:'assistant',source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:'助手新原话'}]}},'append');
  const reply=f.memory.admitMessage(a.session,assistant);
  assert.equal(reply.source.role,'assistant');assert.equal(reply.source.origin.kind,'model');
  assert.equal(f.memory.validateMessage(reply.grant),true);
  assert.throws(()=>f.memory.policy.grant(a,reply.grant.source),{code:'MEMORY_NOT_AUTHORIZED'});
  const forged={...assistant,data:{...assistant.data,message:{...assistant.data.message,content:[{type:'text',text:'伪造内容'}]}}};
  assert.throws(()=>f.memory.admitMessage(a.session,forged),{code:'MEMORY_DISABLED'});
  await f.reload();assert.equal(f.memory.validateMessage(JSON.parse(JSON.stringify(reply.grant))),true);
  await f.memory.set(a.id,false);assert.equal(f.memory.validateMessage(reply.grant),false);
  await f.enable(a);f.begin(a,3);
  assert.equal(f.memory.admitMessage(a.session,user),null,'reopening never reimports an earlier event');
});

test('message recording excludes synthetic context, inherited history and owned child output',async t=>{
  const f=await fixture(t),a=f.actor('root');
  await f.enable(a);f.begin(a,1);
  const context=f.user(a,'injected',{kind:'recent-conversation-context'});
  assert.equal(f.memory.admitMessage(a.session,context),null);
  const tool=f.emit(a,'assistant/message',{turn:1,message:{id:'not-a-model',role:'assistant',source:{kind:'tool'},content:[{type:'text',text:'工具结果'}]}},'append');
  assert.equal(f.memory.admitMessage(a.session,tool),null);
  const child=f.actor('child',{parent:a});f.begin(child,1);
  const output=f.emit(child,'assistant/message',{turn:1,message:{id:'child-output',role:'assistant',source:{kind:'model'},content:[{type:'text',text:'子任务输出'}]}},'append');
  assert.equal(f.memory.check(child).allowed,true);assert.equal(f.memory.admitMessage(child.session,output),null);
});

test('default off ignores legacy selections, unknown identities and unrelated branches', async t => {
  const f = await fixture(t), a = f.actor('root');
  a.options = { dshSessionIds: ['root'], pureMode: false };
  f.begin(a, 1); f.user(a);
  assert.equal(f.memory.ready, true);
  assert.deepEqual(f.memory.check(a), { allowed: false, installed: true, ready: true, epoch: null });
  assert.deepEqual(f.memory.historyPolicy(a), { installed: true, userOnly: true });
  assert.equal(f.memory.status(a.id).defaultEnabled, false);
  assert.equal(f.memory.status(a.id).requested, false);
  assert.equal(f.memory.check({ ...a }).allowed, false);
  assert.equal(f.memory.check({ session: a.session }).allowed, false);
  assert.equal(f.memory.check(null).allowed, false);
  await assert.rejects(f.memory.set('unknown', true));
  assert.throws(() => f.memory.grant(a));
  assert.throws(() => f.memory.assertCurrent(a), { code: 'MEMORY_DISABLED' });
  const file = path.join(f.directory, 'management', 'session-memory', 'policy.json');
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
});

test('selection is persisted but only a subsequent trusted turn becomes active', async t => {
  const f = await fixture(t), a = f.actor('root');
  f.begin(a, 1); const before = f.user(a);
  const status = await f.memory.set(a.id, true);
  assert.equal(status.requested, true); assert.equal(status.enabled, true);
  assert.equal(status.active, false); assert.equal(status.effective, 'next-user-turn');
  assert.equal(f.memory.check(a).allowed, false);
  f.emit(a, 'assistant/message', { turn: 200, message: { role: 'assistant' } }, 'append');
  assert.equal(f.memory.check(a).allowed, false);
  const forged = { seq: a.session.seq - 1, type: 'turn/start', data: { turn: 200 } };
  assert.equal(f.memory.observe(a.session, forged), false);
  assert.equal(f.memory.check(a).allowed, false);
  f.begin(a, 2); const user = f.user(a);
  assert.equal(f.memory.check(a).allowed, true);
  assert.equal(f.memory.status(a.id).active, true);
  assert.throws(() => f.memory.grant(a, f.source(a, before, 1)));
  const source = f.source(a, user, 2), grant = f.memory.grant(a, source);
  assert.equal(f.memory.validate(grant, source), true);
  assert.equal(Object.getOwnPropertyDescriptor(grant, 'signal').enumerable, false);
  assert.equal('signal' in JSON.parse(JSON.stringify(grant)), false);
});

test('check is read-only and explicit grants alone append the journal', async t => {
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); f.begin(a, 1); f.user(a);
  const journal = path.join(f.directory, 'management', 'session-memory', 'policy.json.grants.jsonl');
  for (let i = 0; i < 30; i++) assert.equal(f.memory.check(a).allowed, true);
  await assert.rejects(fs.stat(journal), { code: 'ENOENT' });
  const grant = f.memory.grant(a), before = await fs.readFile(journal, 'utf8');
  assert.ok(grant.signal instanceof AbortSignal);
  for (let i = 0; i < 30; i++) f.memory.check(a);
  assert.equal(await fs.readFile(journal, 'utf8'), before);
  assert.equal(f.memory.validate(grant), true);
});

test('close immediately aborts original signals; reopening does not revive a late result', async t => {
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); f.begin(a, 1); const user = f.user(a);
  const source = f.source(a, user, 1), grant = f.memory.grant(a, source), read = f.memory.grant(a);
  const job = f.job(source, grant), events = [];
  const unsubscribe = f.memory.subscribe(event => events.push(event));
  const closing = f.memory.set(a.id, false);
  assert.equal(grant.signal.aborted, true); assert.equal(read.signal.aborted, true);
  assert.equal(f.memory.check(a).allowed, false);
  assert.equal(f.memory.validate(grant, source), false); assert.equal(f.memory.checkSource(job), false);
  await closing;
  const closed = f.memory.status(a.id); assert.equal(closed.requested, false); assert.equal(closed.active, false);
  f.begin(a, 2); const gap = f.user(a);
  await f.enable(a); assert.equal(f.memory.check(a).allowed, false);
  f.begin(a, 3); const next = f.user(a);
  assert.equal(f.memory.check(a).allowed, true);
  assert.equal(f.memory.validate(grant, source), false); assert.equal(f.memory.checkSource(job), false);
  assert.throws(() => f.memory.grant(a, f.source(a, gap, 2)));
  assert.equal(f.memory.validate(f.memory.grant(a, f.source(a, next, 3))), true);
  assert.ok(events.some(event => event.reason === 'authorization-closing')); unsubscribe();
});

test('only runtime-owned children inherit; fork lineage and child outputs cannot authorize sources', async t => {
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); f.begin(a, 1); const user = f.user(a), source = f.source(a, user, 1);
  const child = f.actor('child', { parent: a }), grandchild = f.actor('grandchild', { parent: child });
  const branch = f.actor('branch', { header: { parentSessionId: 'root', rootSessionId: 'root' },
    seed: a.session.snapshotEvents(), inherited: a.session.seq });
  assert.equal(f.memory.check(child).allowed, true); assert.equal(f.memory.check(grandchild).allowed, true);
  assert.equal(f.memory.check(branch).allowed, false);
  assert.equal(f.memory.status(child.id).rootSessionId, a.id);
  await assert.rejects(f.memory.set(child.id, true));
  assert.equal(f.memory.validate(f.memory.grant(child, source)), true);
  f.begin(child, 1); const output = f.user(child);
  assert.throws(() => f.memory.grant(child, f.source(child, output, 1)));
  f.owners.set(a.id, child);
  assert.equal(f.memory.check(child).allowed, false);
  f.owners.delete(a.id);
  f.records.delete(a.id);
  assert.equal(f.memory.check(child).allowed, false);
});

test('source grants reject assistant, synthetic, replacement and mismatched coordinate material', async t => {
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); f.begin(a, 1); const user = f.user(a), source = f.source(a, user, 1);
  const grant = f.memory.grant(a, source), job = f.job(source, grant);
  assert.equal(f.memory.checkSource(job), true);
  assert.equal(f.memory.checkSource({ ...job, memoryAuthorization: undefined }), false);
  assert.equal(f.memory.checkSource({ ...job, memoryAuthorization: f.memory.grant(a) }), false);
  for (const change of [{ sourceMessageId: 'other' }, { sourceEventSeq: 999 }, { turn: 99 }, { sessionId: 'other' }, { rootTurn: 0 }]) {
    assert.equal(f.memory.checkSource({ ...job, ...change }), false);
  }
  for (const change of [{ role: 'assistant' }, { sequence: 999 }, { messageId: 'other' }, { rootTurn: 0 }]) {
    assert.throws(() => f.memory.grant(a, { ...source, ...change }));
    assert.equal(f.memory.validate(grant, { ...source, ...change }), false);
  }
  const synthetic = f.user(a, 'synthetic', { kind: 'tool' });
  assert.throws(() => f.memory.grant(a, f.source(a, synthetic, 1)));
  const replaced = f.user(a, 'replacement', { kind: 'user' }, 'replace');
  assert.throws(() => f.memory.grant(a, f.source(a, replaced, 1)));
  f.begin(a, 2); f.user(a);
  assert.throws(() => f.memory.grant(a, source));
  assert.equal(f.memory.checkSource(job), true); // Previously authorized queue work remains valid.
});

test('restart restores selected sessions and exact serialized credentials, including later revocation', async t => {
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); f.begin(a, 1); const event = f.user(a), source = f.source(a, event, 1);
  const grant = f.memory.grant(a, source), job = f.job(source, grant), old = f.memory;
  await f.reload();
  assert.equal(old.check(a).allowed, false); assert.equal(old.validate(grant), false);
  assert.equal(f.memory.status(a.id).requested, true); assert.equal(f.memory.check(a).allowed, true);
  assert.equal(f.memory.checkSource(job), true);
  assert.equal(f.memory.validate(job.memoryAuthorization, source), true);
  assert.equal(f.memory.validate({ ...job.memoryAuthorization, epoch: 'forged' }, source), false);
  const b = f.actor('independent'); assert.equal(f.memory.check(b).allowed, false);
  await f.memory.set(a.id, false); await f.enable(a); f.begin(a, 2); f.user(a);
  assert.equal(f.memory.checkSource(job), false);
  await f.reload(); assert.equal(f.memory.checkSource(job), false);
});

test('AsyncLocalStorage retains the original grant across awaits and a close/reopen', async t => {
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); f.begin(a, 1); const event = f.user(a), source = f.source(a, event, 1);
  const grant = f.memory.grant(a, source);
  assert.equal(f.memory.assertCurrent(a), true);
  await f.memory.withGrant(grant, async () => {
    assert.equal(f.memory.assertCurrent(a), true);
    await Promise.resolve(); assert.equal(f.memory.assertCurrent(), true);
    await f.memory.set(a.id, false); await f.enable(a); f.begin(a, 2); f.user(a);
    assert.equal(f.memory.check(a).allowed, true);
    assert.throws(() => f.memory.assertCurrent(a), { code: 'MEMORY_DISABLED' });
    assert.throws(() => f.memory.assertCurrent(), { code: 'MEMORY_DISABLED' });
  });
  assert.equal(f.memory.assertCurrent(a), true);
  assert.throws(() => f.memory.withGrant(grant, () => {}), { code: 'MEMORY_DISABLED' });
});

test('parallel and nested operation contexts are isolated and cannot use another root', async t => {
  const f = await fixture(t), a = f.actor('root'), b = f.actor('other');
  await f.enable(a); await f.enable(b); f.begin(a, 1); f.user(a); f.begin(b, 1); f.user(b);
  const ga = f.memory.grant(a), gb = f.memory.grant(b);
  await Promise.all([
    f.memory.withGrant(ga, async () => {
      await Promise.resolve(); assert.equal(f.memory.assertCurrent(a), true);
      assert.throws(() => f.memory.assertCurrent(b), { code: 'MEMORY_DISABLED' });
      await f.memory.withGrant(gb, async () => { await Promise.resolve(); assert.equal(f.memory.assertCurrent(b), true); });
      assert.equal(f.memory.assertCurrent(a), true);
    }),
    f.memory.withGrant(gb, async () => { await Promise.resolve(); assert.equal(f.memory.assertCurrent(b), true); }),
  ]);
  ga.cancel(); assert.equal(f.memory.validate(ga), false); assert.equal(ga.signal.aborted, true);
});

test('invalid host capabilities fail initialization; shutdown preserves choices and releases listeners', async t => {
  await assert.rejects(createSessionMemory({ directory: os.tmpdir(), ownerSubject: '用户', agents: {}, sessions: {} }), TypeError);
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); const events = [];
  f.memory.subscribe(event => events.push(event)); f.memory.close();
  assert.equal(f.memory.ready, false);
  assert.equal(f.memory.check(a).allowed, false);
  assert.throws(() => f.memory.assertCurrent(a), { code: 'MEMORY_DISABLED' });
  await assert.rejects(f.memory.set(a.id, false), { code: 'MEMORY_DISABLED' });
  assert.throws(() => f.memory.status(a.id), { code: 'MEMORY_DISABLED' });
  await f.memory.policy.set(a.id, false).catch(() => {});
  assert.deepEqual(events, []);
  await f.reload(); assert.equal(f.memory.status(a.id).requested, true);
});

test('settings load an existing native session without creating or opening its agent', async t => {
  const f = await fixture(t), session = Session.create('stored-native');
  session.append('turn/start', { turn: 1 });
  session.append('user/message', { id: 'old-native-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '开启前的原话' }] }, { surfaceOp: 'append' });
  let ensured = 0;
  f.sessions.ensure = async id => { assert.equal(id, session.id); ensured++; f.records.set(id, session); return session; };
  assert.equal(f.memory.status(session.id).requested, false);
  const selected = await f.memory.set(session.id, true);
  assert.equal(ensured, 1); assert.equal(selected.requested, true); assert.equal(selected.active, false);
  f.records.delete(session.id); // Sidebar still reads the persisted choice synchronously.
  assert.equal(f.memory.status(session.id).requested, true); assert.equal(f.memory.status(session.id).active, false);
  await f.reload(); assert.equal(f.memory.status(session.id).requested, true);
  f.records.set(session.id, session);
  const agent = { id: session.id, session }; f.actors.set(agent.id, agent);
  assert.equal(f.memory.check(agent).allowed, false);
  const turn = session.append('turn/start', { turn: 2 });
  assert.equal(f.memory.observe(session, turn), true);
  assert.equal(f.memory.check(agent).allowed, true);
  const message = session.append('user/message', { id: 'native-user', role: 'user', source: { kind: 'user' },
    content: [{ type: 'text', text: '这回合允许记录的原话' }] }, { surfaceOp: 'append' });
  assert.equal(f.memory.observe(session, message), true);
  const source = f.source(agent, message, 2), grant = f.memory.grant(agent, source), job = f.job(source, grant);
  assert.equal(f.memory.checkSource(job), true);
  f.actors.delete(agent.id);
  assert.equal(f.memory.status(session.id).active, false);
  assert.equal(f.memory.checkSource(job), true); // A real cached session verifies durable queued coordinates.
  const closing = f.memory.set(session.id, false);
  assert.equal(grant.signal.aborted, true); assert.equal(f.memory.checkSource(job), false);
  await closing; assert.equal(grant.signal.aborted, true); assert.equal(f.memory.checkSource(job), false);
  assert.equal(ensured, 2);
  await assert.rejects(fs.stat(path.join(f.directory, 'management', 'unified-memory')), { code: 'ENOENT' });
});

test('ensure failures and fabricated ensure results never create authorization', async t => {
  const f = await fixture(t);
  f.sessions.ensure = async () => { throw new Error('no stored session'); };
  await assert.rejects(f.memory.set('missing', true), /no stored session/);
  assert.equal(f.memory.status('missing').requested, false);
  f.sessions.ensure = async () => Session.create('fabricated-only-return');
  await assert.rejects(f.memory.set('fabricated-only-return', true));
  assert.equal(f.memory.status('fabricated-only-return').requested, false);
});

test('an awaited settings loader cannot delay closing revocation', async t => {
  const f = await fixture(t), a = f.actor('root');
  await f.enable(a); f.begin(a, 1); f.user(a);
  const grant = f.memory.grant(a);
  let release;
  f.sessions.ensure = () => new Promise(resolve => { release = resolve; });
  const closing = f.memory.set(a.id, false);
  assert.equal(grant.signal.aborted, true); assert.equal(f.memory.check(a).allowed, false);
  assert.equal(f.memory.validate(grant), false);
  release(a.session); await closing;
  assert.equal(f.memory.status(a.id).requested, false);
});

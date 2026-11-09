import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createMemoryPolicy } from '../lib/memory-policy/index.js';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-policy-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'policy.json');
  const sessions = new Map();
  const agents = new Map();
  const managers = new WeakSet();
  const root = { sessionId: 'root', rootSessionId: 'root', ownerSubject: 'owner-a',
    project: 'project-a', sequence: 19, turn: 1, rootTurn: 1, historyUserOnly: true,
    ...options };
  sessions.set(root.sessionId, root);
  const agent = {};
  agents.set(agent, root.sessionId);
  const configuration = { file, resolveAgent: handle => sessions.get(agents.get(handle)),
    resolveSession: id => sessions.get(id), now: () => 1700000000000,
    authorizeManagement: grant => Boolean(grant && managers.has(grant)) };
  const policy = createMemoryPolicy(configuration);
  await policy.ready();
  function advance(turn) { root.turn = turn; root.rootTurn = turn; root.sequence = turn * 10 + 9; }
  function source(turn, role = 'user', extra = {}) {
    return { sessionId: root.sessionId, messageId: `message-${turn}`, sequence: turn * 10 + 1,
      turn, rootTurn: turn, role, ...extra };
  }
  async function enable() { await policy.set(root.sessionId, true); advance(root.turn + 1); }
  return { policy, file, sessions, agents, root, agent, advance, source, enable,
    manager(scope = {}) { const grant = { ownerSubject: root.ownerSubject, project: root.project, ...scope }; managers.add(grant); return grant; },
    reopen: () => createMemoryPolicy(configuration) };
}

test('historical selection is durable, exact, independently revocable and never opens the current chat', async t => {
  const f = await fixture(t), managementGrant = f.manager(), source = f.source(0);
  const options = { managementGrant, selectionId: 'explicit-old-session' };
  const grant = f.policy.issueHistorical(source, options);
  assert.equal(f.policy.validate(grant), true);
  assert.equal(f.policy.validate(grant, source), true);
  assert.equal(f.policy.check(f.agent).enabled, false);
  assert.throws(() => f.policy.grant(f.agent, source), { code: 'MEMORY_NOT_AUTHORIZED' });
  const reopened = f.reopen(); await reopened.ready();
  assert.deepEqual(reopened.getHistorical(source, options), JSON.parse(JSON.stringify(grant)));
  assert.equal(reopened.getHistorical(source, { ...options, selectionId: 'different-selection' }), null);
  for (const mutation of [{ messageId: 'other' }, { sequence: 88 }, { role: 'assistant' }, { ownerSubject: 'foreign' }, { project: 'foreign' }]) {
    assert.equal(reopened.validate(grant, { ...source, ...mutation }), false);
  }
  assert.equal(reopened.validate({ ...grant, selectionId: 'different' }), false);
  assert.deepEqual(reopened.revokeHistorical(options.selectionId, { managementGrant }), { revoked: 1 });
  assert.equal(reopened.getHistorical(source, options), null);
  assert.equal(reopened.validate(grant), false);
  const next = f.reopen(); await next.ready();
  assert.equal(next.validate(grant), false);
  assert.equal(next.getHistorical(source, options), null);
  assert.equal(next.check(f.agent).enabled, false);
});

test('historical grant requires a real management handle and explicit source coordinates, not a legacy binding', async t => {
  const f = await fixture(t), source = f.source(0), managementGrant = f.manager();
  assert.throws(() => f.policy.issueHistorical(source, { managementGrant: { ...managementGrant }, selectionId: 'old' }), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.throws(() => f.policy.issueHistorical(source, { managementGrant }), { code: 'INVALID_MEMORY_VALUE' });
  assert.throws(() => f.policy.issueHistorical({ ...source, sequence: undefined }, { managementGrant, selectionId: 'old' }), { code: 'INVALID_SOURCE_POSITION' });
  assert.throws(() => f.policy.issueHistorical({ ...source, project: 'foreign' }, { managementGrant, selectionId: 'old' }), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.throws(() => f.policy.issueHistorical({ ...source, rootSessionId: 'other' }, { managementGrant, selectionId: 'old' }), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.throws(() => f.policy.issueHistorical({ ...source, role: 'assistant' }, { managementGrant, selectionId: 'old' }), { code: 'MEMORY_NOT_AUTHORIZED' });
  const grant = f.policy.issueHistorical({ ...source, role: 'assistant' }, { managementGrant, selectionId: 'old', allowAssistant: true });
  assert.equal(f.policy.validate(grant), true);
  assert.equal(f.policy.getHistorical({ ...source, role: 'assistant' }, { managementGrant, selectionId: 'old' }), null);
  const controller = new AbortController(), cancelledManager = f.manager({ signal: controller.signal }); controller.abort();
  assert.throws(() => f.policy.issueHistorical(source, { managementGrant: cancelledManager, selectionId: 'old' }), { code: 'MEMORY_NOT_AUTHORIZED' });
});

test('chat toggles do not revoke historical selection and history does not grant a new chat', async t => {
  const f = await fixture(t), options = { managementGrant: f.manager(), selectionId: 'old' }, source = f.source(0);
  const historical = f.policy.issueHistorical(source, options);
  await f.enable(); const chat = f.policy.grant(f.agent);
  await f.policy.set('root', false);
  assert.equal(f.policy.validate(chat), false);
  assert.equal(f.policy.validate(historical), true);
  assert.equal(historical.signal.aborted, false);
  const independent = { ...f.root, sessionId: 'new-chat', rootSessionId: 'new-chat' }, agent = {};
  f.sessions.set(independent.sessionId, independent); f.agents.set(agent, independent.sessionId);
  assert.equal(f.policy.check(agent).enabled, false);
  assert.throws(() => f.policy.grant(agent), { code: 'MEMORY_NOT_AUTHORIZED' });
  historical.cancel();
  const reopened = f.reopen(); await reopened.ready(); assert.equal(reopened.validate(historical), false);
});

test('missing policy is closed, does not persist a legacy opt-in, and refuses fabricated agents', async t => {
  const f = await fixture(t);
  assert.equal(f.policy.status('root').explicit, false);
  assert.equal(f.policy.check(f.agent).enabled, false);
  assert.throws(() => f.policy.grant(f.agent), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.equal(f.policy.validate({}), false);
  await assert.rejects(fs.stat(f.file), { code: 'ENOENT' });
  await f.enable();
  assert.deepEqual(f.policy.check({ sessionId: 'root', ...f.root }), { enabled: false });
});

test('not-ready check and validate fail closed without opening the policy', async t => {
  const f = await fixture(t);
  const policy = f.reopen();
  assert.equal(policy.check(f.agent).enabled, false);
  assert.equal(policy.validate(null), false);
  assert.throws(() => policy.grant(f.agent), { code: 'MEMORY_NOT_AUTHORIZED' });
});

test('explicit enable starts at a later turn and sequence, not the current turn', async t => {
  const f = await fixture(t);
  const status = await f.policy.set('root', true, { expectedRevision: f.policy.status('root').revision });
  assert.equal(status.enabled, true);
  assert.equal(status.effective, false);
  assert.equal(f.policy.check(f.agent).enabled, false);
  f.root.sequence += 1;
  assert.equal(f.policy.check(f.agent).enabled, false);
  f.advance(2);
  assert.equal(f.policy.check(f.agent).enabled, true);
  assert.throws(() => f.policy.grant(f.agent, f.source(1)), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.equal(f.policy.validate(f.policy.grant(f.agent, f.source(2)), f.source(2)), true);
});

test('half-open start includes the first assigned position only in a subsequent turn', async t => {
  const f = await fixture(t);
  const startSequence = f.root.sequence;
  await f.policy.set('root', true);
  f.root.sequence = startSequence + 1;
  assert.equal(f.policy.check(f.agent).enabled, false);
  assert.throws(() => f.policy.grant(f.agent, f.source(1, 'user', { sequence: startSequence })),
    { code: 'MEMORY_NOT_AUTHORIZED' });
  f.root.turn = 2; f.root.rootTurn = 2;
  const source = f.source(2, 'user', { sequence: startSequence });
  assert.equal(f.policy.validate(f.policy.grant(f.agent, source), source), true);
  assert.throws(() => f.policy.grant(f.agent, f.source(2, 'user', { sequence: startSequence - 1 })),
    { code: 'MEMORY_NOT_AUTHORIZED' });
  // The current next-unassigned position is not yet an actual source.
  assert.throws(() => f.policy.grant(f.agent, f.source(2, 'user', { sequence: f.root.sequence })),
    { code: 'MEMORY_NOT_AUTHORIZED' });
});

test('read grants are durable serializable credentials and cannot collect a source', async t => {
  const f = await fixture(t);
  await f.enable();
  const grant = f.policy.grant(f.agent);
  const serialized = JSON.parse(JSON.stringify(grant));
  assert.equal('signal' in serialized, false);
  assert.equal('cancel' in serialized, false);
  assert.equal(f.policy.validate(serialized), true);
  assert.equal(f.policy.validate(serialized, f.source(2)), false);
  const reopened = f.reopen();
  await reopened.ready();
  assert.equal(reopened.validate(serialized), true);
  assert.equal(reopened.validate(serialized, f.source(2)), false);
});

test('disable blocks immediately, aborts work, and old epochs never revive', async t => {
  const f = await fixture(t);
  await f.enable();
  const source = f.source(2), grant = f.policy.grant(f.agent, source);
  const serialized = JSON.parse(JSON.stringify(grant));
  const events = [];
  const unsubscribe = f.policy.subscribe(event => events.push(event));
  const closing = f.policy.set('root', false);
  assert.equal(f.policy.validate(grant, source), false);
  assert.equal(grant.signal.aborted, true);
  await closing;
  f.advance(3);
  await f.policy.set('root', true);
  f.advance(4);
  assert.equal(f.policy.validate(serialized, source), false);
  assert.notEqual(f.policy.grant(f.agent, source).epoch, serialized.epoch);
  const reopened = f.reopen();
  await reopened.ready();
  assert.equal(reopened.validate(serialized, source), false);
  assert.ok(events.some(event => event.reason === 'authorization-closed'));
  unsubscribe();
});

test('old admitted backlog can obtain a fresh grant; closed and pre-enable periods cannot', async t => {
  const f = await fixture(t);
  await f.enable();
  const admitted = f.source(2);
  f.advance(3);
  await f.policy.set('root', false);
  f.advance(5);
  await f.policy.set('root', true);
  f.advance(6);
  const grant = f.policy.grant(f.agent, admitted);
  assert.equal(f.policy.validate(grant, admitted), true);
  assert.throws(() => f.policy.grant(f.agent, f.source(1)), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.throws(() => f.policy.grant(f.agent, f.source(4)), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.throws(() => f.policy.grant(f.agent, f.source(5)), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.equal(f.policy.validate(f.policy.grant(f.agent, f.source(6)), f.source(6)), true);
});

test('owned children inherit search and root-source processing, not output collection', async t => {
  const f = await fixture(t);
  await f.enable();
  const child = { ...f.root, sessionId: 'child', sequence: 3, turn: 1, rootTurn: 2 };
  const branch = { ...f.root, sessionId: 'branch', rootSessionId: 'branch' };
  const childAgent = {}, branchAgent = {};
  f.sessions.set('child', child); f.sessions.set('branch', branch);
  f.agents.set(childAgent, 'child'); f.agents.set(branchAgent, 'branch');
  assert.equal(f.policy.check(childAgent).enabled, true);
  assert.equal(f.policy.check(branchAgent).enabled, false);
  await assert.rejects(f.policy.set('child', true), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.equal(f.policy.validate(f.policy.grant(childAgent)), true);
  const source = f.source(2);
  const childGrant = f.policy.grant(childAgent, source);
  assert.equal(f.policy.validate(childGrant, source), true);
  for (const role of ['user', 'assistant']) {
    const output = f.source(2, role, { sessionId: 'child', messageId: 'child-message', sequence: 2, turn: 1 });
    assert.throws(() => f.policy.grant(childAgent, output), { code: 'MEMORY_NOT_AUTHORIZED' });
    assert.throws(() => f.policy.grant(f.agent, output), { code: 'MEMORY_NOT_AUTHORIZED' });
    assert.equal(f.policy.validate(childGrant, output), false);
  }
  child.project = 'project-b';
  assert.equal(f.policy.validate(childGrant, source), false);
  child.project = 'project-a';
  child.rootSessionId = 'child'; child.rootTurn = child.turn;
  assert.equal(f.policy.check(childAgent).enabled, false);
});

test('child outputs from the closing root turn remain excluded after reopening', async t => {
  const f = await fixture(t);
  await f.enable();
  const child = { ...f.root, sessionId: 'child', sequence: 3, turn: 1, rootTurn: 2 };
  const childAgent = {};
  f.sessions.set('child', child); f.agents.set(childAgent, 'child');
  await f.policy.set('root', false);
  // These outputs arrive after close but retain its root turn, with unrelated local positions.
  const output = f.source(2, 'user', { sessionId: 'child', messageId: 'late-child', sequence: 3, turn: 1 });
  child.sequence = 4;
  assert.throws(() => f.policy.grant(childAgent, output), { code: 'MEMORY_NOT_AUTHORIZED' });
  await f.policy.set('root', true);
  f.advance(3); child.rootTurn = 3;
  assert.equal(f.policy.check(childAgent).enabled, true);
  assert.throws(() => f.policy.grant(childAgent, output), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.throws(() => f.policy.grant(f.agent, output), { code: 'MEMORY_NOT_AUTHORIZED' });
  const rootBacklog = f.source(2);
  assert.equal(f.policy.validate(f.policy.grant(childAgent, rootBacklog), rootBacklog), true);
});

test('source root supplied by caller cannot override the trusted resolver', async t => {
  const f = await fixture(t);
  await f.enable();
  const other = { ...f.root, sessionId: 'other', rootSessionId: 'other' };
  f.sessions.set('other', other);
  const source = f.source(2, 'user', { sessionId: 'other', rootSessionId: 'root' });
  assert.throws(() => f.policy.grant(f.agent, source), { code: 'MEMORY_NOT_AUTHORIZED' });
});

test('subject and project mutations revoke grants, including changed source ownership', async t => {
  const f = await fixture(t);
  await f.enable();
  const grant = f.policy.grant(f.agent, f.source(2));
  f.root.project = 'project-b';
  assert.equal(f.policy.validate(grant), false);
  assert.equal(f.policy.check(f.agent).enabled, false);
  await assert.rejects(f.policy.set('root', true), { code: 'MEMORY_NOT_AUTHORIZED' });
  f.root.project = 'project-a'; f.root.ownerSubject = 'owner-b';
  assert.equal(f.policy.validate(grant), false);
});

test('historyUserOnly needs affirmative clean-context proof and does not relax old intervals', async t => {
  const f = await fixture(t);
  await f.enable();
  assert.throws(() => f.policy.grant(f.agent, f.source(2, 'assistant')), { code: 'MEMORY_NOT_AUTHORIZED' });
  f.root.historyUserOnly = false;
  assert.throws(() => f.policy.grant(f.agent, f.source(2, 'assistant')), { code: 'MEMORY_NOT_AUTHORIZED' });
  await f.policy.set('root', false);
  await f.policy.set('root', true);
  f.advance(3);
  const source = f.source(3, 'assistant'), grant = f.policy.grant(f.agent, source);
  assert.equal(f.policy.validate(grant, source), true);
  f.root.historyUserOnly = true;
  assert.equal(f.policy.validate(grant, source), false);
  assert.throws(() => f.policy.grant(f.agent, f.source(2, 'assistant')), { code: 'MEMORY_NOT_AUTHORIZED' });
});

test('exact registered grant and exact source coordinates are required; future sources are rejected', async t => {
  const f = await fixture(t);
  await f.enable();
  const source = f.source(2), grant = f.policy.grant(f.agent, source);
  for (const replacement of [
    { ...grant, id: 'invented' }, { ...grant, epoch: 'invented' },
    { ...grant, project: 'other' }, { ...grant, historyUserOnly: false },
    { ...grant, source: { ...source, messageId: 'other' } }, { ...grant, extra: true },
  ]) assert.equal(f.policy.validate(replacement, source), false);
  assert.equal(f.policy.validate(grant, { ...source, role: 'assistant' }), false);
  assert.equal(f.policy.validate(grant, { ...source, sequence: source.sequence + 1 }), false);
  assert.equal(f.policy.validate(grant, { ...source, ownerSubject: 'other' }), false);
  assert.equal(f.policy.validate(grant, { ...source, project: 'other' }), false);
  assert.equal(f.policy.validate(grant, { ...source, rootSessionId: 'other' }), false);
  assert.equal(f.policy.validate(grant, { ...source, intervalId: 'other' }), false);
  assert.equal(f.policy.validate(grant, { ...source, ownerSubject: grant.ownerSubject,
    project: grant.project, rootSessionId: grant.rootSessionId, intervalId: grant.intervalId }), true);
  assert.throws(() => f.policy.grant(f.agent, f.source(3)), { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.equal(f.policy.validate(null, null), false);
  assert.equal(f.policy.validate({ get id() { throw new Error('bad'); } }), false);
});

test('explicit cancellation stays cancelled after serialization and restart', async t => {
  const f = await fixture(t);
  await f.enable();
  const grant = f.policy.grant(f.agent);
  const serialized = JSON.parse(JSON.stringify(grant));
  grant.cancel();
  assert.equal(grant.signal.aborted, true);
  assert.equal(f.policy.validate(serialized), false);
  const reopened = f.reopen();
  await reopened.ready();
  assert.equal(reopened.validate(serialized), false);
});

test('stale revisions do not change persisted authorization, duplicate enable does not shift interval', async t => {
  const f = await fixture(t);
  const revision = f.policy.status('root').revision;
  await f.enable();
  const before = f.policy.status('root');
  await assert.rejects(f.policy.set('root', false, { expectedRevision: revision }), { code: 'MEMORY_REVISION_CONFLICT' });
  assert.equal(f.policy.status('root').enabled, true);
  await f.policy.set('root', true);
  const after = f.policy.status('root');
  assert.deepEqual(after.intervals, before.intervals);
  assert.equal(after.epoch, before.epoch);
});

test('corrupt policy metadata and corrupt grant journals are visible and fail closed', async t => {
  const f = await fixture(t);
  await f.enable();
  await fs.writeFile(f.file + '.grants.jsonl', '{truncated');
  const policy = f.reopen();
  await assert.rejects(policy.ready());
  assert.equal(policy.validate({}), false);
  assert.equal(policy.check(f.agent).enabled, false);
  await fs.writeFile(f.file, '{truncated');
  const other = f.reopen();
  await assert.rejects(other.ready());
  assert.equal(other.check(f.agent).enabled, false);
});

test('closed root sequence cutoff excludes later messages in that same turn', async t => {
  const f = await fixture(t);
  await f.enable();
  f.root.sequence = 25;
  await f.policy.set('root', false);
  f.root.sequence = 29;
  await f.policy.set('root', true);
  f.advance(3);
  const lastBeforeClose = f.source(2, 'user', { sequence: 24 });
  assert.equal(f.policy.validate(f.policy.grant(f.agent, lastBeforeClose), lastBeforeClose), true);
  // sequence=25 is exactly the first position allocated after closing, not an admitted source.
  assert.throws(() => f.policy.grant(f.agent, f.source(2, 'user', { sequence: 25 })),
    { code: 'MEMORY_NOT_AUTHORIZED' });
  assert.throws(() => f.policy.grant(f.agent, f.source(2, 'user', { sequence: 27 })),
    { code: 'MEMORY_NOT_AUTHORIZED' });
});

test('failure to persist a grant never yields a usable credential', async t => {
  const f = await fixture(t);
  await f.enable();
  // A directory at the journal path makes the metadata append fail on all platforms.
  await fs.mkdir(f.file + '.grants.jsonl');
  assert.throws(() => f.policy.grant(f.agent), { code: 'MEMORY_GRANT_FAILED' });
});

test('failed policy persistence rejects save, preserves last saved state, and cancels late credentials', async t => {
  const f = await fixture(t);
  await f.enable();
  const grant = f.policy.grant(f.agent);
  const before = f.policy.status('root');
  // Force the atomic policy rename to fail without monkey-patching filesystem APIs.
  await fs.unlink(f.file);
  await fs.mkdir(f.file);
  const closing = f.policy.set('root', false);
  assert.equal(f.policy.validate(grant), false);
  assert.equal(grant.signal.aborted, true);
  await assert.rejects(closing);
  const after = f.policy.status('root');
  assert.equal(after.enabled, true);
  assert.equal(after.revision, before.revision);
  assert.equal(after.epoch, before.epoch);
  assert.equal(f.policy.validate(grant), false);
  // An explicit new request can use the still-saved authorization after the failed close.
  assert.equal(f.policy.validate(f.policy.grant(f.agent)), true);
});

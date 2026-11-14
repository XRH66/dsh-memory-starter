import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVectorQueue } from '../lib/storage/vector-queue.js';
import { createUnifiedProfiles } from '../lib/storage/profiles.js';

const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const error = code => Object.assign(new Error(code), { code });
const source = (id = 'fictional-source', extra = {}) => ({ id, revision: 'v1', ownerSubject: 'fixture-owner', project: 'fixture-project',
  sessionId: 'fixture-chat', rootSessionId: 'fixture-chat', messageId: id, sequence: 2, turn: 2, rootTurn: 2,
  role: 'user', text: `private fixture ${id}`, state: 'live', ...extra });

async function fixture(t, config = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-vector-recovery-'));
  const file = path.join(directory, 'vector-queue.json');
  const rows = new Map(), agents = new Map([['fixture-chat', { sessionId: 'fixture-chat', enabled: true }]]);
  const valid = new WeakSet(), calls = { acquire: 0, embed: [], source: 0, semantic: 0, list: 0 }, hooks = {};
  let clock = 1000, timerId = 0;
  const timers = new Map();
  function grant(row, kind = row.kind === 'document' ? 'management' : 'chat') {
    const controller = new AbortController();
    const value = { ...row, kind, signal: controller.signal, cancel() { valid.delete(value); controller.abort(); } };
    delete value.text;
    valid.add(value); return value;
  }
  const runtime = {
    authorize: grant => valid.has(grant) && !grant.signal.aborted,
    policy: {
      check: agent => ({ enabled: agent.enabled, sessionId: agent.sessionId, rootSessionId: agent.sessionId,
        ownerSubject: 'fixture-owner', project: 'fixture-project' }),
      validate: (g, row) => valid.has(g) && !g.signal.aborted && Boolean(agents.get(row?.sessionId ?? g.sessionId)?.enabled) &&
        (!row || g.sessionId === row.sessionId),
    },
    sources: { get({ id, revision, grant: g }) {
      calls.source++;
      assert.equal(runtime.authorize(g), true);
      const row = rows.get(id);
      return row?.revision === revision ? structuredClone(row) : null;
    } },
    core: { process() { calls.semantic++; throw new Error('vector queue must never organize'); } },
  };
  const profileOptions = { file: path.join(directory, 'profiles.json'), indexFile: path.join(directory, 'vectors.sqlite'), now: () => clock,
    authorize: runtime.authorize,
    async *listDocuments() {
      calls.list++;
      for (const row of [...rows.values()].filter(row => row.state === 'live')) yield {
        id: row.id, revision: row.revision, domain: row.kind === 'document' ? 'selected-document' : 'raw', text: row.text, sourceIds: [row.id],
      };
    },
    async *listDocumentMetadata() {
      for (const row of rows.values()) if (row.state === 'live') yield {
        id: row.id, revision: row.revision, domain: row.kind === 'document' ? 'selected-document' : 'raw', sourceIds: [row.id],
      };
    },
    resolveDocument({ id, revision }) {
      const row = rows.get(id);
      return row?.revision === revision && row.state === 'live' ? structuredClone(row) : null;
    },
    createBackend({ profile }) {
      const modelKey = `fixed-${profile.revision}`;
      return { modelKey, batchSize: 2,
        async prepare() { return { modelKey, dimensions: profile.dimensions }; },
        async planChunks(text) { return [{ text, start: 0, end: text.length, tokenBound: text.length }]; },
        async embed(texts, options) {
          calls.embed.push(...texts); await hooks.embed?.(texts, options);
          options.signal.throwIfAborted(); options.authorize();
          return texts.map(() => Array.from({ length: profile.dimensions }, (_, i) => i === 0 ? 1 : 0));
        },
        async dispose() {},
      };
    },
  };
  let profiles = createUnifiedProfiles(profileOptions), queue;
  const queueOptions = () => ({ file, runtime, profiles, now: () => clock,
    findAgent: id => agents.get(id), listAgents: () => [...agents.values()],
    acquire: async row => { calls.acquire++; return hooks.acquire ? hooks.acquire(row) : grant(row); },
    config: { debounceMs: 0, retryMs: 10, ...config,
      timers: { setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; }, clearTimeout(id) { timers.delete(id); } } },
  });
  queue = createVectorQueue(queueOptions());
  const management = grant(source(), 'management');
  await profiles.register({ grant: management, profile: { id: 'A', model: 'BAAI/bge-small-zh-v1.5' } });
  await profiles.select({ grant: management, profileId: 'A' });
  await profiles.prepare({ grant: management });
  await queue.ready();
  t.after(async () => { await queue.close(); await profiles.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { file, directory, runtime, calls, hooks, rows, agents, grant, management, timers,
    get profiles() { return profiles; }, get queue() { return queue; },
    put(row = source()) { rows.set(row.id, row); return row; },
    async restart() {
      await queue.close(); await profiles.close(); profiles = createUnifiedProfiles(profileOptions); await profiles.ready();
      queue = createVectorQueue(queueOptions()); await queue.ready();
    },
    async advance(ms = 10) {
      clock += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
      await queue.flush();
    },
  };
}

test('durable notification stores metadata only; restart plus original session availability resumes without new capture', async t => {
  const f = await fixture(t), row = f.put();
  await f.queue.notify({ ...row, target: { model: 'never-store' }, signals: [{ topic: 'private topic' }] });
  const persisted = await fs.readFile(f.file, 'utf8');
  assert.ok(!persisted.includes(row.text)); assert.ok(!persisted.includes('never-store')); assert.ok(!persisted.includes('private topic'));
  f.agents.clear(); await f.restart();
  assert.equal(f.calls.acquire, 0); assert.equal(f.calls.source, 0); assert.equal(f.calls.embed.length, 0);
  await f.queue.resume(); await f.queue.flush();
  assert.equal(f.queue.status().held, 1); assert.equal(f.calls.acquire, 0);
  f.agents.set(row.sessionId, { sessionId: row.sessionId, enabled: true });
  await f.queue.resume(); await f.queue.flush();
  assert.equal(f.queue.status().completed, 1); assert.equal(f.calls.embed.length, 1); assert.equal(f.calls.semantic, 0);
  assert.equal((await f.profiles.coverage({ grant: f.management })).caughtUp, true);
});

test('failure wakes on vector timer, survives restart and never reruns paid semantic organization', async t => {
  const f = await fixture(t), row = f.put();
  let failed = false;
  f.hooks.embed = async () => { if (!failed) { failed = true; throw error('TEMPORARY_VECTOR_FAILURE'); } };
  await f.queue.notify(row); await f.queue.flush();
  assert.equal(f.queue.status().pending, 1); assert.equal(f.queue.status().jobs[0].attempts, 1);
  assert.equal(f.queue.status().nextWake, 1010);
  await f.restart(); await f.queue.resume();
  await f.advance(9); assert.equal(f.queue.status().completed, 0);
  await f.advance(1); assert.equal(f.queue.status().completed, 1); assert.equal(f.calls.semantic, 0);
});

test('retry exhaustion is durable; notify/resume/restart cannot silently reset the failure budget', async t => {
  const f = await fixture(t, { maxAttempts: 2 }), row = f.put();
  f.hooks.embed = async () => { throw error('TEMPORARY_VECTOR_FAILURE'); };
  await f.queue.notify(row); await f.queue.flush(); await f.advance();
  assert.equal(f.queue.status().error, 1); assert.equal(f.queue.status().nextWake, null);
  const attempts = f.calls.acquire;
  await f.restart(); await f.queue.notify(row); await f.queue.resume(); await f.advance(1000);
  assert.equal(f.calls.acquire, attempts); assert.equal(f.queue.status().error, 1);
});

test('closed chats never call acquire and management cannot bypass a chat grant', async t => {
  const f = await fixture(t), row = f.put(); await f.queue.notify(row);
  f.agents.get(row.sessionId).enabled = false;
  await f.queue.flush(); assert.equal(f.calls.acquire, 0); assert.equal(f.calls.source, 0);
  f.agents.get(row.sessionId).enabled = true;
  f.hooks.acquire = item => f.grant(item, 'management');
  await f.queue.resume(); await f.queue.flush();
  assert.equal(f.queue.status().held, 1); assert.equal(f.calls.source, 0); assert.equal(f.calls.embed.length, 0);
});

test('selected manual documents require a fresh management grant and do not require any chat to open', async t => {
  const f = await fixture(t), row = f.put(source('selected-document', { kind: 'document', authority: 'manual', sessionId: undefined }));
  f.agents.clear(); await f.queue.notify(row);
  f.hooks.acquire = () => null;
  await f.queue.flush(); assert.equal(f.queue.status().held, 1); assert.equal(f.calls.source, 0);
  delete f.hooks.acquire; await f.queue.resume(); await f.queue.flush();
  assert.equal(f.queue.status().completed, 1); assert.equal(f.calls.embed.length, 1);
});

test('source versions are frozen; an obsolete notification is superseded without embedding the new version', async t => {
  const f = await fixture(t), row = f.put(); await f.queue.notify(row);
  f.put({ ...row, revision: 'v2', text: 'new version' }); await f.queue.flush();
  assert.equal(f.queue.status().superseded, 1); assert.equal(f.calls.embed.length, 0);
  await f.queue.notify(f.rows.get(row.id)); await f.queue.flush();
  assert.equal(f.queue.status().completed, 1); assert.deepEqual(f.calls.embed, ['new version']);
});

test('cancellation is durable, and a new explicit preparation cannot resurrect the cancelled intent', async t => {
  const f = await fixture(t), row = f.put(); await f.queue.notify(row);
  await f.profiles.cancel({ grant: f.management });
  await f.restart(); await f.queue.resume(); await f.queue.flush();
  assert.equal(f.queue.status().cancelled, 1); assert.equal(f.calls.acquire, 0);
  await f.profiles.prepare({ grant: f.management });
  await f.queue.resume(); await f.queue.flush();
  assert.equal(f.queue.status().cancelled, 1); assert.equal(f.calls.acquire, 0);
});

test('profile/config changes never redirect old work to another active backend', async t => {
  const f = await fixture(t), row = f.put(); await f.queue.notify(row);
  await f.profiles.register({ grant: f.management, profile: { id: 'B', model: 'BAAI/bge-small-zh-v1.5' } });
  await f.profiles.select({ grant: f.management, profileId: 'B' }); await f.profiles.prepare({ grant: f.management });
  const before = f.calls.embed.length;
  await f.queue.flush(); assert.equal(f.queue.status().cancelled, 1); assert.equal(f.calls.embed.length, before); assert.equal(f.calls.acquire, 0);
});

test('shutdown during vector work retains original intent/checkpoint and resumes without repeating completed vectors', async t => {
  const f = await fixture(t), one = f.put(source('one')), two = f.put(source('two'));
  const entered = defer();
  f.hooks.embed = async (texts, options) => {
    if (!texts[0].includes('two')) return;
    entered.resolve();
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  };
  await f.queue.notify(one); await f.queue.notify(two);
  const work = f.queue.flush(); await entered.promise;
  await f.queue.close(); await work;
  delete f.hooks.embed; const before = f.calls.embed.length;
  await f.restart(); await f.queue.resume(); await f.queue.flush();
  assert.equal(f.queue.status().completed, 2);
  assert.deepEqual(f.calls.embed.slice(before), [two.text]);
});

test('a semantic delivery arriving during a vector pass is retained separately', async t => {
  const f = await fixture(t), row = f.put();
  let notified = false;
  f.hooks.embed = async () => {
    if (!notified) { notified = true; await f.queue.notify(row); }
  };
  await f.queue.notify(row); await f.queue.flush();
  assert.equal(f.queue.status().completed, 1); assert.equal(f.calls.acquire, 2);
  assert.equal(f.calls.embed.length, 1); assert.equal(f.calls.semantic, 0);
});

test('coverage shows backlog while queue is paused, then catches up only after vector success', async t => {
  const f = await fixture(t), row = f.put(); await f.queue.notify(row);
  const before = await f.profiles.coverage({ grant: f.management });
  assert.equal(before.lastPreparation.state, 'ready'); assert.equal(before.pending, 1); assert.equal(before.caughtUp, false);
  await f.queue.flush();
  const after = await f.profiles.coverage({ grant: f.management });
  assert.equal(after.pending, 0); assert.equal(after.caughtUp, true);
});

test('revocation during encoding holds work, blocks activation and needs fresh original authorization to resume', async t => {
  const f = await fixture(t), row = f.put(); await f.queue.notify(row);
  f.hooks.embed = async () => { f.agents.get(row.sessionId).enabled = false; };
  // The host grant represents policy revocation with its abort signal.
  f.hooks.acquire = item => {
    const g = f.grant(item);
    f.hooks.embed = async () => { f.agents.get(row.sessionId).enabled = false; g.cancel(); };
    return g;
  };
  await f.queue.flush(); assert.equal(f.queue.status().completed, 0);
  assert.equal((await f.profiles.coverage({ grant: f.management })).caughtUp, false);
  delete f.hooks.acquire; delete f.hooks.embed;
  f.agents.get(row.sessionId).enabled = true;
  await f.queue.resume(); await f.queue.flush();
  if (f.queue.status().pending) await f.advance();
  assert.equal(f.queue.status().completed, 1);
});

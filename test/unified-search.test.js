import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemorySearchSession } from '../lib/suzu/search-session.js';

const PROFILE = { id: 'fixture-vector', revision: 1, model: 'fixture', dimensions: 2,
  encoding: { normalized: true }, backend: 'injected', adapter: 'fixture' };
const record = (id = 'note', revision = 1, text = '虚构资料') => ({ id, revision, text,
  anchor: { path: `fixture/${id}`, line: 1 }, sourceIds: [`source-${id}`] });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
function policyFixture() {
  let enabled = true, epoch = 'first';
  const listeners = new Set();
  const policy = {
    grant(agent) {
      assert.equal(agent, 'trusted-agent');
      if (!enabled) throw Error('private reason must not be echoed');
      return { scope: { ownerSubject: 'owner-fixture', project: 'project-fixture',
        sessionId: 'session-fixture', rootSessionId: 'session-fixture' }, epoch };
    },
    validate(grant) { return enabled && grant.epoch === epoch; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
  };
  return { policy,
    close(notify = true) { enabled = false; epoch = 'second'; if (notify) for (const listener of listeners) listener(); },
    reopen() { enabled = true; }, listeners };
}
function fixture(options = {}) {
  const auth = policyFixture(), requests = [];
  const session = createMemorySearchSession({ policy: auth.policy, agent: 'trusted-agent',
    search: async args => { requests.push(args); return { records: [record()] }; }, ...options });
  return { ...auth, session, requests };
}

test('scope comes only from the grant; model identity parameters never reach a backend', async () => {
  const { session, requests } = fixture();
  assert.equal((await session.search({ query: 'fixture', ownerSubject: 'other' })).error.code, 'INPUT');
  assert.equal((await session.search({ query: 'fixture', profile: PROFILE })).error.code, 'INPUT');
  assert.equal(requests.length, 0);
  const result = await session.search({ query: 'fixture' });
  assert.equal(result.status, 'ok');
  assert.equal(requests[0].scope.ownerSubject, 'owner-fixture');
  assert.equal(requests[0].scope.epoch, 'first');
  assert.ok(Object.isFrozen(requests[0].scope));
  session.dispose();
});

test('default-off policy refusal is content-free and consumes no backend call', async () => {
  const { session, requests, close } = fixture();
  close();
  const result = await session.search({ query: 'fixture' });
  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.equal(requests.length, 0);
  assert.doesNotMatch(JSON.stringify(result), /private reason|owner-fixture/);
  session.dispose();
});

test('id plus revision dedup keeps changed versions while suppressing repeated hits', async () => {
  let revision = 1;
  const { session } = fixture({ search: async () => ({ records: [record('note', revision), record('note', revision)] }) });
  assert.equal((await session.search({ query: 'fixture' })).records.length, 1);
  assert.equal((await session.search({ query: 'again' })).records.length, 0);
  revision++;
  assert.equal((await session.search({ query: 'updated' })).records[0].revision, 2);
  session.dispose();
});

test('parallel tool invocations share the call ceiling', async () => {
  const { session, requests } = fixture({ limits: { calls: 1 } });
  const results = await Promise.all([session.search({ query: 'first' }), session.search({ query: 'second' })]);
  assert.equal(results[0].status, 'ok');
  assert.equal(results[1].error.code, 'CALLS');
  assert.equal(requests.length, 1);
  session.dispose();
});

test('per-call records and full serialized output obey shared character budgets', async () => {
  const { session } = fixture({ search: async ({ query }) => ({ records: [record(query, 1, '长'.repeat(5000)), record('extra')] }),
    limits: { records: 1, chars: 700, totalChars: 1100 } });
  const first = await session.search({ query: 'first' });
  assert.equal(first.status, 'budget');
  assert.ok(first.records[0].truncated);
  assert.ok(JSON.stringify(first).length <= 700);
  assert.equal(first.budget.chars, JSON.stringify(first).length);
  const second = await session.search({ query: 'second' });
  if (second.records.length) assert.ok(JSON.stringify(first).length + JSON.stringify(second).length <= 1100);
  assert.ok(session.budget().chars <= 1100);
  session.dispose();
});

test('oversized sources or anchors cannot bypass character accounting', async () => {
  const { session } = fixture({ limits: { chars: 500, totalChars: 500 },
    search: async () => ({ records: [{ ...record(), text: 'x', source: { text: 'private'.repeat(500) } }] }) });
  const result = await session.search({ query: 'fixture' });
  assert.equal(result.error.code, 'CHARS');
  assert.deepEqual(result.records, []);
  assert.equal(session.budget().chars, 0);
  session.dispose();
});

test('record limit returns an explicit budget status even for an overeager backend', async () => {
  const { session } = fixture({ limits: { records: 1 },
    search: async () => ({ records: [record('one'), record('two')] }) });
  const result = await session.search({ query: 'fixture', limit: 20 });
  assert.equal(result.records.length, 1);
  assert.equal(result.error.code, 'RECORDS');
  session.dispose();
});

test('expansion accepts issued anchors only and shares calls and character accounting', async () => {
  const expandedRequests = [];
  const { session } = fixture({ limits: { calls: 3 }, expand: async args => {
    expandedRequests.push(args); return { records: [record('note', 1, '虚构的完整原文')] };
  } });
  const found = await session.search({ query: 'fixture' });
  assert.equal((await session.expand({ anchor: { id: 'unissued' } })).error.code, 'INPUT');
  const full = await session.expand({ anchor: found.records[0].anchor });
  assert.equal(full.records[0].text, '虚构的完整原文');
  assert.equal(expandedRequests[0].id, 'note');
  assert.equal(expandedRequests[0].revision, 1);
  assert.equal(expandedRequests[0].scope.project, 'project-fixture');
  assert.equal(full.budget.chars, JSON.stringify(found).length + JSON.stringify(full).length);
  assert.equal((await session.expand({ anchor: found.records[0].anchor })).records.length, 0);
  assert.equal((await session.search({ query: 'exhausted' })).error.code, 'CALLS');
  session.dispose();
});

test('first backend profile is cloned, frozen and supplied to all subsequent operations', async () => {
  const requests = [], initial = structuredClone(PROFILE);
  const { session } = fixture({ search: async args => {
    requests.push(args); return { records: [record(args.query)], ...(requests.length === 1 ? { profile: initial } : {}) };
  } });
  await session.search({ query: 'one' });
  initial.encoding.normalized = false;
  await session.search({ query: 'two' });
  assert.equal(requests[0].profile, null);
  assert.equal(requests[1].profile.encoding.normalized, true);
  assert.ok(Object.isFrozen(requests[1].profile.encoding));
  session.dispose();
});

test('optional getProfile pins before reading and later mismatched profiles expose no records', async () => {
  const requests = [];
  const { session } = fixture({ getProfile: async () => PROFILE,
    search: async args => { requests.push(args); return { records: [record()], profile: { ...PROFILE, revision: 2 } }; } });
  const result = await session.search({ query: 'fixture' });
  assert.deepEqual(requests[0].profile, PROFILE);
  assert.equal(result.error.code, 'PROFILE');
  assert.deepEqual(result.records, []);
  assert.equal(session.budget().chars, 0);
  session.dispose();
});

test('a text-only first result cannot silently upgrade to a vector profile', async () => {
  let calls = 0;
  const { session } = fixture({ search: async () => ({ records: [record(String(++calls))],
    ...(calls > 1 ? { profile: PROFILE } : {}) }) });
  await session.search({ query: 'text' });
  assert.equal((await session.search({ query: 'vector' })).error.code, 'PROFILE');
  session.dispose();
});

test('silent revocation then reopen invalidates a late result by epoch', async () => {
  const entered = deferred(), finish = deferred();
  const { session, close, reopen } = fixture({ search: async () => {
    entered.resolve(); await finish.promise; return { records: [record('private')] };
  } });
  const pending = session.search({ query: 'fixture' });
  await entered.promise;
  close(false); reopen(); finish.resolve();
  const result = await pending;
  assert.equal(result.status, 'denied');
  assert.deepEqual(result.records, []);
  assert.equal(session.budget().chars, 0);
  session.dispose();
});

test('revocation promptly releases a backend that ignores AbortSignal', async () => {
  const entered = deferred();
  const { session, close } = fixture({ search: args => {
    entered.resolve(args); return new Promise(() => {});
  } });
  const pending = session.search({ query: 'fixture' });
  const args = await entered.promise;
  close();
  assert.equal((await pending).status, 'denied');
  assert.equal(args.signal.aborted, true);
  session.dispose();
});

test('cancellation releases both an ignoring backend and queued calls', async () => {
  const entered = deferred();
  const { session } = fixture({ search: () => { entered.resolve(); return new Promise(() => {}); } });
  const first = session.search({ query: 'fixture' }), second = session.search({ query: 'queued' });
  await entered.promise;
  session.cancel();
  assert.equal((await first).status, 'cancelled');
  assert.equal((await second).status, 'cancelled');
  session.dispose();
});

test('a caller AbortSignal cancels the answer without returning a backend error', async () => {
  const entered = deferred(), controller = new AbortController();
  const { session } = fixture({ search: () => { entered.resolve(); return new Promise(() => {}); } });
  const pending = session.search({ query: 'fixture' }, { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error('private details'));
  assert.equal((await pending).status, 'cancelled');
  session.dispose();
});

test('time between subqueries does not consume the shared retrieval work budget', async () => {
  let clock = 0;
  const requests = [];
  const { session } = fixture({ now: () => clock, limits: { timeoutMs: 20 },
    search: async args => { requests.push(args); clock += 5; return { records: [record(args.query)] }; } });
  assert.equal((await session.search({ query: 'one' })).status, 'ok');
  assert.equal(session.budget().remainingMs, 15);
  clock += 60_000;
  assert.equal(session.budget().remainingMs, 15);
  const result = await session.search({ query: 'two' });
  assert.equal(result.status, 'ok');
  assert.equal(result.budget.remainingMs, 10);
  assert.equal(requests.length, 2);
  session.dispose();
});

test('search and expansion accumulate work and reject a result that exhausts the shared time budget', async () => {
  let clock = 0, expansions = 0;
  const { session } = fixture({ now: () => clock, limits: { timeoutMs: 20 },
    search: async () => { clock += 7; return { records: [record()] }; },
    expand: async () => { expansions++; clock += 13; return { records: [record('note', 1, 'expanded')] }; } });
  const found = await session.search({ query: 'fixture' });
  assert.equal(found.budget.remainingMs, 13);
  clock += 60_000;
  const expanded = await session.expand({ anchor: found.records[0].anchor });
  assert.equal(expanded.status, 'timeout');
  assert.deepEqual(expanded.records, []);
  assert.equal(session.budget().remainingMs, 0);
  assert.equal((await session.search({ query: 'exhausted' })).status, 'timeout');
  assert.equal(expansions, 1);
  session.dispose();
});

test('backend errors are readable but never echo arbitrary error strings', async () => {
  const { session } = fixture({ search: async () => { throw Error('secret-source /private/path'); } });
  const result = await session.search({ query: 'fixture' });
  assert.equal(result.error.code, 'BACKEND');
  assert.doesNotMatch(JSON.stringify(result), /secret-source|private\/path/);
  assert.deepEqual(result.records, []);
  session.dispose();
});

test('elapsed backend timeout aborts its signal and does not wait for cooperation', async () => {
  let signal;
  const { session } = fixture({ limits: { timeoutMs: 20 }, search: args => {
    signal = args.signal; return new Promise(() => {});
  } });
  const result = await session.search({ query: 'fixture' });
  assert.equal(result.status, 'timeout');
  assert.equal(signal.aborted, true);
  assert.deepEqual(result.records, []);
  session.dispose();
});

test('a rejected malformed scope cannot become usable on a second request', async () => {
  let calls = 0;
  const session = createMemorySearchSession({ agent: 'fixture',
    policy: { grant: () => ({ ownerSubject: 'incomplete' }), validate: () => true },
    search: async () => { calls++; return { records: [record()] }; } });
  assert.equal((await session.search({ query: 'one' })).status, 'denied');
  assert.equal((await session.search({ query: 'two' })).status, 'denied');
  assert.equal(calls, 0);
  session.dispose();
});

test('a pinned profile is also supplied to original-source expansion', async () => {
  let expansion;
  const { session } = fixture({ getProfile: () => PROFILE, expand: async args => {
    expansion = args; return { records: [record('note', 1, 'expanded')] };
  } });
  const result = await session.search({ query: 'fixture' });
  await session.expand({ anchor: result.records[0].anchor });
  assert.deepEqual(expansion.profile, PROFILE);
  session.dispose();
});

test('grant abort alone releases pending reads without a policy notification', async () => {
  const auth = new AbortController(), entered = deferred();
  const credential = { ownerSubject: 'fixture', project: 'fixture', sessionId: 'fixture',
    rootSessionId: 'fixture', epoch: 'fixture', signal: auth.signal };
  const session = createMemorySearchSession({ policy: { grant: () => credential, validate: () => true },
    search: async () => { entered.resolve(); return new Promise(() => {}); } });
  const pending = session.search({ query: 'fixture' });
  await entered.promise;
  auth.abort();
  assert.equal((await pending).status, 'denied');
  session.dispose();
});

test('dispose releases the read grant and subscription once', async () => {
  let releases = 0, subscriptions = 0;
  const { session } = fixture({ policy: {
    grant: () => ({ ownerSubject: 'fixture', project: 'fixture', sessionId: 'fixture',
      rootSessionId: 'fixture', epoch: 'fixture', cancel() { releases++; } }),
    validate: () => true,
    subscribe() { subscriptions++; return () => { subscriptions--; }; },
  } });
  await session.search({ query: 'fixture' });
  assert.equal(subscriptions, 1);
  session.dispose(); session.dispose();
  assert.equal(releases, 1);
  assert.equal(subscriptions, 0);
});

test('a budget too small for any serialized record stops before requesting the backend', async () => {
  const { session, requests } = fixture({ limits: { totalChars: 20 } });
  assert.equal((await session.search({ query: 'fixture' })).error.code, 'CHARS');
  assert.equal(requests.length, 0);
  session.dispose();
});

test('issued object anchors remain usable after the model reorders object keys', async () => {
  const { session } = fixture({ expand: async () => ({ records: [record('note', 1, 'expanded')] }) });
  const found = await session.search({ query: 'fixture' });
  const anchor = found.records[0].anchor;
  assert.equal((await session.expand({ anchor: { line: anchor.line, path: anchor.path } })).status, 'ok');
  session.dispose();
});

test('query length matches the 2000-character source contract', async () => {
  const { session, requests } = fixture();
  assert.equal((await session.search({ query: 'x'.repeat(2001) })).error.code, 'INPUT');
  assert.equal(requests.length, 0);
  assert.equal((await session.search({ query: 'x'.repeat(2000) })).status, 'ok');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query.length, 2000);
  session.dispose();
});

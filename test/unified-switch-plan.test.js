import test from 'node:test';
import assert from 'node:assert/strict';
import { switchFixture, profile, doc } from './unified-switch-fixture.js';
import { estimateTokens } from '../lib/unified/switch-estimate.js';

const constructs = f => f.calls.filter(row => row.op === 'construct').length;
const pick = (plan, keys) => Object.fromEntries(keys.map(key => [key, plan[key]]));
const KEYS = ['total', 'reusable', 'pending', 'removed', 'pendingChars', 'hasSnapshot', 'active'];

test('token estimate counts CJK as one token and other text as four characters', () => {
  assert.equal(estimateTokens({ length: 10, cjk: 2 }), 4);
  assert.equal(estimateTokens({ length: 3 }), null);
});

test('new profile: everything pending, no backend constructed', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('a', '你好世界'), doc('b', 'abcdefgh')]); await f.choose();
  const plan = await f.api.plan({ grant: f.g });
  assert.deepEqual(pick(plan, KEYS), { total: 2, reusable: 0, pending: 2, removed: 0, pendingChars: 12, hasSnapshot: false, active: false });
  assert.equal(plan.estimatedTokens, 6); assert.equal(plan.cloud, false);
  assert.equal(constructs(f), 0);
  assert.equal((await f.api.status({ grant: f.g })).profiles[0].index.hasSnapshot, false);
});

test('switching back counts only the delta and shows a stale old profile', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one'), doc('two'), doc('three')]); await f.choose(profile('A')); await f.api.prepare({ grant: f.g });
  await f.choose(profile('B')); await f.api.prepare({ grant: f.g });
  f.setRows([doc('one'), doc('two', 'edited', 2), doc('four')]);
  const before = constructs(f);
  const plan = await f.api.plan({ grant: f.g, profileId: 'A' });
  assert.deepEqual(pick(plan, KEYS), { total: 3, reusable: 1, pending: 2, removed: 1, pendingChars: 10, hasSnapshot: true, active: false });
  assert.equal(constructs(f), before);
  const status = await f.api.status({ grant: f.g });
  assert.equal(status.profiles.find(row => row.id === 'A').index.hasSnapshot, true);
});

test('runtime-only change keeps zero delta; model directory change needs a full build', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one'), doc('two')]); await f.choose(); await f.api.prepare({ grant: f.g });
  await f.api.register({ profile: profile('A', { backend: { config: { rawRecallDevice: 'cpu' } } }), grant: f.g });
  let plan = await f.api.plan({ grant: f.g });
  assert.deepEqual([plan.pending, plan.reusable, plan.active], [0, 2, true]);
  await f.api.register({ profile: profile('A', { backend: { config: { rawRecallBgeModelDir: 'fictional-moved-models' } } }), grant: f.g });
  plan = await f.api.plan({ grant: f.g });
  assert.deepEqual([plan.pending, plan.reusable, plan.hasSnapshot], [2, 0, false]);
  assert.equal(constructs(f), 1);
});

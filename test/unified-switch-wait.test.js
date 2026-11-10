import test from 'node:test';
import assert from 'node:assert/strict';
import { switchFixture, profile, doc, defer } from './unified-switch-fixture.js';

async function busyQuery(f) {
  f.setRows([doc('one'), doc('two')]); await f.choose(profile('A')); await f.api.prepare({ grant: f.g });
  const entered = defer(), release = defer();
  f.hooks.embed = async (texts, options) => { if (options.kind === 'query') { entered.resolve(); await release.promise; } };
  const query = f.api.query({ query: 'anything', grant: f.grant('management') });
  await entered.promise; f.hooks.embed = undefined;
  await f.choose(profile('B'));
  return { query, release };
}
const progressOf = async (f, id) => (await f.api.status({ grant: f.g })).profiles.find(row => row.id === id).progress;

test('preparation waits for an in-flight query of another profile, then succeeds', async t => {
  const f = await switchFixture(t);
  const { query, release } = await busyQuery(f);
  const preparing = f.api.prepare({ grant: f.g });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal((await progressOf(f, 'B')).state, 'preparing');
  release.resolve();
  assert.equal((await query).records.length > 0, true);
  const result = await preparing;
  assert.equal(result.state, 'ready'); assert.equal(result.profile.id, 'B');
  const progress = await progressOf(f, 'B');
  assert.equal(progress.state, 'ready'); assert.equal(progress.error, null);
});

test('cancelling while waiting exits cleanly', async t => {
  const f = await switchFixture(t);
  const { query, release } = await busyQuery(f);
  const preparing = f.api.prepare({ grant: f.g });
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.api.cancel({ grant: f.g });
  await assert.rejects(preparing, { code: 'PROFILE_CANCELLED' });
  assert.equal((await progressOf(f, 'B')).state, 'cancelled');
  release.resolve(); await query;
  assert.equal((await f.api.status({ grant: f.g })).activeProfileId, 'A');
});

test('waiting past the bound still fails with EMBEDDING_BUSY', async t => {
  const f = await switchFixture(t, { extra: { prepareWaitMs: 60 } });
  const { query, release } = await busyQuery(f);
  await assert.rejects(f.api.prepare({ grant: f.g }), { code: 'EMBEDDING_BUSY' });
  release.resolve(); await query;
});

test('queries during preparation still fail at once (degraded upstream)', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one'), doc('two')]); await f.choose(profile('A')); await f.api.prepare({ grant: f.g });
  await f.choose(profile('B'));
  const entered = defer(), release = defer();
  f.hooks.embed = async (texts, options) => { if (options.kind === 'document') { entered.resolve(); await release.promise; } };
  const preparing = f.api.prepare({ grant: f.g });
  await entered.promise;
  const started = Date.now();
  await assert.rejects(f.api.query({ query: 'anything', grant: f.grant('management') }), { code: 'EMBEDDING_BUSY' });
  assert.ok(Date.now() - started < 1000);
  f.hooks.embed = undefined; release.resolve();
  assert.equal((await preparing).state, 'ready');
});

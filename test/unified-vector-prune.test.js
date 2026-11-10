import test from 'node:test';
import assert from 'node:assert/strict';
import { switchFixture, profile, doc, defer } from './unified-switch-fixture.js';

const counts = f => ({
  snapshots: f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready'"),
  members: f.count('SELECT COUNT(*) AS n FROM vector_members'),
  documents: f.count('SELECT COUNT(*) AS n FROM vector_documents'),
  chunks: f.count('SELECT COUNT(*) AS n FROM vector_chunks'),
});

test('200 documents and 20 single-document increments keep one ready snapshot', async t => {
  const f = await switchFixture(t);
  const rows = Array.from({ length: 200 }, (_, i) => doc(`d${i}`));
  f.setRows(rows); await f.choose(); await f.api.prepare({ grant: f.g });
  for (let i = 0; i < 20; i++) { rows.push(doc(`n${i}`)); f.setRows([...rows]); await f.api.incremental({ grant: f.g }); }
  assert.deepEqual(counts(f), { snapshots: 1, members: 220, documents: 220, chunks: 220 });
  const result = await f.api.query({ query: 'anything', grant: f.g, limit: 40 });
  assert.equal(result.records.length, 40);
});

test('old versions of edited and removed documents are reclaimed', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('a'), doc('b'), doc('c')]); await f.choose(); await f.api.prepare({ grant: f.g });
  f.setRows([doc('a'), doc('b', 'edited', 2)]); await f.api.incremental({ grant: f.g });
  assert.deepEqual(counts(f), { snapshots: 1, members: 2, documents: 2, chunks: 2 });
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_documents WHERE doc_id='b' AND revision='2'"), 1);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_documents WHERE doc_id IN ('c') OR (doc_id='b' AND revision='1')"), 0);
});

test('incremental on profile B never prunes profile A, and switching back still reuses A', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one'), doc('two')]); await f.choose(profile('A')); await f.api.prepare({ grant: f.g });
  await f.choose(profile('B')); await f.api.prepare({ grant: f.g });
  f.setRows([doc('one'), doc('two', 'edited', 2)]);
  for (let i = 0; i < 3; i++) await f.api.incremental({ grant: f.g });
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready' AND profile_id='A'"), 1);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready' AND profile_id='B'"), 1);
  await f.api.select({ profileId: 'A', grant: f.g });
  const before = f.embedded('A').length;
  await f.api.prepare({ grant: f.g });
  assert.deepEqual(f.embedded('A').slice(before), ['edited']);
});

test('a query reading a snapshot during pruning still returns normally', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one'), doc('two')]); await f.choose(); const first = (await f.api.prepare({ grant: f.g })).profile;
  const entered = defer(), release = defer();
  f.hooks.embed = async (texts, options) => { if (options.kind === 'query') { entered.resolve(); await release.promise; } };
  const reader = f.grant('management');
  const query = f.api.query({ query: 'anything', grant: reader, profile: first, limit: 5 });
  await entered.promise; f.hooks.embed = undefined;
  // singleBackend shares the same profile backend, so the increment can run.
  f.setRows([doc('one'), doc('two', 'edited', 2)]);
  await f.api.incremental({ grant: f.g });
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready'"), 2);
  release.resolve();
  const result = await query;
  assert.equal(result.profile.indexId, first.indexId);
  assert.deepEqual(result.records.map(row => row.id), ['one']);
  f.setRows([doc('one'), doc('two', 'edited again', 3)]);
  await f.api.incremental({ grant: f.g });
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready'"), 1);
});

test('a snapshot pinned by an answer grant survives pruning until the grant ends', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one')]); await f.choose(); await f.api.prepare({ grant: f.g });
  const answer = f.grant();
  const pinned = await f.api.activeSnapshot({ grant: answer });
  f.setRows([doc('one', 'edited', 2)]); await f.api.incremental({ grant: f.g });
  assert.equal((await f.api.query({ query: 'x', grant: answer, profile: pinned })).profile.indexId, pinned.indexId);
  answer.cancel();
  f.setRows([doc('one', 'edited again', 3)]); await f.api.incremental({ grant: f.g });
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready'"), 1);
});

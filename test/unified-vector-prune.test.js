import test from 'node:test';
import assert from 'node:assert/strict';
import { switchFixture, profile, doc, defer } from './unified-switch-fixture.js';

const counts = f => ({
  snapshots: f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready'"),
  members: f.count('SELECT COUNT(*) AS n FROM vector_members'),
  documents: f.count('SELECT COUNT(*) AS n FROM vector_documents'),
  chunks: f.count('SELECT COUNT(*) AS n FROM vector_chunks'),
});
const ready = f => f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready'");
// Each call adds one new document, so every increment builds a new snapshot.
async function grow(f, rows, times, prefix) {
  for (let i = 0; i < times; i++) { rows.push(doc(`${prefix}${i}`)); f.setRows([...rows]); await f.api.incremental({ grant: f.g }); }
}

test('200 documents and 20 single-document increments keep the newest five ready snapshots', async t => {
  const f = await switchFixture(t);
  const rows = Array.from({ length: 200 }, (_, i) => doc(`d${i}`));
  f.setRows(rows); await f.choose(); await f.api.prepare({ grant: f.g });
  await grow(f, rows, 20, 'n');
  // Members of the five newest snapshots: 216 + 217 + 218 + 219 + 220.
  assert.deepEqual(counts(f), { snapshots: 5, members: 1090, documents: 220, chunks: 220 });
  const result = await f.api.query({ query: 'anything', grant: f.g, limit: 40 });
  assert.equal(result.records.length, 40);
});

test('retention is configurable; one keeps only the newest snapshot', async t => {
  const f = await switchFixture(t, { extra: { keepSnapshots: 1 } });
  const rows = Array.from({ length: 10 }, (_, i) => doc(`d${i}`));
  f.setRows(rows); await f.choose(); await f.api.prepare({ grant: f.g });
  await grow(f, rows, 3, 'n');
  assert.deepEqual(counts(f), { snapshots: 1, members: 13, documents: 13, chunks: 13 });
});

test('old versions of edited and removed documents are reclaimed once no kept snapshot uses them', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('a'), doc('b'), doc('c')]); await f.choose(); await f.api.prepare({ grant: f.g });
  const rows = [doc('a'), doc('b', 'edited', 2)];
  f.setRows([...rows]); await f.api.incremental({ grant: f.g });
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_documents WHERE doc_id='c'"), 1, 'still in a kept snapshot');
  await grow(f, rows, 5, 'n');
  assert.equal(ready(f), 5);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_documents WHERE doc_id='c' OR (doc_id='b' AND revision='1')"), 0);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_documents WHERE doc_id='b' AND revision='2'"), 1);
  assert.deepEqual([counts(f).documents, counts(f).chunks], [7, 7]);
});

test('incremental on profile B never prunes profile A, and switching back still reuses A', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one'), doc('two')]); await f.choose(profile('A')); await f.api.prepare({ grant: f.g });
  await f.choose(profile('B')); await f.api.prepare({ grant: f.g });
  const rows = [doc('one'), doc('two', 'edited', 2)];
  f.setRows([...rows]); await f.api.incremental({ grant: f.g });
  await grow(f, rows, 6, 'n');
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready' AND profile_id='A'"), 1);
  assert.equal(f.count("SELECT COUNT(*) AS n FROM vector_snapshots WHERE state='ready' AND profile_id='B'"), 5);
  await f.api.select({ profileId: 'A', grant: f.g });
  const before = f.embedded('A').length;
  await f.api.prepare({ grant: f.g });
  assert.deepEqual(f.embedded('A').slice(before).sort(), ['edited', 'n0', 'n1', 'n2', 'n3', 'n4', 'n5']);
});

test('a query reading an old snapshot during pruning still returns normally', async t => {
  const f = await switchFixture(t);
  const rows = [doc('one'), doc('two')];
  f.setRows([...rows]); await f.choose(); const first = (await f.api.prepare({ grant: f.g })).profile;
  const entered = defer(), release = defer();
  f.hooks.embed = async (texts, options) => { if (options.kind === 'query') { entered.resolve(); await release.promise; } };
  const query = f.api.query({ query: 'anything', grant: f.grant('management'), profile: first, limit: 5 });
  await entered.promise; f.hooks.embed = undefined;
  await grow(f, rows, 6, 'n');
  assert.equal(ready(f), 6, 'five newest plus the one being read');
  release.resolve();
  const result = await query;
  assert.equal(result.profile.indexId, first.indexId);
  assert.deepEqual(result.records.map(row => row.id).sort(), ['one', 'two']);
  await grow(f, rows, 1, 'm');
  assert.equal(ready(f), 5);
});

test('a snapshot pinned by an answer grant survives pruning until the grant ends', async t => {
  const f = await switchFixture(t);
  const rows = [doc('one')];
  f.setRows([...rows]); await f.choose(); await f.api.prepare({ grant: f.g });
  const answer = f.grant();
  const pinned = await f.api.activeSnapshot({ grant: answer });
  await grow(f, rows, 6, 'n');
  assert.equal(ready(f), 6);
  assert.equal((await f.api.query({ query: 'x', grant: answer, profile: pinned })).profile.indexId, pinned.indexId);
  answer.cancel();
  await grow(f, rows, 1, 'm');
  assert.equal(ready(f), 5);
});

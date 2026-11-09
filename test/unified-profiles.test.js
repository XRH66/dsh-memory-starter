import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { createUnifiedProfiles, profileFromLegacy } from '../lib/unified/profiles.js';
import { identifyAssets } from '../lib/raw-rag/assets.js';
import { requestEmbeddingService } from '../lib/raw-rag/embedding-http.js';
import { EmbeddingBackend } from '../lib/raw-rag/backend.js';
import { planEmbeddingChunks } from '../lib/raw-rag/chunks.js';
import { buildRawEmbeddingContext } from '../lib/raw-rag/embedding-material.js';
import { sourceTextHash } from '../lib/source-lineage.js';

// Synthetic adapters/documents only; no local model, user database or host.
const defer = () => {
  let resolve; const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const profile = (id = 'A', extra = {}) => ({ id, model: 'BAAI/bge-small-zh-v1.5', ...extra });
const doc = (id, domain = 'raw', text = id, revision = 1) => ({ id, revision, domain, text,
  sourceIds: [`source:${id}`], anchor: { id, revision } });
const backgroundMessage = (id, text, role = 'user', revision = 1) => ({ id, revision, role, text,
  ref: { storage: 'message', id, revision } });
function contextualDoc(id, text, context) {
  const row = doc(id, 'raw', text);
  row.anchor.ref = { storage: 'message', id, revision: row.revision };
  const { proof, ...embedding } = buildRawEmbeddingContext({ ...row, role: 'user' }, context);
  return { ...row, embedding, anchor: { ...row.anchor, embedding: proof } };
}
function storedChunks(file, snapshot, id) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT c.start,c.end,c.token_bound AS tokenBound,c.text_hash AS textHash FROM vector_chunks c
      JOIN vector_members m ON c.document_version_id=m.document_version_id
      WHERE m.snapshot_id=? AND m.doc_id=? ORDER BY c.ordinal`).all(snapshot.indexId, id).map(row => ({ ...row }));
  } finally { db.close(); }
}

async function fixture(t, { queryCandidateLimit } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'unified-profile-fixture-'));
  const file = path.join(directory, 'profiles.json'), indexFile = path.join(directory, 'index.sqlite');
  const valid = new WeakSet(), rows = new Map(), calls = [], instances = [];
  const hooks = {};
  function grant(ownerSubject = 'fictional-owner', project = 'fictional-project') {
    const controller = new AbortController();
    const value = { ownerSubject, project, signal: controller.signal, cancel: () => { valid.delete(value); controller.abort(); } };
    valid.add(value); return value;
  }
  const g = grant(), scope = value => JSON.stringify([value.ownerSubject, value.project]);
  rows.set(scope(g), []);
  const authorize = value => valid.has(value) && !value.signal.aborted;
  const options = { file, indexFile, authorize, queryCandidateLimit,
    async *listDocumentMetadata({ grant: current }) {
      calls.push({ op: 'metadata', scope: scope(current) });
      for (const { text, ...row } of rows.get(scope(current)) ?? []) yield structuredClone(row);
    },
    async *listDocuments({ grant: current }) {
      calls.push({ op: 'list', scope: scope(current) });
      for (const row of [...(rows.get(scope(current)) ?? [])]) yield structuredClone(row);
    },
    async resolveDocument({ id, revision, anchor, grant: current }) {
      calls.push({ op: 'resolve', id, revision, anchor, scope: scope(current) });
      const result = await hooks.resolve?.({ id, revision, anchor, grant: current });
      if (!authorize(current)) throw Object.assign(new Error('revoked'), { code: 'MEMORY_ACCESS_DENIED' });
      if (result !== undefined) return result;
      const row = rows.get(scope(current))?.find(row => row.id === id && row.revision === revision);
      return row ? structuredClone(row) : null;
    },
    createBackend({ config, profile: definition, cacheFile, onUsage }) {
      calls.push({ op: 'construct', id: definition.id, cacheFile });
      const identity = { modelKey: `${definition.id}:${definition.revision}:synthetic-space`, dimensions: definition.dimensions };
      const resources = { cacheFile, onUsage: receipt => onUsage({ ...receipt, modelKey: identity.modelKey }) };
      const backend = {
        modelKey: null, dimensions: identity.dimensions, batchSize: 2, disposed: false,
        async prepare() {
          calls.push({ op: 'load', id: definition.id }); await hooks.prepare?.(definition, resources);
          if (backend.disposed) throw new Error('disposed'); backend.modelKey = identity.modelKey; return identity;
        },
        async planChunks(text, options) {
          calls.push({ op: 'plan', text, options });
          await options.authorize(); options.signal.throwIfAborted();
          if (hooks.plan) return hooks.plan(text, options);
          const chunks = [];
          for (let start = 0; start < text.length; start += 200) {
            const end = Math.min(text.length, start + 200);
            chunks.push({ start, end, text: text.slice(start, end), tokenBound: end - start });
          }
          return chunks;
        },
        async embed(texts, options) {
          calls.push({ op: 'embed', id: definition.id, texts, kind: options.kind, scope: options.scope });
          await options.authorize(); options.signal.throwIfAborted(); await hooks.embed?.(texts, options, definition, resources);
          await options.authorize(); options.signal.throwIfAborted();
          if (hooks.vectors) return hooks.vectors(texts, options, definition);
          return texts.map(() => Array.from({ length: config.rawRecallDimensions }, (_, index) => index === 0 ? 1 : 0));
        },
        async dispose() { backend.disposed = true; backend.modelKey = null; await hooks.dispose?.(definition, resources); },
      };
      instances.push(backend); return backend;
    },
  };
  let api = createUnifiedProfiles(options);
  t.after(async () => { await api.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { get api() { return api; }, file, indexFile, rows, g, grant, valid, calls, hooks, instances, scope,
    setRows(value, current = g) { rows.set(scope(current), value); },
    async choose(value = profile(), current = g) {
      await api.register({ profile: value, grant: current });
      await api.select({ profileId: value.id, grant: current });
    },
    async restart() { await api.close(); api = createUnifiedProfiles(options); await api.ready(); },
  };
}

test('construction and concurrent ready read metadata only', async t => {
  const f = await fixture(t);
  assert.equal(f.calls.length, 0);
  const [one, two] = await Promise.all([f.api.ready({}), f.api.ready({})]);
  assert.equal(one.revision, two.revision); assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.indexFile), { code: 'ENOENT' });
  const state = await f.api.status({ grant: f.g });
  assert.equal(state.active, null); assert.equal(state.selectedProfileId, null);
});

test('synchronous peek returns only loaded safe metadata and never claims index ready', async t => {
  const f = await fixture(t);
  assert.deepEqual(f.api.peek(), { loaded: false, revision: null, selectedProfileId: null, activeProfile: null });
  assert.equal(f.calls.length, 0);
  await f.choose(profile('A', { backend: { config: { rawRecallBgeModelDir: 'fictional-private-directory' } } }));
  assert.equal(f.api.peek().selectedProfileId, 'A');
  assert.equal(f.api.peek().activeProfile, null);
  await assert.rejects(fs.stat(f.indexFile), { code: 'ENOENT' });
  await f.api.prepare({ grant: f.g });
  const before = f.calls.length, safe = f.api.peek();
  assert.deepEqual(Object.keys(safe.activeProfile).sort(), ['dimensions', 'id', 'model', 'revision']);
  assert.equal(safe.activeProfile.id, 'A');
  assert.equal(f.calls.length, before);
  assert.ok(!JSON.stringify(safe).includes('fictional-private-directory'));
  assert.ok(!JSON.stringify(safe).includes('indexId'));
});

test('real object identity authorizes management without any session fields', async t => {
  const f = await fixture(t); await f.choose();
  assert.equal((await f.api.status({ grant: f.g })).selectedProfileId, 'A');
  await assert.rejects(f.api.status({ grant: { ...f.g } }), { code: 'MEMORY_ACCESS_DENIED' });
  await assert.rejects(f.api.status({}), { code: 'MEMORY_ACCESS_DENIED' });
});

test('structured profile rejects code, custom pooling, keys and unknown adapters', async t => {
  const f = await fixture(t);
  for (const definition of [profile('A', { code: 'anything' }), profile('A', { encoding: { pooling: 'mean' } }),
    profile('A', { backend: { config: { apiKey: 'not-accepted' } } }), profile('A', { adapter: { type: 'generated', version: 1 } })]) {
    await assert.rejects(f.api.register({ profile: definition, grant: f.g }));
  }
  assert.equal(f.calls.length, 0);
});

test('legacy installer settings convert through the existing allowlist and real backend contract', async t => {
  const f = await fixture(t);
  const converted = profileFromLegacy({ id: 'legacy', label: 'Legacy fixture', settings: {
    rawRecallModel: 'light', rawRecallDimensions: 0, rawRecallMaxTokens: 2048,
    rawRecallQueryInstruction: 'unused instruction', rawRecallIdleMs: 0, rawRecallAllowCloud: false,
    rawRecallBgeModelDir: 'fictional-model-folder', rawRecallApiKeyEnv: 'FIXTURE_EMBEDDING_KEY',
    rawRecallOnnxModel: '', rawRecallGgufModel: null, rawRecallLlamaServer: undefined,
    rawRecallApiKey: 'inline-secret-do-not-copy', apiKey: 'other-secret-do-not-copy', rawRecallDbPath: 'private-database',
  } });
  assert.equal(converted.model, 'BAAI/bge-small-zh-v1.5');
  assert.equal(converted.dimensions, 512); assert.equal(converted.encoding.maxTokens, 512);
  assert.equal(converted.backend.config.rawRecallMaxTokens, 512);
  assert.equal(converted.backend.config.rawRecallIdleMs, 0);
  assert.equal(converted.backend.config.rawRecallAllowCloud, false);
  assert.equal(converted.backend.config.rawRecallApiKeyEnv, 'FIXTURE_EMBEDDING_KEY');
  for (const key of ['rawRecallQueryInstruction', 'rawRecallOnnxModel', 'rawRecallGgufModel', 'rawRecallLlamaServer', 'rawRecallApiKey', 'apiKey', 'rawRecallDbPath']) {
    assert.equal(Object.hasOwn(converted.backend.config, key), false);
  }
  assert.equal(Object.hasOwn(converted, 'revision'), false);
  assert.equal(Object.hasOwn(converted, 'createdAt'), false);
  assert.ok(!JSON.stringify(converted).includes('secret-do-not-copy'));
  const registered = await f.api.register({ profile: converted, grant: f.g });
  assert.equal(registered.profile.model, converted.model);
  assert.equal(f.calls.length, 0);
});

test('legacy conversion retains supported Qwen encoding and rejects unknown models or inline auth URLs', () => {
  const converted = profileFromLegacy({ id: 'qwen', settings: {
    rawRecallModel: 'Qwen/Qwen3-Embedding-0.6B', rawRecallDimensions: 1024,
    rawRecallMaxTokens: 3000, rawRecallQueryInstruction: 'Retrieve precise evidence',
  } });
  assert.equal(converted.encoding.maxTokens, 3000);
  assert.match(converted.encoding.query, /Retrieve precise evidence/u);
  assert.throws(() => profileFromLegacy({ id: 'unknown', settings: { rawRecallModel: 'not-supported' } }));
  assert.throws(() => profileFromLegacy({ id: 'cloud', settings: {
    rawRecallModel: 'text-embedding-v4', rawRecallApiBase: 'https://user:inline-secret@example.test/v1',
  } }));
  assert.throws(() => profileFromLegacy({ id: 'local', settings: {
    rawRecallModel: 'light', rawRecallApiBase: 'https://user:inline-secret@example.test/v1',
  } }));
});

test('registration is idempotent and stale configuration revisions fail', async t => {
  const f = await fixture(t), before = await f.api.ready();
  const first = await f.api.register({ profile: profile(), grant: f.g, expectedRevision: before.revision });
  const again = await f.api.register({ profile: profile(), grant: f.g });
  assert.equal(first.profile.revision, again.profile.revision);
  await assert.rejects(f.api.select({ profileId: 'A', grant: f.g, expectedRevision: before.revision }), { code: 'MEMORY_REVISION_CONFLICT' });
});

test('selection is pending until every existing domain is prepared', async t => {
  const f = await fixture(t);
  f.setRows([doc('raw'), doc('fact', 'fact'), doc('person', 'person'), doc('event', 'event'), doc('belief', 'belief')]);
  await f.choose(); assert.equal(await f.api.activeSnapshot({ grant: f.g }), null);
  const result = await f.api.prepare({ grant: f.g });
  assert.equal(result.completed, 5);
  assert.equal((await f.api.status({ grant: f.g })).activeProfileId, 'A');
  const data = new DatabaseSync(f.indexFile, { readOnly: true });
  try {
    assert.equal(data.prepare('SELECT COUNT(*) AS n FROM vector_members WHERE snapshot_id=?').get(result.profile.indexId).n, 5);
    assert.ok(!data.prepare('PRAGMA table_info(vector_documents)').all().some(row => row.name === 'text'));
  } finally { data.close(); }
});

test('document planning and query embedding use the existing kind contract', async t => {
  const f = await fixture(t); f.setRows([doc('raw', 'raw', 'x'.repeat(700))]);
  await f.choose(); await f.api.prepare({ grant: f.g });
  const result = await f.api.query({ query: 'fictional query', grant: f.g });
  assert.equal(result.records.length, 1);
  assert.ok(f.calls.some(row => row.op === 'plan' && row.text.length === 700));
  assert.equal(f.calls.filter(row => row.op === 'embed' && row.kind === 'document').flatMap(row => row.texts).join(''), 'x'.repeat(700));
  assert.ok(f.calls.some(row => row.op === 'embed' && row.kind === 'query'));
});

test('raw context drops whole old messages for small token budgets and preserves the original chunks', async t => {
  const f = await fixture(t);
  const first = '甲'.repeat(39) + '。', second = '后续的正文';
  const row = contextualDoc('center', first + second, [
    backgroundMessage('old', '不可在公网执行\n也不可向外发送'),
    backgroundMessage('new', '仅限本地', 'assistant'),
  ]);
  const budget = 40;
  f.hooks.plan = (text, options) => planEmbeddingChunks(text, {
    ...options, maxTokens: budget, countTokens: texts => texts.map(text => text.length),
  });
  f.setRows([row]); await f.choose();
  const { profile: snapshot } = await f.api.prepare({ grant: f.g });
  const shortPrefix = row.embedding.background[1] + '\n' + row.embedding.heading;
  assert.deepEqual(f.calls.filter(call => call.op === 'plan').map(call => call.text), [
    row.text, row.embedding.prefix + first, shortPrefix + first, row.embedding.prefix + second, shortPrefix + second,
  ]);
  const inputs = f.calls.filter(call => call.op === 'embed').flatMap(call => call.texts);
  assert.deepEqual(inputs, [first, shortPrefix + second]);
  assert.deepEqual(storedChunks(f.indexFile, snapshot, row.id), [
    { start: 0, end: first.length, tokenBound: first.length, textHash: sourceTextHash(inputs[0]) },
    { start: first.length, end: row.text.length, tokenBound: inputs[1].length, textHash: sourceTextHash(inputs[1]) },
  ]);
});

test('raw context anchor is rechecked before document dispatch and in queries, and background edits reencode', async t => {
  const f = await fixture(t, { queryCandidateLimit: 120 });
  const original = contextualDoc('center', '照这个规则办', [backgroundMessage('earlier', '不要联网')]);
  const changed = contextualDoc('center', original.text, [backgroundMessage('earlier', '只能在本地测试', 'user', 2)]);
  assert.equal(changed.revision, original.revision);
  assert.deepEqual(changed.anchor.ref, original.anchor.ref);
  f.setRows([original]); await f.choose();

  let dispatchChecks = 0;
  f.hooks.resolve = ({ anchor }) => {
    assert.deepEqual(anchor, original.anchor);
    dispatchChecks++;
    // Initial, source-plan and contextual-plan checks pass. The embedding
    // queue sees a valid record with a stale proof for the same center.
    return dispatchChecks === 4 ? changed : undefined;
  };
  let dispatched = 0;
  f.hooks.embed = () => { dispatched++; };
  const { profile: first } = await f.api.prepare({ grant: f.g });
  assert.equal(dispatched, 1);
  assert.equal(f.calls.filter(call => call.op === 'embed' && call.kind === 'document').length, 2);
  delete f.hooks.resolve;
  delete f.hooks.embed;

  const query = { query: '执行限制', grant: f.g, profile: first };
  const before = f.calls.length;
  const current = await f.api.query(query);
  assert.deepEqual(current.records.map(record => record.text), [original.text]);
  const resolves = f.calls.slice(before).filter(call => call.op === 'resolve');
  assert.equal(resolves.length, 2);
  for (const call of resolves) assert.deepEqual(call.anchor, original.anchor);
  let queryChecks = 0;
  f.hooks.resolve = () => ++queryChecks === 2 ? changed : undefined;
  assert.deepEqual((await f.api.query(query)).records, []);
  f.hooks.resolve = () => [{ ...original, id: 'another-document' }];
  assert.deepEqual((await f.api.query(query)).records, []);
  delete f.hooks.resolve;

  f.setRows([changed]);
  assert.deepEqual((await f.api.query(query)).records, []);
  const beforeIncremental = f.calls.length;
  const { profile: next } = await f.api.incremental({ grant: f.g });
  assert.notEqual(next.indexId, first.indexId);
  assert.deepEqual(f.calls.slice(beforeIncremental).filter(call => call.op === 'embed').flatMap(call => call.texts),
    [changed.embedding.prefix + changed.text]);
  assert.deepEqual((await f.api.query({ ...query, profile: next })).records.map(record => record.anchor.embedding),
    [changed.anchor.embedding]);
});

test('incomplete coverage and token overflow cannot activate a profile', async t => {
  const f = await fixture(t); f.setRows([doc('raw', 'raw', 'abcdef')]); await f.choose();
  f.hooks.plan = () => [{ start: 0, end: 3, text: 'abc', tokenBound: 3 }];
  await assert.rejects(f.api.prepare({ grant: f.g }), { code: 'INCOMPLETE_CHUNK_COVERAGE' });
  f.hooks.plan = () => [{ start: 0, end: 6, text: 'abcdef', tokenBound: 513 }];
  await assert.rejects(f.api.prepare({ grant: f.g }), { code: 'INVALID_CHUNK_PLAN' });
  assert.equal(await f.api.activeSnapshot({ grant: f.g }), null);
});

test('changing selected profile leaves active and explicitly pinned queries intact', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  const a = (await f.api.prepare({ grant: f.g })).profile;
  await f.choose(profile('B'));
  assert.equal((await f.api.activeSnapshot({ grant: f.g })).id, 'A');
  const b = (await f.api.prepare({ grant: f.g })).profile;
  assert.notEqual(a.indexIdentity, b.indexIdentity);
  assert.equal((await f.api.query({ query: 'anything', profile: a, grant: f.g })).profile.id, 'A');
  assert.equal((await f.api.query({ query: 'anything', grant: f.g })).profile.id, 'B');
});

test('explicit null snapshot stays text-only after a profile becomes active', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose(); await f.api.prepare({ grant: f.g });
  const before = f.calls.length;
  assert.deepEqual(await f.api.query({ query: 'anything', profile: null, grant: f.g }), { records: [], profile: null, state: 'unprepared' });
  assert.equal(f.calls.length, before);
});

test('same dimensions with a different query encoding do not share indices', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]);
  const qwen = { model: 'Qwen/Qwen3-Embedding-0.6B', dimensions: 1024 };
  await f.choose(profile('A', qwen)); const old = await f.api.prepare({ grant: f.g });
  const encoded = f.calls.filter(row => row.op === 'embed' && row.kind === 'document').length;
  await f.choose(profile('A', { ...qwen, backend: { config: { rawRecallQueryInstruction: 'Retrieve precisely' } } }));
  const next = await f.api.prepare({ grant: f.g });
  assert.notEqual(old.profile.revision, next.profile.revision);
  assert.notEqual(old.profile.indexIdentity, next.profile.indexIdentity);
  assert.ok(f.calls.filter(row => row.op === 'embed' && row.kind === 'document').length > encoded);
  assert.equal((await f.api.query({ query: 'anything', profile: old.profile, grant: f.g })).records.length, 1);
});

test('switching back reuses unchanged vectors and catches up changed documents', async t => {
  const f = await fixture(t); f.setRows([doc('one'), doc('two')]); await f.choose(); await f.api.prepare({ grant: f.g });
  await f.choose(profile('B')); await f.api.prepare({ grant: f.g });
  f.setRows([doc('one'), doc('two', 'raw', 'edited', 2)]);
  await f.api.select({ profileId: 'A', grant: f.g });
  const before = f.calls.filter(row => row.op === 'embed' && row.kind === 'document' && row.id === 'A').length;
  await f.api.prepare({ grant: f.g });
  const delta = f.calls.filter(row => row.op === 'embed' && row.kind === 'document' && row.id === 'A').slice(before);
  assert.deepEqual(delta.flatMap(row => row.texts), ['edited']);
});

test('existing new knowledge is caught before ready; future knowledge never blocks preparation', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  f.hooks.embed = async (_, options) => { if (options.kind === 'document') f.setRows([doc('raw'), doc('new', 'relationship')]); };
  assert.equal((await f.api.prepare({ grant: f.g })).completed, 2);
  delete f.hooks.embed;
  assert.equal((await f.api.incremental({ grant: f.g })).completed, 2);
  assert.equal((await f.api.query({ query: 'anything', grant: f.g })).records.length, 2);
});

test('preparation catches new raw, edits, removals and all newly existing domains before activation', async t => {
  const f = await fixture(t); f.setRows([doc('edit'), doc('remove')]); await f.choose();
  let changed = false;
  f.hooks.embed = async () => {
    if (changed) return;
    changed = true;
    f.setRows([doc('edit', 'selected-document', 'changed body', 2), doc('new-raw'), doc('new-fact', 'fact'), doc('new-person', 'person-event')]);
  };
  const result = await f.api.prepare({ grant: f.g });
  assert.equal(result.completed, 4);
  const coverage = await f.api.coverage({ grant: f.g });
  assert.equal(coverage.caughtUp, true); assert.equal(coverage.total, 4);
  const audit = new DatabaseSync(f.indexFile);
  try {
    const members = audit.prepare('SELECT d.doc_id,d.revision FROM vector_members m JOIN vector_documents d ON d.version_id=m.document_version_id WHERE m.snapshot_id=? ORDER BY d.doc_id').all(result.profile.indexId);
    assert.deepEqual(members.map(row => row.doc_id), ['edit', 'new-fact', 'new-person', 'new-raw']);
    assert.equal(JSON.parse(members[0].revision), 2);
  } finally { audit.close(); }
});

test('continuous changes preserve a resumable checkpoint and never activate a false ready snapshot', async t => {
  const f = await fixture(t); f.setRows([doc('changing')]); await f.choose();
  let revision = 1;
  f.hooks.embed = async () => f.setRows([doc('changing', 'raw', `version ${++revision}`, revision)]);
  await assert.rejects(f.api.prepare({ grant: f.g }), { code: 'DOCUMENTS_CHANGED' });
  const state = await f.api.status({ grant: f.g }), progress = state.profiles[0].progress;
  assert.equal(state.active, null); assert.equal(progress.state, 'paused');
  assert.equal(progress.completed, 0); assert.equal(progress.total, 1); assert.ok(progress.checkpointId);
  delete f.hooks.embed; await f.restart();
  await f.api.resumePreparation({ grant: f.g, profileId: 'A', profileRevision: state.profiles[0].revision, intentId: progress.intentId });
  assert.equal((await f.api.coverage({ grant: f.g })).caughtUp, true);
});

test('coverage compares current versions to the chosen snapshot without text reads or model work', async t => {
  const f = await fixture(t); f.setRows([doc('edit'), doc('remove'), doc('same')]); await f.choose();
  const original = (await f.api.prepare({ grant: f.g })).profile;
  f.setRows([doc('edit', 'raw', 'new', 2), doc('new', 'selected-document'), doc('same')]);
  const before = f.calls.length;
  const status = await f.api.status({ grant: f.g }); f.api.peek(); await f.api.ready();
  assert.equal(f.calls.length, before);
  const coverage = await f.api.coverage({ grant: f.g });
  assert.equal(status.profiles[0].progress.state, 'ready');
  assert.deepEqual([coverage.total, coverage.completed, coverage.pending, coverage.stale], [3, 1, 2, 2]);
  assert.equal(coverage.caughtUp, false); assert.equal(coverage.lastPreparation.state, 'ready');
  assert.ok(f.calls.slice(before).every(row => row.op === 'metadata'));
  await f.api.incremental({ grant: f.g });
  assert.equal((await f.api.coverage({ grant: f.g })).caughtUp, true);
  assert.equal((await f.api.coverage({ grant: f.g, profile: original })).pending, 2);
  const foreign = f.grant('other');
  await assert.rejects(f.api.coverage({ grant: foreign, profile: original }), { code: 'INVALID_PROFILE_SNAPSHOT' });
});

test('cancelled preparation cannot be resumed by its old intent, including after explicit new preparation', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  await f.api.prepare({ grant: f.g });
  const before = await f.api.status({ grant: f.g });
  const intentId = before.profiles[0].progress.intentId, profileRevision = before.profiles[0].revision;
  await f.api.cancel({ grant: f.g }); await f.restart();
  await assert.rejects(f.api.resumePreparation({ grant: f.g, profileId: 'A', profileRevision, intentId }), { code: 'PROFILE_CANCELLED' });
  await assert.rejects(f.api.incremental({ grant: f.g }), { code: 'PROFILE_CANCELLED' });
  await f.api.prepare({ grant: f.g });
  await assert.rejects(f.api.incremental({ grant: f.g, intentId }), { code: 'PROFILE_CANCELLED' });
});

test('query ranks all resolved candidates by cosine and preserves live weights without reencoding', async t => {
  const f = await fixture(t);
  const weak = Array.from({ length: 8 }, (_, i) => ({ ...doc(`weak-${i}`), weight: 0.05 }));
  f.setRows([...weak, doc('strong')]); await f.choose();
  const cosines = new Map([...weak.map(row => [row.text, 1]), ['strong', 0.6]]);
  f.hooks.vectors = (texts, options, profile) => texts.map(text => {
    const cosine = options.kind === 'query' ? 1 : cosines.get(text);
    return Array.from({ length: profile.dimensions }, (_, i) => i === 0 ? cosine : i === 1 ? Math.sqrt(1 - cosine ** 2) : 0);
  });
  await f.api.prepare({ grant: f.g });
  const before = f.calls.filter(row => row.op === 'embed' && row.kind === 'document').length;
  let result = await f.api.query({ query: 'query', grant: f.g, limit: 1 });
  assert.equal(result.records[0].id, 'weak-0');
  assert.equal(result.records[0].weight, 0.05);
  f.setRows([...weak.map(row => ({ ...row, weight: 1 })), { ...doc('strong'), weight: 0.01 }]);
  result = await f.api.query({ query: 'query', grant: f.g, limit: 1 });
  assert.equal(result.records[0].id, 'weak-0');
  assert.equal(result.records[0].weight, 1);
  assert.equal(f.calls.filter(row => row.op === 'embed' && row.kind === 'document').length, before);
});

test('vector order uses similarity while retaining weight for final merge', async t => {
  const f = await fixture(t); f.setRows([doc('high'), doc('low')]); await f.choose();
  f.hooks.vectors = (texts, options, profile) => texts.map(text => {
    const cosine = options.kind === 'query' ? 1 : text === 'high' ? 0.9 : 0.3;
    return Array.from({ length: profile.dimensions }, (_, i) => i === 0 ? cosine : i === 1 ? Math.sqrt(1 - cosine ** 2) : 0);
  });
  await f.api.prepare({ grant: f.g });
  f.setRows([{ ...doc('high'), weight: 0.5 }, { ...doc('low'), weight: 1 }]);
  const result = await f.api.query({ query: 'query', grant: f.g, limit: 2 });
  assert.deepEqual(result.records.map(row => row.id), ['high', 'low']);
  assert.ok(Math.abs(result.records[0].similarity-0.9)<0.00001);assert.equal(result.records[0].weight,0.5);
  assert.equal(result.records[0].score,result.records[0].similarity);
  assert.ok(Math.abs(result.records[1].similarity-0.3)<0.00001);assert.equal(result.records[1].weight,1);
  assert.equal(result.records[1].score,result.records[1].similarity);
});

const referenceDoc = (id, validity = 'current', storage = 'entry', weight = 1) => ({
  ...doc(id, 'entry'), anchor: { id, revision: 1, ref: { storage } }, state: { validity }, weight,
});

function setQueryCosines(f, cosines) {
  f.hooks.vectors = (texts, options, profile) => texts.map(text => {
    const cosine = options.kind === 'query' ? 1 : cosines.get(text);
    return Array.from({ length: profile.dimensions }, (_, i) => i === 0 ? cosine : i === 1 ? Math.sqrt(1 - cosine ** 2) : 0);
  });
}

test('bounded reference query scans past historical and incompatible records without changing the default query', async t => {
  const f = await fixture(t, { queryCandidateLimit: 18 });
  const history = Array.from({ length: 8 }, (_, i) => referenceDoc(`historical-${i}`, 'historical'));
  const incompatible = Array.from({ length: 8 }, (_, i) => referenceDoc(`document-${i}`, 'current', 'document'));
  const eligible = [referenceDoc('current-entry'), referenceDoc('current-note', 'current', 'note')];
  const rows = [...history, ...incompatible, ...eligible, referenceDoc('beyond-cap')];
  f.setRows(rows); await f.choose();
  setQueryCosines(f, new Map(rows.map((row, i) => [row.text, 1 - i * 0.025])));
  await f.api.prepare({ grant: f.g });
  const query = { query: 'query', grant: f.g, limit: 8 };
  const ordinary = await f.api.query(query);
  assert.deepEqual(ordinary.records.map(row => row.id), history.map(row => row.id));
  assert.equal(ordinary.candidatesExamined, 16);
  const references = await f.api.query({ ...query, referenceOnly: true, minSimilarity: 0.2 });
  assert.deepEqual(references.records.map(row => row.id), eligible.map(row => row.id));
  assert.equal(references.degraded, true);
  assert.equal(references.candidateLimit, 18);
  assert.equal(references.candidatesExamined, 18);
});

test('bounded query filters on cosine and exposes it separately from the weighted score', async t => {
  const f = await fixture(t, { queryCandidateLimit: 120 });
  f.setRows([referenceDoc('softened'), referenceDoc('below-threshold')]); await f.choose();
  setQueryCosines(f, new Map([['softened', 1], ['below-threshold', 0.19]]));
  await f.api.prepare({ grant: f.g });
  f.setRows([referenceDoc('softened', 'current', 'entry', 0.5), referenceDoc('below-threshold')]);
  const query = { query: 'query', grant: f.g, limit: 1 };
  const ordinary = await f.api.query(query);
  assert.equal(ordinary.records[0].id, 'softened');
  const filtered = await f.api.query({ ...query, minSimilarity: 0.2 });
  assert.deepEqual(filtered.records.map(({ id, similarity, score }) => ({ id, similarity, score })), [
    { id: 'softened', similarity: 1, score: 1 },
  ]);
});

test('bounded reference query rechecks current status and storage before returning a record', async t => {
  const f = await fixture(t, { queryCandidateLimit: 120 });
  const rows = [referenceDoc('retracted'), referenceDoc('moved'), referenceDoc('fallback')];
  f.setRows(rows); await f.choose();
  setQueryCosines(f, new Map([['retracted', 1], ['moved', 0.9], ['fallback', 0.8]]));
  await f.api.prepare({ grant: f.g });
  const reads = new Map();
  f.hooks.resolve = ({ id }) => {
    const count = (reads.get(id) ?? 0) + 1; reads.set(id, count);
    if (count !== 2) return;
    if (id === 'retracted') rows[0] = referenceDoc(id, 'historical');
    if (id === 'moved') rows[1] = referenceDoc(id, 'current', 'document');
  };
  const result = await f.api.query({ query: 'query', grant: f.g, limit: 1, referenceOnly: true });
  assert.deepEqual(result.records.map(row => row.id), ['fallback']);
});

test('incremental handles edits, retractions and existing pinned snapshots', async t => {
  const f = await fixture(t); f.setRows([doc('one'), doc('two')]); await f.choose();
  const old = (await f.api.prepare({ grant: f.g })).profile;
  f.setRows([doc('two', 'raw', 'new text', 2)]);
  const before = await f.api.query({ query: 'anything', profile: old, grant: f.g });
  assert.deepEqual(before.records, []);
  await f.api.incremental({ grant: f.g, changes: [{ id: 'two', revision: 2 }] });
  const after = await f.api.query({ query: 'anything', grant: f.g });
  assert.deepEqual(after.records.map(row => [row.id, row.revision]), [['two', 2]]);
});

test('incremental cannot activate the selected pending profile', async t => {
  const f = await fixture(t); await f.choose();
  await assert.rejects(f.api.incremental({ grant: f.g }), { code: 'PROFILE_NOT_ACTIVE' });
  await f.api.prepare({ grant: f.g }); await f.choose(profile('B'));
  await assert.rejects(f.api.incremental({ profileId: 'B', grant: f.g }), { code: 'PROFILE_NOT_ACTIVE' });
  await f.api.incremental({ grant: f.g });
  assert.equal((await f.api.activeSnapshot({ grant: f.g })).id, 'A');
});

test('query rechecks revision before embedding and after a concurrent edit', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose(); await f.api.prepare({ grant: f.g });
  const before = f.calls.length;
  f.hooks.embed = async (_, options) => {
    if (options.kind === 'query') {
      assert.ok(f.calls.slice(before).some(row => row.op === 'resolve' && row.id === 'raw'));
      f.setRows([doc('raw', 'raw', 'changed', 2)]);
    }
  };
  assert.deepEqual((await f.api.query({ query: 'anything', grant: f.g })).records, []);
});

test('scope partition rejects foreign snapshots and never lists another owner', async t => {
  const f = await fixture(t), other = f.grant('another-fictional-owner');
  f.setRows([doc('mine')]); f.setRows([doc('theirs')], other);
  await f.choose(); const mine = (await f.api.prepare({ grant: f.g })).profile;
  assert.deepEqual((await f.api.status({ grant: other })).profiles, []);
  await f.choose(profile(), other); await f.api.prepare({ grant: other });
  assert.deepEqual((await f.api.query({ query: 'anything', grant: other })).records.map(row => row.id), ['theirs']);
  await assert.rejects(f.api.query({ query: 'anything', profile: mine, grant: other }), { code: 'MEMORY_SCOPE_CONFLICT' });
});

test('same owner in a separate project has an independent whole-domain index', async t => {
  const f = await fixture(t), other = f.grant(f.g.ownerSubject, 'another-project');
  f.setRows([doc('one')]); f.setRows([doc('two')], other);
  await f.choose(); const first = await f.api.prepare({ grant: f.g });
  await f.choose(profile(), other); const second = await f.api.prepare({ grant: other });
  assert.notEqual(first.profile.indexId, second.profile.indexId);
  assert.deepEqual((await f.api.query({ query: 'anything', grant: f.g })).records.map(row => row.id), ['one']);
});

test('revocation during encoding cannot activate or return text', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  f.hooks.embed = async () => { f.g.cancel(); };
  await assert.rejects(f.api.prepare({ grant: f.g }));
  const newGrant = f.grant();
  assert.equal(await f.api.activeSnapshot({ grant: newGrant }), null);
  await assert.rejects(f.api.query({ query: 'anything', grant: f.g }));
});

test('revocation after query vector generation prevents returning any result', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose(); await f.api.prepare({ grant: f.g });
  f.hooks.embed = async (_, options) => { if (options.kind === 'query') f.g.cancel(); };
  await assert.rejects(f.api.query({ query: 'anything', grant: f.g }));
});

test('cancel retains completed document checkpoint and prepare resumes after restart', async t => {
  const f = await fixture(t); f.setRows([doc('one'), doc('two')]); await f.choose();
  const waiting = defer(), entered = defer();
  f.hooks.embed = async texts => { if (texts.includes('two')) { entered.resolve(); await waiting.promise; } };
  const preparing = f.api.prepare({ grant: f.g });
  const rejected = assert.rejects(preparing); await entered.promise;
  await f.api.cancel({ grant: f.g }); waiting.resolve(); await rejected;
  const index = new DatabaseSync(f.indexFile, { readOnly: true });
  try {
    assert.deepEqual(index.prepare(`SELECT m.doc_id FROM vector_members m JOIN vector_snapshots s ON s.id=m.snapshot_id
      WHERE s.state='checkpoint' ORDER BY m.doc_id`).all().map(row => row.doc_id), ['one']);
  } finally { index.close(); }
  delete f.hooks.embed; await f.restart();
  const before = f.calls.length; await f.api.prepare({ grant: f.g });
  assert.deepEqual(f.calls.slice(before).filter(row => row.op === 'embed' && row.kind === 'document').flatMap(row => row.texts), ['two']);
});

test('load/release do not pretend that loading prepared the global index', async t => {
  const f = await fixture(t); await f.choose();
  assert.equal((await f.api.load({ grant: f.g })).loaded, true);
  assert.equal(await f.api.activeSnapshot({ grant: f.g }), null);
  await f.api.release({ grant: f.g });
  assert.equal((await f.api.status({ grant: f.g })).profiles[0].modelState, 'unloaded');
  assert.ok(f.instances.every(row => row.disposed));
});

test('cancel can interrupt explicit loading without changing index progress', async t => {
  const f = await fixture(t); await f.choose();
  const waiting = defer(), entered = defer();
  f.hooks.prepare = async () => { entered.resolve(); await waiting.promise; };
  const loading = f.api.load({ grant: f.g }), rejected = assert.rejects(loading);
  await entered.promise;
  assert.equal((await f.api.cancel({ grant: f.g })).cancelled, true);
  waiting.resolve(); await rejected;
  assert.equal((await f.api.status({ grant: f.g })).profiles[0].progress.state, 'unprepared');
});

test('query uses the same backend priority queue during incremental document work', async t => {
  const f = await fixture(t); f.setRows([doc('one')]); await f.choose(); await f.api.prepare({ grant: f.g });
  const waiting = defer(), entered = defer();
  f.setRows([doc('one'), doc('two')]);
  f.hooks.embed = async (texts, options) => { if (options.kind === 'document' && texts.includes('two')) { entered.resolve(); await waiting.promise; } };
  const incremental = f.api.incremental({ grant: f.g }); await entered.promise;
  try {
    assert.equal((await f.api.query({ query: 'anything', grant: f.g })).records[0].id, 'one');
    assert.equal(f.instances.length, 1);
    assert.ok(f.calls.some(row => row.op === 'embed' && row.kind === 'query'));
  } finally { waiting.resolve(); await incremental; }
});

test('release lets already pinned queries drain and then unloads the backend', async t => {
  const f = await fixture(t); f.setRows([doc('one')]); await f.choose(); await f.api.prepare({ grant: f.g });
  const waiting = defer(), entered = defer();
  f.hooks.embed = async (_, options) => { if (options.kind === 'query') { entered.resolve(); await waiting.promise; } };
  const reading = f.api.query({ query: 'anything', grant: f.g }); await entered.promise;
  const state = await f.api.release({ grant: f.g });
  assert.equal(state.queriesMayStillBeDraining, true);
  waiting.resolve(); assert.equal((await reading).records[0].id, 'one');
  assert.equal((await f.api.status({ grant: f.g })).profiles[0].loaded, false);
});

test('missing models report unavailable independently of existing index state', async t => {
  const f = await fixture(t); await f.choose();
  f.hooks.prepare = async () => { throw Object.assign(new Error('synthetic missing assets'), { code: 'ENOENT' }); };
  await assert.rejects(f.api.load({ grant: f.g }), { code: 'ENOENT' });
  const state = (await f.api.status({ grant: f.g })).profiles[0];
  assert.equal(state.modelState, 'unavailable'); assert.equal(state.modelError, 'ENOENT');
  assert.equal(state.progress.state, 'unprepared');
});

test('persisted active snapshot reloads without constructing a model', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  const snapshot = (await f.api.prepare({ grant: f.g })).profile;
  await f.restart(); const before = f.calls.length;
  assert.deepEqual(await f.api.activeSnapshot({ grant: f.g }), snapshot);
  assert.equal(f.calls.length, before);
  assert.equal((await f.api.status({ grant: f.g })).profiles[0].loaded, false);
  assert.equal((await f.api.query({ query: 'anything', profile: snapshot, grant: f.g })).records.length, 1);
});

test('forged or altered encoding snapshots are rejected', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  const snapshot = (await f.api.prepare({ grant: f.g })).profile;
  await assert.rejects(f.api.query({ query: 'anything', profile: { ...snapshot, modelKey: 'other-space' }, grant: f.g }), { code: 'INVALID_PROFILE_SNAPSHOT' });
});

test('explicit cloud revocation blocks old active/explicit snapshots, including after restart', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]);
  const enabled = profile('cloud', { model: 'text-embedding-v4', backend: { config: { rawRecallAllowCloud: true } } });
  await f.choose(enabled); const snapshot = (await f.api.prepare({ grant: f.g })).profile;
  await f.api.register({ profile: { ...enabled, backend: { config: { rawRecallAllowCloud: false } } }, grant: f.g });
  assert.deepEqual(await f.api.activeSnapshot({ grant: f.g }), snapshot);
  const before = f.calls.length;
  await assert.rejects(f.api.query({ query: 'fictional query', grant: f.g }), { code: 'CLOUD_PERMISSION_REVOKED' });
  await assert.rejects(f.api.query({ query: 'fictional query', profile: snapshot, grant: f.g }), { code: 'CLOUD_PERMISSION_REVOKED' });
  assert.ok(!f.calls.slice(before).some(row => row.op === 'embed'));
  await f.restart();
  await assert.rejects(f.api.query({ query: 'fictional query', profile: snapshot, grant: f.g }), { code: 'CLOUD_PERMISSION_REVOKED' });
  // Omitting opt-in is also closed, never permission to reuse an old key.
  await f.api.register({ profile: { ...enabled, backend: { config: {} } }, grant: f.g });
  await assert.rejects(f.api.query({ query: 'fictional query', profile: snapshot, grant: f.g }), { code: 'CLOUD_PERMISSION_REVOKED' });
});

test('normal cloud edits retain old active snapshot when cloud permission remains enabled', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]);
  const enabled = profile('cloud', { model: 'text-embedding-v4', backend: { config: { rawRecallAllowCloud: true } } });
  await f.choose(enabled); const snapshot = (await f.api.prepare({ grant: f.g })).profile;
  await f.api.register({ profile: { ...enabled, label: 'Updated pending configuration' }, grant: f.g });
  assert.equal(f.instances[0].disposed, false);
  const result = await f.api.query({ query: 'fictional query', profile: snapshot, grant: f.g });
  assert.deepEqual(result.profile, snapshot); assert.equal(result.records.length, 1);
});

test('successful cloud revoke cancels in-flight query, disposes old backend and keeps spent receipt', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]);
  const enabled = profile('cloud', { model: 'text-embedding-v4', backend: { config: { rawRecallAllowCloud: true } } });
  await f.choose(enabled); const snapshot = (await f.api.prepare({ grant: f.g })).profile;
  const entered = defer(), receiptDone = defer(); let observedSignal;
  f.hooks.embed = async (_, options, definition, resources) => {
    if (options.kind !== 'query') return;
    observedSignal = options.signal;
    const cancelled = new Promise(resolve => options.signal.addEventListener('abort', async () => {
      await resources.onUsage({ model: definition.model, at: '2026-11-06T00:00:00.000Z', kind: 'query',
        dimensions: definition.dimensions, inputs: 1, tokens: 11, outcome: 'ok', requestId: 'spent-before-revoke' });
      receiptDone.resolve(); resolve();
    }, { once: true }));
    entered.resolve(); await cancelled;
  };
  f.hooks.dispose = async () => { await receiptDone.promise; };
  const reading = f.api.query({ query: 'fictional query', profile: snapshot, grant: f.g });
  const rejected = assert.rejects(reading, { code: 'CLOUD_PERMISSION_REVOKED' }); await entered.promise;
  await f.api.register({ profile: { ...enabled, backend: { config: { rawRecallAllowCloud: false } } }, grant: f.g });
  await rejected;
  assert.equal(observedSignal.aborted, true); assert.equal(f.instances[0].disposed, true);
  assert.equal(f.valid.has(f.g), true); // Cloud revocation is separate from memory authorization.
  const usage = (await f.api.status({ grant: f.g })).profiles[0].embeddingUsage;
  assert.deepEqual(usage, { calls: 1, reportedTokens: 11, unknownUsageCalls: 0, totalTokens: 11, recordingError: null });
  delete f.hooks.dispose; delete f.hooks.embed;
  await f.restart(); assert.deepEqual((await f.api.status({ grant: f.g })).profiles[0].embeddingUsage, usage);
});

test('cloud revoke cancels loading and is isolated from another scope using the same profile ID', async t => {
  const f = await fixture(t), other = f.grant('fictional-other-owner');
  const enabled = profile('cloud', { model: 'text-embedding-v4', backend: { config: { rawRecallAllowCloud: true } } });
  await f.choose(enabled, other); await f.api.load({ grant: other });
  const unaffected = f.instances[0];
  await f.choose(enabled);
  const entered = defer(), finish = defer();
  f.hooks.prepare = async () => { entered.resolve(); await finish.promise; };
  const loading = f.api.load({ grant: f.g }), rejected = assert.rejects(loading, { code: 'CLOUD_PERMISSION_REVOKED' });
  await entered.promise;
  await f.api.register({ profile: { ...enabled, backend: { config: { rawRecallAllowCloud: false } } }, grant: f.g });
  await rejected; finish.resolve();
  assert.equal(unaffected.disposed, false); assert.equal(f.instances[1].disposed, true);
  delete f.hooks.prepare; assert.equal((await f.api.load({ grant: other })).loaded, true);
});

test('failed cloud revocation registration never cancels an existing authorized backend', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]);
  const enabled = profile('cloud', { model: 'text-embedding-v4', backend: { config: { rawRecallAllowCloud: true } } });
  await f.choose(enabled); const snapshot = (await f.api.prepare({ grant: f.g })).profile;
  const state = await f.api.status({ grant: f.g });
  await f.api.register({ profile: profile('other'), grant: f.g });
  await assert.rejects(f.api.register({ profile: { ...enabled, backend: { config: { rawRecallAllowCloud: false } } },
    grant: f.g, expectedRevision: state.revision }), { code: 'MEMORY_REVISION_CONFLICT' });
  assert.equal(f.instances[0].disposed, false);
  assert.equal((await f.api.query({ query: 'fictional query', profile: snapshot, grant: f.g })).records.length, 1);
});

test('fingerprint cache survives release/restart without rereading unchanged fixture assets', async t => {
  const f = await fixture(t), asset = path.join(path.dirname(f.file), 'synthetic-asset.bin');
  await fs.writeFile(asset, 'synthetic asset version one');
  let reads = 0; const original = nativeFs.createReadStream;
  t.mock.method(nativeFs, 'createReadStream', function (file, ...args) {
    if (file === asset) reads++;
    return original.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    const paths = [];
    f.hooks.prepare = async (_, { cacheFile }) => {
      paths.push(cacheFile);
      await identifyAssets([{ name: 'synthetic-asset.bin', file: asset }], cacheFile);
    };
    await f.choose(); await f.api.load({ grant: f.g });
    assert.equal(reads, 1);
    assert.equal(path.basename(paths[0]), 'asset-fingerprints.json');
    const saved = JSON.parse(await fs.readFile(paths[0], 'utf8'));
    assert.equal(Object.values(saved).length, 1);
    assert.match(Object.values(saved)[0].hash, /^[a-f0-9]{64}$/u);
    await f.api.release({ grant: f.g }); await f.restart(); await f.api.load({ grant: f.g });
    assert.equal(paths[1], paths[0]); assert.equal(reads, 1);
    await f.api.release({ grant: f.g });
    await fs.writeFile(asset, 'synthetic asset version two (changed stamp)');
    await f.api.load({ grant: f.g });
    assert.equal(reads, 2); // Existing asset validation is preserved.
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('cache paths isolate profile scope and revision without opening any vector index', async t => {
  const f = await fixture(t), other = f.grant('fictional-other-owner');
  await f.choose(); await f.api.load({ grant: f.g });
  const one = f.calls.filter(row => row.op === 'construct').at(-1).cacheFile;
  await f.choose(profile(), other); await f.api.load({ grant: other });
  const two = f.calls.filter(row => row.op === 'construct').at(-1).cacheFile;
  assert.notEqual(one, two);
  await f.choose(profile('A', { label: 'New revision' })); await f.api.load({ grant: f.g });
  const three = f.calls.filter(row => row.op === 'construct').at(-1).cacheFile;
  assert.notEqual(one, three);
  await assert.rejects(fs.stat(f.indexFile), { code: 'ENOENT' });
});

test('ready/register/status without provider attempts do not create ledger, cache or vector storage', async t => {
  const f = await fixture(t); await f.api.ready(); await f.choose();
  const state = await f.api.status({ grant: f.g });
  assert.deepEqual(state.profiles[0].embeddingUsage, { calls: 0, reportedTokens: 0, unknownUsageCalls: 0, totalTokens: 0, recordingError: null });
  assert.deepEqual((await fs.readdir(path.dirname(f.file))).sort(), ['profiles.json']);
  assert.equal(f.calls.filter(row => row.op === 'construct').length, 0);
  const safe = f.api.peek(); assert.equal(Object.hasOwn(safe, 'embeddingUsage'), false);
});

async function receiptFromFixtureHTTP({ texts, options, definition, resources, tokens, outcome = 'ok', onFetch }) {
  const data = texts.map((_, index) => ({ index, embedding: Array.from({ length: definition.dimensions }, (_, i) => i === 0 ? 1 : 0) }));
  return requestEmbeddingService({ baseUrl: 'https://fixture.invalid/v1', model: definition.model,
    texts, dimensions: definition.dimensions, apiKey: 'synthetic-secret-never-log', scope: options.scope,
    kind: options.kind, signal: options.signal, onUsage: resources.onUsage,
    fetchImpl: async () => {
      await onFetch?.();
      if (outcome === 'network-error') throw new Error('synthetic network interruption');
      return new Response(JSON.stringify({ id: 'fixture-request', ...(tokens === undefined ? {} : { usage: { total_tokens: tokens } }), data }),
        { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'fixture-request' } });
    } });
}

test('actual HTTP receipt fields persist, unknown tokens remain unknown and totals survive restart', async t => {
  const f = await fixture(t); f.setRows([doc('raw', 'raw', 'synthetic-private-body')]); await f.choose();
  let attempt = 0;
  f.hooks.embed = async (texts, options, definition, resources) => receiptFromFixtureHTTP({ texts, options, definition, resources,
    tokens: ++attempt === 1 ? 17 : undefined });
  await f.api.prepare({ grant: f.g }); await f.api.query({ query: 'synthetic-private-query', grant: f.g });
  const before = (await f.api.status({ grant: f.g })).profiles[0].embeddingUsage;
  assert.deepEqual(before, { calls: 2, reportedTokens: 17, unknownUsageCalls: 1, totalTokens: null, recordingError: null });
  const file = f.file + '.embedding-usage.jsonl', raw = await fs.readFile(file, 'utf8');
  const receipts = raw.trim().split('\n').map(JSON.parse);
  assert.equal(receipts[0].tokens, 17); assert.equal(receipts[1].tokens, null);
  assert.equal(receipts[0].kind, 'document'); assert.equal(receipts[1].kind, 'query');
  assert.equal(receipts[0].inputs, 1); assert.equal(receipts[0].dimensions, 512);
  assert.equal(receipts[0].model, 'BAAI/bge-small-zh-v1.5');
  assert.equal(receipts[0].httpStatus, 200); assert.equal(receipts[0].outcome, 'ok');
  assert.equal(receipts[0].requestId, 'fixture-request'); assert.equal(typeof receipts[0].durationMs, 'number');
  assert.equal(typeof receipts[0].at, 'string'); assert.equal(receipts[0].ownerSubject, f.g.ownerSubject);
  assert.equal(typeof receipts[0].profileRevision, 'string'); assert.match(receipts[0].modelKey, /synthetic-space/u);
  for (const forbidden of ['synthetic-secret-never-log', 'synthetic-private-body', 'synthetic-private-query', 'apiKey', 'cost', 'input_tokens']) assert.ok(!raw.includes(forbidden));
  await f.restart(); assert.deepEqual((await f.api.status({ grant: f.g })).profiles[0].embeddingUsage, before);
});

test('receipt arriving after grant cancellation is preserved through close/restart', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  f.hooks.embed = async (texts, options, definition, resources) => receiptFromFixtureHTTP({ texts, options, definition, resources,
    tokens: 23, onFetch: async () => { f.g.cancel(); } });
  await assert.rejects(f.api.prepare({ grant: f.g }));
  // The provider finally callback runs even though the answer's grant is gone.
  await f.restart(); const grant = f.grant();
  assert.deepEqual((await f.api.status({ grant })).profiles[0].embeddingUsage,
    { calls: 1, reportedTokens: 23, unknownUsageCalls: 0, totalTokens: 23, recordingError: null });
  assert.equal(await f.api.activeSnapshot({ grant }), null);
});

test('close waits for an already retiring backend and its late HTTP receipt', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose(); await f.api.prepare({ grant: f.g });
  const entered = defer(), response = defer(), receiptFinished = defer(), disposing = defer();
  f.hooks.embed = async (texts, options, definition, resources) => {
    try {
      await receiptFromFixtureHTTP({ texts, options, definition, resources, tokens: 29,
        onFetch: async () => { entered.resolve(); await response.promise; } });
    } finally { receiptFinished.resolve(); }
  };
  f.hooks.dispose = async () => { disposing.resolve(); await receiptFinished.promise; };
  const reading = f.api.query({ query: 'fictional query', grant: f.g });
  const rejected = assert.rejects(reading); await entered.promise;
  f.g.cancel(); await disposing.promise;
  let closed = false;
  const closing = f.api.close().then(() => { closed = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  response.resolve(); await rejected; await closing;
  delete f.hooks.dispose; delete f.hooks.embed;
  await f.restart(); const grant = f.grant();
  assert.deepEqual((await f.api.status({ grant })).profiles[0].embeddingUsage,
    { calls: 1, reportedTokens: 29, unknownUsageCalls: 0, totalTokens: 29, recordingError: null });
});

test('failed provider attempt records unknown usage without estimating billing', async t => {
  const f = await fixture(t); f.setRows([doc('raw')]); await f.choose();
  f.hooks.embed = async (texts, options, definition, resources) => receiptFromFixtureHTTP({ texts, options, definition, resources, outcome: 'network-error' });
  await assert.rejects(f.api.prepare({ grant: f.g }));
  const state = (await f.api.status({ grant: f.g })).profiles[0].embeddingUsage;
  assert.deepEqual(state, { calls: 1, reportedTokens: 0, unknownUsageCalls: 1, totalTokens: null, recordingError: null });
});

test('receipt metadata ignores caller-supplied scope and unrelated secret/body fields', async t => {
  const f = await fixture(t), other = f.grant('fictional-other-owner');
  await f.choose();
  f.hooks.prepare = async (_, resources) => resources.onUsage({ at: '2026-11-06T00:00:00.000Z',
    model: 'fixture-model', kind: 'query', inputs: 1, dimensions: 512, tokens: 0, outcome: 'ok',
    scope: { ownerSubject: other.ownerSubject, project: other.project },
    input: 'secret-body', apiKey: 'secret-key', response: 'secret-response', cost: 12345 });
  await f.api.load({ grant: f.g });
  assert.equal((await f.api.status({ grant: f.g })).profiles[0].embeddingUsage.calls, 1);
  delete f.hooks.prepare; await f.choose(profile(), other);
  assert.equal((await f.api.status({ grant: other })).profiles[0].embeddingUsage.calls, 0);
  const raw = await fs.readFile(f.file + '.embedding-usage.jsonl', 'utf8');
  for (const forbidden of [other.ownerSubject, 'secret-body', 'secret-key', 'secret-response', 'cost']) assert.ok(!raw.includes(forbidden));
});

test('460 high-dimensional documents: incremental writes only changed chunks and retains previous snapshot versions', async t => {
  const f = await fixture(t);
  const rows = Array.from({ length: 460 }, (_, i) => doc(`synthetic-${i}`, i % 2 ? 'raw' : 'belief', `content-${i}`));
  f.setRows(rows);
  await f.choose(profile('high-dimensional', { model: 'Qwen/Qwen3-Embedding-8B', dimensions: 4096 }));
  const first = (await f.api.prepare({ grant: f.g })).profile;
  const audit = new DatabaseSync(f.indexFile);
  try {
    audit.exec(`CREATE TABLE fixture_vector_writes (operation TEXT,version_id INTEGER,bytes INTEGER);
      CREATE TRIGGER fixture_chunk_insert AFTER INSERT ON vector_chunks BEGIN
        INSERT INTO fixture_vector_writes VALUES('insert',NEW.document_version_id,length(NEW.vector)); END;
      CREATE TRIGGER fixture_chunk_update AFTER UPDATE ON vector_chunks BEGIN
        INSERT INTO fixture_vector_writes VALUES('update',NEW.document_version_id,length(NEW.vector)); END;
      CREATE TRIGGER fixture_chunk_delete AFTER DELETE ON vector_chunks BEGIN
        INSERT INTO fixture_vector_writes VALUES('delete',OLD.document_version_id,length(OLD.vector)); END;`);
    const previous = audit.prepare('SELECT doc_id,document_version_id FROM vector_members WHERE snapshot_id=? ORDER BY doc_id').all(first.indexId);
    f.setRows(rows.map(row => row.id === 'synthetic-17' ? doc(row.id, row.domain, 'edited-content', 2) : row));
    const second = (await f.api.incremental({ grant: f.g })).profile;
    const writes = audit.prepare(`SELECT w.operation,d.doc_id,w.bytes FROM fixture_vector_writes w
      JOIN vector_documents d ON d.version_id=w.version_id`).all().map(row => ({ ...row }));
    assert.deepEqual(writes, [{ operation: 'insert', doc_id: 'synthetic-17', bytes: 4096 * 4 }]);
    assert.deepEqual(audit.prepare('SELECT doc_id,document_version_id FROM vector_members WHERE snapshot_id=? ORDER BY doc_id').all(first.indexId), previous);
    const changed = audit.prepare(`SELECT old.doc_id FROM vector_members old JOIN vector_members latest ON latest.doc_id=old.doc_id
      WHERE old.snapshot_id=? AND latest.snapshot_id=? AND old.document_version_id<>latest.document_version_id`).all(first.indexId, second.indexId);
    assert.deepEqual(changed.map(row => row.doc_id), ['synthetic-17']);
    assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM vector_chunks').get().n, 461);
    assert.equal(audit.prepare('SELECT COUNT(*) AS n FROM vector_snapshots WHERE state=\'ready\'').get().n, 2);
    const original = await f.api.query({ query: 'fictional query', profile: first, grant: f.g, limit: 40 });
    assert.ok(original.records.every(row => row.id !== 'synthetic-17'));
    assert.equal(original.profile.indexId, first.indexId);
  } finally { audit.close(); }
});

// Real profile store, SQLite index, scheduler, chunker and HTTP adapter; only
// the provider's fetch is synthetic. No request can leave this test process.
async function sourceBoundaryFixture(t, { singleBackend = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'source-boundary-'));
  const indexFile = path.join(directory, 'index.sqlite');
  const key = path.join(directory, 'fictional-key.txt'); await fs.writeFile(key, 'fictional-test-key');
  const controller = new AbortController(), grant = { ownerSubject: 'fictional-owner', project: 'main', signal: controller.signal };
  const rows = new Map(), requests = [], hooks = {}; let backend;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(new URL(url).hostname, 'embedding-test.invalid');
    const body = JSON.parse(options.body); requests.push(body.input);
    await hooks.sent?.(body.input);
    return new Response(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:Array.from({length:64},(_,i)=>i===0?1:0)})),usage:{total_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
  });
  const api = createUnifiedProfiles({file:path.join(directory,'profiles.json'),indexFile,singleBackend,
    authorize:g=>g===grant&&!controller.signal.aborted,
    async *listDocuments(){for(const row of rows.values())yield structuredClone(row);},
    async resolveDocument({id,revision}){await hooks.resolve?.(id);const row=rows.get(id);return row?.revision===revision?structuredClone(row):null;},
    createBackend(options){
      backend=new EmbeddingBackend(options);
      const prepare=backend.prepare.bind(backend),plan=backend.planChunks.bind(backend),embed=backend.embed.bind(backend);
      backend.prepare=async()=>{const pending=prepare();hooks.preparing?.();const value=await pending;await hooks.loaded?.();return value;};
      backend.planChunks=async(text,options)=>{const parts=await plan(text,options);await hooks.planned?.(text);return parts;};
      backend.embed=(texts,options)=>{const pending=embed(texts,options);hooks.submitted?.(texts);return pending;};
      return backend;
    }});
  t.after(async()=>{controller.abort();await api.close();assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(directory,{recursive:true,force:true});});
  const p=profileFromLegacy({id:'source-boundary',settings:{rawRecallModel:'text-embedding-v4',rawRecallDimensions:64,rawRecallAllowCloud:true,
    rawRecallApiBase:'https://embedding-test.invalid/v1',rawRecallApiKeyFile:key,rawRecallIdleMs:0}});
  await api.register({profile:p,grant});await api.select({profileId:p.id,grant});
  return {api,grant,rows,requests,hooks,get backend(){return backend;},controller,indexFile,
    members(result){const db=new DatabaseSync(path.join(directory,'index.sqlite'),{readOnly:true});try{return db.prepare('SELECT d.doc_id,d.revision FROM vector_members m JOIN vector_documents d ON d.version_id=m.document_version_id WHERE m.snapshot_id=? ORDER BY d.doc_id').all(result.profile.indexId).map(r=>({id:r.doc_id,revision:JSON.parse(r.revision)}));}finally{db.close();}}};
}

test('raw context reaches the real embedding backend for long chunks and keeps original coordinates', async t => {
  const f = await sourceBoundaryFixture(t);
  const text = '甲'.repeat(599) + '😀' + '乙'.repeat(419);
  const center = contextualDoc('center', text, [backgroundMessage('earlier', '只在本地跑。'),
    backgroundMessage('recent', '不会访问外部服务。', 'assistant')]);
  const plain = doc('plain', 'raw', '无前文的原话');
  const nonRaw = { ...doc('note', 'fact', '派生资料'), embedding: center.embedding };
  for (const row of [center, plain, nonRaw]) f.rows.set(row.id, row);
  const { profile: snapshot } = await f.api.prepare({ grant: f.grant });
  const inputs = f.requests.flat(), spans = [[0, 599], [599, text.length]];
  const bodies = spans.map(([start, end]) => text.slice(start, end));
  assert.equal(bodies.join(''), text);
  assert.deepEqual(inputs, [...bodies.map(body => center.embedding.prefix + body), plain.text, nonRaw.text]);
  assert.ok(inputs[0].length > 600);
  assert.deepEqual(storedChunks(f.indexFile, snapshot, center.id), spans.map(([start, end], i) => ({
    start, end, tokenBound: Buffer.byteLength(inputs[i], 'utf8') + 16, textHash: sourceTextHash(inputs[i]),
  })));
  const result = await f.api.query({ query: '本地服务限制', grant: f.grant, domains: ['raw'] });
  const record = result.records.find(record => record.id === center.id);
  assert.deepEqual(record.anchor.match, { start: 0, end: 599 });
  assert.equal(record.text, text.slice(0, 699));
});

test('queued foreground timeout and cancellation leave the incremental backend warm', async t => {
  const f = await sourceBoundaryFixture(t, { singleBackend: true });
  f.rows.set('one', doc('one')); await f.api.prepare({ grant: f.grant });
  const backend = f.backend, entered = defer(), release = defer();
  f.rows.set('two', doc('two'));
  f.hooks.sent = async texts => { if (texts.includes('two')) { entered.resolve(); await release.promise; } };
  const incremental = f.api.incremental({ grant: f.grant });
  try {
    await entered.promise;
    for (const reason of [new DOMException('query expired', 'TimeoutError'), new DOMException('query cancelled', 'AbortError')]) {
      const controller = new AbortController(), submitted = defer(), query = `queued-${reason.name}`;
      f.hooks.submitted = texts => { if (texts[0] === query) submitted.resolve(); };
      const reading = f.api.query({ query, grant: f.grant, signal: controller.signal });
      const rejected = assert.rejects(reading, error => error === reason);
      await submitted.promise;
      assert.equal(backend.status().queued, 1);
      if (reason.name === 'TimeoutError') setTimeout(() => controller.abort(reason), 1);
      else controller.abort(reason);
      await rejected;
      assert.equal(backend.status().queued, 0);
      assert.equal((await f.api.status({ grant: f.grant })).profiles[0].releasing, false);
      assert.ok(!f.requests.some(texts => texts.includes(query)));
    }
  } finally { release.resolve(); await incremental; }
  assert.equal((await f.api.query({ query: 'next-query', grant: f.grant })).records[0].id, 'one');
  assert.equal(f.backend, backend);
  assert.equal(backend.disposed, false);
  assert.equal((await f.api.status({ grant: f.grant })).profiles[0].embeddingUsage.calls, 3);
});

test('a query cancelled while waiting on shared preparation leaves the loader running', async t => {
  const f = await sourceBoundaryFixture(t, { singleBackend: true });
  f.rows.set('one', doc('one')); await f.api.prepare({ grant: f.grant });
  const key = f.backend.config.rawRecallApiKeyFile;
  await f.api.release({ grant: f.grant });
  const entered = defer(), release = defer(), joined = defer(), readFile = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => {
    if (file === key) { entered.resolve(); await release.promise; }
    return readFile(file, ...args);
  });
  const loading = f.api.load({ grant: f.grant });
  try {
    await entered.promise;
    const backend = f.backend, controller = new AbortController();
    f.hooks.preparing = () => joined.resolve();
    const reading = f.api.query({ query: 'waiting-for-model', grant: f.grant, signal: controller.signal });
    const rejected = assert.rejects(reading, { name: 'AbortError' });
    await joined.promise;
    assert.equal(backend.status().preparing, true);
    assert.equal(backend.status().queued, 0);
    controller.abort(); await rejected;
    assert.equal((await f.api.status({ grant: f.grant })).profiles[0].releasing, false);
    assert.ok(!f.requests.some(texts => texts.includes('waiting-for-model')));
  } finally { release.resolve(); await loading; }
  const backend = f.backend;
  assert.equal((await f.api.query({ query: 'next-query', grant: f.grant })).records[0].id, 'one');
  assert.equal(f.backend, backend);
});

for (const change of ['revise','revoke']) for (const window of ['queued','loaded','between-batches']) {
  test(`source boundary: ${change} while ${window} prevents unsent stale batches`, async t=>{
    const f=await sourceBoundaryFixture(t),oldText='OLD-FICTIONAL-SOURCE '.repeat(200),newText='NEW-FICTIONAL-SOURCE';
    f.rows.set('target',doc('target','raw',oldText));f.rows.set('neighbor',doc('neighbor','document','VALID-FICTIONAL-NEIGHBOR'));
    const mutate=()=>{if(change==='revise')f.rows.set('target',doc('target','raw',newText,2));else f.rows.delete('target');};
    const entered=defer(),release=defer();let once=false,blocking;
    if(window==='between-batches')f.hooks.sent=async texts=>{if(!once&&texts.some(t=>t.includes('OLD-FICTIONAL-SOURCE'))){once=true;mutate();}};
    if(window==='loaded'){
      f.hooks.planned=async text=>{if(text===oldText&&!once){once=true;await f.backend.releaseTransport();f.hooks.loaded=async()=>{delete f.hooks.loaded;entered.resolve();await release.promise;};}};
    }
    if(window==='queued'){
      f.hooks.sent=async texts=>{if(texts[0]==='BUSY-QUERY'){entered.resolve();await release.promise;}};
      f.hooks.planned=async text=>{if(text===oldText&&!once){once=true;blocking=f.backend.embed(['BUSY-QUERY'],{kind:'query',timeoutMs:3000});await entered.promise;}};
    }
    const work=f.api.prepare({grant:f.grant});
    if(window!=='between-batches'){try{await entered.promise;await new Promise(r=>setImmediate(r));mutate();}finally{release.resolve();}}
    const result=await work;await blocking;
    const oldRequests=f.requests.filter(texts=>texts.some(text=>text.includes('OLD-FICTIONAL-SOURCE')));
    assert.equal(oldRequests.length,window==='between-batches'?1:0,'only an already sent batch may contain the old version');
    assert.deepEqual(f.members(result),[{id:'neighbor',revision:1},...(change==='revise'?[{id:'target',revision:2}]:[])]);
    assert.ok(f.requests.some(texts=>texts.includes('VALID-FICTIONAL-NEIGHBOR')));
    assert.equal((await f.api.status({grant:f.grant})).profiles[0].progress.state,'ready');
    // Re-including a withdrawn source is a new normal incremental operation.
    if(change==='revoke'){f.rows.set('target',doc('target','raw','RESTORED-FICTIONAL-SOURCE',2));const restored=await f.api.incremental({grant:f.grant});assert.ok(f.members(restored).some(r=>r.id==='target'&&r.revision===2));}
  });
}

test('source boundary: asynchronous rejection is awaited before HTTP dispatch',async t=>{
  const f=await sourceBoundaryFixture(t);await f.api.load({grant:f.grant});
  await assert.rejects(f.backend.embed(['MUST-NOT-SEND'],{authorize:async()=>{await new Promise(r=>setImmediate(r));return false;}}),/source access changed/);
  assert.equal(f.requests.length,0);
});

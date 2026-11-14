import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createUnifiedProfiles } from '../lib/storage/profiles.js';
import { scratchDirectory } from './helpers.js';
import { CJK } from '../lib/storage/switch-estimate.js';

// Synthetic profiles/documents and a fake backend only: no real model, no
// network, no user database. Shared by the vector model switching tests.
export const profile = (id = 'A', extra = {}) => ({ id, model: 'BAAI/bge-small-zh-v1.5', ...extra });
export const doc = (id, text = id, revision = 1, domain = 'raw') => ({ id, revision, domain, text,
  sourceIds: [`source:${id}`], anchor: { id, revision } });
export const defer = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

export async function switchFixture(t, { singleBackend = true, extra = {} } = {}) {
  const directory = await scratchDirectory('switch-');
  const file = path.join(directory, 'profiles.json'), indexFile = path.join(directory, 'vectors.sqlite');
  const valid = new WeakSet(), calls = [], hooks = {};
  let rows = [];
  function grant(kind) {
    const controller = new AbortController();
    const value = { ownerSubject: 'fictional-owner', project: 'fictional-project', signal: controller.signal,
      ...(kind ? { kind } : {}), cancel: () => { valid.delete(value); controller.abort(); } };
    valid.add(value); return value;
  }
  const g = grant('management');
  const options = { file, indexFile, singleBackend, authorize: value => valid.has(value) && !value.signal.aborted,
    async *listDocumentMetadata() { for (const { text, ...row } of rows) yield { ...structuredClone(row), length: text.length, cjk: (text.match(CJK) ?? []).length }; },
    async *listDocuments() { for (const row of [...rows]) yield structuredClone(row); },
    async resolveDocument({ id, revision }) {
      await hooks.resolve?.(id);
      const row = rows.find(row => row.id === id && row.revision === revision); return row ? structuredClone(row) : null;
    },
    createBackend({ profile: definition }) {
      calls.push({ op: 'construct', id: definition.id });
      const identity = { modelKey: `${definition.id}:${definition.revision}:fake`, dimensions: definition.dimensions };
      const backend = { modelKey: null, dimensions: identity.dimensions, batchSize: 4,
        async prepare() { await hooks.prepare?.(definition); backend.modelKey = identity.modelKey; return identity; },
        async planChunks(text, options) { await options.authorize(); return [{ start: 0, end: text.length, text, tokenBound: text.length }]; },
        async embed(texts, options) {
          calls.push({ op: 'embed', id: definition.id, kind: options.kind, texts });
          await options.authorize(); await hooks.embed?.(texts, options, definition); options.signal.throwIfAborted();
          return texts.map(() => Array.from({ length: identity.dimensions }, (_, i) => i === 0 ? 1 : 0));
        },
        async dispose() { backend.modelKey = null; },
      };
      return backend;
    }, ...extra };
  let api = createUnifiedProfiles(options);
  // Close SQLite before removing (Windows keeps open files); scratchDirectory's
  // own hook can run first and silently fail on the still-open index.
  t.after(async () => { await api.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  return {
    get api() { return api; }, directory, file, indexFile, calls, hooks, g, grant,
    setRows(value) { rows = value; }, get rows() { return rows; },
    async choose(value = profile()) { await api.register({ profile: value, grant: g }); await api.select({ profileId: value.id, grant: g }); },
    async restart() { await api.close(); api = createUnifiedProfiles(options); await api.ready(); },
    embedded(id) { return calls.filter(row => row.op === 'embed' && row.kind === 'document' && (!id || row.id === id)).flatMap(row => row.texts); },
    count(sql, ...args) {
      const db = new DatabaseSync(indexFile, { readOnly: true });
      try { return db.prepare(sql).get(...args).n; } finally { db.close(); }
    },
  };
}

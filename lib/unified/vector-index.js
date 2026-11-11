import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync } from 'node:fs';
import { memoryError } from './contract.js';

// Single host writer. Guards run after every disk wait and immediately before
// rename; failed writes do not publish the new in-memory revision.
export function createProfileStore({ file, initial }) {
  if (!path.isAbsolute(file || '')) throw new TypeError('Absolute profile/index file required');
  let value, loading, broken, chain = Promise.resolve();
  async function read(guard = () => {}) {
    guard();
    if (broken) throw broken;
    if (!value) {
      loading ||= (async () => {
        let next;
        try { next = JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; next = { version: 1, revision: randomUUID(), ...initial() }; }
        if (next?.version !== 1 || typeof next.revision !== 'string') throw memoryError('INVALID_PROFILE_STORE', '档位／索引文件无效');
        return next;
      })();
      let next;
      try { next = await loading; } catch (error) { loading = undefined; throw error; }
      guard(); value ||= next;
    }
    return structuredClone(value);
  }
  async function save(next, guard) {
    await fs.mkdir(path.dirname(file), { recursive: true }); guard();
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(next) + '\n', { flag: 'wx', mode: 0o600 }); guard();
      await fs.rename(temporary, file);
      try { guard(); }
      catch (error) {
        // No other store reader/writer can observe an unaccepted activation.
        // Compensate an authorization change during the atomic disk rename.
        try {
          await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, file);
        } catch (rollbackError) {
          broken = memoryError('PROFILE_COMMIT_UNCERTAIN', '撤权时的设置回退失败，需要重新核对磁盘状态');
          broken.cause = rollbackError; throw broken;
        }
        throw error;
      }
      value = next;
    } finally { await fs.rm(temporary, { force: true }); }
  }
  return {
    peek() { return value ? structuredClone(value) : null; },
    async read(guard) { await chain; return read(guard); },
    update(mutator, { guard = () => {}, expectedRevision } = {}) {
      const task = chain.then(async () => {
        const next = await read(guard); guard();
        if (expectedRevision !== undefined && next.revision !== expectedRevision) throw memoryError('MEMORY_REVISION_CONFLICT', '档位设置已变化', 409);
        const result = await mutator(next); guard(); next.revision = randomUUID();
        await save(next, guard); guard();
        return { value: structuredClone(next), result };
      });
      chain = task.then(() => {}, () => {}); return task;
    },
    async idle() { await chain; },
  };
}

export const profileScopeKey = scope => JSON.stringify([scope.ownerSubject, scope.project]);
export const profileIndexIdentity = ({ profileId, profileRevision, modelKey }) =>
  JSON.stringify([profileId, profileRevision, modelKey]);

export function checkedVector(vector, dimensions) {
  if ((!Array.isArray(vector) && !ArrayBuffer.isView(vector)) || vector.length !== dimensions) throw memoryError('EMBEDDING_DIMENSIONS', '向量维数不一致');
  const out = Array.from(vector); let sum = 0;
  for (const number of out) { if (!Number.isFinite(number)) throw memoryError('INVALID_EMBEDDING', '向量包含无效数字'); sum += number * number; }
  if (!sum || !Number.isFinite(sum)) throw memoryError('INVALID_EMBEDDING', '向量范数无效');
  const norm = Math.sqrt(sum); return out.map(number => number / norm);
}

/** Token plans may omit whitespace, but cannot silently truncate any content. */
export function checkedPlan(text, plan, maxTokens) {
  if (!Array.isArray(plan)) throw memoryError('INVALID_CHUNK_PLAN', '分块结果无效');
  let cursor = 0;
  for (const chunk of plan) {
    if (!Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) || chunk.start < cursor || chunk.end <= chunk.start || chunk.end > text.length ||
        chunk.text !== text.slice(chunk.start, chunk.end) || /\S/u.test(text.slice(cursor, chunk.start)) ||
        !Number.isSafeInteger(chunk.tokenBound) || chunk.tokenBound < 0 || chunk.tokenBound > maxTokens) throw memoryError('INVALID_CHUNK_PLAN', '分块预算或原文覆盖无效');
    cursor = chunk.end;
  }
  if (/\S/u.test(text.slice(cursor))) throw memoryError('INCOMPLETE_CHUNK_COVERAGE', '分块没有覆盖完整原文');
  return plan;
}

const encodeJSON = value => JSON.stringify(value);
const generationFrom = row => row && ({ id: row.id, ownerSubject: row.owner_subject, project: row.project,
  profileId: row.profile_id, profileRevision: row.profile_revision, modelKey: row.model_key,
  dimensions: row.dimensions, indexIdentity: row.index_identity, createdAt: row.created_at });
const documentFrom = row => row && ({ id: row.doc_id, revision: JSON.parse(row.revision), domain: row.domain,
  sourceIds: JSON.parse(row.source_ids), ...(row.anchor === null ? {} : { anchor: JSON.parse(row.anchor) }) });

/** Lazy SQLite index. Immutable document versions own Float32 chunks. Snapshot
 * membership references those versions: retaining/pinning a generation never
 * copies vectors. Only checkpoint membership may change; ready generations are
 * immutable. Each changed document is its own guarded atomic transaction.
 * Construction does not touch the filesystem. No JSON-index compatibility path.
 */
export function createVectorIndex({ file }) {
  if (!path.isAbsolute(file || '')) throw new TypeError('Absolute vector index file required');
  let db, closed = false;
  const statements = new Map();
  function open(guard) {
    guard();
    if (closed) throw memoryError('VECTOR_INDEX_CLOSED', '向量索引已关闭');
    if (!db) {
      mkdirSync(path.dirname(file), { recursive: true }); guard();
      const candidate = new DatabaseSync(file);
      try {
        candidate.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
          CREATE TABLE IF NOT EXISTS vector_snapshots (
            id TEXT PRIMARY KEY, owner_subject TEXT NOT NULL, project TEXT NOT NULL,
            profile_id TEXT NOT NULL, profile_revision TEXT NOT NULL, model_key TEXT NOT NULL,
            dimensions INTEGER NOT NULL, index_identity TEXT NOT NULL,
            state TEXT NOT NULL CHECK(state IN ('checkpoint','ready')), created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS vector_snapshot_lookup ON vector_snapshots(owner_subject,project,index_identity,state);
          CREATE UNIQUE INDEX IF NOT EXISTS vector_checkpoint_unique ON vector_snapshots(owner_subject,project,index_identity) WHERE state='checkpoint';
          CREATE TABLE IF NOT EXISTS vector_documents (
            version_id INTEGER PRIMARY KEY, owner_subject TEXT NOT NULL, project TEXT NOT NULL,
            index_identity TEXT NOT NULL, doc_id TEXT NOT NULL, revision TEXT NOT NULL,
            domain TEXT NOT NULL, source_ids TEXT NOT NULL, anchor TEXT
          );
          CREATE TABLE IF NOT EXISTS vector_chunks (
            document_version_id INTEGER NOT NULL REFERENCES vector_documents(version_id),
            ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
            token_bound INTEGER NOT NULL, text_hash TEXT, vector BLOB NOT NULL,
            PRIMARY KEY(document_version_id,ordinal)
          );
          CREATE TABLE IF NOT EXISTS vector_members (
            snapshot_id TEXT NOT NULL REFERENCES vector_snapshots(id) ON DELETE CASCADE,
            doc_id TEXT NOT NULL, document_version_id INTEGER NOT NULL REFERENCES vector_documents(version_id),
            PRIMARY KEY(snapshot_id,doc_id)
          );`);
        guard(); db = candidate;
      } catch (error) { candidate.close(); throw error; }
    }
    guard(); return db;
  }
  function sql(query) {
    if (!statements.has(query)) statements.set(query, db.prepare(query));
    return statements.get(query);
  }
  function transaction(guard, action) {
    open(guard); db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try { guard(); const result = action(); guard(); db.exec('COMMIT'); committed = true; guard(); return result; }
    catch (error) { if (!committed) db.exec('ROLLBACK'); throw error; }
  }
  function snapshot(scope, id, guard, state) {
    open(guard);
    const row = sql('SELECT * FROM vector_snapshots WHERE id=? AND owner_subject=? AND project=?').get(id, scope.ownerSubject, scope.project);
    if (!row || state && row.state !== state) throw memoryError('INVALID_PROFILE_SNAPSHOT', '向量索引快照无效');
    guard(); return row;
  }
  function member(scope, id, docId, guard) {
    snapshot(scope, id, guard);
    return sql(`SELECT d.* FROM vector_members m JOIN vector_documents d ON d.version_id=m.document_version_id
      WHERE m.snapshot_id=? AND m.doc_id=? AND d.owner_subject=? AND d.project=?`).get(id, docId, scope.ownerSubject, scope.project);
  }
  return {
    profileStats({ scope, profileId, guard }) {
      guard();
      if (!db && !existsSync(file)) return { snapshots: 0, documents: 0, chunks: 0 };
      open(guard);
      const snapshots = sql('SELECT COUNT(*) AS n FROM vector_snapshots WHERE owner_subject=? AND project=? AND profile_id=?').get(scope.ownerSubject, scope.project, profileId).n;
      const documents = sql("SELECT COUNT(*) AS n FROM vector_documents WHERE owner_subject=? AND project=? AND json_extract(index_identity,'$[0]')=?").get(scope.ownerSubject, scope.project, profileId).n;
      const chunks = sql(`SELECT COUNT(*) AS n FROM vector_chunks c JOIN vector_documents d ON d.version_id=c.document_version_id
        WHERE d.owner_subject=? AND d.project=? AND json_extract(d.index_identity,'$[0]')=?`).get(scope.ownerSubject, scope.project, profileId).n;
      guard(); return { snapshots, documents, chunks };
    },
    dropProfile({ scope, profileId, guard }) {
      guard();
      if (!db && !existsSync(file)) return { snapshots: 0, documents: 0, chunks: 0 };
      return transaction(guard, () => {
        const snapshots = sql('DELETE FROM vector_snapshots WHERE owner_subject=? AND project=? AND profile_id=?').run(scope.ownerSubject, scope.project, profileId).changes;
        const owned = `SELECT d.version_id FROM vector_documents d WHERE d.owner_subject=? AND d.project=?
          AND json_extract(d.index_identity,'$[0]')=? AND NOT EXISTS(SELECT 1 FROM vector_members m WHERE m.document_version_id=d.version_id)`;
        const chunks = sql('DELETE FROM vector_chunks WHERE document_version_id IN (' + owned + ')').run(scope.ownerSubject, scope.project, profileId).changes;
        const documents = sql('DELETE FROM vector_documents WHERE version_id IN (' + owned + ')').run(scope.ownerSubject, scope.project, profileId).changes;
        return { snapshots, documents, chunks };
      });
    },
    /** Keep the newest `retain` ready snapshots of ONE index identity plus every
     * id in keep; checkpoints, other identities, profiles and scopes are untouched.
     * Document versions of this identity no snapshot references are reclaimed. */
    prune({ scope, indexIdentity, keep = [], retain = 1, guard }) {
      guard();
      if (!db && !existsSync(file)) return { snapshots: 0, members: 0, documents: 0, chunks: 0 };
      return transaction(guard, () => {
        const kept = new Set(keep);
        const rows = sql(`SELECT id FROM vector_snapshots WHERE owner_subject=? AND project=? AND index_identity=? AND state='ready' ORDER BY rowid DESC`)
          .all(scope.ownerSubject, scope.project, indexIdentity);
        let snapshots = 0, members = 0;
        for (const [i, row] of rows.entries()) {
          if (i < retain || kept.has(row.id)) continue;
          members += sql('DELETE FROM vector_members WHERE snapshot_id=?').run(row.id).changes;
          snapshots += sql('DELETE FROM vector_snapshots WHERE id=?').run(row.id).changes;
        }
        const owned = `SELECT d.version_id FROM vector_documents d WHERE d.owner_subject=? AND d.project=? AND d.index_identity=?
          AND NOT EXISTS(SELECT 1 FROM vector_members m WHERE m.document_version_id=d.version_id)`;
        const args = [scope.ownerSubject, scope.project, indexIdentity];
        const chunks = sql('DELETE FROM vector_chunks WHERE document_version_id IN (' + owned + ')').run(...args).changes;
        const documents = sql('DELETE FROM vector_documents WHERE version_id IN (' + owned + ')').run(...args).changes;
        return { snapshots, members, documents, chunks };
      });
    },
    /** Read-only metadata: newest ready snapshot of one profile revision (any
     * model key), or null. Never creates the index file. */
    latestReady({ scope, profileId, profileRevision, guard }) {
      guard();
      if (!db && !existsSync(file)) return null;
      open(guard);
      const row = sql(`SELECT * FROM vector_snapshots WHERE owner_subject=? AND project=? AND profile_id=? AND profile_revision=? AND state='ready' ORDER BY rowid DESC LIMIT 1`)
        .get(scope.ownerSubject, scope.project, profileId, profileRevision);
      guard(); return generationFrom(row) ?? null;
    },
    /** Read-only metadata for the newest ready snapshot of one archive. */
    archiveStats({ scope, profileId, profileRevision, guard }) {
      guard();
      if (closed) throw memoryError('VECTOR_INDEX_CLOSED', '向量索引已关闭');
      if (!db && !existsSync(file)) return { indexed: false };
      const reader = db ?? new DatabaseSync(file, { readOnly: true });
      try {
        const row = reader.prepare(`SELECT * FROM vector_snapshots WHERE owner_subject=? AND project=? AND profile_id=? AND profile_revision=? AND state='ready' ORDER BY rowid DESC LIMIT 1`)
          .get(scope.ownerSubject, scope.project, profileId, profileRevision);
        guard();
        if (!row) return { indexed: false };
        const documents = reader.prepare('SELECT COUNT(*) AS n FROM vector_members WHERE snapshot_id=?').get(row.id).n;
        const chunks = reader.prepare(`SELECT COUNT(*) AS n FROM vector_members m JOIN vector_chunks c ON c.document_version_id=m.document_version_id
          WHERE m.snapshot_id=?`).get(row.id).n;
        guard();
        return { indexed: true, documents, chunks, lastReadyAt: row.created_at,
          estimatedBytes: chunks * row.dimensions * 4 };
      } finally { if (reader !== db) reader.close(); }
    },
    checkpoint({ scope, profile, modelKey, indexIdentity, resume, now, guard }) {
      return transaction(guard, () => {
        let row = sql(`SELECT * FROM vector_snapshots WHERE owner_subject=? AND project=? AND index_identity=? AND state='checkpoint'`).get(scope.ownerSubject, scope.project, indexIdentity);
        if (row && resume !== false) return generationFrom(row);
        if (row) sql('DELETE FROM vector_snapshots WHERE id=?').run(row.id);
        const previous = sql(`SELECT * FROM vector_snapshots WHERE owner_subject=? AND project=? AND index_identity=? AND state='ready' ORDER BY rowid DESC LIMIT 1`).get(scope.ownerSubject, scope.project, indexIdentity);
        const id = randomUUID();
        sql(`INSERT INTO vector_snapshots(id,owner_subject,project,profile_id,profile_revision,model_key,dimensions,index_identity,state,created_at)
          VALUES(?,?,?,?,?,?,?,?,'checkpoint',?)`).run(id, scope.ownerSubject, scope.project, profile.id, profile.revision, modelKey, profile.dimensions, indexIdentity, now);
        if (previous) sql(`INSERT INTO vector_members(snapshot_id,doc_id,document_version_id)
          SELECT ?,doc_id,document_version_id FROM vector_members WHERE snapshot_id=?`).run(id, previous.id);
        return generationFrom(snapshot(scope, id, guard, 'checkpoint'));
      });
    },
    document({ scope, snapshotId, id, guard }) { return documentFrom(member(scope, snapshotId, id, guard)); },
    documents({ scope, snapshotId, guard }) {
      snapshot(scope, snapshotId, guard);
      // Metadata only. No vector BLOBs or retained generations are read.
      const rows = sql(`SELECT d.* FROM vector_members m JOIN vector_documents d ON d.version_id=m.document_version_id
        WHERE m.snapshot_id=? AND d.owner_subject=? AND d.project=? ORDER BY m.rowid`).all(snapshotId, scope.ownerSubject, scope.project);
      guard(); return rows.map(documentFrom);
    },
    put({ scope, snapshotId, document, dimensions, guard }) {
      return transaction(guard, () => {
        const checkpoint = snapshot(scope, snapshotId, guard, 'checkpoint');
        if (checkpoint.dimensions !== dimensions) throw memoryError('EMBEDDING_DIMENSIONS', '检查点维数不一致');
        const version = sql(`INSERT INTO vector_documents(owner_subject,project,index_identity,doc_id,revision,domain,source_ids,anchor)
          VALUES(?,?,?,?,?,?,?,?)`).run(scope.ownerSubject, scope.project, checkpoint.index_identity, document.id, encodeJSON(document.revision),
          document.domain, encodeJSON(document.sourceIds), document.anchor === undefined ? null : encodeJSON(document.anchor)).lastInsertRowid;
        const insert = sql(`INSERT INTO vector_chunks(document_version_id,ordinal,start,end,token_bound,text_hash,vector) VALUES(?,?,?,?,?,?,?)`);
        document.chunks.forEach((chunk, i) => {
          guard();
          if (chunk.vector.length !== dimensions) throw memoryError('EMBEDDING_DIMENSIONS', '文档向量维数不一致');
          const blob = Buffer.allocUnsafe(dimensions * 4);
          chunk.vector.forEach((number, offset) => {
            if (!Number.isFinite(number) || !Number.isFinite(Math.fround(number))) throw memoryError('INVALID_EMBEDDING', '无法保存 Float32 向量');
            blob.writeFloatLE(number, offset * 4);
          });
          insert.run(version, i, chunk.start, chunk.end, chunk.tokenBound, chunk.textHash ?? null, blob);
        });
        sql(`INSERT INTO vector_members(snapshot_id,doc_id,document_version_id) VALUES(?,?,?)
          ON CONFLICT(snapshot_id,doc_id) DO UPDATE SET document_version_id=excluded.document_version_id`).run(snapshotId, document.id, version);
      });
    },
    remove({ scope, snapshotId, id, guard }) {
      transaction(guard, () => { snapshot(scope, snapshotId, guard, 'checkpoint'); sql('DELETE FROM vector_members WHERE snapshot_id=? AND doc_id=?').run(snapshotId, id); });
    },
    finish({ scope, snapshotId, guard }) {
      return transaction(guard, () => {
        const row = snapshot(scope, snapshotId, guard, 'checkpoint');
        sql("UPDATE vector_snapshots SET state='ready' WHERE id=?").run(snapshotId);
        return generationFrom(row);
      });
    },
    generation({ scope, snapshotId, guard }) { return generationFrom(snapshot(scope, snapshotId, guard, 'ready')); },
    rank({ scope, snapshotId, documents, vector, guard }) {
      const row = snapshot(scope, snapshotId, guard, 'ready');
      if (row.dimensions !== vector.length) throw memoryError('EMBEDDING_DIMENSIONS', '查询向量维数不一致');
      const result = [];
      const chunks = sql(`SELECT c.start,c.end,c.vector FROM vector_members m
        JOIN vector_documents d ON d.version_id=m.document_version_id JOIN vector_chunks c ON c.document_version_id=d.version_id
        WHERE m.snapshot_id=? AND m.doc_id=? AND d.owner_subject=? AND d.project=? AND d.index_identity=? ORDER BY c.ordinal`);
      for (const document of documents) {
        guard(); let score = -Infinity, best;
        for (const chunk of chunks.iterate(snapshotId, document.id, scope.ownerSubject, scope.project, row.index_identity)) {
          guard();
          const blob = Buffer.from(chunk.vector.buffer, chunk.vector.byteOffset, chunk.vector.byteLength);
          if (blob.length !== vector.length * 4) throw memoryError('EMBEDDING_DIMENSIONS', '索引向量维数不一致');
          let similarity = 0;
          for (let i = 0; i < vector.length; i++) similarity += blob.readFloatLE(i * 4) * vector[i];
          if (!Number.isFinite(similarity)) throw memoryError('INVALID_EMBEDDING', '索引向量无效');
          if (similarity > score) { score = similarity; best = { start: chunk.start, end: chunk.end }; }
        }
        if (best) result.push({ document, score, chunk: best });
      }
      guard(); return result.sort((a, b) => b.score - a.score);
    },
    close() { closed = true; statements.clear(); db?.close(); db = undefined; },
  };
}

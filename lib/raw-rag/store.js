import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { indexText, lexicalMatch, textQuery } from './lexical.js';
import {RawMessageStore} from './messages.js';
import {MemoryEntryIndex} from '../memory-entry-index.js';

const LEGACY_TURN_ID_SEPARATOR = '\u0000';
const TURN_ID_SEPARATOR = '\u001f';
const LEGACY_VERSION_SEPARATOR = '\\u0000';
const VERSION_SEPARATOR = '\\u001f';

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

export function rawTurnId(scope, sessionId, turn) {
  return [scope, sessionId, turn].map(part => String(part ?? '')).join(TURN_ID_SEPARATOR);
}

export function canonicalTurnId(value) {
  return typeof value === 'string' ? value.replaceAll(LEGACY_TURN_ID_SEPARATOR, TURN_ID_SEPARATOR) : value;
}

function canonicalSourceVersion(value) {
  return typeof value === 'string'
    ? canonicalTurnId(value).replaceAll(LEGACY_VERSION_SEPARATOR, VERSION_SEPARATOR)
    : value;
}

export function sameSourceVersion(left, right) {
  return canonicalSourceVersion(left) === canonicalSourceVersion(right);
}

// Metadata-only watermark for supported maintenance writers. Controls keep a
// scope-monotonic timestamp; reviewed views retain and increment their revision
// even when cleared. No original body, new table, or second queue is needed.
export function rawMaintenanceRevision(db,scope,namespace='default') {
  const exists=table=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  const controls=exists('raw_controls')?db.prepare('SELECT COUNT(*) n,COALESCE(MAX(updated_at),0) stamp FROM raw_controls WHERE namespace=? AND scope=?').get(namespace,scope):{n:0,stamp:0};
  const views=exists('legacy_scope_views')?db.prepare("SELECT COUNT(*) n,CAST(COALESCE(SUM(revision),0) AS TEXT) revision FROM legacy_scope_views WHERE namespace=? AND scope=?").get(namespace,scope):{n:0,revision:'0'};
  return controls.n||views.n?JSON.stringify([controls.n,controls.stamp,views.n,views.revision]):null;
}

// The revision catches A -> B -> A writes by this bridge; the hash and source
// metadata also catch changes made by an older writer that ignores revisions.
function sourceVersion(row) {
  // Keep the opaque version stable across the turn-id separator migration. Old
  // vector documents and Vault derivations already contain this representation.
  const turnId = canonicalTurnId(row.turn_id).replaceAll(TURN_ID_SEPARATOR, LEGACY_TURN_ID_SEPARATOR);
  return JSON.stringify([row.namespace, row.scope, turnId,
    Number(row.source_revision), row.doc_hash, row.session_id,
    Number(row.turn), Number(row.completed_at)]);
}

const scopeViewJoin = `LEFT JOIN legacy_scope_views sv
  ON sv.namespace=t.namespace AND sv.scope=t.scope AND sv.turn_id=t.turn_id`;
const scopeViewColumns = 'sv.revision AS scope_view_revision,sv.turn_revision AS reviewed_turn_revision,sv.ranges_json';

function migrateTurnIds(db) {
  if (db.prepare('SELECT 1 FROM raw_schema WHERE key=?').get('turn-id-v2')) return;
  const specs = [
    {table:'turns', columns:['namespace'], key:(row,id)=>[row.namespace,id]},
    {table:'windows', columns:['namespace','window_id'], key:(row,id)=>[row.namespace,row.window_id,id]},
    {table:'vectors', columns:['namespace','model_key','window_id'], key:(row,id)=>[row.namespace,row.model_key,row.window_id,id]},
    {table:'turn_messages', columns:['namespace','message_id'], key:row=>[row.namespace,row.message_id], keyUsesTurnId:false},
    {table:'turn_visibility', columns:['namespace'], key:(row,id)=>[row.namespace,id]},
    {table:'legacy_scope_views', columns:['namespace','scope'], key:(row,id)=>[row.namespace,row.scope,id]},
    {table:'embedding_chunks', columns:['namespace','model_key','window_id'], key:(row,id)=>[row.namespace,row.model_key,row.window_id,id]},
    {table:'embedding_chunk_sources', columns:['namespace','model_key'], key:(row,id)=>[row.namespace,row.model_key,id]},
    {table:'import_members', columns:['scope','source_id'], key:(row,id)=>[row.scope,row.source_id,id]},
  ];
  const decode = value => Buffer.from(value).toString('utf8');
  const rowKey = (spec,row,id) => JSON.stringify(spec.key(row,id));
  db.exec('BEGIN IMMEDIATE');
  try {
    const rowsByTable = new Map(), occupiedTurnIds = new Set();
    const namespacesByOldId = new Map(), conflicts = new Map();
    for (const spec of specs) {
      const rows = db.prepare(`SELECT rowid,${spec.columns.join(',')},CAST(turn_id AS BLOB) turn_blob FROM ${spec.table}`).all()
        .map(row => ({...row, turn_id:decode(row.turn_blob)}));
      rowsByTable.set(spec.table,rows.filter(row=>row.turn_id.includes(LEGACY_TURN_ID_SEPARATOR)));
      const keys = new Set(rows.map(row=>rowKey(spec,row,row.turn_id)));
      for (const row of rows) {
        if (row.namespace !== undefined) occupiedTurnIds.add(JSON.stringify([row.namespace,canonicalTurnId(row.turn_id)]));
        if (!row.turn_id.includes(LEGACY_TURN_ID_SEPARATOR)) continue;
        const namespaces = namespacesByOldId.get(row.turn_id) ?? new Set();
        namespaces.add(row.namespace ?? '*'); namespacesByOldId.set(row.turn_id,namespaces);
        if (spec.keyUsesTurnId === false) continue;
        const canonicalKey = rowKey(spec,row,canonicalTurnId(row.turn_id));
        if (keys.has(canonicalKey)) {
          const state = conflicts.get(row.turn_id) ?? {namespaces:new Set()};
          state.namespaces.add(row.namespace ?? '*'); conflicts.set(row.turn_id,state);
        }
      }
    }

    const controls = db.prepare(`SELECT rowid,namespace,scope,target_type,origin,CAST(target_id AS BLOB) target_blob
      FROM raw_controls WHERE target_type='turn'`).all()
      .map(row=>({...row,target_id:decode(row.target_blob)}));
    const controlKey = (row,id)=>JSON.stringify([row.namespace,row.scope,row.target_type,id,row.origin]);
    const controlKeys = new Set(controls.map(row=>controlKey(row,row.target_id)));
    for (const row of controls) {
      if (!row.target_id.includes(LEGACY_TURN_ID_SEPARATOR)) continue;
      const namespaces = namespacesByOldId.get(row.target_id) ?? new Set();
      namespaces.add(row.namespace); namespacesByOldId.set(row.target_id,namespaces);
      if (!controlKeys.has(controlKey(row,canonicalTurnId(row.target_id)))) continue;
      const state = conflicts.get(row.target_id) ?? {namespaces:new Set()};
      state.namespaces.add(row.namespace); conflicts.set(row.target_id,state);
    }

    const conflictIds = new Map();
    const occupiedIds = new Set([...occupiedTurnIds].map(key=>JSON.parse(key)[1]));
    for (const [oldId,state] of conflicts) {
      const namespaces = namespacesByOldId.get(oldId) ?? state.namespaces;
      let salt = 0, candidate;
      do {
        candidate = TURN_ID_SEPARATOR + 'migration-conflict' + TURN_ID_SEPARATOR + sha256(JSON.stringify([oldId,salt]));
        salt += 1;
      } while ([...namespaces].some(namespace=>namespace === '*'
        ? occupiedIds.has(candidate)
        : occupiedTurnIds.has(JSON.stringify([namespace,candidate]))));
      conflictIds.set(oldId,candidate);
    }

    for (const spec of specs) {
      const update = db.prepare(`UPDATE ${spec.table} SET turn_id=? WHERE rowid=?`);
      for (const row of rowsByTable.get(spec.table)) {
        if (!row.turn_id.includes(LEGACY_TURN_ID_SEPARATOR)) continue;
        update.run(conflictIds.get(row.turn_id) ?? canonicalTurnId(row.turn_id),row.rowid);
      }
    }
    const controlUpdate = db.prepare('UPDATE raw_controls SET target_id=? WHERE rowid=?');
    for (const row of controls) {
      if (!row.target_id.includes(LEGACY_TURN_ID_SEPARATOR)) continue;
      controlUpdate.run(conflictIds.get(row.target_id) ?? canonicalTurnId(row.target_id),row.rowid);
    }
    const viewUpdate = db.prepare('UPDATE legacy_scope_views SET turn_revision=? WHERE rowid=?');
    for (const row of db.prepare('SELECT rowid,turn_revision FROM legacy_scope_views').iterate()) {
      const next = row.turn_revision.replaceAll(LEGACY_VERSION_SEPARATOR,VERSION_SEPARATOR);
      if (next !== row.turn_revision) viewUpdate.run(next, row.rowid);
    }
    const hide = db.prepare(`INSERT INTO turn_visibility(namespace,turn_id,excluded) VALUES(?,?,1)
      ON CONFLICT(namespace,turn_id) DO UPDATE SET excluded=1`);
    for (const [oldId,conflictId] of conflictIds) {
      for (const namespace of namespacesByOldId.get(oldId) ?? []) if (namespace !== '*') hide.run(namespace,conflictId);
    }
    db.prepare('INSERT INTO raw_schema(key,value) VALUES(?,?)').run('turn-id-v2', '1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readVersion(row) {
  const original = sourceVersion(row);
  return row.scope_view_revision == null ? original : JSON.stringify([original, row.scope_view_revision]);
}

function reviewedRanges(messages, reviewed) {
  if (!Array.isArray(reviewed) || reviewed.length !== messages.length) throw Error('Scope view must review every message');
  const byId = new Map(reviewed.map(item => [item?.messageId, item?.ranges]));
  if (byId.size !== messages.length) throw Error('Scope view message IDs must be unique');
  return messages.map(message => {
    const ranges = byId.get(message.id);
    if (!Array.isArray(ranges)) throw Error('Scope view must review every message');
    let previous = 0;
    const splitsPair = offset => /[\uD800-\uDBFF]/.test(message.text[offset-1] ?? '') && /[\uDC00-\uDFFF]/.test(message.text[offset] ?? '');
    for (const pair of ranges) {
      if (!Array.isArray(pair) || pair.length !== 2) throw Error('Invalid scope view range');
      const [start, end] = pair;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < previous || end <= start
        || end > message.text.length || splitsPair(start) || splitsPair(end)) throw Error('Invalid scope view range');
      previous = end;
    }
    return {messageId:message.id, ranges};
  });
}

function readableMessages(row) {
  if (row.ranges_json != null && !sameSourceVersion(row.reviewed_turn_revision,sourceVersion(row))) return [];
  const messages = JSON.parse(row.messages_json);
  if (row.ranges_json == null) return messages;
  const reviewed = reviewedRanges(messages, JSON.parse(row.ranges_json));
  return messages.flatMap((message, index) => {
    const {ranges} = reviewed[index];
    if (!ranges.length) return [];
    let text = '';
    const offsets = ranges.map(([start, end]) => {
      if (text.length) text += '\n';
      const textStart = text.length;
      text += message.text.slice(start, end);
      return {start, end, docStart:message.docStart+start, docEnd:message.docStart+end, textStart, textEnd:text.length};
    });
    const kind = ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === message.text.length ? 'selected-message' : 'excerpt';
    return [{...message, text, docStart:offsets[0].docStart, docEnd:offsets.at(-1).docEnd,
      fragment:{kind, offsetUnit:'utf16', ranges:offsets}}];
  });
}

export function legacyMessageMatch(query, message) {
  if (!message.fragment) return lexicalMatch(query, message.text);
  return message.fragment.ranges.reduce((score, {textStart, textEnd}) =>
    Math.max(score, lexicalMatch(query, message.text.slice(textStart, textEnd))), 0);
}

function readableTurn(row, messageId = '') {
  const messages = readableMessages(row);
  if (!messages.length || (messageId && !messages.some(message=>message.id===messageId))) return null;
  return {turnId:row.turn_id, sourceVersion:readVersion(row), scope:row.scope, sessionId:row.session_id,
    turn:Number(row.turn), completedAt:Number(row.completed_at), weight:Number(row.weight), messages,
    ...(row.scope_view_revision == null ? {} : {turnRevision:sourceVersion(row), scopeViewRevision:row.scope_view_revision})};
}

const SENTENCE_BREAK = /[\n\r。！？；;.!?，,]/;
const isBreak = (text, index) => SENTENCE_BREAK.test(text[index])
  && !(text[index] === '.' && /[a-z0-9]/i.test(text[index - 1] || '') && /[a-z0-9]/i.test(text[index + 1] || ''));

/** Split text into sentence-ish clauses while keeping exact source offsets. */
export function splitClauses(text) {
  const source = String(text ?? '');
  const out = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (isBreak(source, index)) {
      let end = index + 1;
      while (end < source.length && isBreak(source, end)) end += 1;
      const value = source.slice(start, end).trim();
      if (value) out.push({ text: value, start, end });
      start = end;
      index = end - 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) out.push({ text: tail, start, end: source.length });
  return out;
}

/** Split a whole turn into non-overlapping embedding windows. */
export function splitWindows(text, maxChars = 600) {
  const source = String(text ?? '');
  const limit = Math.max(80, Number(maxChars) || 600);
  const windows = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(source.length, start + limit);
    if(end<source.length&&/[\uD800-\uDBFF]/.test(source[end-1])&&/[\uDC00-\uDFFF]/.test(source[end]))end-=1;
    if (end < source.length) {
      let boundary = end;
      while (boundary > start && !isBreak(source, boundary - 1)) boundary -= 1;
      if (boundary > start + Math.floor(limit * 0.35)) end = boundary;
    }
    while (start < end && /\s/.test(source[start])) start += 1;
    const value = source.slice(start, end);
    const trimmed = value.trim();
    if (trimmed) {
      const lead = value.indexOf(trimmed);
      windows.push({
        id: 'w' + windows.length,
        index: windows.length,
        start: start + lead,
        end: start + lead + trimmed.length,
        text: trimmed,
        textHash: sha256(trimmed),
      });
    }
    start = end;
  }
  return windows;
}

export function buildTurn(input) {
  const messages = (input.messages || []).filter(m=>m.role==='user'||m.role==='assistant').map((message) => ({
    id: String(message.id ?? ''),
    role: message.role === 'assistant' ? 'assistant' : 'user',
    text: String(message.text ?? ''),
    ts: Number(message.ts ?? input.completedAt ?? 0),
    seq: Number(message.seq ?? 0),
  })).filter((message) => message.id && message.text.trim());
  if (!messages.length) throw new Error('raw recall turn needs at least one message');

  let docText = '';
  const withOffsets = messages.map((message) => {
    const prefix = message.role === 'assistant' ? '助手：' : '用户：';
    if (docText) docText += '\n';
    const docStart = docText.length + prefix.length;
    docText += prefix + message.text;
    return { ...message, docStart, docEnd: docText.length };
  });
  const turnId = canonicalTurnId(input.turnId
    ? String(input.turnId)
    : rawTurnId(input.scope, input.sessionId, input.turn));
  return {
    namespace: String(input.namespace || 'default'),
    turnId,
    scope: String(input.scope || ''),
    sessionId: String(input.sessionId || ''),
    turn: Number(input.turn ?? 0),
    completedAt: Number(input.completedAt ?? 0),
    docText,
    docHash: sha256(docText),
    messages: withOffsets,
    windows: splitWindows(docText, input.windowChars),
  };
}

export class RawMemoryStore {
  constructor(file, logger = console) {
    if (!file) throw new Error('raw recall store needs a database path');
    this.file = path.resolve(file);
    this.logger = logger;
    this.namespace = 'default';
    mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        namespace TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        session_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        completed_at INTEGER NOT NULL,
        doc_hash TEXT NOT NULL,
        doc_text TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        source_revision INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (namespace, turn_id)
      );
      CREATE TABLE IF NOT EXISTS windows (
        namespace TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        start_offset INTEGER NOT NULL,
        end_offset INTEGER NOT NULL,
        text TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        PRIMARY KEY (namespace, turn_id, window_id)
      );
      CREATE TABLE IF NOT EXISTS vectors (
        namespace TEXT NOT NULL,
        model_key TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        window_id TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        dim INTEGER NOT NULL,
        vector BLOB NOT NULL,
        PRIMARY KEY (namespace, model_key, turn_id, window_id)
      );
      CREATE INDEX IF NOT EXISTS turns_scope_time
        ON turns(namespace, scope, completed_at);
      CREATE INDEX IF NOT EXISTS turns_scope_session_turn
        ON turns(namespace, scope, session_id, turn);
      CREATE TABLE IF NOT EXISTS turn_messages (
        namespace TEXT NOT NULL, message_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        role TEXT NOT NULL, PRIMARY KEY(namespace,message_id)
      );
      CREATE INDEX IF NOT EXISTS turn_messages_turn ON turn_messages(namespace,turn_id);
      CREATE TABLE IF NOT EXISTS turn_visibility (
        namespace TEXT NOT NULL, turn_id TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1, excluded INTEGER NOT NULL DEFAULT 0,
        source_hidden INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,turn_id)
      );
      CREATE TABLE IF NOT EXISTS raw_controls (
        namespace TEXT NOT NULL, scope TEXT NOT NULL, target_type TEXT NOT NULL,
        target_id TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'operator',
        weight REAL NOT NULL DEFAULT 1, excluded INTEGER NOT NULL DEFAULT 0,
        reason TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
        PRIMARY KEY(namespace,scope,target_type,target_id,origin)
      );
      CREATE TABLE IF NOT EXISTS raw_schema (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy_scope_views (
        namespace TEXT NOT NULL, scope TEXT NOT NULL, turn_id TEXT NOT NULL,
        revision INTEGER NOT NULL, turn_revision TEXT NOT NULL, ranges_json TEXT,
        PRIMARY KEY(namespace,scope,turn_id)
      );
      CREATE TABLE IF NOT EXISTS embedding_models (
        namespace TEXT NOT NULL, model_key TEXT NOT NULL, dimensions INTEGER NOT NULL,
        descriptor_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(namespace,model_key)
      );
      CREATE TABLE IF NOT EXISTS embedding_usage (
        id INTEGER PRIMARY KEY, namespace TEXT NOT NULL, scope TEXT NOT NULL,
        model_key TEXT, at TEXT NOT NULL, receipt_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS embedding_chunks (
        namespace TEXT NOT NULL, model_key TEXT NOT NULL, turn_id TEXT NOT NULL, window_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL, start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
        text TEXT NOT NULL, text_hash TEXT NOT NULL, source_hash TEXT NOT NULL,
        source_revision INTEGER NOT NULL, token_bound INTEGER NOT NULL,
        PRIMARY KEY(namespace,model_key,turn_id,window_id)
      );
      CREATE TABLE IF NOT EXISTS embedding_chunk_sources (
        namespace TEXT NOT NULL, model_key TEXT NOT NULL, turn_id TEXT NOT NULL,
        source_hash TEXT NOT NULL, source_revision INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
        PRIMARY KEY(namespace,model_key,turn_id)
      );
      CREATE TABLE IF NOT EXISTS import_progress (
        scope TEXT NOT NULL, source_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        position INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL, PRIMARY KEY(scope,source_id)
      );
      CREATE TABLE IF NOT EXISTS import_members (
        scope TEXT NOT NULL, source_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, PRIMARY KEY(scope,source_id,turn_id)
      );
    `);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('PRAGMA table_info(turns)').all().some(column => column.name === 'source_revision')) {
        // Additive: old readers/writers keep their existing named-column queries.
        this.db.exec('ALTER TABLE turns ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 1');
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    try {
      migrateTurnIds(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    if (!this.db.prepare('SELECT value FROM raw_schema WHERE key=?').get('message-index-v1')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const insert=this.db.prepare('INSERT INTO turn_messages(namespace,message_id,turn_id,role) VALUES(?,?,?,?)');
        for (const row of this.db.prepare('SELECT namespace,turn_id,messages_json FROM turns').iterate()) {
          for (const m of JSON.parse(row.messages_json)) insert.run(row.namespace,m.id,row.turn_id,m.role);
        }
        this.db.prepare('INSERT INTO raw_schema(key,value) VALUES(?,?)').run('message-index-v1','1');
        this.db.exec('COMMIT');
      } catch(error) { this.db.exec('ROLLBACK'); this.db.close(); throw error; }
    }
    this.db.exec('INSERT OR IGNORE INTO turn_visibility(namespace,turn_id) SELECT namespace,turn_id FROM turns');
    this.messages=new RawMessageStore(this.db,()=>this.namespace);
    this.entries=new MemoryEntryIndex(this.db,()=>this.namespace);
    this.textSearchAvailable = this.initializeTextIndex();
    this.closed = false;
  }

  initializeTextIndex() {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raw_text_index'").get();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS raw_text_index USING fts5(terms,source_hash UNINDEXED)');
      if (!exists || !this.db.prepare('SELECT value FROM raw_schema WHERE key=?').get('text-index-v1')) {
        this.db.exec('DELETE FROM raw_text_index');
        this.db.prepare('INSERT OR REPLACE INTO raw_schema(key,value) VALUES(?,?)').run('text-index-v1', '1');
      }
      // A rollback to an older bridge may have changed sources without knowing
      // this derived index. Reconcile by source hash on the next new-version open.
      const insert = this.db.prepare('INSERT INTO raw_text_index(rowid,terms,source_hash) VALUES(?,?,?)');
      const stale = this.db.prepare(`SELECT t.rowid FROM turns t
        LEFT JOIN raw_text_index x ON x.rowid=t.rowid WHERE x.source_hash IS NULL OR x.source_hash<>t.doc_hash`).all();
      const read = this.db.prepare('SELECT doc_text,doc_hash FROM turns WHERE rowid=?');
      for (const row of stale) {
        const source = read.get(row.rowid);
        this.db.prepare('DELETE FROM raw_text_index WHERE rowid=?').run(row.rowid);
        insert.run(row.rowid, indexText(source.doc_text), source.doc_hash);
      }
      this.db.exec('COMMIT');
      return true;
    } catch (error) {
      this.db.exec('ROLLBACK');
      if (!/no such module: fts5/i.test(error.message)) { this.db.close(); throw error; }
      this.logger.warn?.('[raw-recall] SQLite FTS5 unavailable; retaining vector retrieval');
      return false;
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  getLegacyScopeView({scope,turnId}) {
    const id=canonicalTurnId(turnId);
    const row = this.db.prepare(`SELECT t.*,${scopeViewColumns} FROM turns t ${scopeViewJoin}
      WHERE t.namespace=? AND t.scope=? AND t.turn_id=?`).get(this.namespace,scope,id);
    if (!row) return null;
    const turnRevision = sourceVersion(row);
    return {namespace:row.namespace, scope, turnId:row.turn_id, turnRevision, docHash:row.doc_hash,
      sourceRevision:Number(row.source_revision), scopeViewRevision:row.scope_view_revision ?? 0,
      reviewedTurnRevision:row.reviewed_turn_revision ?? null,
      state:row.ranges_json == null ? (row.scope_view_revision == null ? 'unreviewed' : 'cleared')
        : (sameSourceVersion(row.reviewed_turn_revision,turnRevision) ? 'reviewed' : 'stale'),
      messages:row.ranges_json == null ? null : JSON.parse(row.ranges_json)};
  }

  /** A reviewed view narrows legacy reads. It does not change the original or its controls. */
  setLegacyScopeView(input) { return this.#writeLegacyScopeView(input, false); }

  /** Explicitly restore ordinary legacy reads while keeping earlier locators invalid. */
  clearLegacyScopeView(input) { return this.#writeLegacyScopeView(input, true); }

  #writeLegacyScopeView({scope,turnId,turnRevision,expectedScopeViewRevision,messages}, clear) {
    turnId=canonicalTurnId(turnId);
    if (!scope || typeof turnId !== 'string' || !turnId || typeof turnRevision !== 'string' || !turnRevision) {
      throw Error('Exact legacy turn revision required');
    }
    // projectMessage reserves this prefix for canonical message projections.
    if (turnId.startsWith('message:')) throw Error('Scope views are only supported for legacy turns');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getLegacyScopeView({scope,turnId});
      if (!current || !sameSourceVersion(current.turnRevision,turnRevision)
        || (expectedScopeViewRevision !== undefined && current.scopeViewRevision !== expectedScopeViewRevision)) {
        throw Error('Legacy scope view source or review changed');
      }
      const next = clear ? null : reviewedRanges(this.storedTurn(scope,turnId), messages);
      if (JSON.stringify(next) !== JSON.stringify(current.messages) || (!clear && current.state === 'stale')) {
        this.db.prepare(`INSERT INTO legacy_scope_views(namespace,scope,turn_id,revision,turn_revision,ranges_json)
          VALUES(?,?,?,?,?,?) ON CONFLICT(namespace,scope,turn_id) DO UPDATE SET
          revision=excluded.revision,turn_revision=excluded.turn_revision,ranges_json=excluded.ranges_json`)
          .run(this.namespace,scope,turnId,current.scopeViewRevision+1,current.turnRevision,next == null ? null : JSON.stringify(next));
      }
      const result = this.getLegacyScopeView({scope,turnId});
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  archiveTurn(turn) {
    if (!turn?.turnId) throw new Error('turnId is required');
    if (!turn.scope) throw new Error('scope is required');
    if(turn.namespace!==this.namespace)throw new Error('raw memory namespace mismatch');
    const turnId=canonicalTurnId(String(turn.turnId));
    const existing = this.db.prepare(
      'SELECT turn_id, scope, doc_hash,messages_json FROM turns WHERE namespace=? AND turn_id=?',
    ).get(turn.namespace, turnId);
    if (existing && existing.scope!==turn.scope) throw new Error('turn belongs to another scope');
    if(existing&&JSON.parse(existing.messages_json).every(m=>m.role==='user')&&turn.messages.some(m=>m.role==='assistant'))throw new Error('cannot widen a user-only archive');
    if (existing && existing.doc_hash === turn.docHash) {
      return { inserted: false, changed: false, pending: 0 };
    }
    const incomingIds=new Set();
    for (const m of turn.messages) {
      if(incomingIds.has(m.id))throw new Error('duplicate message id within turn');
      incomingIds.add(m.id);
      const row=this.db.prepare('SELECT turn_id FROM turn_messages WHERE namespace=? AND message_id=?').get(turn.namespace,m.id);
      if(row&&row.turn_id!==turnId)throw new Error('message '+m.id+' already belongs to '+row.turn_id);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (existing) {
        this.db.prepare('DELETE FROM turn_messages WHERE namespace=? AND turn_id=?').run(turn.namespace,turnId);
        this.db.prepare('DELETE FROM windows WHERE namespace=? AND turn_id=?').run(turn.namespace, turnId);
        this.db.prepare('DELETE FROM vectors WHERE namespace=? AND turn_id=?').run(turn.namespace, turnId);
        this.db.prepare('DELETE FROM embedding_chunks WHERE namespace=? AND turn_id=?').run(turn.namespace,turnId);
        this.db.prepare('DELETE FROM embedding_chunk_sources WHERE namespace=? AND turn_id=?').run(turn.namespace,turnId);
        this.db.prepare(
          'UPDATE turns SET scope=?, session_id=?, turn=?, completed_at=?, doc_hash=?, doc_text=?, messages_json=?, source_revision=source_revision+1 WHERE namespace=? AND turn_id=?',
        ).run(turn.scope, turn.sessionId, turn.turn, turn.completedAt, turn.docHash, turn.docText,
          JSON.stringify(turn.messages), turn.namespace, turnId);
      } else {
        this.db.prepare(
          'INSERT INTO turns(namespace, turn_id, scope, session_id, turn, completed_at, doc_hash, doc_text, messages_json, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
        ).run(turn.namespace, turnId, turn.scope, turn.sessionId, turn.turn, turn.completedAt,
          turn.docHash, turn.docText, JSON.stringify(turn.messages), Date.now());
      }
      const insertWindow = this.db.prepare(
        'INSERT INTO windows(namespace, turn_id, window_id, ordinal, start_offset, end_offset, text, text_hash) VALUES(?,?,?,?,?,?,?,?)',
      );
      for (const window of turn.windows) {
        insertWindow.run(turn.namespace, turnId, window.id, window.index, window.start,
          window.end, window.text, window.textHash);
      }
      const message=this.db.prepare('INSERT INTO turn_messages(namespace,message_id,turn_id,role) VALUES(?,?,?,?)');
      for(const m of turn.messages)message.run(turn.namespace,m.id,turnId,m.role);
      if (this.textSearchAvailable) {
        const row = this.db.prepare('SELECT rowid FROM turns WHERE namespace=? AND turn_id=?').get(turn.namespace, turnId);
        this.db.prepare('DELETE FROM raw_text_index WHERE rowid=?').run(row.rowid);
        this.db.prepare('INSERT INTO raw_text_index(rowid,terms,source_hash) VALUES(?,?,?)').run(row.rowid, indexText(turn.docText), turn.docHash);
      }
      this.db.prepare('INSERT OR IGNORE INTO turn_visibility(namespace,turn_id) VALUES(?,?)').run(turn.namespace,turnId);
      this.refreshControl(turn.scope,turnId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { inserted: !existing, changed: Boolean(existing), pending: turn.windows.length };
  }

  sourcesNeedingChunks(modelKey,{scope,limit=10}={}){
    // The old local vector path embeds whole turns. Reviewed messages instead
    // enter the unified vector catalogue through queryReader.legacyPage().
    return this.db.prepare(`SELECT t.*,sv.revision AS scope_view_revision FROM turns t
      JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id
      LEFT JOIN embedding_chunk_sources c ON c.namespace=t.namespace AND c.turn_id=t.turn_id AND c.model_key=?
      ${scopeViewJoin}
      WHERE t.namespace=? AND t.scope=? AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL
        AND (c.turn_id IS NULL OR c.source_hash<>t.doc_hash OR c.source_revision<>t.source_revision)
      ORDER BY t.completed_at,t.turn_id LIMIT ?`).all(modelKey,this.namespace,scope,Math.max(1,Math.min(40,limit)))
      .map(row=>({turnId:row.turn_id,scope:row.scope,sourceVersion:readVersion(row),docText:row.doc_text}));
  }

  putChunks(modelKey,source,chunks){
    if(!chunks?.length)throw new Error('A nonempty source needs at least one embedding chunk');
    const turnId=canonicalTurnId(source.turnId);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.db.prepare(`SELECT t.*,sv.revision AS scope_view_revision FROM turns t
        JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id ${scopeViewJoin}
        WHERE t.namespace=? AND t.turn_id=? AND t.scope=? AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL`)
        .get(this.namespace,turnId,source.scope);
      if(!row||!sameSourceVersion(readVersion(row),source.sourceVersion)){this.db.exec('COMMIT');return false;}
      const model=this.db.prepare('SELECT descriptor_json FROM embedding_models WHERE namespace=? AND model_key=?').get(this.namespace,modelKey);
      const limit=model?JSON.parse(model.descriptor_json).maxTokens:null;
      if(!Number.isSafeInteger(limit)||limit<=0)throw new Error('Embedding chunks require a registered model token limit');
      let previous=0;const ids=new Set();
      for(const chunk of chunks){
        if(!chunk.id||ids.has(chunk.id)||!Number.isSafeInteger(chunk.start)||!Number.isSafeInteger(chunk.end)||chunk.start<previous||chunk.end<=chunk.start||chunk.end>row.doc_text.length
          ||row.doc_text.slice(chunk.start,chunk.end)!==chunk.text||row.doc_text.slice(previous,chunk.start).trim()
          ||!Number.isSafeInteger(chunk.tokenBound)||chunk.tokenBound<0||chunk.tokenBound>limit||sha256(chunk.text)!==chunk.textHash)throw new Error('Invalid embedding chunk source coverage');
        ids.add(chunk.id);previous=chunk.end;
      }
      if(row.doc_text.slice(previous).trim())throw new Error('Embedding chunk plan drops source text');
      this.db.prepare('DELETE FROM vectors WHERE namespace=? AND model_key=? AND turn_id=?').run(this.namespace,modelKey,turnId);
      this.db.prepare('DELETE FROM embedding_chunks WHERE namespace=? AND model_key=? AND turn_id=?').run(this.namespace,modelKey,turnId);
      const insert=this.db.prepare(`INSERT INTO embedding_chunks(namespace,model_key,turn_id,window_id,ordinal,start_offset,end_offset,text,text_hash,source_hash,source_revision,token_bound)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      chunks.forEach((chunk,index)=>insert.run(this.namespace,modelKey,turnId,chunk.id,index,chunk.start,chunk.end,chunk.text,chunk.textHash,row.doc_hash,row.source_revision,chunk.tokenBound));
      this.db.prepare('INSERT OR REPLACE INTO embedding_chunk_sources(namespace,model_key,turn_id,source_hash,source_revision,chunk_count) VALUES(?,?,?,?,?,?)')
        .run(this.namespace,modelKey,turnId,row.doc_hash,row.source_revision,chunks.length);
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  pendingWindows(modelKey, { scope, asOf = Number.MAX_SAFE_INTEGER, limit = 200 } = {}) {
    const rows = this.db.prepare(`
      SELECT t.namespace,t.turn_id,t.scope,t.session_id,t.turn,t.completed_at,t.doc_hash,t.source_revision,w.window_id,w.text,w.text_hash,
        sv.revision AS scope_view_revision
      FROM turns t JOIN embedding_chunks w ON t.namespace=w.namespace AND t.turn_id=w.turn_id
      JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id
      LEFT JOIN vectors v ON v.namespace=t.namespace AND v.model_key=w.model_key
        AND v.turn_id=t.turn_id AND v.window_id=w.window_id AND v.text_hash=w.text_hash
      ${scopeViewJoin}
      WHERE w.model_key=? AND w.source_hash=t.doc_hash AND w.source_revision=t.source_revision
        AND t.namespace=? AND t.scope=? AND t.completed_at<=? AND v.turn_id IS NULL
        AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL
      ORDER BY t.completed_at ASC, w.ordinal ASC LIMIT ?
    `).all(modelKey, this.namespace, scope, asOf, Math.max(1, Number(limit) || 200));
    return rows.map((row) => ({
      turnId: row.turn_id,
      sourceVersion: readVersion(row),
      scope: row.scope,
      completedAt: Number(row.completed_at),
      windowId: row.window_id,
      text: row.text,
      textHash: row.text_hash,
    }));
  }

  putVectors(modelKey, entries) {
    if (!entries?.length) return 0;
    const model = this.db.prepare('SELECT dimensions FROM embedding_models WHERE namespace=? AND model_key=?').get(this.namespace,modelKey);
    const statement = this.db.prepare(
      'INSERT OR REPLACE INTO vectors(namespace, model_key, turn_id, window_id, text_hash, dim, vector) VALUES(?,?,?,?,?,?,?)',
    );
    this.db.exec('BEGIN IMMEDIATE');
    let inserted = 0;
    try {
      for (const entry of entries) {
        const turnId=canonicalTurnId(entry.turnId);
        if(!entry.vector?.length||Array.from(entry.vector).some(n=>!Number.isFinite(n)))throw new Error('invalid embedding vector');
        if(model&&entry.vector.length!==model.dimensions)throw new Error('embedding does not match registered model dimensions');
        if(entry.sourceVersion){
          const row=this.db.prepare(`SELECT t.*,sv.revision AS scope_view_revision FROM turns t JOIN embedding_chunks w ON w.namespace=t.namespace AND w.turn_id=t.turn_id
            JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id ${scopeViewJoin}
            WHERE t.namespace=? AND w.model_key=? AND t.turn_id=? AND w.window_id=? AND w.text_hash=?
              AND w.source_hash=t.doc_hash AND w.source_revision=t.source_revision
              AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL`).get(this.namespace,modelKey,turnId,entry.windowId,entry.textHash);
          if(!row||!sameSourceVersion(readVersion(row),entry.sourceVersion))continue;
        }
        const vector = Float32Array.from(entry.vector);
        statement.run(entry.namespace || this.namespace, modelKey, turnId, entry.windowId,
          entry.textHash, vector.length, Buffer.from(vector.buffer));
        inserted += 1;
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return inserted;
  }

  registerModel(identity) {
    if (!identity?.modelKey || !Number.isInteger(identity.dimensions) || identity.dimensions<=0 || !identity.descriptor) throw new Error('Invalid embedding model identity');
    const body=JSON.stringify(identity.descriptor);
    const old=this.db.prepare('SELECT descriptor_json FROM embedding_models WHERE namespace=? AND model_key=?').get(this.namespace,identity.modelKey);
    if(old&&old.descriptor_json!==body)throw new Error('Embedding model identity conflict');
    this.db.prepare('INSERT OR IGNORE INTO embedding_models(namespace,model_key,dimensions,descriptor_json,created_at) VALUES(?,?,?,?,?)')
      .run(this.namespace,identity.modelKey,identity.dimensions,body,Date.now());
  }

  recordEmbeddingUsage(receipt) {
    if (!receipt.scope) return;
    this.db.prepare('INSERT INTO embedding_usage(namespace,scope,model_key,at,receipt_json) VALUES(?,?,?,?,?)')
      .run(this.namespace,receipt.scope,receipt.modelKey||null,receipt.at,JSON.stringify(receipt));
  }

  embeddingUsageSummary(scope) {
    return this.db.prepare(`SELECT COUNT(*) calls,COALESCE(SUM(json_extract(receipt_json,'$.tokens')),0) reportedTokens,
      COALESCE(SUM(CASE WHEN json_extract(receipt_json,'$.tokens') IS NULL THEN 1 ELSE 0 END),0) unknownUsageCalls
      FROM embedding_usage WHERE namespace=? AND scope=?`).get(this.namespace,scope);
  }

  refreshControl(scope,turnId) {
    turnId=canonicalTurnId(turnId);
    const row=this.db.prepare(`
      SELECT COALESCE(MIN(c.weight),1) weight,COALESCE(MAX(c.excluded),0) excluded
      FROM raw_controls c JOIN turns t ON t.namespace=c.namespace AND t.scope=c.scope
      WHERE t.namespace=? AND t.scope=? AND t.turn_id=? AND (
        (c.target_type='session' AND c.target_id=t.session_id) OR
        (c.target_type='turn' AND c.target_id=t.turn_id) OR
        (c.target_type='message' AND EXISTS(SELECT 1 FROM turn_messages m
          WHERE m.namespace=t.namespace AND m.turn_id=t.turn_id AND m.message_id=c.target_id)))
    `).get(this.namespace,scope,turnId);
    this.db.prepare('UPDATE turn_visibility SET weight=?,excluded=? WHERE namespace=? AND turn_id=?')
      .run(row.weight,row.excluded,this.namespace,turnId);
  }

  setControl({scope,targetType,targetId,weight=1,excluded=false,reason='',origin='operator'}) {
    if(!scope||!targetId||!['session','turn','message'].includes(targetType)||!Number.isFinite(weight)||weight<0||weight>1)throw new Error('invalid raw memory control');
    if(targetType==='turn')targetId=canonicalTurnId(targetId);
    if(targetType==='turn'){
      const row=this.db.prepare('SELECT scope FROM turns WHERE namespace=? AND turn_id=?').get(this.namespace,targetId);
      if(row&&row.scope!==scope)throw new Error('raw memory control scope mismatch');
    }
    if(targetType==='message'){
      const row=this.db.prepare('SELECT t.scope FROM turn_messages m JOIN turns t ON t.namespace=m.namespace AND t.turn_id=m.turn_id WHERE m.namespace=? AND m.message_id=?').get(this.namespace,targetId);
      if(row&&row.scope!==scope)throw new Error('raw memory control scope mismatch');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.db.prepare('SELECT COALESCE(MAX(updated_at),0) stamp FROM raw_controls WHERE namespace=? AND scope=?').get(this.namespace,scope).stamp;
      this.db.prepare(`INSERT INTO raw_controls(namespace,scope,target_type,target_id,origin,weight,excluded,reason,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(namespace,scope,target_type,target_id,origin) DO UPDATE SET
        weight=excluded.weight,excluded=excluded.excluded,reason=excluded.reason,updated_at=excluded.updated_at
        WHERE raw_controls.weight<>excluded.weight OR raw_controls.excluded<>excluded.excluded OR raw_controls.reason<>excluded.reason`)
        .run(this.namespace,scope,targetType,targetId,origin,weight,excluded?1:0,String(reason),Math.max(Date.now(),previous+1));
      const affected=this.db.prepare(`SELECT t.turn_id FROM turns t WHERE t.namespace=? AND t.scope=? AND (
        (?='session' AND t.session_id=?) OR (?='turn' AND t.turn_id=?) OR
        (?='message' AND EXISTS(SELECT 1 FROM turn_messages m WHERE m.namespace=t.namespace AND m.turn_id=t.turn_id AND m.message_id=?)))`)
        .all(this.namespace,scope,targetType,targetId,targetType,targetId,targetType,targetId);
      for(const row of affected)this.refreshControl(scope,row.turn_id);
      this.db.exec('COMMIT');return {affected:affected.length,weight,excluded};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  getControl({scope,targetType,targetId,origin='operator'}) {
    if(targetType==='turn')targetId=canonicalTurnId(targetId);
    return this.db.prepare('SELECT weight,excluded FROM raw_controls WHERE namespace=? AND scope=? AND target_type=? AND target_id=? AND origin=?')
      .get(this.namespace,scope,targetType,targetId,origin)||{weight:1,excluded:0};
  }

  maintenanceRevision(scope) { return rawMaintenanceRevision(this.db,scope,this.namespace); }

  /** Remove one archived turn and every projection derived from it: windows, vectors,
   * chunks, visibility and its full-text row. Used when a message is withdrawn. */
  removeTurn(scope,turnId){
    turnId=canonicalTurnId(turnId);
    const turn=this.db.prepare('SELECT rowid FROM turns WHERE namespace=? AND turn_id=? AND scope=?').get(this.namespace,turnId,scope);
    if(!turn)return false;
    this.db.exec('BEGIN IMMEDIATE');
    try{
      for(const table of ['turn_messages','windows','vectors','embedding_chunks','embedding_chunk_sources','turn_visibility'])
        this.db.prepare(`DELETE FROM ${table} WHERE namespace=? AND turn_id=?`).run(this.namespace,turnId);
      if(this.textSearchAvailable)this.db.prepare('DELETE FROM raw_text_index WHERE rowid=?').run(turn.rowid);
      this.db.prepare('DELETE FROM turns WHERE namespace=? AND turn_id=?').run(this.namespace,turnId);
      this.db.exec('COMMIT');return true;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  messageTurn(scope,messageId){
    return this.db.prepare(`SELECT t.turn_id,t.session_id,t.turn FROM turn_messages m JOIN turns t
      ON t.namespace=m.namespace AND t.turn_id=m.turn_id WHERE m.namespace=? AND m.message_id=? AND t.scope=?`)
      .get(this.namespace,messageId,scope)||null;
  }
  messageVisibility(scope,sessionId,messageId){
    const link=this.messageTurn(scope,messageId);
    const row=link?this.db.prepare('SELECT weight,excluded,source_hidden FROM turn_visibility WHERE namespace=? AND turn_id=?').get(this.namespace,link.turn_id):null;
    const control=this.db.prepare(`SELECT COALESCE(MAX(excluded),0) excluded,COALESCE(MIN(weight),1) weight FROM raw_controls
      WHERE namespace=? AND scope=? AND ((target_type='session' AND target_id=?) OR (target_type='message' AND target_id=?) OR (target_type='turn' AND target_id=?))`)
      .get(this.namespace,scope,sessionId,messageId,link?.turn_id??'');
    return {eligible:!control.excluded&&control.weight>0&&!row?.excluded&&!row?.source_hidden&&(row?.weight??1)>0,weight:Number(row?.weight??control.weight)};
  }
  recentTurns(scope,{limit=40,since=0,until=Number.MAX_SAFE_INTEGER}={}){
    if (!scope || !Number.isFinite(since) || !Number.isFinite(until) || since > until) return [];
    const rows=this.db.prepare(`SELECT t.*,v.weight,${scopeViewColumns} FROM turns t
      JOIN turn_visibility v ON v.namespace=t.namespace AND v.turn_id=t.turn_id ${scopeViewJoin}
      WHERE t.namespace=? AND t.scope=? AND t.completed_at>=? AND t.completed_at<=? AND v.excluded=0 AND v.source_hidden=0 AND v.weight>0
      ORDER BY t.completed_at DESC,t.turn_id`).iterate(this.namespace,scope,since,until);
    const turns=[], capacity=Math.min(100,Math.max(1,Number(limit)||40));
    for (const row of rows) {
      const turn=readableTurn(row);
      if (turn) turns.push(turn);
      if (turns.length>=capacity) break;
    }
    return turns;
  }

  sourceState(ref, scope) {
    if (!scope || (ref.scope && ref.scope !== scope)) return { state: 'blocked', reason: 'scope-changed' };
    const expectedVersion = ref.sourceVersion ?? ref.turnRevision;
    const requestedTurnId = canonicalTurnId(ref.turnId);
    let row = ref.messageId ? this.db.prepare(`SELECT t.*,v.excluded,v.source_hidden,v.weight,${scopeViewColumns} FROM turn_messages m
      JOIN turns t ON t.namespace=m.namespace AND t.turn_id=m.turn_id
      JOIN turn_visibility v ON v.namespace=t.namespace AND v.turn_id=t.turn_id ${scopeViewJoin}
      WHERE m.namespace=? AND m.message_id=? AND t.scope=?`).get(this.namespace,ref.messageId,scope) : null;
    if (!row && requestedTurnId) row = this.db.prepare(`SELECT t.*,v.excluded,v.source_hidden,v.weight,${scopeViewColumns} FROM turns t
      JOIN turn_visibility v ON v.namespace=t.namespace AND v.turn_id=t.turn_id ${scopeViewJoin}
      WHERE t.namespace=? AND t.turn_id=? AND t.scope=?`).get(this.namespace,requestedTurnId,scope);
    const sessionId = ref.sessionId || row?.session_id || '';
    const turnId = requestedTurnId || row?.turn_id || (sessionId && ref.turn != null ? rawTurnId(scope,sessionId,ref.turn) : '');
    const controls = this.db.prepare(`SELECT COALESCE(MAX(excluded),0) excluded,COALESCE(MIN(weight),1) weight FROM raw_controls
      WHERE namespace=? AND scope=? AND ((target_type='session' AND target_id=?) OR
        (target_type='turn' AND target_id=?) OR (target_type='message' AND target_id=?))`)
      .get(this.namespace,scope,sessionId,turnId,ref.messageId || '');
    if (controls.excluded || controls.weight<=0 || row?.excluded || row?.source_hidden || (row && row.weight<=0)) {
      return { state: 'blocked', reason: 'source-excluded' };
    }
    if (!row) return { state: expectedVersion ? 'blocked' : 'unknown', reason: 'source-not-archived' };
    if ((requestedTurnId && row.turn_id!==requestedTurnId) || (ref.sessionId && row.session_id!==ref.sessionId) || (ref.turn!=null && Number(row.turn)!==Number(ref.turn))) {
      return { state: 'blocked', reason: 'source-identity-changed' };
    }
    const message = JSON.parse(row.messages_json).find(item=>item.id===ref.messageId && item.role==='user');
    if (!message) return { state: 'blocked', reason: 'user-source-missing' };
    const version = sourceVersion(row), textHash = sha256(message.text);
    if ((expectedVersion && !sameSourceVersion(expectedVersion,version)) || (ref.textHash && ref.textHash!==textHash)) {
      return { state: 'stale', reason: 'source-changed' };
    }
    const visible = row.ranges_json == null ? message : readableMessages(row).find(item=>item.id===message.id);
    if (!visible) return {state:'blocked', reason:'source-outside-scope-view'};
    if (visible.fragment && typeof ref.evidence === 'string' && ref.evidence.trim() && message.text.includes(ref.evidence)
      && !visible.fragment.ranges.some(({start,end})=>message.text.slice(start,end).includes(ref.evidence))) {
      return {state:'blocked', reason:'evidence-outside-scope-view'};
    }
    return { state: 'live', weight: Number(row.weight), text: visible.text,
      ...(visible.fragment ? {fragment:visible.fragment} : {}), ref: {
      scope, turnId: row.turn_id, sessionId: row.session_id, turn: Number(row.turn),
      messageId: message.id, sourceVersion: version, textHash,
    } };
  }

  *windowPages(modelKey,{scope,asOf=Number.MAX_SAFE_INTEGER,pageSize=256,includeText=false}={}) {
    const size=Math.max(1,Math.min(1024,Number(pageSize)||256));
    let after=0;
    // rowid is a keyset cursor, never a time cut: the oldest rows remain eligible.
    const query=this.db.prepare(`SELECT v.rowid cursor,t.namespace,t.scope,t.turn_id,t.session_id,t.turn,t.completed_at,t.doc_hash,t.source_revision,vis.weight,
      w.window_id,w.start_offset,w.end_offset,v.vector,v.dim,${includeText?'w.text':'NULL'} AS text,sv.revision AS scope_view_revision
      FROM vectors v JOIN turns t ON t.namespace=v.namespace AND t.turn_id=v.turn_id
      JOIN embedding_chunks w ON w.namespace=v.namespace AND w.model_key=v.model_key AND w.turn_id=v.turn_id AND w.window_id=v.window_id AND w.text_hash=v.text_hash
      JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id ${scopeViewJoin}
      WHERE v.namespace=? AND v.model_key=? AND t.scope=? AND t.completed_at<=?
        AND w.source_hash=t.doc_hash AND w.source_revision=t.source_revision
        AND v.rowid>? AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL
      ORDER BY v.rowid LIMIT ?`);
    while(true){
      const rows=query.all(this.namespace,modelKey,scope,asOf,after,size);
      if(!rows.length)return;
      after=Number(rows.at(-1).cursor);
      yield rows.map(r=>({...r,turnId:r.turn_id,sourceVersion:readVersion(r),completedAt:Number(r.completed_at),vector:new Float32Array(Uint8Array.from(r.vector).buffer)}));
    }
  }

  loadTurns(refs,{scope,asOf=Number.MAX_SAFE_INTEGER,since=0,sessionId='',messageId=''}={}) {
    if (!scope || !Number.isFinite(asOf) || !Number.isFinite(since) || since > asOf) return [];
    const query=this.db.prepare(`SELECT t.*,vis.weight,${scopeViewColumns} FROM turns t
      JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id ${scopeViewJoin}
      WHERE t.namespace=? AND t.scope=? AND t.turn_id=? AND t.completed_at>=? AND t.completed_at<=?
        AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0`);
    return refs.flatMap(ref=>{
      // String ids remain supported for source readers; ranked retrieval passes
      // a versioned reference so an old hit can never acquire a new body.
      const id=typeof ref==='string'?ref:ref?.turnId;
      if (!id) return [];
      const r=query.get(this.namespace,scope,canonicalTurnId(id),since,asOf);
      if (!r || (sessionId && r.session_id!==sessionId)) return [];
      if (typeof ref==='object' && !sameSourceVersion(ref.sourceVersion,readVersion(r))) return [];
      const turn=readableTurn(r,messageId);
      return turn ? [turn] : [];
    });
  }

  embeddingLegacySlots(scope,sessionId,turn) {
    // Keep unreviewed and hidden positions here so a readable suffix cannot
    // jump across them. New per-message projections are never legacy sources.
    return this.db.prepare(`SELECT t.namespace,t.scope,t.turn_id,t.session_id,t.turn,t.completed_at,
      t.doc_hash,t.source_revision,sv.revision AS scope_view_revision,
      json_extract(m.value,'$.id') messageId,json_extract(m.value,'$.seq') sequence
      FROM turns t ${scopeViewJoin} CROSS JOIN json_each(t.messages_json) m
      WHERE t.namespace=? AND t.scope=? AND t.session_id=? AND t.turn=? AND t.turn_id NOT GLOB 'message:*'`)
      .all(this.namespace,scope,sessionId,turn)
      .map(row=>({turnId:row.turn_id,messageId:row.messageId,sequence:row.sequence,revision:readVersion(row)}));
  }

  searchText(query, { scope, asOf = Number.MAX_SAFE_INTEGER, since = 0, messageId = '', sessionId = '', limit = 40 } = {}) {
    if (!scope || !Number.isFinite(asOf) || !Number.isFinite(since) || since > asOf) return [];
    const parsed = textQuery(query);
    if (!parsed && !messageId) return [];
    const capacity = Math.max(1, Math.min(40, Number(limit) || 40));
    const params = [this.namespace, scope, since, asOf];
    let filters = '';
    if (messageId) {
      filters += ' AND EXISTS(SELECT 1 FROM turn_messages m WHERE m.namespace=t.namespace AND m.turn_id=t.turn_id AND m.message_id=?)';
      params.push(String(messageId));
    }
    if (sessionId) { filters += ' AND t.session_id=?'; params.push(String(sessionId)); }
    const visible = `t.namespace=? AND t.scope=? AND t.completed_at>=? AND t.completed_at<=?
      AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0${filters}`;
    const visibilityJoin = `JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id ${scopeViewJoin}`;
    const hit = (row, score) => ({turnId:row.turn_id, sourceVersion:readVersion(row), completedAt:Number(row.completed_at),
      score:row.weight, lexicalScore:score*row.weight, weight:row.weight, routes:['text']});
    const hits = [];
    const useFts = parsed && this.textSearchAvailable;
    if (useFts || messageId) {
      const match = useFts ? 'raw_text_index MATCH ? AND raw_text_index.source_hash=t.doc_hash AND ' : '';
      const from = useFts ? 'raw_text_index JOIN turns t ON t.rowid=raw_text_index.rowid' : 'turns t';
      const rank = useFts ? 'raw_text_index.rank' : '-1';
      const rows = this.db.prepare(`SELECT t.namespace,t.scope,t.turn_id,t.session_id,t.turn,t.completed_at,t.doc_hash,t.source_revision,
        vis.weight,sv.revision AS scope_view_revision,${rank} lexical_rank
        FROM ${from} ${visibilityJoin} WHERE ${match}${visible} AND sv.ranges_json IS NULL
        ORDER BY lexical_rank,t.completed_at DESC,t.turn_id LIMIT ?`).all(...(useFts ? [parsed.match] : []),...params,capacity*8);
      hits.push(...rows.map(row=>hit(row,Math.max(0,-row.lexical_rank))));
    }
    // Full-turn FTS cannot rank a reviewed turn. Match each visible span
    // separately so hidden terms and joins across cuts never qualify it.
    const reviewed = this.db.prepare(`SELECT t.*,vis.weight,${scopeViewColumns} FROM turns t ${visibilityJoin}
      WHERE ${visible} AND sv.ranges_json IS NOT NULL`).iterate(...params);
    for (const row of reviewed) {
      const messages = readableMessages(row).filter(message=>!messageId || message.id===messageId);
      const score = messages.reduce((best,message)=>Math.max(best,parsed ? legacyMessageMatch(query,message) : 1),0);
      if (score>0) hits.push(hit(row,score));
    }
    return hits
      .sort((a, b) => b.lexicalScore - a.lexicalScore || b.completedAt - a.completedAt || a.turnId.localeCompare(b.turnId))
      .slice(0, capacity);
  }

  hasVectors(modelKey, { scope, asOf = Number.MAX_SAFE_INTEGER } = {}) {
    return Boolean(this.db.prepare(`SELECT 1 FROM vectors v JOIN turns t ON t.namespace=v.namespace AND t.turn_id=v.turn_id
      JOIN embedding_chunks w ON w.namespace=v.namespace AND w.model_key=v.model_key AND w.turn_id=v.turn_id AND w.window_id=v.window_id AND w.text_hash=v.text_hash
      JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id ${scopeViewJoin}
      WHERE v.namespace=? AND v.model_key=? AND t.scope=? AND t.completed_at<=?
        AND w.source_hash=t.doc_hash AND w.source_revision=t.source_revision
        AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL LIMIT 1`).get(this.namespace, modelKey, scope, asOf));
  }

  progress(scope,sourceId) {
    return this.db.prepare('SELECT * FROM import_progress WHERE scope=? AND source_id=?').get(scope,sourceId)||null;
  }

  storedTurn(scope,turnId) {
    turnId=canonicalTurnId(turnId);
    const r=this.db.prepare('SELECT messages_json FROM turns WHERE namespace=? AND scope=? AND turn_id=?').get(this.namespace,scope,turnId);
    return r?JSON.parse(r.messages_json):null;
  }

  beginImport(scope,sourceId,fingerprint) {
    const previous=this.progress(scope,sourceId);
    if(previous&&previous.fingerprint!==fingerprint){
      this.db.prepare(`UPDATE turn_visibility SET source_hidden=1 WHERE namespace=? AND turn_id IN
        (SELECT turn_id FROM import_members WHERE scope=? AND source_id=?)`).run(this.namespace,scope,sourceId);
    }
    return previous;
  }

  saveProgress({scope,sourceId,fingerprint,position,completed=false,turnId}) {
    turnId=canonicalTurnId(turnId);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      if(turnId)this.db.prepare('INSERT OR REPLACE INTO import_members(scope,source_id,turn_id,fingerprint) VALUES(?,?,?,?)').run(scope,sourceId,turnId,fingerprint);
      this.db.prepare(`INSERT INTO import_progress(scope,source_id,fingerprint,position,completed,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(scope,source_id) DO UPDATE SET fingerprint=excluded.fingerprint,position=excluded.position,completed=excluded.completed,updated_at=excluded.updated_at`)
        .run(scope,sourceId,fingerprint,position,completed?1:0,Date.now());
      if(completed){
        this.db.prepare(`UPDATE turn_visibility SET source_hidden=1 WHERE namespace=? AND turn_id IN
          (SELECT turn_id FROM import_members WHERE scope=? AND source_id=? AND fingerprint<>?)`)
          .run(this.namespace,scope,sourceId,fingerprint);
      }
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }

  markImportedVisible(scope,turnId) {
    turnId=canonicalTurnId(turnId);
    const row=this.db.prepare('SELECT scope FROM turns WHERE namespace=? AND turn_id=?').get(this.namespace,turnId);
    if(!row||row.scope!==scope)throw new Error('imported turn scope mismatch');
    this.db.prepare('UPDATE turn_visibility SET source_hidden=0 WHERE namespace=? AND turn_id=?').run(this.namespace,turnId);
  }

  authorizedTurns(modelKey, { scope, asOf = Number.MAX_SAFE_INTEGER, limit = 2000 } = {}) {
    // Compatibility surface only. It delegates authorization/version checks to
    // the same paging and final-read implementation as production retrieval.
    const groups=new Map(),capacity=Math.max(1,Number(limit) || 2000);let count=0;
    outer:for(const page of this.windowPages(modelKey,{scope,asOf,includeText:true}))for(const row of page){
      const key=JSON.stringify([row.turnId,row.sourceVersion]);
      let group=groups.get(key);if(!group){group={turnId:row.turnId,sourceVersion:row.sourceVersion,windows:[]};groups.set(key,group);}
      group.windows.push({windowId:row.window_id,text:row.text,vector:row.vector});
      if(++count>=capacity)break outer;
    }
    return this.loadTurns([...groups.values()],{scope,asOf}).map(turn=>({...turn,
      windows:groups.get(JSON.stringify([turn.turnId,turn.sourceVersion])).windows}))
      .sort((a,b)=>b.completedAt-a.completedAt || a.turnId.localeCompare(b.turnId));
  }

  stats(modelKey, scope) {
    const turnCount = this.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE namespace=? AND scope=?')
      .get(this.namespace, scope)?.n ?? 0;
    const windowCount = this.db.prepare(`
      SELECT COUNT(*) AS n FROM windows w JOIN turns t
        ON t.namespace=w.namespace AND t.turn_id=w.turn_id
      WHERE t.namespace=? AND t.scope=?
    `).get(this.namespace, scope)?.n ?? 0;
    const vectorCount = this.db.prepare(`
      SELECT COUNT(*) AS n FROM vectors v JOIN turns t
        ON t.namespace=v.namespace AND t.turn_id=v.turn_id
      WHERE t.namespace=? AND t.scope=? AND v.model_key=?
    `).get(this.namespace, scope, modelKey)?.n ?? 0;
    const progress=this.db.prepare(`SELECT COUNT(*) eligible,COALESCE(SUM(CASE WHEN v.window_id IS NOT NULL THEN 1 ELSE 0 END),0) indexed_count
      FROM embedding_chunks w JOIN turns t ON t.namespace=w.namespace AND t.turn_id=w.turn_id
      JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id
      LEFT JOIN vectors v ON v.namespace=w.namespace AND v.turn_id=w.turn_id AND v.window_id=w.window_id AND v.text_hash=w.text_hash AND v.model_key=w.model_key
      ${scopeViewJoin}
      WHERE w.model_key=? AND w.source_hash=t.doc_hash AND w.source_revision=t.source_revision
        AND t.namespace=? AND t.scope=? AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL`).get(modelKey,this.namespace,scope);
    const unplanned=this.db.prepare(`SELECT COUNT(*) n FROM turns t JOIN turn_visibility vis ON vis.namespace=t.namespace AND vis.turn_id=t.turn_id
      LEFT JOIN embedding_chunk_sources c ON c.namespace=t.namespace AND c.turn_id=t.turn_id AND c.model_key=?
      ${scopeViewJoin}
      WHERE t.namespace=? AND t.scope=? AND vis.excluded=0 AND vis.source_hidden=0 AND vis.weight>0 AND sv.ranges_json IS NULL
        AND(c.turn_id IS NULL OR c.source_hash<>t.doc_hash OR c.source_revision<>t.source_revision)`).get(modelKey,this.namespace,scope);
    return { turns: Number(turnCount), windows: Number(windowCount), vectors: Number(vectorCount),
      eligibleWindows:Number(progress.eligible), indexedWindows:Number(progress.indexed_count), pendingWindows:Number(progress.eligible)-Number(progress.indexed_count),pendingSources:Number(unplanned.n) };
  }
}

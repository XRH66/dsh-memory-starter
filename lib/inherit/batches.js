import {randomUUID} from 'node:crypto';

const now = () => Date.now();

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

export function ensureInheritSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inherit_batches (
      namespace TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      source_json TEXT NOT NULL,
      total INTEGER NOT NULL,
      inserted INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      conflicts INTEGER NOT NULL DEFAULT 0,
      undone INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(namespace,batch_id)
    );
    CREATE TABLE IF NOT EXISTS inherit_members (
      namespace TEXT NOT NULL,
      source_key TEXT NOT NULL,
      text_hash TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY(namespace,source_key)
    );
    CREATE INDEX IF NOT EXISTS inherit_members_batch
      ON inherit_members(namespace,batch_id,state);
  `);
}

export function newInheritBatchId(clock = now) {
  const stamp = new Date(clock()).toISOString().replace(/[-:.TZ]/g,'');
  return `inherit-${stamp}-${randomUUID().slice(0,8)}`;
}

export function createInheritBatch(db,{source,scope='',batchId=newInheritBatchId(),total=0,clock=now}={}) {
  ensureInheritSchema(db);
  const createdAt = clock();
  db.prepare(`INSERT INTO inherit_batches(
    namespace,batch_id,created_at,source_json,total,inserted,skipped,conflicts,undone,updated_at
  ) VALUES('default',?,?,?,?,0,0,0,0,?)`)
    .run(batchId,createdAt,JSON.stringify({scope,...source}),total,createdAt);
  return {batchId,createdAt};
}

export function finishInheritBatch(db,batchId,{inserted=0,skipped=0,conflicts=0,clock=now}={}) {
  db.prepare(`UPDATE inherit_batches SET inserted=?,skipped=?,conflicts=?,updated_at=?
    WHERE namespace='default' AND batch_id=?`).run(inserted,skipped,conflicts,clock(),batchId);
}

export function addInheritMember(db,{
  sourceKey,textHash,batchId,turnId,state='active',clock=now,
}) {
  db.prepare(`INSERT INTO inherit_members(
    namespace,source_key,text_hash,batch_id,turn_id,state,created_at
  ) VALUES('default',?,?,?,?,?,?)
  ON CONFLICT(namespace,source_key) DO UPDATE SET
    text_hash=excluded.text_hash,batch_id=excluded.batch_id,turn_id=excluded.turn_id,state=excluded.state`)
    .run(sourceKey,textHash,batchId,turnId,state,clock());
}

function parseSource(row) {
  try {
    const source = JSON.parse(row.source_json);
    return source && typeof source === 'object' ? source : {};
  } catch {
    return {};
  }
}

export function listInheritBatches(db) {
  if (!tableExists(db,'inherit_batches')) return [];
  return db.prepare(`SELECT batch_id,created_at,source_json,total,inserted,skipped,conflicts,undone,updated_at
    FROM inherit_batches WHERE namespace='default' ORDER BY created_at DESC,batch_id DESC`).all().map(row=>({
    batchId:row.batch_id,
    createdAt:new Date(Number(row.created_at)).toISOString(),
    updatedAt:new Date(Number(row.updated_at)).toISOString(),
    source:parseSource(row),
    total:Number(row.total),
    inserted:Number(row.inserted),
    skipped:Number(row.skipped),
    conflicts:Number(row.conflicts),
    state:row.undone?'undone':'active',
  }));
}

function batch(db,batchId) {
  if (!tableExists(db,'inherit_batches')) return null;
  const row=db.prepare(`SELECT * FROM inherit_batches WHERE namespace='default' AND batch_id=?`).get(batchId);
  return row ? {
    ...row,
    source:parseSource(row),
    state:row.undone?'undone':'active',
  } : null;
}

function members(db,batchId) {
  if (!tableExists(db,'inherit_members')) return [];
  return db.prepare(`SELECT source_key,text_hash,turn_id,state FROM inherit_members
    WHERE namespace='default' AND batch_id=? ORDER BY turn_id,source_key`).all(batchId);
}

export function setInheritBatchState(store,batchId,state,{reason=''}={}) {
  if (!['active','undone'].includes(state)) throw Error('继承批次状态无效');
  ensureInheritSchema(store.db);
  const target=batch(store.db,batchId);
  if (!target) throw Error('找不到继承批次：' + batchId);
  const scope=String(target.source.scope||'');
  if (!scope) throw Error('继承批次缺少作用域');
  const rows=members(store.db,batchId);
  let changed=0, missing=0;
  for (const row of rows) {
    if (!store.storedTurn(scope,row.turn_id)) { missing += 1; continue; }
    const result=store.setControl({
      scope,targetType:'turn',targetId:row.turn_id,
      excluded:state==='undone',weight:1,
      origin:'inherit:'+batchId,
      reason:reason || (state==='undone'?'inherited memory batch undone':'inherited memory batch restored'),
    });
    if (result.affected) changed += result.affected;
  }
  store.db.prepare(`UPDATE inherit_batches SET undone=?,updated_at=?
    WHERE namespace='default' AND batch_id=?`).run(state==='undone'?1:0,now(),batchId);
  store.db.prepare(`UPDATE inherit_members SET state=? WHERE namespace='default' AND batch_id=?`).run(state,batchId);
  return {batchId,state,members:rows.length,changed,missing};
}

export function undoInheritBatch(store,batchId) {
  return setInheritBatchState(store,batchId,'undone');
}

export function restoreInheritBatch(store,batchId) {
  return setInheritBatchState(store,batchId,'active');
}

export function inheritMemberRecords(db) {
  if (!tableExists(db,'inherit_members')) return [];
  const batches=tableExists(db,'inherit_batches')
    ? new Map(db.prepare(`SELECT batch_id,undone FROM inherit_batches WHERE namespace='default'`).all()
      .map(row=>[row.batch_id,Boolean(row.undone)]))
    : new Map();
  return db.prepare(`SELECT source_key,text_hash,batch_id,turn_id,state FROM inherit_members
    WHERE namespace='default'`).all().map(row=>({
    sourceKey:row.source_key,
    textHash:row.text_hash,
    batchId:row.batch_id,
    turnId:row.turn_id,
    state:batches.get(row.batch_id)?'undone':row.state,
  }));
}

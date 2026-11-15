import {buildTurn,sha256} from '../raw-rag/store.js';
import {
  addInheritMember,
  createInheritBatch,
  ensureInheritSchema,
  finishInheritBatch,
  inheritMemberRecords,
  newInheritBatchId,
} from './batches.js';
import {inheritRecordIdentity,inheritTimeMs} from './format.js';

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function batchStates(db) {
  if (!tableExists(db,'inherit_batches')) return new Map();
  return new Map(db.prepare(`SELECT batch_id,undone FROM inherit_batches WHERE namespace='default'`).all()
    .map(row=>[row.batch_id,Boolean(row.undone)]));
}

function existingImported(db,scope) {
  const output=new Map(),batches=batchStates(db);
  for (const row of inheritMemberRecords(db)) {
    output.set(row.sourceKey,{
      sourceKey:row.sourceKey,
      textHash:row.textHash,
      batchId:row.batchId,
      state:batches.get(row.batchId)?'undone':row.state,
    });
  }
  if (!tableExists(db,'turns')) return output;
  for (const row of db.prepare('SELECT turn_id,messages_json FROM turns WHERE namespace=\'default\' AND scope=?').iterate(scope)) {
    let messages;
    try { messages=JSON.parse(row.messages_json); }
    catch { continue; }
    for (const message of Array.isArray(messages)?messages:[]) {
      const imported=message?.import;
      if (!imported?.sourceKey || output.has(imported.sourceKey)) continue;
      output.set(imported.sourceKey,{
        sourceKey:imported.sourceKey,
        textHash:imported.textHash,
        batchId:imported.batchId,
        turnId:row.turn_id,
        state:batches.get(imported.batchId)?'undone':'active',
      });
    }
  }
  return output;
}

export function compareInheritRecords(db,scope,records) {
  const existing=existingImported(db,scope),local=new Map();
  const decisions=[];
  let inserted=0,skipped=0,conflicts=0,undone=0;
  for (const record of records) {
    const identity=inheritRecordIdentity(record);
    const earlier=local.get(identity.sourceKey),current=existing.get(identity.sourceKey);
    if (earlier) {
      if (earlier.textHash===identity.textHash) {
        decisions.push({record,identity,status:'skipped',reason:'duplicate-in-file'});
        skipped += 1;
      } else {
        decisions.push({record,identity,status:'conflict',reason:'duplicate-id-different-text-in-file'});
        conflicts += 1;
      }
      continue;
    }
    local.set(identity.sourceKey,identity);
    if (current) {
      if (current.textHash!==identity.textHash) {
        decisions.push({record,identity,status:'conflict',reason:'same-id-different-text'});
        conflicts += 1;
      } else if (current.state==='undone') {
        decisions.push({record,identity,status:'undone',reason:'already-imported-but-undone',batchId:current.batchId});
        undone += 1;
      } else {
        decisions.push({record,identity,status:'skipped',reason:'already-imported',batchId:current.batchId});
        skipped += 1;
      }
      continue;
    }
    decisions.push({record,identity,status:'new'});
    inserted += 1;
  }
  return {inserted,skipped,conflicts,undone,decisions};
}

function importedMessage(record,identity,batchId) {
  const importInfo={
    batchId,
    sourceKey:identity.sourceKey,
    textHash:identity.textHash,
    ...(record.id===undefined?{}:{id:record.id}),
    system:record.source.system,
    kind:record.kind,
    file:record.source.file,
    ...(record.source.locator===undefined?{}:{locator:record.source.locator}),
    ...(record.time===undefined?{}:{timeText:record.time}),
    ...(record.part===undefined?{}:{part:record.part}),
  };
  const timestamp=inheritTimeMs(record.time) ?? 0;
  return {
    id:'inherit:'+identity.sourceKey,
    role:record.speaker,
    speaker:record.speaker,
    text:record.text,
    ts:timestamp,
    seq:1,
    import:importInfo,
  };
}

function importedTurn(record,identity,batchId,scope,ordinal) {
  const message=importedMessage(record,identity,batchId);
  const sessionId='inherit-'+sha256(record.source.system).slice(0,20);
  return buildTurn({
    namespace:'default',
    scope,
    sessionId,
    turn:ordinal,
    turnId:'inherit:'+identity.sourceKey,
    completedAt:message.ts,
    messages:[message],
  });
}

export function applyInheritRecords(input) {
  let {store,scope,records,batchId,source,clock=Date.now}=input??{};
  if (!store?.db || typeof store.archiveTurn!=='function') throw TypeError('继承导入需要 RawMemoryStore');
  if (!scope || typeof scope!=='string') throw Error('继承导入缺少作用域');
  batchId??=newInheritBatchId(clock);
  ensureInheritSchema(store.db);
  const comparison=compareInheritRecords(store.db,scope,records);
  createInheritBatch(store.db,{scope,batchId,source,total:records.length,clock});
  let inserted=0,skipped=0,conflicts=0,undone=0,ordinal=0;
  const importedRecords=[];
  try {
    for (const decision of comparison.decisions) {
      const {record,identity,status}=decision;
      if (status==='skipped') { skipped += 1; continue; }
      if (status==='conflict') { conflicts += 1; continue; }
      if (status==='undone') { undone += 1; continue; }
      ordinal += 1;
      const turnId='inherit:'+identity.sourceKey;
      const existing=store.storedTurn(scope,turnId);
      if (existing) {
        const prior=existing[0];
        if (prior?.text===record.text && prior?.role===record.speaker) {
          addInheritMember(store.db,{
            sourceKey:identity.sourceKey,
            textHash:identity.textHash,
            batchId,
            turnId,
            clock,
          });
          skipped += 1;
        } else {
          conflicts += 1;
        }
        continue;
      }
      const turn=importedTurn(record,identity,batchId,scope,ordinal);
      const result=store.archiveTurn(turn);
      if (!result.inserted) {
        if (result.changed) conflicts += 1;
        else skipped += 1;
        continue;
      }
      addInheritMember(store.db,{
        sourceKey:identity.sourceKey,
        textHash:identity.textHash,
        batchId,
        turnId,
        clock,
      });
      inserted += 1;
      importedRecords.push({turnId,messageId:turn.messages[0].id,sourceKey:identity.sourceKey,record});
    }
    finishInheritBatch(store.db,batchId,{inserted,skipped,conflicts,clock});
    return {batchId,scope,inserted,skipped,conflicts,undone,total:records.length,comparison,importedRecords};
  } catch (error) {
    finishInheritBatch(store.db,batchId,{inserted,skipped,conflicts,clock});
    throw error;
  }
}

export function inheritPreview(db,scope,records) {
  const compared=compareInheritRecords(db,scope,records);
  return {
    insert:compared.inserted,
    skip:compared.skipped,
    conflict:compared.conflicts,
    undone:compared.undone,
    decisions:compared.decisions.map(item=>({
      sourceKey:item.identity.sourceKey,
      id:item.record.id ?? null,
      file:item.record.source.file,
      status:item.status,
      reason:item.reason ?? null,
      ...(item.batchId?{batchId:item.batchId}:{}),
    })),
  };
}

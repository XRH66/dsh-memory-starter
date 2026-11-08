import fs from 'node:fs/promises';
import path from 'node:path';
import {zstdDecompressSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {sessionFormatCatalog} from '@deepseek-ai/dsh-session-format-catalog';
import {contentText,isDirectUserMessage} from '../text.js';
import {isAppendSurfaceEvent} from '@deepseek-ai/dsh-session/surface';
import {buildTurn,sha256} from './store.js';

const nativeId=id=>/^session-[a-zA-Z0-9_-]+$/.test(id);
const bytesHash=bytes=>createHash('sha256').update(bytes).digest('hex');
const inside=(p,root)=>{const r=path.relative(root,p);return !path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep);};
const fingerprint=cfg=>sha256(JSON.stringify({owner:cfg.ownerSubject,root:cfg.ownerDirectory,home:cfg.dshHome,
  raw:Object.fromEntries(Object.entries(cfg.memory||{}).filter(([key])=>key.startsWith('rawRecall')).sort(([a],[b])=>a.localeCompare(b)))}));

/** Decode every append frame with the installed DSH format catalog. No source writes. */
export async function readSessionHistory(file,{maxSourceBytes=256*1024*1024,maxFrameBytes=64*1024*1024}={}){
  const stat=await fs.lstat(file);
  if(stat.isSymbolicLink()||!stat.isFile())throw Error('not-a-regular-session-file');
  if(stat.size>maxSourceBytes)throw Error('source-file-too-large');
  const bytes=await fs.readFile(file);
  let restored=null,plainBytes=0;
  const feed=text=>{
    plainBytes+=Buffer.byteLength(text);
    if(plainBytes>maxSourceBytes*2)throw Error('decoded-session-too-large');
    for(const line of text.split(/\r?\n/)){
      if(!line.trim())continue;
      const row=JSON.parse(line);
      if(!restored)restored=sessionFormatCatalog.createRestore(row,{recovery:'strict',validation:'current'});
      else restored.decodeRow(row);
    }
  };
  if(file.endsWith('.zstd')){
    let offset=0;
    while(offset<bytes.length){
      const decoded=zstdDecompressSync(bytes.subarray(offset),{info:true,maxOutputLength:maxFrameBytes});
      const consumed=decoded.engine.bytesWritten;
      if(!consumed)throw Error('invalid-zstd-session-frame');
      offset+=consumed;feed(decoded.buffer.toString('utf8'));
    }
  }else feed(bytes.toString('utf8'));
  if(!restored)throw Error('empty-session-file');
  return {artifact:restored.finish(),hash:bytesHash(bytes),size:stat.size,mtimeMs:stat.mtimeMs};
}

/** Match the live archive's last direct user + final assistant per completed turn. */
export function completedHistoryTurns(artifact,scope){
  const sessionId=String(artifact.header?.id||'');
  if(!nativeId(sessionId))throw Error('invalid-session-identity');
  const events=artifact.events.slice(Number(artifact.inheritedEventCount)||0);
  const turns=[],skipped={interrupted:0,empty:0,control:0,execution:0};
  if(Number(artifact.header.delegationDepth)>0)return {turns,skipped:{...skipped,execution:1}};
  let current=null;
  for(const e of events){
    const d=e.data||{};
    if(e.type==='turn/start'){current={turn:d.turn,user:null,assistant:null,control:false,execution:false};continue;}
    if(!current)continue;
    if(e.type==='user/message'&&isAppendSurfaceEvent(e)&&isDirectUserMessage(d)&&contentText(d.content).trim()){
      current.user={id:String(d.id||''),role:'user',text:contentText(d.content).trim(),ts:Number(e.time)||0,seq:Number(e.seq)||0};
      if(/^\[SessionRelay Task:\s*[a-zA-Z0-9-]+\]\s*Delivery ID:/i.test(current.user.text))current.execution=true;
    }
    if(e.type==='assistant/message'&&isAppendSurfaceEvent(e)&&d.turn===current.turn){
      current.assistant=d.interrupted?null:{id:String(d.message?.id||`${sessionId}:event:${e.seq}`),role:'assistant',text:contentText(d.message?.content).trim(),ts:Number(e.time)||0,seq:Number(e.seq)||0};
    }
    if(['tool/call','tool/ptc-dispatch','tool/ptc-dispatch-start'].includes(e.type)){
      let args=d.arguments||{};if(typeof args==='string')try{args=JSON.parse(args);}catch{args={};}
      if(d.name==='soften_memory'||(d.name==='dafeiyu_records'&&['archive','delete'].includes(args.action)))current.control=true;
    }
    if(e.type!=='turn/end'||d.turn!==current.turn)continue;
    if(d.reason?.kind!=='completed'){skipped.interrupted++;current=null;continue;}
    if(current.execution){skipped.execution++;current=null;continue;}
    if(current.control){skipped.control++;current=null;continue;}
    const time=Number(e.time),messages=[current.user,current.assistant];
    if(!Number.isFinite(time)||time<=0||messages.some(m=>!m?.id||!m?.text)||!Number.isInteger(current.turn)){
      skipped.empty++;current=null;continue;
    }
    turns.push(buildTurn({scope,sessionId,turn:current.turn,completedAt:time,messages}));
    current=null;
  }
  return {turns,skipped};
}

export async function readModeRecords(dshHome){
  const file=path.join(dshHome,'storages','pure_mode.json');
  try{
    const stat=await fs.lstat(file);if(stat.isSymbolicLink())throw Error('linked-pure-mode-records');
    const data=JSON.parse(await fs.readFile(file,'utf8'));
    if(data.unit?.name!=='pure_mode'||data.unit?.version!==1||!data.tables?.sessions||typeof data.tables.sessions!=='object')throw Error('invalid-pure-mode-records');
    return data.tables.sessions;
  }catch(error){if(error.code==='ENOENT')return {};throw error;}
}

export function historyMode(record,normalDefaultConfirmed=false){
  if(record===undefined)return normalDefaultConfirmed?'normal':'default-mode-unconfirmed';
  if(!record||typeof record.enabled!=='boolean')return 'invalid-mode-record';
  if(record.enabled||record.historyUserOnly===true)return 'pure-or-mixed-history';
  if(record.historyUserOnly!==false)return 'legacy-mode-unconfirmed';
  return 'normal';
}

async function locateSources(cfg){
  const root=await fs.realpath(path.join(cfg.dshHome,'sessions'));
  const selected=new Set(cfg.dshSessionIds||[]),found=new Map();
  for(const workspace of await fs.readdir(root,{withFileTypes:true})){
    if(!workspace.isDirectory()||workspace.isSymbolicLink())continue;
    const dir=path.join(root,workspace.name);
    for(const item of await fs.readdir(dir,{withFileTypes:true})){
      if(!selected.has(item.name)||!nativeId(item.name)||!item.isDirectory()||item.isSymbolicLink())continue;
      const folder=path.join(dir,item.name),real=await fs.realpath(folder);
      if(!inside(real,root))throw Error('session-source-outside-root');
      const files=(await fs.readdir(folder)).filter(n=>/^session\.v\d+\.jsonl(?:\.zstd)?$/.test(n));
      files.sort((a,b)=>Number(/\.v(\d+)/.exec(b)[1])-Number(/\.v(\d+)/.exec(a)[1])||Number(b.endsWith('.zstd'))-Number(a.endsWith('.zstd')));
      if(found.has(item.name))throw Error('duplicate-session-identity');
      found.set(item.name,{file:files[0]?path.join(folder,files[0]):null,workspace:workspace.name});
    }
  }
  return found;
}

function validateDeployment(cfg){
  if(!path.isAbsolute(cfg.ownerDirectory||'')||!path.isAbsolute(cfg.dshHome||'')||typeof cfg.ownerSubject!=='string'||!cfg.ownerSubject.trim()||!Array.isArray(cfg.dshSessionIds)||cfg.dshSessionIds.some(id=>!nativeId(id)))throw Error('invalid-history-deployment');
}

export async function previewHistory(configurationFile,{normalDefaultConfirmed=false,excludeSessionIds=[],maxSourceBytes}={}){
  const cfg=JSON.parse(await fs.readFile(configurationFile,'utf8'));validateDeployment(cfg);
  const records=await readModeRecords(cfg.dshHome),located=await locateSources(cfg),excluded=new Set(excludeSessionIds);
  const plan={version:1,createdAt:new Date().toISOString(),configurationFile:path.resolve(configurationFile),deployment:fingerprint(cfg),scope:cfg.ownerSubject,
    normalDefaultConfirmed:Boolean(normalDefaultConfirmed),maxSourceBytes,excludedSessionIds:[...excluded],sources:[],summary:{sessions:0,eligibleSessions:0,turns:0,skippedSessions:0}};
  for(const id of [...new Set(cfg.dshSessionIds)]){
    const location=located.get(id),entry={sessionId:id,...location,reason:historyMode(records[id],normalDefaultConfirmed),turns:0};
    if(excluded.has(id)||/raw-production-|inplace-memory-test|qa-flow-|pure-dual-/i.test(location?.workspace||''))entry.reason='explicit-test-or-execution-exclusion';
    if(entry.reason==='normal'&&!location?.file)entry.reason='source-not-found';
    if(entry.reason==='normal'){
      try{
        const read=await readSessionHistory(location.file,{maxSourceBytes});
        if(read.artifact.header.id!==id)throw Error('source-identity-mismatch');
        const parsed=completedHistoryTurns(read.artifact,plan.scope);
        entry.hash=read.hash;entry.size=read.size;entry.mtimeMs=read.mtimeMs;
        entry.modeHash=sha256(JSON.stringify(records[id]??null));entry.turns=parsed.turns.length;entry.skippedTurns=parsed.skipped;
        entry.reason=entry.turns?'eligible':'no-completed-direct-turns';
      }catch(error){entry.reason='unreadable-source';entry.error=String(error.message).slice(0,250);}
    }
    plan.sources.push(entry);plan.summary.sessions++;
    if(entry.reason==='eligible'){plan.summary.eligibleSessions++;plan.summary.turns+=entry.turns;}else plan.summary.skippedSessions++;
  }
  plan.id=sha256(JSON.stringify(plan));return plan;
}

/** Import a reviewed snapshot; checkpoints advance only after local vectors persist. */
export async function applyHistory(plan,{store,recall,maxTurns=Infinity,batchSize=16,signal,onProgress=()=>{}}={}){
  const expected=plan.id,copy={...plan};delete copy.id;
  if(plan.version!==1||sha256(JSON.stringify(copy))!==expected)throw Error('invalid-history-plan');
  const stats={inserted:0,updated:0,unchanged:0,processed:0,sessions:0,complete:false,excludedSessions:0};
  const excludedSession=source=>{
    const control=store.getControl({scope:plan.scope,targetType:'session',targetId:source.sessionId,origin:'operator'});
    if(!control.excluded&&!(control.weight<=0))return false;
    stats.excludedSessions++;return true;
  };
  const readConfig=async()=>{
    const cfg=JSON.parse(await fs.readFile(plan.configurationFile,'utf8'));validateDeployment(cfg);
    if(fingerprint(cfg)!==plan.deployment||cfg.ownerSubject!==plan.scope||cfg.memory?.rawRecall!==true)throw Error('history-authorization-or-model-changed');
    return cfg;
  };
  sources: for(const source of plan.sources.filter(s=>s.reason==='eligible'||(s.reason==='no-completed-direct-turns'&&store.progress(plan.scope,s.sessionId)))){
    signal?.throwIfAborted();
    if(excludedSession(source))continue;
    const cfg=await readConfig();
    if(!cfg.dshSessionIds.includes(source.sessionId))throw Error('history-session-no-longer-authorized');
    const located=(await locateSources({...cfg,dshSessionIds:[source.sessionId]})).get(source.sessionId);
    if(!located||path.resolve(located.file||'')!==path.resolve(source.file))throw Error('history-source-location-changed');
    const checkMode=async()=>{
      const records=await readModeRecords(cfg.dshHome);
      if(historyMode(records[source.sessionId],plan.normalDefaultConfirmed)!=='normal'||sha256(JSON.stringify(records[source.sessionId]??null))!==source.modeHash)throw Error('history-mode-policy-changed');
    };
    await checkMode();
    const read=await readSessionHistory(source.file,{maxSourceBytes:plan.maxSourceBytes});
    if(read.hash!==source.hash||read.artifact.header.id!==source.sessionId)throw Error('history-source-changed-repreview-required');
    const {turns}=completedHistoryTurns(read.artifact,plan.scope);
    const previous=store.beginImport(plan.scope,source.sessionId,source.hash);
    const start=previous?.fingerprint===source.hash?previous.position:0;
    for(let offset=start;offset<turns.length;offset+=batchSize){
      signal?.throwIfAborted();const current=await readConfig();
      if(!current.dshSessionIds.includes(source.sessionId))throw Error('history-session-no-longer-authorized');
      await checkMode();
      const stat=await fs.stat(source.file);
      if(stat.size!==read.size||stat.mtimeMs!==read.mtimeMs)throw Error('history-source-changed-during-import');
      const count=Math.min(batchSize,turns.length-offset,maxTurns-stats.processed);
      if(count<=0){stats.complete=false;return stats;}
      if(excludedSession(source))continue sources;
      for(const turn of turns.slice(offset,offset+count)){
        const stored=store.storedTurn(plan.scope,turn.turnId);
        const accepted=stored?.every(m=>m.role==='user')?buildTurn({...turn,messages:turn.messages.filter(m=>m.role==='user')}):turn;
        const result=store.archiveTurn(accepted);
        if(result.inserted)stats.inserted++;else if(result.changed)stats.updated++;else stats.unchanged++;
        store.markImportedVisible(plan.scope,turn.turnId);
      }
      // Includes missing vectors left by a crash even when every archive is unchanged.
      await recall.indexPending({signal});
      for(const turn of turns.slice(offset,offset+count))store.saveProgress({scope:plan.scope,sourceId:source.sessionId,fingerprint:source.hash,position:offset+count,turnId:turn.turnId});
      stats.processed+=count;await onProgress({...stats,sessionId:source.sessionId,position:offset+count,total:turns.length});
      if(count<batchSize&&offset+count<turns.length){stats.complete=false;return stats;}
    }
    if(excludedSession(source))continue;
    await recall.indexPending({signal});
    const final=await fs.readFile(source.file);if(bytesHash(final)!==source.hash)throw Error('history-source-changed-during-import');
    await checkMode();await readConfig();
    store.saveProgress({scope:plan.scope,sourceId:source.sessionId,fingerprint:source.hash,position:turns.length,completed:true});stats.sessions++;
  }
  stats.complete=true;return stats;
}

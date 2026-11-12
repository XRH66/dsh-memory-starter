import {createMemorySearchSession} from './suzu/search-session.js';
import {isDeepStrictEqual} from 'node:util';
import {buildRawEmbeddingContext} from './raw-rag/embedding-material.js';
import {runMemoryQueryLanes} from './memory-query-lanes.js';
import {authorizedTools} from './worker.js';
import {hydrateMemory,memoryDirectory,MEMORY_TAG} from './memory.js';
import {memoryNoteExcluded,memoryNoteInDirectories} from './memory-entry-access.js';
import {memorySourceState} from './source-lineage.js';
import {adjustedRelevance} from './priority.js';
import {queryProfile} from './raw-rag/lexical.js';
import {MEMORY_ENTRY_SCHEMA} from './memory-entry.js';
import {MEMORY_ENTRY_TYPES,MEMORY_VALIDITY,MEMORY_PROGRESS} from './memory-contract.js';
import {localTime,localTimeWithDay} from './local-time.js';
import {createLegacyNoteReader,readVaultNote} from './legacy-notes.js';
import {legacyImportFingerprints} from './legacy-import.js';
import {minSimilarityFor,queryWaitFor} from './raw-rag/models.js';
import {createVaultBackend} from './vault-files.js';

const fields=['type','subject_ref','state','tags','importance','evidence_basis','speaker_ref','viewpoint_holder_ref','inferred_by_ref','source_refs','sourceStatus'];
const typed=request=>['type','validity','progress','subject','tag'].some(key=>request[key]!==undefined);
const matches=(entry,request)=>!['type','validity','progress','subject','tag'].some(key=>{
  if(request[key]===undefined)return false;
  return key==='tag'?!entry.tags?.includes(request.tag):key==='subject'?entry.subject_ref!==request.subject:
    ['validity','progress'].includes(key)?entry.state?.[key]!==request[key]:entry.type!==request.type;
});
const timeRange=request=>({since:request.since?Date.parse(request.since):0,until:request.until?Date.parse(request.until):Number.MAX_SAFE_INTEGER});
const inTime=(time,request)=>{const {since,until}=timeRange(request);return !request.since&&!request.until||Number.isFinite(time)&&time>=since&&time<=until;};
const vectorReviewMs=200,packingReserveMs=25;
// The vector service rejects control characters and outer whitespace (INVALID_MEMORY_VALUE).
// Multi-line questions and quoted originals are normal input, so fold them for the vector lane
// only; the text lanes still receive the original query.
export const vectorQueryText=value=>String(value??'').replace(/[\u0000-\u001f\u007f]+/gu,' ').replace(/\s+/gu,' ').trim().slice(0,2000);
// Only MEMORY_QUERY_DEFAULTS.records results are shown per call; each vector candidate is
// re-verified through the note store, so asking for 40 (80 verified) timed out at ~390 turns.
export const VECTOR_LANE_LIMIT=10;
function currentRawContext(reader,source,anchor){
  if(!anchor?.embedding)return true;
  if(!source||typeof reader.embeddingContext!=='function')return false;
  const material=buildRawEmbeddingContext(source,reader.embeddingContext(source.ref,{limit:4}));
  const expected=anchor.embedding,proof=material?.proof;
  return expected.sources?isDeepStrictEqual(proof,expected):
    Boolean(proof&&proof.version===expected.version&&proof.fingerprint===expected.fingerprint);
}
function publicRawContext(record){
  const proof=record.anchor?.embedding;
  if(record.kind!=='original'||!proof)return record;
  // Full dependency locators belong to the index, not the model's text budget.
  // The fingerprint binds all selected source identities, versions and bodies.
  return {...record,sourceIds:[record.id],anchor:{...record.anchor,
    embedding:{version:proof.version,fingerprint:proof.fingerprint}}};
}
const compareRank=(a,b)=>b.rank-a.rank||(b.record.time??0)-(a.record.time??0);
export const rerankDocumentText=value=>Array.from(String(value??'')).slice(0,1000).join('');
const isCorrection=source=>source?.role==='user'&&source.completion==='completed'&&source.changeKind==='correction';
function newestCorrection(records,corrections){
  if(!corrections.length)return;
  const applied=records.filter(record=>record.kind==='entry'&&record.state?.validity==='current');
  const appliedTime=Math.max(-Infinity,...applied.map(record=>record.time??-Infinity));
  return corrections.sort((a,b)=>b.source.time-a.source.time||b.source.sequence-a.source.sequence)
    .find(({source})=>source.time>appliedTime&&!applied.some(record=>record.source_refs?.some(ref=>ref.id===source.id&&ref.revision===source.revision)));
}
export {localTime} from './local-time.js';
/** Answering rules shared by the per-turn guidance message and the memory_search description.
 * Benchmark failures were mostly stated-as-fact guesses and shifted dates, not missing memories. */
export const ANSWER_RULES=[
  '只把记录（近期接续、记忆检索结果）里实际写到的内容当成事实说',
  '不要自己补记录里没有的具体时刻或时段、日期、数字、地点、天气、人物现在的状态、别人的反应或原话、事情的后续进展和原因；记录里没有就不说，或直接说没有记录',
  '计划、打算、约定在没有后续确认前，不能说成已经发生',
  '时间只用记录给出的时间和程序标注的相对日（今天、昨天、N 天前）；说到现在几点几号，照给出的当前本地时间原样说，不取整、不估算',
  '同一件事前后说法不同时，以时间最新的说法为准，并点明之前的说法；记录没说明原因就说原因不明，不要替它找原因',
  '只回答被问到的事，不顺带提无关的旧事，不主动说第三方的健康、婚姻、家庭、经济等私事',
  '给建议、做推测或按用户要求续编时可以发挥，但要说明这是建议、推测或新编的内容，不能和记录里的事混在一起说成已经发生',
];
const TYPE_ZH={fact:'事实',event:'事件',preference:'偏好',habit:'习惯',recent_state:'近况',goal:'目标',plan:'计划',todo:'待办',commitment:'约定',relationship:'关系',belief:'看法',reflection:'感想'};
const PROGRESS_ZH={planned:'尚未发生',in_progress:'进行中',completed:'已完成',cancelled:'已取消',unknown:'进展未知'};
const VALIDITY_ZH={current:'当前有效',historical:'已过时',disputed:'有争议',unverified:'未核实'};
/** One line the model reads first: what this record is, who said it, and when. */
export function recordLabel(record){
  const when=Number.isFinite(record.time)?localTimeWithDay(record.time):'时间未知';
  if(record.kind==='original')return `原话 · ${record.role==='user'?'用户说':record.role==='assistant'?'助手说':'未知说话人'} · ${when}`;
  const type=TYPE_ZH[record.type]??'记忆',progress=record.state?.progress?`（${PROGRESS_ZH[record.state.progress]??record.state.progress}）`:'';
  return `记忆条目 · ${type}${progress} · ${VALIDITY_ZH[record.state?.validity]??'有效性未知'} · 依据时间 ${when}`;
}
function excerpt(record,query='',offset,expanded=false){
  // Vector readers may already supply a slice. All issued offsets remain in
  // the authorized source's coordinates, including later open/continuation.
  const text=record.text,base=record.anchor?.range?.start??0;
  let start=offset===undefined?undefined:Math.max(0,offset-base);
  if(start===undefined){
    const terms=queryProfile(query).terms.map(term=>term.slice(2));
    // Normalization can change offsets. Locate the original substring before
    // using a hit offset, otherwise preserve the source's initial context.
    const direct=terms.map(term=>text.toLowerCase().indexOf(term)).filter(position=>position>=0);
    const hit=record.hitOffset===undefined?(direct.length?Math.min(...direct):0):record.hitOffset-base;
    start=Math.max(0,hit-(expanded?350:100));
  }
  if(start>0&&/[\uDC00-\uDFFF]/u.test(text[start]))start--;
  let end=expanded?text.length:Math.min(text.length,start+700);
  if(end<text.length&&/[\uD800-\uDBFF]/u.test(text[end-1]))end--;
  return {label:recordLabel(record),...record,...Number.isFinite(record.time)?{localTime:localTime(record.time)}:{},text:text.slice(start,end),anchor:{...record.anchor,range:{start:base+start,end:base+end}},...end<text.length?{truncated:true}:{}};
}
function rawRecord(source){return {id:source.id,revision:source.revision,text:source.text,kind:'original',role:source.role,time:source.time,
  source:{kind:'original',sessionId:source.sessionId,messageId:source.messageId,sequence:source.sequence,turn:source.turn,completion:source.completion,
    ...(source.fragment?{fragment:source.fragment}:{})},
  anchor:{id:source.id,revision:source.revision,ref:source.ref},weight:source.weight??1,...source.hitOffset!==undefined?{hitOffset:source.hitOffset}:{}};}

function entryBackend({tools,config,project}){
  return tools?.vaultBackend??createVaultBackend({vaultPath:config.vaultPath,project});
}

async function noteSearchHits({backend,agent,project,query,signal,check,structured,limit}){
  const hits=await backend.search({query,page_size:limit,search_type:'text',...structured===false?{tags:[MEMORY_TAG]}:{}},{agent,project,signal,check});
  check();
  if(!Array.isArray(hits))throw Error('Invalid note search');
  return structured===true?hits.filter(hit=>hit.metadata?.memory_entry_schema===MEMORY_ENTRY_SCHEMA):hits;
}

/** Pass only IDs and revisions to the organizer. It rereads the selected
 * entries using the original batch proofs and applies its own body budget. */
export function createMemoryReferenceLoader({access,tools,vectors,config,now=Date.now}){
  const clock=()=>Number(now());
  return async function loadReferences(input,context){
    context.check();
    const userText=input.sources.filter(source=>source.role==='user').map(source=>source.text.trim()).filter(Boolean);
    if(!userText.length)return [];
    const last=Array.from(userText.at(-1)).slice(0,400).join('');
    const query=Array.from(userText.slice(-4).reverse().join('\n')).slice(0,1000).join('');
    const {agent,scope}=context,grant=access.grant(agent),limit=8;
    const minSimilarity=minSimilarityFor(config);
    const check=()=>{
      context.check();
      if(!access.validate(grant)||grant.ownerSubject!==scope.ownerSubject||grant.project!==scope.project)
        throw Object.assign(Error('Reference authorization changed'),{code:'MEMORY_NOT_AUTHORIZED'});
    };
    try{
      check();
      const scoped=authorizedTools(tools,access,grant,agent,check);
      const backend=entryBackend({tools:scoped,config,project:scope.project});
      const lanes={text:async({signal})=>{
        const hits=await noteSearchHits({backend,agent,project:scope.project,query:last,signal,check,structured:true,limit});
        const notes=await Promise.allSettled(hits.slice(0,limit).map(hit=>backend.read(hit.file_path||hit.permalink,{agent,signal,check})));
        check();
        const records=[];
        for(const result of notes){
          if(result.status!=='fulfilled')continue;
          const note=result.value,meta=note?.metadata;
          if(meta?.memory_entry_schema!==MEMORY_ENTRY_SCHEMA||!meta.memory_entry_id||!note.checksum||memoryNoteExcluded(meta))continue;
          records.push({id:meta.memory_entry_id,revision:String(note.checksum)});
        }
        return {records};
      }};
      if(vectors)lanes.vector=async({signal,deadline})=>{
        const profile=await vectors.getSnapshot({grant,signal});check();
        if(!profile)return {records:[],state:'unavailable'};
        const text=vectorQueryText(query);if(!text)return {records:[]};
        const found=await vectors.query({grant,profile,query:text,domains:['entry','fact'],referenceOnly:true,minSimilarity,signal,deadline,limit});check();
        return {...found,records:found.records.filter(row=>['entry','note'].includes(row.anchor?.ref?.storage)&&row.state?.validity==='current'&&row.similarity>=minSimilarity)};
      };
      const {results}=await runMemoryQueryLanes({lanes,deadline:clock()+2000,signal:AbortSignal.any([context.signal,grant.signal].filter(Boolean)),now:clock});
      check();
      const references=new Map();
      for(const {id,revision,anchor} of [...(results.vector?.records??[]),...(results.text?.records??[])]){
        const legacy=anchor?.ref?.storage==='note'&&anchor.ref.identifier;
        if(!references.has(id))references.set(id,{id,revision,...(legacy?{legacy}: {})});
        if(references.size===limit)break;
      }
      return [...references.values()];
    }finally{grant.cancel?.();}
  };
}

/** One native answer, one policy grant and one ledger. No capture, model
 * classification, index repair or native-history reads occur in this adapter. */
export function createMemoryQueryAnswer({access,agent,answerTurn,raw,entries,tools,config,vectors,getPriorityConfig=()=>config,
  now=Date.now,tokenLimits,reranker=null,logger,searchWaitMs,visibleMessageIds,searchKind='search',onSearch}={}){
  const noteRefs=new Map();
  const legacyDirectories=['fact','event','history'].map(kind=>memoryDirectory(config,kind));
  function readers(request){
    const check=()=>{request.signal.throwIfAborted();if(!access.validate(request.grant))throw Error('Memory authorization changed');};
    check();const authorize=()=>!request.signal.aborted&&access.validate(request.grant);
    return {check,authorize,raw:raw.queryReader(request.scope,{authorize}),entries:entries.forGrant(agent,request.grant,{signal:request.signal}),
      };
  }
  async function entryRecord(entry,reader,request,located=false){
    if(!entry||!entry.sourceStatus?.eligible||!matches(entry,request))return null;
    const times=entry.source_refs.map(ref=>reader.raw.get({storage:'message',...ref})?.time).filter(Number.isFinite);
    const fallback=Date.parse(entry.occurred_at||entry.valid_from||'');
    const time=times.length?Math.max(...times):Number.isFinite(fallback)?fallback:null;if(!inTime(time,request))return null;
    const priority=adjustedRelevance(1,entry.priorityMetadata,{...await getPriorityConfig(),query:request.query??'',text:`# ${entry.title}\n${entry.content}`,now:now()});
    if(!located&&!priority.eligible)return null;
    return {id:entry.id,revision:entry.revision,text:entry.content,kind:'entry',time,weight:priority.score,
      ...Object.fromEntries(fields.filter(key=>entry[key]!==undefined).map(key=>[key,entry[key]])),
      source:{kind:'note',permalink:entry.permalink},anchor:{id:entry.id,revision:entry.revision,ref:{storage:'entry',id:entry.id}},
      _sourceValid:()=>entry.sourceStatus.manualBody||entry.source_refs.every(ref=>{
        const source=reader.raw.get({storage:'message',...ref});return source&&(!ref.role||source.role===ref.role);
      })};
  }
  async function legacyRecord(note,request,located=false,migrated=null){
    if(!note||!matches(note.entry,request)||memoryNoteExcluded(note.metadata)||!memoryNoteInDirectories(note,request.scope.project,legacyDirectories))return null;
    if(!located&&migrated?.get(note.memoryId)===note.checksum)return null;
    const sourceStatus=memorySourceState(note,{scope:request.scope.ownerSubject,sourceState:raw.querySourceState});if(!sourceStatus.eligible)return null;
    const date=Date.parse(note.sourceEventTime||note.recordedAt),time=Number.isFinite(date)?date:null;if(!inTime(time,request))return null;
    const relevance=adjustedRelevance(1,note.metadata,{...await getPriorityConfig(),query:request.query??'',text:note.value,now:now()});if(!located&&!relevance.eligible)return null;
    const id='legacy-note:'+note.memoryId,ref={storage:'note',id};
    noteRefs.set(id,{filePath:note.filePath,memoryId:note.memoryId});
    return {id,revision:note.checksum,text:note.value||note.entry.content,kind:'entry',time,
      ...Object.fromEntries(fields.filter(key=>note.entry[key]!==undefined).map(key=>[key,note.entry[key]])),
      sourceStatus:{eligible:true,authority:sourceStatus.authority},source:{kind:'note',permalink:note.permalink},
      anchor:{id,revision:note.checksum,ref},weight:relevance.score,
      _sourceValid:()=>memorySourceState(note,{scope:request.scope.ownerSubject,sourceState:raw.querySourceState}).eligible};
  }
  const localLegacy=config.vaultPath?createLegacyNoteReader({vaultPath:config.vaultPath,directories:legacyDirectories}):null;
  // Reports how long each search took and what it found; no query text or results leave here.
  async function search(request){
    const begun=now(),coldBefore=vectors?.coldLoads?.()??0;
    const report=summary=>{try{onSearch?.({kind:searchKind,at:new Date(begun).toISOString(),totalMs:Math.max(0,now()-begun),
      cold:(vectors?.coldLoads?.()??0)!==coldBefore,...summary});}catch{}};
    let result;
    try{result=await searchOnce(request);}
    catch(error){report({state:request.signal?.aborted?'timeout':'failed'});throw error;}
    const {_stats:stats,...answer}=result,channels=answer.channels??{};
    const lane=name=>channels[name]?{state:channels[name].state,ms:channels[name].elapsedMs}:null;
    const textMs=Math.max(0,...['originals','structured','legacy'].map(name=>channels[name]?.elapsedMs??0));
    report({state:answer.degraded?'partial':'ok',records:Math.min(answer.records.length,request.limit||answer.records.length),
      skippedVisible:stats?.skippedVisible??0,text:{ms:textMs},vector:lane('vector'),
      rerank:channels.rerank?{state:channels.rerank.state,ms:channels.rerank.ms??0}:null});
    return answer;
  }
  async function searchOnce(request){
    const reader=readers(request),range=timeRange(request);
    const migrated=localLegacy?.available()?await legacyImportFingerprints(config):new Map();
    const lanes={
      originals:async()=>{if(typed(request))return {records:[]};const page=reader.raw.search({query:request.query,...range,limit:40});return {records:page.sources.map(rawRecord),degraded:page.partial};},
      // Structured entries are searched in the local projection (same SQLite as originals).
      structured:async()=>{
        const found=await reader.entries.search(request.query,{limit:20});
        const records=await Promise.all(found.map(entry=>entryRecord(entry,reader,request)));reader.check();
        return {records:records.filter(Boolean)};
      },
      // Old-format notes come only from the selected Vault directory.
      legacy:async()=>{
        if(!localLegacy?.available())return {records:[],state:'unavailable'};
        const records=await Promise.all(localLegacy.search(request.query,20).map(async note=>legacyRecord(await hydrateMemory({...note,frontmatter:note.metadata}),request,false,migrated)));
        reader.check();return {records:records.filter(Boolean)};
      },
      vector:async lane=>{
        if(!vectors&&typed(request))return {records:[],state:'unavailable'};
        const profile=await request.getProfile();
        lane.signal.throwIfAborted();reader.check();
        if(!profile)return {records:[],state:'unavailable'};
        if(vectors){
          const text=vectorQueryText(request.query);if(!text)return {records:[]};
          const result=await vectors.query({grant:request.grant,profile,query:text,signal:lane.signal,deadline:lane.deadline,limit:VECTOR_LANE_LIMIT});
          reader.check();return {records:(result.records??[]).filter(record=>(!typed(request)||record.kind!=='original')&&matches(record,request)&&inTime(record.time,request))
            .map(record=>({...record,_vector:true})),degraded:result.degraded,...result.state==='unavailable'?{state:'unavailable'}:{}};
        }
        const result=await raw.retrieve({query:request.query,asOf:range.until,since:range.since,mode:'vector',repair:false,expectedModelKey:profile.modelKey,
          deadline:lane.deadline,signal:lane.signal,authorize:()=>!lane.signal.aborted&&reader.authorize()});
        reader.check();return {records:reader.raw.fromTurns(result.turns,{vector:true}).map(rawRecord),degraded:result.partial,
          ...['vector-unavailable','scope-changed'].includes(result.reason)?{state:'unavailable'}:{}};
      },
    };
    const start=now();
    const result=await runMemoryQueryLanes({lanes,deadline:request.deadline,signal:request.signal,now});reader.check();
    const ranked=new Map();let skippedVisible=0;
    for(const channel of Object.values(result.results))channel.records.forEach((record,index)=>{
      if(Number.isSafeInteger(answerTurn)&&record.kind==='original'&&record.source?.sessionId===agent.session.id&&record.source.turn===answerTurn)return;
      // Lines the model can already read in this conversation would only take a slot from older memory.
      if(visibleMessageIds?.size&&record.kind==='original'&&record.source?.sessionId===agent.session.id&&visibleMessageIds.has(record.source.messageId)){skippedVisible++;return;}
      const key=JSON.stringify([record.id,record.revision]),item=ranked.get(key)??{};
      const importance=record.importance?.level==='high'?1.2:record.importance?.level==='low'?.9:1;
      const validity=record.state?.validity==='historical'&&!request.validity?.includes('historical')?.85:1;
      const rank=importance*validity*(record.weight??1)/(60+index+1),kind=record._vector?'vector':'text';
      item[kind]={record,rank:(item[kind]?.rank??0)+rank};ranked.set(key,item);
    });
    const vectorCorrections=[];
    for(const item of ranked.values()){
      for(const candidate of [item.text,item.vector])if(candidate)candidate.record=excerpt(candidate.record,request.query);
      const record=item.vector?.record;
      if(record?.kind==='original'&&(!item.text||request.hasSeen(item.text.record))){
        const source=reader.raw.get(record.anchor.ref);
        if(isCorrection(source))vectorCorrections.push({item,record,source});
      }
    }
    const ordered=(includePending=false)=>[...ranked.values()].flatMap(item=>{
      const {text,vector,checked}=item;
      if(vector&&(checked||includePending)&&!request.hasSeen(vector.record))return [{item,record:vector.record,rank:vector.rank+(text?.rank??0)}];
      return text?[{item,...text}]:[];
    }).sort(compareRank);
    // Share the original delivery reserve with review when collection runs long.
    const reviewDeadline=Math.min(request.deadline-Math.min(packingReserveMs,(request.deadline-start)/8),now()+vectorReviewMs);
    const reviewStates=new Set();
    if(vectors)while(true){
      // Check only vectors that could occupy an available result slot. Re-rank
      // after a refusal so verified text keeps its own score and can fill it.
      const eligible=ordered(true).filter(({record})=>!request.hasSeen(record)&&record.text.trim());
      const correction=newestCorrection(eligible.map(({record})=>record),vectorCorrections.filter(({item,record})=>item.vector&&!request.hasSeen(record)));
      const pending=eligible.filter(({record},index)=>index<request.limit||record===correction?.record)
        .filter(({record,item})=>record._vector&&!item.checked);
      if(!pending.length)break;
      const checks=Object.fromEntries(pending.map(({record},index)=>[index,async({signal})=>{
        const {id,revision,anchor}=record,resolved=await vectors.resolveDocument({grant:request.grant,id,revision,anchor,signal});
        const current=Array.isArray(resolved)?resolved:resolved?[resolved]:[];
        return {records:current.some(row=>row.id===id&&row.revision===revision)?[record]:[]};
      }]));
      const review=await runMemoryQueryLanes({lanes:checks,deadline:reviewDeadline,signal:request.signal,now,reserveMs:0});reader.check();
      pending.forEach(({item},index)=>{
        const state=review.channels[index].state;
        if(state==='ready')item.checked=true;
        else{
          item.vector=undefined;
          reviewStates.add(state);
        }
      });
      if(reviewStates.has('timeout'))break;
    }
    const reviewState=reviewStates.has('timeout')?'timeout':reviewStates.has('failed')?'failed':reviewStates.size?'source_changed':undefined;
    // Optional rerank: reorders only the leading candidates; any failure keeps the fused order.
    // An unconfigured reranker leaves the result exactly as before, without a channel entry.
    let list=ordered(),rerank;
    if(reranker?.status?.().enabled){
      const candidates=list.filter(({record})=>record.text.trim()).slice(0,config.memoryRerankCandidates??30);
      rerank={state:'disabled',candidates:candidates.length};
      const budget=Math.min(config.memoryRerankTimeoutMs??1500,request.deadline-now()-packingReserveMs);
      if(candidates.length<2||!String(request.query??'').trim())rerank.state='skipped';
      else if(!reranker.enabled())rerank.state=reranker.status().state==='paused'?'paused':'disabled';
      else if(budget<200)rerank.state='no_time';
      else{
        const timeout=AbortSignal.timeout(budget),rerankStart=now();
        try{
          const ranked=await reranker.rerank({query:request.query,documents:candidates.map(({record})=>rerankDocumentText(record.text)),
            signal:AbortSignal.any([request.signal,timeout])});
          if(!Array.isArray(ranked)||ranked.some(row=>!Number.isInteger(row?.index)||row.index<0||row.index>=candidates.length||!Number.isFinite(row.score))||
            new Set(ranked.map(row=>row.index)).size!==ranked.length)throw Error('Invalid rerank result');
          const scored=[...ranked].sort((a,b)=>b.score-a.score).map(row=>candidates[row.index]);
          const reordered=[...scored,...candidates.filter(entry=>!scored.includes(entry))];
          // Reranked ranks sit above any fused rank, so compareRank keeps this order.
          const reranked=reordered.map((entry,index)=>({...entry,rank:1+(reordered.length-index)/reordered.length}));
          list=[...reranked,...list.filter(entry=>!candidates.includes(entry))];
          rerank.state='applied';rerank.ms=Math.max(0,now()-rerankStart);
        }catch(error){
          if(request.signal.aborted)throw error;
          rerank.ms=Math.max(0,now()-rerankStart);
          rerank.state=error?.code==='RERANK_UNAVAILABLE'?'disabled':error?.code==='RERANK_PAUSED'?'paused':
            error?.code==='RERANK_TIMEOUT'||timeout.aborted?'timeout':'failed';
          logger?.warn?.('[memory-rerank] '+rerank.state+(Number.isFinite(error?.httpStatus)?' http='+error.httpStatus:''));
        }
      }
    }
    const records=list.map(({record,rank,item})=>({...record,_rank:rank,_textFallback:record._vector?item.text:undefined}));
    const channels={...result.channels,...rerank?{rerank}:{},...reviewState?{vectorValidation:{state:reviewState}}:{}};
    const degraded=result.degraded||Boolean(reviewState);
    return {records,channels,degraded,timings:{totalMs:Math.max(0,now()-start)},coverage:{complete:!degraded,rawTypedFilters:typed(request)?'not_applicable':'included'},
      _stats:{skippedVisible}};
  }
  async function expand(request){
    const reader=readers(request),ref=request.anchor.ref;let record;
    if(vectors&&['document','note','entry'].includes(ref?.storage)){
      const resolved=await vectors.resolveDocument({grant:request.grant,id:request.id,revision:request.revision,signal:request.signal});
      record=Array.isArray(resolved)?resolved.find(row=>row.id===request.id):resolved;
      if(record&&(!matches(record,request)||!inTime(record.time,request)))record=null;
      if(record)record={...record,_vector:true};
    }
    if(!record&&ref?.storage==='entry')record=await entryRecord(await reader.entries.read(ref.id),reader,request,true);
    else if(!record&&ref?.storage==='note'){
      const saved=noteRefs.get(ref.id);if(saved){const payload=readVaultNote(config.vaultPath,saved.filePath),note=payload?await hydrateMemory({...payload,frontmatter:payload.metadata}):null;
        if(note?.memoryId===saved.memoryId)record=await legacyRecord(note,request,true);}
    }else if(!record&&ref){
      const source=reader.raw.get(ref);
      if(source&&currentRawContext(reader.raw,source,request.anchor)){
        record=rawRecord(source);
        if(request.anchor.embedding)record.anchor.embedding=request.anchor.embedding;
      }
    }
    reader.check();if(!record||record.id!==request.id||record.revision!==request.revision)return {records:[],degraded:true,channels:{source:{state:'source_changed'}}};
    const records=[excerpt(record,'',request.anchor.nextOffset??Math.max(0,(request.anchor.range?.start??0)-250),true)];
    if(ref.storage==='message'||ref.storage==='legacy'){
      const seen=new Set([record.id]);
      // Context proof locates associated previous messages; token limits may
      // omit some from an encoded chunk. Expand only on request within budget.
      const source=reader.raw.get(ref);
      const proof=request.anchor.embedding&&source?buildRawEmbeddingContext(source,reader.raw.embeddingContext(ref,{limit:4}))?.proof:null;
      const context=(proof?.sources??[]).map(item=>reader.raw.get(item.ref)).filter(Boolean);
      for(const source of [...context,...reader.raw.neighbors(ref)])if(!seen.has(source.id)){
        seen.add(source.id);records.push(excerpt(rawRecord(source),'',0,true));
      }
    }
    if(ref.storage==='entry')for(const sourceRef of record.source_refs??[]){const source=reader.raw.get({storage:'message',...sourceRef});if(source)records.push(excerpt(rawRecord(source),'',0,true));}
    return {records,channels:{source:{state:'ready'}},degraded:false};
  }
  const actualDevice=raw.status?.().backend?.actualDevice;
  return createMemorySearchSession({policy:access,agent,tokenLimits:tokenLimits??{},searchWaitMs:searchWaitMs??queryWaitFor(config,actualDevice),now,search,expand,
    validateResult(result,request){
      const reader=readers(request),corrections=[];
      function current(record){
        if(record.kind==='original'){
          const source=reader.raw.get(record.anchor.ref);
          if(!currentRawContext(reader.raw,source,record.anchor))return false;
          if(request.query&&isCorrection(source)){
            corrections.push({record,source});
          }
          return Boolean(source);
        }
        if(record._vector&&record.source_refs?.length&&!record.sourceStatus?.manualBody)return record.source_refs.every(ref=>{
          const source=reader.raw.get({storage:'message',...ref});return source&&(!ref.role||source.role===ref.role);
        });
        return record._sourceValid?.()!==false;
      }
      let fallbacks=0;
      const records=result.records.flatMap(record=>{
        if(current(record))return [record];
        const fallback=record._textFallback;
        if(!fallback||!current(fallback.record))return [];
        fallbacks++;
        return [{...fallback.record,_rank:result.channels.rerank?.state==='applied'?record._rank:fallback.rank}];
      });
      if(fallbacks)records.sort((a,b)=>compareRank({record:a,rank:a._rank},{record:b,rank:b._rank}));
      // Reserve the first evidence slot for one relevant user correction that
      // is newer than the matching applied entries. Keep their stored state.
      const newest=newestCorrection(records,corrections);
      if(newest){
        records.splice(records.indexOf(newest.record),1);
        records.unshift({...newest.record,source:{...newest.record.source,changeKind:'correction'}});
      }
      const removed=result.records.length-records.length;
      const publicRecords=records.map(publicRawContext);
      if(!removed&&!fallbacks)return {...result,records:publicRecords};
      return {...result,records:publicRecords,degraded:true,channels:{...result.channels,sourceValidation:{state:'source_changed',removed,...fallbacks?{fallbacks}:{}}},
        coverage:{...result.coverage,complete:false}};
    },
    getProfile({grant,signal}){if(vectors)return vectors.getSnapshot({grant,signal});const state=raw.status();return state.enabled&&state.backend?.prepared&&state.modelKey?{id:config.rawRecallModel,revision:state.modelKey,modelKey:state.modelKey}:null;},
    async recent(request){const reader=readers(request);return {records:reader.raw.recent({limit:40}).map(source=>excerpt(rawRecord(source),'',0)),channels:{originals:{state:'ready'}}};},
  });
}

export function createMemoryQueryTools({answer}){
  const filters={type:{type:'string',enum:MEMORY_ENTRY_TYPES,description:'长期条目的内容类型；筛选后不包含未分类原文'},validity:{type:'string',enum:MEMORY_VALIDITY},progress:{type:'string',enum:MEMORY_PROGRESS},
    subject:{type:'string',description:'精确主体引用'},tag:{type:'string'},since:{type:'string',description:'ISO 时间下界：原文时间或长期条目的来源/记录时间'},until:{type:'string',description:'ISO 时间上界'}};
  const limit={type:'integer',description:'最多返回10条；搜索、展开、近期读取同轮合计4次、约4K tokens'};
  return [
    {name:'memory_search',description:'仅在需要历史依据时搜索已开启的个人记忆。先看当前对话和已接续的上下文。当前材料已给齐本题的日期、偏好、条件或决定时，直接回答；闲聊、通用建议、根据眼前条件排期或改写，都不查询记忆，也不为验证当前已有信息再查一遍。用户明确要求回顾或核对历史，或确实缺少会改变答案的历史信息时，先做一次聚焦搜索，读完结果再决定是否补查，避免并行调用记忆工具。结果够用就回答；每条结果的 label 说明它是原话还是记忆条目、谁说的、何时说的：'+ANSWER_RULES.join('；')+'。有冲突、需要引用原话或缺关键条件时，再用 memory_open 展开相关 ref，核对角色、时间、有效性、事项进展和归属。核对最新改口时先用普通搜索，以便同时查到尚未归类的原话和已应用条目。用户对同一事项最新且明确的更正原话（标有 correction 的记录）用于回答当前安排；旧说法与已应用条目的状态按实际记录说明。搜索约1K tokens，可能未查全。',parameters:{query:{type:'string',required:true},limit,...filters},run:'search'},
    {name:'memory_open',description:'核对 memory_search/memory_recent 已返回的 ref（结果里的短编号），展开同版本原文、保存的同回合上下文及关联的有限前文，或长期条目及依据。前文帮助理解原话，不保证每条都参与了该分块的向量编码。背景与正文各保留原说话者和来源，不能将助手建议当成用户陈述。单次约2K tokens；返回续页 ref（结果里的短编号）后可继续。不得编造 ref。',parameters:{ref:{type:'string',required:true}},run:'expand'},
    {name:'memory_recent',description:'按需查看最近保存的双方原文。与搜索、展开共用本回答的调用及返回额度；自动短期接续独立处理。',parameters:{limit},run:'recent'},
  ].map(({run,...tool})=>({...tool,output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    async execute(args,exec){return answer(exec.agent)[run](args,{signal:exec.signal});}}));
}

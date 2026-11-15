import {createMemorySearchSession} from './suzu/search-session.js';
import {isDeepStrictEqual} from 'node:util';
import {buildRawEmbeddingContext} from './raw-rag/embedding-material.js';
import {runMemoryQueryLanes} from './memory-query-lanes.js';
import {lexicalMatchTerms,lexicalTerms,queryProfile} from './raw-rag/lexical.js';
import {localTime,localTimeWithDay} from './local-time.js';
import {queryWaitFor} from './raw-rag/models.js';
import {createStopwatch,searchFinalizationReserveMs} from './monotonic.js';
import {buildInheritedVectorMaterial} from './raw-rag/query-reader.js';

const milliseconds=value=>Number.isFinite(value)?Math.round(Math.max(0,value)*100)/100:0;
const matches=(entry,request)=>!['type','validity','progress','subject','tag'].some(key=>{
  if(request[key]===undefined)return false;
  return key==='tag'?!entry.tags?.includes(request.tag):key==='subject'?entry.subject_ref!==request.subject:
    ['validity','progress'].includes(key)?entry.state?.[key]!==request[key]:entry.type!==request.type;
});
const timeRange=request=>({since:request.since?Date.parse(request.since):0,until:request.until?Date.parse(request.until):Number.MAX_SAFE_INTEGER});
const inTime=(time,request)=>{const {since,until}=timeRange(request);return !request.since&&!request.until||Number.isFinite(time)&&time>=since&&time<=until;};
// The vector service rejects control characters and outer whitespace (INVALID_MEMORY_VALUE).
// Multi-line questions and quoted originals are normal input, so fold them for the vector lane
// only; the text lanes still receive the original query.
export const vectorQueryText=value=>String(value??'').replace(/[\u0000-\u001f\u007f]+/gu,' ').replace(/\s+/gu,' ').trim().slice(0,2000);
const MIN_SEARCH_ORIGINAL_CHARACTERS=3;
export const SUMMARY_RERANK_WEIGHT=0.7;
export const isSearchableOriginal=record=>record?.kind!=='original'||
  Array.from(String(record.text??'').trim()).length>=MIN_SEARCH_ORIGINAL_CHARACTERS;
const TRIVIAL_PREFETCH=new Set([
  '好的','好','嗯','嗯嗯','哦','行','可以','谢谢','谢了','继续','接着说','晚安','早','早安','在吗',
  'ok','okay','thanks','thx','yes','no','收到','明白','知道了','对','是的','没事',
]);
const PREFETCH_PARTICLES=/[啊呀吧呢嘛啦哦喔噢咧咯]+$/u;
/** Skip only empty, pure-social, or tokenless input; uncertain text is searched. */
export function shouldPrefetch(value){
  const normalized=String(value??'').normalize('NFKC')
    .replace(/[\p{P}\p{S}\p{Z}\s]+/gu,'').toLowerCase();
  if(!normalized)return {ok:false,reason:'trivial'};
  let core=normalized;
  for(;;){
    const next=core.replace(PREFETCH_PARTICLES,'');
    if(!next||next===core)break;
    core=next;
  }
  if(TRIVIAL_PREFETCH.has(normalized)||TRIVIAL_PREFETCH.has(core)||/^哈{2,}$/u.test(core))return {ok:false,reason:'trivial'};
  if(!queryProfile(value).terms.length)return {ok:false,reason:'trivial'};
  return {ok:true};
}
const PREFETCH_OPTION_DEFAULTS=Object.freeze({
  maxRecords:3,minLexical:.6,vectorMargin:.1,minRerank:.02,rerankRatio:.5,maxChars:1000,
});

function normalizedPrefetchText(value){
  return String(value??'').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu,'');
}

function hanBigrams(value){
  const terms=new Set();
  for(const match of String(value??'').matchAll(/\p{Script=Han}+/gu)){
    const chars=Array.from(match[0]);
    for(let index=0;index<chars.length-1;index++)terms.add(chars[index]+chars[index+1]);
  }
  return terms;
}

function similarPrefetchText(left,right){
  const a=normalizedPrefetchText(left),b=normalizedPrefetchText(right);
  if(!a||!b)return false;
  if(a.includes(b)||b.includes(a))return true;
  const one=hanBigrams(a),two=hanBigrams(b);
  if(!one.size||!two.size)return false;
  let shared=0;for(const term of one)if(two.has(term))shared++;
  return shared/(one.size+two.size-shared)>=.7;
}

function prefetchLine(record){
  const text=String(record?.text??'').replace(/\s+/gu,' ').trim();
  if(!text)return '';
  return `- [${record?.label??'记忆'}] ${text}`;
}

function truncatePrefetchLine(value,max){
  if(max<=0)return '';
  let length=0,output='';
  for(const char of String(value??'')){
    if(length+char.length>max)break;
    output+=char;length+=char.length;
  }
  return output;
}

/**
 * Apply automatic-prefetch admission, event folding and output limits.
 * Tool searches deliberately bypass this selector.
 */
export function selectPrefetch({records=[],minSimilarity=0,options={}}={}){
  const settings=options&&typeof options==='object'?options:{};
  const recordLimit=settings.maxRecords??settings.prefetchMaxRecords,characterLimit=settings.maxChars??settings.prefetchMaxChars;
  const lexicalFloor=settings.minLexical??settings.prefetchMinLexical,margin=settings.vectorMargin??settings.prefetchVectorMargin;
  const rerankFloor=settings.minRerank??settings.prefetchMinRerank;
  const rerankRatioOption=settings.rerankRatio??settings.prefetchRerankRatio;
  const maxRecords=Number.isSafeInteger(recordLimit)?Math.min(4,Math.max(1,recordLimit)):3;
  const maxChars=Number.isFinite(characterLimit)?Math.max(0,characterLimit):1000;
  const minLexical=Number.isFinite(lexicalFloor)?lexicalFloor:PREFETCH_OPTION_DEFAULTS.minLexical;
  const vectorMargin=Number.isFinite(margin)?margin:PREFETCH_OPTION_DEFAULTS.vectorMargin;
  const minRerank=Number.isFinite(rerankFloor)?rerankFloor:PREFETCH_OPTION_DEFAULTS.minRerank;
  const rerankRatio=Number.isFinite(rerankRatioOption)&&rerankRatioOption>=0&&rerankRatioOption<=1
    ?rerankRatioOption:PREFETCH_OPTION_DEFAULTS.rerankRatio;
  const threshold=Number.isFinite(minSimilarity)?minSimilarity:0;
  const reasons={lexical:0,vector:0,agree:0};
  const rows=(Array.isArray(records)?records:[]).filter(isSearchableOriginal).map((record,index)=>({record,index}));
  const topRerank=settings.rerankApplied===true?Math.max(-Infinity,...rows.flatMap(({record})=>{
    const validity=record?.state?.validity,rerank=record?.signals?.rerank;
    return record&&String(record.text??'').trim()&&validity!=='historical'&&validity!=='disputed'&&Number.isFinite(rerank)?[rerank]:[];
  })):null;
  const admitted=[];
  for(const row of rows){
    const record=row.record,signals=record?.signals??{},validity=record?.state?.validity;
    if(!record||!String(record.text??'').trim()||validity==='historical'||validity==='disputed')continue;
    const lexical=Number.isFinite(signals.lexical)?signals.lexical:0;
    const similarity=Number.isFinite(signals.similarity)?signals.similarity:null;
    const lanes=Array.isArray(signals.lanes)?signals.lanes:[];
    let reason='';
    if(settings.rerankApplied===true){
      const relativeFloor=topRerank*rerankRatio;
      if(Number.isFinite(topRerank)&&Number.isFinite(signals.rerank)&&signals.rerank>=minRerank&&signals.rerank>=relativeFloor)
        reason='rerank';
    }else if(lexical>=minLexical){
      reason='lexical';
    }else if(similarity!==null&&similarity>=threshold+vectorMargin){
      reason='vector';
    }else if(lanes.includes('text')&&lanes.includes('vector')&&lexical>=.3&&similarity!==null&&similarity>=threshold){
      reason='agree';
    }
    if(!reason)continue;
    if(Object.hasOwn(reasons,reason))reasons[reason]++;
    admitted.push({...row,reason});
  }

  let kept=admitted;
  let folded=0;
  const deduped=[];
  for(const row of kept){
    const matches=deduped.filter(existing=>similarPrefetchText(existing.record.text,row.record.text));
    if(!matches.length){
      deduped.push(row);continue;
    }
    const best=matches.reduce((winner,item)=>item.index<winner.index?item:winner);
    if(row.index<best.index){
      for(const match of matches)deduped.splice(deduped.indexOf(match),1);
      deduped.push(row);folded+=matches.length;
    }else folded++;
  }
  kept=deduped.sort((left,right)=>left.index-right.index);

  const lines=[];
  let chars=0;
  for(const row of kept){
    if(lines.length>=maxRecords)break;
    const remaining=maxChars-chars;
    if(remaining<=0)break;
    const full=prefetchLine(row.record);
    const line=full.length<=remaining?full:truncatePrefetchLine(full,remaining);
    if(!line)break;
    lines.push(line);chars+=line.length;
  }
  return {lines,stats:{
    candidates:rows.length,admitted:admitted.length,rejected:rows.length-admitted.length,folded,
    injected:lines.length,chars,...reasons,
  }};
}
// Only MEMORY_QUERY_DEFAULTS.records results are shown per call; each vector candidate is
// re-verified through the note store, so asking for 40 (80 verified) timed out at ~390 turns.
export const VECTOR_LANE_LIMIT=10;
function rawEmbeddingMaterial(reader,source){
  return buildInheritedVectorMaterial(source)
    ??(source&&typeof reader?.embeddingContext==='function'
      ?buildRawEmbeddingContext(source,reader.embeddingContext(source.ref,{limit:4}))
      :null);
}
function currentRawContext(reader,source,anchor){
  if(!anchor?.embedding)return true;
  if(!source)return false;
  const material=rawEmbeddingMaterial(reader,source);
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
export const rerankDocumentText=(value,limit=1000)=>Array.from(String(value??'')).slice(0,limit).join('');
export {localTime} from './local-time.js';
/** Fact-sourcing rules attached only where memory material enters the prompt. */
export const ANSWER_RULES=Object.freeze([
  '这些规则只管事实从哪里来，不改变你的身份、语气和说话方式',
  '只把记录里实际写到的内容当事实说；记录没写的具体时刻、日期、数字、地点、人物近况、别人的反应或原话、事情的后续和原因，不要自己补',
  '计划、打算、约定没有后续确认，不说成已经发生',
  '说时间以记录标注和当前本地时间为准，不取整、不估算',
  '同一件事前后说法不同，以最新的为准，并顺带点明之前的说法；记录没说原因就别替它找原因',
  '不翻出与当前话题无关的旧事，不主动谈第三方的健康、婚姻、家庭、经济等私事',
  '没有依据时，像平常聊天一样说不记得或没听说过，不要说“根据记录”“记忆库”之类的程序用语',
  '建议、推测和续编照常发挥，不用每次声明，只是不能把它们说成记录里发生过的事',
]);
function documentTitle(record){
  const explicit=String(record.title??'').trim();
  if(explicit)return explicit;
  const heading=/^#\s+(.+?)\s*$/m.exec(String(record.text??''))?.[1]?.trim();
  if(heading)return heading;
  const identifier=String(record.source?.permalink??record.anchor?.ref?.identifier??'').replace(/\\/g,'/');
  const stem=identifier.split('/').filter(Boolean).pop()??'';
  if(!stem)return '未命名资料';
  let decoded=stem;
  try{decoded=decodeURIComponent(stem);}catch{}
  return decoded.replace(/-/g,' ').trim()||'未命名资料';
}
/** One line the model reads first: what this record is, who said it, and when. */
export function recordLabel(record){
  const dateOnly=typeof record.timeText==='string'&&/^\d{4}-\d{2}-\d{2}$/u.test(record.timeText);
  const when=dateOnly?record.timeText:Number.isFinite(record.time)?localTimeWithDay(record.time):'时间未知';
  const imported=record.imported===true||Boolean(record.import?.batchId);
  if(record.kind==='original'&&record.role==='summary'){
    const known=record.timeText!==undefined||Number.isFinite(record.time);
    return `旧笔记（整理摘要） · 写于${known?' '+when:'时间不详'}`;
  }
  if(record.kind==='document'){
    const known=record.timeText!==undefined||Number.isFinite(record.time);
    if(record.domain==='thoughts')return `助手自己的想法 · ${known?'写于 '+when:'写于时间不详'}`;
    if(record.domain==='diary')return `助手自己的日记 · ${known?'写于 '+when:'写于时间不详'}`;
    const title=documentTitle(record);
    return `检索资料 · ${title}${known?' · 写于 '+when:''}`;
  }
  const base=record.kind==='original'?`原话 · ${record.role==='user'?'用户说':record.role==='assistant'?'助手说':'未知说话人'} · ${when}`:`记录 · ${when}`;
  const withQuestion=record.kind==='original'&&record.role==='user'&&/[？?吗呢]$/u.test(String(record.text??'').trimEnd())?
    base+' · 当时的提问':base;
  return record.kind==='original'&&imported?withQuestion+' · 导入':withQuestion;
}
function excerpt(record,query='',offset,expanded=false,profile=queryProfile(query)){
  // Vector readers may already supply a slice. All issued offsets remain in
  // the authorized source's coordinates, including later open/continuation.
  const text=record.text,base=record.anchor?.range?.start??0;
  let start=offset===undefined?undefined:Math.max(0,offset-base);
  if(start===undefined){
    const terms=profile.terms.map(term=>term.slice(2));
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
function rawRecord(source){
  const imported=Boolean(source.import?.batchId),speaker=source.speaker??source.role;
  // Imported records without a written time are stored at timestamp 0; show them as undated, not 1970.
  const undated=imported&&!source.import.timeText;
  return {id:source.id,revision:source.revision,text:source.text,kind:'original',role:source.role,speaker,time:undated?undefined:source.time,
  ...(imported?{imported:true,import:source.import,...source.import.timeText?{timeText:source.import.timeText}:{}}:{}),
  source:{kind:'original',sessionId:source.sessionId,messageId:source.messageId,sequence:source.sequence,turn:source.turn,completion:source.completion,
    ...(imported?{system:source.import.system,recordKind:source.import.kind,batchId:source.import.batchId}:{}),
    ...(source.fragment?{fragment:source.fragment}:{})},
  anchor:{id:source.id,revision:source.revision,ref:source.ref},weight:source.weight??1,...source.hitOffset!==undefined?{hitOffset:source.hitOffset}:{}};}

/** One native answer, one policy grant and one ledger. No capture, model
 * classification, index repair or native-history reads occur in this adapter. */
export function createMemoryQueryAnswer({access,agent,answerTurn,raw,config,vectors,
  now=Date.now,tokenLimits,reranker=null,logger,searchWaitMs,visibleMessageIds,searchKind='search',onSearch,
  keepSignals=false,elapsed=createStopwatch()}={}){
  if(typeof elapsed!=='function')throw new TypeError('需要单调计时方法');
  function readers(request){
    const signal=request.finalizationSignal??request.signal;
    const check=()=>{signal.throwIfAborted();if(!access.validate(request.grant))throw Error('Memory authorization changed');};
    check();const authorize=()=>!signal.aborted&&access.validate(request.grant);
    return {check,authorize,raw:raw.queryReader(request.scope,{authorize})};
  }
  // Reports how long each search took and what it found; no query text or results leave here.
  async function search(request){
    const begun=now(),begunElapsed=elapsed(),coldBefore=vectors?.coldLoads?.()??0;
    let measured;
    request.report=({result,fallback=false,totalMs}={})=>{
      if(typeof onSearch!=='function')return;
      const channels=measured?.channels??{};
      const textMs=channels.originals?.elapsedMs??0;
      const vectorMs=channels.vector?.elapsedMs,vectorTimings=measured?.timings??{};
      const rerankMs=channels.rerank?.ms,reportedTotal=milliseconds(Number.isFinite(totalMs)?totalMs:elapsed()-begunElapsed);
      try{onSearch?.({kind:searchKind,at:new Date(begun).toISOString(),totalMs:reportedTotal,
        state:result?.status??'failed',fallback:fallback===true,records:result?.records?.length??0,
        skippedVisible:measured?._stats?.skippedVisible??0,
        text:{ms:textMs},
        vector:channels.vector?{state:channels.vector.state,ms:Number.isFinite(vectorMs)?vectorMs:0,
          encodeMs:Number.isFinite(vectorTimings.vectorEncodeMs)?vectorTimings.vectorEncodeMs:0,
          searchMs:Number.isFinite(vectorTimings.vectorSearchMs)?vectorTimings.vectorSearchMs:0}:null,
        rerank:channels.rerank?{state:channels.rerank.state,ms:Number.isFinite(rerankMs)?rerankMs:0}:null,
        timings:{totalMs:reportedTotal,textMs,vectorMs:Number.isFinite(vectorMs)?vectorMs:0,
          vectorEncodeMs:Number.isFinite(vectorTimings.vectorEncodeMs)?vectorTimings.vectorEncodeMs:0,
          vectorSearchMs:Number.isFinite(vectorTimings.vectorSearchMs)?vectorTimings.vectorSearchMs:0,
          rerankMs:Number.isFinite(rerankMs)?rerankMs:0},
        cold:(vectors?.coldLoads?.()??0)!==coldBefore});}catch{}
    };
    const offer=request.offer;
    request.offer=value=>{measured=value;offer?.(value);};
    const result=await searchOnce(request);
    const {_stats:stats,...answer}=result;
    measured={...answer,_stats:stats};
    request.offer?.(measured);
    return answer;
  }
  async function searchOnce(request){
    const invocationStarted=elapsed();
    const remainingTime=()=>Math.max(0,request.getRemainingMs?.()??((request.deadline??now())-now()));
    const finalizationReserve=searchFinalizationReserveMs(request.timeoutMs??remainingTime());
    const reader=readers(request),range=timeRange(request),searchProfile=queryProfile(request.query);
    const yieldToVector=()=>new Promise(resolve=>setImmediate(resolve));
    const lanes={
      vector:async lane=>{
        if(!vectors)return {records:[],state:'unavailable'};
        const profile=await request.getProfile();
        lane.signal.throwIfAborted();reader.check();
        if(!profile)return {records:[],state:'unavailable'};
        const text=vectorQueryText(request.query);if(!text)return {records:[]};
        const vectorStarted=elapsed(),result=await vectors.query({grant:request.grant,profile,query:text,signal:lane.signal,
          deadline:lane.deadline,remainingMs:lane.getRemainingMs(),limit:VECTOR_LANE_LIMIT});
        reader.check();
        const vectorMs=milliseconds(elapsed()-vectorStarted);
        return {records:(result.records??[]).filter(record=>!String(record.id??'').startsWith('legacy-note:')&&
          record.anchor?.ref?.storage!=='note'&&record.anchor?.ref?.storage!=='entry'&&record.domain!=='entry'&&
          matches(record,request)&&inTime(record.time,request))
          .map(record=>({...record,_vector:true})),degraded:result.degraded,...result.state==='unavailable'?{state:'unavailable'}:{},
          timings:{...(result.timings??{}),totalMs:Number.isFinite(result.timings?.totalMs)?result.timings.totalMs:vectorMs}};
      },
      originals:async()=>{if(vectors)await yieldToVector();const page=reader.raw.search({query:request.query,...range,limit:40});return {records:page.sources.map(rawRecord),degraded:page.partial};},
    };
    const result=await runMemoryQueryLanes({lanes,deadline:now()+remainingTime(),signal:request.signal,now,elapsed,
      reserveMs:finalizationReserve});reader.check();
    if(Object.values(result.channels).some(channel=>channel.state==='timeout')&&
      Object.values(result.results).every(channel=>!channel.records?.length)){
      throw Object.assign(Error('Memory query lanes timed out without records'),{memorySearchCode:'TIMEOUT'});
    }
    const ranked=new Map();let skippedVisible=0;
    for(const channel of Object.values(result.results))channel.records.forEach((record,index)=>{
      if(!isSearchableOriginal(record))return;
      if(Number.isSafeInteger(answerTurn)&&record.kind==='original'&&record.source?.sessionId===agent.session.id&&record.source.turn===answerTurn)return;
      // Lines the model can already read in this conversation would only take a slot from older memory.
      if(visibleMessageIds?.size&&record.kind==='original'&&record.source?.sessionId===agent.session.id&&visibleMessageIds.has(record.source.messageId)){skippedVisible++;return;}
      const key=JSON.stringify([record.id,record.revision]),item=ranked.get(key)??{};
      const rank=(record.weight??1)/(60+index+1),kind=record._vector?'vector':'text';
      item[kind]={record,rank:(item[kind]?.rank??0)+rank};ranked.set(key,item);
    });
    const ordered=()=>[...ranked.values()].flatMap(item=>{
      const {text,vector}=item;
      if(vector&&!request.hasSeen(vector.record))return [{item,record:vector.record,rank:vector.rank+(text?.rank??0)}];
      return text?[{item,...text}]:[];
    }).sort(compareRank);
    const materialize=rows=>rows.map(({record,rank,item,_rerankScore})=>{
      const lanes=[...(item.text?['text']:[]),...(item.vector?['vector']:[])];
      const similarity=Number.isFinite(item.vector?.record?.similarity)?item.vector.record.similarity:null;
      const signals={lexical:lexicalMatchTerms(searchProfile,new Set(lexicalTerms(record.text))),similarity,
        rerank:Number.isFinite(_rerankScore)?_rerankScore:null,lanes};
      const primary=excerpt({...record,_signals:signals},request.query,undefined,false,searchProfile);
      const fallback=record._vector&&item.text?{...item.text,record:{...item.text.record,_signals:signals}}:undefined;
      return {...primary,_rank:rank,...fallback?{_textFallback:fallback}:{}};
    });
    const degraded=result.degraded;
    let list=ordered();
    // Optional rerank: reorders only the leading candidates; any failure keeps the fused order.
    // An unconfigured reranker leaves the result exactly as before, without a channel entry.
    let rerank;
    if(reranker?.status?.().enabled){
      const candidateLimit=searchKind==='prefetch'?config.prefetchRerankCandidates??16:config.memoryRerankCandidates??30;
      const documentLimit=searchKind==='prefetch'?500:1000;
      const candidates=list.filter(({record})=>record.text.trim()).slice(0,candidateLimit);
      rerank={state:'disabled',candidates:candidates.length};
      const budget=Math.min(config.memoryRerankTimeoutMs??1500,Math.max(0,remainingTime()-finalizationReserve));
      if(candidates.length<2||!String(request.query??'').trim())rerank.state='skipped';
      else if(!reranker.enabled())rerank.state=reranker.status().state==='paused'?'paused':'disabled';
      else if(budget<200)rerank.state='no_time';
      else{
        const draftVector=result.results.vector?.timings??{},draftTextMs=result.channels.originals?.elapsedMs??0,
          draftVectorMs=result.channels.vector?.elapsedMs??0;
        request.offer?.({records:materialize(list),channels:result.channels,degraded,
          timings:{totalMs:milliseconds(elapsed()-invocationStarted),textMs:draftTextMs,vectorMs:draftVectorMs,
            vectorEncodeMs:Number.isFinite(draftVector.encodeMs)?draftVector.encodeMs:0,
            vectorSearchMs:Number.isFinite(draftVector.searchMs)?draftVector.searchMs:0,rerankMs:0},
          coverage:{complete:!degraded},_stats:{skippedVisible}});
        const timeout=AbortSignal.timeout(Math.ceil(budget)),rerankStart=elapsed();
        try{
          const ranked=await reranker.rerank({query:request.query,documents:candidates.map(({record})=>rerankDocumentText(record.text,documentLimit)),
            signal:AbortSignal.any([request.signal,timeout])});
          if(!Array.isArray(ranked)||ranked.some(row=>!Number.isInteger(row?.index)||row.index<0||row.index>=candidates.length||!Number.isFinite(row.score))||
            new Set(ranked.map(row=>row.index)).size!==ranked.length)throw Error('Invalid rerank result');
          const scores=new Map(ranked.map(row=>[candidates[row.index],row.score]));
          const scored=candidates.filter(entry=>scores.has(entry)).sort((left,right)=>scores.get(right)-scores.get(left));
          const reordered=[...scored,...candidates.filter(entry=>!scores.has(entry))];
          // Keep the model-ranked sequence while carrying each absolute score for prefetch gating.
          const reranked=reordered.map((entry,index)=>({...entry,rank:1+(reordered.length-index)/reordered.length,
            ...scores.has(entry)?{_rerankScore:scores.get(entry)}:{}}));
          list=[...reranked,...list.filter(entry=>!candidates.includes(entry))];
          rerank.state='applied';rerank.ms=milliseconds(elapsed()-rerankStart);
        }catch(error){
          if(request.signal.aborted)throw error;
          rerank.ms=milliseconds(elapsed()-rerankStart);
          rerank.state=error?.code==='RERANK_UNAVAILABLE'?'disabled':error?.code==='RERANK_PAUSED'?'paused':
            error?.code==='RERANK_TIMEOUT'||timeout.aborted?'timeout':'failed';
          logger?.warn?.('[memory-rerank] '+rerank.state+(Number.isFinite(error?.httpStatus)?' http='+error.httpStatus:''));
        }
      }
    }
    const weighted=list.map(entry=>({...entry,
      rank:entry.rank*(entry.record.role==='summary'?SUMMARY_RERANK_WEIGHT:1)}))
      .sort(compareRank);
    const records=materialize(weighted);
    const channels={...result.channels,...rerank?{rerank}:{}};
    const vectorTimings=result.results.vector?.timings??{},textMs=channels.originals?.elapsedMs??0,
      vectorMs=channels.vector?.elapsedMs??0;
    return {records,channels,degraded,timings:{totalMs:milliseconds(elapsed()-invocationStarted),textMs,
      vectorMs,vectorEncodeMs:Number.isFinite(vectorTimings.encodeMs)?vectorTimings.encodeMs:0,
      vectorSearchMs:Number.isFinite(vectorTimings.searchMs)?vectorTimings.searchMs:0,rerankMs:rerank?.ms??0},
      coverage:{complete:!degraded},
      _stats:{skippedVisible}};
  }
  async function expand(request){
    const reader=readers(request),ref=request.anchor.ref;let record;
    if(vectors&&ref?.storage==='document'){
      const resolved=await vectors.resolveDocument({grant:request.grant,id:request.id,revision:request.revision,signal:request.signal});
      record=Array.isArray(resolved)?resolved.find(row=>row.id===request.id):resolved;
      if(record&&(!matches(record,request)||!inTime(record.time,request)))record=null;
      if(record)record={...record,_vector:true};
    }
    if(!record&&ref&&ref.storage!=='note'){
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
      const proof=request.anchor.embedding&&source?rawEmbeddingMaterial(reader.raw,source)?.proof:null;
      const context=(proof?.sources??[]).map(item=>reader.raw.get(item.ref)).filter(Boolean);
      for(const source of [...context,...reader.raw.neighbors(ref)])if(!seen.has(source.id)){
        seen.add(source.id);records.push(excerpt(rawRecord(source),'',0,true));
      }
    }
    return {records,channels:{source:{state:'ready'}},degraded:false};
  }
  const actualDevice=raw.status?.().backend?.actualDevice;
  return createMemorySearchSession({policy:access,agent,tokenLimits:tokenLimits??{},keepSignals,
    searchWaitMs:searchWaitMs??queryWaitFor(config,actualDevice),now,elapsed,search,expand,
    validateResult(result,request){
      const reader=readers(request);
      function current(record){
        if(record.kind==='original'){
          const source=reader.raw.get(record.anchor.ref);
          if(!currentRawContext(reader.raw,source,record.anchor))return false;
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
        return [{...fallback.record,_rank:result.channels.rerank?.state==='applied'?record._rank:fallback.rank,
          ...record._signals?{_signals:record._signals}:{}}];
      });
      if(fallbacks)records.sort((a,b)=>compareRank({record:a,rank:a._rank},{record:b,rank:b._rank}));
      const removed=result.records.length-records.length;
      const publicRecords=records.map(publicRawContext);
      if(!removed&&!fallbacks)return {...result,records:publicRecords};
      return {...result,records:publicRecords,degraded:true,channels:{...result.channels,sourceValidation:{state:'source_changed',removed,...fallbacks?{fallbacks}:{}}},
        coverage:{...result.coverage,complete:false}};
    },
    getProfile({grant,signal}){return vectors?vectors.getSnapshot({grant,signal}):null;},
    async recent(request){const reader=readers(request);return {records:reader.raw.recent({limit:40}).map(source=>excerpt(rawRecord(source),'',0)),channels:{originals:{state:'ready'}}};},
  });
}

export function createMemoryQueryTools({answer}){
  const filters={since:{type:'string',description:'ISO 时间下界'},until:{type:'string',description:'ISO 时间上界'}};
  const limit={type:'integer',description:'最多返回10条；搜索、展开、近期读取同轮合计4次、约4K tokens'};
  return [
    {name:'memory_search',description:'仅在缺少会改变答案的历史依据时搜索已开启的个人记忆。先看当前对话、接续和已有材料；材料够用就直接回答。闲聊、通用建议、按眼前条件排期或改写不查。明确回忆或核对，或者确实缺少关键历史信息时，先做一次聚焦搜索，读完结果再决定是否补查。label 说明它是原话还是旧笔记、谁说的、何时说的。需要核对原话、冲突或归属时，用 memory_open 展开相关 ref。只把结果里实际写到的内容当事实；本轮如附有记忆使用规则，照规则回答。搜索约 1K tokens，可能未查全。',parameters:{query:{type:'string',required:true},limit,...filters},run:'search'},
    {name:'memory_open',description:'核对 memory_search/memory_recent 已返回的 ref（结果里的短编号），展开同版本原文、保存的同回合上下文及关联的有限前文，或旧笔记及依据。前文帮助理解原话，不保证每条都参与了该分块的向量编码。背景与正文各保留原说话者和来源，不能将助手建议当成用户陈述。单次约2K tokens；返回续页 ref（结果里的短编号）后可继续。不得编造 ref。',parameters:{ref:{type:'string',required:true}},run:'expand'},
    {name:'memory_recent',description:'按需查看最近保存的双方原文。与搜索、展开共用本回答的调用及返回额度；自动短期接续独立处理。',parameters:{limit},run:'recent'},
  ].map(({run,...tool})=>({...tool,output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
    async execute(args,exec){return answer(exec.agent)[run](args,{signal:exec.signal});}}));
}

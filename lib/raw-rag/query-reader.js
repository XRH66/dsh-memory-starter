import {sourceIdentity} from '../unified/contract.js';
import {lexicalMatch, textQuery} from './lexical.js';
import {canonicalTurnId,legacyMessageMatch,sameSourceVersion} from './store.js';

/** Format only approved text. Offsets address the untouched original message. */
export function displayOriginalSource(source){
  const {fragment}=source;
  if(!fragment)return source.text;
  const text=source.evidenceText??source.text;
  if(fragment.kind==='selected-message')return `[本轮选中消息；完整原件保留]\n${text}`;
  return fragment.ranges.map(({start,end,textStart,textEnd},index)=>{
    const gap=index>0&&start>fragment.ranges[index-1].end?'；与前段不连续':'';
    return `[原文片段 UTF-16 [${start}, ${end})${gap}；完整原件保留]\n${text.slice(textStart,textEnd)}`;
  }).join('\n');
}

/** Read adapter over the one original authority and its older text projections.
 * Reads never repair vectors, scan the Vault, or admit native history. */
export function createRawQueryReader(memory,scope,{authorize}){
  const check=()=>{if(typeof authorize!=='function'||authorize()!==true)throw Object.assign(Error('Raw query authorization changed'),{code:'MEMORY_NOT_AUTHORIZED'});};
  const visible=source=>memory.messageVisibility(scope.ownerSubject,source.sessionId,source.messageId);
  const publicMessage=source=>{
    const visibility=visible(source);if(!visibility.eligible||source.withdrawn)return null;
    return {id:source.id,revision:source.revision,role:source.role,text:source.text,time:source.time??source.recordedAt,
      timeKind:source.timeKind,sessionId:source.sessionId,messageId:source.messageId,sequence:source.sequence,turn:source.turn,
      completion:source.turnState,changeKind:source.processingContext?.changeKind,weight:visibility.weight,
      ref:{storage:'message',id:source.id,revision:source.revision}};
  };
  function fromTurns(turns,{query='',vector=false,messageId=''}={}){
    check();const sources=[];
    for(const turn of turns){
      // Re-read the exact saved projection version after any asynchronous lane.
      const live=memory.loadTurns([{turnId:turn.turnId,sourceVersion:turn.sourceVersion}],{scope:scope.ownerSubject})[0];
      if(!live)continue;
      for(const message of live.messages){
        if(messageId&&message.id!==messageId)continue;
        // Whole-turn window scores and offsets do not describe a scoped span.
        if(vector&&message.fragment)continue;
        const matched=vector&&turn.matchedRanges?.filter(range=>range.end>message.docStart&&range.start<message.docEnd);
        if(vector&&turn.matchedRanges?.length&&!matched.length)continue;
        let id;try{id=sourceIdentity({sessionId:live.sessionId,messageId:message.id});}catch{continue;}
        const canonical=memory.messages.get({...scope,id,includeWithdrawn:true});
        let source;
        if(canonical){
          if(vector&&(canonical.text!==message.text||canonical.role!==message.role||canonical.sequence!==message.seq))continue;
          source=publicMessage(canonical);
        }else source={id,revision:live.sourceVersion,role:message.role,text:displayOriginalSource(message),time:message.ts||live.completedAt,timeKind:'legacy',
          sessionId:live.sessionId,messageId:message.id,sequence:message.seq,turn:live.turn,completion:'completed',weight:live.weight,
          ...(message.fragment?{fragment:message.fragment,evidenceText:message.text}:{}),
          ref:{storage:'legacy',id,revision:live.sourceVersion,turnRevision:live.turnRevision??live.sourceVersion,
            ...(live.scopeViewRevision===undefined?{}:{scopeViewRevision:live.scopeViewRevision}),
            turnId:live.turnId,sessionId:live.sessionId,messageId:message.id}};
        if(!source||!source.text)continue;
        const score=query?(canonical?lexicalMatch(query,source.text):legacyMessageMatch(query,message)):1;
        if(query&&!vector&&!score)continue;
        sources.push({...source,score:vector?turn.fusion??turn.score??1:score,
          ...matched?.length?{hitOffset:Math.max(0,matched[0].start-message.docStart)}:{}});
      }
    }
    return sources;
  }

  function canonicalWithReviewedProjection(query,since,until){
    const parsed=textQuery(query);
    if(!parsed)return [];
    // A canonical save can own a message whose old projection is still bound
    // to a legacy turn. Its search must not depend on the legacy span's text.
    const rows=memory.db.prepare(`SELECT m.id FROM raw_messages m
      JOIN raw_message_versions v ON v.namespace=m.namespace AND v.owner=m.owner AND v.project=m.project AND v.id=m.id AND v.revision=m.revision
      JOIN turn_messages tm ON tm.namespace=m.namespace AND tm.message_id=m.message_id
      JOIN turns t ON t.namespace=tm.namespace AND t.turn_id=tm.turn_id AND t.scope=m.owner AND t.session_id=m.session_id
      JOIN legacy_scope_views sv ON sv.namespace=t.namespace AND sv.scope=t.scope AND sv.turn_id=t.turn_id
      WHERE m.namespace=? AND m.owner=? AND m.project=? AND m.withdrawn=0 AND sv.ranges_json IS NOT NULL
        AND COALESCE(json_extract(v.core_json,'$.time'),v.recorded_at) BETWEEN ? AND ?
        AND EXISTS(SELECT 1 FROM json_each(?) term WHERE instr(memory_nfkc(json_extract(v.core_json,'$.text')),term.value)>0)`)
      .all(memory.namespace,scope.ownerSubject,scope.project,since,until,JSON.stringify(parsed.terms.map(term=>term.slice(2))));
    return rows.flatMap(({id})=>{
      const current=memory.messages.get({...scope,id});
      const source=current&&publicMessage(current),score=source?lexicalMatch(query,source.text):0;
      return score?[{...source,score}]:[];
    });
  }

  function get(ref){
    check();
    if(ref.storage==='message'){
      const source=memory.messages.get({...scope,id:ref.id,revision:ref.revision});return source?.isCurrent?publicMessage(source):null;
    }
    if(ref.storage!=='legacy')return null;
    if(memory.messages.get({...scope,id:ref.id,includeWithdrawn:true}))return null;
    const turns=memory.loadTurns([{turnId:ref.turnId,sourceVersion:ref.revision}],{scope:scope.ownerSubject});
    const source=fromTurns(turns,{messageId:ref.messageId}).find(item=>item.id===ref.id&&item.messageId===ref.messageId);
    if(!source)return null;
    // Resolve with the caller's stable version so a document anchor can be
    // checked without rewriting the locator stored in the vector archive.
    return {...source,revision:ref.revision,ref:{...source.ref,turnId:ref.turnId,revision:ref.revision,
      ...(ref.turnRevision!==undefined?{turnRevision:ref.turnRevision}:{})}};
  }

  function embeddingSlots(sessionId,turn){
    const canonical=memory.messages.embeddingSlots({...scope,sessionId,turn});
    const sequences=new Map(canonical.map(slot=>[slot.ref.id,slot.sequence]));
    const legacy=memory.embeddingLegacySlots(scope.ownerSubject,sessionId,turn).flatMap(({turnId,messageId,sequence,revision})=>{
      let id;try{id=sourceIdentity({sessionId,messageId});}catch{return [{sequence,ref:null}];}
      if(sequences.get(id)===sequence)return [];
      // The legacy writer defaulted missing sequence numbers to zero.
      return [{sequence:sequence===0?null:sequence,ref:{storage:'legacy',id,revision,turnId,sessionId,messageId}}];
    });
    return [...canonical,...legacy];
  }

  function embeddingContext(ref,{limit=4}={}){
    if(ref.storage==='legacy'&&canonicalTurnId(ref.turnId)?.startsWith('message:')){
      check();return [];
    }
    const center=get(ref);
    if(!Number.isSafeInteger(limit)||limit<0)throw Error('Invalid embedding context limit');
    if(!center?.text.trim()||!Number.isSafeInteger(center.turn)||center.turn<0||!limit)return [];
    const capacity=Math.min(4,limit),context=[];
    let next=center,nextSlot;
    turns:for(let turn=center.turn;turn>=Math.max(0,center.turn-1);turn--){
      const slots=embeddingSlots(center.sessionId,turn);
      if(turn===center.turn){
        nextSlot=slots.find(slot=>slot.ref?.storage===center.ref.storage&&slot.ref.id===center.id&&sameSourceVersion(slot.ref.revision,center.revision));
        if(!nextSlot||!Number.isSafeInteger(nextSlot.sequence))break;
      }
      const earlier=slots.filter(slot=>turn!==center.turn||slot.sequence<center.sequence).sort((a,b)=>b.sequence-a.sequence);
      for(const [index,slot] of earlier.entries()){
        if(!slot.ref||!Number.isSafeInteger(slot.sequence)||slot.sequence===earlier[index+1]?.sequence
          ||slot.intervalId&&nextSlot.intervalId&&slot.intervalId!==nextSlot.intervalId)break turns;
        const gap=nextSlot.sequence-slot.sequence;
        const sameInterval=typeof slot.intervalId==='string'&&slot.intervalId.length>0&&slot.intervalId===nextSlot.intervalId;
        const turnBoundary=turn!==next.turn;
        // Native seq counts every host event. A shared recording interval
        // permits gaps between adjacent saved slots; old slots keep the narrow
        // sequence checks when their shared interval cannot be proven.
        const legacyBoundary=!sameInterval&&turnBoundary&&gap===3&&next.role==='user';
        if(gap<=0||(!sameInterval&&gap!==1&&!legacyBoundary))break turns;
        const needsCompletion=turnBoundary&&(sameInterval||legacyBoundary);
        const source=get(slot.ref);
        if(!source?.text.trim()||source.turn!==turn||source.sessionId!==center.sessionId||source.sequence!==slot.sequence
          ||needsCompletion&&source.completion!=='completed'
          ||legacyBoundary&&source.role!=='assistant')break turns;
        context.push(source);
        if(context.length===capacity)break turns;
        next=source;nextSlot=slot;
      }
    }
    check();return context.reverse();
  }

  return {
    fromTurns,
    get,
    embeddingContext,
    legacyPage({after='',limit=100}={}){
      check();if(typeof after!=='string'||!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('Invalid legacy source page');
      after=canonicalTurnId(after);
      const rows=memory.db.prepare(`SELECT t.turn_id FROM turns t JOIN turn_visibility v ON v.namespace=t.namespace AND v.turn_id=t.turn_id
        WHERE t.namespace=? AND t.scope=? AND t.turn_id>? AND v.excluded=0 AND v.source_hidden=0 AND v.weight>0
        ORDER BY t.turn_id LIMIT ?`).all(memory.namespace,scope.ownerSubject,after,limit);
      const sources=fromTurns(memory.loadTurns(rows.map(row=>row.turn_id),{scope:scope.ownerSubject})).filter(source=>source.ref.storage==='legacy');
      check();return {sources,nextAfter:rows.length===limit?rows.at(-1).turn_id:null};
    },
    search({query,since=0,until=Number.MAX_SAFE_INTEGER,limit=40}){
      check();
      const hits=memory.searchText(query,{scope:scope.ownerSubject,since,asOf:until,limit}),turns=memory.loadTurns(hits,{scope:scope.ownerSubject,since,asOf:until});
      const indexed=fromTurns(turns,{query}),pending=memory.messages.searchPending({...scope,query,since,until,limit});
      const merged=new Map(indexed.map(source=>[source.id,source]));
      for(const source of canonicalWithReviewedProjection(query,since,until))merged.set(source.id,source);
      for(const item of pending.sources){const source=publicMessage(item);if(source)merged.set(source.id,{...source,score:item.lexicalScore});}
      const sources=[...merged.values()].filter(source=>source.time>=since&&source.time<=until)
        .sort((a,b)=>b.score*b.weight-a.score*a.weight||b.time-a.time).slice(0,limit);
      check();return {sources,partial:pending.partial};
    },
    recent({limit=40,since=0,until=Number.MAX_SAFE_INTEGER}={}){
      check();const indexed=fromTurns(memory.recentTurns(scope.ownerSubject,{limit,since,until})),merged=new Map(indexed.map(source=>[source.id,source]));
      for(const item of memory.messages.recentSources({...scope,limit:Math.min(100,limit),since,until})){const source=publicMessage(item);if(source)merged.set(source.id,source);}
      return [...merged.values()].sort((a,b)=>b.time-a.time||b.sequence-a.sequence).slice(0,limit);
    },
    neighbors(ref){
      const source=this.get(ref);if(!source)return [];
      if(ref.storage==='message')return memory.messages.forTurn({...scope,sessionId:source.sessionId,turn:source.turn}).map(publicMessage).filter(Boolean);
      const turns=memory.loadTurns([{turnId:ref.turnId,sourceVersion:ref.revision}],{scope:scope.ownerSubject});return fromTurns(turns);
    },
  };
}

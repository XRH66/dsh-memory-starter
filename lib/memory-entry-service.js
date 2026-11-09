import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {withCommitLock} from './coordinator.js';
import {normalizeSemanticEntry,memoryEntryMetadata,readMemoryEntry,historicalMemoryEntryMetadata} from './memory-entry.js';
import {memoryDirectory,sanitizeMemoryTitle} from './memory.js';
import {MEMORY_ENTRY_TYPES,MEMORY_VALIDITY,MEMORY_PROGRESS} from './memory-contract.js';
import {carryPriority,reinforcePriorityPatch,isStrongCue} from './priority.js';
import {topicFileNames,topicPageContent,topicPageMetadata,topicsDirectory,withEntryTopics} from './entry-links.js';

const START='<!-- dsh-memory-entry:start -->',END='<!-- dsh-memory-entry:end -->';
const body=content=>{
  const start=content.indexOf(START),end=content.indexOf(END);
  if(start<0||end<start||content.indexOf(START,start+START.length)>=0||content.indexOf(END,end+END.length)>=0)throw Error('Managed entry block is missing or ambiguous');
  return {start:start+START.length,end,text:content.slice(start+START.length,end).replace(/^\r?\n|\r?\n$/g,'')};
};
function decoded(note){
  const managed=body(note.content);
  return {...readMemoryEntry({metadata:note.metadata,content:managed.text}),id:note.metadata.memory_entry_id,
    permalink:note.permalink,filePath:note.file_path??null,revision:String(note.checksum),title:note.title,
    bodyOperationId:note.metadata.memory_body_operation_id??note.metadata.memory_operation_id??null,
    priorityMetadata:{...carryPriority(note.metadata),recorded_at:note.metadata.recorded_at??note.metadata.created,memory_type:note.metadata.memory_type,importance:note.metadata.importance}};
}

/** Stable program-owned identities, guarded Markdown commits and rebuildable
 * metadata. Producers supply their one semantic result, never extra classifiers.
 * The factory does not open a backend or scan a library. */
export function createMemoryEntryService({scope,config,repository,backend,sourceState,getPriorityConfig=()=>config,logger=console}){
  if(!scope?.ownerSubject||!scope.project||typeof repository!=='function'||typeof sourceState!=='function')throw Error('Entry scope, repository and source resolver required');
  const repo=()=>repository();
  const currentSource=(ref,context)=>{
    const current=sourceState(ref,context);
    return Boolean(current&&current.id===ref.id&&current.revision===ref.revision&&current.isCurrent!==false&&!current.withdrawn&&
      current.ownerSubject===scope.ownerSubject&&current.project===scope.project&&(!ref.role||current.role===ref.role));
  };
  function guard(context,refs=[]){
    context.check();
    for(const ref of refs)if(!currentSource(ref,context))throw Object.assign(Error('Entry source revision changed'),{code:'MEMORY_SOURCE_CHANGED'});
  }
  const directory=memoryDirectory(config,'fact').replace(/\/facts$/,'/entries');
  const topicDirectory=topicsDirectory('chats/entries');
  async function ensureTopicPages(tags,context){
    for(const name of topicFileNames(tags)){
      try{
        await backend.write({title:name,directory:topicDirectory,content:topicPageContent(name),
          tags:topicPageMetadata(name).tags,metadata:topicPageMetadata(name),overwrite:false},context);
      }catch(error){
        if(error?.code==='MEMORY_WRITE_CONFLICT'||/already exists/i.test(String(error?.message??error)))continue;
        logger?.warn?.('[memory-entry] topic page write failed: '+name+' ('+String(error?.code??error?.message??error)+')');
      }
    }
  }
  // The Markdown file's size+mtime when it was projected. A later difference means someone edited
  // the note outside the system, so search falls back to the authoritative read for that entry.
  const fileStamp=filePath=>{
    if(!config.vaultPath||!filePath)return null;
    try{const stat=fs.statSync(path.join(config.vaultPath,filePath));return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;}catch{return null;}
  };
  const projectNote=(note,context)=>{
    context.check();const entry=decoded(note);if(!entry.id)throw Error('Structured note lacks its stable identity');
    repo().project({...scope,id:entry.id,permalink:note.permalink,revision:note.checksum,entry:{...entry,fileStamp:fileStamp(entry.filePath)}});return entry;
  };
  async function read(id,context,{note:loaded}={}){
    guard(context);const item=repo().get({...scope,id});if(!item)return null;
    // Reuse only this parse's already-read, identical registered note. A moved
    // locator or changed revision follows the authoritative read path.
    const reusable=loaded?.metadata?.memory_entry_id===id&&loaded.checksum&&String(loaded.checksum)===String(item.revision)
      &&loaded.permalink===item.permalink&&(!item.filePath||loaded.file_path===item.filePath);
    const note=reusable?loaded:await backend.read(item.filePath??item.permalink,context);
    context.check();if(!note){repo().remove({...scope,id});return null;}
    if(note.metadata.memory_entry_id!==id)throw Object.assign(Error('Structured note identity changed'),{code:'MEMORY_ENTRY_ID_CHANGED'});
    const entry=projectNote(note,context),operationId=note.metadata.memory_body_operation_id??note.metadata.memory_operation_id;
    const baseline=operationId?repo().operation({...scope,operationId}):null;
    const manualBody=Boolean(baseline&&entry.content!==baseline.payload.entry.content),staleRefs=entry.source_refs.filter(ref=>!currentSource(ref,context));
    return {...entry,sourceStatus:{eligible:manualBody||staleRefs.length===0,manualBody,staleRefs}};
  }
  /** Retrieval from the local projection: no Basic Memory read. memory_open still uses read(). */
  async function search(query,filters,context){
    guard(context);
    const found=repo().search({...scope,...filters,query,limit:filters?.limit??20}),results=[];
    for(const item of found){
      const stamp=fileStamp(item.filePath);
      if(!item.content||!stamp||stamp!==item.fileStamp){const fresh=await read(item.id,context);if(fresh)results.push(fresh);continue;}
      results.push(item);
    }
    return results.map(item=>{if(item.sourceStatus)return item;
      const operationId=item.bodyOperationId;
      const baseline=operationId?repo().operation({...scope,operationId}):null;
      const manualBody=Boolean(baseline&&item.content!==baseline.payload.entry.content),staleRefs=(item.source_refs??[]).filter(ref=>!currentSource(ref,context));
      return {...item,sourceStatus:{eligible:manualBody||staleRefs.length===0,manualBody,staleRefs}};
    });
  }
  async function commitLocked(input,context){
      guard(context);
      if(typeof input.operationId!=='string'||!input.operationId.trim())throw Error('Program operation identity required');
      let op=repo().operation({...scope,operationId:input.operationId});
      if(!op){
        if(input.target&&(!input.target.id||!input.target.revision))throw Error('Target identity and revision required');
        const previous=input.target?await read(input.target.id,context):null;
        if(input.target&&!previous)throw Error('Target entry is unavailable');
        const entry=normalizeSemanticEntry(input.proposed,{sources:input.sources,subjects:input.subjects,previous});
        if(entry.content.includes(START)||entry.content.includes(END))throw Error('Reserved entry marker in semantic output');
        guard(context,entry.source_refs);
        const id=previous?.id??randomUUID(),title=previous?.title??sanitizeMemoryTitle(entry.content.split(/\r?\n/)[0].slice(0,44)+' '+id.slice(0,8));
        const payload={id,title,directory,entry,target:input.target??null,allowReplacement:input.allowReplacement===true,historyId:randomUUID(),
          ...(input.reinforcement?{reinforcement:input.reinforcement}:{})};
        op=repo().prepare({...scope,operationId:input.operationId,payload});
      }
      const {payload}=op,refs=payload.entry.source_refs;
      if(op.state==='rejected')return {...op.result,duplicate:true};
      guard(context,refs);
      if(op.state==='committed')return {...op.result,duplicate:true};
      if(op.state==='review')return op.result;
      // A prepared operation owns its identity and semantic payload across
      // retries; it must never be replaced by a later model response.
      const check=()=>guard(context,refs),execution={...context,check};
      const target=payload.target?repo().get({...scope,id:payload.id}):null;
      let current=await backend.read(target?.filePath??target?.permalink??payload.directory+'/'+payload.title+'.md',execution);
      const {archive:pendingArchive,...storedPayload}=payload;
      const review=reason=>{
        check();const result={state:'review',reason,operationId:input.operationId,id:payload.id,permalink:current?.permalink??target?.permalink??null,currentRevision:current?.checksum??null};
        repo().checkpoint({...scope,operationId:input.operationId,state:'review',result,payload:storedPayload});return result;
      };
      const commitReceipt=async(note,archive,extra={})=>{
        if(archive){
          const {title,directory,parentId,...fields}=archive;
          let history=await backend.read(directory+'/'+title+'.md',execution);
          if(!history){
            const saved=await backend.write({title,directory,...fields,overwrite:false},execution);
            history=await backend.read(saved.file_path??saved.permalink,execution);
          }
          if(history?.metadata.memory_parent_id!==parentId||history.metadata.memory_operation_id!==input.operationId)
            throw Error('历史条目回读不一致');
          projectNote(history,execution);
        }
        const entry=projectNote(note,execution);
        await ensureTopicPages(entry.tags,execution);
        const result={state:'committed',id:entry.id,permalink:entry.permalink,revision:entry.revision,...extra};
        repo().checkpoint({...scope,operationId:input.operationId,state:'committed',result,payload:storedPayload});
        return result;
      };
      if(current&&(current.metadata.memory_operation_id===input.operationId||current.metadata.memory_reinforcement_operation_id===input.operationId)){
        if(current.metadata.memory_entry_id!==payload.id)return review('note-identity-changed');
        const reinforced=current.metadata.memory_reinforcement_operation_id===input.operationId;
        return commitReceipt(current,pendingArchive,{recovered:true,...(reinforced?{reinforced:true,metadataOnly:true}:{})});
      }
      if(op.state==='writing')return review('write-outcome-unknown');
      if(payload.reinforcement){
        if(!current||current.metadata.memory_entry_id!==payload.id||String(current.checksum)!==payload.target?.revision)
          return review('target-revision-changed');
        const existing=decoded(current),source=refs.length===1?sourceState(refs[0],context):null;
        const quote=payload.reinforcement;
        const sourceTime=source?.time??source?.recordedAt;
        const confirmed=source?.role==='user'&&typeof quote==='string'&&quote.length>=8&&source.text?.includes(quote)&&
          existing.content===payload.entry.content&&existing.state.validity==='current'&&isStrongCue(quote,existing.content)&&Number.isFinite(sourceTime);
        const priority=await getPriorityConfig();check();
        const patch=confirmed?reinforcePriorityPatch(current.metadata,{...priority,now:sourceTime}):null;
        let entry=existing;
        if(patch){
          repo().checkpoint({...scope,operationId:input.operationId,state:'writing'});
          const metadata={...patch,memory_reinforcement_operation_id:input.operationId};
          let saved;
          try{saved=await backend.edit({identifier:current.file_path??current.permalink,operation:'append',content:'',expected_checksum:String(current.checksum),metadata},execution);}
          catch(error){if(error.code==='MEMORY_WRITE_CONFLICT')return review('backend-write-conflict');throw error;}
          const fresh=await backend.read(saved.file_path??saved.permalink,execution);
          if(!fresh||fresh.content!==current.content||fresh.metadata.memory_reinforcement_operation_id!==input.operationId)throw Error('强化写入回读不一致');
          entry=projectNote(fresh,execution);
        }
        const result={state:'committed',id:entry.id,permalink:entry.permalink,revision:entry.revision,reinforced:Boolean(patch),metadataOnly:true};
        repo().checkpoint({...scope,operationId:input.operationId,state:'committed',result});
        return result;
      }
      let archive;
      if(payload.target){
        if(!current||String(current.checksum)!==String(payload.target.revision))return review('target-revision-changed');
        let before;try{before=decoded(current);}catch{return review('managed-body-changed');}
        if(before.id!==payload.id)return review('note-identity-changed');
        const meaningChanged=before.content!==payload.entry.content||!isDeepStrictEqual(before.importance,payload.entry.importance);
        if(meaningChanged&&!payload.allowReplacement)return review('content-or-importance-conflict');
        // Keep a durable copy until the conditional edit succeeds. A refused
        // edit must not leave a separate searchable history note behind.
        const metadata={embed:false,...memoryEntryMetadata({...before,state:{...before.state,validity:'historical'}},current.metadata),...historicalMemoryEntryMetadata(current.metadata),
          memory_entry_id:payload.historyId,memory_parent_id:payload.id,memory_operation_id:input.operationId,
          memory_body_operation_id:current.metadata.memory_body_operation_id??current.metadata.memory_operation_id};
        archive={title:'历史 '+payload.historyId,directory:memoryDirectory(config,'history'),parentId:payload.id,content:current.content,tags:before.tags,metadata};
      }else if(current)return review('create-target-exists');
      const metadata={...memoryEntryMetadata(payload.entry,current?.metadata),memory_entry_id:payload.id,memory_operation_id:input.operationId,memory_body_operation_id:input.operationId,source_plugin:'dsh-basic-memory-bridge'};
      if(!current)metadata.recorded_at=new Date().toISOString();
      check();repo().checkpoint({...scope,operationId:input.operationId,state:'writing',...(archive?{payload:{...payload,archive}}:{})});
      let saved;
      try{
        if(current){
          const span=body(current.content);
          const nextContent=withEntryTopics(current.content.slice(0,span.start-START.length)+`${START}\n${payload.entry.content}\n${END}`+
            current.content.slice(span.end+END.length),payload.entry.tags);
          saved=await backend.edit({identifier:current.file_path??current.permalink,operation:'find_replace',
            find_text:current.content,content:nextContent,
            expected_replacements:1,expected_checksum:String(current.checksum),metadata},execution);
        }else saved=await backend.write({title:payload.title,directory:payload.directory,
          content:withEntryTopics(`# ${payload.title}\n\n${START}\n${payload.entry.content}\n${END}\n`,payload.entry.tags),
          tags:payload.entry.tags,metadata,overwrite:false},execution);
      }
      catch(error){if(error.code==='MEMORY_WRITE_CONFLICT')return review('backend-write-conflict');throw error;}
      check();const note=await backend.read(saved.file_path??saved.permalink,execution);if(!note)throw Error('Committed entry cannot be read back');
      if(note.metadata.memory_entry_id!==payload.id||note.metadata.memory_operation_id!==input.operationId)throw Error('条目写入回读不一致');
      return commitReceipt(note,archive);
  }
  const commit=(input,context)=>withCommitLock(()=>commitLocked(input,context));
  const pending=op=>op?.state==='review'||op?.payload.approved===true&&['prepared','writing'].includes(op.state);
  const conflict=()=>Object.assign(Error('条目版本已变化，请刷新并重新对照。'),{code:'REVISION_CONFLICT'});
  function reviewList({afterId=''}={},context){
    guard(context);
    const page=repo().reviews({...scope,afterId,limit:21});
    const items=page.slice(0,20).map(({operationId,result,state,payload})=>({operationId,reason:result?.reason??'submission-pending',
      submitted:state!=='review',type:payload.entry.type}));
    return {items,nextAfter:page.length>20?items.at(-1).operationId:null};
  }
  async function readReview(operationId,context){
    guard(context);
    const op=repo().operation({...scope,operationId});
    if(!pending(op))throw conflict();
    const {payload}=op;
    const current=payload.target?await read(payload.id,context).catch(error=>{
      context.check();
      if(error.code==='MEMORY_ENTRY_ID_CHANGED')return null;
      throw error;
    }):null;
    guard(context);
    const sourceValid=payload.entry.source_refs.every(ref=>currentSource(ref,context));
    const sources=sourceValid?payload.entry.source_refs.slice(0,8).map(ref=>{
      const source=sourceState(ref,context);
      return {...ref,text:String(source.text??'').slice(0,500)};
    }):[];
    return {operationId,reason:op.result?.reason??'submission-pending',
      current:current?.sourceStatus.eligible?current:null,proposed:sourceValid?payload.entry:null,sources,
      submitted:op.state!=='review',revision:op.state==='review'?current?.revision??null:payload.target.revision,
      canApprove:sourceValid&&Boolean(current?.sourceStatus.eligible)&&!payload.reinforcement,canReject:op.state==='review'};
  }
  async function decideReview({operationId,action,revision},context){
    return withCommitLock(async()=>{
      guard(context);
      const op=repo().operation({...scope,operationId});
      if(op?.state==='committed'||op?.state==='rejected')return {...op.result,duplicate:true};
      if(!pending(op))throw conflict();
      if(action==='reject'){
        if(op.state!=='review')throw conflict();
        const result={state:'rejected',operationId,id:op.payload.id};
        repo().checkpoint({...scope,operationId,state:'rejected',result});
        return result;
      }
      if(action!=='approve')throw Error('未知审核操作');
      const {payload}=op;
      if(payload.reinforcement)throw Error('强化依据或版本已变化，可拒绝此建议。');
      guard(context,payload.entry.source_refs);
      if(op.state==='review'){
        const current=payload.target?await read(payload.id,context):null;
        if(!current?.sourceStatus.eligible||current.revision!==revision)throw conflict();
        guard(context,payload.entry.source_refs);
        repo().approveReview({...scope,operationId,payload:{...payload,approved:true,allowReplacement:true,
          target:{id:payload.id,revision},historyId:payload.target.revision===revision?payload.historyId:randomUUID()}});
      }else if(payload.target.revision!==revision)throw conflict();
      return commitLocked({operationId},context);
    });
  }
  async function list(filters,context){
    guard(context);const limit=filters?.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid structured entry limit');
    for(const [key,values] of [['type',MEMORY_ENTRY_TYPES],['validity',MEMORY_VALIDITY],['progress',MEMORY_PROGRESS]])if(filters?.[key]&&!values.includes(filters[key]))throw Error('Invalid structured entry '+key);
    const entries=[],errors=[];let afterId=filters?.afterId??'',scanned=0,unavailable=0;
    while(entries.length<limit&&scanned<100){
      const page=repo().list({...filters,...scope,afterId,limit:Math.min(24,limit-entries.length,100-scanned)});
      const checked=await Promise.allSettled(page.entries.map(candidate=>read(candidate.id,context)));context.check();
      for(let index=0;index<page.entries.length;index++){
        const candidate=page.entries[index],result=checked[index];afterId=candidate.id;scanned++;
        if(result.status==='rejected'){errors.push({id:candidate.id,error:result.reason.code??result.reason.message});continue;}
        const entry=result.value;if(!entry)continue;
        if(!entry.sourceStatus.eligible&&!filters?.includeUnavailable){unavailable++;continue;}
        if(filters?.type&&entry.type!==filters.type||filters?.validity&&entry.state.validity!==filters.validity||filters?.progress&&entry.state.progress!==filters.progress||filters?.subject&&entry.subject_ref!==filters.subject||filters?.tag&&!entry.tags.includes(filters.tag))continue;
        entries.push(entry);if(entries.length===limit)break;
      }
      if(!page.nextAfter||!page.entries.length)return {entries,nextAfter:null,scanned,unavailable,errors};
    }
    return {entries,nextAfter:afterId,scanned,unavailable,errors};
  }
  return {commit,read,search,list,reviewList,readReview,decideReview,reviews(context){guard(context);return repo().reviews(scope);},
    project:projectNote,bodyMarkers:Object.freeze({start:START,end:END})};
}

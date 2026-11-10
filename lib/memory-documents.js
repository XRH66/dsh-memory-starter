import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {createUnifiedStateStore} from './unified/state-store.js';
import {hydrateMemory,memoryDirectory} from './memory.js';
import {stripFrontmatter} from './records.js';
import {createVaultBackend} from './vault-files.js';
import {memorySourceState,sourceTextHash} from './source-lineage.js';
import {legacyNoteAliasPath,noteIdentifierPath as relative,resolveMemoryNotePath} from './memory-note-path.js';
import {personalDirectory} from './personal-namespace.js';
import {adjustedRelevance} from './priority.js';
import {buildRawEmbeddingContext} from './raw-rag/embedding-material.js';
import {isTopicPath} from './entry-links.js';
import {CJK} from './unified/switch-estimate.js';

const fail=(code,message)=>{throw Object.assign(Error(message),{code});};
const yes=value=>value===true||value==='true';
export const normalizeMemoryEntryNote=value=>value?{...value,content:stripFrontmatter(value.content??''),metadata:value.frontmatter??value.metadata??{}}:null;
// Size only, for the switch estimate; never part of document identity.
const textSize=text=>({length:text.length,cjk:(text.match(CJK)??[]).length});
const metadata=row=>Object.fromEntries(['id','revision','domain','sourceIds','anchor','ownerSubject','project','sessionId','rootSessionId','messageId','sequence','turn','rootTurn','role','kind','authority','length','cjk'].filter(key=>row[key]!==undefined).map(key=>[key,structuredClone(row[key])]));
const excluded=meta=>['excluded','source_hidden','hidden','memory_excluded'].some(key=>yes(meta[key]))||['excluded','withdrawn','deleted'].includes(meta.source_state)||meta.status==='revoked';

/** Source adapter for portable: the persisted catalogue holds LOCATORS and
 * versions only. Raw SQLite and Basic Memory remain the only body authorities.
 * Arbitrary filesystem traversal and automatic historical import are absent. */
export function createMemoryDocuments({directory,access,raw,entries,tools,vaultBackend,config,getPriorityConfig=()=>config,authorize,agentForGrant,beforeBackground=async()=>{}}){
  const store=createUnifiedStateStore({file:path.join(directory,'documents.json'),initial:()=>({documents:[],selections:[]})});
  const entriesDirectory=memoryDirectory(config,'fact').replace(/\/facts$/,'/entries');
  const scopeOf=grant=>({ownerSubject:grant.ownerSubject,project:grant.project});
  const same=(a,b)=>a.ownerSubject===b.ownerSubject&&a.project===b.project;
  let catalogueRevision,byIdentity=new Map();
  const identity=(scope,id)=>JSON.stringify([scope.ownerSubject,scope.project,id]);
  function locator(state,scope,id){
    if(catalogueRevision!==state.revision){
      byIdentity=new Map(state.documents.map(row=>[identity(row,row.id),row]));
      catalogueRevision=state.revision;
    }
    return byIdentity.get(identity(scope,id));
  }
  function context({grant,signal}={}){
    const combined=AbortSignal.any([grant?.signal,signal].filter(Boolean));
    const check=()=>{combined.throwIfAborted();if(!authorize(grant))fail('MEMORY_NOT_AUTHORIZED','记忆资料授权已失效');};
    check();const agent=agentForGrant(grant)??(grant.kind==='management'?{session:{id:'memory-management'}}:null);
    const backend=vaultBackend??tools?.vaultBackend
      ??createVaultBackend({vaultPath:config.vaultPath,project:grant.project});
    return {grant,signal:combined,check,agent,backend,config,project:grant.project,scope:scopeOf(grant),authorize:()=>{try{check();return true;}catch{return false;}}};
  }
  const readRaw=(ctx,ref)=>raw.queryReader(ctx.scope,{authorize:ctx.authorize}).get(ref);
  function original(source,ctx,{withContext=true}={}){
    if(!source||!['user','assistant'].includes(source.role)||!source.text?.trim())return null;
    const reader=withContext?raw.queryReader(ctx.scope,{authorize:ctx.authorize}):null;
    const material=reader?.embeddingContext?buildRawEmbeddingContext(source,reader.embeddingContext(source.ref,{limit:4})):null;
    ctx.check();
    return {...ctx.scope,id:source.id,revision:source.revision,domain:'raw',text:source.text,
      sourceIds:[source.id,...(material?.proof.sources.map(item=>item.id)??[])],
      ...(material?{embedding:{prefix:material.prefix,background:material.background,heading:material.heading}}:{}),
      kind:'message',sessionId:source.sessionId,messageId:source.messageId,sequence:source.sequence,turn:source.turn,
      role:source.role,time:source.time,weight:source.weight??1,source:{kind:'original',sessionId:source.sessionId,messageId:source.messageId,sequence:source.sequence,turn:source.turn,completion:source.completion,
        ...(source.fragment?{fragment:source.fragment}:{})},
      anchor:{id:source.id,revision:source.revision,ref:source.ref,...material?{embedding:material.proof}:{}},recordKind:'original'};
  }
  async function* rawDocuments(ctx){
    const reader=raw.messageReader(ctx.scope,{authorize:ctx.authorize});let beforePosition;
    while(true){
      await beforeBackground(ctx);ctx.check();
      const page=reader.list({beforePosition,limit:100});
      for(const source of page.sources){
        const row=original(readRaw(ctx,{storage:'message',id:source.id,revision:source.revision}),ctx);
        if(row)yield row;
      }
      if(page.nextBefore==null)break;
      if(page.nextBefore===beforePosition)fail('SOURCE_PAGINATION_STALLED','原文分页未前进');
      beforePosition=page.nextBefore;
    }
    const query=raw.queryReader(ctx.scope,{authorize:ctx.authorize});
    if(typeof query.legacyPage!=='function')fail('LEGACY_RAW_ENUMERATION_UNAVAILABLE','需要 raw.queryReader().legacyPage 分页枚举旧原话');
    let after='';
    while(true){
      await beforeBackground(ctx);ctx.check();const page=await query.legacyPage({after,limit:100});ctx.check();
      for(const source of page.sources){const row=original(source,ctx);if(row)yield row;}
      if(page.nextAfter==null||page.nextAfter==='')break;
      if(page.nextAfter===after)fail('SOURCE_PAGINATION_STALLED','旧原文分页未前进');after=page.nextAfter;
    }
  }
  function directories(){return [memoryDirectory(config,'fact'),memoryDirectory(config,'event'),memoryDirectory(config,'history'),entriesDirectory,personalDirectory('thoughts'),personalDirectory('diary')];}
  function permittedPath(rel,ctx){
    if(!rel)return false;
    if(isTopicPath(rel,entriesDirectory))return false;
    return directories().some(dir=>rel.startsWith(dir+'/'))||store.snapshot(state=>state.selections.some(row=>same(row,ctx.scope)&&relative(row.identifier,ctx.project)===rel));
  }
  const permitted=(identifier,ctx)=>permittedPath(relative(identifier,ctx.project),ctx);
  function notePermitted(identifier,filePath,ctx){
    return permitted(identifier,ctx)||(legacyNoteAliasPath(identifier,ctx.project)&&
      permittedPath(resolveMemoryNotePath({permalink:identifier,filePath},ctx.project),ctx));
  }
  async function* noteIdentifiers(ctx){
    const seen=new Set();
    const known=store.snapshot(state=>state.documents.filter(row=>same(row,ctx.scope)&&row.filePath));
    for(const directory of directories()){
      await beforeBackground(ctx);ctx.check();
      const nodes=(await ctx.backend.list(directory,ctx)).filter(node=>!node.directory_path||node.directory_path===directory);
      for(const node of nodes){
        const identifier=node.permalink??node.file_path;
        if(node.type==='directory'||!identifier||!notePermitted(identifier,node.file_path,ctx)||seen.has(identifier))continue;
        seen.add(identifier);yield {identifier,filePath:node.file_path};
      }
    }
    for(const row of store.snapshot(state=>state.selections.filter(row=>same(row,ctx.scope))))if(!seen.has(row.identifier)){
      seen.add(row.identifier);yield {identifier:row.identifier,filePath:known.find(saved=>saved.identifier===row.identifier)?.filePath};
    }
    // A known on-disk note omitted by the index still needs a read. Otherwise
    // a transient directory omission would publish it as deleted.
    for(const {identifier,filePath} of known)if(identifier&&!seen.has(identifier)&&notePermitted(identifier,filePath,ctx)){
      seen.add(identifier);yield {identifier,filePath};
    }
  }
  async function noteDocument(identifier,ctx,filePath){
    ctx.check();if(!notePermitted(identifier,filePath,ctx))return null;
    // Keep the migrated permalink as identity and read the file in the selected project.
    const legacy=legacyNoteAliasPath(identifier,ctx.project),legacyPath=legacy?resolveMemoryNotePath({permalink:identifier,filePath},ctx.project):null;
    // Vector candidates are checked on every search and read through the same
    // authorized Vault layer as foreground writes.
    const knownFilePath=legacyPath??filePath;
    const payload=await ctx.backend.read(legacyPath??identifier,{...ctx,knownFilePath});ctx.check();
    if(!payload)return null;
    const meta=payload.frontmatter??payload.metadata??{};
    if(excluded(meta)||yes(meta.qa_fixture))return null;
    const permalink=payload.permalink??identifier;
    const migratedPermalink=legacyNoteAliasPath(permalink,ctx.project);
    const rel=resolveMemoryNotePath({permalink,filePath:payload.file_path},ctx.project);
    const actualPath=migratedPermalink?rel:relative(payload.file_path,ctx.project);
    if(migratedPermalink&&!actualPath)return null;
    if(legacy&&(payload.permalink!==identifier||(legacyPath&&actualPath!==legacyPath)))return null;
    if(!permitted(permalink,ctx)&&!permittedPath(actualPath,ctx))return null;
    const personal=rel?.startsWith('dafeiyu/');
    let text=String(payload.content??''),id,domain,sourceIds,ref,entry,authority='manual',weight=1;
    if(meta.memory_entry_id){
      if(ctx.grant.kind==='management'){
        // The host may supply a management-aware entry reader. Without it,
        // use the Markdown body, but validate every declared source below.
        const {readMemoryEntry}=await import('./memory-entry.js');
        const match=/<!-- dsh-memory-entry:start -->\r?\n([\s\S]*?)\r?\n<!-- dsh-memory-entry:end -->/.exec(text);
        if(!match)return null;entry={...readMemoryEntry({metadata:meta,content:match[1]}),id:meta.memory_entry_id};
        const repository=raw.entryRepository?.(ctx.scope,{authorize:ctx.authorize});
        const operationId=meta.memory_body_operation_id??meta.memory_operation_id;
        const baseline=operationId?repository?.operation({...ctx.scope,operationId}):null;
        entry.sourceStatus={manualBody:Boolean(baseline&&entry.content!==baseline.payload.entry.content)};
      }else entry=await entries.forGrant(ctx.agent,ctx.grant,{signal:ctx.signal}).read(meta.memory_entry_id,{note:normalizeMemoryEntryNote(payload)});
      ctx.check();if(!entry)return null;
      const sourceValid=entry.sourceStatus?.manualBody===true||entry.source_refs.every(source=>{
        const current=readRaw(ctx,{storage:'message',...source});return current&&(!source.role||source.role===current.role);
      });
      if(!sourceValid||entry.sourceStatus?.eligible===false)return null;
      text=entry.content;id=entry.id;domain='entry';sourceIds=entry.source_refs.map(row=>row.id);authority=entry.sourceStatus?.manualBody?'manual':'derived';ref={storage:'entry',id};
    }else if(!personal&&meta.memory_id){
      const note=await hydrateMemory({...payload,frontmatter:meta});ctx.check();if(!note)return null;
      const lineage=memorySourceState(note,{scope:ctx.scope.ownerSubject,sourceState:raw.querySourceState});if(!lineage.eligible)return null;
      text=note.value||note.entry?.content||text;id='legacy-note:'+note.memoryId;domain='fact';entry=note.entry;authority=lineage.authority;
      sourceIds=lineage.refs.map(row=>row.messageId);ref={storage:'note',id,identifier:permalink};
    }else{
      id='document:'+encodeURIComponent(permalink);domain=personal?(rel.includes('/thoughts/')?'thoughts':'diary'):'document';
      ref={storage:'document',id,identifier:permalink};
    }
    // Selecting a path never turns a derived note into manual evidence.
    if(meta.dsh_derivation&&!meta.memory_entry_id){
      const lineage=memorySourceState({content:payload.content,metadata:meta},{scope:ctx.scope.ownerSubject,sourceState:raw.querySourceState});
      if(!lineage.eligible)return null;authority=lineage.authority;
      sourceIds=lineage.refs.map(row=>row.messageId);
    }
    if(!text.trim())return null;
    if(!sourceIds?.length)sourceIds=[id];
    // The file-byte SHA-256 remains the public note revision. The existing
    // fingerprint helper is only a fallback for older read backends.
    // Controls and source proofs are checked independently on every read.
    const revision=String(payload.checksum||sourceTextHash(JSON.stringify([payload.content??'',meta])));
    const date=Date.parse(meta.source_event_time??meta.recorded_at??meta.created??payload.updated_at??'');
    return {...ctx.scope,id,revision,domain,text,sourceIds,kind:'document',authority,
      anchor:{id,revision,ref},source:{kind:'note',permalink},recordKind:domain==='entry'||domain==='fact'?'entry':'document',title:payload.title,
      time:Number.isFinite(date)?date:null,weight,metadata:meta,filePath:payload.file_path,...entry?{entry}:{}};
  }
  async function resolveDocument(options){
    const ctx=context(options),saved=await store.read(state=>locator(state,ctx.scope,options.id));ctx.check();
    if(!saved)return null;
    let row;
    if(saved.domain==='raw')row=original(readRaw(ctx,saved.anchor.ref),ctx,{
      // Older snapshots encoded only the body. Keep them readable until the
      // existing background reconciliation prepares contextual material.
      withContext:!Object.hasOwn(options,'anchor')||Boolean(options.anchor?.embedding),
    });
    else try{row=await noteDocument(saved.identifier??saved.anchor.ref.identifier,ctx,saved.filePath);}
    catch(error){ctx.check();if(error.code==='MEMORY_NOTE_SYNC_PENDING')return null;throw error;}
    ctx.check();if(!row||row.id!==options.id||row.revision!==options.revision)return null;
    if(options.anchor?.embedding&&!isDeepStrictEqual(options.anchor.embedding,row.anchor?.embedding))return null;
    if(options.query&&row.metadata){
      const priority=await getPriorityConfig();ctx.check();
      const relevance=adjustedRelevance(1,row.metadata,{...priority,query:options.query,text:row.title?`# ${row.title}\n${row.text}`:row.text,now:Date.now()});
      if(!relevance.eligible)return null;row.weight=relevance.score;
    }
    return record(row);
  }
  function record(row){
    const {recordKind,entry,metadata:_meta,filePath:_filePath,title:_title,embedding:_embedding,...result}=row;
    const fields=['type','subject_ref','state','tags','importance','evidence_basis','speaker_ref','viewpoint_holder_ref','inferred_by_ref','source_refs','sourceStatus'];
    return {...result,kind:recordKind??(row.domain==='raw'?'original':'entry'),
      ...entry?Object.fromEntries(fields.filter(key=>entry[key]!==undefined).map(key=>[key,entry[key]])):{},text:row.text};
  }
  function selection(state,ctx){
    const identifiers=state.selections.filter(row=>same(row,ctx.scope)).map(row=>row.identifier);
    return {identifiers,selected:identifiers.length,revision:state.selectionRevision??'initial'};
  }
  return {
    ready:()=>store.read(),
    context,
    async documentSelection({grant,signal}){
      const ctx=context({grant,signal});if(grant.kind!=='management')fail('MEMORY_NOT_AUTHORIZED','查看手选资料需要管理授权');
      const state=await store.read();ctx.check();return selection(state,ctx);
    },
    async selectDocuments({grant,identifiers,signal,expectedRevision,check}){
      const ctx=context({grant,signal});if(grant.kind!=='management')fail('MEMORY_NOT_AUTHORIZED','选择人工资料需要管理授权');
      if(!Array.isArray(identifiers)||identifiers.length>100||identifiers.some(value=>typeof value!=='string'||!relative(value,ctx.project)))fail('INVALID_DOCUMENT_SELECTION','只接受明确选择的 Basic Memory 相对标识');
      const current=selection(await store.read(),ctx);
      const checkRevision=revision=>{
        ctx.check();check?.();
        if(expectedRevision!==undefined&&revision!==expectedRevision)fail('MEMORY_REVISION_CONFLICT','资料选择已变化，请刷新后再保存');
      };
      checkRevision(current.revision);
      const unique=[...new Map(identifiers.map(id=>[relative(id,ctx.project),id])).values()];
      for(const id of unique.filter(id=>!current.identifiers.includes(id))){
        const note=await ctx.backend.read(id,ctx);checkRevision(current.revision);
        const requested=relative(id,ctx.project);
        if(isTopicPath(requested,entriesDirectory))fail('INVALID_DOCUMENT_SELECTION','主题页不能作为检索资料');
        if(!note||![note.permalink,note.file_path].some(value=>relative(value,ctx.project)===requested))
          fail('INVALID_DOCUMENT_SELECTION','未找到所选资料的确切路径：'+id);
      }
      const {value}=await store.update(state=>{
        checkRevision(state.selectionRevision??'initial');
        state.selections=state.selections.filter(row=>!same(row,ctx.scope));
        state.selections.push(...unique.map(identifier=>({...ctx.scope,identifier})));
        state.selectionRevision=randomUUID();
      });
      return selection(value,ctx);
    },
    async *listDocuments(options){
      await store.read(()=>null);const ctx=context(options),rows=[],seen=new Set();
      const emit=row=>{if(!row||seen.has(row.id))return false;seen.add(row.id);rows.push(row);return true;};
      for await(const row of rawDocuments(ctx))if(emit(row))yield row;
      for await(const {identifier,filePath} of noteIdentifiers(ctx)){
        await beforeBackground(ctx);const row=await noteDocument(identifier,ctx,filePath);
        if(row){row.identifier=identifier;row.anchor.ref.identifier??=identifier;if(emit(row))yield row;}
      }
      ctx.check();await store.update(state=>{ctx.check();state.documents=state.documents.filter(row=>!same(row,ctx.scope));state.documents.push(...rows.map(row=>({...metadata(row),...typeof row.text==='string'?textSize(row.text):{},...row.identifier?{identifier:row.identifier}:{},...row.filePath?{filePath:row.filePath}:{}})));});
      ctx.check();
    },
    async *listDocumentMetadata(options){const ctx=context(options),rows=await store.read(state=>state.documents.filter(row=>same(row,ctx.scope)).map(metadata));for(const row of rows){ctx.check();yield row;}},
    resolveDocument,
    locate(notice){return store.ready?store.snapshot(state=>state.documents.filter(row=>same(row,notice)&&(row.id===notice.id||row.identifier===notice.permalink||row.anchor?.ref?.identifier===notice.permalink))):[];},
    getMetadata({id,revision,grant}){
      const ctx=context({grant});const row=store.snapshot(state=>locator(state,ctx.scope,id));return row?.revision===revision?{...row,state:'live'}:null;
    },
    async close(){await store.idle();},
  };
}

import {createMemoryEntryService} from './memory-entry-service.js';
import {createVaultBackend} from './vault-files.js';
import {hydrateMemory,memoryDirectory} from './memory.js';
import {memorySourceState} from './source-lineage.js';
import {reinforcePriorityPatch,isStrongCue} from './priority.js';
import {withCommitLock} from './coordinator.js';
import {legacyNoteAliasPath,noteIdentifierPath,resolveMemoryNotePath} from './memory-note-path.js';

const denied=()=>Object.assign(Error('Structured entry authorization changed'),{code:'MEMORY_NOT_AUTHORIZED'});
const excluded=()=>Object.assign(Error('Note excluded from personal memory'),{code:'MEMORY_NOTE_EXCLUDED'});

export function memoryNoteExcluded(metadata={}){
  return ['excluded','source_hidden','hidden','memory_excluded','qa_fixture'].some(key=>[true,'true'].includes(metadata[key]))
    ||['excluded','withdrawn','deleted'].includes(metadata.source_state)||metadata.status==='revoked';
}

export function memoryNoteInDirectories(note,project,directories){
  const relative=resolveMemoryNotePath(note,project);
  const directory=directories.find(dir=>relative?.startsWith(dir+'/'));
  const alias=legacyNoteAliasPath(note.permalink,project);
  return Boolean(directory&&(!alias||alias.startsWith(directory+'/')));
}

/** Frontend readers use their current read grant. Background writers must also
 * prove the exact persisted message-source grants from their original root. */
export function createMemoryEntryAccess({access,raw,tools,config,getPriorityConfig}){
  function serviceFor(scope,authorize){
    const reader=raw.messageReader(scope,{authorize});
    const backend=tools?.vaultBackend??createVaultBackend({vaultPath:config.vaultPath,project:scope.project});
    const entryBackend={...backend,async read(identifier,context){
      const note=await backend.read(identifier,context);
      // A hidden note still exists. Treating it as missing could remove its
      // projection or permit a saved operation to recreate it.
      if(note&&memoryNoteExcluded(note.metadata))throw excluded();
      return note;
    }};
    const service=createMemoryEntryService({scope,config,getPriorityConfig,repository:()=>raw.entryRepository(scope,{authorize}),backend:entryBackend,
      sourceState:ref=>reader.get(ref)});
    async function read(id,context,options){
      try{context.check();if(options?.note&&memoryNoteExcluded(options.note.metadata))throw excluded();return await service.read(id,context,options);}
      catch(error){if(error.code==='MEMORY_NOTE_EXCLUDED')return null;throw error;}
    }
    return {reader,backend,service,read};
  }
  function open(agent,refs,existingGrant,signal){
    const grant=existingGrant??access.grant(agent),scope={ownerSubject:grant.ownerSubject,project:grant.project};
    if(grant.sessionId!==agent?.session?.id||!access.validate(grant))throw denied();
    const readAuthorized=()=>!signal?.aborted&&access.validate(grant);
    const initial=raw.messageReader(scope,{authorize:readAuthorized});
    const proofs=refs?.map(ref=>{
      const source=initial.get(ref);
      if(!source?.isCurrent||source.withdrawn||source.authorization?.rootSessionId!==agent.session.id||!access.validateMessage(source.authorization))throw denied();
      return source.authorization;
    })??[];
    const authorize=()=>readAuthorized()&&proofs.every(proof=>access.validateMessage(proof));
    const context={agent,signal:AbortSignal.any([signal,grant.signal].filter(Boolean)),check(){if(!authorize())throw denied();}};
    return {...serviceFor(scope,authorize),context,scope};
  }
  return {
    forGrant(agent,grant,{signal}={}){const {service,read,context}=open(agent,undefined,grant,signal);return {read:(id,options)=>read(id,context,options),search:(query,filters)=>service.search(query,filters,context),list:filters=>service.list(filters,context)};},
    forAgent(agent){const {service,read,context}=open(agent);return {read:id=>read(id,context),list:filters=>service.list(filters,context),reviews:()=>service.reviews(context)};},
    forManagement(context){
      if(typeof context?.check!=='function')throw denied();
      context.check();
      const scope={ownerSubject:raw.scope(),project:config.project};
      const authorize=()=>{try{context.check();return true;}catch{return false;}};
      const {service}=serviceFor(scope,authorize);
      return {list:input=>service.reviewList(input,context),read:id=>service.readReview(id,context),decide:input=>service.decideReview(input,context)};
    },
    forBatch(agent,refs){
      if(!Array.isArray(refs)||!refs.length)throw denied();
      const {service,read,context,reader,backend,scope}=open(agent,refs),allowed=new Map(refs.map(ref=>[JSON.stringify([ref.id,ref.revision]),reader.get(ref)]));
      const legacyDirectories=['fact','event'].map(kind=>memoryDirectory(config,kind));
      async function legacyNote(ref){
        context.check();
        if(typeof ref.legacy!=='string'||!ref.id.startsWith('legacy-note:'))return null;
        const requested=legacyNoteAliasPath(ref.legacy,scope.project)??noteIdentifierPath(ref.legacy,scope.project);
        if(!legacyDirectories.some(dir=>requested?.startsWith(dir+'/')))return null;
        const payload=await backend.read(ref.legacy,context);
        if(!payload||memoryNoteExcluded(payload.metadata)||!memoryNoteInDirectories(payload,scope.project,legacyDirectories))return null;
        const note=await hydrateMemory({...payload,frontmatter:payload.metadata});
        if(!note||note.status!=='active'||!['fact','event'].includes(note.kind)||'legacy-note:'+note.memoryId!==ref.id||
          !memorySourceState(note,{scope:scope.ownerSubject,sourceState:raw.querySourceState}).eligible)return null;
        return note;
      }
      return {async commit(input){
        context.check();
        if(!(input.sources instanceof Map)||[...input.sources.values()].some(ref=>!allowed.has(JSON.stringify([ref.id,ref.revision]))))throw denied();
        const sources=new Map([...input.sources].map(([name,ref])=>[name,allowed.get(JSON.stringify([ref.id,ref.revision]))]));
        return service.commit({...input,sources},context);
      },read:id=>read(id,context),list:filters=>service.list(filters,context),
      async readLegacy(ref){
        const note=await legacyNote(ref);
        return note?.checksum===ref.revision?{...note.entry,id:ref.id,revision:note.checksum,content:note.value,legacy:ref.legacy}:null;
      },
      async reinforceLegacy(input){
        return withCommitLock(async()=>{
          const note=await legacyNote(input.target);
          const result={state:'committed',metadataOnly:true,reinforced:false,id:input.target.id};
          if(!note)return result;
          if(note.metadata.memory_reinforcement_operation_id===input.operationId)return {...result,reinforced:true,duplicate:true};
          if(note.checksum!==input.target.revision||note.value!==input.proposed.content)return result;
          const reference=input.sources.get(input.proposed.source_refs[0]);
          const source=reference&&allowed.has(JSON.stringify([reference.id,reference.revision]))?reader.get(reference):null;
          const time=source?.time??source?.recordedAt,quote=input.reinforcement;
          if(source?.role!=='user'||!source.isCurrent||source.withdrawn||!Number.isFinite(time)||!source.text?.includes(quote)||!isStrongCue(quote,note.value))return result;
          const execution={...context,check(){
            context.check();
            const current=reader.get(reference);
            if(!current?.isCurrent||current.withdrawn)throw Object.assign(Error('Legacy reinforcement source changed'),{code:'MEMORY_SOURCE_CHANGED'});
          }};
          const priority=getPriorityConfig?await getPriorityConfig():config;
          const patch=reinforcePriorityPatch(note.metadata,{...priority,now:time});
          if(!patch)return result;
          const metadata={...patch,memory_reinforcement_operation_id:input.operationId};
          try{
            await backend.edit({identifier:note.filePath||note.permalink,operation:'append',content:'',expected_checksum:note.checksum,metadata},execution);
          }catch(error){if(error.code==='MEMORY_WRITE_CONFLICT')return result;throw error;}
          const fresh=await backend.read(note.filePath||note.permalink,execution);
          if(!fresh||fresh.content!==note.content||fresh.metadata.memory_reinforcement_operation_id!==input.operationId)throw Error('旧条目强化回读不一致');
          return {...result,reinforced:true,revision:fresh.checksum};
        });
      }};
    },
  };
}

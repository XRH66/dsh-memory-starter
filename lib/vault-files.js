import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parseLegacyNote} from './legacy-notes.js';
import {noteIdentifierPath} from './memory-note-path.js';
import {sanitizeMemoryTitle} from './memory.js';
import {lexicalMatch} from './raw-rag/lexical.js';
import {toolFailureText,unwrapToolValue} from './mcp.js';

const FRONTMATTER_ERROR='MEMORY_FRONTMATTER_UNSUPPORTED';
const WRITE_CONFLICT='MEMORY_WRITE_CONFLICT';
const BACKEND_ERROR='MEMORY_BACKEND_ERROR';
const AMBIGUOUS_NOTE='MEMORY_AMBIGUOUS_NOTE';
const CJK_RE=/[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f]/;
const FRONTMATTER_KEY_RE=/^[A-Za-z_][\w-]*$/;
const DEFAULT_LEGACY_VAULT_TOOL_NAMES=Object.freeze({
  read:'mcp__basic_memory__read_note',
  write:'mcp__basic_memory__write_note',
  edit:'mcp__basic_memory__edit_note',
  list:'mcp__basic_memory__list_directory',
  search:'mcp__basic_memory__search_notes',
  move:'mcp__basic_memory__move_note',
});

const fail=(code,message,details={})=>Object.assign(Error(message),{code,...details});
const slashPath=value=>String(value??'').replace(/\\/g,'/');
const checksumOf=bytes=>createHash('sha256').update(bytes).digest('hex');

function relativePath(value,project){
  return noteIdentifierPath(slashPath(value),project);
}

function physicalPath(root,relative){
  const full=path.resolve(root,relative);
  const prefix=root.endsWith(path.sep)?root:root+path.sep;
  if(full!==root&&!full.startsWith(prefix))throw fail(BACKEND_ERROR,'Vault path escapes its root');
  return full;
}

function directoryPath(value,project){
  const raw=slashPath(value).replace(/^\/+|\/+$/g,'');
  if(!raw)return '';
  const relative=relativePath(raw,project);
  if(!relative)throw fail(BACKEND_ERROR,'Vault directory must be a safe relative path');
  return relative;
}

function normalizeTags(value){
  if(value===undefined||value===null)return [];
  const list=Array.isArray(value)?value:typeof value==='string'?value.split(','):null;
  if(!list)throw fail(FRONTMATTER_ERROR,'tags must be a string or list');
  return list.map(item=>String(item).trim()).filter(Boolean);
}

function scalarText(value,key){
  if(value===null)return 'null';
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  if(typeof value==='boolean')return value?'true':'false';
  throw fail(FRONTMATTER_ERROR,'unsupported frontmatter value for '+key);
}

function appendFrontmatterField(lines,key,value){
  if(!FRONTMATTER_KEY_RE.test(key))throw fail(FRONTMATTER_ERROR,'unsupported frontmatter key: '+key);
  if(value===undefined)return;
  if(Array.isArray(value)){
    lines.push(key+':');
    for(const item of value){
      if(item===null||typeof item==='object')throw fail(FRONTMATTER_ERROR,'unsupported list value for '+key);
      lines.push('  - '+scalarText(item,key));
    }
    return;
  }
  lines.push(key+': '+scalarText(value,key));
}

function renderNote({title,type,permalink,metadata,tags,content}){
  const lines=['---'];
  appendFrontmatterField(lines,'title',title);
  appendFrontmatterField(lines,'type',type);
  appendFrontmatterField(lines,'permalink',permalink);
  for(const [key,value] of Object.entries(metadata)){
    if(['title','type','permalink','tags'].includes(key))continue;
    appendFrontmatterField(lines,key,value);
  }
  appendFrontmatterField(lines,'tags',tags);
  lines.push('---');
  return lines.join('\n')+'\n\n'+String(content??'');
}

function stripSeparatorNewline(body){
  if(body.startsWith('\r\n'))return body.slice(2);
  if(body.startsWith('\n'))return body.slice(1);
  return body;
}

function firstHeading(body){
  return /^#\s+(.+?)\s*$/m.exec(body)?.[1]??'';
}

function permalinkText(relative){
  const base=relative.replace(/\.md$/i,'');
  const hasCjk=CJK_RE.test(base);
  let text=base.normalize('NFKD').replace(/\p{M}/gu,'');
  if(hasCjk){
    text=[...text].filter(char=>!('\uff00'<=char&&char<='\uffef')).join('');
    text=text.replace(/([\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f])([a-zA-Z0-9])/g,'$1-$2')
      .replace(/([a-zA-Z0-9])([\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f])/g,'$1-$2');
  }
  text=text.toLowerCase().replace(/'/g,'').replace(/_/g,'-');
  text=hasCjk
    ?text.replace(/[^a-z0-9\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f/.-]+/g,'-')
    :text.replace(/[^a-z0-9/.-]+/g,'-');
  return text.split('/').map(part=>part.replace(/-+/g,'-').replace(/^-+|-+$/g,'')).join('/');
}

function notePermalink(relative,project){
  const normalized=permalinkText(relative);
  return project?project+'/'+normalized:normalized;
}

function parseFile(bytes,relative,project){
  const text=bytes.toString('utf8');
  const hasFrontmatter=/^---[ \t]*\r?\n/.test(text);
  let metadata={},body=text;
  if(hasFrontmatter){
    const parsed=parseLegacyNote(text);
    if(!parsed)throw fail(FRONTMATTER_ERROR,'unsupported frontmatter in '+relative);
    metadata=parsed.metadata;
    body=stripSeparatorNewline(parsed.content);
  }
  const fallback=path.posix.basename(relative,'.md');
  const title=metadata.title!==undefined?String(metadata.title):firstHeading(body)||fallback;
  const permalink=metadata.permalink!==undefined&&String(metadata.permalink)
    ?String(metadata.permalink)
    :notePermalink(relative,project);
  return {content:body,metadata,permalink,file_path:relative,checksum:checksumOf(bytes),title};
}

async function readFile(root,relative,project){
  const full=physicalPath(root,relative);
  let bytes;
  try{bytes=await fs.readFile(full);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  return parseFile(bytes,relative,project);
}

async function existingChecksum(full){
  try{return checksumOf(await fs.readFile(full));}catch(error){if(error.code==='ENOENT')return null;throw error;}
}

async function markdownFiles(root,relative=''){
  const directory=physicalPath(root,relative||'.');
  let entries;
  try{entries=await fs.readdir(directory,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
  const files=[];
  for(const entry of entries){
    const child=relative?relative+'/'+entry.name:entry.name;
    if(entry.isSymbolicLink())continue;
    if(entry.isDirectory()){
      files.push(...await markdownFiles(root,child));
    }else if(entry.isFile()&&entry.name.endsWith('.md')){
      files.push(child);
    }
  }
  return files;
}

function samePermalink(left,right,project){
  const a=relativePath(left,project),b=relativePath(right,project);
  return Boolean(a&&b&&a===b);
}

async function resolveNote(root,project,identifier){
  const requested=slashPath(identifier);
  const relative=relativePath(requested,project);
  if(!relative)return null;
  // Resolution order: project-relative path (with or without .md), exact
  // frontmatter permalink, then one exact filename/title match anywhere in the
  // Vault. Duplicate filenames are ambiguous and are rejected rather than guessed.
  const direct=relative.toLowerCase().endsWith('.md')?[relative]:[relative,relative+'.md'];
  for(const candidate of direct){
    const note=await readFile(root,candidate,project);
    if(!note)continue;
    if(candidate.toLowerCase().endsWith('.md')||samePermalink(note.permalink,requested,project))return note;
  }

  const candidates=[];
  const unsupported=[];
  const filename=path.posix.basename(relative);
  const filenameWithExtension=filename.toLowerCase().endsWith('.md')?filename:filename+'.md';
  for(const file of await markdownFiles(root)){
    let note;
    try{note=parseFile(await fs.readFile(physicalPath(root,file)),file,project);}
    catch(error){
      if(error.code!==FRONTMATTER_ERROR)throw error;
      if(path.posix.basename(file).toLowerCase()===filenameWithExtension.toLowerCase())unsupported.push(error);
      continue;
    }
    if(samePermalink(note.permalink,requested,project))return note;
    if(path.posix.basename(file).toLowerCase()===filenameWithExtension.toLowerCase())candidates.push(note);
  }
  if(unsupported.length)throw unsupported[0];
  if(candidates.length===1)return candidates[0];
  if(candidates.length>1)throw fail(AMBIGUOUS_NOTE,'more than one Vault note has filename '+filename);
  return null;
}

async function atomicWrite(full,text){
  const directory=path.dirname(full),temporary=path.join(directory,'.'+path.basename(full)+'.'+process.pid+'.'+randomUUID()+'.tmp');
  await fs.mkdir(directory,{recursive:true});
  let handle=null;
  try{
    handle=await fs.open(temporary,'wx');
    await handle.writeFile(text,'utf8');
    await handle.sync();
    await handle.close();
    handle=null;
    await fs.rename(temporary,full);
  }catch(error){
    if(handle)await handle.close().catch(()=>{});
    await fs.unlink(temporary).catch(()=>{});
    throw error;
  }
}

function contextCheck(context){
  context?.check?.();
}

export function createLegacyVaultBackend(tools,names=tools?.legacyVaultToolNames??DEFAULT_LEGACY_VAULT_TOOL_NAMES){
  async function call(context,key,args){
    contextCheck(context);
    const name=names[key],execArgs={project:context?.project,output_format:'json',...args};
    let definition;
    try{definition=tools?.get?.(name,context?.agent);}
    catch(error){throw fail(BACKEND_ERROR,error instanceof Error?error.message:String(error));}
    if(!definition||typeof definition.execute!=='function')throw fail(BACKEND_ERROR,'scoped tool is unavailable: '+name);
    const callId='vault-'+randomUUID();
    let raw;
    try{
      raw=await definition.execute(execArgs,{
        callId,rootCallId:callId,name,arguments:execArgs,agent:context?.agent,
        signal:context?.signal??new AbortController().signal,token:Symbol(name),deferContext(){},concludeTurn(){},
        memoryAuthorization:()=>{try{contextCheck(context);return true;}catch{return false;}},
      });
    }catch(error){throw fail(BACKEND_ERROR,error instanceof Error?error.message:String(error));}
    const result=raw&&typeof raw==='object'&&Object.hasOwn(raw,'isError')?raw:{isError:false,value:raw,content:[]};
    contextCheck(context);
    if(result?.isError){
      const text=toolFailureText(result);
      const conflict=key!=='read'&&/checksum|conflict|modified|already exists|no match|multiple|not found/i.test(text);
      throw fail(key==='read'||!conflict?'MEMORY_BACKEND_ERROR':'MEMORY_WRITE_CONFLICT',text);
    }
    const value=unwrapToolValue(result);
    if(value?.error==='NOTE_NOT_FOUND')return null;
    if(value?.error==='NOTE_SYNC_PENDING'){
      throw fail('MEMORY_NOTE_SYNC_PENDING','Local Markdown is awaiting synchronization',{retryable:true});
    }
    if(value?.error||value?.action==='conflict'){
      const text=String(value.message??value.error??'conflict');
      const conflict=key!=='read'&&(value.action==='conflict'||/checksum|conflict|modified|already exists|no match|multiple|not found/i.test(text));
      throw fail(key==='read'||!conflict?'MEMORY_BACKEND_ERROR':'MEMORY_WRITE_CONFLICT',text);
    }
    return value;
  }
  return {
    async read(identifier,context){
      const value=await call(context,'read',{identifier,include_content:true,include_frontmatter:true,
        ...(context?.knownFilePath?{known_file_path:context.knownFilePath}:{})});
      return value?{...value,metadata:value.frontmatter??value.metadata??{}}:null;
    },
    write:(input,context)=>call(context,'write',input),
    edit:(input,context)=>call(context,'edit',input),
    async list(directory,context){
      const nodes=[];
      for(let page=1;page<=10000;page++){
        const value=await call(context,'list',{dir_name:directory,depth:1,page,page_size:100,sort:'updated_desc'});
        const pageNodes=Array.isArray(value)?value:value?.nodes??value?.files??value?.results??[];
        nodes.push(...pageNodes);
        const more=typeof value?.has_more==='boolean'?value.has_more:typeof value?.total==='number'?page*100<value.total:pageNodes.length>=100;
        if(!more||!pageNodes.length)break;
      }
      return nodes;
    },
    async search(input,context){
      const value=await call(context,'search',input);
      return Array.isArray(value)?value:value?.results??[];
    },
    move:(input,context)=>call(context,'move',input),
  };
}

export function createVaultBackend({vaultPath,project}){
  const root=path.resolve(vaultPath);
  return {
    async read(identifier,context){
      contextCheck(context);
      const note=await resolveNote(root,project,identifier);
      contextCheck(context);
      return note;
    },
    async write(input={},context){
      contextCheck(context);
      const directory=directoryPath(input.directory,project);
      const title=String(input.title??'');
      const filename=sanitizeMemoryTitle(title);
      if(!filename)throw fail(BACKEND_ERROR,'Memory title has no usable filename');
      const filePath=(directory?directory+'/':'')+filename+'.md';
      const full=physicalPath(root,filePath);
      const currentChecksum=await existingChecksum(full);
      if(currentChecksum&&input.overwrite!==true){
        throw fail(WRITE_CONFLICT,'Vault note already exists: '+filePath,{currentChecksum});
      }
      if(input.expected_checksum!==undefined&&String(input.expected_checksum)!==currentChecksum){
        throw fail(WRITE_CONFLICT,'Vault note checksum changed: '+filePath,{currentChecksum});
      }
      const metadata=input.metadata&&typeof input.metadata==='object'?input.metadata:{};
      const permalink=notePermalink(filePath,project);
      const tags=normalizeTags(input.tags??metadata.tags);
      const text=renderNote({title,type:String(input.note_type??metadata.type??'note'),permalink,metadata,tags,content:input.content});
      const bytes=Buffer.from(text,'utf8');
      await atomicWrite(full,text);
      contextCheck(context);
      return {permalink,checksum:checksumOf(bytes),file_path:filePath};
    },
    async edit(input={},context){
      contextCheck(context);
      const current=await resolveNote(root,project,input.identifier);
      if(!current)throw fail(WRITE_CONFLICT,'Vault note was not found: '+String(input.identifier??''),{currentChecksum:null});
      if(input.expected_checksum===undefined||String(input.expected_checksum)!==current.checksum){
        throw fail(WRITE_CONFLICT,'Vault note checksum changed: '+current.file_path,{currentChecksum:current.checksum});
      }
      let content=current.content;
      if(input.operation==='append'){
        const addition=String(input.content??'');
        if(addition)content=content.replace(/\n*$/,'\n')+addition;
      }else if(input.operation==='find_replace'){
        const find=String(input.find_text??'');
        const expected=Number(input.expected_replacements??1);
        const parts=find?content.split(find):[];
        const replacements=Math.max(0,parts.length-1);
        if(!find||replacements!==expected){
          throw fail(WRITE_CONFLICT,'Vault note find_replace expected '+expected+' match(es), found '+replacements,{currentChecksum:current.checksum});
        }
        content=parts.join(String(input.content??''));
      }else{
        throw fail(BACKEND_ERROR,'Unsupported Vault edit operation: '+String(input.operation??''));
      }
      const patch=input.metadata&&typeof input.metadata==='object'?input.metadata:{};
      const metadata={...current.metadata,...patch};
      const title=metadata.title!==undefined?String(metadata.title):current.title;
      const type=String(metadata.type??'note');
      const permalink=metadata.permalink!==undefined&&String(metadata.permalink)
        ?String(metadata.permalink)
        :current.permalink;
      const tags=normalizeTags(metadata.tags);
      const text=renderNote({title,type,permalink,metadata,tags,content});
      const bytes=Buffer.from(text,'utf8');
      await atomicWrite(physicalPath(root,current.file_path),text);
      contextCheck(context);
      return {title,permalink,checksum:checksumOf(bytes),file_path:current.file_path,action:'updated'};
    },
    async list(directory='',context){
      contextCheck(context);
      const relative=directoryPath(directory,project);
      const nodes=[];
      for(const file of await markdownFiles(root,relative)){
        const full=physicalPath(root,file);
        const [bytes,stat]=await Promise.all([fs.readFile(full),fs.stat(full)]);
        const note=parseFile(bytes,file,project);
        nodes.push({
          type:'file',
          name:note.title,
          title:note.title,
          directory_path:path.posix.dirname(file)==='.'?'':path.posix.dirname(file),
          permalink:note.permalink,
          file_path:file,
          updated_at:stat.mtime.toISOString(),
        });
      }
      nodes.sort((left,right)=>right.updated_at.localeCompare(left.updated_at)||left.file_path.localeCompare(right.file_path));
      contextCheck(context);
      return nodes;
    },
    async search(input={},context){
      contextCheck(context);
      const query=String(input.query??'').normalize('NFKC').toLowerCase().trim();
      const tags=normalizeTags(input.tags);
      const limit=Math.max(0,Number(input.page_size??input.limit??20)||20);
      const results=[];
      for(const file of await markdownFiles(root)){
        const note=parseFile(await fs.readFile(physicalPath(root,file)),file,project);
        const noteTags=normalizeTags(note.metadata.tags);
        if(tags.some(tag=>!noteTags.includes(tag)))continue;
        const searchable=[
          note.title,
          note.content,
          note.metadata.subject,
          note.metadata.attribute,
          note.metadata.value,
        ].filter(value=>value!==undefined&&value!==null).join('\n');
        const lexical=query?lexicalMatch(query,searchable):1;
        const substring=query&&searchable.toLowerCase().includes(query)?1:0;
        const score=Math.max(lexical,substring);
        if(query&&score<=0)continue;
        results.push({
          title:note.title,
          permalink:note.permalink,
          file_path:file,
          checksum:note.checksum,
          score,
          matched_chunk:note.content,
          metadata:note.metadata,
          frontmatter:note.metadata,
        });
      }
      results.sort((left,right)=>right.score-left.score||left.title.localeCompare(right.title)||left.file_path.localeCompare(right.file_path));
      const selected=results.slice(0,limit);
      contextCheck(context);
      return selected;
    },
    async move(input={},context){
      contextCheck(context);
      const current=await resolveNote(root,project,input.identifier);
      if(!current)throw fail(WRITE_CONFLICT,'Vault note was not found: '+String(input.identifier??''),{currentChecksum:null});
      const destination=relativePath(input.destination_path,project);
      if(!destination||!destination.toLowerCase().endsWith('.md'))throw fail(BACKEND_ERROR,'Vault move destination must be a relative Markdown path');
      if(destination===current.file_path){
        contextCheck(context);
        return {moved:false,permalink:current.permalink,checksum:current.checksum,file_path:current.file_path};
      }
      const source=physicalPath(root,current.file_path),target=physicalPath(root,destination);
      try{
        await fs.access(target);
        throw fail(WRITE_CONFLICT,'Vault move destination already exists: '+destination,{currentChecksum:current.checksum});
      }catch(error){
        if(error.code!=='ENOENT')throw error;
      }
      await fs.mkdir(path.dirname(target),{recursive:true});
      await fs.rename(source,target);
      contextCheck(context);
      return {moved:true,permalink:current.permalink,checksum:current.checksum,file_path:destination};
    },
  };
}

/** Build one authorized Vault backend from a memory operation context. */
export function vaultContextFor(ctx){
  const config=ctx?.config??{};
  const vaultPath=ctx?.vaultPath||config.vaultPath;
  const legacyNames=ctx?.tools?.legacyVaultToolNames
    ??(!vaultPath&&typeof ctx?.tools?.get==='function'?DEFAULT_LEGACY_VAULT_TOOL_NAMES:null);
  const injected=ctx?.vaultBackend
    ??(legacyNames?createLegacyVaultBackend(ctx.tools,legacyNames):null)
    ??ctx?.tools?.vaultBackend
    ??config.vaultBackend;
  if(!vaultPath&&!injected)throw fail(BACKEND_ERROR,'Vault path is not configured');
  const project=ctx?.project||config.project;
  const backend=injected??createVaultBackend({vaultPath,project});
  const check=()=>{
    ctx?.signal?.throwIfAborted?.();
    ctx?.check?.();
    ctx?.tools?.check?.();
  };
  return {backend,context:{...ctx,config,project,vaultPath,check}};
}

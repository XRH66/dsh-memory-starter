import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {initializeMemoryDirectory,prepareMemoryEnvironment,validateMemoryBackend,assertMemoryPathsInside} from './memory-install.js';
import {unwrapToolValue} from './mcp.js';

const names=['search_notes','read_note','write_note','list_directory','edit_note','move_note'];
const inside=(parent,child)=>{const relative=path.relative(parent,child);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));};
const absent=error=>error.code==='ENOENT'||error.code==='ENOTDIR';
const markdownPath=value=>typeof value==='string'&&/\.md$/i.test(value);
const toolValue=value=>({content:[],structuredContent:{result:value}});
const syncPending=()=>toolValue({error:'NOTE_SYNC_PENDING',retryable:true});
const vanishedEntity=/^(?:Error calling tool 'read_note': )?Entity with external_id '[\da-f-]{36}' not found$/i;

async function localMarkdown(vault,filePath,check,{read=true}={}){
  const parts=filePath.split(/[\\/]/);
  if(parts.some(part=>!part||part==='.'||part==='..'||/[:\u0000-\u001f]/.test(part)))throw Error('Invalid local Markdown path');
  const file=path.join(vault,...parts);
  const exact=async()=>{
    const real=await fs.realpath(file);check();
    if(path.relative(file,real)!=='')throw Error('Local Markdown path redirected');
  };
  let handle;
  try{
    await exact();
    const before=await fs.lstat(file);check();
    if(!before.isFile())throw Error('Local Markdown is not a regular file');
    if(!read)return {exists:true};
    handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));check();
    await exact();
    const opened=await handle.stat();check();
    if(!opened.isFile()||opened.dev!==before.dev||opened.ino!==before.ino)return {changed:true};
    const bytes=await handle.readFile();check();
    await exact();
    const after=await fs.lstat(file);check();
    if(!after.isFile()||after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||
      after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs)return {changed:true};
    return {checksum:createHash('sha256').update(bytes).digest('hex'),content:bytes.toString('utf8')};
  }catch(error){if(absent(error))return null;throw error;}
  finally{await handle?.close();}
}

async function verifyNoteRead({vault,args,knownFilePath,result,value,check}){
  if(value?.error==='NOTE_NOT_FOUND'){
    // A known file can outlive a temporary disappearance from Basic Memory's catalogue.
    const file=knownFilePath??args.identifier;
    if(markdownPath(file)&&await localMarkdown(vault,file,check,{read:false}))return syncPending();
    return result;
  }
  if(value?.error||!markdownPath(value?.file_path))return result;
  const disk=await localMarkdown(vault,value.file_path,check);
  if(!disk||disk.changed||disk.checksum!==value.checksum)return syncPending();
  if(args.include_frontmatter===true&&!args.section&&!args.lines&&args.max_tokens==null&&disk.content!==value.content){
    return toolValue({...value,content:disk.content});
  }
  return result;
}
async function actual(file){try{return await fs.realpath(file);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(file);if(parent===file)throw error;return path.join(await actual(parent),path.basename(file));}}
async function ensureLocalPaths(directory){
  await assertMemoryPathsInside(directory);
}
async function ensureLocalProject(directory){
  const state=path.join(directory,'basic-memory-state'),vault=path.join(directory,'vault');
  await ensureLocalPaths(directory);
  const settings=JSON.parse(await fs.readFile(path.join(state,'config.json'),'utf8'));
  if(settings.projects?.main?.mode!=='local'||!path.isAbsolute(settings.projects.main.path??'')||await actual(settings.projects.main.path)!==await actual(vault)||settings.database_url)throw Error('Memory backend must be a local main project in the selected directory');
}
// Group vaults are separate security scopes; a link anywhere inside one could
// make a read or write escape into another group even when the root is valid.
async function ensureGroupVaultHasNoLinks(directory){
  const vault=path.join(directory,'vault'),pending=[vault];
  while(pending.length){
    const current=pending.pop();let items;
    try{items=await fs.readdir(current,{withFileTypes:true});}catch(error){if(error.code==='ENOENT'&&current===vault)return;throw error;}
    for(const item of items){if(item.isSymbolicLink())throw Error('Group memory vault cannot contain filesystem links');if(item.isDirectory())pending.push(path.join(current,item.name));}
  }
}

/** One private MCP connection per selected scope, never registered as model tools. */
export function createMemoryConnections({backend,personalDirectory,socialRoot,logger}={}){
  validateMemoryBackend(backend);
  if(!path.isAbsolute(personalDirectory??'')||(socialRoot!==undefined&&!path.isAbsolute(socialRoot)))throw Error('Explicit absolute memory scope roots are required');
  let closed=false,closing;const entries=new Map();
  async function resolveDirectory(input){
    if(typeof input!=='string'||!path.isAbsolute(input))throw Error('Explicit memory directory required');
    const requested=path.resolve(input),personalPath=path.resolve(personalDirectory),socialPath=socialRoot?path.resolve(socialRoot):null;
    const [directory,personal,social]=await Promise.all([actual(requested),actual(personalPath),socialPath?actual(socialPath):null]);
    if(social&&(inside(personal,social)||inside(social,personal)))throw Error('Personal and social memory scopes must be separate');
    const personalRequest=requested===personalPath&&directory===personal;
    const expectedSocial=socialPath&&inside(socialPath,requested)?path.resolve(social,path.relative(socialPath,requested)):null;
    const socialRequest=socialPath&&requested!==socialPath&&inside(socialPath,requested)&&directory!==social&&inside(social,directory)&&path.relative(expectedSocial,directory)==='';
    if(!personalRequest&&!socialRequest)throw Error('Memory directory is outside the selected scopes');
    return directory;
  }
  async function open(directory,onDisconnect,existingOnly=false,permitted,isSocial=false){
    const check=()=>{if(permitted&&!permitted())throw Error('Memory authorization changed');};check();
    await ensureLocalPaths(directory);if(isSocial)await ensureGroupVaultHasNoLinks(directory);check();
    try{await fs.access(path.join(directory,'basic-memory-state/config.json'));}
    catch(error){if(error.code!=='ENOENT')throw error;if(existingOnly)return null;check();await initializeMemoryDirectory({directory,backend});}
    check();await ensureLocalProject(directory);if(isSocial)await ensureGroupVaultHasNoLinks(directory);check();
    const env=await prepareMemoryEnvironment(directory,backend);
    const vault=path.join(directory,'vault');
    check();
    const transport=new StdioClientTransport({command:backend.command,args:['mcp','--project','main'],cwd:directory,env,stderr:'pipe'});
    transport.stderr?.on('data',()=>{});
    const client=new Client({name:'dsh-memory-private-connection',version:'0.1.0'});
    try{
      client.onclose=onDisconnect;
      await client.connect(transport);
      check();
      const available=new Set((await client.listTools()).tools.map(tool=>tool.name));
      for(const name of names)if(!available.has(name))throw Error(`Memory backend is missing required tool: ${name}`);
      const tools={get(name){
        const rawName=String(name).replace(/^mcp__basic_memory__/,'');
        if(name!==`mcp__basic_memory__${rawName}`||!names.includes(rawName))return undefined;
        return {name,async execute(args,exec){
          if(args?.project!=='main')throw Error('Memory access is limited to the selected project');
          if(isSocial)await ensureGroupVaultHasNoLinks(directory);
          const assertCurrent=()=>{
            exec?.signal?.throwIfAborted();
            if(exec?.memoryAuthorization&&!exec.memoryAuthorization())throw Error('Memory authorization changed');
          };
          assertCurrent();
          const {known_file_path:knownFilePath,...wireArgs}=args;
          const result=await client.callTool({name:rawName,arguments:wireArgs},{signal:exec?.signal,timeout:45000});
          assertCurrent();
          if(!Array.isArray(result.content))throw Error('Invalid memory backend result');
          if(result.isError){
            const value=unwrapToolValue({value:result});
            if(['edit_note','write_note'].includes(rawName)&&value?.error==='NOTE_REVISION_CONFLICT'){
              return toolValue({error:value.error,currentChecksum:value.currentChecksum??null});
            }
            // The watcher can remove the entity between resolve and get_entity.
            if(rawName==='read_note'&&args.output_format==='json'&&vanishedEntity.test(value?.text?.trim()??''))return syncPending();
            throw Error('Memory backend tool returned an error');
          }
          const response={content:result.content,...result.structuredContent===undefined?{}:{structuredContent:result.structuredContent}};
          if(rawName==='read_note'&&args.output_format==='json'&&args.include_content!==false){
            const value=unwrapToolValue({value:response});
            const verified=await verifyNoteRead({vault,args,knownFilePath,result:response,value,check:assertCurrent});
            assertCurrent();
            return verified;
          }
          return response;
        }};
      }};
      // Verify the text route without starting Basic Memory's legacy embedder.
      check();
      await tools.get('mcp__basic_memory__search_notes').execute({project:'main',query:'DSH Chat',tags:['dsh-memory'],page_size:1,search_type:'text',output_format:'json'},{});
      check();
      return {tools,close:()=>client.close()};
    }catch(error){await client.close().catch(()=>{});throw error;}
  }
  async function getOrStart(directory,existingOnly,permitted){
    if(permitted&&!permitted())throw Error('Memory authorization changed');
    const social=socialRoot?await actual(path.resolve(socialRoot)):null,isSocial=Boolean(social&&inside(social,directory)&&directory!==social);
    if(permitted&&!permitted())throw Error('Memory authorization changed');
    if(!entries.has(directory)){
      const entry={required:!permitted,permits:new Set(permitted?[permitted]:[]),pending:null};
      const allowed=()=>entry.required||[...entry.permits].some(check=>check());
      entry.pending=open(directory,()=>{if(entries.get(directory)===entry)entries.delete(directory);},existingOnly,allowed,isSocial);entries.set(directory,entry);
      entry.pending.then(result=>{if(!result&&entries.get(directory)===entry)entries.delete(directory);},error=>{if(entries.get(directory)===entry)entries.delete(directory);logger?.warn?.('[basic-memory-bridge] connection failed: '+error.message);});
    }
    const entry=entries.get(directory);if(permitted)entry.permits.add(permitted);else entry.required=true;
    try{const value=await entry.pending;
      if(permitted&&!permitted())throw Error('Memory authorization changed');
      if(!value&&!existingOnly){if(closed)throw Error('Memory connections are closed');return getOrStart(directory,false);}
      return value;
    }finally{if(permitted)entry.permits.delete(permitted);}
  }
  return {
    async peek(input){
      if(closed)throw Error('Memory connections are closed');
      const directory=await resolveDirectory(input),entry=entries.get(directory);
      return entry?await entry.pending:null;
    },
    async acquire(input){
      if(closed)throw Error('Memory connections are closed');
      const directory=await resolveDirectory(input);
      if(closed)throw Error('Memory connections are closed');
      return getOrStart(directory,false);
    },
    async acquireExisting(input,{permitted}={}){
      if(closed)throw Error('Memory connections are closed');
      if(permitted&&!permitted())throw Error('Memory authorization changed');
      const directory=await resolveDirectory(input);
      if(closed)throw Error('Memory connections are closed');
      return getOrStart(directory,true,permitted);
    },
    async release(input){
      if(closed)return;
      const directory=await resolveDirectory(input),entry=entries.get(directory);if(!entry)return;
      entries.delete(directory);const result=await Promise.allSettled([entry.pending]);if(result[0].status==='fulfilled'&&result[0].value)await result[0].value.close();
    },
    close(){
      if(closing)return closing;closed=true;
      closing=(async()=>{const pending=[...entries.values()].map(entry=>entry.pending);entries.clear();const results=await Promise.allSettled(pending);const failures=[];for(const result of results)if(result.status==='fulfilled'&&result.value)try{await result.value.close();}catch(error){failures.push(error);}if(failures.length)throw new AggregateError(failures,'Memory connections did not close cleanly');})();
      return closing;
    },
  };
}

export const name='basic-memory-connections';
export function apply(ctx,options={}){
  const connections=createMemoryConnections({...options,logger:ctx.logger});
  ctx.effect(()=>()=>connections.close());
  ctx.provide('memoryConnections',connections);
}

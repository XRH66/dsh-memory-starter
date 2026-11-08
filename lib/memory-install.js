import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

const modelDirectory='models--Qdrant--bge-small-zh-v1.5';
const inside=(a,b)=>{const r=path.relative(a,b);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
async function actualLocation(value){try{return await fs.realpath(value);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(value);if(parent===value)throw error;return path.join(await actualLocation(parent),path.basename(value));}}
export async function assertMemoryPathsInside(directory){
  const state=path.join(directory,'basic-memory-state');
  const managed=[state,path.join(directory,'vault'),path.join(state,'config.json'),path.join(state,'memory.db'),path.join(state,'memory.db-wal'),path.join(state,'memory.db-shm'),path.join(directory,'management'),path.join(directory,'runtime-home'),path.join(directory,'temp'),path.join(directory,'embedding-cache'),path.join(directory,'embedding-cache',modelDirectory),path.join(directory,'hf-cache'),path.join(directory,'qqbridge-memory-install.json'),path.join(directory,'.initializing.lock'),path.join(directory,'initialization-error.txt')];
  for(const item of managed)if(!inside(directory,await actualLocation(item)))throw Error('Memory data paths must remain inside the selected directory');
}
/** Check both lexical and real locations before creating an independent library. */
export async function validateNewMemoryLocation(directory,excluded=[]){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('新记忆目录必须是绝对路径');
  const requested=path.resolve(directory),actual=await actualLocation(requested);
  for(const other of excluded.filter(Boolean)){
    if(!path.isAbsolute(other))throw Error('现有记忆范围路径无效');
    const existing=path.resolve(other),real=await actualLocation(existing);
    if(inside(requested,existing)||inside(existing,requested)||inside(actual,real)||inside(real,actual))throw Error('新记忆库必须与现有个人库和群目录分开');
  }
  return requested;
}
/** Validate a previously initialized local library without starting its backend. */
export async function validateExistingMemoryDirectory(directory){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('记忆库目录必须是绝对路径');
  const requested=path.resolve(directory),root=await fs.realpath(requested);if(root!==requested)throw Error('记忆库目录不能是链接，请使用实际路径');
  await assertMemoryPathsInside(root);
  const state=path.join(root,'basic-memory-state'),settings=JSON.parse(await fs.readFile(path.join(state,'config.json'),'utf8'));
  if(settings.database_url||settings.projects?.main?.mode!=='local'||!path.isAbsolute(settings.projects.main.path??'')||await actualLocation(settings.projects.main.path)!==await actualLocation(path.join(root,'vault')))throw Error('记忆后端 main 项目未指向所选目录的 vault');
  if(!(await fs.readdir(state)).some(name=>/\.db$|\.sqlite/.test(name)))throw Error('所选记忆库数据库不存在');
  return root;
}
export async function hasMemoryPending(directory){
  const root=await fs.realpath(directory),file=path.join(root,'management/memory-status/recovery.json');
  if(!inside(root,await actualLocation(file)))throw Error('待处理记录不能指向记忆库之外');
  let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(state.version!==1||state.project!=='main'||!Array.isArray(state.jobs)||!Array.isArray(state.pending))throw Error('记忆待处理记录损坏，不能切换');
  return state.jobs.length>0||state.pending.length>0;
}
export function validateMemoryBackend(backend){
  if(!backend||typeof backend.command!=='string'||!path.isAbsolute(backend.command))throw Error('请配置 Basic Memory 可执行文件的绝对路径');
  if(backend.embeddingCache!==undefined&&!path.isAbsolute(backend.embeddingCache))throw Error('模型缓存目录必须是绝对路径');
  if(backend.offline!==undefined&&typeof backend.offline!=='boolean')throw Error('offline 必须是布尔值');
  if(backend.embeddingThreads!==undefined&&(!Number.isInteger(backend.embeddingThreads)||backend.embeddingThreads<1||backend.embeddingThreads>32))throw Error('事实检索线程数必须在 1 到 32 之间');
  return backend;
}
/** No inherited memory configuration, credentials or user-home defaults. */
export function memoryBackendEnvironment(directory,backend,parent=process.env){
  validateMemoryBackend(backend);if(!path.isAbsolute(directory))throw Error('记忆根目录必须是绝对路径');
  const env={};for(const [key,value] of Object.entries(parent))if(/^(path|pathext|systemroot|windir|comspec|programdata|programfiles|programfiles\(x86\)|number_of_processors|processor_architecture)$/i.test(key))env[key]=value;
  const home=path.join(directory,'runtime-home');
  return {...env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),
    TEMP:path.join(directory,'temp'),TMP:path.join(directory,'temp'),BASIC_MEMORY_CONFIG_DIR:path.join(directory,'basic-memory-state'),BASIC_MEMORY_HOME:path.join(directory,'vault'),
    BASIC_MEMORY_CLOUD_MODE:'false',BASIC_MEMORY_DATABASE_BACKEND:'sqlite',BASIC_MEMORY_DEFAULT_PROJECT:'main',BASIC_MEMORY_SEMANTIC_EMBEDDING_PROVIDER:'fastembed',BASIC_MEMORY_SEMANTIC_EMBEDDING_MODEL:'BAAI/bge-small-zh-v1.5',BASIC_MEMORY_SEMANTIC_EMBEDDING_DIMENSIONS:'512',
    BASIC_MEMORY_AUTO_UPDATE:'false',BASIC_MEMORY_LOGFIRE_ENABLED:'false',BASIC_MEMORY_LOGFIRE_SEND_TO_LOGFIRE:'false',FASTEMBED_CACHE_PATH:path.join(directory,'embedding-cache'),HF_HOME:path.join(directory,'hf-cache'),HF_HUB_OFFLINE:backend.offline===true?'1':'0',
    BASIC_MEMORY_SEMANTIC_EMBEDDING_THREADS:String(backend.embeddingThreads || 2),BASIC_MEMORY_SEMANTIC_EMBEDDING_PARALLEL:'1',
    PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',PYTHONNOUSERSITE:'1'};
}
export async function prepareMemoryEnvironment(directory,backend){
  const env=memoryBackendEnvironment(directory,backend);
  for(const folder of [env.HOME,env.APPDATA,env.LOCALAPPDATA,env.TEMP,env.BASIC_MEMORY_CONFIG_DIR,env.BASIC_MEMORY_HOME,env.FASTEMBED_CACHE_PATH])await fs.mkdir(folder,{recursive:true});
  return env;
}
export async function runMemoryCommand(directory,backend,args,{timeoutMs=120000}={}){
  const env=await prepareMemoryEnvironment(directory,backend),began=performance.now();
  return new Promise((resolve,reject)=>{
    const child=spawn(backend.command,args,{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    let stdout='',stderr='',timedOut=false;
    child.stdout.on('data',data=>{stdout=(stdout+data).slice(-1000000);});child.stderr.on('data',data=>{stderr=(stderr+data).slice(-16000);});
    const timer=setTimeout(()=>{timedOut=true;child.kill();},timeoutMs);
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('close',code=>{clearTimeout(timer);const result={code,stdout,stderr,elapsedMs:performance.now()-began};if(timedOut||code!==0){const error=Error(timedOut?'记忆初始化命令超时，可修正后重试':`Basic Memory 命令失败（退出 ${code}），详见新目录中的 initialization-error.txt`);error.commandResult=result;reject(error);}else resolve(result);});
  });
}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function save(file,value){const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n');await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}}
/** New independent destination only. Retry only directories created by this initializer. */
export async function initializeMemoryDirectory({directory,backend}){
  validateMemoryBackend(backend);if(!path.isAbsolute(directory))throw Error('新记忆目录必须是绝对路径');
  directory=path.resolve(directory);await fs.access(backend.command);
  await fs.mkdir(directory,{recursive:true});
  if(await fs.realpath(directory)!==directory)throw Error('初始化目录不能是链接或经过目录别名，请使用实际路径');
  await assertMemoryPathsInside(directory);
  const markerFile=path.join(directory,'qqbridge-memory-install.json'),lockFile=path.join(directory,'.initializing.lock');
  let marker;
  try{marker=await json(markerFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!marker&&(await fs.readdir(directory)).length)throw Error('新库目录不是空目录；请选择新目录，不能覆盖现有记忆');
  if(marker&&(marker.version!==1||marker.directory!==directory))throw Error('初始化记录与目标目录不匹配');
  const lock=await fs.open(lockFile,'wx').catch(error=>{if(error.code==='EEXIST')throw Error('该目录正在初始化');throw error;});
  const started=performance.now(),timingMs={};
  try{
    await assertMemoryPathsInside(directory);
    // Re-check after taking the exclusive lock to avoid adopting another initializer's work.
    if(!marker){const names=(await fs.readdir(directory)).filter(name=>name!=='.initializing.lock');if(names.length)throw Error('目录已被另一操作使用');}
    marker??={version:1,directory,createdAt:new Date().toISOString()};
    if(marker.state==='ready'){
      const settings=await json(path.join(directory,'basic-memory-state/config.json'));
      if(settings.projects?.main?.mode!=='local'||path.resolve(settings.projects.main.path)!==path.join(directory,'vault'))throw Error('已初始化库的项目登记不匹配');
      if(!(await fs.readdir(path.join(directory,'basic-memory-state'))).some(name=>/\.db$|\.sqlite/.test(name)))throw Error('已初始化库的数据库缺失');
      return {directory,alreadyInitialized:true,timingMs:{total:performance.now()-started}};
    }
    await save(markerFile,{...marker,state:'initializing'});
    const env=await prepareMemoryEnvironment(directory,backend);
    const version=await runMemoryCommand(directory,backend,['--version']);timingMs.version=version.elapsedMs;
    if(!/\b0\.24\.1\b/.test(version.stdout))throw Error('当前初始化流程仅验证 Basic Memory 0.24.1，请保留现用版本');
    const settingsFile=path.join(env.BASIC_MEMORY_CONFIG_DIR,'config.json');
    let settings;try{settings=await json(settingsFile);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(settings){if(settings.projects?.main?.mode!=='local'||path.resolve(settings.projects.main.path)!==path.join(directory,'vault'))throw Error('重试目录中的后端登记已被改变');}
    else await fs.writeFile(settingsFile,JSON.stringify({projects:{main:{path:path.join(directory,'vault'),mode:'local'}},default_project:'main'},null,2),{flag:'wx'});
    const cache=path.join(env.FASTEMBED_CACHE_PATH,modelDirectory);
    if(backend.embeddingCache){const began=performance.now();await fs.cp(path.join(backend.embeddingCache,modelDirectory),cache,{recursive:true,dereference:true,force:true});timingMs.copyModel=performance.now()-began;}
    else if(backend.offline){try{await fs.access(cache);}catch(error){if(error.code!=='ENOENT')throw error;throw Error('离线初始化需要已下载的模型缓存，请先配置 embeddingCache');}}
    const index=await runMemoryCommand(directory,backend,['project','index','main']);timingMs.index=index.elapsedMs;
    const search=await runMemoryCommand(directory,backend,['tool','search-notes','qqbridge-initialization-check','--project','main','--hybrid','--local','--json']);timingMs.search=search.elapsedMs;
    const searchResult=JSON.parse(search.stdout);if(searchResult.error||searchResult.isError)throw Error('新库检索自检失败');
    const databases=(await fs.readdir(env.BASIC_MEMORY_CONFIG_DIR)).filter(name=>/\.db$|\.sqlite/.test(name));if(!databases.length)throw Error('后端未建立独立数据库');
    timingMs.total=performance.now()-started;
    await save(markerFile,{...marker,state:'ready',readyAt:new Date().toISOString(),backendVersion:'0.24.1',timingMs});
    return {directory,initialized:true,backendVersion:'0.24.1',databases,timingMs};
  }catch(error){
    if(marker){await save(markerFile,{...marker,state:'failed',failedAt:new Date().toISOString(),error:error.message});await fs.writeFile(path.join(directory,'initialization-error.txt'),error.commandResult?.stderr||error.message);}
    throw error;
  }finally{await lock.close();await fs.rm(lockFile,{force:true});}
}

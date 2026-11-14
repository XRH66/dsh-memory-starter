import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJsonAtomic} from './atomic-file.js';

const inside=(a,b)=>{const r=path.relative(a,b);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
async function actualLocation(value){try{return await fs.realpath(value);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(value);if(parent===value)throw error;return path.join(await actualLocation(parent),path.basename(value));}}
export async function assertMemoryPathsInside(directory){
  const managed=[path.join(directory,'vault'),path.join(directory,'management'),path.join(directory,'qqbridge-memory-install.json'),path.join(directory,'.initializing.lock'),path.join(directory,'initialization-error.txt')];
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
  // The framework reads and writes the vault directly; a library is its vault directory.
  const vault=await fs.stat(path.join(root,'vault')).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  if(!vault?.isDirectory())throw Error('所选记忆库缺少 vault 目录');
  return root;
}
export async function hasMemoryPending(directory){
  const root=await fs.realpath(directory),file=path.join(root,'management/memory-status/recovery.json');
  if(!inside(root,await actualLocation(file)))throw Error('待处理记录不能指向记忆库之外');
  let state;try{state=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return false;throw error;}
  if(state.version!==1||state.project!=='main'||!Array.isArray(state.jobs)||!Array.isArray(state.pending))throw Error('记忆待处理记录损坏，不能切换');
  return state.jobs.length>0||state.pending.length>0;
}
async function json(file){return JSON.parse(await fs.readFile(file,'utf8'));}
async function save(file,value){await writeJsonAtomic(file,value,{space:2,trailingNewline:true});}
/** New independent destination only: create the vault and management folders and the
 * install marker. Retry only directories created by this initializer. */
export async function initializeMemoryDirectory({directory}){
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('新记忆目录必须是绝对路径');
  directory=path.resolve(directory);
  await fs.mkdir(directory,{recursive:true});
  if(await fs.realpath(directory)!==directory)throw Error('初始化目录不能是链接或经过目录别名，请使用实际路径');
  await assertMemoryPathsInside(directory);
  const markerFile=path.join(directory,'qqbridge-memory-install.json'),lockFile=path.join(directory,'.initializing.lock');
  let marker;
  try{marker=await json(markerFile);}catch(error){if(error.code!=='ENOENT')throw error;}
  if(!marker&&(await fs.readdir(directory)).length)throw Error('新库目录不是空目录；请选择新目录，不能覆盖现有记忆');
  if(marker&&(marker.version!==1||marker.directory!==directory))throw Error('初始化记录与目标目录不匹配');
  const lock=await fs.open(lockFile,'wx').catch(error=>{if(error.code==='EEXIST')throw Error('该目录正在初始化');throw error;});
  try{
    await assertMemoryPathsInside(directory);
    // Re-check after taking the exclusive lock to avoid adopting another initializer's work.
    if(!marker){const names=(await fs.readdir(directory)).filter(name=>name!=='.initializing.lock');if(names.length)throw Error('目录已被另一操作使用');}
    marker??={version:1,directory,createdAt:new Date().toISOString()};
    if(marker.state==='ready'){await validateExistingMemoryDirectory(directory);return {directory,alreadyInitialized:true};}
    await save(markerFile,{...marker,state:'initializing'});
    for(const folder of ['vault','management'])await fs.mkdir(path.join(directory,folder),{recursive:true});
    await fs.rm(path.join(directory,'initialization-error.txt'),{force:true});
    await save(markerFile,{...marker,state:'ready',readyAt:new Date().toISOString()});
    return {directory,initialized:true};
  }catch(error){
    if(marker){await save(markerFile,{...marker,state:'failed',failedAt:new Date().toISOString(),error:error.message});await fs.writeFile(path.join(directory,'initialization-error.txt'),error.message);}
    throw error;
  }finally{await lock.close();await fs.rm(lockFile,{force:true});}
}

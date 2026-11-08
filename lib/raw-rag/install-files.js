import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../config.js';
import { rawModelSpec,embeddingCredentialEndpoint } from './models.js';
import { embeddingAssets,bgeModelDirectory } from './assets.js';
import { PYTHON_PACKAGES,FASTEMBED_PACKAGE } from './install-catalog.js';
const execute=promisify(execFile);
const worker=fileURLToPath(new URL('./embed_worker.py',import.meta.url));
export async function exists(file){try{return (await fs.stat(file)).isFile();}catch(error){if(error.code==='ENOENT'||error.code==='ENOTDIR')return false;throw error;}}

export async function pythonPackages(python){
  if(!path.isAbsolute(python || '')||!await exists(python))return {};
  const parent=path.dirname(python),base=/^(?:scripts|bin)$/i.test(path.basename(parent))?path.dirname(parent):parent;
  const directories=[path.join(base,'Lib','site-packages')];
  try{for(const name of await fs.readdir(path.join(base,'lib')))if(/^python3\.\d+$/.test(name))directories.push(path.join(base,'lib',name,'site-packages'));}catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))throw error;}
  const versions={};
  for(const directory of directories){
    let names;try{names=await fs.readdir(directory);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    for(const name of names.filter(name=>/^(?:numpy|tokenizers|onnxruntime|fastembed)-[^/]+\.dist-info$/i.test(name))){
      const content=await fs.readFile(path.join(directory,name,'METADATA'),'utf8');
      const distribution=/^Name:\s*(.+)$/m.exec(content)?.[1]?.trim().toLowerCase();
      const version=/^Version:\s*(.+)$/m.exec(content)?.[1]?.trim();
      if(distribution&&version)versions[distribution]=version;
    }
  }
  return versions;
}
export const pythonRequirements=spec=>[...PYTHON_PACKAGES,...(spec.engine==='fastembed'?[FASTEMBED_PACKAGE]:[])];
export async function findPython(cfg,settings={},spec={engine:'onnx'}){
  const candidates=[settings.rawRecallPython,path.join(path.dirname(cfg.backend?.command || ''),process.platform==='win32'?'python.exe':'python3')];
  if(process.platform==='win32'&&process.env.LOCALAPPDATA)candidates.push(path.join(process.env.LOCALAPPDATA,'Programs','Python','Python312','python.exe'));
  for(const directory of (process.env.PATH || '').split(path.delimiter))if(directory)candidates.push(path.join(directory,process.platform==='win32'?'python.exe':'python3'));
  let first=null,python312=null;
  for(const file of [...new Set(candidates.filter(file=>path.isAbsolute(file || '')))])try{
    if(!await exists(file))continue;
    const candidate={file,packages:await pythonPackages(file)};
    if(pythonRequirements(spec).every(item=>{const [name,version]=item.split('==');return candidate.packages[name]===version;}))return candidate;
    const parent=path.dirname(file),base=/^(?:scripts|bin)$/i.test(path.basename(parent))?path.dirname(parent):parent;
    let version='';try{version=await fs.readFile(path.join(base,'pyvenv.cfg'),'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(/^version\s*=\s*3\.12\./m.test(version)||await exists(path.join(base,'python312.dll')))python312 ||= candidate;
    first ||= candidate;
  }catch(error){
    // Windows PATH can contain an inaccessible Store execution alias. An
    // optional candidate must not hide an otherwise usable Python runtime.
    if(['EACCES','EPERM'].includes(error.code)&&file!==settings.rawRecallPython)continue;
    throw error;
  }
  return python312 || first;
}

/** File/dependency inventory only. This never imports a model or calls an API. */
export async function inspectSelectedInstallation(input){
  const config=resolveConfig(input),spec=rawModelSpec(config),issues=[];
  if(spec.engine==='api'){
    if(!config.rawRecallAllowCloud)issues.push('请明确选择云端检索');
    try{embeddingCredentialEndpoint(config);}catch(error){issues.push(error.message);}
    let key=process.env[config.rawRecallApiKeyEnv];
    if(config.rawRecallApiKeyFile)try{key=await fs.readFile(config.rawRecallApiKeyFile,'utf8');}catch{issues.push('已保存的 API Key 文件不存在或无法读取');}
    if(!String(key || '').trim())issues.push('请填写 API Key，或配置相应环境变量');
    return {ready:!issues.length,model:spec.id,level:'configuration-only',issues,message:'只读取配置，未请求 API；实际可用性待运行确认'};
  }
  try{const assets=await embeddingAssets(spec,config,worker);for(const entry of assets.entries)if(!await exists(entry.file))issues.push('缺少模型或运行文件：'+entry.name);}catch(error){issues.push(error.message);}
  let packages={};
  if(['fastembed','onnx'].includes(spec.engine)){
    if(!path.isAbsolute(config.rawRecallPython)||!await exists(config.rawRecallPython))issues.push('请选择已安装的 Python 程序完整路径');
    else{
      packages=await pythonPackages(config.rawRecallPython);
      for(const requirement of pythonRequirements(spec))if(!packages[requirement.split('==')[0]])issues.push('缺少本地运行依赖 '+requirement.split('==')[0]);
    }
  }
  if(spec.engine==='llamacpp'&&config.rawRecallLlamaContext<=spec.maxTokens)issues.push('向量输入上限必须小于运行上下文');
  if(config.rawRecallInstallReceipt){
    try{
      let receipt;try{const stat=await fs.stat(config.rawRecallInstallReceipt);if(stat.size>1048576)throw Error('oversize');receipt=JSON.parse(await fs.readFile(config.rawRecallInstallReceipt,'utf8'));}
      catch{throw Error('安装记录无法读取或格式无效，请重新准备');}
      if(receipt.schema!==1||receipt.model!==spec.id)throw Error('安装记录与所选型号不一致');
      const names=spec.engine==='fastembed'?['rawRecallPython','rawRecallBgeModelDir']:spec.engine==='onnx'?['rawRecallPython','rawRecallOnnxModel','rawRecallOnnxTokenizer']:['rawRecallGgufModel','rawRecallLlamaServer'];
      for(const name of names){
        if(receipt.settings[name]!==config[name])throw Error('模型路径已改变，请在高级设置重新指定已有文件，或重新准备');
      }
      for(const file of receipt.files || []){const stat=await fs.stat(file.path);if(stat.size!==file.size||stat.mtimeMs!==file.mtimeMs)throw Error('已准备文件发生变化，请重新准备');}
      for(const [name,version] of Object.entries(receipt.packages || {}))if(packages[name]!==version)throw Error('Python 依赖已改变，请重新准备');
    }catch(error){issues.push(error.message);}
  }
  return {ready:!issues.length,model:spec.id,level:'files-and-metadata-only',packages,issues,
    message:issues.length?'文件或运行依赖尚未准备完整':'文件与依赖信息已就绪；未试跑模型'};
}

export async function existingBge(cfg,settings){
  for(const cache of [...new Set([settings.rawRecallCacheDir,path.join(cfg.ownerDirectory,'embedding-cache')].filter(Boolean))]){
    try{const directory=await bgeModelDirectory({...settings,rawRecallCacheDir:cache});return {directory,cache};}catch{/* Offer the normal install recipe when no existing snapshot can be located. */}
  }
  return null;
}

export async function deviceResources({readGpu=false}={}){
  const cpuThreads=os.availableParallelism?.() || os.cpus().length;
  const result={totalRamGiB:os.totalmem()/2**30,freeRamGiB:os.freemem()/2**30,cpuThreads,
    suggestedThreads:Math.max(1,Math.min(4,Math.floor(cpuThreads/2))),gpus:[],gpuState:'not-read'};
  if(readGpu){
    try{
      const {stdout}=await execute('nvidia-smi',['--query-gpu=name,memory.total,memory.free','--format=csv,noheader,nounits'],{windowsHide:true,timeout:3000,maxBuffer:16384});
      result.gpus=stdout.trim().split(/\r?\n/).map(line=>{const parts=line.split(',').map(part=>part.trim());return {name:parts.slice(0,-2).join(','),totalGiB:Number(parts.at(-2))/1024,freeGiB:Number(parts.at(-1))/1024};})
        .filter(gpu=>Number.isFinite(gpu.freeGiB)&&gpu.freeGiB>=0);
      result.gpuState=result.gpus.length?'available':'unavailable';
    }catch{result.gpuState='unavailable';}
  }
  const gpu=Math.max(0,...result.gpus.map(gpu=>gpu.freeGiB));
  result.recommendedModel=gpu>=8&&result.freeRamGiB>=6 || result.freeRamGiB>=14?'Qwen/Qwen3-Embedding-8B'
    :gpu>=4&&result.freeRamGiB>=4 || result.freeRamGiB>=8?'Qwen/Qwen3-Embedding-4B'
    :result.freeRamGiB>=3?'Qwen/Qwen3-Embedding-0.6B':'BAAI/bge-small-zh-v1.5';
  result.recommendationBasis='保守资源预算，非速度或质量实测；可自行选择其他型号';
  return result;
}

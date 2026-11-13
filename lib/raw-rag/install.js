import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { randomUUID,createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveConfig } from '../config.js';
import { rawModelOptions, rawModelSpec } from './models.js';
import { RAW_MODEL_FIELDS } from './settings.js';
import { INSTALL_CATALOG,LLAMA_RUNTIME } from './install-catalog.js';
import { installPath,inside,verifiedDownload,fileDigest,saveInstallJson,userCancel } from './install-download.js';
import { findPython,pythonPackages,pythonRequirements,existingBge,deviceResources,inspectSelectedInstallation,exists } from './install-files.js';
const ROOT='runtime/embedding-install-v1';
const unpacker=fileURLToPath(new URL('../../scripts/unpack-embedding.ps1',import.meta.url));
const INVENTORY_PATH_FIELDS=Object.freeze(['rawRecallPython','rawRecallCacheDir','rawRecallBgeModelDir',
  'rawRecallOnnxModel','rawRecallOnnxTokenizer','rawRecallGgufModel','rawRecallLlamaServer',
  'rawRecallLlamaCpuServer','rawRecallLlamaCudaServer','rawRecallLlamaGpuLayers','rawRecallInstallReceipt']);
// Only artifacts the installer itself downloads must sit under the install root. Python and the
// fastembed cache come from discovery or the user's configured cache directory, so a pinned
// fastembed receipt legitimately points outside the root and is still accepted.
const RECEIPT_PATH_FIELDS=Object.freeze(['rawRecallOnnxModel','rawRecallOnnxTokenizer','rawRecallGgufModel',
  'rawRecallLlamaServer','rawRecallLlamaCpuServer','rawRecallLlamaCudaServer']);

function receiptPathsInside(root,settings){
  const normalized=(value)=>process.platform==='win32'?String(value).toLowerCase():String(value);
  const base=normalized(path.resolve(root));
  for(const name of RECEIPT_PATH_FIELDS){
    if(!Object.hasOwn(settings,name)||settings[name]==='')continue;
    const value=settings[name];
    if(typeof value!=='string'||!path.isAbsolute(value))return false;
    const relative=path.relative(base,normalized(path.resolve(value)));
    if(path.isAbsolute(relative)||relative==='..'||relative.startsWith('..'+path.sep))return false;
  }
  return true;
}

function selectedConfig(cfg,input={}){
  const defaults=resolveConfig(cfg.memory || {}),fields={};
  for(const name of RAW_MODEL_FIELDS)if(Object.hasOwn(input,name)){
    if(typeof input[name]!==typeof defaults[name])throw Error('向量模型参数格式无效');fields[name]=input[name];
  }
  return resolveConfig({...cfg.memory,...fields});
}
function modelSettings(settings,id){
  if(!settings||typeof settings!=='object')return false;
  try{return rawModelSpec(settings).id===id;}catch{return false;}
}
function inventorySettings(settings={}){
  return Object.fromEntries(INVENTORY_PATH_FIELDS.filter(name=>Object.hasOwn(settings,name)).map(name=>[name,settings[name]]));
}
async function libraryInstallReceipts(cfg){
  const receipts=[];
  try{
    const installRoot=await installPath(cfg.ownerDirectory,ROOT);
    const directory=await installPath(cfg.ownerDirectory,ROOT+'/receipts');
    for(const entry of await fs.readdir(directory,{withFileTypes:true})){
      if(!entry.isFile()||!/\.json$/i.test(entry.name))continue;
      try{
        const file=await installPath(cfg.ownerDirectory,ROOT+'/receipts/'+entry.name);
        const stat=await fs.stat(file);if(stat.size>1048576)continue;
        const receipt=JSON.parse(await fs.readFile(file,'utf8'));
        if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||receipt.schema!==1||
          typeof receipt.model!=='string'||!receipt.settings||typeof receipt.settings!=='object'||Array.isArray(receipt.settings))continue;
        if(receipt.mode!=='user-supplied-files'&&!receiptPathsInside(installRoot,receipt.settings))continue;
        const at=Date.parse(receipt.at);
        receipts.push({file,model:receipt.model,settings:receipt.settings,
          order:Number.isFinite(at)?at:stat.mtimeMs,name:entry.name});
      }catch{/* A damaged receipt cannot hide another usable installation. */}
    }
  }catch{/* Missing or unusable receipt storage leaves normal discovery available. */}
  return receipts.sort((left,right)=>right.order-left.order||right.name.localeCompare(left.name));
}
function runCommand(program,args,{signal,timeoutMs=900000}={}){
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const env={...process.env,PYTHONUTF8:'1',PYTHONNOUSERSITE:'1',PIP_CONFIG_FILE:process.platform==='win32'?'NUL':'/dev/null'};
    for(const name of Object.keys(env))if(/^PIP_/i.test(name)&&name!=='PIP_CONFIG_FILE'||/^PYTHON(?:HOME|PATH)$/i.test(name))delete env[name];
    const child=spawn(program,args,{windowsHide:true,stdio:['ignore','ignore','ignore'],env});
    const abort=()=>{child.kill();};signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{child.kill();},timeoutMs);let settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
    child.once('error',()=>finish(Error('安装程序无法启动，请检查 Python 或解压程序路径')));
    child.once('close',code=>finish(signal?.aborted?Error('安装已取消，已下载部分保留以便继续'):code===0?null:Error('运行环境准备未成功（退出 '+code+'），未修改当前模型；可重试或使用高级设置')));
  });
}
async function flattenRuntime(source,target,signal){
  for(const entry of await fs.readdir(source,{withFileTypes:true})){
    signal?.throwIfAborted();const file=path.join(source,entry.name);
    if(entry.isSymbolicLink())throw Error('运行环境包中不能包含链接');
    if(entry.isDirectory())await flattenRuntime(file,target,signal);
    else if(/\.(?:exe|dll)$/i.test(entry.name)){
      const destination=path.join(target,entry.name);
      if(await exists(destination)){if(await fileDigest(destination,signal)!==await fileDigest(file,signal))throw Error('运行环境包存在同名不同内容文件');}
      else await fs.copyFile(file,destination,1);
    }
  }
}
async function acquireInstallLock(job,root){
  const file=await installPath(root,ROOT+'/install.lock');await fs.mkdir(path.dirname(file),{recursive:true});
  for(let attempt=0;attempt<2;attempt++){
    try{const handle=await fs.open(file,'wx');await handle.writeFile(JSON.stringify({id:job.id,pid:process.pid,at:job.startedAt}));return {file,handle};}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      let owner;try{owner=JSON.parse(await fs.readFile(file,'utf8'));}catch{throw Error('安装锁记录不完整，请保留现场后处理，不要同时重复安装');}
      if(!Number.isInteger(owner.pid)||owner.pid<=0)throw Error('安装锁记录无效');
      let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}
      if(alive)throw Error('另一个安装准备仍在运行，请等待或在其入口取消');
      await fs.rename(file,file+'.stale-'+randomUUID());
    }
  }
  throw Error('安装入口正在被另一操作使用，请稍后继续');
}

/** One explicit installation job per settings host. No startup/model/API probe. */
export function createModelInstaller({readConfiguration,stageModel}){
  let current=null,closed=false,starting=false;
  const publicJob=()=>current?{id:current.id,state:current.state,model:current.model,step:current.step,
    received:current.received || 0,total:current.total || 0,file:current.file || null,error:current.error || null,
    startedAt:current.startedAt,finishedAt:current.finishedAt || null}:null;
  async function plan(input={}){
    const {cfg,revision}=await readConfiguration();
    if(input.revision&&input.revision!==revision)throw Error('配置已改变，请刷新后准备');
    const config=selectedConfig(cfg,input.settings),spec=rawModelSpec(config);
    if(spec.engine==='api')return {model:spec.id,revision,cloud:true,downloadBytes:0,resources:await deviceResources(),
      message:'云端只需填写地址和密钥；不会在准备阶段请求 API'};
    const catalog=INSTALL_CATALOG[spec.id];if(!catalog)throw Error('该型号尚无安装配方');
    await installPath(cfg.ownerDirectory,ROOT);
    const resources=await deviceResources({readGpu:input.readGpu===true});
    const acceleration=input.acceleration==='cuda'?'cuda':'cpu';
    const python=['fastembed','onnx'].includes(spec.engine)?await findPython(cfg,config,spec):null;
    const bge=spec.engine==='fastembed'?await existingBge(cfg,config):null;
    const directory=spec.engine==='fastembed'?(bge?.directory || path.join(cfg.ownerDirectory,'embedding-cache','models--Qdrant--bge-small-zh-v1.5','snapshots',catalog.revision))
      :path.join(cfg.ownerDirectory,ROOT,'models',catalog.key,catalog.revision);
    const settings={...Object.fromEntries(RAW_MODEL_FIELDS.map(name=>[name,config[name]])),rawRecallModel:spec.id,rawRecallAllowCloud:false,
      rawRecallDimensions:0,rawRecallThreads:input.settings?.rawRecallThreads || resources.suggestedThreads,rawRecallInstallReceipt:''};
    if(spec.engine==='fastembed')Object.assign(settings,{rawRecallPython:python?.file || '',rawRecallCacheDir:bge?.cache || path.join(cfg.ownerDirectory,'embedding-cache'),rawRecallBgeModelDir:directory});
    if(spec.engine==='onnx')Object.assign(settings,{rawRecallPython:python?.file || '',rawRecallOnnxModel:path.join(directory,catalog.artifacts[0].file),rawRecallOnnxTokenizer:path.join(directory,'tokenizer.json')});
    if(spec.engine==='llamacpp')Object.assign(settings,{rawRecallGgufModel:path.join(directory,catalog.artifacts[0].file),
      rawRecallLlamaServer:path.join(cfg.ownerDirectory,ROOT,'llama',LLAMA_RUNTIME.revision+'-'+acceleration,'bin','llama-server.exe'),rawRecallLlamaGpuLayers:acceleration==='cuda'?-1:0});
    const inspected=await inspectSelectedInstallation(settings);
    const requirements=pythonRequirements(spec),reusePython=python&&requirements.every(item=>{const [name,version]=item.split('==');return python.packages[name]===version;});
    const runtimeArtifacts=spec.engine==='llamacpp'?LLAMA_RUNTIME[acceleration]:[];
    const result={model:spec.id,revision,cloud:false,origin:catalog.origin,source:catalog.homepage,runtimeSource:spec.engine==='llamacpp'?LLAMA_RUNTIME.homepage:null,
      downloadBytes:[...catalog.artifacts,...runtimeArtifacts].reduce((n,item)=>n+item.size,0),pythonPackagesMayDownload:['onnx','fastembed'].includes(spec.engine)&&!reusePython,
      resources,acceleration,suggestedSettings:settings,existingFiles:inspected,
      reuse:{bgeCache:Boolean(bge),python:Boolean(reusePython),process:false},
      message:'下载量是所选模型与运行包的完整大小；已有正确文件会复用，Python 依赖另计。资源建议未做性能实测。'};
    return {...result,_private:{cfg,config,spec,catalog,python,reusePython,directory,runtimeArtifacts}};
  }
  async function inventory(input={}){
    const {cfg,revision}=await readConfiguration();
    if(input.revision&&input.revision!==revision)throw Error('配置已改变，请刷新后准备');
    const models=[],receipts=await libraryInstallReceipts(cfg);
    for(const model of rawModelOptions.filter(option=>!option.cloud)){
      try{
        let readySettings=null,source=null,issues=[],downloadBytes=0;
        const candidates=[];
        if(modelSettings(cfg.pendingRawRecall,model.id))candidates.push(['current',cfg.pendingRawRecall]);
        if(modelSettings(cfg.memory,model.id))candidates.push(['current',cfg.memory]);
        for(const item of cfg.rawModelHistory || [])if(modelSettings(item?.settings,model.id))candidates.push(['history',item.settings]);
        for(const receipt of receipts)if(receipt.model===model.id)
          candidates.push(['installed',{...receipt.settings,rawRecallInstallReceipt:receipt.file}]);
        for(const [candidateSource,settings] of candidates){
          try{
            const inspected=await inspectSelectedInstallation(settings);
            if(inspected.ready){readySettings=settings;source=candidateSource;break;}
          }catch{/* A broken older setting cannot hide a later usable installation. */}
        }
        if(!readySettings){
          const accelerations=model.engine==='llamacpp'?['cuda','cpu']:[null];
          for(const acceleration of accelerations){
            try{
              const planned=await plan({revision,settings:{rawRecallModel:model.id},...(acceleration?{acceleration}:{})});
              downloadBytes=planned.downloadBytes || 0;
              if(planned.existingFiles?.ready){readySettings=planned.suggestedSettings;source='installed';break;}
              issues=planned.existingFiles?.issues || [];
            }catch(error){issues=[String(error.message || '安装检测未完成')];}
          }
        }
        models.push({id:model.id,installed:Boolean(readySettings),source,issues:readySettings?[]:issues,
          downloadBytes,settings:readySettings?inventorySettings(readySettings):null});
      }catch(error){
        models.push({id:model.id,installed:false,source:null,issues:[String(error.message || '安装检测未完成')],
          downloadBytes:0,settings:null});
      }
    }
    return {revision,models};
  }
  async function checked(job){
    job.controller.signal.throwIfAborted();if(closed)throw Error('安装入口已关闭');
    if((await readConfiguration()).revision!==job.revision)throw Error('准备期间配置发生变化，已停止自动保存；已下载文件保留');
  }
  async function preparePython(job,p){
    if(p.reusePython)return p.python.file;
    if(!p.python)throw Error('未找到 Python。请先安装 Python 3.12，或在高级设置填写已有 Python 路径，再继续准备');
    try{await runCommand(p.python.file,['-c','import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else 2)'],{signal:job.controller.signal,timeoutMs:10000});}
    catch{throw Error('自动安装配方使用 Python 3.12；请在高级设置提供 Python 3.12，或使用已装好依赖的运行环境');}
    const requirements=pythonRequirements(p.spec),key=createHash('sha256').update(requirements.join('\n')).digest('hex').slice(0,16);
    const relative=ROOT+'/python/'+key,directory=await installPath(p.cfg.ownerDirectory,relative);
    const marker=path.join(directory,'embedding-runtime-owned.json');
    await fs.mkdir(path.dirname(directory),{recursive:true});
    try{await fs.mkdir(directory);await saveInstallJson(p.cfg.ownerDirectory,relative+'/embedding-runtime-owned.json',{schema:1,requirements});}
    catch(error){if(error.code!=='EEXIST')throw error;const saved=JSON.parse(await fs.readFile(marker,'utf8'));if(JSON.stringify(saved.requirements)!==JSON.stringify(requirements))throw Error('运行目录不属于当前安装配方');}
    await checked(job);job.step='创建独立 Python 运行环境';
    const python=path.join(directory,process.platform==='win32'?'Scripts/python.exe':'bin/python');
    if(!await exists(python))await runCommand(p.python.file,['-m','venv',directory],{signal:job.controller.signal});
    await checked(job);job.step='准备所选型号的运行依赖';
    const versions=await pythonPackages(python);
    if(!requirements.every(item=>{const [name,version]=item.split('==');return versions[name]===version;})){
      await runCommand(python,['-m','pip','install','--disable-pip-version-check','--no-input','--only-binary=:all:','--index-url','https://pypi.org/simple',...requirements],{signal:job.controller.signal});
    }
    return python;
  }
  async function run(job,input){
    let finalState='failed',finalStep=job.step,finalError='';
    try{
      const prepared=await plan(input),p=prepared._private;if(!p)throw Error('云端无需本地安装');
      job.revision=prepared.revision;job.model=prepared.model;job.root=p.cfg.ownerDirectory;
      job.lock=await acquireInstallLock(job,job.root);await checked(job);
      const settings={...prepared.suggestedSettings},signal=job.controller.signal,root=p.cfg.ownerDirectory;
      const files=[];
      if(input.useExisting===true){
        const supplied=selectedConfig(p.cfg,input.settings),inventory=await inspectSelectedInstallation(supplied);
        if(!inventory.ready)throw Error(inventory.issues.join('；'));
        Object.assign(settings,Object.fromEntries(RAW_MODEL_FIELDS.map(name=>[name,supplied[name]])));
        settings.rawRecallInstallReceipt='';
      }else{
        if(process.platform!=='win32'&&p.spec.engine==='llamacpp')throw Error('自动运行包目前支持 Windows x64；其他系统请在高级设置使用官方安装的 llama-server');
        if(p.spec.engine==='llamacpp'&&process.arch!=='x64')throw Error('此自动运行包只支持 x64；请使用适合设备的手动安装');
        if(['onnx','fastembed'].includes(p.spec.engine))settings.rawRecallPython=await preparePython(job,p);
        for(const artifact of p.catalog.artifacts){
          await checked(job);job.step='准备模型文件';
          const target=path.join(p.directory,artifact.file),relative=path.relative(root,target);
          let saved;
          if(await exists(target)){
            const stat=await fs.stat(target);if(stat.size!==artifact.size||await fileDigest(target,signal)!==artifact.sha256)throw Error('已有外部缓存与配方不一致；请用高级设置指定，或改用当前库内的安装目录');
            saved={file:target,reused:true};
          }else saved=await verifiedDownload(root,relative,artifact,{signal,allowDownload:input.allowDownload===true,onProgress:async progress=>{Object.assign(job,progress);if(Date.now()-(job.lastChecked || 0)>2000){await checked(job);job.lastChecked=Date.now();}}});
          files.push({path:saved.file,sha256:artifact.sha256,size:artifact.size});
        }
        if(p.spec.engine==='fastembed'){
          const refRelative='embedding-cache/models--Qdrant--bge-small-zh-v1.5/refs/main';
          if(inside(path.resolve(root),path.resolve(p.directory))&&!await exists(path.join(root,refRelative))){const ref=await installPath(root,refRelative);await fs.mkdir(path.dirname(ref),{recursive:true});await fs.writeFile(ref,p.catalog.revision,{flag:'wx'});}
        }
        if(p.spec.engine==='llamacpp'){
          const runtimeRelative=ROOT+'/llama/'+LLAMA_RUNTIME.revision+'-'+prepared.acceleration;
          const bin=await installPath(root,runtimeRelative+'/bin');await fs.mkdir(bin,{recursive:true});
          for(const artifact of p.runtimeArtifacts){
            await checked(job);job.step='准备本地向量运行程序';
            const zip=await verifiedDownload(root,ROOT+'/downloads/'+artifact.file,artifact,{signal,allowDownload:input.allowDownload===true,onProgress:progress=>{Object.assign(job,progress);}});
            const unpack=await installPath(root,ROOT+'/unpack/'+randomUUID());await fs.mkdir(path.dirname(unpack),{recursive:true});
            await runCommand('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',unpacker,'-Archive',zip.file,'-Destination',unpack,'-Root',await installPath(root,ROOT)],{signal,timeoutMs:180000});
            await flattenRuntime(unpack,bin,signal);
          }
          if(!await exists(settings.rawRecallLlamaServer))throw Error('运行包中未找到 llama-server，未保存新选择');
        }
      }
      await checked(job);job.step='登记安装结果';
      const inventory=await inspectSelectedInstallation(settings);if(!inventory.ready)throw Error(inventory.issues.join('；'));
      for(const file of files){const stat=await fs.stat(file.path);file.mtimeMs=stat.mtimeMs;}
      const receiptRelative=ROOT+'/receipts/'+job.id+'.json';
      const receipt={schema:1,model:p.spec.id,revision:p.catalog.revision,at:new Date().toISOString(),scope:'raw-conversation-embedding',
        source:input.useExisting===true?null:p.catalog.homepage,expectedSource:p.catalog.homepage,
        runtimeRevision:input.useExisting===true?null:p.spec.engine==='llamacpp'?LLAMA_RUNTIME.revision:null,
        mode:input.useExisting===true?'user-supplied-files':'pinned-artifacts',settings,files,packages:inventory.packages || {},tested:false};
      await saveInstallJson(root,receiptRelative,receipt);
      settings.rawRecallInstallReceipt=await installPath(root,receiptRelative);
      await checked(job);
      if(input.downloadOnly===true){
        finalState='downloaded';finalStep='已下载；选中后点「保存」启用';
      }else{
        finalStep=job.step='保存待切换选择';
        const result=await stageModel({settings},job.revision);if(result?.saveWarning)finalError=result.saveWarning;
        finalState='prepared';finalStep='已准备并保存，重新加载记忆框架后生效；尚未试跑';
      }
    }catch(error){finalState=job.controller.signal.aborted?'cancelled':'failed';finalStep=job.step;finalError=String(error.message || '准备未完成');}
    finally{
      if(job.lock){
        try{await job.lock.handle.close();}catch{finalError ||= '安装结果已保留，安装锁未正常关闭；重新打开前请查看该任务记录';}
        try{const owner=JSON.parse(await fs.readFile(job.lock.file,'utf8'));if(owner.id===job.id)await fs.rm(job.lock.file);}catch{/* A changed lock is never removed. */}
      }
      const finishedAt=new Date().toISOString();
      const record={id:job.id,state:finalState,model:job.model,step:finalStep,received:job.received || 0,total:job.total || 0,
        file:job.file || null,error:finalError || null,startedAt:job.startedAt,finishedAt};
      try{if(job.root)await saveInstallJson(job.root,ROOT+'/jobs/'+job.id+'.json',record);}catch{/* Keep the in-memory result; never write into another library. */}
      Object.assign(job,{state:finalState,step:finalStep,error:finalError || null,finishedAt});
    }
  }
  return {
    inventory,
    async plan(input){const result=await plan(input);delete result._private;return result;},
    async start(input){
      if(closed)throw Error('安装入口已关闭');if(starting||current?.state==='running')throw Error('已有安装准备正在进行');
      if(input.downloadOnly===true&&input.allowDownload!==true)throw Error('只下载模式需要明确允许下载');
      if(input.allowDownload!==true&&input.useExisting!==true)throw Error('请明确选择下载准备，或只使用已有文件');
      starting=true;
      try{
        const selected=await plan(input);if(selected.cloud)throw Error('云端型号直接保存 API 设置即可');if(closed)throw Error('安装入口已关闭');
        current={id:randomUUID(),state:'running',model:selected.model,revision:selected.revision,step:'开始准备',startedAt:new Date().toISOString(),controller:new AbortController()};
        const job=current;job.task=run(job,input).catch(error=>{job.state='failed';job.error=String(error.message || '安装准备未完成');job.finishedAt=new Date().toISOString();});return publicJob();
      }finally{starting=false;}
    },
    status:publicJob,
    cancel(id){if(current?.id!==id||current.state!=='running')throw Error('该安装任务已结束或不存在');current.controller.abort(userCancel());return publicJob();},
    async dispose(){closed=true;if(current?.state==='running')current.controller.abort();await current?.task;},
  };
}

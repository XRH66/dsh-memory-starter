import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {initializeMemoryDirectory,validateNewMemoryLocation,validateExistingMemoryDirectory,hasMemoryPending} from './memory-install.js';
import {rawModelSettings,normalizeRawModelSettings,publicRawModel} from './raw-rag/settings.js';
import {embeddingCredentialEndpoint} from './raw-rag/models.js';
import {inspectSelectedInstallation} from './raw-rag/install-files.js';
import {inside,installPath} from './raw-rag/install-download.js';
import {normalizeHandoffTokens} from './memory-contract.js';
import {resolvePersonalTimeZone} from './personal-namespace.js';

export const deploymentFingerprint=cfg=>createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
export async function readDeploymentModelConfiguration(file){const cfg=JSON.parse(await fs.readFile(file,'utf8'));return {cfg,revision:deploymentFingerprint(cfg)};}
function rawModelSnapshot(memory={}){
  const fields=publicRawModel(memory).fields;
  if(memory.rawRecallApiKeyFile)fields.rawRecallApiKeyFile=memory.rawRecallApiKeyFile;
  return fields;
}
async function removeUnusedStagedKey(cfg,file){
  if(!file)return;
  const references=[cfg.memory?.rawRecallApiKeyFile,cfg.pendingRawRecall?.rawRecallApiKeyFile,...(cfg.rawModelHistory || []).map(item=>item.settings?.rawRecallApiKeyFile)];
  if(references.includes(file))return;
  const directory=path.resolve(cfg.ownerDirectory,'management/raw-recall/credentials');
  if(path.dirname(path.resolve(file))!==directory||!inside(directory,path.resolve(file))||! /^[a-f0-9-]{36}\.key$/i.test(path.basename(file)))return;
  try{if(path.relative(directory,await fs.realpath(directory))!==''||path.relative(file,await fs.realpath(file))!=='')return;await fs.rm(file);}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
export function deploymentStaticFingerprint(cfg){const copy={...cfg};delete copy.dshSessionIds;return deploymentFingerprint(copy);}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
async function optionalJson(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function save(file,value){
  const temporary=file+'.'+randomUUID()+'.tmp';
  try{
    await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
    // Windows readers may briefly hold the destination during atomic replace.
    for(let attempt=0;;attempt++)try{await fs.rename(temporary,file);break;}catch(error){
      if(attempt>=5||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;
      await new Promise(resolve=>setTimeout(resolve,30*2**attempt));
    }
  }finally{await fs.rm(temporary,{force:true});}
}
export {save as writeDeploymentJson};
const nativeId=id=>typeof id==='string'&&/^session-[a-zA-Z0-9_-]+$/.test(id);
function validateSessions(cfg){
  if(!path.isAbsolute(cfg?.dshHome??''))throw Error('请先指定该 DSH 实例的数据目录');
  if(!Array.isArray(cfg.dshSessionIds)||cfg.dshSessionIds.some(id=>!nativeId(id))||new Set(cfg.dshSessionIds).size!==cfg.dshSessionIds.length)throw Error('DSH 会话绑定无效');
}
/** Read only the native workspace index and its title projections. */
export async function listDeploymentSessions(cfg){
  validateSessions(cfg);
  const index=JSON.parse(await fs.readFile(path.join(cfg.dshHome,'storages','workspace.json'),'utf8'));
  if(index.unit?.name!=='workspace'||index.unit.version!==2||!index.tables?.workspaces)throw Error('不支持此 DSH 会话索引版本，请核对宿主版本');
  const archived=new Set(index.global?.archivedSessionIds??[]),seen=new Set(),sessions=[];
  for(const [workspaceId,workspace] of Object.entries(index.tables.workspaces))for(const id of workspace.sessionIds??[]){
    if(!nativeId(id)||archived.has(id)||seen.has(id))continue;seen.add(id);
    const cache=await optionalJson(path.join(cfg.dshHome,'storages','session_projcache','sessions',id+'.json'));
    if(cache&&cache.version!==7)throw Error('不支持此 DSH 标题缓存版本，请核对宿主版本');
    sessions.push({id,title:cache?.record?.rows?.title?.val??'未命名聊天',workspace:workspace.title??workspaceId,bound:cfg.dshSessionIds.includes(id)});
  }
  return sessions;
}
export async function applyDeploymentSessionChange(cfg,{action,value}){
  validateSessions(cfg);
  if(action==='bind'){
    if(!(await listDeploymentSessions(cfg)).some(s=>s.id===value))throw Error('请选择此 DSH 实例中未归档的普通会话');
    cfg.dshSessionIds=[...new Set([...cfg.dshSessionIds,value])];
  }else if(action==='unbind'){
    if(!cfg.dshSessionIds.includes(value))throw Error('该会话尚未绑定');
    cfg.dshSessionIds=cfg.dshSessionIds.filter(id=>id!==value);
  }else if(action==='replace'){
    if(!Array.isArray(value)||value.some(id=>!nativeId(id))||new Set(value).size!==value.length)throw Error('会话选择无效');
    const available=new Set((await listDeploymentSessions(cfg)).map(s=>s.id));
    if(value.some(id=>!available.has(id)&&!cfg.dshSessionIds.includes(id)))throw Error('请选择此 DSH 实例中未归档的普通会话');
    cfg.dshSessionIds=[...value];
  }else throw Error('未知会话绑定操作');
  return cfg;
}
export async function readDeploymentSettings(file){
  if(!path.isAbsolute(file??''))throw Error('Explicit absolute deployment configuration required');
  const cfg=JSON.parse(await fs.readFile(file,'utf8'));validateSessions(cfg);
  const timeZone=resolvePersonalTimeZone(cfg.memory?.timeZone);
  const receipt=await optionalJson(file+'.runtime.json'),running=Number.isInteger(receipt?.pid)&&receipt.pid>0&&alive(receipt.pid);
  const sessions=await listDeploymentSessions(cfg),listed=new Set(sessions.map(s=>s.id));
  for(const id of cfg.dshSessionIds)if(!listed.has(id))sessions.push({id,title:'已绑定但当前不可用',workspace:'',bound:true,unavailable:true});
  const flags=Object.fromEntries(['autoRecall','autoCapture','recentContext','rawRecall'].map(key=>[key,typeof cfg.memory?.[key]==='boolean'?cfg.memory[key]:(key==='rawRecall'?false:true)]));
  const pendingFlags=validMemoryFlags(cfg.pendingMemoryFlags)?cfg.pendingMemoryFlags:null;
  return {directory:cfg.ownerDirectory,pendingDirectory:cfg.pendingMemoryDirectory??null,switchError:running?receipt.switchError??null:null,settingsError:running?receipt.settingsError??null:null,flags,pendingFlags,
    timeZone:timeZone.timeZone,timeZoneConfigured:timeZone.configuredTimeZone,timeZoneHost:timeZone.hostTimeZone,timeZoneError:timeZone.error,...rawModelSettings(cfg),
    pendingRawModelSwitch:cfg.pendingRawRecall&&cfg.pendingRawRecallSwitch?{cloudConfirmed:cfg.pendingRawRecallSwitch.cloudConfirmed===true}:null,
    rawModelHistory:(cfg.rawModelHistory || []).map(item=>({id:item.id,model:item.settings.rawRecallModel,cloud:item.settings.rawRecallAllowCloud,at:item.at})),
    embeddingScope:{raw:'由已加载档位报告',facts:'由已加载档位报告',shared:'查看记忆运行状态，区分所选档位、实际生效与待准备'},
    revision:deploymentFingerprint(cfg),runtime:!running?'stopped-or-unreported':receipt.fingerprintVersion!==2||receipt.fingerprint!==deploymentFingerprint(cfg)?'reload-required':receipt.state==='ready'?'loaded':'starting',sessions};
}

export async function stageDeploymentRawModel(file,input,expectedRevision,afterSave){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的配置版本');
  let lock,saveWarning=null;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用；请稍后重试');throw error;}
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    if(cfg.pendingMemoryDirectory)throw Error('请先完成或取消记忆库切换');
    const next={...cfg},previousKey=cfg.pendingRawRecall?.rawRecallApiKeyFile;let createdKey=null;
    if(input?.cancel===true){delete next.pendingRawRecall;delete next.pendingRawRecallAt;delete next.pendingRawRecallSwitch;}
    else{
      const restore=input?.restoreId?(cfg.rawModelHistory || []).find(item=>item.id===input.restoreId):null;
      if(input?.restoreId&&!restore)throw Error('上次向量设置已不存在，请重新选择');
      if(restore?.settings?.rawRecallAllowCloud&&input.allowCloud!==true)throw Error('恢复该设置会使用云端 API，请先明确选择');
      if(restore?.settings?.rawRecallApiKeyService)embeddingCredentialEndpoint(restore.settings);
      if(input.apiKey!==undefined&&typeof input.apiKey!=='string')throw Error('API Key 格式无效');
      const key=(input.apiKey||'').trim();
      const fields=normalizeRawModelSettings(restore?.settings || input?.settings,restore?.settings || cfg.pendingRawRecall || cfg.memory,
        {apiKeyProvided:Boolean(key),reuseApiKey:input.reuseApiKey===true});
      // History is a saved pair, including credentials dormant in local mode.
      // Bind older snapshots to their own address before publishing the restore.
      if(restore)fields.rawRecallApiKeyService=embeddingCredentialEndpoint(fields);
      if(key){
        if(!fields.rawRecallAllowCloud)throw Error('只有选择云端检索时才保存 API Key');
        if(key.length>8192||/[\r\n\u0000]/.test(key))throw Error('API Key 格式无效');
        if(!path.isAbsolute(cfg.ownerDirectory??''))throw Error('个人记忆库目录无效');
        const directory=await installPath(cfg.ownerDirectory,'management/raw-recall/credentials');
        await fs.mkdir(directory,{recursive:true});
        // A pending key never overwrites the credential used by the active model.
        fields.rawRecallApiKeyFile=path.join(directory,randomUUID()+'.key');
        await fs.writeFile(fields.rawRecallApiKeyFile,key,{flag:'wx',mode:0o600});
        createdKey=fields.rawRecallApiKeyFile;
      }
      let prepared;try{prepared=await inspectSelectedInstallation(fields);}catch(error){if(createdKey)await removeUnusedStagedKey(cfg,createdKey);throw error;}
      if(!prepared.ready){if(createdKey)await removeUnusedStagedKey(cfg,createdKey);throw Error('模型尚未准备完整：'+prepared.issues.join('；'));}
      next.pendingRawRecall=fields;
      next.pendingRawRecallAt=new Date().toISOString();
      // Optional one-shot confirmation: after reload the selected profile is
      // prepared automatically. Absent -> behaviour unchanged.
      if(input.confirmSwitch===true){
        if(fields.rawRecallAllowCloud&&input.cloudConfirmed!==true)throw Error('切换到云端模型需要明确确认本次发送范围');
        next.pendingRawRecallSwitch={confirmedAt:next.pendingRawRecallAt,cloudConfirmed:input.cloudConfirmed===true};
      }else delete next.pendingRawRecallSwitch;
    }
    try{await save(file,next);}catch(error){if(createdKey)await removeUnusedStagedKey(cfg,createdKey);throw error;}
    try{await removeUnusedStagedKey(next,previousKey);}catch{saveWarning='选择已保存；未引用的旧密钥文件暂未清理，已保留';}
    if(afterSave)try{await afterSave(next,deploymentFingerprint(next));}catch{saveWarning='模型设置已保存，运行状态回执未更新；下次重新加载后生效';}
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
  return {...await readDeploymentSettings(file),...(saveWarning?{saveWarning}:{})};
}
const memoryFlagKeys=['autoRecall','autoCapture','recentContext','rawRecall'];
const memoryFlagDefault=key=>key==='rawRecall'?false:true;
function validMemoryFlags(value){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===memoryFlagKeys.length&&memoryFlagKeys.every(key=>typeof value[key]==='boolean');}
export async function stageDeploymentFlags(file,flags,expectedRevision,afterSave){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision||!validMemoryFlags(flags))throw Error('请选择有效的记忆功能设置');
  let lock;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用；请稍后重试');throw error;}
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));if(deploymentFingerprint(cfg)!==expectedRevision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    if(cfg.memory!==undefined&&(!cfg.memory||typeof cfg.memory!=='object'||Array.isArray(cfg.memory)))throw Error('当前记忆功能配置无效');
    const active=Object.fromEntries(memoryFlagKeys.map(key=>[key,typeof cfg.memory?.[key]==='boolean'?cfg.memory[key]:memoryFlagDefault(key)])),next={...cfg};
    if(memoryFlagKeys.every(key=>active[key]===flags[key]))delete next.pendingMemoryFlags;else next.pendingMemoryFlags=Object.fromEntries(memoryFlagKeys.map(key=>[key,flags[key]]));
    await save(file,next);if(afterSave)try{await afterSave(next,deploymentFingerprint(next));}catch{throw Error('功能设置已保存但状态未更新，请重新加载记忆框架');}
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
  return readDeploymentSettings(file);
}
export async function stageDeploymentHandoff(file,tokens,expectedRevision,afterSave){
  tokens=normalizeHandoffTokens(tokens);
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的配置版本');
  const lock=await fs.open(file+'.lock','wx');
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision)throw Object.assign(Error('配置已被其他操作修改，请刷新后重试'),{code:'REVISION_CONFLICT'});
    const next={...cfg,memory:{...cfg.memory,handoffTokens:tokens}},revision=deploymentFingerprint(next);
    await save(file,next);
    if(afterSave)try{await afterSave(next,revision);}catch{throw Error('长度已保存但运行状态未更新，请重新加载记忆框架');}
    return {tokens,revision,applied:Boolean(afterSave)};
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
}
export async function stageDeploymentTimeZone(file,timeZone,expectedRevision){
  if(!path.isAbsolute(file??'')||typeof timeZone!=='string'||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的时区设置');
  const lock=await fs.open(file+'.lock','wx');
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision)throw Object.assign(Error('配置已被其他操作修改，请刷新后重试'),{code:'REVISION_CONFLICT'});
    if(cfg.memory!==undefined&&(!cfg.memory||typeof cfg.memory!=='object'||Array.isArray(cfg.memory)))throw Error('当前记忆功能配置无效');
    const next={...cfg,memory:{...cfg.memory,timeZone:timeZone.trim()}};
    await save(file,next);
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
  return readDeploymentSettings(file);
}
export async function updateDeploymentSession(file,change,expectedRevision,afterSave,beforeSave){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的配置版本');
  let lock;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用；请稍后重试');throw error;}
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    await beforeSave?.(cfg);
    await applyDeploymentSessionChange(cfg,change);await save(file,cfg);
    if(afterSave)try{await afterSave(cfg,deploymentFingerprint(cfg),{
      action:change.action,value:Array.isArray(change.value)?[...change.value]:change.value,
    });}catch{/* Saved settings remain explicitly pending if live application fails. */}
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
  return readDeploymentSettings(file);
}

/** Initialize a new independent library without changing the running selection. */
export async function createDeploymentLibrary(file,directory,expectedRevision){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的配置版本');
  let lock;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用；请稍后重试');throw error;}
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    if(!path.isAbsolute(cfg.ownerDirectory??''))throw Error('当前个人记忆库路径无效');
    const target=await validateNewMemoryLocation(directory,[cfg.ownerDirectory,cfg.socialRoot]);
    const result=await initializeMemoryDirectory({directory:target});
    return {...result,selected:false};
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
}

/** Stage a library change; the running host continues using its existing library. */
export async function stageDeploymentLibrary(file,directory,expectedRevision,afterSave){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision||!path.isAbsolute(directory??''))throw Error('请选择有效的记忆库目录和配置版本');
  let lock;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用；请稍后重试');throw error;}
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));if(deploymentFingerprint(cfg)!==expectedRevision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    if(!path.isAbsolute(cfg.ownerDirectory??''))throw Error('当前个人记忆库路径无效');
    const target=path.resolve(directory),current=path.resolve(cfg.ownerDirectory),next={...cfg};
    if(target===current)delete next.pendingMemoryDirectory;
    else{const preview=await applyPendingLibrary({...cfg,pendingMemoryDirectory:target});if(preview.switchError)throw Error('暂不能选择该库：'+preview.switchError);next.pendingMemoryDirectory=target;}
    await save(file,next);
    if(afterSave)try{await afterSave(next,deploymentFingerprint(next));}catch{throw Error('目录选择已保存但状态未更新，请重新加载记忆框架');}
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
  return readDeploymentSettings(file);
}

async function applyPendingLibrary(cfg){
  if(!cfg.pendingMemoryDirectory)return {cfg};
  const current=cfg.ownerDirectory,target=cfg.pendingMemoryDirectory;
  try{
    await validateNewMemoryLocation(target,[current,cfg.socialRoot]);await validateExistingMemoryDirectory(target);
    if(await hasMemoryPending(current)||await hasMemoryPending(target))throw Error('当前库或目标库仍有待整理或待同步内容');
    const next={...cfg,ownerDirectory:target};
    if(cfg.selfProfile){
      const oldVault=await fs.realpath(path.join(current,'vault')),oldProfile=await fs.realpath(cfg.selfProfile),relative=path.relative(oldVault,oldProfile);
      if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('当前人格档案不在原记忆库内');
      const targetVault=await fs.realpath(path.join(target,'vault'));let candidate;try{candidate=await fs.realpath(path.join(targetVault,relative));}catch(error){if(error.code==='ENOENT')throw Error('目标库缺少与当前人格对应的档案');throw error;}const check=path.relative(targetVault,candidate);
      if(!check||check==='..'||check.startsWith('..'+path.sep)||path.isAbsolute(check))throw Error('目标人格档案不在目标库内');
      if((await fs.stat(candidate)).size>16*1024)throw Error('目标人格档案过大');const profile=await fs.readFile(candidate,'utf8');if(!profile.includes('<!-- dafeiyu-record kind=thoughts -->'))throw Error('目标库缺少对应的人格档案');next.selfProfile=candidate;
    }
    delete next.pendingMemoryDirectory;return {cfg:next,changed:true};
  }catch(error){return {cfg,switchError:String(error.message??'记忆库切换失败')};}
}
async function applyPendingDeployment(input){
  const library=await applyPendingLibrary(input);let cfg=library.cfg,changed=Boolean(library.changed),settingsError=null;
  // Keep related staged changes together if the library cannot yet switch;
  // disabling capture first could otherwise strand the jobs that block it.
  if(library.switchError)return {cfg,changed:false,switchError:library.switchError,settingsError:null};
  if(cfg.pendingMemoryFlags!==undefined){
    if(validMemoryFlags(cfg.pendingMemoryFlags)&&(cfg.memory===undefined||(cfg.memory&&typeof cfg.memory==='object'&&!Array.isArray(cfg.memory)))){cfg={...cfg,memory:{...cfg.memory,...cfg.pendingMemoryFlags}};delete cfg.pendingMemoryFlags;changed=true;}
    else settingsError='待生效的记忆功能设置无效，仍使用原设置';
  }
  if(cfg.pendingRawRecall!==undefined){
    try{
      const pending=cfg.pendingRawRecall;
      if(pending.rawRecallApiKeyService)embeddingCredentialEndpoint(pending);
      // Validated pending snapshots retain the whole service/credential pair;
      // using the active model as the base would splice two histories together.
      const bound=Boolean(pending.rawRecallApiKeyService);
      const model=normalizeRawModelSettings(pending,bound?pending:cfg.memory,{
        apiKeyProvided:!bound&&Boolean(pending.rawRecallApiKeyFile&&pending.rawRecallApiKeyFile!==cfg.memory?.rawRecallApiKeyFile),
      });
      if(cfg.pendingRawRecall.rawRecallApiKeyFile)model.rawRecallApiKeyFile=cfg.pendingRawRecall.rawRecallApiKeyFile;
      const prepared=await inspectSelectedInstallation(model);if(!prepared.ready)throw Error(prepared.issues.join('；'));
      let history=cfg.rawModelHistory || [];
      const previous=rawModelSnapshot(cfg.memory);
      if(JSON.stringify(previous)!==JSON.stringify(model)){
        const id=deploymentFingerprint({settings:previous,at:cfg.pendingRawRecallAt || null});
        history=[{id,at:cfg.pendingRawRecallAt || null,settings:previous},...history.filter(item=>item.id!==id)].slice(0,5);
      }
      const memory={...cfg.memory,...model};delete memory.rawRecallSwitch;
      if(cfg.pendingRawRecallSwitch?.confirmedAt)memory.rawRecallSwitch={confirmedAt:cfg.pendingRawRecallSwitch.confirmedAt,cloudConfirmed:cfg.pendingRawRecallSwitch.cloudConfirmed===true};
      cfg={...cfg,memory,rawModelHistory:history};delete cfg.pendingRawRecall;delete cfg.pendingRawRecallAt;delete cfg.pendingRawRecallSwitch;changed=true;
    }catch(error){settingsError='原句检索模型暂未切换：'+String(error.message??'配置无效');}
  }
  return {cfg,changed,switchError:library.switchError,settingsError};
}

/** Acquire the same deployment lock as the existing configuration editor. */
export async function beginDeploymentConfiguration(file){
  if(!path.isAbsolute(file??''))throw Error('Explicit absolute deployment configuration required');
  let lock;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('Deployment configuration is in use');throw error;}
  try{
    const original=JSON.parse(await fs.readFile(file,'utf8'));let cfg=original;const prior=await optionalJson(file+'.runtime.json');
    if(Number.isInteger(prior?.pid)&&prior.pid>0&&alive(prior.pid))throw Error('Deployment configuration already has a running instance');
    const switched=await applyPendingDeployment(cfg);cfg=switched.cfg;
    const receipt={pid:process.pid,fingerprintVersion:2,fingerprint:deploymentFingerprint(original),state:'starting',loadedAt:null,switchError:switched.switchError??null,settingsError:switched.settingsError??null};
    await save(file+'.runtime.json',receipt);
    let closing=false,writes=Promise.resolve();
    const write=update=>{if(closing)return Promise.reject(Error('Deployment is closing'));const task=writes.then(async()=>{const next={...receipt,...update};await save(file+'.runtime.json',next);Object.assign(receipt,next);});writes=task.catch(()=>{});return task;};
    const ready=async()=>{
      if(switched.changed){
        let commitLock;try{commitLock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用，无法提交记忆库切换');throw error;}
        try{
          const current=JSON.parse(await fs.readFile(file,'utf8'));if(deploymentFingerprint(current)!==deploymentFingerprint(original))throw Error('记忆库选择在加载期间发生变化，请重试');
          const checked=await applyPendingDeployment(current);if(!checked.changed||deploymentFingerprint(checked.cfg)!==deploymentFingerprint(cfg))throw Error('待生效设置在加载期间不再安全：'+(checked.switchError??checked.settingsError??'配置改变'));
          await save(file,cfg);
        }finally{await commitLock.close();await fs.rm(file+'.lock',{force:true});}
      }
      return write({state:'ready',fingerprint:deploymentFingerprint(cfg),loadedAt:new Date().toISOString()});
    };
    return {get cfg(){return cfg;},ready,markApplied:fingerprint=>write({state:'ready',fingerprint,loadedAt:new Date().toISOString()}),async close(){closing=true;await writes;const current=await optionalJson(file+'.runtime.json');if(current?.pid===process.pid&&current.fingerprint===receipt.fingerprint)await fs.rm(file+'.runtime.json',{force:true});}};
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
}

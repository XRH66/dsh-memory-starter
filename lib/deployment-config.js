import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {initializeMemoryDirectory,validateNewMemoryLocation,validateExistingMemoryDirectory,hasMemoryPending} from './memory-install.js';
import {rawModelSettings,normalizeRawModelSettings,publicRawModel} from './raw-rag/settings.js';
import {embeddingCredentialEndpoint,embeddingEndpoint} from './raw-rag/models.js';
import {rerankServiceUrl} from './raw-rag/rerank-http.js';
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
  const references=[cfg.memory?.rawRecallApiKeyFile,
    ...(cfg.memory?.memoryRerank===true?[cfg.memory.memoryRerankApiKeyFile]:[]),cfg.pendingRawRecall?.rawRecallApiKeyFile,
    ...(cfg.embeddingServices || []).map(item=>item?.apiKeyFile),
    ...(cfg.rawModelHistory || []).map(item=>item.settings?.rawRecallApiKeyFile)];
  if(references.includes(file))return;
  const directory=path.resolve(cfg.ownerDirectory,'management/raw-recall/credentials');
  if(path.dirname(path.resolve(file))!==directory||!inside(directory,path.resolve(file))||! /^[a-f0-9-]{36}\.key$/i.test(path.basename(file)))return;
  try{if(path.relative(directory,await fs.realpath(directory))!==''||path.relative(file,await fs.realpath(file))!=='')return;await fs.rm(file);}
  catch(error){if(error.code!=='ENOENT')throw error;}
}
const embeddingServices=cfg=>Array.isArray(cfg.embeddingServices)?cfg.embeddingServices:[];
function normalizedEmbeddingBase(value){
  const endpoint=new URL(embeddingEndpoint(value));
  endpoint.pathname=endpoint.pathname.replace(/\/embeddings\/?$/,'')||'/';
  return endpoint.toString().replace(/\/$/,'');
}
function normalizedRerankBase(value){
  const endpoint=new URL(rerankServiceUrl(value));
  endpoint.pathname=endpoint.pathname.replace(/\/rerank\/?$/,'')||'/';
  return endpoint.toString().replace(/\/$/,'');
}
function loopbackUrl(value){
  try{return ['localhost','127.0.0.1','::1'].includes(new URL(value).hostname.replace(/^\[|\]$/g,''));}
  catch{return false;}
}
function embeddingServiceIdentity(value){
  return [embeddingEndpoint(value.apiBase??value.rawRecallApiBase),String(value.apiModel??value.rawRecallApiModel??'').trim(),
    Number(value.dimensions??value.rawRecallDimensions)].join('\0');
}
function sameEmbeddingService(model,service){
  if(model?.rawRecallModel!=='custom-api')return false;
  try{
    return embeddingServiceIdentity({apiBase:model.rawRecallApiBase,apiModel:model.rawRecallApiModel,dimensions:model.rawRecallDimensions})===
      embeddingServiceIdentity(service);
  }catch{return false;}
}
const rerankServiceInUse=(cfg,service)=>cfg.memory?.memoryRerank===true&&
  cfg.memory?.memoryRerankSource!=='direct'&&cfg.memory?.memoryRerankServiceId===service.id;
const embeddingServiceInUse=(cfg,service)=>sameEmbeddingService(cfg.memory,service)||sameEmbeddingService(cfg.pendingRawRecall,service)||
  rerankServiceInUse(cfg,service);
function publicEmbeddingService(service,cfg){
  return {id:service.id,name:service.name,apiBase:service.apiBase,apiModel:service.apiModel,dimensions:service.dimensions,
    hasKey:Boolean(service.apiKeyFile),inUse:embeddingServiceInUse(cfg,service)};
}
function publicDeploymentRerank(cfg){
  const memory=cfg.memory&&typeof cfg.memory==='object'&&!Array.isArray(cfg.memory)?cfg.memory:{};
  const source=memory.memoryRerankSource==='direct'?'direct':'service';
  const model=typeof memory.memoryRerankModel==='string'&&memory.memoryRerankModel.trim()&&
    memory.memoryRerankModel.trim().length<=120?memory.memoryRerankModel.trim():'BAAI/bge-reranker-v2-m3';
  const candidates=Number.isInteger(memory.memoryRerankCandidates)&&memory.memoryRerankCandidates>=5&&memory.memoryRerankCandidates<=50
    ?memory.memoryRerankCandidates:30;
  const apiBase=typeof memory.memoryRerankApiBase==='string'?memory.memoryRerankApiBase.trim():'';
  return {enabled:memory.memoryRerank===true,source,
    serviceId:source==='service'&&typeof memory.memoryRerankServiceId==='string'?memory.memoryRerankServiceId:'',
    apiBase,model,candidates,hasKey:Boolean(memory.memoryRerankApiKeyFile)};
}
function findEmbeddingService(cfg,identity){
  return embeddingServices(cfg).find(service=>{
    try{return embeddingServiceIdentity(service)===identity;}catch{return false;}
  });
}
function upsertEmbeddingService(cfg,fields,now=new Date().toISOString()){
  const identity=embeddingServiceIdentity(fields),services=embeddingServices(cfg),existing=findEmbeddingService(cfg,identity);
  if(existing)return services.map(service=>service===existing?{...service,apiKeyFile:fields.rawRecallApiKeyFile||'',apiKeyService:fields.rawRecallApiKeyService||embeddingEndpoint(service.apiBase),updatedAt:now}:service);
  if(services.length>=20)throw Error('最多保存 20 个向量服务');
  const host=new URL(embeddingEndpoint(fields.rawRecallApiBase)).hostname;
  return [...services,{id:randomUUID(),name:host+' · '+fields.rawRecallApiModel,apiBase:normalizedEmbeddingBase(fields.rawRecallApiBase),
    apiModel:fields.rawRecallApiModel,dimensions:fields.rawRecallDimensions,apiKeyFile:fields.rawRecallApiKeyFile||'',
    apiKeyService:fields.rawRecallApiKeyService||embeddingEndpoint(fields.rawRecallApiBase),createdAt:now,updatedAt:now}];
}
async function writeCredentialKey(cfg,key,prefix=''){
  if(key.length>8192||/[\r\n\u0000]/.test(key))throw Error('API Key 格式无效');
  if(!path.isAbsolute(cfg.ownerDirectory??''))throw Error('个人记忆库目录无效');
  const directory=await installPath(cfg.ownerDirectory,'management/raw-recall/credentials');
  await fs.mkdir(directory,{recursive:true});
  const file=path.join(directory,prefix+randomUUID()+'.key');
  await fs.writeFile(file,key,{flag:'wx',mode:0o600});
  return file;
}
async function writeEmbeddingKey(cfg,key){return writeCredentialKey(cfg,key);}
async function writeRerankKey(cfg,key){return writeCredentialKey(cfg,key,'rerank-');}
async function removeUnusedRerankKey(cfg,file){
  if(!file)return;
  const references=[cfg.memory?.memoryRerankApiKeyFile,cfg.memory?.rawRecallApiKeyFile,cfg.pendingRawRecall?.rawRecallApiKeyFile,
    ...(cfg.embeddingServices||[]).map(item=>item?.apiKeyFile),...(cfg.rawModelHistory||[]).map(item=>item?.settings?.rawRecallApiKeyFile)];
  if(references.includes(file))return;
  const directory=path.resolve(cfg.ownerDirectory,'management/raw-recall/credentials');
  if(path.dirname(path.resolve(file))!==directory||!inside(directory,path.resolve(file))||
    !/^rerank-[a-f0-9-]{36}\.key$/i.test(path.basename(file)))return;
  try{
    if(path.relative(directory,await fs.realpath(directory))!==''||path.relative(file,await fs.realpath(file))!=='')return;
    await fs.rm(file);
  }catch(error){if(error.code!=='ENOENT')throw error;}
}
export function deploymentStaticFingerprint(cfg){const copy={...cfg};delete copy.dshSessionIds;delete copy.embeddingServices;return deploymentFingerprint(copy);}
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
  if(Object.hasOwn(cfg,'autoEnableNewSessions')&&typeof cfg.autoEnableNewSessions!=='boolean')throw Error('新对话记忆设置无效');
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
    if(!nativeId(value))throw Error('会话选择无效');
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
  return {directory:cfg.ownerDirectory,pendingDirectory:cfg.pendingMemoryDirectory??null,switchError:running?receipt.switchError??null:null,settingsError:running?receipt.settingsError??null:null,autoEnableNewSessions:cfg.autoEnableNewSessions===true,flags,pendingFlags,
    timeZone:timeZone.timeZone,timeZoneConfigured:timeZone.configuredTimeZone,timeZoneHost:timeZone.hostTimeZone,timeZoneError:timeZone.error,...rawModelSettings(cfg),
    pendingRawModelSwitch:cfg.pendingRawRecall&&cfg.pendingRawRecallSwitch?{cloudConfirmed:cfg.pendingRawRecallSwitch.cloudConfirmed===true}:null,
    rawModelHistory:(cfg.rawModelHistory || []).map(item=>({id:item.id,model:item.settings.rawRecallModel,cloud:item.settings.rawRecallAllowCloud,at:item.at})),
    embeddingServices:embeddingServices(cfg).slice(0,20).map(service=>publicEmbeddingService(service,cfg)),
    rerank:publicDeploymentRerank(cfg),
    embeddingScope:{raw:'由已加载档位报告',facts:'由已加载档位报告',shared:'查看记忆运行状态，区分所选档位、实际生效与待准备'},
    revision:deploymentFingerprint(cfg),runtime:!running?'stopped-or-unreported':receipt.fingerprintVersion!==2||receipt.fingerprint!==deploymentFingerprint(cfg)?'reload-required':receipt.state==='ready'?'loaded':'starting',sessions};
}

// The list never changes the running model, so a save marks the new revision applied (no reload).
export async function manageEmbeddingServices(file,input,expectedRevision,afterSave){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的配置版本');
  if(!input||typeof input!=='object'||Array.isArray(input)||!['save','delete'].includes(input.action))throw Error('未知向量服务操作');
  let lock;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用；请稍后重试');throw error;}
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    if(cfg.pendingMemoryDirectory)throw Error('请先完成或取消记忆库切换');
    const services=embeddingServices(cfg);
    let next={...cfg},previousKey='',createdKey='',saveWarning='';
    if(input.action==='delete'){
      if(typeof input.id!=='string'||!input.id)throw Error('请选择要删除的向量服务');
      const existing=services.find(service=>service.id===input.id);
      if(!existing)throw Error('所选服务已不存在，请刷新');
      if(rerankServiceInUse(cfg,existing))throw Error('这个服务正被重排使用；要删除请先关闭重排');
      if(embeddingServiceInUse(cfg,existing))throw Error('这个服务正在使用，不能删除');
      next={...cfg,embeddingServices:services.filter(service=>service.id!==existing.id)};
      previousKey=existing.apiKeyFile;
    }else{
      const existing=input.id?services.find(service=>service.id===input.id):null;
      if(input.id&&!existing)throw Error('所选服务已不存在，请刷新');
      if(!existing&&services.length>=20)throw Error('最多保存 20 个向量服务');
      const rawBase=input.apiBase??existing?.apiBase;
      if(typeof rawBase!=='string'||!rawBase.trim())throw Error('请填写 API 地址');
      const apiBase=normalizedEmbeddingBase(rawBase);
      const apiModel=input.apiModel??existing?.apiModel;
      if(typeof apiModel!=='string'||!apiModel.trim()||apiModel.trim().length>200||/[\u0000-\u001f]/u.test(apiModel.trim()))
        throw Error('模型名称应为 1 到 200 个字符，且不能包含控制字符');
      const dimensions=Number(input.dimensions??existing?.dimensions);
      if(!Number.isSafeInteger(dimensions)||dimensions<1||dimensions>4096)throw Error('向量维数应为 1 到 4096 的整数');
      let newKey='';
      if(Object.hasOwn(input,'apiKey')){
        if(typeof input.apiKey!=='string')throw Error('API Key 格式无效');
        newKey=input.apiKey.trim();
        if(newKey.length>8192||/[\r\n\u0000]/.test(newKey))throw Error('API Key 格式无效');
      }
      const endpoint=embeddingEndpoint(apiBase),addressChanged=Boolean(existing&&embeddingEndpoint(existing.apiBase)!==endpoint);
      const modelChanged=Boolean(existing&&apiModel.trim()!==existing.apiModel),dimensionsChanged=Boolean(existing&&dimensions!==existing.dimensions);
      if(existing&&embeddingServiceInUse(cfg,existing)&&(addressChanged||modelChanged||dimensionsChanged||newKey)){
        if(rerankServiceInUse(cfg,existing)&&(addressChanged||newKey))
          throw Error('这个服务正被重排使用；要更换地址或密钥，请先关闭重排');
        throw Error('这个服务正在使用；要更换地址、模型或密钥，请先切到其他模型');
      }
      if(addressChanged&&!newKey)throw Error('服务地址已改变，请填写这个地址对应的 API Key');
      const host=new URL(endpoint).hostname;
      const rawName=input.name===undefined?existing?.name??'':input.name;
      if(typeof rawName!=='string')throw Error('服务名称格式无效');
      const name=rawName.trim()||host+' · '+apiModel.trim();
      if(name.length>60)throw Error('服务名称不能超过 60 个字符');
      if(newKey)createdKey=await writeEmbeddingKey(cfg,newKey);
      const now=new Date().toISOString(),service={id:existing?.id??randomUUID(),name,apiBase,apiModel:apiModel.trim(),
        dimensions,apiKeyFile:createdKey||existing?.apiKeyFile||'',apiKeyService:endpoint,
        createdAt:existing?.createdAt??now,updatedAt:now};
      next={...cfg,embeddingServices:existing?services.map(row=>row.id===existing.id?service:row):[...services,service]};
      previousKey=existing?.apiKeyFile??'';
    }
    try{await save(file,next);}catch(error){if(createdKey)await removeUnusedStagedKey(cfg,createdKey);throw error;}
    try{await removeUnusedStagedKey(next,previousKey);}catch{saveWarning='服务已保存；未引用的旧密钥文件暂未清理，已保留';}
    if(afterSave)try{await afterSave(next,deploymentFingerprint(next));}catch{saveWarning='服务已保存，运行状态回执未更新；不影响当前模型';}
    return {...await readDeploymentSettings(file),...(saveWarning?{saveWarning}:{})};
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
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
      if(input?.serviceId!==undefined&&(typeof input.serviceId!=='string'||!input.serviceId.trim()))throw Error('请选择有效的向量服务');
      if(input?.serviceId&&restore)throw Error('不能同时选择已保存服务和恢复旧设置');
      const service=input?.serviceId?embeddingServices(cfg).find(item=>item.id===input.serviceId):null;
      if(input?.serviceId&&!service)throw Error('所选服务已不存在，请刷新');
      if(restore?.settings?.rawRecallAllowCloud&&input.allowCloud!==true)throw Error('恢复该设置会使用云端 API，请先明确选择');
      if(restore?.settings?.rawRecallApiKeyService)embeddingCredentialEndpoint(restore.settings);
      if(input.apiKey!==undefined&&typeof input.apiKey!=='string')throw Error('API Key 格式无效');
      const key=service?'':(input.apiKey||'').trim();
      try{
        const serviceFields=service?{rawRecallModel:'custom-api',rawRecallAllowCloud:true,rawRecallApiKeyEnv:'',rawRecallApiBase:service.apiBase,
          rawRecallApiModel:service.apiModel,rawRecallDimensions:service.dimensions}:null;
        const fields=normalizeRawModelSettings(service?{...(input.settings||{}),...serviceFields}:restore?.settings||input?.settings,
          service?{...(cfg.pendingRawRecall||cfg.memory),...serviceFields,rawRecallApiKeyFile:service.apiKeyFile||'',
            rawRecallApiKeyService:service.apiKeyService||embeddingEndpoint(service.apiBase)}:restore?.settings||cfg.pendingRawRecall||cfg.memory,
          {apiKeyProvided:Boolean(key),reuseApiKey:input.reuseApiKey===true});
        // History is a saved pair, including credentials dormant in local mode.
        // Bind older snapshots to their own address before publishing the restore.
        if(restore)fields.rawRecallApiKeyService=embeddingCredentialEndpoint(fields);
        if(key){
          if(!fields.rawRecallAllowCloud)throw Error('只有选择云端检索时才保存 API Key');
          // A pending key never overwrites the credential used by the active model.
          fields.rawRecallApiKeyFile=await writeEmbeddingKey(cfg,key);
          createdKey=fields.rawRecallApiKeyFile;
        }
        if(!service&&fields.rawRecallModel==='custom-api'&&!findEmbeddingService(cfg,embeddingServiceIdentity(fields))&&
          embeddingServices(cfg).length>=20)throw Error('最多保存 20 个向量服务');
        const prepared=await inspectSelectedInstallation(fields);
        if(!prepared.ready)throw Error((fields.rawRecallAllowCloud?'模型尚未准备完整：':'该模型尚未下载完整，请先下载：')+prepared.issues.join('；'));
        next.pendingRawRecall=fields;
        next.pendingRawRecallAt=new Date().toISOString();
        if(!service&&fields.rawRecallModel==='custom-api')next.embeddingServices=upsertEmbeddingService(cfg,fields,next.pendingRawRecallAt);
        // Optional one-shot confirmation: after reload the selected profile is
        // prepared automatically. Absent -> behaviour unchanged.
        if(input.confirmSwitch===true){
          if(fields.rawRecallAllowCloud&&input.cloudConfirmed!==true)throw Error('切换到云端模型需要明确确认本次发送范围');
          next.pendingRawRecallSwitch={confirmedAt:next.pendingRawRecallAt,cloudConfirmed:input.cloudConfirmed===true};
        }else delete next.pendingRawRecallSwitch;
      }catch(error){if(createdKey)await removeUnusedStagedKey(cfg,createdKey);throw error;}
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
export async function stageDeploymentRerank(file,input,expectedRevision){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的配置版本');
  if(!input||typeof input!=='object'||Array.isArray(input)||typeof input.enabled!=='boolean')throw Error('请选择有效的重排设置');
  const source=input.source===undefined?'service':input.source;
  if(!['service','direct'].includes(source))throw Error('请选择有效的重排服务来源');
  let lock;try{lock=await fs.open(file+'.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('配置正在被另一操作使用；请稍后重试');throw error;}
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision)throw Object.assign(Error('配置已被其他操作修改，请刷新后重试'),{code:'REVISION_CONFLICT'});
    if(cfg.memory!==undefined&&(!cfg.memory||typeof cfg.memory!=='object'||Array.isArray(cfg.memory)))throw Error('当前记忆功能配置无效');
    const memory={...cfg.memory};
    const previousSource=memory.memoryRerankSource==='direct'?'direct':'service';
    const previousKey=typeof memory.memoryRerankApiKeyFile==='string'?memory.memoryRerankApiKeyFile:'';
    let createdKey='',saveWarning='';
    if(input.enabled&&input.cloudConfirmed!==true)throw Error('开启重排会把候选记忆片段发送到所选服务，请先确认');
    if(source==='service'){
      memory.memoryRerankSource='service';
      if(input.enabled){
        const service=embeddingServices(cfg).find(item=>item.id===input.serviceId);
        if(!service)throw Error('所选重排服务已不存在，请刷新');
        if(!service.apiKeyFile)throw Error('所选重排服务尚未保存 API Key');
        const model=typeof input.model==='string'?input.model.trim():'';
        if(!model||model.length>120||/[\u0000-\u001f\u007f]/u.test(model))throw Error('重排模型名称应为 1 到 120 个字符');
        const candidates=input.candidates===undefined?(memory.memoryRerankCandidates??30):input.candidates;
        if(!Number.isInteger(candidates)||candidates<5||candidates>50)throw Error('重排候选数应为 5 到 50 的整数');
        Object.assign(memory,{memoryRerank:true,memoryRerankApiBase:service.apiBase,memoryRerankApiKeyFile:service.apiKeyFile,
          memoryRerankServiceId:service.id,memoryRerankModel:model,memoryRerankCandidates:candidates});
      }else{
        memory.memoryRerank=false;
        if(previousSource==='direct'&&/^rerank-[a-f0-9-]{36}\.key$/i.test(path.basename(previousKey)))memory.memoryRerankApiKeyFile='';
      }
    }else{
      const rawBase=typeof input.apiBase==='string'?input.apiBase.trim():'';
      if(!rawBase)throw Error('请填写重排服务地址');
      let apiBase;
      try{apiBase=normalizedRerankBase(rawBase);}
      catch{throw Error('重排服务地址需为 HTTPS，或本机回环 HTTP 地址');}
      const model=typeof input.model==='string'?input.model.trim():'';
      if(!model||model.length>120||/[\u0000-\u001f\u007f]/u.test(model))throw Error('重排模型名称应为 1 到 120 个字符');
      const candidates=input.candidates===undefined?(memory.memoryRerankCandidates??30):input.candidates;
      if(!Number.isInteger(candidates)||candidates<5||candidates>50)throw Error('重排候选数应为 5 到 50 的整数');
      const key=input.apiKey===undefined?'':String(input.apiKey).trim();
      if(key.length>8192||/[\r\n\u0000]/.test(key))throw Error('API Key 格式无效');
      let keyFile='',sameAddress=false;
      if(previousSource==='direct'&&previousKey){
        try{sameAddress=normalizedRerankBase(memory.memoryRerankApiBase)===apiBase;}catch{}
      }
      if(key){
        keyFile=await writeRerankKey(cfg,key);
        createdKey=keyFile;
      }else if(sameAddress&&previousKey)keyFile=previousKey;
      else if(loopbackUrl(apiBase))keyFile='';
      else throw Error('请填写重排服务的 API Key');
      Object.assign(memory,{memoryRerank:input.enabled,memoryRerankSource:'direct',memoryRerankApiBase:apiBase,
        memoryRerankApiKeyFile:keyFile,memoryRerankServiceId:'',memoryRerankModel:model,memoryRerankCandidates:candidates});
    }
    const next={...cfg,memory};
    try{await save(file,next);}
    catch(error){if(createdKey)await removeUnusedRerankKey(cfg,createdKey);throw error;}
    try{await removeUnusedRerankKey(next,previousKey);}
    catch{saveWarning='重排设置已保存；未引用的旧密钥文件暂未清理，已保留';}
    return {rerank:publicDeploymentRerank(next),revision:deploymentFingerprint(next),...(saveWarning?{saveWarning}:{})};
  }finally{await lock.close();await fs.rm(file+'.lock',{force:true});}
}
export async function stageDeploymentSessionDefault(file,enabled,expectedRevision,afterSave){
  if(!path.isAbsolute(file??'')||typeof expectedRevision!=='string'||!expectedRevision)throw Error('需要有效的配置版本');
  if(typeof enabled!=='boolean')throw Error('请选择有效的开关状态');
  const lock=await fs.open(file+'.lock','wx');
  try{
    const cfg=JSON.parse(await fs.readFile(file,'utf8'));
    if(deploymentFingerprint(cfg)!==expectedRevision)throw Object.assign(Error('配置已被其他操作修改，请刷新后重试'),{code:'REVISION_CONFLICT'});
    const next={...cfg,autoEnableNewSessions:enabled},revision=deploymentFingerprint(next);
    await save(file,next);
    if(afterSave)try{await afterSave(next,revision);}catch{throw Error('新对话记忆设置已保存，运行状态未更新；请重新加载记忆框架');}
    return {autoEnableNewSessions:enabled,revision,applied:Boolean(afterSave)};
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

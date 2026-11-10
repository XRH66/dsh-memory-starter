import fs from 'node:fs/promises';
import path from 'node:path';
import {initializeMemoryDirectory,validateNewMemoryLocation,validateExistingMemoryDirectory,hasMemoryPending} from './memory-install.js';
import {DEFAULT_VAULT_PATH} from './paths.js';
import {trusted,json,body} from './settings-host.js';
import {deploymentFingerprint,listDeploymentSessions,updateDeploymentSession,writeDeploymentJson} from './deployment-config.js';

const base='/api/basic-memory-bootstrap';
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
async function paths(profile){
  if(!profile||typeof profile.name!=='string'||!profile.name||/[\\/\0]/.test(profile.name)||['.','..','node_modules'].includes(profile.name)||!path.isAbsolute(profile.dir??'')||!path.isAbsolute(profile.home??''))throw Error('当前 DSH profile 无法识别');
  const directory=path.resolve(profile.dir),expected=path.resolve(profile.home,'profiles',profile.name);
  if(!samePath(directory,expected)||!samePath(await fs.realpath(directory),directory))throw Error('当前 profile 路径不受支持');
  const root=path.join(directory,'basic-memory-bridge'),configFile=path.join(root,'configuration.json');
  return {directory,root,configFile,activationFile:path.join(root,'activation.json'),socialRoot:path.join(root,'social'),personalDirectory:path.join(root,'personal'),dshHome:path.resolve(profile.home)};
}
async function existing(file){try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function readActivation(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function guardConfiguration(p){
  if(!samePath(await fs.realpath(p.root),p.root))throw Error('配置目录不能是链接');
  const stat=await fs.lstat(p.configFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('配置文件不能是链接');
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
async function listModels(llm,provider){
  let timer;try{return await Promise.race([llm.listModels(provider),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('读取模型超时，请手动填写')),15_000);timer.unref?.();})]);}finally{clearTimeout(timer);}
}
export async function readBootstrap(profile,rawConfig={},providers=[]){
  const p=await paths(profile),configured=await existing(p.configFile);let sessions=[],revision=null,sessionsError=null,activation=null,cfg=null;
  if(configured){await guardConfiguration(p);if(await existing(p.activationFile)){const stat=await fs.lstat(p.activationFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('启用记录不受支持');activation=await readActivation(p.activationFile);}cfg=JSON.parse(await fs.readFile(p.configFile,'utf8'));try{sessions=await listDeploymentSessions(cfg);}catch{sessionsError='暂时无法读取 DSH 聊天列表，请先创建聊天或稍后重试。';}revision=deploymentFingerprint(cfg);}
  return {profile:profile.name,configured,configFile:p.configFile,personalDirectory:cfg?.ownerDirectory??p.personalDirectory,captureProvider:cfg?.memory?.captureProvider??(typeof rawConfig.captureProvider==='string'?rawConfig.captureProvider:''),captureModel:cfg?.memory?.captureModel??(typeof rawConfig.captureModel==='string'?rawConfig.captureModel:''),providers:providers.filter(item=>typeof item?.id==='string'&&typeof item?.name==='string').map(({id,name})=>({id,name})),sessions,sessionsError,revision,activation:activation?.state??null,activationInUse:activation?.state==='active'&&Number.isInteger(activation.activePid)&&alive(activation.activePid),activationError:activation?.state==='failed'?'上次启用未成功，当前仍使用原记忆；检查配置后可重试。':null};
}
export async function updateBootstrapOptions(profile,input,revision){
  const p=await paths(profile);await guardConfiguration(p);if(typeof revision!=='string'||!revision)throw Error('需要有效的配置版本');
  const lock=await fs.open(p.configFile+'.lock','wx').catch(error=>{if(error.code==='EEXIST')throw Error('配置正在被另一操作使用');throw error;});
  try{
    if(await existing(p.activationFile))throw Error('请先取消待启用操作');
    const cfg=JSON.parse(await fs.readFile(p.configFile,'utf8'));if(deploymentFingerprint(cfg)!==revision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    if(typeof input?.captureProvider!=='string'||!input.captureProvider.trim()||typeof input.captureModel!=='string'||!input.captureModel.trim())throw Error('请填写整理服务和模型');
    const {backend:_unused,...rest}=cfg;
    await writeDeploymentJson(p.configFile,{...rest,memory:{...cfg.memory,captureProvider:input.captureProvider.trim(),captureModel:input.captureModel.trim()}});
  }finally{await lock.close();await fs.rm(p.configFile+'.lock',{force:true});}
}
export async function updateBootstrapSessions(profile,ids,revision){
  const p=await paths(profile);await guardConfiguration(p);
  return updateDeploymentSession(p.configFile,{action:'replace',value:ids},revision,undefined,async()=>{if(await existing(p.activationFile))throw Error('请先取消待启用操作');});
}
export async function stageBootstrapActivation(profile,rawConfig,revision,action='schedule'){
  const p=await paths(profile);if(!await existing(p.configFile))throw Error('请先准备独立配置');
  await guardConfiguration(p);
  const lock=await fs.open(p.configFile+'.lock','wx').catch(error=>{if(error.code==='EEXIST')throw Error('配置正在被另一操作使用');throw error;});
  try{
    const cfg=JSON.parse(await fs.readFile(p.configFile,'utf8'));if(deploymentFingerprint(cfg)!==revision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    const current=await readActivation(p.activationFile);if(current?.state==='active'&&Number.isInteger(current.activePid)&&alive(current.activePid))throw Error('已有 DSH 进程正在使用该配置');
    if(action==='cancel'){await fs.rm(p.activationFile,{force:true});return {activation:null};}
    if(action!=='schedule')throw Error('未知启用操作');
    if(!cfg.dshSessionIds?.length)throw Error('请先选择至少一个使用新记忆库的 DSH 聊天');
    const sessions=await listDeploymentSessions(cfg);if(cfg.dshSessionIds.some(id=>!sessions.some(item=>item.id===id)))throw Error('已选择的聊天不可用，请重新选择');
    if(!cfg.memory?.captureProvider||!cfg.memory?.captureModel)throw Error('整理服务或模型尚未配置');
    await validateExistingMemoryDirectory(cfg.ownerDirectory);await validateNewMemoryLocation(cfg.ownerDirectory,[path.resolve(rawConfig.vaultPath||DEFAULT_VAULT_PATH),cfg.socialRoot]);
    if(await hasMemoryPending(cfg.ownerDirectory))throw Error('新库仍有待整理内容');
    await writeDeploymentJson(p.activationFile,{version:1,state:'scheduled',profile:profile.name,configFile:p.configFile,fingerprint:deploymentFingerprint(cfg),scheduledPid:process.pid});
    return {activation:'scheduled'};
  }finally{await lock.close();await fs.rm(p.configFile+'.lock',{force:true});}
}
/** Read a previously scheduled activation without modifying the current profile. */
export async function readScheduledBootstrap(profile,rawConfig){
  const p=await paths(profile);if(!await existing(p.activationFile))return null;
  await guardConfiguration(p);
  const stat=await fs.lstat(p.activationFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('启用记录不受支持');
  const marker=await readActivation(p.activationFile);if(!marker||marker.version!==1||marker.profile!==profile.name||!samePath(path.resolve(marker.configFile??''),p.configFile)||!['scheduled','active','failed'].includes(marker.state)||(marker.state==='scheduled'&&(!Number.isInteger(marker.scheduledPid)||marker.scheduledPid<=0||typeof marker.fingerprint!=='string')))throw Error('启用记录无效');
  if(marker.state==='failed'||(marker.state==='scheduled'&&Number.isInteger(marker.scheduledPid)&&alive(marker.scheduledPid)))return null;
  const plan={configFile:p.configFile,activationFile:p.activationFile,marker};
  try{
    if(marker.state==='active'&&Number.isInteger(marker.activePid)&&marker.activePid!==process.pid&&alive(marker.activePid))throw Error('已有 DSH 进程正在使用该配置');
    const cfg=JSON.parse(await fs.readFile(p.configFile,'utf8'));if(marker.state==='scheduled'&&marker.fingerprint!==deploymentFingerprint(cfg))throw Error('待启用配置已改变');
    if(marker.state==='scheduled'&&!cfg.dshSessionIds?.length)throw Error('未选择使用新记忆库的聊天');
    if(marker.state==='scheduled'){const sessions=await listDeploymentSessions(cfg);if(cfg.dshSessionIds.some(id=>!sessions.some(item=>item.id===id)))throw Error('已选择的聊天不可用');}
    if(!cfg.memory?.captureProvider||!cfg.memory?.captureModel)throw Error('整理服务或模型尚未配置');
    await validateExistingMemoryDirectory(cfg.ownerDirectory);if(marker.state==='scheduled')await validateNewMemoryLocation(cfg.ownerDirectory,[path.resolve(rawConfig.vaultPath||DEFAULT_VAULT_PATH),cfg.socialRoot]);
    if(marker.state==='scheduled'&&await hasMemoryPending(cfg.ownerDirectory))throw Error('新库仍有待整理内容');
    return plan;
  }catch(error){return {...plan,error:String(error.message??'配置校验失败')};}
}
export async function recordBootstrapActivation(plan,state){
  if(!['active','failed'].includes(state))throw Error('无效启用状态');
  const lock=await fs.open(plan.configFile+'.lock','wx').catch(error=>{if(error.code==='EEXIST')throw Error('配置正在被另一操作使用');throw error;});
  try{
    const current=await readActivation(plan.activationFile);if(JSON.stringify(current)!==JSON.stringify(plan.marker))throw Error('待启用操作已改变');
    if(state==='failed'){
      if(current.state==='active'&&Number.isInteger(current.activePid)&&current.activePid!==process.pid&&alive(current.activePid))throw Error('已有 DSH 进程正在使用该配置');
      // A competing startup can fail before the successful startup has marked
      // activation active. Its live deployment receipt still owns the config.
      const runtime=await readActivation(plan.configFile+'.runtime.json');
      if(Number.isInteger(runtime?.pid)&&runtime.pid>0&&alive(runtime.pid))throw Error('已有 DSH 进程正在加载该配置');
    }
    const {activePid,...rest}=current;await writeDeploymentJson(plan.activationFile,{...rest,state,...(state==='active'?{activePid:process.pid}:{})});
  }finally{await lock.close();await fs.rm(plan.configFile+'.lock',{force:true});}
}
export async function createBootstrap(profile,rawConfig,input){
  const p=await paths(profile);
  if(!path.isAbsolute(input?.directory??'')||typeof input?.captureProvider!=='string'||!input.captureProvider.trim()||typeof input?.captureModel!=='string'||!input.captureModel.trim())throw Error('请填写独立记忆目录、整理服务和模型');
  await fs.mkdir(p.root,{recursive:true});if(!samePath(await fs.realpath(p.root),p.root))throw Error('配置目录不能是链接');
  let lock;try{lock=await fs.open(p.configFile+'.setup.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('首次配置正在进行');throw error;}
  try{
    if(await existing(p.configFile))throw Error('首次配置已存在，不会覆盖');
    const directory=await validateNewMemoryLocation(input.directory,[path.resolve(rawConfig.vaultPath||DEFAULT_VAULT_PATH),p.socialRoot]);
    const initialized=await initializeMemoryDirectory({directory});
    const cfg={ownerDirectory:directory,socialRoot:p.socialRoot,dshHome:p.dshHome,dshSessionIds:[],memory:{captureProvider:input.captureProvider.trim(),captureModel:input.captureModel.trim()}};
    let handle;try{handle=await fs.open(p.configFile,'wx');await handle.writeFile(JSON.stringify(cfg,null,2)+'\n');await handle.sync();}catch(error){if(error.code==='EEXIST')throw Error('首次配置已存在，不会覆盖');throw error;}finally{await handle?.close();}
    return {configured:true,configFile:p.configFile,directory,initialized:initialized.initialized??true,applied:false};
  }finally{await lock.close();await fs.rm(p.configFile+'.setup.lock',{force:true});}
}
export function registerBootstrapRoutes(ctx,rawConfig){
  const profile=ctx.get?.('profileContext');if(!profile||typeof ctx.inject!=='function')return;
  ctx.inject(['webServer'],child=>child.effect(()=>child.webServer.register({kind:'prefix',path:base,handler:async(req,res)=>{
    if(!trusted(child,req,req.method==='POST'))return json(res,403,{ok:false,error:'访问被拒绝'});
    try{
      const url=new URL(req.url??'/', 'http://localhost'),sub=url.pathname.slice(base.length).replace(/\/+$/,'')||'/';
      if(req.method==='GET'&&sub==='/')return json(res,200,{ok:true,...await readBootstrap(profile,rawConfig,ctx.llm?.listProviders?.()??[])});
      if(req.method==='GET'&&sub==='/models'){
        const providers=ctx.llm?.listProviders?.()??[];
        const provider=url.searchParams.get('provider');if(!providers.some(item=>item.id===provider))throw Error('请选择已注册的整理服务');
        const models=await listModels(ctx.llm,provider);return json(res,200,{ok:true,models:models.filter(item=>typeof item?.id==='string'&&typeof item?.name==='string').map(({id,name})=>({id,name}))});
      }
      if(req.method==='POST'&&sub==='/sessions'){
        const input=await body(req);if(!Array.isArray(input.ids)||typeof input.revision!=='string')throw Error('请选择有效的聊天');
        await updateBootstrapSessions(profile,input.ids,input.revision);return json(res,200,{ok:true,...await readBootstrap(profile,rawConfig,ctx.llm?.listProviders?.()??[])});
      }
      if(req.method==='POST'&&sub==='/options'){
        const input=await body(req);await updateBootstrapOptions(profile,input,input.revision);return json(res,200,{ok:true,...await readBootstrap(profile,rawConfig,ctx.llm?.listProviders?.()??[])});
      }
      if(req.method==='POST'&&sub==='/activation'){
        const input=await body(req);if(typeof input.revision!=='string'||!['schedule','cancel'].includes(input.action))throw Error('请选择有效的启用操作');
        await stageBootstrapActivation(profile,rawConfig,input.revision,input.action);return json(res,200,{ok:true,...await readBootstrap(profile,rawConfig,ctx.llm?.listProviders?.()??[])});
      }
      if(req.method==='POST'&&sub==='/')return json(res,200,{ok:true,...await createBootstrap(profile,rawConfig,await body(req))});return json(res,404,{ok:false,error:'未找到设置'});
    }catch(error){return json(res,400,{ok:false,error:String(error.message??'首次配置失败')});}
  }}),'basic-memory: bootstrap routes'));
}

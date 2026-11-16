import fs from 'node:fs/promises';
import path from 'node:path';
import {initializeMemoryDirectory,validateNewMemoryLocation,validateExistingMemoryDirectory} from './memory-install.js';
import {DEFAULT_VAULT_PATH} from './paths.js';
import {trusted,json,body} from './settings-host.js';
import {deploymentFingerprint,listDeploymentSessions,updateDeploymentSession,writeDeploymentJson} from './deployment-config.js';

const base='/api/basic-memory-bootstrap';
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const validSessionId=id=>typeof id==='string'&&/^session-[a-zA-Z0-9_-]+$/.test(id);
async function paths(profile){
  if(!profile||typeof profile.name!=='string'||!profile.name||/[\\/\0]/.test(profile.name)||['.','..','node_modules'].includes(profile.name)||!path.isAbsolute(profile.dir??'')||!path.isAbsolute(profile.home??''))throw Error('当前 DSH profile 无法识别');
  const directory=path.resolve(profile.dir),expected=path.resolve(profile.home,'profiles',profile.name);
  if(!samePath(directory,expected)||!samePath(await fs.realpath(directory),directory))throw Error('当前 profile 路径不受支持');
  const root=path.join(directory,'basic-memory-bridge'),configFile=path.join(root,'configuration.json');
  return {directory,root,configFile,activationFile:path.join(root,'activation.json'),socialRoot:path.join(root,'social'),personalDirectory:path.join(root,'personal'),dshHome:path.resolve(profile.home)};
}
async function existing(file){try{await fs.access(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function readActivation(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
function activationConsent(marker){
  if(!marker||marker.consent===undefined)return null;
  const sessionIds=marker.consent?.sessionIds;
  if(!Array.isArray(sessionIds)||sessionIds.some(id=>!validSessionId(id))||new Set(sessionIds).size!==sessionIds.length||
    typeof marker.consent?.autoEnableNewSessions!=='boolean')throw Error('启用记录里的聊天选择无效');
  return {sessionIds:[...sessionIds],autoEnableNewSessions:marker.consent.autoEnableNewSessions};
}
async function guardConfiguration(p){
  if(!samePath(await fs.realpath(p.root),p.root))throw Error('配置目录不能是链接');
  const stat=await fs.lstat(p.configFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('配置文件不能是链接');
}
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
async function actualLocation(value){
  try{return await fs.realpath(value);}
  catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=path.dirname(value);if(parent===value)throw error;
    return path.join(await actualLocation(parent),path.basename(value));
  }
}
async function nearestExistingDirectory(value){
  let current=value;
  while(true){
    try{
      const stat=await fs.stat(current);
      if(!stat.isDirectory())throw Error('路径的一部分不是文件夹');
      return current;
    }catch(error){
      if(error.code!=='ENOENT')throw error;
      const parent=path.dirname(current);if(parent===current)throw error;current=parent;
    }
  }
}
async function childSuggestion(directory){
  for(let index=1;index<100;index++){
    const candidate=path.join(directory,index===1?'dsh-memory':'dsh-memory-'+index);
    if(!await existing(candidate))return candidate;
  }
  return path.join(directory,'dsh-memory-new');
}
/** Inspect a prospective library location without creating or changing it. */
export async function checkBootstrapLocation(profile,rawConfig,input){
  if(typeof input?.directory!=='string'||!path.isAbsolute(input.directory)){
    return {status:'invalid',usable:false,directory:input?.directory??'',message:'请填写完整的文件夹路径。'};
  }
  const p=await paths(profile),requested=path.resolve(input.directory);
  try{
    await validateNewMemoryLocation(requested,[path.resolve(rawConfig?.vaultPath||DEFAULT_VAULT_PATH),p.socialRoot]);
  }catch(error){
    const message=String(error.message??'这个位置不能使用');
    return {status:/分开/.test(message)?'overlap':'invalid',usable:false,directory:requested,
      message:message+'。请选择现有记忆以外的位置。'};
  }
  let stat;
  try{stat=await fs.lstat(requested);}
  catch(error){if(error.code!=='ENOENT')throw error;}
  if(stat?.isSymbolicLink())return {status:'linked',usable:false,directory:requested,message:'这个路径是链接，请选择实际文件夹。'};
  if(stat&&!stat.isDirectory())return {status:'invalid',usable:false,directory:requested,message:'这个路径不是文件夹。'};
  try{
    if(await actualLocation(requested)!==requested)
      return {status:'linked',usable:false,directory:requested,message:'这个路径经过链接或目录别名，请选择实际文件夹。'};
  }catch(error){
    return {status:'invalid',usable:false,directory:requested,message:String(error.message??'无法检查这个位置')};
  }
  const writableAt=stat?requested:await nearestExistingDirectory(path.dirname(requested));
  try{await fs.access(writableAt,fs.constants.W_OK);}
  catch{return {status:'unwritable',usable:false,directory:requested,message:'这个位置没有写入权限，请换一个位置。'};}
  if(!stat)return {status:'missing',usable:true,directory:requested,message:'这个文件夹还不存在，继续后会在本机新建。'};
  const markerFile=path.join(requested,'qqbridge-memory-install.json');
  if(await existing(markerFile)){
    try{
      const marker=JSON.parse(await fs.readFile(markerFile,'utf8'));
      if(marker?.version===1&&marker.state==='ready'&&samePath(marker.directory??'',requested)){
        await validateExistingMemoryDirectory(requested);
        return {status:'initialized',usable:true,directory:requested,message:'这个文件夹里已有记忆库，可以接着用这个库。'};
      }
    }catch{/* The shared not-empty decision below refuses incomplete or invalid markers. */}
    return {status:'not-empty',usable:false,directory:requested,suggestedDirectory:await childSuggestion(requested),
      message:'这个文件夹里的初始化还没有完成或记录无效，不能直接使用。可以在这里新建一个子文件夹。'};
  }
  const entries=await fs.readdir(requested);
  if(!entries.length)return {status:'empty',usable:true,directory:requested,message:'这个空文件夹可以直接使用。'};
  return {status:'not-empty',usable:false,directory:requested,suggestedDirectory:await childSuggestion(requested),
    message:'这个文件夹里还有其他文件，不能直接用作记忆库。可以在这里新建一个子文件夹。'};
}
async function frameworkLoaded(p,cfg){
  const file=p.configFile+'.runtime.json';
  if(!await existing(file))return false;
  try{
    const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())return false;
    const receipt=JSON.parse(await fs.readFile(file,'utf8'));
    return receipt?.pid===process.pid&&receipt.state==='ready'&&receipt.fingerprint===deploymentFingerprint(cfg);
  }catch{return false;}
}
export async function readBootstrap(profile){
  const p=await paths(profile),configured=await existing(p.configFile);let sessions=[],revision=null,sessionsError=null,activation=null,cfg=null,loaded=false;
  if(configured){await guardConfiguration(p);if(await existing(p.activationFile)){const stat=await fs.lstat(p.activationFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('启用记录不受支持');activation=await readActivation(p.activationFile);}cfg=JSON.parse(await fs.readFile(p.configFile,'utf8'));try{sessions=await listDeploymentSessions(cfg);}catch{sessionsError='暂时无法读取 DSH 聊天列表，请先创建聊天或稍后重试。';}revision=deploymentFingerprint(cfg);loaded=await frameworkLoaded(p,cfg);}
  const consent=activationConsent(activation);
  return {profile:profile.name,configured,frameworkLoaded:loaded,configFile:p.configFile,personalDirectory:cfg?.ownerDirectory??p.personalDirectory,sessions,sessionsError,revision,activation:activation?.state??null,activationInUse:activation?.state==='active'&&Number.isInteger(activation.activePid)&&alive(activation.activePid),activationError:activation?.state==='failed'?'上次启用未成功，当前仍使用原记忆；检查配置后可重试。'+(activation.error?'原因：'+activation.error:''):null,consent};
}
export async function updateBootstrapSessions(profile,ids,revision){
  const p=await paths(profile);await guardConfiguration(p);
  return updateDeploymentSession(p.configFile,{action:'replace',value:ids},revision,undefined,async()=>{if(await existing(p.activationFile))throw Error('请先取消待启用操作');});
}
export async function stageBootstrapActivation(profile,rawConfig,revision,action='schedule',consentInput){
  const p=await paths(profile);if(!await existing(p.configFile))throw Error('请先准备独立配置');
  await guardConfiguration(p);
  const lock=await fs.open(p.configFile+'.lock','wx').catch(error=>{if(error.code==='EEXIST')throw Error('配置正在被另一操作使用');throw error;});
  try{
    const cfg=JSON.parse(await fs.readFile(p.configFile,'utf8'));if(deploymentFingerprint(cfg)!==revision){const error=Error('配置已被其他操作修改，请刷新后重试');error.code='REVISION_CONFLICT';throw error;}
    const current=await readActivation(p.activationFile);if(current?.state==='active'&&Number.isInteger(current.activePid)&&alive(current.activePid))throw Error('已有 DSH 进程正在使用该配置');
    if(action==='cancel'){await fs.rm(p.activationFile,{force:true});return {activation:null};}
    if(action!=='schedule')throw Error('未知启用操作');
    const sessionIds=consentInput?.sessionIds??[];
    if(!Array.isArray(sessionIds)||sessionIds.some(id=>!validSessionId(id))||new Set(sessionIds).size!==sessionIds.length)throw Error('聊天选择无效');
    if(typeof (consentInput?.autoEnableNewSessions??false)!=='boolean')throw Error('新对话记忆设置无效');
    const consent={sessionIds:[...sessionIds],autoEnableNewSessions:consentInput?.autoEnableNewSessions===true};
    const sessions=await listDeploymentSessions(cfg);if(consent.sessionIds.some(id=>!sessions.some(item=>item.id===id)))throw Error('已选择的聊天不可用，请重新选择');
    await validateExistingMemoryDirectory(cfg.ownerDirectory);await validateNewMemoryLocation(cfg.ownerDirectory,[path.resolve(rawConfig.vaultPath||DEFAULT_VAULT_PATH),cfg.socialRoot]);
    await writeDeploymentJson(p.activationFile,{version:1,state:'scheduled',profile:profile.name,configFile:p.configFile,fingerprint:deploymentFingerprint(cfg),scheduledPid:process.pid,consent});
    return {activation:'scheduled',consent};
  }finally{await lock.close();await fs.rm(p.configFile+'.lock',{force:true});}
}
/** Read a previously scheduled activation without modifying the current profile. */
export async function readScheduledBootstrap(profile,rawConfig){
  const p=await paths(profile);if(!await existing(p.activationFile))return null;
  await guardConfiguration(p);
  const stat=await fs.lstat(p.activationFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('启用记录不受支持');
  const marker=await readActivation(p.activationFile);if(!marker||marker.version!==1||marker.profile!==profile.name||!samePath(path.resolve(marker.configFile??''),p.configFile)||!['scheduled','active','failed'].includes(marker.state)||(marker.state==='scheduled'&&(!Number.isInteger(marker.scheduledPid)||marker.scheduledPid<=0||typeof marker.fingerprint!=='string')))throw Error('启用记录无效');
  if(marker.state==='failed'||(marker.state==='scheduled'&&Number.isInteger(marker.scheduledPid)&&alive(marker.scheduledPid)))return null;
  const consent=activationConsent(marker),pending=Array.isArray(marker.consentPendingSessionIds)
    ? marker.consentPendingSessionIds.filter(id=>validSessionId(id)) : [];
  const existingSessionIds=Array.isArray(marker.firstRunExistingSessionIds)
    ? marker.firstRunExistingSessionIds.filter(id=>validSessionId(id)) : [];
  const plan={configFile:p.configFile,activationFile:p.activationFile,marker,consent,pending,existing:existingSessionIds};
  try{
    if(marker.state==='active'&&Number.isInteger(marker.activePid)&&marker.activePid!==process.pid&&alive(marker.activePid))throw Error('已有 DSH 进程正在使用该配置');
    const cfg=JSON.parse(await fs.readFile(p.configFile,'utf8'));if(marker.state==='scheduled'&&marker.fingerprint!==deploymentFingerprint(cfg))throw Error('待启用配置已改变');
    if(marker.state==='scheduled'&&consent){const sessions=await listDeploymentSessions(cfg);if(consent.sessionIds.some(id=>!sessions.some(item=>item.id===id)))throw Error('已选择的聊天不可用');}
    await validateExistingMemoryDirectory(cfg.ownerDirectory);if(marker.state==='scheduled')await validateNewMemoryLocation(cfg.ownerDirectory,[path.resolve(rawConfig.vaultPath||DEFAULT_VAULT_PATH),cfg.socialRoot]);
    return plan;
  }catch(error){return {...plan,error:String(error.message??'配置校验失败')};}
}
export async function recordBootstrapActivation(plan,state,details={}){
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
    const {activePid,...rest}=current;await writeDeploymentJson(plan.activationFile,{...rest,...details,state,...(state==='active'?{activePid:process.pid}:{})});
  }finally{await lock.close();await fs.rm(plan.configFile+'.lock',{force:true});}
}
export async function updateBootstrapActivationPending(plan,ids){
  if(!Array.isArray(ids)||ids.some(id=>!validSessionId(id))||new Set(ids).size!==ids.length)throw Error('待打开聊天记录无效');
  const lock=await fs.open(plan.configFile+'.lock','wx').catch(error=>{if(error.code==='EEXIST')throw Error('配置正在被另一操作使用');throw error;});
  try{
    const current=await readActivation(plan.activationFile);
    if(!current||current.state!=='active')throw Error('启用记录尚未生效');
    if(current.profile!==plan.marker.profile||!samePath(path.resolve(current.configFile??''),plan.configFile))throw Error('启用记录已改变');
    await writeDeploymentJson(plan.activationFile,{...current,consentPendingSessionIds:[...ids]});
  }finally{await lock.close();await fs.rm(plan.configFile+'.lock',{force:true});}
}
export async function createBootstrap(profile,rawConfig,input){
  const p=await paths(profile);
  if(!path.isAbsolute(input?.directory??''))throw Error('请填写独立记忆目录');
  await fs.mkdir(p.root,{recursive:true});if(!samePath(await fs.realpath(p.root),p.root))throw Error('配置目录不能是链接');
  let lock;try{lock=await fs.open(p.configFile+'.setup.lock','wx');}catch(error){if(error.code==='EEXIST')throw Error('首次配置正在进行');throw error;}
  try{
    const replace=input.replace===true,alreadyConfigured=await existing(p.configFile);
    if(alreadyConfigured&&!replace)throw Error('首次配置已存在，不会覆盖');
    if(replace){
      await guardConfiguration(p);
      if(await existing(p.activationFile)){
        const marker=await readActivation(p.activationFile);
        if(marker?.state==='scheduled'||(marker?.state==='active'&&Number.isInteger(marker.activePid)&&alive(marker.activePid)))
          throw Error('请先取消启用，再修改记忆库位置');
      }
    }
    const directory=await validateNewMemoryLocation(input.directory,[path.resolve(rawConfig.vaultPath||DEFAULT_VAULT_PATH),p.socialRoot]);
    const initialized=await initializeMemoryDirectory({directory});
    const cfg={ownerDirectory:directory,socialRoot:p.socialRoot,dshHome:p.dshHome,dshSessionIds:[]};
    if(replace){
      await writeDeploymentJson(p.configFile,cfg);
      await fs.rm(p.activationFile,{force:true});
    }else{
      let handle;try{handle=await fs.open(p.configFile,'wx');await handle.writeFile(JSON.stringify(cfg,null,2)+'\n');await handle.sync();}catch(error){if(error.code==='EEXIST')throw Error('首次配置已存在，不会覆盖');throw error;}finally{await handle?.close();}
    }
    return {configured:true,configFile:p.configFile,directory,initialized:initialized.initialized??true,applied:false,replaced:replace};
  }finally{await lock.close();await fs.rm(p.configFile+'.setup.lock',{force:true});}
}
export function registerBootstrapRoutes(ctx,rawConfig){
  const profile=ctx.get?.('profileContext');if(!profile||typeof ctx.inject!=='function')return;
  ctx.inject(['webServer'],child=>child.effect(()=>child.webServer.register({kind:'prefix',path:base,handler:async(req,res)=>{
    if(!trusted(child,req,req.method==='POST'))return json(res,403,{ok:false,error:'访问被拒绝'});
    try{
      const url=new URL(req.url??'/', 'http://localhost'),sub=url.pathname.slice(base.length).replace(/\/+$/,'')||'/';
      if(req.method==='GET'&&sub==='/')return json(res,200,{ok:true,...await readBootstrap(profile)});
      if(req.method==='POST'&&sub==='/location')return json(res,200,{ok:true,...await checkBootstrapLocation(profile,rawConfig,await body(req))});
      if(req.method==='POST'&&sub==='/sessions'){
        const input=await body(req);if(!Array.isArray(input.ids)||typeof input.revision!=='string')throw Error('请选择有效的聊天');
        await updateBootstrapSessions(profile,input.ids,input.revision);return json(res,200,{ok:true,...await readBootstrap(profile)});
      }
      if(req.method==='POST'&&sub==='/activation'){
        const input=await body(req);if(typeof input.revision!=='string'||!['schedule','cancel'].includes(input.action))throw Error('请选择有效的启用操作');
        await stageBootstrapActivation(profile,rawConfig,input.revision,input.action,{
          sessionIds:input.sessionIds,
          autoEnableNewSessions:input.autoEnableNewSessions,
        });return json(res,200,{ok:true,...await readBootstrap(profile)});
      }
      if(req.method==='POST'&&sub==='/')return json(res,200,{ok:true,...await createBootstrap(profile,rawConfig,await body(req))});return json(res,404,{ok:false,error:'未找到设置'});
    }catch(error){return json(res,400,{ok:false,error:String(error.message??'首次配置失败')});}
  }}),'basic-memory: bootstrap routes'));
}
export function registerLoadedBootstrapRoute(ctx,profile){
  if(!ctx||typeof ctx.inject!=='function')return;
  ctx.inject(['webServer'],child=>child.effect(()=>child.webServer.register({kind:'prefix',path:base,handler:async(req,res)=>{
    if(!trusted(child,req,false))return json(res,403,{ok:false,error:'访问被拒绝'});
    const url=new URL(req.url??'/','http://localhost'),sub=url.pathname.slice(base.length).replace(/\/+$/,'')||'/';
    if(req.method==='GET'&&sub==='/'){
      if(!profile)return json(res,200,{ok:true,configured:true,frameworkLoaded:true});
      try{
        const p=await paths(profile);let marker=null;
        if(await existing(p.activationFile)){
          const stat=await fs.lstat(p.activationFile);if(!stat.isFile()||stat.isSymbolicLink())throw Error('启用记录不受支持');
          marker=await readActivation(p.activationFile);
        }
        const consent=activationConsent(marker),pending=Array.isArray(marker?.consentPendingSessionIds)
          ? marker.consentPendingSessionIds.filter(id=>validSessionId(id)):[],
          existingSessionIds=Array.isArray(marker?.firstRunExistingSessionIds)
            ? marker.firstRunExistingSessionIds.filter(id=>validSessionId(id)):[];
        return json(res,200,{ok:true,configured:true,frameworkLoaded:true,activation:marker?.state??null,consent,
          consentPendingSessionIds:pending,firstRunExistingSessionIds:existingSessionIds});
      }catch(error){
        // The framework is running either way; an unreadable first-run record must not
        // turn a working settings page into an error (deployments may use other paths).
        child.logger?.warn?.('[basic-memory-bridge] first-run record unreadable: '+String(error?.message??error));
        return json(res,200,{ok:true,configured:true,frameworkLoaded:true});
      }
    }
    return json(res,409,{ok:false,error:'记忆框架已在运行，请在设置页「记忆框架」里调整。'});
  }}),'basic-memory: loaded bootstrap route'));
}

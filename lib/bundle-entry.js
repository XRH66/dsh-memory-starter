import {apply as applyLegacy} from './index.js';
export {Config} from './index.js';
import {createMemoryConnections} from './memory-connections.js';
import {apply as applyPersonal} from './platform-host.js';
import {beginDeploymentConfiguration,deploymentFingerprint,deploymentStaticFingerprint} from './deployment-config.js';
import {listExistingOwnerSubjects,personalFactLibraryEmpty} from './owner-identity.js';
import {resolveConfig} from './config.js';
import path from 'node:path';
import {registerBootstrapRoutes,readScheduledBootstrap,recordBootstrapActivation} from './bootstrap-host.js';
import {existsSync} from 'node:fs';

const personalServiceKey=Symbol.for('@local/dsh-basic-memory-bridge/memoryPersonal');

// One installed entry: preserve the existing bridge unless portable mode is
// explicitly configured. The optional QQ attachment uses memoryPersonal only
// when that personal host is actually enabled.
export const name='basic-memory-bundle';
export const inject=['tools','llm','agents','sessions'];
export function apply(ctx,options={}){
  if(options.mode==='unified')return startUnified(ctx,options);
  if(options.mode===undefined){const profile=ctx.get?.('profileContext');if(profile&&path.isAbsolute(profile.dir??'')&&existsSync(path.join(profile.dir,'basic-memory-bridge','activation.json')))return startScheduled(ctx,options,profile);}
  if(options.mode===undefined||options.mode==='legacy'){registerBootstrapRoutes(ctx,options);return applyLegacy(ctx,options);}
  if(options.mode!=='portable')throw Error('Unknown memory runtime mode');
  return startPortable(ctx,options);
}
async function startUnified(ctx,options){
  const entry=new URL('./unified/index.js',import.meta.url);
  const plugin=await import('./unified/index.js').catch(error=>{
    if(error.code==='ERR_MODULE_NOT_FOUND'&&error.url===entry.href){
      throw Object.assign(new Error('Unified mode requires the standalone unified candidate. Use portable or legacy mode with the ordinary package.'),{code:'UNIFIED_CANDIDATE_REQUIRED'});
    }
    throw error;
  });
  const fiber=ctx.plugin(plugin,options);
  await fiber.await();
}
async function startScheduled(ctx,options,profile){
  let plan,fiber;
  try{
    plan=await readScheduledBootstrap(profile,options);
    if(!plan){registerBootstrapRoutes(ctx,options);applyLegacy(ctx,options);return;}
    if(plan.error)throw Error(plan.error);
    fiber=ctx.plugin(child=>startPortable(child,{mode:'portable',configurationFile:plan.configFile}));
    await fiber;
    await recordBootstrapActivation(plan,'active');
  }catch(error){
    if(fiber)try{await fiber.dispose();}catch(disposeError){ctx.logger?.warn?.('[basic-memory-bridge] activation cleanup failed: '+disposeError.message);}
    if(['scheduled','active'].includes(plan?.marker?.state))try{await recordBootstrapActivation(plan,'failed');}catch{}
    ctx.logger?.warn?.('[basic-memory-bridge] scheduled activation failed; using existing memory: '+String(error.message??error));
    registerBootstrapRoutes(ctx,options);applyLegacy(ctx,options);
  }
}
async function startPortable(ctx,options){
  let deployment,connections,service;
  try{
    let settings=options;
    if(options.configurationFile){
      if(options.connections||options.personal)throw Error('Use one deployment configuration source');
      deployment=await beginDeploymentConfiguration(options.configurationFile);
      ctx.effect(()=>()=>deployment.close());
      let cfg=deployment.cfg;
      if(deployment.pendingOwnerIdentity){
        connections=createMemoryConnections({backend:cfg.backend,personalDirectory:cfg.ownerDirectory,socialRoot:cfg.socialRoot,logger:ctx.logger});
        const memory=await connections.acquire(cfg.ownerDirectory),config=resolveConfig({...cfg.memory,project:'main',vaultPath:path.join(cfg.ownerDirectory,'vault')});
        try{
          if(deployment.pendingOwnerIdentity.kind==='new-qq'){
            if(!await personalFactLibraryEmpty({tools:memory.tools,config}))throw Error('个人库出现事实或事件，不能自动新建主人主体');
          }else{
            const preview=await listExistingOwnerSubjects({tools:memory.tools,config,offset:deployment.pendingOwnerIdentity.offset??0});
            if(!preview.subjects.some(item=>item.subject===deployment.pendingOwnerIdentity.subject))throw Error('已选主体在当前个人库中不可确认');
          }
        }catch(error){await deployment.deferPendingOwnerIdentity('主人主体暂未绑定：'+String(error.message??'主体校验失败'));cfg=deployment.cfg;}
      }
      const subject=deployment.pendingOwnerIdentity&&!cfg.pendingOwnerIdentity?(deployment.originalOwnerSubject??options.ownerSubject??undefined):(cfg.ownerSubject??options.ownerSubject);
      if(cfg.ownerSubject&&options.ownerSubject&&cfg.ownerSubject!==options.ownerSubject)throw Error('Conflicting personal subject');
      settings={connections:{backend:cfg.backend,personalDirectory:cfg.ownerDirectory,socialRoot:cfg.socialRoot},personal:{directory:cfg.ownerDirectory,sessionIds:cfg.dshSessionIds,ownerSubject:subject,ownerIdentity:cfg.ownerIdentity,memory:cfg.memory,persona:{basePersona:cfg.basePersona,selfProfile:cfg.selfProfile},sessionMemory:options.sessionMemory===true,configurationFile:options.configurationFile,configurationFingerprint:deploymentFingerprint(cfg),configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment}};
    }
    connections??=createMemoryConnections({...settings.connections,logger:ctx.logger});
    // Cordis disposes effects in reverse registration order: keep the backend
    // available until the personal host has drained its own work.
    ctx.effect(()=>()=>connections.close());
    service=await applyPersonal(ctx,{...(settings.personal??{}),deferProvide:true},connections);
    if(deployment){
      try{await deployment.ready();}
      catch(error){
        if(error.code!=='OWNER_BINDING_RECHECK_FAILED'||!deployment.pendingOwnerIdentity)throw error;
        await deployment.deferPendingOwnerIdentity('主人主体暂未绑定：加载期间出现待处理内容，请处理后重试');
        service.reconcileIdentityConfiguration(deployment.cfg,deploymentFingerprint(deployment.cfg),deployment.cfg.ownerSubject??options.ownerSubject??null);
        await deployment.ready();
      }
      if(deployment.pendingOwnerIdentity)service.reconcileIdentityConfiguration(deployment.cfg,deploymentFingerprint(deployment.cfg),deployment.cfg.ownerSubject??options.ownerSubject??null);
    }
    ctx.provide('memoryPersonal',service);
    globalThis[personalServiceKey]=service;
    ctx.effect(()=>()=>{if(globalThis[personalServiceKey]===service)delete globalThis[personalServiceKey];});
  }catch(error){
    await service?.personal?.close().catch(()=>{});
    await connections?.close().catch(()=>{});
    await deployment?.close().catch(()=>{});
    throw error;
  }
}

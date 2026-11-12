export {Config} from './config.js';
import {apply as applyPersonal} from './platform-host.js';
import {beginDeploymentConfiguration,deploymentFingerprint,deploymentStaticFingerprint} from './deployment-config.js';
import path from 'node:path';
import {registerBootstrapRoutes,readScheduledBootstrap,recordBootstrapActivation} from './bootstrap-host.js';
import {existsSync} from 'node:fs';

const personalServiceKey=Symbol.for('@local/dsh-basic-memory-bridge/memoryPersonal');

// One installed entry. Memory only runs in portable mode; until a deployment is configured the
// entry serves the setup pages and leaves every conversation untouched.
export const name='basic-memory-bundle';
export const inject=['tools','llm','agents','sessions'];
export function apply(ctx,options={}){
  if(options.sessionMemory===false)throw Error('不再支持不用对话开关的运行方式，请去掉 sessionMemory:false');
  if(options.mode==='unified'||options.mode==='legacy')throw Error('已不支持 '+options.mode+' 模式');
  if(options.mode===undefined){const profile=ctx.get?.('profileContext');if(profile&&path.isAbsolute(profile.dir??'')&&existsSync(path.join(profile.dir,'basic-memory-bridge','activation.json')))return startScheduled(ctx,options,profile);}
  if(options.mode===undefined){registerBootstrapRoutes(ctx,options);return;}
  if(options.mode!=='portable')throw Error('Unknown memory runtime mode');
  return startPortable(ctx,options);
}
async function startScheduled(ctx,options,profile){
  let plan,fiber;
  try{
    plan=await readScheduledBootstrap(profile,options);
    if(!plan){registerBootstrapRoutes(ctx,options);return;}
    if(plan.error)throw Error(plan.error);
    fiber=ctx.plugin(child=>startPortable(child,{mode:'portable',configurationFile:plan.configFile,sessionMemory:true}));
    await fiber;
    await recordBootstrapActivation(plan,'active');
  }catch(error){
    if(fiber)try{await fiber.dispose();}catch(disposeError){ctx.logger?.warn?.('[basic-memory-bridge] activation cleanup failed: '+disposeError.message);}
    if(['scheduled','active'].includes(plan?.marker?.state))try{await recordBootstrapActivation(plan,'failed');}catch{}
    ctx.logger?.warn?.('[basic-memory-bridge] scheduled activation failed; memory stays off until setup succeeds: '+String(error.message??error));
    registerBootstrapRoutes(ctx,options);
  }
}
async function startPortable(ctx,options){
  let deployment,service;
  try{
    let settings=options;
    if(options.configurationFile){
      if(options.personal)throw Error('Use one deployment configuration source');
      deployment=await beginDeploymentConfiguration(options.configurationFile);
      ctx.effect(()=>()=>deployment.close());
      let cfg=deployment.cfg;
      const subject=cfg.ownerSubject??options.ownerSubject;
      if(cfg.ownerSubject&&options.ownerSubject&&cfg.ownerSubject!==options.ownerSubject)throw Error('Conflicting personal subject');
      settings={personal:{directory:cfg.ownerDirectory,sessionIds:cfg.dshSessionIds,ownerSubject:subject,memory:cfg.memory,persona:{basePersona:cfg.basePersona,selfProfile:cfg.selfProfile},sessionMemory:true,autoEnableNewSessions:cfg.autoEnableNewSessions===true,configurationFile:options.configurationFile,configurationFingerprint:deploymentFingerprint(cfg),configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment}};
    }
    service=await applyPersonal(ctx,{...(settings.personal??{}),deferProvide:true});
    if(deployment)await deployment.ready();
    ctx.provide('memoryPersonal',service);
    globalThis[personalServiceKey]=service;
    ctx.effect(()=>()=>{if(globalThis[personalServiceKey]===service)delete globalThis[personalServiceKey];});
  }catch(error){
    await service?.personal?.close().catch(()=>{});
    await deployment?.close().catch(()=>{});
    throw error;
  }
}

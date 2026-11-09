import {apply as applyLegacy} from './index.js';
export {Config} from './index.js';
import {createMemoryConnections} from './memory-connections.js';
import {apply as applyPersonal} from './platform-host.js';
import {beginDeploymentConfiguration,deploymentFingerprint,deploymentStaticFingerprint} from './deployment-config.js';
import path from 'node:path';
import {registerBootstrapRoutes,readScheduledBootstrap,recordBootstrapActivation} from './bootstrap-host.js';
import {existsSync} from 'node:fs';

const personalServiceKey=Symbol.for('@local/dsh-basic-memory-bridge/memoryPersonal');

// One installed entry: preserve the existing bridge unless portable mode is
// explicitly configured.
export const name='basic-memory-bundle';
export const inject=['tools','llm','agents','sessions'];
export function apply(ctx,options={}){
  if(options.mode==='unified')throw Error('已不支持 unified 模式');
  if(options.mode===undefined){const profile=ctx.get?.('profileContext');if(profile&&path.isAbsolute(profile.dir??'')&&existsSync(path.join(profile.dir,'basic-memory-bridge','activation.json')))return startScheduled(ctx,options,profile);}
  if(options.mode===undefined||options.mode==='legacy'){registerBootstrapRoutes(ctx,options);return applyLegacy(ctx,options);}
  if(options.mode!=='portable')throw Error('Unknown memory runtime mode');
  return startPortable(ctx,options);
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
      const subject=cfg.ownerSubject??options.ownerSubject;
      if(cfg.ownerSubject&&options.ownerSubject&&cfg.ownerSubject!==options.ownerSubject)throw Error('Conflicting personal subject');
      settings={connections:{backend:cfg.backend,personalDirectory:cfg.ownerDirectory,socialRoot:cfg.socialRoot},personal:{directory:cfg.ownerDirectory,sessionIds:cfg.dshSessionIds,ownerSubject:subject,memory:cfg.memory,persona:{basePersona:cfg.basePersona,selfProfile:cfg.selfProfile},sessionMemory:options.sessionMemory===true,configurationFile:options.configurationFile,configurationFingerprint:deploymentFingerprint(cfg),configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment}};
    }
    connections??=createMemoryConnections({...settings.connections,logger:ctx.logger});
    // Cordis disposes effects in reverse registration order: keep the backend
    // available until the personal host has drained its own work.
    ctx.effect(()=>()=>connections.close());
    service=await applyPersonal(ctx,{...(settings.personal??{}),deferProvide:true},connections);
    if(deployment)await deployment.ready();
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

import path from 'node:path';
import {createBridge,createLazyRecentConversationStore} from './index.js';
import {hasSessionMemory} from './worker.js';
import {createRecentConversationStore} from './recent-context.js';
import {createRecoveryStore} from './recovery.js';
import {resolveConfig} from './config.js';

/** Own the personal memory connection and stores independently of any platform. */
export async function createPersonalMemoryRuntime({directory,config,acquireMemory,llm,logger,recentBinding,captureSubject,findAgent,listAgents,semanticOrganizer,pipelineResources,pipelineCommitted,access,ownerSubject,resolveChatConnection}) {
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Explicit personal directory required');
  const gated=hasSessionMemory(access);
  const initial=gated?null:await acquireMemory(directory);
  let dsh;
  const textRequest=(name,args)=>dsh?.vectors&&name==='mcp__basic_memory__search_notes'?{...args,search_type:'text'}:args;
  // Keep the core's tool view stable while resolving the live scope connection
  // for every call. A restarted backend must not leave the core holding a dead client.
  const tools=Object.create(initial?.tools??null);
  tools.get=(name,agent)=>{
    const available=initial?initial.tools.get(name,agent):(/^mcp__basic_memory__(search_notes|read_note|write_note|list_directory|edit_note|move_note)$/.test(name)?{name}:undefined);
    if(!available)return available;
    return {...available,async execute(args,exec){
      const owner=exec?.agent??agent;
      if(gated)access.assertCurrent(owner);
      const current=await acquireMemory(directory);
      if(gated)access.assertCurrent(owner);
      const definition=current.tools.get(name,owner);
      if(!definition)throw Error(`Memory tool unavailable after reconnect: ${name}`);
      const result=await definition.execute(textRequest(name,args),exec);
      if(gated)access.assertCurrent(owner);
      return result;
    }};
  };
  // A management route has its own authenticated capability. It can prepare
  // the selected library without silently enabling any conversation grant.
  tools.forManagement=check=>({get(name,agent){
    if(!/^mcp__basic_memory__(search_notes|read_note|write_note|list_directory|edit_note|move_note)$/.test(name))return undefined;
    return {name,async execute(args,exec={}){
      check();const current=await acquireMemory(directory);check();
      const definition=current.tools.get(name,agent);if(!definition)throw Error('Management memory tool unavailable');
      const value=await definition.execute(textRequest(name,args),{...exec,memoryAuthorization:()=>{try{check();return true;}catch{return false;}}});check();return value;
    }};
  }});
  const memory={...initial,tools};
  const resolved=resolveConfig({...config,project:'main',vaultPath:path.join(directory,'vault')});
  const recentStore=(gated?createLazyRecentConversationStore:createRecentConversationStore)({config:resolved,logger,qqBinding:recentBinding});
  const recoveryStore=createRecoveryStore(resolved);
  // Platforms opt in with their own scope and can revoke it without stopping DSH.
  let platformGate=null;const maintenanceAllowed=(id,item)=>typeof id==='string'&&(/^session-[a-zA-Z0-9_-]+$/.test(id)||Boolean(platformGate?.(id,item)));
  dsh=createBridge({config:resolved,tools:memory.tools,llm,logger,recentStore,recoveryStore,captureSubject,findAgent,listAgents,semanticOrganizer,pipelineResources,pipelineCommitted,access,ownerSubject,resolveChatConnection,maintenanceOwnerAllowed:maintenanceAllowed});
  return {directory,config:resolved,memory,recentStore,recoveryStore,dsh,maintenanceAllowed,registerPlatformMaintenance(gate){if(platformGate||typeof gate!=='function')throw Error('Platform maintenance is already registered or invalid');platformGate=gate;let held=true;return()=>{if(held){held=false;if(platformGate===gate)platformGate=null;}};},close:()=>dsh.dispose()};
}

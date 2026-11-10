import path from 'node:path';
import {createBridge,createLazyRecentConversationStore} from './index.js';
import {hasSessionMemory} from './worker.js';
import {createRecentConversationStore} from './recent-context.js';
import {createRecoveryStore} from './recovery.js';
import {resolveConfig} from './config.js';

/** Own the personal memory stores independently of any platform. Notes live in the
 * vault and are read and written directly; there is no backend process to connect to. */
export async function createPersonalMemoryRuntime({directory,config,llm,logger,findAgent,listAgents,semanticOrganizer,pipelineResources,pipelineCommitted,access,ownerSubject,resolveChatConnection}) {
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Explicit personal directory required');
  const gated=hasSessionMemory(access);
  let dsh;
  // No MCP note tools remain; the core reads and writes the Vault layer directly.
  const tools={get(){return undefined;}};
  const memory={tools};
  const resolved=resolveConfig({...config,project:'main',vaultPath:path.join(directory,'vault')});
  const recentStore=(gated?createLazyRecentConversationStore:createRecentConversationStore)({config:resolved,logger});
  const recoveryStore=createRecoveryStore(resolved);
  // Platforms opt in with their own scope and can revoke it without stopping DSH.
  let platformGate=null;const maintenanceAllowed=(id,item)=>typeof id==='string'&&(/^session-[a-zA-Z0-9_-]+$/.test(id)||Boolean(platformGate?.(id,item)));
  dsh=createBridge({config:resolved,tools:memory.tools,llm,logger,recentStore,recoveryStore,findAgent,listAgents,semanticOrganizer,pipelineResources,pipelineCommitted,access,ownerSubject,resolveChatConnection,maintenanceOwnerAllowed:maintenanceAllowed});
  return {directory,config:resolved,memory,recentStore,recoveryStore,dsh,maintenanceAllowed,registerPlatformMaintenance(gate){if(platformGate||typeof gate!=='function')throw Error('Platform maintenance is already registered or invalid');platformGate=gate;let held=true;return()=>{if(held){held=false;if(platformGate===gate)platformGate=null;}};},close:()=>dsh.dispose()};
}

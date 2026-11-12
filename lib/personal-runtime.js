import path from 'node:path';
import {createBridge} from './index.js';
import {hasSessionMemory} from './worker.js';
import {createRecoveryStore} from './recovery.js';
import {resolveConfig} from './config.js';

/** Own the personal memory stores independently of any platform. Notes live in the
 * vault and are read and written directly; there is no backend process to connect to. */
export async function createPersonalMemoryRuntime({directory,config,llm,logger,findAgent,listAgents,semanticOrganizer,pipelineResources,pipelineCommitted,access,ownerSubject,resolveChatConnection}) {
  if(typeof directory!=='string'||!path.isAbsolute(directory))throw Error('Explicit personal directory required');
  if(!hasSessionMemory(access)||typeof access.admitMessage!=='function')throw Error('对话记忆授权未接入');
  let dsh;
  // No MCP note tools remain; the core reads and writes the Vault layer directly.
  const tools={get(){return undefined;}};
  const memory={tools};
  const resolved=resolveConfig({...config,project:'main',vaultPath:path.join(directory,'vault')});
  const recoveryStore=createRecoveryStore(resolved);
  dsh=createBridge({config:resolved,tools:memory.tools,llm,logger,recoveryStore,findAgent,listAgents,semanticOrganizer,pipelineResources,pipelineCommitted,access,ownerSubject,resolveChatConnection});
  return {directory,config:resolved,memory,recoveryStore,dsh,close:()=>dsh.dispose()};
}

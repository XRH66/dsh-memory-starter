import {memoryError,requiredText,sourceIdentity} from './storage/contract.js';

// Shared by the message recorder, structured notes, handoff and query adapters.
// Existing legacy character budgets remain in their old contract until each
// consumer is migrated; they must not silently be interpreted as token limits.
export const MEMORY_ENTRY_TYPES=Object.freeze(['fact','event','preference','habit','recent_state','goal','plan','todo','commitment','relationship','belief','reflection']);
export const MEMORY_VALIDITY=Object.freeze(['current','historical','disputed','unverified']);
export const MEMORY_PROGRESS=Object.freeze(['planned','in_progress','completed','cancelled','unknown']);
export const MEMORY_IMPORTANCE_LEVELS=Object.freeze(['high','normal','low','unknown']);
export const MEMORY_IMPORTANCE_BASES=Object.freeze(['user_explicit','contextual','unassessed']);
export const MEMORY_CHANGE_KINDS=Object.freeze(['remember','correction','decision']);
export const MEMORY_PIPELINE_DEFAULTS=Object.freeze({batchTokens:4096,batchTurns:8,idleMs:90_000,maxWaitMs:300_000,referenceTokens:2048,semanticConcurrency:1});
export const MEMORY_QUERY_DEFAULTS=Object.freeze({calls:4,records:10,searchTokens:1024,openTokens:2048,totalTokens:4096,waitMs:2000});
export const MEMORY_HANDOFF_DEFAULTS=Object.freeze({tokens:4096,presets:Object.freeze([4096,8192]),maxTokens:16384});
export const MEMORY_HANDOFF_SOURCE='memory-handoff-context';

export function normalizeHandoffTokens(value=MEMORY_HANDOFF_DEFAULTS.tokens){
  if(!Number.isSafeInteger(value)||value<1||value>MEMORY_HANDOFF_DEFAULTS.maxTokens)throw memoryError('INVALID_HANDOFF_BUDGET','接续长度须为 1–16384 tokens 的整数');
  return value;
}

function revision(value){
  if(Number.isSafeInteger(value)&&value>0)return value;
  if(typeof value==='string')return requiredText(value,'来源版本');
  throw memoryError('INVALID_SOURCE_REVISION','需要持久来源版本');
}

/**
 * A post-commit notification, not an authorization credential or a second copy
 * of the original. Consumers resolve this exact id/revision through the owning
 * source service and validate their own grant before reading or committing.
 */
export function createSourceNotice(input){
  if(!input||!['message','document'].includes(input.kind)||!['saved','updated','withdrawn'].includes(input.operation))throw memoryError('INVALID_SOURCE_NOTICE','来源通知无效');
  const result={kind:input.kind,operation:input.operation,
    ownerSubject:requiredText(input.ownerSubject,'主体'),project:requiredText(input.project,'项目'),
    revision:revision(input.revision),platform:''};
  if(input.kind==='message'){
    result.sessionId=requiredText(input.sessionId,'会话');result.messageId=requiredText(input.messageId,'消息');
    if(!['user','assistant'].includes(input.role))throw memoryError('INVALID_SOURCE_ROLE','仅采集真实用户或助手消息');
    result.role=input.role;result.id=sourceIdentity(result);
    if(input.id!==undefined&&input.id!==result.id)throw memoryError('SOURCE_ID_MISMATCH','来源身份不一致');
  }else result.id=requiredText(input.id,'资料身份',2000);
  if(input.position!==undefined){
    if(!Number.isSafeInteger(input.position)||input.position<0)throw memoryError('INVALID_SOURCE_POSITION','来源游标无效');
    result.position=input.position;
  }
  return Object.freeze(result);
}

import {estimateRecentTokens} from './recent-context.js';
import {MEMORY_PIPELINE_DEFAULTS} from './memory-contract.js';

export const pipelineKey=ref=>JSON.stringify([ref.ownerSubject,ref.project,ref.id,ref.revision]);
export const pipelineGroup=job=>JSON.stringify([job.ownerSubject,job.project,job.sessionId,job.rootSessionId,job.epoch,job.target?.provider,job.target?.model,job.topic]);

/** Trigger thresholds count whole completed native turns, not both speakers.
 * An important unfinished turn cannot move work in front of its own answer. */
export function memoryBatchDue(jobs,settings=MEMORY_PIPELINE_DEFAULTS){
  if(!jobs.length)return Infinity;
  const turns=new Set(jobs.filter(job=>job.turnState==='completed').map(job=>job.turn));
  if(jobs.some(job=>job.continuation||(job.turnState==='completed'&&(job.important||job.boundary)))||turns.size>=settings.batchTurns||jobs.reduce((sum,job)=>sum+job.tokens,0)>=settings.batchTokens)return 0;
  return Math.min(Math.min(...jobs.map(job=>job.createdAt))+settings.maxWaitMs,Math.max(...jobs.map(job=>job.updatedAt))+settings.idleMs);
}

/** UTF-16 offsets into the unchanged original. A large message is continued,
 * never shortened in storage or quarantined solely for exceeding the batch. */
function endWithin(text,start,tokens){
  let end=start,used=0,boundary=start;
  for(const point of text.slice(start)){
    const cost=/\p{Script=Han}/u.test(point)?.6:point.codePointAt(0)<128?.3:1;
    if(used+cost>tokens)break;
    used+=cost;end+=point.length;
    if(/[\n。！？；.!?;]/u.test(point)&&used>=tokens/2)boundary=end;
  }
  return end<text.length&&boundary>start?boundary:end;
}
export function packMemoryBatch(jobs,read,settings=MEMORY_PIPELINE_DEFAULTS){
  const fragments=[];let remaining=settings.batchTokens;
  for(const job of jobs){
    if(remaining<1)break;
    const source=read(job),start=job.offset??0,end=endWithin(source.text,start,remaining);
    if(end<=start)continue;
    const tokens=estimateRecentTokens(source.text.slice(start,end));
    fragments.push({key:pipelineKey(job),id:job.id,revision:job.revision,start,end,total:source.text.length,tokens});remaining-=tokens;
    if(end<source.text.length)break;
  }
  return {fragments,tokens:settings.batchTokens-remaining};
}

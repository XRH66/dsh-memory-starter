// Memory map data: fingerprint, disk cache and one background layout build at a time.
// The heavy part (vectors, layout, clusters, keywords) runs in worker.js.
import path from 'node:path';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {Worker} from 'node:worker_threads';
import {gzipSync} from 'node:zlib';
import {readLayoutMembers} from '../storage/vector-index.js';
import {writeFileAtomic} from '../atomic-file.js';
import {LAYOUT_ALGORITHM_VERSION,seedFrom} from './layout.js';

export const MAP_FORMAT='dsh-memory-map',MAP_VERSION=1,MAP_MAX_ITEMS=10000;
const CACHE_NAME='map-v1.json';
const round=(value,digits=2)=>{const k=10**digits;return Math.round(value*k)/k;};
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');

function defaultRunner(input,onProgress){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./worker.js',import.meta.url),{workerData:input,resourceLimits:{maxOldGenerationSizeMb:1024}});
    let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;worker.terminate().catch(()=>{});fn(value);};
    worker.on('message',message=>{
      if(message?.type==='progress')onProgress?.(message);
      else if(message?.type==='done')finish(resolve,message);
      else if(message?.type==='error')finish(reject,Object.assign(Error(message.message),{code:message.code}));
    });
    worker.on('error',error=>finish(reject,error));
    worker.on('exit',code=>finish(reject,Object.assign(Error('布局线程意外退出（'+code+'）'),{code:'MEMORY_MAP_WORKER_EXIT'})));
  });
}

/**
 * access: {source(check), describe(ids,check)} from the memory runtime.
 * source → {state:'ready',layout:{indexFile,scope,snapshotId,profileId,modelKey,dimensions,indexIdentity}} | {state:'no-vectors'|'no-index'|...}
 * describe → [{kind,time,sessionId,text}|null] aligned with ids.
 */
export function createMemoryMapService({directory,access,logger,maxItems=MAP_MAX_ITEMS,now=Date.now,runLayout=defaultRunner,readMembers=readLayoutMembers}){
  if(!path.isAbsolute(directory??''))throw TypeError('Memory map directory required');
  const cacheFile=path.join(directory,'memory-map',CACHE_NAME);
  let memory=null,build=null,lastError=null,diskChecked=false;

  async function readCache(){
    try{
      const value=JSON.parse(await fs.readFile(cacheFile,'utf8'));
      if(value?.data?.format!==MAP_FORMAT||value.data.version!==MAP_VERSION||value.algorithm!==LAYOUT_ALGORITHM_VERSION)return null;
      return value;
    }catch{return null;}
  }
  function remember(entry){
    const body=Buffer.from(JSON.stringify(entry.data));
    memory={...entry,fingerprint:entry.data.fingerprint,body,gzip:gzipSync(body)};
    return memory;
  }
  async function current(check){
    const source=await access.source(check);
    if(source?.state!=='ready')return {state:source?.state??'unavailable'};
    const {members,indexIdentity}=readMembers({file:source.layout.indexFile,scope:source.layout.scope,snapshotId:source.layout.snapshotId});
    const fingerprint=sha([MAP_VERSION,LAYOUT_ALGORITHM_VERSION,maxItems,indexIdentity,members.map(m=>m.id+'@'+m.version)]).slice(0,32);
    return {state:'ready',layout:source.layout,members,fingerprint};
  }
  async function compute(target,check,fresh){
    const ids=target.members.map(m=>m.id);
    const described=await access.describe(ids,check);
    let rows=ids.map((id,i)=>({id,meta:described[i]})).filter(row=>row.meta);
    rows.sort((a,b)=>(a.meta.time??Infinity)-(b.meta.time??Infinity)||(a.id<b.id?-1:a.id>b.id?1:0));
    const truncated=rows.length>maxItems;
    if(truncated)rows=rows.slice(rows.length-maxItems);
    const previous=fresh?null:memory??(await readCache());
    const started=now();
    const output=await runLayout({file:target.layout.indexFile,scope:target.layout.scope,snapshotId:target.layout.snapshotId,
      ids:rows.map(row=>row.id),texts:rows.map(row=>row.meta.text??''),seed:seedFrom(target.fingerprint),
      previous:previous?{raw3:previous.raw3,raw2:previous.raw2}:null},progress=>{if(build)build.progress={stage:progress.stage,done:progress.done,total:progress.total};});
    check?.();
    const kept=output.keep.map(i=>rows[i]),result=output.result,n=kept.length;
    const sessionIds=[...new Set(kept.map(row=>row.meta.sessionId).filter(Boolean))];
    const sessionStats=new Map(sessionIds.map(id=>[id,{first:null,last:null,count:0}]));
    for(const row of kept){
      const stat=sessionStats.get(row.meta.sessionId);if(!stat)continue;
      stat.count++;const t=row.meta.time;
      if(Number.isFinite(t)){stat.first=stat.first===null?t:Math.min(stat.first,t);stat.last=stat.last===null?t:Math.max(stat.last,t);}
    }
    sessionIds.sort((a,b)=>(sessionStats.get(a).first??Infinity)-(sessionStats.get(b).first??Infinity)||(a<b?-1:1));
    const sessionIndex=new Map(sessionIds.map((id,i)=>[id,i]));
    const centers=Array.from({length:result.clusters},()=>[0,0,0,0]);
    const items=kept.map((row,i)=>{
      const c=result.labels[i],center=centers[c];
      for(let q=0;q<3;q++)center[q]+=result.pos[i*3+q];center[3]++;
      return {id:row.id,kind:['user','assistant'].includes(row.meta.kind)?row.meta.kind:'note',time:Number.isFinite(row.meta.time)?row.meta.time:null,
        session:sessionIndex.get(row.meta.sessionId)??null,cluster:c,depth:round(result.depth[i],3),
        pos:[round(result.pos[i*3]),round(result.pos[i*3+1]),round(result.pos[i*3+2])],pos2:[round(result.pos2[i*2]),round(result.pos2[i*2+1])],
        near:result.near[i]};
    });
    const data={format:MAP_FORMAT,version:MAP_VERSION,generatedAt:now(),fingerprint:target.fingerprint,
      model:{profileId:target.layout.profileId??null,modelKey:target.layout.modelKey??null,dimensions:output.dimensions},
      stats:{items:n,sessions:sessionIds.length,clusters:result.clusters,truncated,buildMs:Math.max(0,now()-started),incremental:result.incremental},
      items,sessions:sessionIds.map(id=>sessionStats.get(id)),
      clusters:centers.map((center,c)=>({size:center[3],keywords:result.keywords[c]??[],
        center:center[3]?[round(center[0]/center[3]),round(center[1]/center[3]),round(center[2]/center[3])]:[0,0,0]}))};
    const raw3=kept.map((row,i)=>[row.id,Array.from(result.raw3.subarray(i*3,i*3+3),v=>round(v,4))]);
    const raw2=kept.map((row,i)=>[row.id,Array.from(result.raw2.subarray(i*2,i*2+2),v=>round(v,4))]);
    const entry={algorithm:LAYOUT_ALGORITHM_VERSION,data,raw3,raw2};
    await fs.mkdir(path.dirname(cacheFile),{recursive:true});
    await writeFileAtomic(cacheFile,JSON.stringify(entry));
    return remember(entry);
  }
  function start(target,check,fresh=false){
    if(build)return build; // one build at a time; the next request picks up later changes
    lastError=null;
    const task={fingerprint:target.fingerprint,progress:{stage:'prepare',done:0,total:1},startedAt:now()};
    task.promise=compute(target,check,fresh).catch(error=>{
      lastError={code:error?.code??'MEMORY_MAP_FAILED',message:String(error?.message??error).slice(0,200),fingerprint:target.fingerprint};
      logger?.warn?.('[memory-map] '+lastError.code);
      throw error;
    }).finally(()=>{if(build===task)build=null;});
    task.promise.catch(()=>{});
    build=task;return task;
  }
  async function loadDisk(){
    if(memory||diskChecked)return;
    diskChecked=true;const cached=await readCache();if(cached)remember(cached);
  }
  return {
    /** wait: how long to wait for a fresh build before answering with stale data or progress. */
    async data(check,{wait=1500,rebuild=false}={}){
      await loadDisk();
      const target=await current(check);
      if(target.state!=='ready')return {state:target.state};
      if(!rebuild&&memory?.fingerprint===target.fingerprint)return {state:'ready',entry:memory};
      if(lastError?.fingerprint===target.fingerprint&&!rebuild&&!build)return {state:'failed',error:lastError,entry:memory};
      if(rebuild&&memory?.fingerprint===target.fingerprint&&!build)memory={...memory,fingerprint:null};
      const task=start(target,check,rebuild);
      await Promise.race([task.promise.catch(()=>{}),new Promise(resolve=>setTimeout(resolve,wait).unref?.())]);
      if(memory?.fingerprint===target.fingerprint)return {state:'ready',entry:memory};
      if(lastError?.fingerprint===target.fingerprint&&!build)return {state:'failed',error:lastError,entry:memory};
      return {state:'building',progress:build?.progress??null,entry:memory};
    },
    status(){return {building:Boolean(build),progress:build?.progress??null,fingerprint:memory?.fingerprint??null,error:lastError};},
    async idle(){await build?.promise.catch(()=>{});},
  };
}

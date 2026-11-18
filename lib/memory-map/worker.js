// Memory map layout worker. Reads the vector index read-only and computes the
// layout off the DSH main thread. Input and output go through postMessage only.
import {parentPort,workerData} from 'node:worker_threads';
import {readLayoutVectors} from '../storage/vector-index.js';
import {buildLayout} from './layout.js';

const {file,scope,snapshotId,ids,texts,previous,seed}=workerData;
let lastStage='',lastAt=0;
const progress=(stage,done,total)=>{
  const now=Date.now();
  if(stage===lastStage&&now-lastAt<250)return;
  lastStage=stage;lastAt=now;parentPort.postMessage({type:'progress',stage,done,total});
};
try{
  progress('vectors',0,ids.length);
  const {dimensions,vectors,found}=readLayoutVectors({file,scope,snapshotId,ids});
  const keep=[];for(let i=0;i<ids.length;i++)if(found[i])keep.push(i);
  const compact=new Float32Array(keep.length*dimensions);
  keep.forEach((i,k)=>compact.set(vectors.subarray(i*dimensions,(i+1)*dimensions),k*dimensions));
  const keptIds=keep.map(i=>ids[i]);
  const toMap=rows=>Array.isArray(rows)?new Map(rows):null;
  const result=buildLayout({ids:keptIds,vectors:compact,dimensions,texts:keep.map(i=>texts[i]),seed,progress,
    previous:previous?{raw3:toMap(previous.raw3),raw2:toMap(previous.raw2)}:null});
  parentPort.postMessage({type:'done',keep,dimensions,result},
    [result.pos.buffer,result.pos2.buffer,result.raw3.buffer,result.raw2.buffer,result.depth.buffer,result.labels.buffer]);
}catch(error){
  parentPort.postMessage({type:'error',code:error?.code??'MEMORY_MAP_LAYOUT_FAILED',message:String(error?.message??error).slice(0,300)});
}

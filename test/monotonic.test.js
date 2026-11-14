import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createStopwatch,searchFinalizationReserveMs} from '../lib/monotonic.js';
import {requestEmbeddingService} from '../lib/raw-rag/embedding-http.js';
import {requestRerank} from '../lib/raw-rag/rerank-http.js';

test('stopwatch ignores backward wall-clock jumps and reserves finalization time',()=>{
  let now=10;const elapsed=createStopwatch(()=>now);
  now=25;assert.equal(elapsed(),15);
  now=5;assert.equal(elapsed(),0);
  assert.equal(searchFinalizationReserveMs(1300),300);
  assert.equal(searchFinalizationReserveMs(4000),400);
});

test('service receipts measure real time even when the wall clock is frozen',async()=>{
  const original=Date.now;
  Date.now=()=>1000;
  try{
    const embeddingUsage=[];
    await requestEmbeddingService({baseUrl:'http://127.0.0.1:9/v1',model:'fictional',texts:['虚构'],dimensions:2,
      onUsage:receipt=>embeddingUsage.push(receipt),fetchImpl:async()=>{
        await delay(15);
        return {ok:true,status:200,headers:{get:()=>null},json:async()=>({data:[{index:0,embedding:[1,0]}]})};
      }});
    assert.equal(embeddingUsage.length,1);assert.ok(embeddingUsage[0].durationMs>=10);

    const rerankUsage=[];
    await requestRerank({baseUrl:'http://127.0.0.1:9/v1',model:'fictional',query:'虚构',documents:['甲','乙'],
      onUsage:receipt=>rerankUsage.push(receipt),fetchImpl:async()=>{
        await delay(15);
        return {ok:true,status:200,headers:{get:()=>null},json:async()=>({results:[{index:1,relevance_score:.8}]})};
      }});
    assert.equal(rerankUsage.length,1);assert.ok(rerankUsage[0].durationMs>=10);
  }finally{Date.now=original;}
});

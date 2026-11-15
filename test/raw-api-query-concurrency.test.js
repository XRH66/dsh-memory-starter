import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {resolveConfig} from '../lib/config.js';
import {EmbeddingBackend} from '../lib/raw-rag/backend.js';

const KEY='FICTIONAL_RAW_API_QUERY_KEY';

function cloudBackend(t) {
  process.env[KEY]='public-fictional-key';
  const config=resolveConfig({rawRecallModel:'text-embedding-v4',rawRecallDimensions:64,
    rawRecallApiBase:'https://fictional-embedding.invalid/v1',rawRecallApiKeyEnv:KEY,
    rawRecallAllowCloud:true,rawRecallIdleMs:10});
  const backend=new EmbeddingBackend({config});
  t.after(async()=>{
    delete process.env[KEY];
    await backend.dispose();
  });
  return backend;
}

function response(body,signal) {
  const inputs=JSON.parse(body).input;
  return delay(200,undefined,{signal}).then(()=>({
    ok:true,
    status:200,
    headers:new Headers({'x-request-id':'fictional-request'}),
    async json(){
      return {
        id:'fictional-response',
        usage:{total_tokens:inputs.length},
        data:inputs.map((_,index)=>({index,embedding:Array.from({length:64},(_,offset)=>offset===0?1:0)})),
      };
    },
  }));
}

test('cloud queries run four at a time, queue the fifth, and report live status',async t=>{
  const backend=cloudBackend(t);
  let active=0,peak=0,startedFour;
  const four=new Promise(resolve=>{startedFour=resolve;});
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    active++;
    peak=Math.max(peak,active);
    if(active===4)startedFour();
    try{return await response(options.body,options.signal);}
    finally{active--;}
  });
  const states=Array.from({length:5},()=>[]);
  const first=Array.from({length:4},(_,index)=>backend.embed([`query-${index}`],{
    kind:'query',timeoutMs:2000,onJobState:state=>states[index].push(state),
  }));
  await four;
  assert.equal(backend.status().active,true);
  assert.equal(backend.status().activeQueries,4);
  assert.equal(backend.status().queuedQueries,0);
  await delay(35);
  assert.equal(backend.status().prepared,true);

  const started=performance.now();
  const fifth=backend.embed(['query-fifth'],{kind:'query',timeoutMs:2000,
    onJobState:state=>states[4].push(state)});
  assert.equal(backend.status().activeQueries,4);
  assert.equal(backend.status().queuedQueries,1);
  assert.equal(backend.status().queued,1);
  assert.deepEqual(states[4],['pending']);

  const vectors=await Promise.all(first);
  assert.ok(performance.now()-started<500);
  assert.ok(vectors.every(vector=>vector[0].length===64));
  assert.equal((await fifth)[0].length,64);
  assert.equal(peak,4);
  assert.ok(states.every(history=>history.join(',')==='pending,dispatched'));
  assert.deepEqual(backend.status().observedKinds,['query']);
  assert.equal(backend.status().active,false);
  assert.equal(backend.status().activeQueries,0);
  assert.equal(backend.status().queuedQueries,0);
});

test('a running cloud document job never blocks a query',async t=>{
  const backend=cloudBackend(t),documentStarted=new Promise(resolve=>{
    t.mock.method(globalThis,'fetch',async(_url,options)=>{
      const input=JSON.parse(options.body).input;
      if(input[0]==='held-document'){resolve();await delay(300,undefined,{signal:options.signal});}
      return response(options.body,options.signal);
    });
  });
  let documentSettled=false;
  const document=backend.embed(['held-document'],{kind:'document',timeoutMs:3000})
    .finally(()=>{documentSettled=true;});
  await documentStarted;
  const queryStarted=performance.now();
  const query=await backend.embed(['parallel-query'],{kind:'query',timeoutMs:2000});
  assert.equal(query[0].length,64);
  assert.ok(performance.now()-queryStarted<500);
  assert.equal(documentSettled,false);
  await document;
});

test('dispose cancels active and queued cloud queries without waiting for the network timeout',async t=>{
  const backend=cloudBackend(t);
  let active=0,startedFour;
  const entered=new Promise(resolve=>{startedFour=resolve;});
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    active++;
    if(active===4)startedFour();
    try{
      await delay(2000,undefined,{signal:options.signal});
      throw Error('unreachable');
    }finally{active--;}
  });
  const pending=Array.from({length:5},(_,index)=>
    backend.embed(['dispose-query-'+index],{kind:'query',timeoutMs:3000}));
  await entered;
  assert.equal(backend.status().activeQueries,4);
  assert.equal(backend.status().queuedQueries,1);
  const disposing=performance.now();
  await backend.dispose();
  const settled=await Promise.allSettled(pending);
  assert.ok(settled.every(result=>result.status==='rejected'&&result.reason?.code==='RAW_RECALL_CANCELLED'));
  assert.ok(performance.now()-disposing<500);
  assert.equal(backend.status().active,false);
  assert.equal(backend.status().activeQueries,0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {testConnection,describeConnectionFailure} from '../lib/connection-test.js';

const json=(payload,status=200)=>{
  const make=()=>({ok:status>=200&&status<300,status,headers:{get:()=>null},json:async()=>structuredClone(payload),clone:make});
  return make();
};
const vector=size=>Array.from({length:size},(_,index)=>index===0?1:0.01);

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-connection-test-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const keyFile=path.join(directory,'service.key'),rerankKey=path.join(directory,'rerank.key');
  await fs.writeFile(keyFile,'fictional-service-key');await fs.writeFile(rerankKey,'fictional-rerank-key');
  const cfg={embeddingServices:[{id:'service-a',name:'虚构甲',apiBase:'https://fictional-a.example/v1',apiModel:'fictional-embed',dimensions:8,apiKeyFile:keyFile}],
    memory:{memoryRerankSource:'direct',memoryRerankApiBase:'https://fictional-rerank.example/v1',memoryRerankApiKeyFile:rerankKey}};
  return {cfg};
}

test('a saved embedding service is tested with its own key and reports time and size without the key',async t=>{
  const {cfg}=await fixture(t);const seen=[];
  const result=await testConnection(cfg,{target:'embedding',serviceId:'service-a'},{fetchImpl:async(url,options)=>{
    seen.push({url,auth:options.headers.authorization,body:JSON.parse(options.body)});return json({data:[{index:0,embedding:vector(8)}]});}});
  assert.equal(result.ok,true);assert.equal(result.dimensions,8);assert.equal(result.host,'fictional-a.example');
  assert.ok(Number.isFinite(result.ms));
  assert.equal(seen[0].url,'https://fictional-a.example/v1/embeddings');assert.equal(seen[0].auth,'Bearer fictional-service-key');
  assert.deepEqual(seen[0].body.input,['连接测试']);
  assert.doesNotMatch(JSON.stringify(result),/fictional-service-key/);
});

test('a typed key replaces the saved one and a size mismatch names the size the service returned',async t=>{
  const {cfg}=await fixture(t);let auth;
  const result=await testConnection(cfg,{target:'embedding',serviceId:'service-a',apiKey:'fictional-typed-key'},{fetchImpl:async(_url,options)=>{
    auth=options.headers.authorization;return json({data:[{index:0,embedding:vector(4)}]});}});
  assert.equal(auth,'Bearer fictional-typed-key');
  assert.equal(result.ok,false);assert.equal(result.error.code,'dimensions');
  assert.equal(result.error.message,'返回 4 维，设置的是 8 维');assert.equal(result.error.hint,'把向量维数改成 4');
});

test('a new custom service form without a key is refused before any request',async t=>{
  const {cfg}=await fixture(t);let calls=0;
  const result=await testConnection(cfg,{target:'embedding',model:'custom-api',apiBase:'https://fictional-new.example/v1',apiModel:'fictional-embed',dimensions:8},
    {fetchImpl:async()=>{calls++;return json({});}});
  assert.equal(result.ok,false);assert.equal(result.error.code,'key-missing');assert.equal(calls,0);
});

test('HTTP and network failures become one plain reason with a next step',()=>{
  assert.equal(describeConnectionFailure(Error('x'),{httpStatus:401}).message,'API Key 无效或没有权限');
  assert.equal(describeConnectionFailure(Error('x'),{httpStatus:404}).code,'not-found');
  assert.equal(describeConnectionFailure(Error('x'),{httpStatus:429}).code,'rate');
  assert.equal(describeConnectionFailure(Error('x'),{httpStatus:503}).message,'服务商暂时出错（HTTP 503）');
  assert.equal(describeConnectionFailure(Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}})).code,'network');
  assert.equal(describeConnectionFailure(Error('x'),{timedOut:true}).message,'10 秒内没有响应');
  for(const status of [401,404,429,503])assert.ok(describeConnectionFailure(Error('x'),{httpStatus:status}).hint);
});

test('a service that never answers stops at the test timeout',async t=>{
  const {cfg}=await fixture(t);
  const result=await testConnection(cfg,{target:'embedding',serviceId:'service-a'},{timeoutMs:50,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});})});
  assert.equal(result.ok,false);assert.equal(result.error.code,'timeout');
});

test('direct rerank reuses its saved key only at the same address and loopback needs none',async t=>{
  const {cfg}=await fixture(t);const auths=[];
  const fetchImpl=async(url,options)=>{auths.push([url,options.headers.authorization]);return json({results:[{index:0,relevance_score:0.9},{index:1,relevance_score:0.1}]});};
  const saved=await testConnection(cfg,{target:'rerank',source:'direct',apiBase:'https://fictional-rerank.example/v1',model:'fixture/reranker'},{fetchImpl});
  assert.equal(saved.ok,true);assert.deepEqual(auths[0],['https://fictional-rerank.example/v1/rerank','Bearer fictional-rerank-key']);
  const moved=await testConnection(cfg,{target:'rerank',source:'direct',apiBase:'https://fictional-other.example/v1',model:'fixture/reranker'},{fetchImpl});
  assert.equal(moved.ok,false);assert.equal(moved.error.code,'key-missing');assert.equal(auths.length,1);
  const local=await testConnection(cfg,{target:'rerank',source:'direct',apiBase:'http://127.0.0.1:9/v1',model:'fixture/reranker'},{fetchImpl});
  assert.equal(local.ok,true);assert.equal(auths[1][1],undefined);
});

test('rerank through a saved service uses that service key and rejects an empty answer',async t=>{
  const {cfg}=await fixture(t);let auth;
  const result=await testConnection(cfg,{target:'rerank',source:'service',serviceId:'service-a',model:'fixture/reranker'},
    {fetchImpl:async(_url,options)=>{auth=options.headers.authorization;return json({results:[]});}});
  assert.equal(auth,'Bearer fictional-service-key');
  assert.equal(result.ok,false);assert.equal(result.error.code,'invalid');
});

test('the settings route runs one test at a time and returns only the outcome',async t=>{
  const {createSettingsHandler}=await import('../lib/settings-host.js');
  const {Readable}=await import('node:stream');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-connection-route-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'deployment.json');
  await fs.writeFile(file,JSON.stringify({ownerDirectory:directory,memory:{}}));
  const handler=createSettingsHandler({},file);t.after(()=>handler.dispose?.());
  const send=async input=>{
    const req=Readable.from([Buffer.from(JSON.stringify(input))]);
    Object.assign(req,{method:'POST',url:'/api/basic-memory-settings/test',socket:{remoteAddress:'127.0.0.1'},
      headers:{host:'127.0.0.1:15680','content-type':'application/json','x-basic-memory-settings':'1'}});
    const res={headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=JSON.parse(value);}};
    await handler(req,res);return res;
  };
  const res=await send({target:'embedding',model:'custom-api',apiBase:'https://fictional-new.example/v1',apiModel:'fictional-embed',dimensions:8});
  assert.equal(res.statusCode,200);assert.equal(res.body.ok,true);
  assert.equal(res.body.result.ok,false);assert.equal(res.body.result.error.code,'key-missing');
  const unknown=await send({target:'chat'});
  assert.equal(unknown.body.ok,false);
});

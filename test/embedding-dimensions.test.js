import test from 'node:test';
import assert from 'node:assert/strict';
import {rawModelSpec,modelContract} from '../lib/raw-rag/models.js';
import {requestEmbeddingService} from '../lib/raw-rag/embedding-http.js';
import {profileFromLegacy} from '../lib/unified/profiles.js';
import {resolveConfig} from '../lib/config.js';

const custom={rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-dim.example/v1',rawRecallApiModel:'fictional-embed',rawRecallDimensions:0};

test('a custom service is asked for a size only when the option is on; vendor presets always are',()=>{
  assert.equal(rawModelSpec(custom).sendDimensions,false);
  assert.equal(rawModelSpec(custom).dimensions,1024);
  assert.equal(rawModelSpec({...custom,rawRecallApiSendDimensions:true}).sendDimensions,true);
  assert.equal(rawModelSpec({rawRecallModel:'text-embedding-v4'}).sendDimensions,true);
  assert.equal(resolveConfig({}).rawRecallApiSendDimensions,false);
  assert.equal(resolveConfig({rawRecallApiSendDimensions:'true'}).rawRecallApiSendDimensions,false);
});

test('the option does not change the index identity of an existing service',()=>{
  const before=modelContract(rawModelSpec(custom),custom);
  const on={...custom,rawRecallApiSendDimensions:true};
  assert.deepEqual(modelContract(rawModelSpec(on),on),before);
  assert.deepEqual(modelContract(rawModelSpec({...custom,rawRecallDimensions:1024}),custom),before);
});

test('profiles accept the option as a boolean and keep it in the backend config',()=>{
  const profile=profileFromLegacy({id:'custom-api',settings:{...custom,rawRecallAllowCloud:true,rawRecallApiSendDimensions:true}});
  assert.equal(profile.backend.config.rawRecallApiSendDimensions,true);
  assert.equal(profile.dimensions,1024);
  assert.throws(()=>profileFromLegacy({id:'custom-api',settings:{...custom,rawRecallAllowCloud:true,rawRecallApiSendDimensions:'yes'}}),/boolean/);
});

test('the request body carries dimensions only when asked',async()=>{
  const bodies=[];
  const fetchImpl=async(url,init)=>{bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({data:[{index:0,embedding:Array(4).fill(0.5)}],usage:{total_tokens:3}}),{status:200,headers:{'content-type':'application/json'}});};
  for(const sendDimensions of [false,true])
    await requestEmbeddingService({baseUrl:'https://fictional-dim.example/v1/embeddings',model:'fictional-embed',texts:['甲'],dimensions:4,sendDimensions,apiKey:'fictional',fetchImpl});
  assert.equal('dimensions' in bodies[0],false);
  assert.equal(bodies[1].dimensions,4);
});

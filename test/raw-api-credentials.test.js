import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {normalizeRawModelSettings,publicRawModel} from '../lib/raw-rag/settings.js';
import {rawModelSpec,embeddingEndpoint} from '../lib/raw-rag/models.js';
import {CloudEmbeddingTransport} from '../lib/raw-rag/cloud-backend.js';
import {stageDeploymentRawModel,beginDeploymentConfiguration,deploymentFingerprint} from '../lib/deployment-config.js';

const A='https://service-a.example/tenant-one/v1',B='https://service-b.example/v1';
const cloud={rawRecallModel:'text-embedding-v4',rawRecallAllowCloud:true,rawRecallApiBase:A,rawRecallDimensions:64,rawRecallApiKeyEnv:'FICTIONAL_A_KEY'};
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'api-credential-binding-'));
  const keyFile=path.join(directory,'original.key');await fs.writeFile(keyFile,'fictional-key-A');
  const dshHome=path.join(directory,'dsh');await fs.mkdir(path.join(dshHome,'storages'),{recursive:true});
  await fs.writeFile(path.join(dshHome,'storages/workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{}}}));
  const cfg={ownerDirectory:directory,ownerSubject:'fictional-owner',dshHome,dshSessionIds:[],memory:{...cloud,rawRecallApiKeyFile:keyFile}};
  const file=path.join(directory,'deployment.json');await fs.writeFile(file,JSON.stringify(cfg));
  t.after(async()=>{assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  const read=async()=>JSON.parse(await fs.readFile(file,'utf8'));
  const stage=async input=>stageDeploymentRawModel(file,input,deploymentFingerprint(await read()));
  const apply=async input=>{const staged=path.join(directory,'apply.json');await fs.writeFile(staged,JSON.stringify(input));const runtime=await beginDeploymentConfiguration(staged);
    try{const receipt=JSON.parse(await fs.readFile(staged+'.runtime.json','utf8'));await runtime.ready();return {cfg:runtime.cfg,settingsError:receipt.settingsError};}finally{await runtime.close();}};
  return {directory,keyFile,cfg,file,read,stage,apply};
}

test('credentials stay with the normalized service; origin and tenant changes require a new choice',async t=>{
  const f=await fixture(t),base=f.cfg.memory;
  const same=normalizeRawModelSettings({rawRecallApiBase:A+'/embeddings/'},base);
  assert.equal(same.rawRecallApiKeyFile,f.keyFile);
  assert.equal(same.rawRecallApiKeyService,embeddingEndpoint(A));
  for(const rawRecallApiBase of [B,A.replace('tenant-one','tenant-two')])
    assert.throws(()=>normalizeRawModelSettings({rawRecallApiBase},base),/密钥|凭据/);
  assert.throws(()=>normalizeRawModelSettings({rawRecallApiBase:B,rawRecallApiKeyService:embeddingEndpoint(B)},base),/密钥|凭据/);
  const reused=normalizeRawModelSettings({rawRecallApiBase:B},base,{reuseApiKey:true});
  assert.equal(reused.rawRecallApiKeyFile,f.keyFile);assert.equal(reused.rawRecallApiKeyService,embeddingEndpoint(B));
  const env=normalizeRawModelSettings({rawRecallApiBase:B,rawRecallApiKeyEnv:'FICTIONAL_B_KEY'},base);
  assert.equal(env.rawRecallApiKeyFile,'');assert.equal(env.rawRecallApiKeyService,embeddingEndpoint(B));
  assert.equal(publicRawModel(env).fields.rawRecallApiKeyEnv,'FICTIONAL_B_KEY');
  const local=normalizeRawModelSettings({rawRecallModel:'light',rawRecallDimensions:0,rawRecallApiBase:B},base);
  assert.equal(local.rawRecallApiBase,A,'local selection cannot reassign a dormant API credential');
  assert.throws(()=>normalizeRawModelSettings({rawRecallModel:'text-embedding-v4',rawRecallDimensions:64,rawRecallAllowCloud:true,rawRecallApiBase:B},local),/密钥|凭据/);
});

test('staging a foreign service preserves active configuration, cancellation, and pending credentials',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.file);
  await assert.rejects(f.stage({settings:{rawRecallApiBase:B}}),/密钥|凭据/);
  assert.ok(before.equals(await fs.readFile(f.file)));
  const saved=await f.stage({settings:{rawRecallApiBase:B},apiKey:'fictional-key-B'});
  assert.equal(JSON.stringify(saved).includes('fictional-key-B'),false);
  const staged=await f.read();assert.deepEqual(staged.memory,f.cfg.memory);
  assert.notEqual(staged.pendingRawRecall.rawRecallApiKeyFile,f.keyFile);
  assert.equal(staged.pendingRawRecall.rawRecallApiKeyService,embeddingEndpoint(B));
  assert.equal(staged.pendingRawRecall.rawRecallApiKeyEnv,'');
  const applied=await f.apply(staged);assert.equal(applied.settingsError,null);
  assert.equal(applied.cfg.memory.rawRecallApiKeyFile,staged.pendingRawRecall.rawRecallApiKeyFile);
  assert.equal(applied.cfg.memory.rawRecallApiKeyService,embeddingEndpoint(B));
  assert.equal(await fs.readFile(f.keyFile,'utf8'),'fictional-key-A');
  await f.stage({cancel:true});assert.deepEqual((await f.read()).memory,f.cfg.memory);
  await assert.rejects(fs.access(staged.pendingRawRecall.rawRecallApiKeyFile),{code:'ENOENT'});
});

test('an explicit gateway reuse survives staging but an unbound old pending cross-service key does not',async t=>{
  const f=await fixture(t);
  await f.stage({settings:{rawRecallApiBase:B},reuseApiKey:true});
  const result=await f.apply(await f.read());assert.equal(result.settingsError,null);
  assert.equal(result.cfg.memory.rawRecallApiKeyFile,f.keyFile);
  const legacy={...f.cfg,pendingRawRecall:{...f.cfg.memory,rawRecallApiBase:B}};
  const rejected=await f.apply(legacy);assert.match(rejected.settingsError,/密钥|凭据/);
  assert.deepEqual(rejected.cfg.memory,f.cfg.memory);
});

test('restoring local history preserves the complete dormant service and credential pair through reload',async t=>{
  const f=await fixture(t),model=path.join(f.directory,'fixture.gguf'),server=path.join(f.directory,'fixture-server.exe');
  await fs.writeFile(model,'fixture weights; never executed');await fs.writeFile(server,'fixture executable; never executed');
  const historyKey=path.join(f.directory,'history.key');await fs.writeFile(historyKey,'fictional-key-B');
  for(const bound of [true,false]){
    const settings={...cloud,rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallDimensions:2560,rawRecallAllowCloud:false,
      rawRecallGgufModel:model,rawRecallLlamaServer:server,rawRecallApiBase:B,rawRecallApiKeyFile:historyKey,
      rawRecallApiKeyEnv:'',...(bound?{rawRecallApiKeyService:embeddingEndpoint(B)}:{})};
    await fs.writeFile(f.file,JSON.stringify({...f.cfg,rawModelHistory:[{id:'local-b',settings}]}));
    await f.stage({restoreId:'local-b'});
    const staged=await f.read(),applied=await f.apply(staged);
    assert.equal(applied.settingsError,null);
    const saved=applied.cfg.memory;
    assert.equal(saved.rawRecallApiBase,B);assert.equal(saved.rawRecallApiKeyFile,historyKey);
    assert.equal(saved.rawRecallApiKeyService,embeddingEndpoint(B));assert.equal(saved.rawRecallApiKeyEnv,'');
    assert.equal(saved.rawRecallAllowCloud,false);
    const cloudAgain=normalizeRawModelSettings({rawRecallModel:'text-embedding-v4',rawRecallAllowCloud:true,rawRecallDimensions:64},saved);
    assert.equal(cloudAgain.rawRecallApiBase,B);assert.equal(cloudAgain.rawRecallApiKeyFile,historyKey);
    assert.throws(()=>normalizeRawModelSettings({...cloudAgain,rawRecallApiBase:A},saved),/密钥|凭据/);
    assert.equal(await fs.readFile(f.keyFile,'utf8'),'fictional-key-A');
  }
});

test('restoring an environment-only cloud history does not retain the current file key',async t=>{
  const f=await fixture(t),before=process.env.FICTIONAL_B_KEY;process.env.FICTIONAL_B_KEY='fictional-env-B';
  t.after(()=>{if(before===undefined)delete process.env.FICTIONAL_B_KEY;else process.env.FICTIONAL_B_KEY=before;});
  const settings={...cloud,rawRecallApiBase:B,rawRecallApiKeyEnv:'FICTIONAL_B_KEY',rawRecallApiKeyService:embeddingEndpoint(B)};
  await fs.writeFile(f.file,JSON.stringify({...f.cfg,rawModelHistory:[{id:'cloud-b',settings}]}));
  await assert.rejects(f.stage({restoreId:'cloud-b'}),/明确选择/);
  await f.stage({restoreId:'cloud-b',allowCloud:true});
  const applied=await f.apply(await f.read());assert.equal(applied.settingsError,null);
  assert.equal(applied.cfg.memory.rawRecallApiKeyFile,'');assert.equal(applied.cfg.memory.rawRecallApiKeyEnv,'FICTIONAL_B_KEY');
  assert.equal(applied.cfg.memory.rawRecallApiKeyService,embeddingEndpoint(B));
});

test('a history with a mismatched credential binding cannot be staged as a fresh valid pair',async t=>{
  const f=await fixture(t),settings={...f.cfg.memory,rawRecallApiBase:B,rawRecallApiKeyService:embeddingEndpoint(A)};
  await fs.writeFile(f.file,JSON.stringify({...f.cfg,rawModelHistory:[{id:'mismatched',settings}]}));
  const before=await fs.readFile(f.file);
  await assert.rejects(f.stage({restoreId:'mismatched',allowCloud:true}),/密钥|凭据/);
  assert.ok(before.equals(await fs.readFile(f.file)));
});

test('failed validation or configuration publication never changes the old config or leaves the new key',async t=>{
  const f=await fixture(t),before=await fs.readFile(f.file);
  await assert.rejects(f.stage({settings:{rawRecallApiBase:'http://service-b.example/v1'},apiKey:'fictional-key-B'}));
  const rename=fs.rename;
  fs.rename=async function(from,to){if(to===f.file)throw Object.assign(Error('fixture publish failure'),{code:'EIO'});return rename.call(fs,from,to);};
  try{await assert.rejects(f.stage({settings:{rawRecallApiBase:B},apiKey:'fictional-key-B'}),/fixture publish failure/);}
  finally{fs.rename=rename;}
  assert.ok(before.equals(await fs.readFile(f.file)));
  assert.deepEqual(await fs.readdir(path.join(f.directory,'management/raw-recall/credentials')),[]);
  assert.equal(await fs.readFile(f.keyFile,'utf8'),'fictional-key-A');
});

test('real transport sends file and environment keys only to the selected simulated service',async t=>{
  const f=await fixture(t),requests=[];
  const server=http.createServer(async(req,res)=>{let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
    requests.push({path:req.url,key:req.headers.authorization});res.setHeader('content-type','application/json');
    res.end(JSON.stringify({data:body.input.map((_,index)=>({index,embedding:Array.from({length:64},(_,i)=>i===0?1:0)}))}));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const fetchOriginal=globalThis.fetch,oldEnv=process.env.FICTIONAL_B_KEY;process.env.FICTIONAL_B_KEY='fictional-env-B';
  globalThis.fetch=(url,options)=>{const target=new URL(url);assert.ok(['service-a.example','service-b.example'].includes(target.hostname));
    return fetchOriginal(`http://127.0.0.1:${server.address().port}/${target.hostname}`,options);};
  t.after(async()=>{globalThis.fetch=fetchOriginal;if(oldEnv===undefined)delete process.env.FICTIONAL_B_KEY;else process.env.FICTIONAL_B_KEY=oldEnv;await new Promise(resolve=>server.close(resolve));});
  const send=async config=>{const transport=new CloudEmbeddingTransport({config,spec:rawModelSpec(config)});try{await transport.prepare();await transport.embed(['fictional evidence'],{kind:'document',scope:'fixture'});}finally{transport.dispose();}};
  const first=normalizeRawModelSettings({},f.cfg.memory);await send(first);
  const env=normalizeRawModelSettings({rawRecallApiBase:B,rawRecallApiKeyEnv:'FICTIONAL_B_KEY'},first);await send(env);
  const reuse=normalizeRawModelSettings({rawRecallApiBase:B},first,{reuseApiKey:true});await send(reuse);
  await assert.rejects(send({...first,rawRecallApiBase:B}),/密钥|凭据/);
  assert.deepEqual(requests,[{path:'/service-a.example',key:'Bearer fictional-key-A'},{path:'/service-b.example',key:'Bearer fictional-env-B'},{path:'/service-b.example',key:'Bearer fictional-key-A'}]);
});

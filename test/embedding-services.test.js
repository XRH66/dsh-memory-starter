import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {
  deploymentFingerprint,
  deploymentStaticFingerprint,
  manageEmbeddingServices,
  readDeploymentSettings,
  stageDeploymentRawModel,
} from '../lib/deployment-config.js';
import {createSettingsHandler} from '../lib/settings-host.js';

const API='https://fictional-a.example/v1';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'embedding-services-')),dshHome=path.join(root,'dsh');
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  await fs.mkdir(path.join(dshHome,'storages'),{recursive:true});
  await fs.writeFile(path.join(dshHome,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{}}}));
  const file=path.join(root,'deployment.json');
  await fs.writeFile(file,JSON.stringify({ownerDirectory:root,ownerSubject:'fictional-owner',dshHome,dshSessionIds:[],memory:{rawRecall:false}}));
  const read=async()=>JSON.parse(await fs.readFile(file,'utf8'));
  const revision=async()=>deploymentFingerprint(await read());
  const manage=async input=>manageEmbeddingServices(file,input,await revision());
  const stage=async input=>stageDeploymentRawModel(file,input,await revision());
  const credentials=path.join(root,'management/raw-recall/credentials');
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,file,read,revision,manage,stage,credentials};
}

const serviceInput=(patch={})=>({action:'save',name:'收藏服务',apiBase:API,apiModel:'fictional-embed',dimensions:768,
  apiKey:'fictional-key-a',...patch});

test('embedding services can be created, edited and deleted without exposing secret references',async t=>{
  const f=await fixture(t);
  let value=await f.manage(serviceInput({name:''}));
  assert.equal(value.embeddingServices.length,1);
  const first=value.embeddingServices[0];
  assert.equal(first.name,'fictional-a.example · fictional-embed');
  assert.deepEqual(Object.keys(first).sort(),['apiBase','apiModel','dimensions','hasKey','id','inUse','name']);
  assert.equal(JSON.stringify(value).includes('apiKeyFile'),false);
  assert.equal(JSON.stringify(value).includes('apiKeyService'),false);
  const saved=(await f.read()).embeddingServices[0];
  assert.equal(await fs.readFile(saved.apiKeyFile,'utf8'),'fictional-key-a');
  assert.equal(saved.apiKeyService,'https://fictional-a.example/v1/embeddings');

  value=await f.manage({action:'save',id:first.id,name:'改名服务',apiBase:first.apiBase,apiModel:first.apiModel,dimensions:first.dimensions});
  assert.equal(value.embeddingServices[0].name,'改名服务');
  assert.equal((await f.read()).embeddingServices[0].apiKeyFile,saved.apiKeyFile);

  value=await f.manage({action:'delete',id:first.id});
  assert.deepEqual(value.embeddingServices,[]);
  await assert.rejects(fs.access(saved.apiKeyFile),{code:'ENOENT'});
});

test('embedding service validation keeps HTTPS, dimensions, model names and address-key pairing',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.manage(serviceInput({apiBase:'http://fictional-a.example/v1'})),/HTTPS/);
  await assert.rejects(f.manage(serviceInput({apiModel:''})),/模型名称/);
  await assert.rejects(f.manage(serviceInput({dimensions:0})),/维数/);
  await assert.rejects(f.manage(serviceInput({name:'x'.repeat(61)})),/60/);
  const created=(await f.manage(serviceInput())).embeddingServices[0];
  await assert.rejects(f.manage({action:'save',id:created.id,apiBase:'https://fictional-b.example/v1',apiModel:created.apiModel,
    dimensions:created.dimensions,name:created.name}),/服务地址已改变，请填写这个地址对应的 API Key/);
});

test('the service list is capped at twenty entries',async t=>{
  const f=await fixture(t),cfg=await f.read();
  cfg.embeddingServices=Array.from({length:20},(_,index)=>({id:'fixture-'+index,name:'服务 '+index,
    apiBase:'https://fictional-'+index+'.example/v1',apiModel:'fictional-'+index,dimensions:768,apiKeyFile:'',
    apiKeyService:'https://fictional-'+index+'.example/v1/embeddings',createdAt:'2026-11-10T00:00:00.000Z',updatedAt:'2026-11-10T00:00:00.000Z'}));
  await fs.writeFile(f.file,JSON.stringify(cfg));
  await assert.rejects(f.manage(serviceInput({apiBase:'https://fictional-overflow.example/v1'})),/20/);
});

test('an in-use service can only be renamed and cannot be deleted',async t=>{
  const f=await fixture(t),created=(await f.manage(serviceInput())).embeddingServices[0];
  const staged=await f.stage({serviceId:created.id,settings:{rawRecallModel:'custom-api',rawRecallAllowCloud:true,rawRecallApiKeyEnv:'FICTIONAL_DRAFT_KEY'}});
  assert.equal(staged.embeddingServices[0].inUse,true);
  const pending=(await f.read()).pendingRawRecall;
  assert.deepEqual([pending.rawRecallApiBase,pending.rawRecallApiModel,pending.rawRecallDimensions],
    ['https://fictional-a.example/v1','fictional-embed',768]);
  assert.equal(pending.rawRecallApiKeyFile,(await f.read()).embeddingServices[0].apiKeyFile);
  assert.equal(pending.rawRecallApiKeyEnv,'');

  await assert.rejects(f.manage({action:'save',id:created.id,name:'仍在用',apiBase:'https://fictional-b.example/v1',
    apiModel:created.apiModel,dimensions:created.dimensions,apiKey:'fictional-key-b'}),/正在使用；要更换地址、模型或密钥/);
  const renamed=await f.manage({action:'save',id:created.id,name:'仍在使用的新名字',apiBase:created.apiBase,
    apiModel:created.apiModel,dimensions:created.dimensions});
  assert.equal(renamed.embeddingServices[0].name,'仍在使用的新名字');
  await assert.rejects(f.manage({action:'delete',id:created.id}),/正在使用，不能删除/);

  await f.stage({cancel:true});
  assert.equal((await f.read()).embeddingServices.length,1);
  assert.equal(await fs.readFile((await f.read()).embeddingServices[0].apiKeyFile,'utf8'),'fictional-key-a');
});

test('replacing a service key deletes only the old unreferenced file',async t=>{
  const f=await fixture(t),created=(await f.manage(serviceInput())).embeddingServices[0],old= (await f.read()).embeddingServices[0].apiKeyFile;
  await f.manage({action:'save',id:created.id,name:created.name,apiBase:created.apiBase,apiModel:created.apiModel,
    dimensions:created.dimensions,apiKey:'fictional-key-b'});
  const current=(await f.read()).embeddingServices[0].apiKeyFile;
  assert.notEqual(current,old);
  assert.equal(await fs.readFile(current,'utf8'),'fictional-key-b');
  await assert.rejects(fs.access(old),{code:'ENOENT'});

  const second=await f.manage(serviceInput({apiBase:'https://fictional-b.example/v1',apiModel:'fictional-embed-b',apiKey:'fictional-key-c'}));
  let cfg=await f.read(),secondRow=cfg.embeddingServices.find(row=>row.id===second.embeddingServices[1].id),firstRow=cfg.embeddingServices.find(row=>row.id===created.id);
  secondRow.apiKeyFile=firstRow.apiKeyFile;
  secondRow.apiKeyService=firstRow.apiKeyService;
  await fs.writeFile(f.file,JSON.stringify(cfg));
  await f.manage({action:'save',id:created.id,name:created.name,apiBase:created.apiBase,apiModel:created.apiModel,
    dimensions:created.dimensions,apiKey:'fictional-key-d'});
  assert.equal(await fs.readFile(firstRow.apiKeyFile,'utf8'),'fictional-key-b');
});

test('staged model selection can use a service without another key and direct custom saves enter the list once',async t=>{
  const f=await fixture(t),created=(await f.manage(serviceInput())).embeddingServices[0];
  assert.equal(created.hasKey,true);
  const staged=await f.stage({serviceId:created.id,settings:{rawRecallApiModel:'ignored'}});
  assert.equal(staged.pendingRawModel.fields.rawRecallApiModel,'fictional-embed');
  assert.equal(staged.pendingRawModel.hasSavedApiKey,true);

  await f.stage({cancel:true});
  await f.stage({settings:{rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-direct.example/v1',
    rawRecallApiModel:'direct-model',rawRecallDimensions:1024,rawRecallAllowCloud:true},apiKey:'fictional-direct-key'});
  let cfg=await f.read();
  assert.equal(cfg.embeddingServices.length,2);
  const direct=cfg.embeddingServices.find(row=>row.apiModel==='direct-model');
  assert.ok(direct);assert.equal(await fs.readFile(direct.apiKeyFile,'utf8'),'fictional-direct-key');

  await f.stage({settings:{rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-direct.example/v1',
    rawRecallApiModel:'direct-model',rawRecallDimensions:1024,rawRecallAllowCloud:true},apiKey:'fictional-direct-key-2'});
  cfg=await f.read();
  assert.equal(cfg.embeddingServices.filter(row=>row.apiModel==='direct-model').length,1);
  const deduped=cfg.embeddingServices.find(row=>row.apiModel==='direct-model');
  assert.equal(await fs.readFile(deduped.apiKeyFile,'utf8'),'fictional-direct-key-2');
});

test('embedding service writes reject a stale deployment revision',async t=>{
  const f=await fixture(t),revision=await f.revision();
  const before=deploymentStaticFingerprint(await f.read());
  await f.manage(serviceInput());
  assert.equal(deploymentStaticFingerprint(await f.read()),before);
  await assert.rejects(manageEmbeddingServices(f.file,serviceInput({apiBase:'https://fictional-b.example/v1'}),revision),
    {code:'REVISION_CONFLICT'});
});

test('settings route saves a service without a restart and marks the new revision applied',async t=>{
  const f=await fixture(t);let afterSave=0,appliedRevision='';
  const handler=createSettingsHandler({},f.file,undefined,undefined,{afterSave:(cfg,revision)=>{afterSave++;appliedRevision=revision;}});
  t.after(()=>handler.dispose());
  const request=async(body,{header=true}={})=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{method:'POST',url:'/api/basic-memory-settings/embedding-services',socket:{remoteAddress:'127.0.0.1'},
      headers:{host:'127.0.0.1:15680','content-type':'application/json',...(header?{'x-basic-memory-settings':'1'}:{})}});
    const res={headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=JSON.parse(value);}};
    await handler(req,res);return res;
  };
  const revision=await f.revision(),body={...serviceInput(),revision};
  const saved=await request(body);
  assert.equal(saved.statusCode,200,JSON.stringify(saved.body));
  assert.equal(saved.body.embeddingServices.length,1);
  // The list never changes the running model: the saved revision is marked applied, so no reload is asked for.
  assert.equal(afterSave,1);assert.equal(appliedRevision,saved.body.revision);
  assert.equal((await request({...body,revision:(await f.revision())},{header:false})).statusCode,403);
});

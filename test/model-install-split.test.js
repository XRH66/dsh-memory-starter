import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createModelInstaller } from '../lib/raw-rag/install.js';
import { PYTHON_PACKAGES, FASTEMBED_PACKAGE } from '../lib/raw-rag/install-catalog.js';
import { scratchDirectory } from './helpers.js';

const CURRENT='Qwen/Qwen3-Embedding-4B';
const HISTORY='Qwen/Qwen3-Embedding-8B';
const BGE='BAAI/bge-small-zh-v1.5';
const RECEIPT_DIRECTORY=path.join('runtime','embedding-install-v1','receipts');

async function fixture(t) {
  const root=await scratchDirectory('model-install-split-');
  const currentModel=path.join(root,'current.gguf'),currentServer=path.join(root,'current-server.exe');
  const historyModel=path.join(root,'history.gguf'),historyServer=path.join(root,'history-server.exe');
  await Promise.all([currentModel,currentServer,historyModel,historyServer].map(file=>fs.writeFile(file,'fixture')));
  const currentSettings={rawRecallModel:CURRENT,rawRecallDimensions:2560,rawRecallDevice:'cpu',
    rawRecallGgufModel:currentModel,rawRecallLlamaServer:currentServer,rawRecallLlamaGpuLayers:0,
    rawRecallApiKeyFile:path.join(root,'fixture.key'),rawRecallApiKeyEnv:'FICTIONAL_INVENTORY_KEY'};
  const historySettings={...currentSettings,rawRecallModel:HISTORY,rawRecallDimensions:4096,
    rawRecallGgufModel:historyModel,rawRecallLlamaServer:historyServer,rawRecallApiKeyFile:'',
    rawRecallApiKeyEnv:'FICTIONAL_HISTORY_KEY'};
  const cfg={ownerDirectory:root,backend:{command:path.join(root,'fixture-backend.exe')},
    memory:currentSettings,rawModelHistory:[{id:'history-eight',settings:historySettings}]};
  const staged=[];
  const installer=createModelInstaller({
    readConfiguration:async()=>({cfg,revision:'r1'}),
    stageModel:async input=>{staged.push(input);return {};},
  });
  t.after(()=>installer.dispose());
  return {root,cfg,currentSettings,staged,installer};
}

async function fakeIsolatedPython(root,label){
  const environment=path.join(root,'runtime','embedding-install-v1','python',label);
  const executable=path.join(environment,process.platform==='win32'?'Scripts/python.exe':'bin/python');
  const sitePackages=process.platform==='win32'?path.join(environment,'Lib','site-packages')
    :path.join(environment,'lib','python3.12','site-packages');
  await fs.mkdir(path.dirname(executable),{recursive:true});
  await fs.mkdir(sitePackages,{recursive:true});
  await fs.writeFile(executable,'fixture');
  const packages={};
  for(const requirement of [...PYTHON_PACKAGES,FASTEMBED_PACKAGE]){
    const [name,version]=requirement.split('=='),directory=path.join(sitePackages,name+'-'+version+'.dist-info');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory,'METADATA'),'Metadata-Version: 2.1\nName: '+name+'\nVersion: '+version+'\n');
    packages[name]=version;
  }
  return {file:executable,sitePackages,packages};
}

async function writeBgeReceipt(root,name,{at,model=BGE,python,label}){
  const cache=path.join(root,'embedding-cache-'+label),modelDirectory=path.join(cache,'models--Qdrant--bge-small-zh-v1.5','snapshots',label);
  await fs.mkdir(modelDirectory,{recursive:true});
  const assets=[['model_optimized.onnx','fixture weights'],['tokenizer.json','{}'],['config.json','{}']];
  for(const [file,content] of assets)await fs.writeFile(path.join(modelDirectory,file),content);
  const files=[];
  for(const [file] of assets){
    const target=path.join(modelDirectory,file),stat=await fs.stat(target);
    files.push({path:target,size:stat.size,mtimeMs:stat.mtimeMs});
  }
  const settings={rawRecallModel:BGE,rawRecallDimensions:512,rawRecallPython:python.file,
    rawRecallCacheDir:cache,rawRecallBgeModelDir:modelDirectory,rawRecallInstallReceipt:'',
    rawRecallApiKeyFile:path.join(root,'fictional-receipt.key'),rawRecallApiKeyEnv:'FICTIONAL_RECEIPT_KEY'};
  const receipt={schema:1,model,revision:label,at,scope:'raw-conversation-embedding',source:null,expectedSource:null,
    runtimeRevision:null,mode:'pinned-artifacts',settings,files,packages:python.packages,tested:false};
  const directory=path.join(root,RECEIPT_DIRECTORY),file=path.join(directory,name);
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(file,JSON.stringify(receipt));
  return {file,modelDirectory,receipt};
}

async function waitFor(installer, state) {
  for(let attempt=0;attempt<200;attempt++){
    const job=installer.status();
    if(job?.state===state)return job;
    if(job&&job.state!=='running')return job;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  throw Error('installer did not reach '+state);
}

test('inventory distinguishes current, history and missing local models without exposing credentials',async t=>{
  const f=await fixture(t),inventory=await f.installer.inventory({revision:'r1'});
  assert.equal(inventory.revision,'r1');
  assert.equal(inventory.models.some(model=>model.id==='text-embedding-v4'),false);
  const current=inventory.models.find(model=>model.id===CURRENT);
  const history=inventory.models.find(model=>model.id===HISTORY);
  const missing=inventory.models.find(model=>model.id==='Qwen/Qwen3-Embedding-0.6B');
  assert.equal(current.installed,true);assert.equal(current.source,'current');
  assert.equal(history.installed,true);assert.equal(history.source,'history');
  assert.equal(missing.installed,false);assert.ok(missing.issues.length>0);assert.equal(missing.settings,null);
  assert.equal(Object.keys(current.settings).some(name=>/^rawRecallApiKey/u.test(name)),false);
});

test('inventory rediscovers a verified receipt with an isolated Python and exposes paths only',async t=>{
  const f=await fixture(t),python=await fakeIsolatedPython(f.root,'isolated'),
    receipt=await writeBgeReceipt(f.root,'verified.json',{at:'2026-11-13T01:00:00.000Z',python,label:'verified'});
  const inventory=await f.installer.inventory({revision:'r1'}),bge=inventory.models.find(model=>model.id===BGE);
  assert.equal(bge.installed,true);
  assert.equal(bge.source,'installed');
  assert.equal(bge.settings.rawRecallPython,python.file);
  assert.equal(bge.settings.rawRecallInstallReceipt,receipt.file);
  assert.deepEqual(Object.keys(bge.settings).sort(),
    ['rawRecallBgeModelDir','rawRecallCacheDir','rawRecallInstallReceipt','rawRecallPython']);
  assert.equal(Object.keys(bge.settings).some(name=>/key|credential|secret/i.test(name)),false);
});

test('inventory prefers the latest verifiable receipt and skips damaged or mismatched candidates',async t=>{
  const f=await fixture(t),olderPython=await fakeIsolatedPython(f.root,'older'),
    newerPython=await fakeIsolatedPython(f.root,'newer'),
    older=await writeBgeReceipt(f.root,'z-older.json',{at:'2026-11-13T01:00:00.000Z',python:olderPython,label:'older'}),
    newer=await writeBgeReceipt(f.root,'a-newer.json',{at:'2026-11-13T03:00:00.000Z',python:newerPython,label:'newer'});
  await writeBgeReceipt(f.root,'mismatch.json',{at:'2026-11-13T05:00:00.000Z',model:HISTORY,python:newerPython,label:'mismatch'});
  await fs.writeFile(path.join(f.root,RECEIPT_DIRECTORY,'damaged.json'),'{"schema":1,');

  let inventory=await f.installer.inventory({revision:'r1'}),bge=inventory.models.find(model=>model.id===BGE);
  assert.equal(bge.installed,true);
  assert.equal(bge.settings.rawRecallPython,newerPython.file);
  assert.equal(bge.settings.rawRecallInstallReceipt,newer.file);

  const metadata=path.join(newerPython.sitePackages,FASTEMBED_PACKAGE.replace('==','-')+'.dist-info','METADATA');
  const originalMetadata=await fs.readFile(metadata,'utf8');
  await fs.writeFile(metadata,'Metadata-Version: 2.1\nName: fastembed\nVersion: 0.0.0\n');
  inventory=await f.installer.inventory({revision:'r1'});bge=inventory.models.find(model=>model.id===BGE);
  assert.equal(bge.installed,true);
  assert.equal(bge.settings.rawRecallPython,olderPython.file);
  assert.equal(bge.settings.rawRecallInstallReceipt,older.file);

  await fs.writeFile(metadata,originalMetadata);
  await fs.rm(path.join(newer.modelDirectory,'model_optimized.onnx'));
  inventory=await f.installer.inventory({revision:'r1'});bge=inventory.models.find(model=>model.id===BGE);
  assert.equal(bge.settings.rawRecallPython,olderPython.file);
});

test('download-only installation writes a receipt but never stages the selected model',async t=>{
  const f=await fixture(t),input={revision:'r1',settings:f.currentSettings,allowDownload:true,useExisting:true};
  await f.installer.start({...input,downloadOnly:true});
  assert.equal((await waitFor(f.installer,'downloaded')).state,'downloaded');
  assert.equal(f.staged.length,0);
  await f.installer.start(input);
  assert.equal((await waitFor(f.installer,'prepared')).state,'prepared');
  assert.equal(f.staged.length,1);
});

test('download completion is visible only after its install lock is released',async t=>{
  const f=await fixture(t),input={revision:'r1',settings:f.currentSettings,allowDownload:true,useExisting:true};
  const lock=path.join(f.root,'runtime','embedding-install-v1','install.lock');
  await f.installer.start({...input,downloadOnly:true});
  assert.equal((await waitFor(f.installer,'downloaded')).state,'downloaded');
  await assert.rejects(fs.access(lock),{code:'ENOENT'});
  await f.installer.start(input);
  assert.equal((await waitFor(f.installer,'prepared')).state,'prepared');
  assert.equal(f.staged.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createModelInstaller } from '../lib/raw-rag/install.js';
import { scratchDirectory } from './helpers.js';

const CURRENT='Qwen/Qwen3-Embedding-4B';
const HISTORY='Qwen/Qwen3-Embedding-8B';

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
  return {root,currentSettings,staged,installer};
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

test('download-only installation writes a receipt but never stages the selected model',async t=>{
  const f=await fixture(t),input={revision:'r1',settings:f.currentSettings,allowDownload:true,useExisting:true};
  await f.installer.start({...input,downloadOnly:true});
  assert.equal((await waitFor(f.installer,'downloaded')).state,'downloaded');
  assert.equal(f.staged.length,0);
  await f.installer.start(input);
  assert.equal((await waitFor(f.installer,'prepared')).state,'prepared');
  assert.equal(f.staged.length,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createSettingsHandler} from '../lib/settings-host.js';
import {deploymentFingerprint} from '../lib/deployment-config.js';
import {scratchDirectory} from './helpers.js';

// An older library (for example one created by the 0.3.0 starter) is just a folder with vault/
// and management/. Selecting it from the settings page must stage the switch for the next start.
test('selecting an existing library stages it without the removed QQ configuration reservation',async t=>{
  const root=await scratchDirectory('library-select-');
  const current=path.join(root,'new-library'),old=path.join(root,'old-starter','data');
  for(const dir of [path.join(current,'vault'),path.join(current,'management'),path.join(old,'vault','chats','facts'),path.join(old,'management')])await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(old,'vault','chats','facts','pet.md'),'---\ntitle: 虚构宠物\nmemory_kind: fact\n---\n\n- [fact] 养了一只叫阿岑的猫\n');
  const file=path.join(root,'deployment.json'),cfg={ownerDirectory:current,dshHome:path.join(root,'home'),dshSessionIds:[],memory:{}};
  await fs.writeFile(file,JSON.stringify(cfg));
  await fs.mkdir(path.join(cfg.dshHome,'storages'),{recursive:true});
  await fs.writeFile(path.join(cfg.dshHome,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{},tables:{workspaces:{}}}));
  let saved=0;const handler=createSettingsHandler({},file,undefined,undefined,{afterSave:async()=>{saved++;}});t.after(()=>handler.dispose?.());
  const req=Readable.from([Buffer.from(JSON.stringify({action:'select',directory:old,revision:deploymentFingerprint(cfg)}))]);
  Object.assign(req,{method:'POST',url:'/api/basic-memory-settings/libraries',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:15680','content-type':'application/json','x-basic-memory-settings':'1'}});
  const res={setHeader(){},end(value){this.body=JSON.parse(value);}};
  await handler(req,res);
  assert.equal(res.body.ok,true,res.body.error);
  assert.equal(res.body.pendingDirectory,old);assert.equal(saved,1);
  const stored=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(stored.ownerDirectory,current,'the running library stays until the next start');assert.equal(stored.pendingMemoryDirectory,old);
  assert.equal(await fs.readFile(path.join(old,'vault','chats','facts','pet.md'),'utf8').then(text=>text.includes('阿岑')),true,'selecting must not touch the old notes');
});

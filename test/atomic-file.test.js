import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeFileAtomic,writeJsonAtomic} from '../lib/atomic-file.js';

async function directory(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'atomic-file-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return root;
}

test('atomic writes retry transient rename contention',async t=>{
  const root=await directory(t),file=path.join(root,'state.json');
  const originalRename=fs.rename;
  let attempts=0;
  fs.rename=async(...args)=>{
    attempts++;
    if(attempts<=2)throw Object.assign(Error('simulated rename contention'),{code:'EPERM'});
    return originalRename(...args);
  };
  try{
    await writeFileAtomic(file,'complete');
  }finally{
    fs.rename=originalRename;
  }
  assert.equal(attempts,3);
  assert.equal(await fs.readFile(file,'utf8'),'complete');
  assert.deepEqual(await fs.readdir(root),['state.json']);
});

test('exhausted atomic rename retries preserve the original error and clean up',async t=>{
  const root=await directory(t),file=path.join(root,'state.json');
  const originalRename=fs.rename,originalError=Object.assign(Error('persistent contention'),{code:'EACCES'});
  let attempts=0;
  fs.rename=async()=>{
    attempts++;
    throw originalError;
  };
  let caught;
  try{
    await writeFileAtomic(file,'not committed');
  }catch(error){
    caught=error;
  }finally{
    fs.rename=originalRename;
  }
  assert.equal(caught,originalError);
  assert.equal(attempts,6);
  assert.deepEqual(await fs.readdir(root),[]);
});

test('JSON atomic writes preserve requested indentation and trailing newline',async t=>{
  const root=await directory(t),file=path.join(root,'state.json');
  await writeJsonAtomic(file,{first:1,nested:{ok:true}},{space:2,trailingNewline:true});
  assert.equal(await fs.readFile(file,'utf8'),'{\n  "first": 1,\n  "nested": {\n    "ok": true\n  }\n}\n');
  await writeJsonAtomic(file,{compact:true},{space:0});
  assert.equal(await fs.readFile(file,'utf8'),'{"compact":true}');
});

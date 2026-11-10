import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {resolveConfig} from '../lib/config.js';

const allowed={authorize:()=>true};
const owner='withdraw-owner';
const input=(patch={})=>({ownerSubject:owner,project:'main',sessionId:'session-w',messageId:'user-w',role:'user',sequence:1,turn:1,rootTurn:1,
  text:'我把备用钥匙藏在蓝色花盆底下。',content:[{type:'text',text:'我把备用钥匙藏在蓝色花盆底下。'}],time:Date.parse('2026-01-02T10:00:00+08:00'),authorization:{epoch:'e'},...patch});

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'raw-withdraw-test-')),file=path.join(directory,'raw.sqlite');
  const make=()=>createRawRecall({config:resolveConfig({project:'main',rawRecall:true,rawRecallDbPath:file}),ownerSubject:()=>owner,logger:{warn(){}}});
  let raw=make();
  t.after(async()=>{await raw.dispose?.();await fs.rm(directory,{recursive:true,force:true});});
  return {get raw(){return raw;},async restart(){await raw.dispose?.();raw=make();}};
}
// Counts hits in the full-text projection itself, not only the filtered reader.
async function hits(raw,query){return (await raw.retrieve({query,mode:'text',authorize:()=>true})).turns.length;}

test('withdrawing a message removes its words from the full-text index',async t=>{
  const f=await fixture(t);
  const kept=f.raw.recordMessage(input({messageId:'user-k',sequence:2,text:'周末去爬山。',content:[{type:'text',text:'周末去爬山。'}]}),allowed).source;
  const saved=f.raw.recordMessage(input(),allowed).source;
  f.raw.projectMessage(saved,allowed);f.raw.projectMessage(kept,allowed);
  assert.ok(await hits(f.raw,'备用钥匙')>0);
  const result=f.raw.withdrawMessage({ownerSubject:owner,project:'main',id:saved.id},allowed);
  assert.equal(result.withdrawn,true);assert.equal(result.removed,true);
  assert.equal(await hits(f.raw,'备用钥匙'),0);
  assert.ok(await hits(f.raw,'爬山')>0,'other messages stay searchable');
  assert.equal(f.raw.messageReader({ownerSubject:owner,project:'main'},allowed).get({id:saved.id}),null);
  // Repeating is harmless.
  assert.deepEqual({...f.raw.withdrawMessage({ownerSubject:owner,project:'main',id:saved.id},allowed),notice:null},{withdrawn:false,removed:false,notice:null});
});

test('purge removes projections left by earlier withdrawals and is idempotent',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'raw-withdraw-purge-'));
  const store=new RawMemoryStore(path.join(directory,'raw.sqlite'),{warn(){}});
  const raw=createRawRecall({config:resolveConfig({project:'main',rawRecall:true,rawRecallDbPath:path.join(directory,'raw.sqlite')}),ownerSubject:()=>owner,store,logger:{warn(){}}});
  t.after(async()=>{await raw.dispose?.();store.close();await fs.rm(directory,{recursive:true,force:true});});
  const saved=raw.recordMessage(input(),allowed).source;raw.projectMessage(saved,allowed);
  // An older build only marked the source withdrawn and left its text projection.
  store.messages.withdraw({ownerSubject:owner,project:'main',id:saved.id},allowed);
  assert.ok(await hits(raw,'备用钥匙')>0);
  assert.deepEqual(raw.purgeWithdrawnProjections({ownerSubject:owner,project:'main'},allowed),{removed:1});
  assert.equal(await hits(raw,'备用钥匙'),0);
  assert.deepEqual(raw.purgeWithdrawnProjections({ownerSubject:owner,project:'main'},allowed),{removed:0});
});

test('withdrawal requires current authorization',async t=>{
  const f=await fixture(t);
  const saved=f.raw.recordMessage(input(),allowed).source;f.raw.projectMessage(saved,allowed);
  assert.throws(()=>f.raw.withdrawMessage({ownerSubject:owner,project:'main',id:saved.id},{authorize:()=>false}),{code:'MEMORY_NOT_AUTHORIZED'});
  assert.ok(await hits(f.raw,'备用钥匙')>0);
});

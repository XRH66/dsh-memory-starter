import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {resolveConfig} from '../lib/config.js';
import {embeddingContract} from './embedding-fixture.js';

test('revoked raw indexing cannot commit a vector returned after closing memory',async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'raw-auth-')),db=path.join(dir,'raw.sqlite');
  let started,release,allowed=true;
  const entered=new Promise(resolve=>{started=resolve;}),pending=new Promise(resolve=>{release=resolve;});
  const embedder={...embeddingContract('authorization-fixture:4',4),async embed(texts){started();await pending;return texts.map(()=>[1,0,0,0]);},dispose(){}};
  const recall=createRawRecall({config:resolveConfig({rawRecall:true,rawRecallDbPath:db}),ownerSubject:()=> 'fixture-owner',embedder,logger:{warn(){}}});
  try{
    const archived=await recall.archiveTurn({sessionId:'session-fixture',turn:1,completedAt:Date.now(),authorize:()=>allowed,
      messages:[{id:'authorized-user',role:'user',text:'获准回合的原话。'}]});
    assert.ok(archived.turnId);await entered;
    allowed=false;release();await recall.flush();
    const store=new RawMemoryStore(db);
    try{const stats=store.stats('authorization-fixture:4','fixture-owner');assert.equal(stats.turns,1);assert.equal(stats.vectors,0);}finally{store.close();}
    const refused=await recall.archiveTurn({sessionId:'session-fixture',turn:2,completedAt:Date.now(),authorize:()=>allowed,messages:[]});
    assert.equal(refused.skipped,'authorization-revoked');
  }finally{
    release();await recall.dispose();
    assert.equal(path.dirname(path.resolve(dir)),path.resolve(os.tmpdir()));
    await fs.rm(dir,{recursive:true,force:true});
  }
});

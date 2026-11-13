import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVectorIndex} from '../lib/unified/vector-index.js';

test('Float32Array ranking matches the prior per-element LE dot product',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vector-rank-'));
  const index=createVectorIndex({file:path.join(directory,'index.sqlite')});
  t.after(async()=>{index.close();await fs.rm(directory,{recursive:true,force:true});});
  const scope={ownerSubject:'fictional-owner',project:'main'},guard=()=>{};
  const profile={id:'fixture-profile',revision:'fixture-revision',dimensions:4};
  const checkpoint=index.checkpoint({scope,profile,modelKey:'fixture-model',indexIdentity:'fixture-index',now:1,guard});
  const storedVector=new Float32Array([0.25,-1.5,3.75,0.5]);
  index.put({scope,snapshotId:checkpoint.id,dimensions:4,guard,document:{
    id:'fixture-document',revision:'one',domain:'fact',sourceIds:['source-one'],
    chunks:[{start:0,end:1,tokenBound:1,vector:storedVector}],
  }});
  const ready=index.finish({scope,snapshotId:checkpoint.id,guard});
  const query=new Float32Array([1.25,0.5,-0.75,2]);
  const [ranked]=index.rank({scope,snapshotId:ready.id,documents:[{id:'fixture-document'}],vector:query,guard});

  const blob=Buffer.allocUnsafe(storedVector.length*4);
  storedVector.forEach((value,index)=>blob.writeFloatLE(value,index*4));
  const expected=Array.from(query).reduce((sum,value,index)=>sum+blob.readFloatLE(index*4)*value,0);
  assert.ok(Math.abs(ranked.score-expected)<=1e-6,`${ranked.score} != ${expected}`);
});

test('ranking keeps dimension and non-finite vector checks',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'vector-rank-invalid-'));
  const index=createVectorIndex({file:path.join(directory,'index.sqlite')});
  t.after(async()=>{index.close();await fs.rm(directory,{recursive:true,force:true});});
  const scope={ownerSubject:'fictional-owner',project:'main'},guard=()=>{};
  const profile={id:'fixture-profile',revision:'fixture-revision',dimensions:2};
  const checkpoint=index.checkpoint({scope,profile,modelKey:'fixture-model',indexIdentity:'fixture-index',now:1,guard});
  index.put({scope,snapshotId:checkpoint.id,dimensions:2,guard,document:{
    id:'fixture-document',revision:'one',domain:'fact',sourceIds:['source-one'],
    chunks:[{start:0,end:1,tokenBound:1,vector:new Float32Array([1,0])}],
  }});
  const ready=index.finish({scope,snapshotId:checkpoint.id,guard});
  assert.throws(()=>index.rank({scope,snapshotId:ready.id,documents:[{id:'fixture-document'}],vector:new Float32Array([1]),guard}),
    {code:'EMBEDDING_DIMENSIONS'});
  assert.throws(()=>index.rank({scope,snapshotId:ready.id,documents:[{id:'fixture-document'}],vector:new Float32Array([1,NaN]),guard}),
    {code:'INVALID_EMBEDDING'});
});

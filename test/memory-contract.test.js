import test from 'node:test';
import assert from 'node:assert/strict';
import {createSourceNotice,normalizeHandoffTokens,MEMORY_ENTRY_TYPES,MEMORY_PIPELINE_DEFAULTS,MEMORY_QUERY_DEFAULTS,MEMORY_HANDOFF_DEFAULTS} from '../lib/memory-contract.js';

test('handoff presets and custom token budgets keep their independent meaning',()=>{
  assert.equal(normalizeHandoffTokens(),4096);assert.equal(normalizeHandoffTokens(8192),8192);
  assert.equal(normalizeHandoffTokens(6000),6000);assert.equal(normalizeHandoffTokens(16384),16384);
  for(const value of [0,-1,1.5,16385,'8192',NaN,Infinity])assert.throws(()=>normalizeHandoffTokens(value),{code:'INVALID_HANDOFF_BUDGET'});
  assert.deepEqual(MEMORY_HANDOFF_DEFAULTS.presets,[4096,8192]);
  assert.equal(MEMORY_PIPELINE_DEFAULTS.batchTokens,4096);assert.equal(MEMORY_PIPELINE_DEFAULTS.batchTurns,8);
  assert.equal(MEMORY_QUERY_DEFAULTS.totalTokens,4096);assert.equal(MEMORY_QUERY_DEFAULTS.waitMs,2000);
});

test('source notifications preserve stable message identity across revisions and model changes',()=>{
  const input={kind:'message',operation:'saved',sessionId:'session-a',messageId:'message-a',role:'user',ownerSubject:'owner-a',project:'main',revision:1,text:'原文由来源服务保存',model:'model-a'};
  const first=createSourceNotice(input),updated=createSourceNotice({...input,revision:2,operation:'updated',model:'model-b'});
  assert.equal(first.id,updated.id);assert.notEqual(first.revision,updated.revision);
  assert.equal(first.platform,'');assert.equal('text' in first,false);assert.equal('model' in first,false);
  assert.ok(Object.isFrozen(first));assert.equal(first.role,'user');
  assert.equal(createSourceNotice({...input,role:'assistant'}).role,'assistant');
  assert.throws(()=>createSourceNotice({...input,role:'tool'}),{code:'INVALID_SOURCE_ROLE'});
  assert.throws(()=>createSourceNotice({...input,id:'unrelated'}),{code:'SOURCE_ID_MISMATCH'});
  assert.throws(()=>createSourceNotice({...input,revision:0}),{code:'INVALID_SOURCE_REVISION'});
});

test('document revisions use the existing note identity and never invent a chat source',()=>{
  const notice=createSourceNotice({kind:'document',operation:'updated',id:'note:diary/one',revision:'revision-two',ownerSubject:'owner-a',project:'main',position:4});
  assert.equal(notice.id,'note:diary/one');assert.equal('sessionId' in notice,false);
  assert.equal(notice.position,4);assert.equal(notice.revision,'revision-two');
  assert.equal(new Set(MEMORY_ENTRY_TYPES).size,12);
  assert.ok(MEMORY_ENTRY_TYPES.includes('reflection'));assert.equal(MEMORY_ENTRY_TYPES.includes('history'),false);
});

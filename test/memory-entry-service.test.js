import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createMemoryEntryBackend} from '../lib/memory-entry-backend.js';
import {createMemoryEntryService} from '../lib/memory-entry-service.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent} from './helpers.js';

const original={id:'dsh:qa:user-one',revision:1,role:'user',isCurrent:true,ownerSubject:'测试用户',project:'main'};
const proposed=(patch={})=>({type:'plan',content:'QA 虚构计划：下周整理书架。',subject_ref:'p1',source_refs:['s1'],state:{validity:'current',progress:'planned'},tags:['测试计划'],importance:{level:'high',basis:'user_explicit',reason:'虚构用户明确说明这是优先事项'},...patch});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'entry-service-')),raw=new RawMemoryStore(path.join(directory,'existing-raw.sqlite'),{warn(){}}),memory=memoryStore({project:'main'});
  const scope={ownerSubject:'测试用户',project:'main'},config={project:'main',vaultPath:path.join(directory,'vault')},backend=createMemoryEntryBackend({tools:memory.tools,project:'main'});
  const originals=new Map([[original.id,{...original}]]);let allowed=true;
  const context={agent:fakeAgent('session-fixture'),check(){if(!allowed)throw Object.assign(Error('closed'),{code:'MEMORY_NOT_AUTHORIZED'});}};
  const make=(override={})=>createMemoryEntryService({scope,config,repository:()=>raw.entries,backend,sourceState:ref=>originals.get(ref.id),...override});
  const input=(operationId,patch={})=>({operationId,proposed:proposed(),sources:new Map([['s1',original]]),subjects:new Map([['p1','测试用户']]),...patch});
  t.after(async()=>{raw.close();await fs.rm(directory,{recursive:true,force:true});});
  return {raw,memory,scope,backend,context,make,input,originals,revoke:()=>{allowed=false;}};
}

test('one semantic result creates a real editable note and metadata projection with independent state and importance',async t=>{
  const f=await fixture(t),service=f.make(),saved=await service.commit(f.input('create-one'),f.context);
  assert.equal(saved.state,'committed');const entry=await service.read(saved.id,f.context);
  assert.equal(entry.type,'plan');assert.equal(entry.content,proposed().content);assert.equal(entry.importance.level,'high');assert.equal(entry.state.progress,'planned');
  assert.deepEqual(entry.source_refs,[{id:original.id,revision:1,role:'user'}]);assert.equal(f.memory.notes.size,1);
  const stored=f.raw.db.prepare('SELECT metadata_json FROM structured_entries').get();assert.equal('content' in JSON.parse(stored.metadata_json),false);
  assert.equal((await service.list({type:'plan',progress:'planned',tag:'测试计划'},f.context)).entries.length,1);
  assert.equal((await service.list({type:'fact'},f.context)).entries.length,0);
  const duplicate=await service.commit(f.input('create-one',{proposed:proposed({content:'忽略后来的不同模型结果'})}),f.context);
  assert.equal(duplicate.duplicate,true);assert.equal(f.memory.notes.size,1);assert.equal((await service.read(saved.id,f.context)).content,proposed().content);
  assert.equal(f.raw.entries.list({...f.scope,ownerSubject:'另一个用户'}).entries.length,0);
});

test('same parse reuses only an identical registered note and still checks source and access changes',async t=>{
  const f=await fixture(t),created=await f.make().commit(f.input('reuse-create'),f.context);
  const note=await f.backend.read(created.permalink,f.context);
  let reads=0;
  const service=f.make({backend:{...f.backend,async read(...args){reads++;return f.backend.read(...args);}}});
  const reused=await service.read(created.id,f.context,{note});
  assert.equal(reads,0);assert.equal(reused.content,proposed().content);
  await service.read(created.id,f.context,{note:{...note,checksum:'different-revision'}});
  await service.read(created.id,f.context,{note:{...note,permalink:'different-location'}});
  assert.equal(reads,2);
  f.originals.set(original.id,{...original,revision:2});
  assert.equal((await service.read(created.id,f.context,{note})).sourceStatus.eligible,false);
  assert.equal(reads,2);
  f.revoke();await assert.rejects(service.read(created.id,f.context,{note}),{code:'MEMORY_NOT_AUTHORIZED'});
});

test('stale manual edits become a review without overwriting text or unknown metadata',async t=>{
  const f=await fixture(t),service=f.make(),first=await service.commit(f.input('manual-one'),f.context),note=f.memory.notes.get(first.permalink);
  note.content+='\n人工可视化附注：保留这段。\n';note.frontmatter.my_manual_key='保留';note.checksum='manual-new-revision';
  const result=await service.commit(f.input('stale-update',{target:{id:first.id,revision:first.revision},proposed:proposed({content:'另一个计划'}),allowReplacement:true}),f.context);
  assert.equal(result.state,'review');assert.equal(result.reason,'target-revision-changed');assert.ok(note.content.includes('人工可视化附注'));assert.equal(note.frontmatter.my_manual_key,'保留');
  assert.equal(f.memory.notes.size,1);assert.equal(service.reviews(f.context).length,1);
});

test('completion preserves importance and human annotations while previous full text becomes history',async t=>{
  const f=await fixture(t),service=f.make(),first=await service.commit(f.input('completion-create'),f.context),note=f.memory.notes.get(first.permalink);
  note.content+='\n人工附注：下层放工具书。\n';note.frontmatter.manual_key='kept';note.checksum='manual-baseline';
  const before=await service.read(first.id,f.context);
  const update=f.input('completion-update',{target:{id:first.id,revision:before.revision},proposed:proposed({state:{validity:null,progress:'completed'},importance:null})});
  const result=await service.commit(update,f.context);assert.equal(result.state,'committed');
  const current=await service.read(first.id,f.context);assert.equal(current.state.validity,'current');assert.equal(current.state.progress,'completed');assert.equal(current.importance.level,'high');
  assert.ok(f.memory.notes.get(result.permalink).content.includes('人工附注'));assert.equal(f.memory.notes.get(result.permalink).frontmatter.manual_key,'kept');
  const history=(await service.list({validity:'historical'},f.context)).entries;assert.equal(history.length,1);assert.equal(history[0].state.progress,'planned');assert.equal(history[0].importance.level,'high');
  await service.commit(update,f.context);assert.equal(f.memory.notes.size,2);
});

test('a changed meaning or importance needs the conflict decision even with a matching target revision',async t=>{
  const f=await fixture(t),service=f.make(),first=await service.commit(f.input('conflict-create'),f.context);
  const result=await service.commit(f.input('conflict-update',{target:{id:first.id,revision:first.revision},proposed:proposed({importance:{level:'low',basis:'contextual',reason:'模型认为不重要'}})}),f.context);
  assert.equal(result.state,'review');assert.equal(result.reason,'content-or-importance-conflict');assert.equal(f.memory.notes.size,1);
});

test('human review pins the displayed revision and archives the newer manual body after refresh',async t=>{
  const f=await fixture(t),service=f.make(),first=await service.commit(f.input('review-create'),f.context);
  const change=f.input('review-change',{target:{id:first.id,revision:first.revision},proposed:proposed({content:'整理工具箱。'})});
  assert.equal((await service.commit(change,f.context)).state,'review');
  const initial=await service.readReview(change.operationId,f.context);
  assert.equal(initial.proposed.content,'整理工具箱。');
  assert.equal(initial.sources[0].id,original.id);
  const note=f.memory.notes.get(first.permalink);
  note.content=note.content.replace(proposed().content,'Obsidian 手动改动。')+'\n人工补注。';
  note.checksum='manual-review-version';
  await assert.rejects(service.decideReview({action:'approve',operationId:change.operationId,revision:initial.revision},f.context),{code:'REVISION_CONFLICT'});
  const latest=await service.readReview(change.operationId,f.context);
  assert.equal(latest.current.content,'Obsidian 手动改动。');
  const decision={action:'approve',operationId:change.operationId,revision:latest.revision};
  assert.equal((await service.decideReview(decision,f.context)).state,'committed');
  assert.equal((await service.decideReview(decision,f.context)).duplicate,true);
  const history=(await service.list({validity:'historical'},f.context)).entries;
  assert.deepEqual(history.map(row=>row.content),['Obsidian 手动改动。']);
  assert.ok(f.memory.notes.get(first.permalink).content.includes('人工补注。'));
  assert.deepEqual(service.reviewList({},f.context).items,[]);
});

test('a withdrawn proposal can be rejected without disclosing its body or replaying a write',async t=>{
  const f=await fixture(t),service=f.make(),first=await service.commit(f.input('reject-create'),f.context);
  const change=f.input('reject-change',{target:{id:first.id,revision:first.revision},proposed:proposed({content:'旧来源的建议。'})});
  assert.equal((await service.commit(change,f.context)).state,'review');
  f.originals.set(original.id,{...original,withdrawn:true});
  const review=await service.readReview(change.operationId,f.context);
  assert.equal(review.proposed,null);assert.deepEqual(review.sources,[]);assert.equal(review.canApprove,false);
  await assert.rejects(service.decideReview({action:'approve',operationId:change.operationId,revision:first.revision},f.context),{code:'MEMORY_SOURCE_CHANGED'});
  assert.equal((await service.decideReview({action:'reject',operationId:change.operationId},f.context)).state,'rejected');
  assert.equal((await service.commit(change,f.context)).state,'rejected');
  assert.equal(f.memory.notes.size,1);
});

test('a new matching user reaffirmation raises priority once and preserves the body and importance',async t=>{
  const f=await fixture(t),service=f.make();
  const content='校对已经写好的蓝鲸航海日志。';
  const first=await service.commit(f.input('reinforce-create',{proposed:proposed({content})}),f.context);
  const note=f.memory.notes.get(first.permalink),bodyBefore=note.content;
  note.frontmatter.base_priority=0.4;
  note.frontmatter.decay_anchor_at='2026-10-01T00:00:00.000Z';
  f.originals.set(original.id,{...original,text:'我还是决定'+content,time:Date.parse('2026-10-04T00:00:00.000Z')});
  const input=f.input('reinforce-once',{proposed:proposed({content}),target:{id:first.id,revision:first.revision},reinforcement:content});
  const result=await service.commit(input,f.context);
  assert.equal(result.reinforced,true);assert.equal(result.metadataOnly,true);
  const fresh=f.memory.notes.get(first.permalink);
  assert.equal(fresh.content,bodyBefore);assert.equal(fresh.frontmatter.reinforcement_count,1);
  assert.equal((await service.read(first.id,f.context)).importance.level,'high');
  assert.equal((await service.commit(input,f.context)).duplicate,true);
  const again=await service.commit({...input,operationId:'reinforce-cooldown',target:{id:first.id,revision:result.revision}},f.context);
  assert.equal(again.reinforced,false);assert.equal(f.memory.notes.size,1);
});

test('lost post-write acknowledgement recovers the exact operation without another write or semantic call',async t=>{
  const f=await fixture(t);let writes=0;
  const backend={...f.backend,async write(...args){writes++;const saved=await f.backend.write(...args);if(writes===1)throw Error('fixture lost write acknowledgement');return saved;}};
  const service=f.make({backend});await assert.rejects(service.commit(f.input('lost-ack'),f.context),/lost write acknowledgement/);
  assert.equal(f.memory.notes.size,1);const result=await service.commit(f.input('lost-ack'),f.context);
  assert.equal(result.recovered,true);assert.equal(writes,1);assert.equal(f.memory.notes.size,1);
});

test('revoked access and stale sources cannot create a note or reach the backend',async t=>{
  const f=await fixture(t),service=f.make();f.originals.set(original.id,{...original,revision:2});
  await assert.rejects(service.commit(f.input('bad-source'),f.context),{code:'MEMORY_SOURCE_CHANGED'});assert.equal(f.memory.tools.calls.length,0);
  f.revoke();await assert.rejects(service.list({},f.context),{code:'MEMORY_NOT_AUTHORIZED'});assert.equal(f.memory.tools.calls.length,0);
});

test('query marks obsolete evidence while a genuinely edited managed body remains authoritative',async t=>{
  const f=await fixture(t),service=f.make(),first=await service.commit(f.input('source-later-changed'),f.context);
  f.originals.set(original.id,{...original,revision:2});
  assert.equal((await service.read(first.id,f.context)).sourceStatus.eligible,false);
  assert.equal((await service.list({},f.context)).entries.length,0);
  assert.equal((await service.list({includeUnavailable:true},f.context)).entries.length,1);
  const note=f.memory.notes.get(first.permalink);note.content=note.content.replace('QA 虚构计划：下周整理书架。','人工改为整理工具箱');note.checksum='human-edited-managed-body';
  const edited=await service.read(first.id,f.context);assert.equal(edited.sourceStatus.manualBody,true);assert.equal(edited.sourceStatus.eligible,true);assert.ok(edited.content.includes('工具箱'));
  f.memory.notes.delete(first.permalink);assert.equal(await service.read(first.id,f.context),null);assert.equal(f.raw.entries.get({...f.scope,id:first.id}),null);
});

test('lost acknowledgement after editing recovers once and keeps a single historical version',async t=>{
  const f=await fixture(t);let edits=0;
  const backend={...f.backend,async edit(...args){edits++;const value=await f.backend.edit(...args);throw Error('fixture edit acknowledgement lost');}};
  const service=f.make({backend}),first=await service.commit(f.input('edit-ack-create'),f.context);
  const update=f.input('edit-ack-update',{target:{id:first.id,revision:first.revision},proposed:proposed({content:'QA虚构：改为整理工具箱。'}),allowReplacement:true});
  await assert.rejects(service.commit(update,f.context),/edit acknowledgement lost/);
  const recovered=await service.commit(update,f.context);assert.equal(recovered.recovered,true);assert.equal(edits,1);assert.equal(f.memory.notes.size,2);
  const history=(await service.list({validity:'historical'},f.context)).entries;
  assert.equal(history.length,1);assert.equal(history[0].sourceStatus.manualBody,false);assert.equal(history[0].content,proposed().content);
});

test('a malformed or replaced note is reported without hiding other valid query results',async t=>{
  const f=await fixture(t),service=f.make(),one=await service.commit(f.input('broken-one'),f.context),two=await service.commit(f.input('good-two'),f.context);
  f.memory.notes.get(one.permalink).frontmatter.memory_entry_id='another-note-identity';
  await assert.rejects(service.read(one.id,f.context),{code:'MEMORY_ENTRY_ID_CHANGED'});
  const result=await service.list({type:'plan'},f.context);assert.equal(result.entries.length,1);assert.equal(result.entries[0].id,two.id);assert.equal(result.errors.length,1);
  await assert.rejects(service.list({type:'history'},f.context),/Invalid structured entry type/);
});

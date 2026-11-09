import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSemanticEntry,resolveMemoryEntryState,memoryEntryMetadata,readMemoryEntry,customNoteMetadata} from '../lib/memory-entry.js';

const sources=new Map([['s1',{id:'dsh:session-a:user-a',revision:3,role:'user'}],['s2',{id:'dsh:session-a:assistant-a',revision:1,role:'assistant'}]]);
const subjects=new Map([['u1','owner:one'],['a1','assistant:one']]);
const plan=(patch={})=>({type:'plan',content:'下个月开始练习；周末有空才进行。',subject_ref:'u1',source_refs:['s1'],state:{validity:'current',progress:'planned'},tags:['建模'],importance:{level:'high',basis:'user_explicit',reason:'用户明确表示重要'},...patch});

test('one semantic item resolves supplied identities while retaining conditions and source roles',()=>{
  const entry=normalizeSemanticEntry(plan(),{sources,subjects});
  assert.equal(entry.content,'下个月开始练习；周末有空才进行。');assert.equal(entry.subject_ref,'owner:one');
  assert.deepEqual(entry.source_refs,[{id:'dsh:session-a:user-a',revision:3,role:'user'}]);
  assert.equal(entry.state.progress,'planned');assert.equal(entry.importance.level,'high');
  const inferred=normalizeSemanticEntry(plan({type:'reflection',subject_ref:'a1',source_refs:['s2'],evidence_basis:'inferred',inferred_by_ref:'a1',state:null,importance:null}),{sources,subjects});
  assert.equal(inferred.inferred_by_ref,'assistant:one');assert.equal(inferred.source_refs[0].role,'assistant');assert.equal(inferred.evidence_basis,'inferred');
  assert.throws(()=>normalizeSemanticEntry(plan({evidence_basis:'inferred'}),{sources,subjects}),/推断主体/);
  assert.equal(inferred.state.validity,'unverified');assert.equal(inferred.importance,null);
  assert.throws(()=>normalizeSemanticEntry(plan({source_refs:['invented']}),{sources,subjects}),{code:'INVALID_MEMORY_ENTRY'});
  assert.throws(()=>normalizeSemanticEntry(plan({subject_ref:'invented'}),{sources,subjects}),{code:'INVALID_MEMORY_ENTRY'});
});

test('completion does not lower importance or erase validity and null proposals keep prior judgments',()=>{
  const previous=normalizeSemanticEntry(plan(),{sources,subjects});
  const completed=normalizeSemanticEntry(plan({state:{progress:'completed'},importance:null}),{sources,subjects,previous});
  assert.deepEqual(completed.state,{validity:'current',progress:'completed'});assert.deepEqual(completed.importance,previous.importance);
  assert.deepEqual(resolveMemoryEntryState(null,completed.state),completed.state);
  assert.deepEqual(resolveMemoryEntryState(null,null,{type:'goal'}),{validity:'unverified',progress:'unknown'});
  assert.throws(()=>normalizeSemanticEntry(plan({state:'current'}),{sources,subjects}),{code:'INVALID_MEMORY_ENTRY'});
});

test('metadata round trip preserves manual fields while the actual Markdown body remains authoritative',()=>{
  const entry=normalizeSemanticEntry(plan(),{sources,subjects});
  const metadata=memoryEntryMetadata(entry,{type:'note',title:'旧笔记标题',permalink:'old/path',embed:true,manual_priority:'defer',obsidian_custom:'手工保留',base_priority:0.25,value:'过期缓存'});
  assert.deepEqual(customNoteMetadata({embed:true,manual_key:'保留',type:'旧类型'}),{manual_key:'保留'});
  assert.equal(metadata.obsidian_custom,'手工保留');assert.equal(metadata.manual_priority,'defer');assert.equal(metadata.base_priority,0.25);
  assert.equal(metadata.embed,false);
  assert.equal(metadata.memory_type,'plan');assert.equal('type' in metadata,false);assert.equal('title' in metadata,false);assert.equal('permalink' in metadata,false);
  assert.equal(metadata.state_validity,'current');assert.equal(metadata.state_progress,'planned');
  const read=readMemoryEntry({metadata,content:'人手修改后的条件：周末不再练习。',legacyKind:'fact',legacyStatus:'active'});
  assert.equal('embed' in read,false);
  assert.equal(read.content,'人手修改后的条件：周末不再练习。');assert.equal(read.type,'plan');assert.deepEqual(read.importance,entry.importance);
  assert.deepEqual(read.source_refs,entry.source_refs);assert.deepEqual(read.tags,['建模']);assert.equal(read.legacy,false);
});

test('legacy history is not invented as a thirteenth type or assigned importance from its old priority',()=>{
  const read=readMemoryEntry({content:'以前的原文。',metadata:{base_priority:0.01},legacyKind:'history',legacyStatus:'history'});
  assert.equal(read.type,null);assert.equal(read.state.validity,'historical');assert.equal(read.importance,null);assert.equal(read.legacy,true);
  assert.equal(readMemoryEntry({content:'旧正文',metadata:{type:'note'},legacyKind:'fact',legacyStatus:'active'}).type,'fact');
  assert.throws(()=>readMemoryEntry({content:'手改正文',metadata:{memory_type:'not_a_type'}}),{code:'INVALID_MEMORY_ENTRY'});
});

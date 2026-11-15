import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {convertLegacyVault} from '../lib/inherit/vault.js';

const ENTRY_START='<!-- dsh-memory-entry:start -->';
const ENTRY_END='<!-- dsh-memory-entry:end -->';

async function write(vault,relative,content) {
  const file=path.join(vault,...relative.split('/'));
  await fs.mkdir(path.dirname(file),{recursive:true});
  await fs.writeFile(file,content);
  return file;
}

function note(metadata,body='') {
  const lines=['---'];
  for(const [key,value] of Object.entries(metadata)) {
    if(Array.isArray(value)) lines.push(key+':',...value.map(item=>'- '+item));
    else lines.push(key+': '+value);
  }
  lines.push('---','',body);
  return lines.join('\n');
}

function appendField(lines,key,value) {
  if(value===undefined) return;
  if(Array.isArray(value)) {
    lines.push(key+':');
    for(const item of value) lines.push('  - '+JSON.stringify(item));
    return;
  }
  lines.push(key+': '+JSON.stringify(value));
}

function renderedNote({title,type='note',permalink,metadata={},tags=[],content=''}) {
  const lines=['---'];
  appendField(lines,'title',title);
  appendField(lines,'type',type);
  appendField(lines,'permalink',permalink);
  for(const [key,value] of Object.entries(metadata)) {
    if(['title','type','permalink','tags'].includes(key)) continue;
    appendField(lines,key,value);
  }
  appendField(lines,'tags',tags);
  lines.push('---');
  return lines.join('\n')+'\n\n'+String(content);
}

function entryNote(vault,relative,{
  title='虚构条目',
  metadata={},
  managed='条目正文',
  topics=['虚构主题'],
  supplement='',
  tags=['dsh-memory'],
  rawContent=null,
}={}) {
  const content=rawContent??[
    '# '+title,
    '',
    ENTRY_START,
    managed,
    ENTRY_END,
    ...(topics.length?['主题：'+topics.map(name=>'[['+name+']]').join(' ')]:[]),
    ...(supplement?[supplement]:[]),
  ].join('\n');
  return write(vault,relative,renderedNote({
    title,
    permalink:'main/'+relative.replace(/\.md$/u,''),
    metadata:{
      embed:false,
      memory_entry_schema:'memory-entry-v1',
      memory_entry_id:'fixture-'+path.posix.basename(relative,'.md'),
      memory_type:'fact',
      subject_ref:'',
      memory_source_refs:JSON.stringify([]),
      state_validity:'current',
      state_progress:'',
      importance:'null',
      ...metadata,
    },
    tags,
    content,
  }));
}

function topicNote(vault,relative,name,supplement='') {
  const fixed='# '+name+'\n\n本页由记忆框架自动维护，可在下方自由补充\n';
  return write(vault,relative,renderedNote({
    title:name,
    permalink:'main/'+relative.replace(/\.md$/u,''),
    metadata:{embed:false},
    tags:['dsh-topic'],
    content:fixed+(supplement?supplement+'\n':''),
  }));
}

test('0.3 conversion keeps the exact record bytes and source files untouched',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const valueFile=await write(root,'chats/facts/value.md',note({
    memory_id:'fact-one',
    memory_kind:'fact',
    subject:'虚构主体',
    attribute:'虚构属性',
    value:'文件头里的正文',
    recorded_at:'2026-10-25T04:21:07.668Z',
    tags:['原有标签'],
  },'正文区不应覆盖 value'));
  const bodyFile=await write(root,'chats/events/body.md',note({
    memory_id:'event-one',
    memory_kind:'event',
    type:'event',
    created:'2026-10-26',
  },'正文部分原样保留'));
  const withoutId=await write(root,'chats/history/no-id.md',note({title:'no id'},'不导入'));
  const bad=await write(root,'chats/review/bad.md','---\ntitle: broken\nmetadata:\n  nested: value\n---\n正文');
  const empty=await write(root,'chats/review/empty.md',note({memory_id:'empty-one',value:''},''));
  const selected=[valueFile,bodyFile,withoutId,bad,empty];
  const before=await Promise.all(selected.map(async file=>({
    file,content:await fs.readFile(file),stat:await fs.stat(file),
  })));

  const result=await convertLegacyVault(root,{now:new Date('2026-11-15T10:00:00Z')});
  assert.equal(result.scanned,5);
  assert.equal(result.records.length,2);
  const value=result.records.find(record=>record.id==='chats/facts/value.md');
  const body=result.records.find(record=>record.id==='chats/events/body.md');
  assert.equal(JSON.stringify(value),JSON.stringify({
    id:'chats/facts/value.md',
    speaker:'summary',
    kind:'note',
    text:'文件头里的正文',
    source:{system:'basic-memory-0.3',file:'chats/facts/value.md'},
    time:'2026-10-25T04:21:07.668Z',
    tags:['原有标签','subject:虚构主体','attribute:虚构属性','memory_kind:fact'],
  }));
  assert.equal(JSON.stringify(body),JSON.stringify({
    id:'chats/events/body.md',
    speaker:'summary',
    kind:'note',
    text:'正文部分原样保留',
    source:{system:'basic-memory-0.3',file:'chats/events/body.md'},
    time:'2026-10-26',
    tags:['memory_kind:event','type:event'],
  }));
  assert.deepEqual(result.conversion.basicMemory03,{imported:2,skipped:2});
  assert.deepEqual(result.conversionSkipped.map(item=>item.file),[
    'chats/review/bad.md','chats/review/empty.md',
  ]);
  const after=await Promise.all(before.map(async saved=>({
    file:saved.file,content:await fs.readFile(saved.file),stat:await fs.stat(saved.file),
  })));
  for(const [index,saved] of after.entries()) {
    assert.deepEqual(saved.content,before[index].content);
    assert.equal(saved.stat.mtimeMs,before[index].stat.mtimeMs);
  }
});

test('long 0.3 notes and 0.6 entries split only at preserved boundaries',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-long-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const first='甲'.repeat(12_000),second='乙'.repeat(12_000),body=first+'\n\n'+second;
  await write(root,'chats/facts/long.md',note({memory_id:'long-one',recorded_at:'2026-10-27'},body));
  await write(root,'chats/facts/unbroken.md',note({memory_id:'unbroken-one'},'丙'.repeat(20_001)));
  await entryNote(root,'chats/entries/long.md',{
    title:'长条目',
    metadata:{memory_type:'plan',state_progress:'planned'},
    managed:body,
    topics:[],
  });
  const result=await convertLegacyVault(root);
  assert.equal(result.records.length,4);
  const legacy=result.records.filter(record=>record.source.system==='basic-memory-0.3');
  const entry=result.records.filter(record=>record.source.system==='basic-memory-0.6');
  assert.deepEqual(legacy.map(record=>record.part),[1,2]);
  assert.deepEqual(entry.map(record=>record.part),[1,2]);
  assert.deepEqual(legacy.map(record=>record.id),[
    'chats/facts/long.md#part-1','chats/facts/long.md#part-2',
  ]);
  assert.deepEqual(entry.map(record=>record.id),[
    'fixture-long#part-1','fixture-long#part-2',
  ]);
  assert.equal(legacy.map(record=>record.text).join(''),body);
  assert.equal(entry.map(record=>record.text).join(''),body);
  assert.equal(result.conversion.basicMemory03.imported,1);
  assert.equal(result.conversion.entries.imported,1);
  assert.deepEqual(result.conversionSkipped,[{
    file:'chats/facts/unbroken.md',
    reason:'正文超过 20000 字，且找不到可保留原文的段落边界',
  }]);
});

test('0.6 entries keep managed and user text while excluding title and topic lines',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-entry-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await entryNote(root,'chats/entries/current.md',{
    title:'当前条目',
    metadata:{
      memory_type:'plan',
      state_validity:'disputed',
      state_progress:'planned',
      evidence_basis:'observed',
      occurred_at:'2026-10-20',
      recorded_at:'2026-10-21T02:03:04Z',
    },
    tags:['原有标签','dsh-memory'],
    managed:'受管正文。',
    topics:['工作','夜班'],
    supplement:'用户补写：保留这一句。',
  });
  await entryNote(root,'chats/entries/missing.md',{
    title:'缺标记',
    rawContent:'# 缺标记\n\n没有受管正文标记',
  });
  await entryNote(root,'chats/entries/duplicate-start.md',{
    title:'重复开始标记',
    rawContent:['# 重复开始标记','',ENTRY_START,'第一段',ENTRY_START,'第二段',ENTRY_END].join('\n'),
  });
  await entryNote(root,'chats/entries/duplicate-end.md',{
    title:'重复结束标记',
    rawContent:['# 重复结束标记','',ENTRY_START,'第一段',ENTRY_END,ENTRY_END].join('\n'),
  });

  const result=await convertLegacyVault(root);
  assert.equal(result.records.length,1);
  const record=result.records[0];
  assert.equal(record.id,'fixture-current');
  assert.equal(record.text,'受管正文。\n\n用户补写：保留这一句。');
  assert.equal(record.time,'2026-10-21T02:03:04Z');
  assert.deepEqual(record.source,{system:'basic-memory-0.6',file:'chats/entries/current.md'});
  assert.deepEqual(record.tags,[
    '原有标签','dsh-memory',
    'memory_type:plan','state_validity:disputed','state_progress:planned',
    'evidence_basis:observed','occurred_at:2026-10-20',
  ]);
  assert.deepEqual(result.conversion.entries,{
    imported:1,
    skipped:3,
    skippedByReason:{
      '正文标记缺失':1,
      '正文标记重复':2,
    },
  });
  assert.deepEqual(result.conversionSkipped.map(item=>[item.file,item.reason]),[
    ['chats/entries/duplicate-end.md','正文标记重复'],
    ['chats/entries/duplicate-start.md','正文标记重复'],
    ['chats/entries/missing.md','正文标记缺失'],
  ]);
});

test('derived entries are skipped by default and included explicitly',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-derived-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await entryNote(root,'chats/entries/derived.md',{
    title:'对话整理',
    metadata:{
      memory_source_refs:JSON.stringify([{id:'raw-one',revision:1,role:'user'}]),
      evidence_basis:'observed',
    },
    managed:'由对话整理出的摘要。',
    topics:[],
  });
  await entryNote(root,'chats/entries/no-source.md',{
    title:'没有来源',
    metadata:{memory_source_refs:JSON.stringify([]),evidence_basis:'inferred'},
    managed:'没有原话来源，照常导入。',
    topics:[],
  });
  await entryNote(root,'chats/entries/manual.md',{
    title:'手写条目',
    metadata:{
      memory_source_refs:JSON.stringify([{id:'raw-two',revision:1,role:'assistant'}]),
      evidence_basis:'manual',
      state_validity:'historical',
    },
    managed:'手写依据的条目。',
    topics:[],
  });

  const defaultResult=await convertLegacyVault(root);
  assert.deepEqual(defaultResult.records.map(record=>record.source.file).sort(),[
    'chats/entries/manual.md','chats/entries/no-source.md',
  ]);
  assert.equal(defaultResult.conversion.entries.imported,2);
  assert.equal(defaultResult.conversion.entries.skipped,1);
  assert.deepEqual(defaultResult.conversion.entries.skippedByReason,{
    '由对话整理而来，原话已在原话库':1,
  });
  assert.deepEqual(defaultResult.conversionSkipped,[{
    file:'chats/entries/derived.md',
    reason:'由对话整理而来，原话已在原话库',
  }]);
  assert.ok(defaultResult.records.find(record=>record.source.file.endsWith('manual.md')).tags
    .includes('state_validity:historical'));

  const included=await convertLegacyVault(root,{includeDerived:true});
  assert.equal(included.records.length,3);
  assert.equal(included.conversion.entries.imported,3);
  assert.equal(included.conversion.entries.skipped,0);
});

test('an entry migrated from 0.3 replaces its source note in the same scan',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-replaced-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await write(root,'chats/facts/legacy.md',note({
    memory_id:'legacy-one',
    memory_kind:'fact',
    value:'旧摘要',
    created:'2026-10-20',
  },''));
  await entryNote(root,'chats/entries/replacement.md',{
    title:'更新后的条目',
    metadata:{
      memory_source_refs:JSON.stringify([]),
      evidence_basis:'manual',
      legacy_import_from:JSON.stringify({
        kind:'legacy-note',
        memoryId:'legacy-one',
        path:'chats/facts/legacy.md',
        checksum:'fixture-checksum',
      }),
      created:'2026-10-22',
    },
    managed:'更新后的正文。',
    topics:[],
  });

  const result=await convertLegacyVault(root);
  assert.deepEqual(result.records.map(record=>record.source.file),['chats/entries/replacement.md']);
  assert.equal(result.records[0].time,'2026-10-22');
  assert.equal(result.conversion.entries.imported,1);
  assert.equal(result.conversion.replacedBasicMemory03.skipped,1);
  assert.equal(result.conversion.basicMemory03.imported,0);
  assert.deepEqual(result.conversionSkipped,[{
    file:'chats/facts/legacy.md',
    reason:'已由新版条目接替',
  }]);
});

test('topic supplements import alone while fixed pages and entry history skip',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-topics-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await topicNote(root,'chats/topics/固定.md','固定');
  await topicNote(root,'chats/topics/补充.md','补充','用户补充：主题页只导入这一句。');
  await entryNote(root,'chats/history/条目存档.md',{
    title:'历史条目',
    metadata:{
      memory_type:'fact',
      state_validity:'historical',
      memory_parent_id:'fixture-parent',
    },
    managed:'条目旧正文',
    topics:[],
  });
  await write(root,'chats/history/0.3.md',note({
    memory_id:'history-03',
    memory_kind:'history',
    value:'0.3 历史正文',
    recorded_at:'2026-10-23',
  },''));

  const result=await convertLegacyVault(root);
  assert.equal(result.records.length,2);
  const topic=result.records.find(record=>record.source.file==='chats/topics/补充.md');
  assert.equal(topic.text,'用户补充：主题页只导入这一句。');
  assert.deepEqual(topic.tags,['topic:补充']);
  assert.equal(topic.source.system,'basic-memory-0.6');
  const history=result.records.find(record=>record.source.file==='chats/history/0.3.md');
  assert.equal(history.text,'0.3 历史正文');
  assert.equal(history.source.system,'basic-memory-0.3');
  assert.deepEqual(result.conversion.topics,{
    imported:1,
    skipped:1,
    skippedByReason:{'主题页固定内容':1},
  });
  assert.deepEqual(result.conversion.entryHistory,{skipped:1});
  assert.deepEqual(result.conversionSkipped,[
    {file:'chats/history/条目存档.md',reason:'条目旧版本存档'},
    {file:'chats/topics/固定.md',reason:'主题页固定内容'},
  ]);
});

test('conversion ignores dafeiyu, index, chats/other and unlisted Vault directories',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-scope-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await write(root,'chats/facts/kept.md',note({memory_id:'kept',value:'保留'},''));
  await write(root,'dafeiyu/diary/ignored.md',note({memory_id:'diary',value:'不导入'},''));
  await write(root,'index/topic.md',note({memory_id:'topic',value:'不导入'},''));
  await write(root,'chats/other/ignored.md',renderedNote({
    title:'别处条目',
    metadata:{memory_entry_schema:'memory-entry-v1',memory_entry_id:'other'},
    tags:[],
    content:ENTRY_START+'\n不导入\n'+ENTRY_END,
  }));
  const result=await convertLegacyVault(root);
  assert.deepEqual(result.records.map(record=>record.id),['chats/facts/kept.md']);
  assert.equal(result.scanned,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {convertLegacyVault} from '../lib/inherit/vault.js';

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

test('0.3 value/body and recorded_at/created conversion keeps source files untouched',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const valueFile=await write(root,'chats/facts/value.md',note({
    memory_id:'fact-one',memory_kind:'fact',subject:'虚构主体',attribute:'虚构属性',value:'文件头里的正文',recorded_at:'2026-10-25T04:21:07.668Z'
  },'正文区不应覆盖 value'));
  const bodyFile=await write(root,'chats/events/body.md',note({
    memory_id:'event-one',memory_kind:'event',type:'event',created:'2026-10-26'
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
  assert.equal(value.text,'文件头里的正文');
  assert.equal(value.time,'2026-10-25T04:21:07.668Z');
  assert.equal(value.speaker,'summary');
  assert.equal(value.kind,'note');
  assert.deepEqual(value.source,{system:'basic-memory-0.3',file:'chats/facts/value.md'});
  assert.ok(value.tags.includes('subject:虚构主体'));
  assert.ok(value.tags.includes('attribute:虚构属性'));
  assert.ok(value.tags.includes('memory_kind:fact'));
  const body=result.records.find(record=>record.id==='chats/events/body.md');
  assert.equal(body.text,'正文部分原样保留');
  assert.equal(body.time,'2026-10-26');
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

test('long 0.3 notes split only at preserved paragraph boundaries and use part ids',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-long-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const first='甲'.repeat(12_000),second='乙'.repeat(12_000),body=first+'\n\n'+second;
  await write(root,'chats/facts/long.md',note({memory_id:'long-one',recorded_at:'2026-10-27'},body));
  await write(root,'chats/facts/unbroken.md',note({memory_id:'unbroken-one'},'丙'.repeat(20_001)));
  const result=await convertLegacyVault(root);
  assert.equal(result.records.length,2);
  assert.deepEqual(result.records.map(record=>record.part),[1,2]);
  assert.deepEqual(result.records.map(record=>record.id),[
    'chats/facts/long.md#part-1','chats/facts/long.md#part-2',
  ]);
  assert.equal(result.records.map(record=>record.text).join(''),body);
  assert.deepEqual(result.conversionSkipped,[{
    file:'chats/facts/unbroken.md',
    reason:'正文超过 20000 字，且找不到可保留原文的段落边界',
  }]);
});

test('conversion ignores dafeiyu, index and unlisted Vault directories',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'inherit-vault-scope-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await write(root,'chats/facts/kept.md',note({memory_id:'kept',value:'保留'},''));
  await write(root,'dafeiyu/diary/ignored.md',note({memory_id:'diary',value:'不导入'},''));
  await write(root,'index/topic.md',note({memory_id:'topic',value:'不导入'},''));
  await write(root,'chats/other/ignored.md',note({memory_id:'other',value:'不导入'},''));
  const result=await convertLegacyVault(root);
  assert.deepEqual(result.records.map(record=>record.id),['chats/facts/kept.md']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  inheritHeader,
  inheritReport,
  isInheritTime,
  readInheritJsonl,
  splitInheritText,
  writeInheritJsonl,
} from '../lib/inherit/format.js';

async function fixture(t,name='inherit-format-') {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),name));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  return directory;
}

test('JSONL validation reports line, field, cause and correction while listing unknown fields',async t=>{
  const directory=await fixture(t),file=path.join(directory,'bad.jsonl');
  const records=[
    {speaker:'summary',kind:'note',source:{system:'fixture',file:'a.md'}},
    {speaker:'owner',kind:'unknown',text:'正文',source:{system:'',file:'',extra:true},time:'2026-13-40',id:7,conversation:2,order:-1,part:0,tags:[1],mystery:true},
    {speaker:'user',kind:'message',text:'x'.repeat(20_001),source:{system:'fixture',file:'b.md'}},
  ];
  await fs.writeFile(file,[JSON.stringify(inheritHeader()),...records.map(value=>JSON.stringify(value))].join('\n'));
  const parsed=await readInheritJsonl(file);
  assert.equal(parsed.errors.some(error=>error.line===2&&error.field==='text'),true);
  for(const field of ['speaker','kind','source.system','source.file','time','id','conversation','order','part','tags']) {
    assert.equal(parsed.errors.some(error=>error.line===3&&error.field===field),true,field);
  }
  assert.equal(parsed.errors.some(error=>error.line===4&&error.field==='text'),true);
  assert.ok(parsed.errors.every(error=>error.problem&&error.fix));
  assert.deepEqual(parsed.unknownFields,[
    {field:'mystery',count:1},
    {field:'source.extra',count:1},
  ]);
  const report=inheritReport(parsed.records,{source:parsed.file,errors:parsed.errors,unknownFields:parsed.unknownFields,header:parsed.header});
  assert.equal(report.ok,false);
  assert.equal(report.summary.total,3);
  assert.equal(report.summary.byKind.note,1);
  assert.equal(report.summary.bySpeaker.summary,1);
});

test('valid JSONL is canonicalized, counted, estimated and written atomically',async t=>{
  const directory=await fixture(t),file=path.join(directory,'valid.jsonl'),out=path.join(directory,'out.jsonl');
  const header=inheritHeader('fixture','2026-11-15T10:00:00+08:00');
  const records=[
    {id:'a',time:'2026-10-25',speaker:'summary',kind:'note',text:'旧笔记正文',source:{system:'basic-memory-0.3',file:'chats/a.md'},ignored:'drop'},
    {time:'2026-10-26T10:00:00+08:00',speaker:'user',kind:'message',text:'用户原话',source:{system:'fixture',file:'u'}},
    {time:'2026-10-27T10:00:00Z',speaker:'assistant',kind:'message',text:'助手原话',source:{system:'fixture',file:'a'}},
  ];
  await fs.writeFile(file,[JSON.stringify(header),...records.map(value=>JSON.stringify(value))].join('\n'));
  const parsed=await readInheritJsonl(file);
  assert.deepEqual(parsed.errors,[]);
  assert.deepEqual(parsed.unknownFields,[{field:'ignored',count:1}]);
  assert.equal('ignored' in parsed.records[0],false);
  const report=inheritReport(parsed.records,{header:parsed.header,unknownFields:parsed.unknownFields});
  assert.deepEqual(report.summary.byKind,{message:2,note:1});
  assert.deepEqual(report.summary.bySpeaker,{assistant:1,summary:1,user:1});
  assert.deepEqual(report.summary.timeRange,{from:'2026-10-25',to:'2026-10-27T10:00:00Z'});
  assert.equal(report.summary.withoutTime,0);
  assert.equal(report.estimatedEmbedding.records,3);
  assert.equal(report.estimatedEmbedding.characters,13);
  await writeInheritJsonl(out,header,parsed.records);
  const lines=(await fs.readFile(out,'utf8')).trim().split(/\r?\n/).map(line=>JSON.parse(line));
  assert.deepEqual(lines[0],header);
  assert.equal(lines.length,4);
  assert.equal(lines[1].source.file,'chats/a.md');
});

test('empty lines, malformed JSON, invalid headers and time-zone-less times are explicit errors',async t=>{
  const directory=await fixture(t),file=path.join(directory,'syntax.jsonl');
  await fs.writeFile(file,[
    JSON.stringify({standard:'wrong',version:2}),
    '',
    '{not json}',
    JSON.stringify({speaker:'summary',kind:'note',text:'正文',source:{system:'s',file:'f'},time:'2026-11-15T10:00:00'}),
  ].join('\n'));
  const parsed=await readInheritJsonl(file);
  assert.equal(parsed.errors.some(error=>error.line===1&&error.field==='standard'),true);
  assert.equal(parsed.errors.some(error=>error.line===1&&error.field==='version'),true);
  assert.equal(parsed.errors.some(error=>error.line===2),true);
  assert.equal(parsed.errors.some(error=>error.line===3&&error.field==='$'),true);
  assert.equal(parsed.errors.some(error=>error.line===4&&error.field==='time'),true);
  assert.equal(isInheritTime('2026-02-29'),false);
  assert.equal(isInheritTime('2028-02-29'),true);
});

test('size and record limits reject before reading the whole body',async t=>{
  const directory=await fixture(t),large=path.join(directory,'large.jsonl'),many=path.join(directory,'many.jsonl');
  await fs.writeFile(large,'');
  await fs.truncate(large,50*1024*1024+1);
  await assert.rejects(()=>readInheritJsonl(large),/超过 50MB/u);

  const header=JSON.stringify(inheritHeader());
  const line=JSON.stringify({speaker:'summary',kind:'note',text:'x',source:{system:'fixture',file:'f'}});
  await fs.writeFile(many,[header,...Array.from({length:3},()=>line)].join('\n'));
  const parsed=await readInheritJsonl(many,{maxRecords:2});
  assert.equal(parsed.errors.some(error=>error.field==='$'&&/记录数超过/u.test(error.problem)),true);
});

test('long note splitting keeps every source character and refuses unbroken overlong text',()=>{
  const first='甲'.repeat(12_000),second='乙'.repeat(12_000),source=first+'\n\n'+second;
  const parts=splitInheritText(source);
  assert.equal(parts.length,2);
  assert.ok(parts.every(part=>Array.from(part).length<=20_000));
  assert.equal(parts.join(''),source);
  assert.equal(splitInheritText('丙'.repeat(20_001)),null);
});

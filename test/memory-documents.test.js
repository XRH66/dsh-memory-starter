import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMemoryDocuments} from '../lib/memory-documents.js';
import {createUnifiedStateStore} from '../lib/unified/state-store.js';

async function fixture(t,project='main'){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-documents-'));
  const grant={kind:'management',project,ownerSubject:'fictional-owner'};
  const listed=[],notes=new Map(),reads=[];
  const tools={get(name){return {async execute(args){
    assert.equal(args.project,project);
    if(name==='mcp__basic_memory__list_directory'){
      return {structuredContent:{result:{nodes:listed.filter(row=>row.directory===args.dir_name)}}};
    }
    assert.equal(name,'mcp__basic_memory__read_note');
    reads.push(args);
    return {structuredContent:{result:notes.get(args.identifier)??{error:'NOTE_NOT_FOUND'}}};
  }};}};
  const raw={
    messageReader:()=>({list:()=>({sources:[]})}),
    queryReader:()=>({legacyPage:()=>({sources:[]})}),
    querySourceState:()=>({state:'live'}),
  };
  const documents=createMemoryDocuments({directory,tools,raw,config:{captureFolder:'chats'},authorize:value=>value===grant,agentForGrant:()=>null});
  t.after(async()=>{await documents.close();await fs.rm(directory,{recursive:true,force:true});});
  function add(permalink,filePath,{directory='chats/facts',frontmatter={}}={}){
    const note={permalink,file_path:filePath,frontmatter,content:'Fictional note',checksum:'fictional-v1'};
    listed.push({type:'file',directory,permalink,file_path:filePath});
    notes.set(filePath,note);
    return note;
  }
  return {documents,grant,listed,notes,reads,add,
    async list(){const rows=[];for await(const row of documents.listDocuments({grant}))rows.push(row);return rows;},
    resolve:({id,revision})=>documents.resolveDocument({grant,id,revision}),
  };
}

test('main indexes and reopens migrated notes by file path while keeping their identities and sources',async t=>{
  const f=await fixture(t);
  const fact=f.add('personal/chats/facts/a-stable-slug','chats/facts/Current title.md',{
    frontmatter:{memory_id:'fictional-fact',memory_kind:'fact',value:'Fictional note',source_message_id:'fictional-message'},
  });
  const diary=f.add('personal/dafeiyu/thoughts/a-stable-slug','dafeiyu/diary/Current title.md',{directory:'dafeiyu/diary'});
  const rows=await f.list();
  assert.deepEqual(rows.map(row=>[row.id,row.domain]),[
    ['legacy-note:fictional-fact','fact'],['document:'+encodeURIComponent(diary.permalink),'diary'],
  ]);
  const [saved]=rows;
  assert.deepEqual(saved.sourceIds,['fictional-message']);
  assert.equal(saved.identifier,fact.permalink);
  assert.equal(saved.anchor.ref.identifier,fact.permalink);
  assert.equal((await f.resolve(saved)).source.permalink,fact.permalink);
  assert.ok(f.reads.every(args=>args.identifier===args.known_file_path));

  // A temporary omission from the directory catalogue still checks the known file.
  f.listed.shift();
  assert.ok((await f.list()).some(row=>row.id===saved.id));
  for(const change of [{file_path:'chats/facts/Other.md'},{permalink:'other/chats/facts/a-stable-slug'}]){
    f.notes.set(fact.file_path,{...fact,...change});
    assert.equal(await f.resolve(saved),null);
  }
  f.notes.set(fact.file_path,{...fact,frontmatter:{...fact.frontmatter,source_hidden:true}});
  assert.equal(await f.resolve(saved),null);
});

test('migration is limited to main, permitted vault paths and explicit selections',async t=>{
  const f=await fixture(t);
  f.add('other/chats/facts/wrong-namespace','chats/facts/Wrong namespace.md');
  for(const [i,filePath] of [
    undefined,'main/chats/facts/Project prefix.md','personal/chats/facts/Project prefix.md',
    'chats/facts/../Outside.md','chats\\facts\\..\\Outside.md','chats/facts/.. /Outside.md','chats/facts/Note:stream.md',
    '/chats/facts/Absolute.md',path.win32.resolve('C:', '/chats/facts/Absolute.md'),
  ].entries())f.add('personal/chats/facts/unsafe-'+i,filePath);
  f.add('personal/chats/facts/private','manual/Chosen.md');
  f.add('personal/chats/facts/fixture','chats/facts/Fixture.md',{frontmatter:{qa_fixture:true}});

  assert.deepEqual(await f.list(),[]);
  assert.deepEqual(f.reads.map(args=>args.identifier),['chats/facts/Fixture.md']);
  await f.documents.selectDocuments({grant:f.grant,identifiers:['manual/Chosen.md']});
  const [selected]=await f.list();
  assert.equal(selected.source.permalink,'personal/chats/facts/private');
  assert.equal((await f.resolve(selected)).text,'Fictional note');
  await f.documents.selectDocuments({grant:f.grant,identifiers:[]});
  assert.equal(await f.resolve(selected),null);

  const other=await fixture(t,'other');
  other.add('personal/chats/facts/legacy','chats/facts/Legacy.md');
  assert.deepEqual(await other.list(),[]);
  assert.deepEqual(other.reads,[]);
});

test('selected metadata reads wait for committed changes and do not expose mutable store objects',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'selected-state-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const store=createUnifiedStateStore({file:path.join(directory,'state.json'),initial:()=>({rows:[{id:'one',revision:1}],other:Array(500).fill('unrelated metadata')})});
  let release,entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const hold=new Promise(resolve=>{release=resolve;});
  const write=store.update(async state=>{entered();await hold;state.rows[0].revision=2;});
  await started;
  const selected=store.read(state=>state.rows.find(row=>row.id==='one'));
  release();await write;
  const row=await selected;assert.deepEqual(row,{id:'one',revision:2});
  row.revision=999;
  assert.equal(store.snapshot(state=>state.rows[0].revision),2);
  const snapshot=store.snapshot(state=>state.rows[0]);snapshot.id='changed';
  assert.equal((await store.read(state=>state.rows[0])).id,'one');
});

test('catalogue point lookups follow a committed rescan and return independent metadata',async t=>{
  const f=await fixture(t),note=f.add('personal/chats/facts/point-note','chats/facts/Point note.md');
  const [first]=await f.list();
  const metadata=f.documents.getMetadata({...first,grant:f.grant});
  metadata.anchor.ref.identifier='mutated-locator';
  assert.notEqual(f.documents.getMetadata({...first,grant:f.grant}).anchor.ref.identifier,'mutated-locator');
  note.checksum='fictional-v2';note.content='Updated fictional body';
  const [second]=await f.list();
  assert.equal(f.documents.getMetadata({...first,grant:f.grant}),null);
  assert.equal((await f.resolve(first)),null);
  assert.equal((await f.resolve(second)).text,'Updated fictional body');
});

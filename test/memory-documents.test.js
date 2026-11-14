import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMemoryDocuments} from '../lib/memory-documents.js';
import {createUnifiedStateStore} from '../lib/storage/state-store.js';
import {vaultMemoryStore} from './vault-memory.js';

function yamlValue(value){
  if(typeof value==='string')return JSON.stringify(value);
  if(typeof value==='number'||typeof value==='boolean')return String(value);
  return JSON.stringify(String(value));
}

async function writeNote(vault,filePath,{title,permalink,frontmatter={},content='Fictional note'}={}){
  const full=path.join(vault,filePath);
  await fs.mkdir(path.dirname(full),{recursive:true});
  const lines=['---','title: '+JSON.stringify(title??path.posix.basename(filePath,'.md')),'permalink: '+JSON.stringify(permalink)];
  for(const [key,value] of Object.entries(frontmatter)){
    if(Array.isArray(value)){
      lines.push(key+':');
      for(const item of value)lines.push('  - '+JSON.stringify(String(item)));
    }else lines.push(key+': '+yamlValue(value));
  }
  lines.push('---','',content);
  await fs.writeFile(full,lines.join('\n'));
}

async function fixture(t,project='main'){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-documents-'));
  const vault=path.join(directory,'vault');
  await fs.mkdir(vault);
  const store=await vaultMemoryStore({vault,project});
  const grant={kind:'management',project,ownerSubject:'fictional-owner'};
  const control={omit:null};
  const backend={...store.backend,async list(directory,context){
    return (await store.backend.list(directory,context)).filter(node=>node.file_path!==control.omit);
  }};
  const raw={
    messageReader:()=>({list:()=>({sources:[]})}),
    queryReader:()=>({legacyPage:()=>({sources:[]})}),
    querySourceState:()=>({state:'live'}),
  };
  const documents=createMemoryDocuments({directory,tools:{},vaultBackend:backend,raw,
    config:{captureFolder:'chats',vaultPath:vault},authorize:value=>value===grant,agentForGrant:()=>null});
  t.after(async()=>{await documents.close();await fs.rm(directory,{recursive:true,force:true});});
  async function add(permalink,filePath,{directory='chats/facts',frontmatter={},content='Fictional note',title}={}){
    await writeNote(vault,filePath,{title,permalink,frontmatter,content});
    await store.refresh();
    return {permalink,file_path:filePath,directory,frontmatter,content};
  }
  return {documents,grant,store,vault,control,add,
    rewrite:(filePath,options)=>writeNote(vault,filePath,options).then(()=>store.refresh()),
    async list(){const rows=[];for await(const row of documents.listDocuments({grant}))rows.push(row);return rows;},
    resolve:({id,revision})=>documents.resolveDocument({grant,id,revision}),
  };
}

test('main indexes and reopens migrated notes by file path while keeping their identities and sources',async t=>{
  const f=await fixture(t);
  const fact=await f.add('personal/chats/facts/a-stable-slug','chats/facts/Current title.md',{
    frontmatter:{memory_id:'fictional-fact',memory_kind:'fact',value:'Fictional note',source_message_id:'fictional-message'},
  });
  const diary=await f.add('personal/dafeiyu/thoughts/a-stable-slug','dafeiyu/diary/Current title.md',{
    directory:'dafeiyu/diary',
  });
  const rows=await f.list();
  assert.deepEqual(rows.map(row=>[row.id,row.domain]),[
    ['legacy-note:fictional-fact','fact'],['document:'+encodeURIComponent(diary.permalink),'diary'],
  ]);
  const [saved]=rows;
  assert.deepEqual(saved.sourceIds,['fictional-message']);
  assert.equal(saved.identifier,fact.permalink);
  assert.equal(saved.anchor.ref.identifier,fact.permalink);
  assert.equal((await f.resolve(saved)).source.permalink,fact.permalink);
  assert.ok(f.store.calls.filter(call=>call.name==='read').every(call=>call.identifier===fact.file_path||call.identifier===diary.file_path));

  // A temporary omission from the directory catalogue still checks the known file.
  f.control.omit=fact.file_path;
  assert.ok((await f.list()).some(row=>row.id===saved.id));
  f.control.omit=null;

  await f.rewrite(fact.file_path,{title:'Current title',permalink:'other/chats/facts/a-stable-slug',
    frontmatter:fact.frontmatter,content:fact.content});
  assert.equal(await f.resolve(saved),null);

  await f.rewrite(fact.file_path,{title:'Current title',permalink:fact.permalink,
    frontmatter:{...fact.frontmatter,source_hidden:true},content:fact.content});
  assert.equal(await f.resolve(saved),null);
});

test('migration is limited to main, permitted vault paths and explicit selections',async t=>{
  const f=await fixture(t);
  await f.add('other/chats/facts/wrong-namespace','chats/facts/Wrong namespace.md');
  await f.add('personal/chats/facts/fixture','chats/facts/Fixture.md',{frontmatter:{qa_fixture:true}});
  await f.add('personal/chats/facts/private','manual/Chosen.md');

  assert.deepEqual(await f.list(),[]);
  assert.ok(f.store.calls.some(call=>call.name==='read'&&call.identifier==='chats/facts/Fixture.md'));
  await f.documents.selectDocuments({grant:f.grant,identifiers:['manual/Chosen.md']});
  const [selected]=await f.list();
  assert.equal(selected.source.permalink,'personal/chats/facts/private');
  assert.equal((await f.resolve(selected)).text,'Fictional note');
  await f.documents.selectDocuments({grant:f.grant,identifiers:[]});
  assert.equal(await f.resolve(selected),null);

  const other=await fixture(t,'other');
  await other.add('personal/chats/facts/legacy','chats/facts/Legacy.md');
  assert.deepEqual(await other.list(),[]);
  assert.equal(other.store.calls.some(call=>call.name==='read'),false);
});

test('the production document factory forwards logger warnings without file bodies',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-documents-logger-')),vault=path.join(directory,'vault');
  const malformed=path.join(vault,'chats','facts','Malformed.md');
  const body='FICTIONAL_MALFORMED_BODY_MUST_NOT_BE_LOGGED',warnings=[];
  await fs.mkdir(path.dirname(malformed),{recursive:true});
  await fs.writeFile(malformed,`---\ntitle: Malformed\nmetadata:\n  nested: value\n---\n\n${body}`);
  const raw={
    messageReader:()=>({list:()=>({sources:[]})}),
    queryReader:()=>({legacyPage:()=>({sources:[]})}),
  };
  const documents=createMemoryDocuments({directory,tools:{},raw,
    config:{captureFolder:'chats',vaultPath:vault},authorize:()=>true,agentForGrant:()=>null,
    logger:{warn:message=>warnings.push(String(message))}});
  t.after(async()=>{await documents.close();await fs.rm(directory,{recursive:true,force:true});});
  const rows=[];
  for await(const row of documents.listDocuments({grant:{kind:'management',project:'main',ownerSubject:'fictional-owner'}}))rows.push(row);
  assert.deepEqual(rows,[]);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/chats\/facts\/Malformed\.md/u);
  assert.equal(warnings[0].includes(body),false);
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
  const f=await fixture(t);
  const note=await f.add('personal/chats/facts/point-note','chats/facts/Point note.md');
  const [first]=await f.list();
  const metadata=f.documents.getMetadata({...first,grant:f.grant});
  metadata.anchor.ref.identifier='mutated-locator';
  assert.notEqual(f.documents.getMetadata({...first,grant:f.grant}).anchor.ref.identifier,'mutated-locator');
  await f.rewrite(note.file_path,{title:'Point note',permalink:note.permalink,frontmatter:note.frontmatter,content:'Updated fictional body'});
  const [second]=await f.list();
  assert.equal(f.documents.getMetadata({...first,grant:f.grant}),null);
  assert.equal((await f.resolve(first)),null);
  assert.equal((await f.resolve(second)).text,'Updated fictional body');
});

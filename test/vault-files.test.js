import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parseLegacyNote} from '../lib/legacy-notes.js';
import {createVaultBackend} from '../lib/vault-files.js';

async function fixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vault-files-'));
  const vault=path.join(root,'vault');
  await fs.mkdir(vault);
  const backend=createVaultBackend({vaultPath:vault,project:'personal'});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {root,vault,backend};
}

async function noteFixture(t,count=20){
  const {root,vault,backend}=await fixture(t);
  const directory=path.join(vault,'chats','entries');
  await fs.mkdir(directory,{recursive:true});
  const notes=[];
  for(let index=0;index<count;index++){
    const number=String(index+1).padStart(2,'0');
    const title=`Entry ${number}`;
    const filePath=`chats/entries/${title}.md`;
    const permalink=`personal/chats/entries/entry-${number}`;
    const content=`# ${title}\n\nBody ${number}.\n`;
    await fs.writeFile(path.join(directory,`${title}.md`),`---
title: "${title}"
type: note
permalink: ${permalink}
---

${content}`);
    notes.push({filePath,permalink,title,content});
  }
  return {root,vault,backend,notes};
}

test('write/read round-trip preserves flat frontmatter, lists and byte checksums',async t=>{
  const {vault,backend}=await fixture(t);
  const content='# Fixture\n\nBody with a colon: "quoted" and a newline.\n';
  const written=await backend.write({
    title:'Fixture: 茶 "Plan"\nRoundtrip',
    directory:'chats/facts',
    content,
    tags:['dsh-memory','sample'],
    metadata:{
      memory_id:'fixture-memory',
      quoted:'A: "B"\nC',
      sources:['one:two','"quoted"'],
      active:true,
    },
    overwrite:false,
  });

  assert.equal(written.file_path,'chats/facts/Fixture 茶 Plan Roundtrip.md');
  assert.equal(written.permalink,'personal/chats/facts/fixture-茶-plan-roundtrip');
  const bytes=await fs.readFile(path.join(vault,written.file_path));
  assert.equal(written.checksum,createHash('sha256').update(bytes).digest('hex'));
  const markdown=bytes.toString('utf8');
  assert.match(markdown,/^---\ntitle: "Fixture: 茶 \\"Plan\\"\\nRoundtrip"\ntype: "note"\npermalink: "personal\/chats\/facts\/fixture-茶-plan-roundtrip"\n/);

  const parsed=parseLegacyNote(markdown);
  assert.ok(parsed);
  assert.equal(parsed.metadata.quoted,'A: "B"\nC');
  assert.deepEqual(parsed.metadata.sources,['one:two','"quoted"']);
  assert.deepEqual(parsed.metadata.tags,['dsh-memory','sample']);

  const byPath=await backend.read(written.file_path);
  const byPermalink=await backend.read(written.permalink);
  assert.deepEqual(byPath,byPermalink);
  assert.equal(byPath.content,content);
  assert.equal(byPath.title,'Fixture: 茶 "Plan"\nRoundtrip');
  assert.equal(byPath.metadata.quoted,'A: "B"\nC');
  assert.deepEqual(byPath.metadata.sources,['one:two','"quoted"']);
  assert.equal(byPath.checksum,written.checksum);
});

test('write conflicts are explicit and expected checksums protect overwrites',async t=>{
  const {vault,backend}=await fixture(t);
  const first=await backend.write({title:'Conflict',directory:'chats/facts',content:'first',tags:[]});
  await assert.rejects(
    ()=>backend.write({title:'Conflict',directory:'chats/facts',content:'second',tags:[]}),
    {code:'MEMORY_WRITE_CONFLICT'},
  );
  assert.equal((await backend.read(first.file_path)).content,'first');

  const changed=await backend.write({
    title:'Conflict',directory:'chats/facts',content:'second',tags:[],overwrite:true,expected_checksum:first.checksum,
  });
  assert.equal((await backend.read(changed.file_path)).content,'second');
  await assert.rejects(
    ()=>backend.write({
      title:'Conflict',directory:'chats/facts',content:'stale',tags:[],overwrite:true,expected_checksum:first.checksum,
    }),
    {code:'MEMORY_WRITE_CONFLICT'},
  );
  assert.equal((await backend.read(changed.file_path)).content,'second');
  assert.deepEqual(await fs.readdir(path.join(vault,'chats','facts')),['Conflict.md']);
});

test('atomic writes leave the previous target intact when rename fails',async t=>{
  const {vault,backend}=await fixture(t);
  const written=await backend.write({title:'Atomic',directory:'chats/facts',content:'before',tags:[]});
  const originalRename=fs.rename;
  fs.rename=async()=>{
    const error=Error('simulated rename failure');
    error.code='EIO';
    throw error;
  };
  try{
    await assert.rejects(
      ()=>backend.edit({
        identifier:written.file_path,
        operation:'append',
        content:'after',
        expected_checksum:written.checksum,
      }),
      {code:'EIO'},
    );
  }finally{
    fs.rename=originalRename;
  }
  assert.equal(await fs.readFile(path.join(vault,written.file_path),'utf8'),'---\ntitle: "Atomic"\ntype: "note"\npermalink: "personal/chats/facts/atomic"\ntags:\n---\n\nbefore');
  assert.deepEqual(await fs.readdir(path.join(vault,'chats','facts')),['Atomic.md']);
});

test('atomic writes retry transient Windows rename contention and remove the temporary file',async t=>{
  const {vault,backend}=await fixture(t),originalRename=fs.rename;
  let attempts=0;
  fs.rename=async(...args)=>{
    attempts++;
    if(attempts<=2){
      const error=Error('simulated Windows rename contention');
      error.code=attempts===1?'EPERM':'EBUSY';
      throw error;
    }
    return originalRename(...args);
  };
  try{
    await backend.write({title:'Retried',directory:'chats/facts',content:'after retries',tags:[]});
  }finally{
    fs.rename=originalRename;
  }
  assert.equal(attempts,3);
  assert.equal((await backend.read('chats/facts/Retried.md')).content,'after retries');
  assert.equal((await fs.readdir(path.join(vault,'chats','facts'))).some(name=>name.endsWith('.tmp')),false);
});

test('an exhausted atomic rename retry reports the error and leaves no temporary file',async t=>{
  const {vault,backend}=await fixture(t),originalRename=fs.rename;
  let attempts=0;
  fs.rename=async()=>{
    attempts++;
    const error=Error('simulated persistent rename contention');
    error.code='EACCES';
    throw error;
  };
  try{
    await assert.rejects(()=>backend.write({title:'Blocked',directory:'chats/facts',content:'not committed',tags:[]}),{code:'EACCES'});
  }finally{
    fs.rename=originalRename;
  }
  assert.equal(attempts,6);
  assert.deepEqual(await fs.readdir(path.join(vault,'chats','facts')),[]);
});

test('find_replace and append merge metadata and reject stale or inexact edits',async t=>{
  const {backend}=await fixture(t);
  const written=await backend.write({
    title:'Editable',directory:'chats/facts',content:'alpha',tags:['one'],metadata:{memory_id:'editable',keep:'yes'},
  });
  const replaced=await backend.edit({
    identifier:written.file_path,
    operation:'find_replace',
    find_text:'alpha',
    content:'beta',
    expected_replacements:1,
    expected_checksum:written.checksum,
    metadata:{edited:'yes'},
  });
  const appended=await backend.edit({
    identifier:written.file_path,
    operation:'append',
    content:'gamma',
    expected_checksum:replaced.checksum,
    metadata:{appended:true},
  });
  const note=await backend.read(written.permalink);
  assert.equal(note.content,'beta\ngamma');
  assert.equal(note.metadata.memory_id,'editable');
  assert.equal(note.metadata.keep,'yes');
  assert.equal(note.metadata.edited,'yes');
  assert.equal(note.metadata.appended,'true');
  await assert.rejects(
    ()=>backend.edit({
      identifier:written.file_path,operation:'append',content:'stale',expected_checksum:replaced.checksum,
    }),
    {code:'MEMORY_WRITE_CONFLICT'},
  );
  await assert.rejects(
    ()=>backend.edit({
      identifier:written.file_path,operation:'find_replace',find_text:'missing',content:'x',
      expected_replacements:1,expected_checksum:appended.checksum,
    }),
    {code:'MEMORY_WRITE_CONFLICT'},
  );
});

test('recursive listing returns directory-node fields without leaving the Vault',async t=>{
  const {vault,backend}=await fixture(t);
  await backend.write({title:'Root fact',directory:'chats/facts',content:'one',tags:['fact']});
  await backend.write({title:'Nested fact',directory:'chats/facts/deep',content:'two',tags:['fact']});
  await fs.writeFile(path.join(vault,'chats','not-markdown.txt'),'ignored');

  const nodes=await backend.list('chats');
  assert.deepEqual(nodes.map(node=>node.file_path).sort(),['chats/facts/Root fact.md','chats/facts/deep/Nested fact.md']);
  assert.deepEqual(Object.keys(nodes[0]).sort(),[
    'directory_path','file_path','name','permalink','title','type','updated_at',
  ]);
  assert.ok(nodes.every(node=>node.type==='file'&&node.name===node.title&&node.permalink.startsWith('personal/chats/facts/')));
  assert.ok(nodes.some(node=>node.directory_path==='chats/facts/deep'));
  await assert.rejects(()=>backend.list('../outside'),{code:'MEMORY_BACKEND_ERROR'});
});

test('Basic Memory markdown and stable permalinks remain readable and editable',async t=>{
  const {vault,backend}=await fixture(t);
  const directory=path.join(vault,'chats','facts');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'Renamed title.md'),`---
title: "Fixture: 茶"
type: note
permalink: personal/chats/facts/stable-fixture
memory_id: fixture-stable
tags:
  - dsh-memory
  - fixture
---

# Fixture: 茶

Original body.
`);

  const byPermalink=await backend.read('personal/chats/facts/stable-fixture');
  const byFilename=await backend.read('Renamed title');
  assert.equal(byPermalink.title,'Fixture: 茶');
  assert.equal(byPermalink.content,'# Fixture: 茶\n\nOriginal body.\n');
  assert.equal(byFilename.file_path,byPermalink.file_path);
  const edited=await backend.edit({
    identifier:byPermalink.permalink,
    operation:'append',
    content:'\nEdited body.\n',
    expected_checksum:byPermalink.checksum,
    metadata:{manual_field:'kept'},
  });
  const fresh=await backend.read(edited.permalink);
  assert.equal(fresh.content,'# Fixture: 茶\n\nOriginal body.\n\nEdited body.\n');
  assert.equal(fresh.metadata.memory_id,'fixture-stable');
  assert.equal(fresh.metadata.manual_field,'kept');
  assert.deepEqual(fresh.metadata.tags,['dsh-memory','fixture']);
});

test('unsupported frontmatter structures fail instead of being guessed',async t=>{
  const {vault,backend}=await fixture(t);
  const directory=path.join(vault,'chats','facts');
  await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(path.join(directory,'Nested.md'),`---
title: Nested
metadata:
  child: value
---

body
`);
  await assert.rejects(()=>backend.read('chats/facts/Nested.md'),{code:'MEMORY_FRONTMATTER_UNSUPPORTED'});
  await assert.rejects(()=>backend.read('Nested'),{code:'MEMORY_FRONTMATTER_UNSUPPORTED'});
});

test('listing and search skip one malformed Vault file and log only its relative path',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'vault-frontmatter-isolation-')),vault=path.join(root,'vault');
  await fs.mkdir(path.join(vault,'chats','facts'),{recursive:true});
  const warnings=[],backend=createVaultBackend({vaultPath:vault,project:'personal',logger:{warn:message=>warnings.push(message)}});
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await backend.write({title:'Usable fact',directory:'chats/facts',content:'FICTIONAL_SEARCHABLE_BODY',tags:['fixture']});
  const body='MALFORMED_BODY_MUST_NOT_BE_LOGGED';
  await fs.writeFile(path.join(vault,'chats','facts','Malformed.md'),`---
title: Malformed
metadata:
  nested: value
---

${body}
`);

  const listed=await backend.list('chats/facts');
  assert.deepEqual(listed.map(node=>node.file_path),['chats/facts/Usable fact.md']);
  const searched=await backend.search({query:'FICTIONAL_SEARCHABLE_BODY'});
  assert.deepEqual(searched.map(result=>result.file_path),['chats/facts/Usable fact.md']);
  assert.equal(warnings.length,2);
  assert.ok(warnings.every(message=>message.includes('chats/facts/Malformed.md')));
  assert.ok(warnings.every(message=>!message.includes(body)));

  const originalReadFile=fs.readFile;
  fs.readFile=async(file,...args)=>{
    if(String(file).endsWith('Unreadable.md'))throw Object.assign(Error('simulated unreadable file'),{code:'EACCES'});
    return originalReadFile(file,...args);
  };
  await fs.writeFile(path.join(vault,'chats','facts','Unreadable.md'),'---\ntitle: Unreadable\n---\n');
  try{
    await assert.rejects(()=>backend.list('chats/facts'),{code:'EACCES'});
  }finally{
    fs.readFile=originalReadFile;
  }
});

test('known file path reads a matching permalink once without changing the result',async t=>{
  const {backend,notes}=await noteFixture(t);
  const target=notes[7];
  const originalReadFile=fs.readFile;
  let reads=0;
  fs.readFile=function(...args){
    reads++;
    return Reflect.apply(originalReadFile,fs,args);
  };
  let fast,scanned,fastReads,scannedReads;
  try{
    fast=await backend.read(target.permalink,{knownFilePath:target.filePath});
    fastReads=reads;
    reads=0;
    scanned=await backend.read(target.permalink);
    scannedReads=reads;
  }finally{
    fs.readFile=originalReadFile;
  }
  assert.deepEqual(fast,scanned);
  assert.equal(fast.file_path,target.filePath);
  assert.equal(fast.content,target.content);
  assert.equal(fastReads,1);
  assert.ok(scannedReads>fastReads,'the fallback scans multiple note files');
});

test('missing or mismatched known paths fall back to the original scan',async t=>{
  const {backend,notes}=await noteFixture(t);
  const target=notes[3],other=notes[11];
  const missing=await backend.read(target.permalink,{knownFilePath:'chats/entries/missing.md'});
  const mismatched=await backend.read(target.permalink,{knownFilePath:other.filePath});
  assert.equal(missing.file_path,target.filePath);
  assert.equal(missing.content,target.content);
  assert.equal(mismatched.file_path,target.filePath);
  assert.equal(mismatched.content,target.content);
});

test('unsafe and non-Markdown known paths are ignored without reading outside the Vault',async t=>{
  const {root,vault,backend,notes}=await noteFixture(t);
  const target=notes[5];
  const outside=path.join(root,'outside.md');
  await fs.writeFile(outside,`---
title: Outside
permalink: ${target.permalink}
---

outside content
`);

  for(const knownFilePath of ['../outside.md',outside,'chats/entries/not-markdown.txt']){
    const originalReadFile=fs.readFile,readPaths=[];
    fs.readFile=function(file,...args){
      readPaths.push(path.resolve(String(file)));
      return Reflect.apply(originalReadFile,fs,[file,...args]);
    };
    let note;
    try{
      note=await backend.read(target.permalink,{knownFilePath});
    }finally{
      fs.readFile=originalReadFile;
    }
    assert.equal(note.file_path,target.filePath);
    assert.equal(note.content,target.content);
    assert.equal(readPaths.includes(path.resolve(outside)),false);
    assert.ok(readPaths.every(file=>file.startsWith(path.resolve(vault)+path.sep)));
  }
});

test('unsupported frontmatter at the known path falls back without changing behavior',async t=>{
  const {vault,backend,notes}=await noteFixture(t);
  const target=notes[9];
  const unsupported='chats/entries/Unsupported.md';
  await fs.writeFile(path.join(vault,unsupported),`---
title: Unsupported
metadata:
  child: value
---

unsupported
`);
  const byKnownPath=await backend.read(target.permalink,{knownFilePath:unsupported});
  const byScan=await backend.read(target.permalink);
  assert.deepEqual(byKnownPath,byScan);
  assert.equal(byKnownPath.file_path,target.filePath);
});

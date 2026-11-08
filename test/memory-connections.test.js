import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import os from 'node:os';
import {sourceTextHash} from '../lib/source-lineage.js';
import {createMemoryEntryBackend} from '../lib/memory-entry-backend.js';
import {createMemoryConnections} from '../lib/memory-connections.js';
import {createPersonalMemoryRuntime} from '../lib/personal-runtime.js';

test('connection provider refuses unselected, overlapping and linked scopes before starting a backend',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/memory-connections-')),personal=path.join(root,'personal'),social=path.join(root,'social');
 await fs.mkdir(personal);await fs.mkdir(social);
 const backend={command:process.execPath,offline:true},connections=createMemoryConnections({backend,personalDirectory:personal,socialRoot:social});
 try{
  await assert.rejects(connections.acquire(path.join(root,'unselected')),/outside/);
  await assert.rejects(connections.acquireExisting(path.join(social,'blocked'),{permitted:()=>false}),/authorization changed/);
  await assert.rejects(fs.access(path.join(social,'blocked')),{code:'ENOENT'});
  assert.equal(await connections.acquireExisting(path.join(social,'missing')),null);
  await assert.rejects(fs.access(path.join(social,'missing')),{code:'ENOENT'});
  const alias=path.join(social,'alias');await fs.symlink(personal,alias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(connections.acquire(alias),/outside/);
  const group=path.join(social,'group-a');await fs.mkdir(group);const groupAlias=path.join(social,'group-b');await fs.symlink(group,groupAlias,process.platform==='win32'?'junction':'dir');
  await assert.rejects(connections.acquire(groupAlias),/outside/);
 }finally{await connections.close();}
 const overlapping=createMemoryConnections({backend,personalDirectory:personal,socialRoot:path.join(personal,'groups')});
 try{await assert.rejects(overlapping.acquire(personal),/separate/);}finally{await overlapping.close();}
 await assert.rejects(connections.acquire(personal),/closed/);
});

test('a management directory linked outside the chosen library is rejected before backend startup',async()=>{
 const parent=await fs.mkdtemp(path.resolve('.local/memory-paths-')),root=path.join(parent,'library'),vault=path.join(root,'vault'),state=path.join(root,'basic-memory-state'),outside=path.join(parent,'outside');
 await fs.mkdir(vault,{recursive:true});await fs.mkdir(state);await fs.mkdir(outside);await fs.writeFile(path.join(state,'config.json'),JSON.stringify({projects:{main:{mode:'local',path:vault}}}));
 await fs.symlink(outside,path.join(root,'management'),process.platform==='win32'?'junction':'dir');
 const connections=createMemoryConnections({backend:{command:process.execPath},personalDirectory:root});
 try{await assert.rejects(connections.acquire(root),/must remain inside/);}finally{await connections.close();}
});

test('a stopped backend is evicted and the next acquisition creates a new connection',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/memory-reconnect-')),vault=path.join(root,'vault'),state=path.join(root,'basic-memory-state');
 await fs.mkdir(vault);await fs.mkdir(state);await fs.writeFile(path.join(state,'config.json'),JSON.stringify({projects:{main:{mode:'local',path:vault}}}));
 await fs.writeFile(path.join(root,'mcp'),`let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;const message=JSON.parse(line);if(message.id===undefined)continue;let result;if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(message.method==='tools/list')result={tools:['search_notes','read_note','write_note','list_directory','edit_note','move_note'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))};else if(message.method==='tools/call'){if(message.params.name==='read_note')process.exit(3);result={content:[{type:'text',text:'{}'}]};}else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');}});`);
 const connections=createMemoryConnections({backend:{command:process.execPath},personalDirectory:root});
 let personal;
 try{
  assert.equal(await connections.peek(root),null);
  personal=await createPersonalMemoryRuntime({directory:root,config:{},acquireMemory:directory=>connections.acquire(directory),llm:{}});
  const first=await connections.acquire(root);
  assert.equal(await connections.peek(root),first);
  assert.equal(await connections.acquireExisting(root),first);
  await assert.rejects(personal.memory.tools.get('mcp__basic_memory__read_note').execute({project:'main'},{}));
  const second=await connections.acquire(root);assert.notEqual(second,first);
  const result=await personal.memory.tools.get('mcp__basic_memory__search_notes').execute({project:'main'},{});
  assert.equal(result.content[0].text,'{}');
  await connections.release(root);assert.equal(await connections.peek(root),null);const third=await connections.acquire(root);assert.notEqual(third,second);
 }finally{await personal?.close();await connections.close();}
});
test('revoked cross-scope opening cannot interrupt a simultaneous legitimate scope connection',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/memory-shared-open-')),vault=path.join(root,'vault'),state=path.join(root,'basic-memory-state'),marker=path.join(root,'started');await fs.mkdir(vault);await fs.mkdir(state);await fs.writeFile(path.join(state,'config.json'),JSON.stringify({projects:{main:{mode:'local',path:vault}}}));
 await fs.writeFile(path.join(root,'mcp'),`import fs from 'node:fs';let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===undefined)continue;const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');if(m.method==='initialize'){fs.writeFileSync('started','yes');setTimeout(()=>reply({protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}),500);}else if(m.method==='tools/list')reply({tools:['search_notes','read_note','write_note','list_directory','edit_note','move_note'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))});else if(m.method==='tools/call')reply({content:[{type:'text',text:'{}'}]});else reply({});}});`);
 const connections=createMemoryConnections({backend:{command:process.execPath},personalDirectory:root});let permitted=true;
 try{const guarded=connections.acquireExisting(root,{permitted:()=>permitted}).then(()=>null,error=>error);for(let i=0;i<200;i++){try{await fs.access(marker);break;}catch{await new Promise(r=>setTimeout(r,10));}}await fs.access(marker);const normal=connections.acquire(root);await new Promise(r=>setTimeout(r,80));permitted=false;assert.ok((await guarded) instanceof Error);assert.ok((await normal).tools);}
 finally{await connections.close();}
});
test('group vault refuses links to another group both before opening and during use',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/memory-group-link-')),personal=path.join(root,'personal'),social=path.join(root,'social'),group=path.join(social,'group-a'),other=path.join(social,'group-b'),vault=path.join(group,'vault'),state=path.join(group,'basic-memory-state');await fs.mkdir(personal);await fs.mkdir(vault,{recursive:true});await fs.mkdir(state);await fs.mkdir(other);await fs.writeFile(path.join(state,'config.json'),JSON.stringify({projects:{main:{mode:'local',path:vault}}}));
 await fs.writeFile(path.join(group,'mcp'),`let pending='';process.stdin.on('data',chunk=>{pending+=chunk;let end;while((end=pending.indexOf('\\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);if(!line.trim())continue;const m=JSON.parse(line);if(m.id===undefined)continue;let result;if(m.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};else if(m.method==='tools/list')result={tools:['search_notes','read_note','write_note','list_directory','edit_note','move_note'].map(name=>({name,inputSchema:{type:'object',properties:{}}}))};else result={content:[{type:'text',text:'{}'}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`);
 const connections=createMemoryConnections({backend:{command:process.execPath},personalDirectory:personal,socialRoot:social});try{const opened=await connections.acquire(group);await fs.symlink(other,path.join(vault,'members'),process.platform==='win32'?'junction':'dir');await assert.rejects(opened.tools.get('mcp__basic_memory__search_notes').execute({project:'main',query:'test'},{}),/cannot contain filesystem links/);await connections.release(group);await assert.rejects(connections.acquire(group),/cannot contain filesystem links/);}finally{await connections.close();}
});

test('local reads reject a stale indexed revision and retain Basic Memory checksum conflicts',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'memory-local-revision-'));
 const vault=path.join(root,'vault'),state=path.join(root,'basic-memory-state'),file=path.join(vault,'notes','current.md');
 await fs.mkdir(path.dirname(file),{recursive:true});await fs.mkdir(state);
 await fs.writeFile(path.join(state,'config.json'),JSON.stringify({projects:{main:{mode:'local',path:vault}}}));
 await fs.writeFile(path.join(root,'mcp'),`import fs from 'node:fs';
 const names=['search_notes','read_note','write_note','list_directory','edit_note','move_note'];
 for await(const line of (await import('node:readline')).createInterface({input:process.stdin})){
  const message=JSON.parse(line);if(message.id===undefined)continue;
  let result={content:[{type:'text',text:'{}'}]};
  if(message.method==='initialize')result={protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}};
  else if(message.method==='tools/list')result={tools:names.map(name=>({name,inputSchema:{type:'object'}}))};
  else if(message.params?.name==='read_note'){
   const note=JSON.parse(fs.readFileSync('indexed.json','utf8'));
   result=typeof note==='string'?{isError:true,content:[{type:'text',text:note}]}:{content:[],structuredContent:{result:note}};
  }
  else if(message.params?.name==='edit_note')result={isError:true,content:[{type:'text',text:fs.readFileSync('edit-error.json','utf8')}]};
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');
 }`);
 const connections=createMemoryConnections({backend:{command:process.execPath},personalDirectory:root});
 t.after(async()=>{await connections.close();await fs.rm(root,{recursive:true,force:true});});
 const {tools}=await connections.acquire(root),backend=createMemoryEntryBackend({tools,project:'main'});
 const context={agent:{session:{id:'fixture'}},check(){}};
 const filePath='notes/current.md',old='---\r\ntitle: Current\r\n---\r\nold human body\r\n',fresh=old.replace('old','new');
 const index=content=>fs.writeFile(path.join(root,'indexed.json'),JSON.stringify(content===null?{error:'NOTE_NOT_FOUND'}:
  {file_path:filePath,permalink:'main/notes/current',content,checksum:sourceTextHash(content),frontmatter:{title:'Current'}}));
 await fs.writeFile(file,old);await index(old);
 assert.equal((await backend.read(filePath,context)).checksum,sourceTextHash(old));
 await fs.writeFile(file,fresh);
 await assert.rejects(backend.read(filePath,context),{code:'MEMORY_NOTE_SYNC_PENDING',retryable:true});
 await index(null);
 await assert.rejects(backend.read(filePath,context),{code:'MEMORY_NOTE_SYNC_PENDING',retryable:true});
 await index(fresh);
 assert.equal((await backend.read(filePath,context)).checksum,sourceTextHash(fresh));
 await fs.writeFile(path.join(root,'edit-error.json'),JSON.stringify({error:'NOTE_REVISION_CONFLICT',currentChecksum:sourceTextHash(fresh)}));
 await assert.rejects(backend.edit({identifier:filePath,expected_checksum:sourceTextHash(old)},context),
  {code:'MEMORY_WRITE_CONFLICT',backendCode:'NOTE_REVISION_CONFLICT',currentChecksum:sourceTextHash(fresh)});
 await fs.writeFile(path.join(root,'edit-error.json'),JSON.stringify({error:'UNRECOGNIZED_EDIT_ERROR'}));
 await assert.rejects(backend.edit({identifier:filePath},context),{code:'MEMORY_BACKEND_ERROR'});
 await fs.unlink(file);
 await assert.rejects(backend.read(filePath,context),{code:'MEMORY_NOTE_SYNC_PENDING',retryable:true});
 await fs.writeFile(path.join(root,'indexed.json'),JSON.stringify("Entity with external_id '00000000-0000-0000-0000-000000000000' not found"));
 await assert.rejects(backend.read(filePath,context),{code:'MEMORY_NOTE_SYNC_PENDING',retryable:true});
 await index(null);
 assert.equal(await backend.read(filePath,context),null);
});

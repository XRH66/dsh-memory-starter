import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createBridge} from '../lib/index.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createSessionMemory} from '../lib/session-memory.js';
import {createSettingsHandler} from '../lib/settings-host.js';
import {resolveConfig} from '../lib/config.js';
import {fakeAgent,fakeLlm,fakeTools} from './helpers.js';

const owner='虚构主人',logger={warn(){}},allowed={authorize:()=>true};

const message=(patch={})=>({ownerSubject:owner,project:'main',sessionId:'session-alpha',messageId:'message-alpha',role:'user',
  sequence:1,turn:1,rootTurn:1,text:'我在蓝色花盆底下放了备用钥匙。',content:[{type:'text',text:'我在蓝色花盆底下放了备用钥匙。'}],
  time:Date.parse('2026-02-03T09:00:00+08:00'),authorization:{epoch:'fixture'},...patch});

async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'raw-delete-route-'));
  const agent=fakeAgent('session-alpha');
  const agents={get:id=>id===agent.session.id?agent:null,list:()=>[agent],isOwnedBy:()=>false};
  const sessions={get:id=>id===agent.session.id?agent.session:null};
  const access=await createSessionMemory({directory,ownerSubject:owner,agents,sessions,logger});
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecallDbPath:path.join(directory,'raw.sqlite'),
    rawRecall:true,autoCapture:false,recentContext:false,maxTimelineEntries:0,maxIndexNotes:0});
  await fs.mkdir(config.vaultPath,{recursive:true});
  const store=new RawMemoryStore(config.rawRecallDbPath,logger);
  const bridge=createBridge({config,tools:fakeTools(()=>{throw Error('unexpected tool call');}),llm:fakeLlm('{"actions":[]}'),access,
    ownerSubject:owner,findAgent:id=>id===agent.session.id?agent:null,listAgents:()=>[agent],logger,semanticOrganizer:false,rawRecallStore:store});
  const projector=createRawRecall({config,ownerSubject:()=>owner,store,logger});
  const handler=createSettingsHandler({},path.join(directory,'deployment.json'),undefined,undefined,{manageRawMessages:bridge.manageRawMessages});
  t.after(async()=>{
    await bridge.dispose();
    access.close();
    assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {agent,bridge,handler,projector,store};
}

async function request(handler,{method='GET',url,body,headers={}}={}){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},aborted:false,
    headers:{host:'127.0.0.1:15680',...(body===undefined?{}:{'content-type':'application/json'}),...headers}});
  const res={statusCode:200,destroyed:false,headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=JSON.parse(value);}};
  await handler(req,res);
  return res;
}

test('raw message search covers every conversation, returns local time and skips withdrawn originals',async t=>{
  const f=await fixture(t);
  const old=f.store.messages.record(message({messageId:'alpha-old',sequence:1,
    text:'蓝色花盆的旧位置在门口。',content:[{type:'text',text:'蓝色花盆的旧位置在门口。'}],time:1_000}),allowed).source;
  f.store.messages.record(message({sessionId:'session-beta',messageId:'beta-new',sequence:2,
    text:'今天确认蓝色花盆已经搬到阳台。',content:[{type:'text',text:'今天确认蓝色花盆已经搬到阳台。'}],time:2_000}),allowed);
  const hidden=f.store.messages.record(message({sessionId:'session-hidden',messageId:'hidden-old',sequence:3,
    text:'蓝色花盆里曾经藏着秘密。',content:[{type:'text',text:'蓝色花盆里曾经藏着秘密。'}],time:3_000}),allowed).source;
  f.store.messages.record(message({sessionId:'session-other',messageId:'unrelated',sequence:4,
    text:'阳台新添了一把椅子。',content:[{type:'text',text:'阳台新添了一把椅子。'}],time:4_000}),allowed);
  f.store.messages.withdraw({ownerSubject:owner,project:'main',id:hidden.id},allowed);

  const response=await request(f.handler,{url:'/api/basic-memory-settings/raw-messages?query='+encodeURIComponent('蓝色花盆')+'&limit=20'});
  assert.equal(response.statusCode,200);
  assert.equal(response.body.ok,true);
  assert.deepEqual(response.body.messages.map(item=>item.sessionId),['session-beta','session-alpha']);
  assert.deepEqual(new Set(response.body.messages.map(item=>item.id)),new Set([old.id,
    f.store.messages.list({ownerSubject:owner,project:'main'}).sources.find(item=>item.sessionId==='session-beta').id]));
  assert.ok(response.body.messages.every(item=>item.time&&item.excerpt.includes('蓝色花盆')));
});

test('withdrawing a searched original removes its text index and notifies vectors once',async t=>{
  const f=await fixture(t);
  const saved=f.store.messages.record(message(),allowed).source,removed=[];
  f.projector.projectMessage(saved,allowed);
  assert.ok(f.projector.queryReader({ownerSubject:owner,project:'main'},allowed).search({query:'备用钥匙'}).sources.length>0);
  assert.ok(f.bridge.vectors,'fixture must exercise the vector notification path');
  f.bridge.vectors.notifyChanged=async notice=>removed.push(notice);

  const deleted=await request(f.handler,{method:'POST',url:'/api/basic-memory-settings/raw-messages',
    body:{action:'withdraw',id:saved.id,revision:saved.revision},headers:{'x-basic-memory-settings':'1'}});
  assert.equal(deleted.statusCode,200,deleted.body.error);
  assert.deepEqual({withdrawn:deleted.body.withdrawn,removed:deleted.body.removed,entries:deleted.body.entries},
    {withdrawn:true,removed:true,entries:null});
  assert.equal(removed.length,1);
  assert.equal(removed[0].kind,'message');
  assert.equal(removed[0].operation,'withdrawn');
  assert.equal(removed[0].id,saved.id);
  assert.equal(removed[0].revision,saved.revision);
  const searched=await request(f.handler,{url:'/api/basic-memory-settings/raw-messages?query='+encodeURIComponent('备用钥匙')});
  assert.deepEqual(searched.body.messages,[]);
  assert.equal(f.projector.queryReader({ownerSubject:owner,project:'main'},allowed).search({query:'备用钥匙'}).sources.length,0);
});

test('a stale message revision is rejected without changing the original',async t=>{
  const f=await fixture(t);
  const first=f.store.messages.record(message(),allowed).source;
  const current=f.store.messages.record(message({sequence:2,text:'更新后的蓝色花盆说明。',content:[{type:'text',text:'更新后的蓝色花盆说明。'}]}),allowed).source;
  assert.equal(current.revision,first.revision+1);
  const response=await request(f.handler,{method:'POST',url:'/api/basic-memory-settings/raw-messages',
    body:{action:'withdraw',id:current.id,revision:first.revision},headers:{'x-basic-memory-settings':'1'}});
  assert.equal(response.statusCode,409);
  assert.equal(response.body.error,'这条原话已经变化，请重新搜索');
  const found=await f.bridge.manageRawMessages({action:'search',query:'蓝色花盆',limit:20},()=>{});
  assert.equal(found.messages.length,1);
  assert.equal(found.messages[0].revision,current.revision);
});

test('raw message writes require the settings header',async t=>{
  const f=await fixture(t);
  const saved=f.store.messages.record(message(),allowed).source;
  const response=await request(f.handler,{method:'POST',url:'/api/basic-memory-settings/raw-messages',
    body:{action:'withdraw',id:saved.id,revision:saved.revision}});
  assert.equal(response.statusCode,403);
  assert.equal(response.body.ok,false);
  assert.equal(f.store.messages.get({ownerSubject:owner,project:'main',id:saved.id}).id,saved.id);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {RawMemoryStore} from '../lib/raw-rag/store.js';

const allowed={authorize:()=>true};
const input=(patch={})=>({ownerSubject:'owner-a',project:'main',sessionId:'session-a',messageId:'user-a',role:'user',sequence:1,turn:1,rootTurn:1,
  text:'原话及其条件：周末有空才去。',content:[{type:'text',text:'原话及其条件：周末有空才去。'}],time:123456,authorization:{epoch:'test-epoch'},...patch});
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'raw-message-test-')),file=path.join(directory,'raw.sqlite');
  let store=new RawMemoryStore(file,{warn(){}});
  t.after(async()=>{store.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});});
  return {get store(){return store;},restart(){store.close();store=new RawMemoryStore(file,{warn(){}});}};
}

test('projection receipts are independent, version checked and persisted without copying original bodies',async t=>{
  const f=await fixture(t),source=f.store.messages.record(input(),allowed).source;
  const text={...source,consumer:'raw-text-v1'},recent={...source,consumer:'recent-v1'};
  assert.equal(f.store.messages.projectionWork(text).length,1);
  assert.equal(f.store.messages.projectionReceipt(text,allowed),true);
  assert.equal(f.store.messages.projectionWork(text).length,0);
  assert.equal(f.store.messages.projectionReceipt({...recent,error:'cache unavailable'},allowed),true);
  let pending=f.store.messages.projectionWork(recent);assert.equal(pending.length,1);assert.equal(pending[0].error,'cache unavailable');assert.equal('text' in pending[0],false);
  f.store.messages.completeTurn({...input(),state:'completed'},allowed);
  assert.equal(f.store.messages.projectionReceipt(recent,allowed),false);
  f.restart();pending=f.store.messages.projectionWork(recent);assert.equal(pending.length,1);
  assert.equal(f.store.messages.projectionWork(text).length,1);
  assert.throws(()=>f.store.messages.projectionReceipt({...pending[0],consumer:'recent-v1'},{authorize:()=>false}));
  assert.equal(f.store.messages.projectionReceipt({...pending[0],consumer:'recent-v1'},allowed),true);
  assert.equal(f.store.messages.projectionWork(recent).length,0);
});

test('only original message bodies persist independently of completed turns or embeddings',async t=>{
  const f=await fixture(t),user=f.store.messages.record(input(),allowed);
  const body=[{type:'text',text:'助手尚未完成的原话。'}];
  const content=[{type:'reasoning',text:'qa-only-reasoning'},{...body[0],extra:'qa-only-extra'},
    {type:'image',url:'qa-only://image-one'},{type:'tool-call',name:'search',input:'qa-only-search'},
    {type:'tool-result',text:'qa-only-result'}];
  const assistant=f.store.messages.record(input({messageId:'assistant-a',role:'assistant',sequence:2,text:'助手尚未完成的原话。',content,messageState:'interrupted'}),allowed);
  assert.equal(user.source.turnState,'pending');assert.equal(assistant.source.role,'assistant');
  assert.deepEqual(assistant.source.content,body);assert.equal(assistant.source.text,body[0].text);assert.equal(assistant.source.messageState,'interrupted');
  const stored=f.store.db.prepare('SELECT core_json FROM raw_message_versions WHERE id=?').get(assistant.source.id).core_json;
  assert.equal(stored.includes('qa-only'),false);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM turns').get().n,0);
  assert.equal(f.store.messages.list(input()).sources.length,2);
  f.restart();assert.deepEqual(f.store.messages.get({...input(),id:assistant.source.id}).content,body);
});

test('event replay is idempotent while A-to-B-to-A edits retain three immutable versions',async t=>{
  const f=await fixture(t),first=f.store.messages.record(input(),allowed);
  const duplicate=f.store.messages.record(input({authorization:{epoch:'test-epoch',issuedAt:'later'}}),allowed);
  assert.equal(duplicate.duplicate,true);assert.equal(duplicate.source.revision,1);
  assert.equal(f.store.messages.changes(input()).length,1);
  f.store.messages.record(input({sequence:2,text:'另一版',content:[{type:'text',text:'另一版'}]}),allowed);
  const third=f.store.messages.record(input({sequence:3}),allowed);assert.equal(third.source.revision,3);
  const old=f.store.messages.get({...input(),id:first.source.id,revision:1});
  assert.equal(old.text,input().text);assert.equal(old.currentRevision,3);assert.equal(old.isCurrent,false);
  assert.equal(f.store.messages.get({...input(),id:first.source.id,revision:2}).text,'另一版');
  f.restart();assert.equal(f.store.messages.get({...input(),id:first.source.id}).revision,3);
  assert.equal(f.store.messages.record(input(),allowed).skipped,'stale-native-event');
  assert.equal(f.store.messages.get({...input(),id:first.source.id}).revision,3);
});

test('legacy mixed-block replay preserves the complete stored event and rejects same-sequence changes',async t=>{
  const f=await fixture(t);
  const text='第一段\n第二段',body=[{type:'text',text}];
  const content=[{type:'reasoning',text:'fixture reasoning'},{type:'text',text:'第一段',extra:'fixture metadata'},
    {type:'image',url:'fixture://attachment'},{type:'text',text:'第二段'}];
  const event=input({messageId:'assistant-a',role:'assistant',text,content,origin:{kind:'fixture'}});
  const saved=f.store.messages.record(event,allowed),id=saved.source.id;
  const versions=()=>f.store.db.prepare('SELECT * FROM raw_message_versions WHERE id=? ORDER BY revision').all(id);
  // The legacy writer kept both supplied fields and used the same schema and key order.
  const legacyJson=JSON.stringify({...JSON.parse(versions()[0].core_json),text,content});
  f.store.db.prepare('UPDATE raw_message_versions SET core_json=? WHERE id=? AND revision=1').run(legacyJson,id);
  const history=versions();
  f.restart();

  const replay=f.store.messages.record(structuredClone(event),allowed);
  assert.deepEqual(replay,{duplicate:true,notice:null,source:{...saved.source,content}});
  for(const patch of [
    {text:'正文已改',content:[{type:'text',text:'正文已改'}]},
    {text:'旧文本投影已改'},
    {content:[{...content[0],text:'changed reasoning'},...content.slice(1)]},
    {content:body},
    {origin:{kind:'changed'}},
  ])assert.throws(()=>f.store.messages.record({...event,...patch},allowed),/cannot change its payload/);
  assert.deepEqual(versions(),history);
  assert.deepEqual(f.store.messages.changes(event),[saved.notice]);

  const next=f.store.messages.record({...event,sequence:2},allowed);
  assert.equal(next.source.revision,2);
  assert.deepEqual(JSON.parse(versions()[1].core_json).content,body);
  assert.deepEqual(versions()[0],history[0]);
  assert.equal(f.store.messages.record({...event,sequence:2,content:body},allowed).duplicate,true);
  assert.throws(()=>f.store.messages.record({...event,sequence:2,content:[{type:'text',text:'正文又改'}]},allowed),/cannot change its payload/);
  assert.equal(f.store.messages.record(event,allowed).skipped,'stale-native-event');
  assert.deepEqual(f.store.messages.changes(event),[saved.notice,next.notice]);
});

test('revoked queued work commits neither original bytes nor a feed notification',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.store.messages.record(input(),{authorize:()=>false}),{code:'MEMORY_NOT_AUTHORIZED'});
  assert.equal(f.store.messages.changes(input()).length,0);assert.equal(f.store.messages.list(input()).sources.length,0);
  const saved=f.store.messages.record(input(),allowed);
  assert.throws(()=>f.store.messages.record(input({text:'不应写入'}),{authorize:()=>false}),{code:'MEMORY_NOT_AUTHORIZED'});
  assert.equal(f.store.messages.get({...input(),id:saved.source.id}).revision,1);
});

test('completion updates metadata without regenerating a content revision or replaying events',async t=>{
  const f=await fixture(t),saved=f.store.messages.record(input(),allowed);
  const notices=f.store.messages.completeTurn({...input(),state:'completed'},allowed);
  assert.equal(notices.length,1);assert.equal(notices[0].revision,1);assert.ok(notices[0].position>saved.notice.position);
  const current=f.store.messages.get({...input(),id:saved.source.id});assert.equal(current.turnState,'completed');assert.equal(current.revision,1);
  assert.deepEqual(f.store.messages.completeTurn({...input(),state:'completed'},allowed),[]);
  const changes=f.store.messages.changes({...input(),after:saved.notice.position});assert.equal(changes.length,1);
  assert.equal('text' in changes[0],false);assert.equal('authorization' in changes[0],false);
});

test('owners, projects, pagination and source withdrawal do not widen visibility or erase history',async t=>{
  const f=await fixture(t),first=f.store.messages.record(input(),allowed);
  f.store.messages.record(input({messageId:'user-b',sequence:2}),allowed);
  const page=f.store.messages.list({...input(),limit:1});assert.equal(page.sources.length,1);assert.ok(page.nextBefore);
  assert.equal(f.store.messages.list({...input(),beforePosition:page.nextBefore,limit:1}).sources[0].id,first.source.id);
  assert.equal(f.store.messages.get({...input(),ownerSubject:'other',id:first.source.id}),null);
  assert.equal(f.store.messages.get({...input(),project:'other',id:first.source.id}),null);
  f.store.messages.withdraw({...input(),id:first.source.id},allowed);
  assert.equal(f.store.messages.get({...input(),id:first.source.id}),null);
  assert.equal(f.store.messages.get({...input(),id:first.source.id,revision:1,includeWithdrawn:true}).text,input().text);
  assert.equal(f.store.messages.withdraw({...input(),id:first.source.id},allowed),null);
});

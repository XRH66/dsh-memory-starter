import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Session} from '@deepseek-ai/dsh-session';
import {RawMemoryStore,buildTurn} from '../lib/raw-rag/store.js';
import {createRawQueryReader} from '../lib/raw-rag/query-reader.js';
import {createSessionMemory} from '../lib/session-memory.js';

const scope={ownerSubject:'qa-owner',project:'main'},allowed={authorize:()=>true};
async function fixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'raw-query-reader-')),memory=new RawMemoryStore(path.join(directory,'existing.sqlite'),{warn(){}});
  t.after(async()=>{memory.close();await fs.rm(directory,{recursive:true,force:true});});
  const source=(patch={})=>({...scope,sessionId:'session-qa',messageId:'qa-user',role:'user',sequence:1,turn:1,rootTurn:1,text:'  只有周末有空，才整理书架。  ',content:[{type:'text',text:'  只有周末有空，才整理书架。  '}],time:1000,authorization:{fixture:true},...patch});
  return {directory,memory,source,reader:createRawQueryReader(memory,scope,allowed)};
}

test('committed originals are text searchable before any text or vector projection exists',async t=>{
  const f=await fixture(t),saved=f.memory.messages.record(f.source(),allowed).source;
  const result=f.reader.search({query:'书架'});assert.equal(result.sources.length,1);assert.equal(result.sources[0].text,f.source().text);
  assert.equal(result.sources[0].revision,1);assert.equal('authorization' in result.sources[0],false);assert.equal('content' in result.sources[0],false);
  assert.equal(f.reader.get(result.sources[0].ref).id,saved.id);assert.equal(f.memory.db.prepare('SELECT COUNT(*) n FROM turns').get().n,0);
  assert.equal(f.reader.search({query:'工具箱'}).sources.length,0);
});

test('old raw text stays readable with real speaker and a persistent version rather than a guessed new source',async t=>{
  const f=await fixture(t),turn=buildTurn({scope:scope.ownerSubject,namespace:'default',sessionId:'session-old',turn:2,completedAt:1000,messages:[
    {id:'old-u',role:'user',text:'只有晴天才去山坡。',ts:1000,seq:3},{id:'old-a',role:'assistant',text:'我建议先看天气。',ts:1001,seq:4},
  ]});f.memory.archiveTurn(turn);
  const result=f.reader.search({query:'山坡'});assert.equal(result.sources.length,1);const source=result.sources[0];
  assert.equal(source.role,'user');assert.equal(source.ref.storage,'legacy');assert.equal(typeof source.revision,'string');
  const neighbors=f.reader.neighbors(source.ref);assert.deepEqual(neighbors.map(item=>item.role),['user','assistant']);assert.equal(neighbors[1].text,'我建议先看天气。');
});

test('changed originals supersede stale text hits and stale vectors cannot acquire their new body',async t=>{
  const f=await fixture(t),one=f.memory.messages.record(f.source(),allowed).source;
  const turn=buildTurn({scope:scope.ownerSubject,namespace:'default',sessionId:one.sessionId,turn:1,completedAt:1000,messages:[{id:one.messageId,role:'user',text:one.text,ts:1000,seq:1}]});f.memory.archiveTurn(turn);
  const old=f.reader.search({query:'书架'}).sources[0],indexed=f.memory.recentTurns(scope.ownerSubject);
  f.memory.messages.record(f.source({sequence:2,text:'已改为整理工具箱。',content:[{type:'text',text:'已改为整理工具箱。'}]}),allowed);
  assert.equal(f.reader.search({query:'书架'}).sources.length,0);assert.equal(f.reader.search({query:'工具箱'}).sources.length,1);
  assert.equal(f.reader.get(old.ref),null);assert.equal(f.reader.fromTurns(indexed,{query:'书架',vector:true}).length,0);
  f.memory.messages.withdraw({...scope,id:one.id},allowed);assert.equal(f.reader.search({query:'书架'}).sources.length,0);assert.equal(f.reader.search({query:'工具箱'}).sources.length,0);
});

test('exact identifiers, operator exclusions and same-turn role order apply even to pending projections',async t=>{
  const f=await fixture(t);f.memory.messages.record(f.source({text:'编号 DOC731 尚未启用。',content:[{type:'text',text:'编号 DOC731 尚未启用。'}]}),allowed);
  f.memory.messages.record(f.source({messageId:'qa-assistant',role:'assistant',sequence:2,text:'这是建议，不是用户决定。',content:[{type:'text',text:'这是建议，不是用户决定。'}]}),allowed);
  assert.equal(f.reader.search({query:'DOC73'}).sources.length,0);const found=f.reader.search({query:'DOC731'}).sources[0];assert.ok(found);
  assert.deepEqual(f.reader.neighbors(found.ref).map(item=>item.role),['user','assistant']);
  f.memory.setControl({scope:scope.ownerSubject,targetType:'message',targetId:'qa-user',excluded:true});assert.equal(f.reader.search({query:'DOC731'}).sources.length,0);
  assert.equal(f.reader.recent().length,1);
});

test('scope and revoked read callbacks cannot expose another owner or execute a saved anchor',async t=>{
  const f=await fixture(t);f.memory.messages.record(f.source(),allowed);const source=f.reader.search({query:'书架'}).sources[0];
  const other=createRawQueryReader(f.memory,{...scope,ownerSubject:'other'},allowed);assert.equal(other.search({query:'书架'}).sources.length,0);
  const closed=createRawQueryReader(f.memory,scope,{authorize:()=>false});assert.throws(()=>closed.get(source.ref),{code:'MEMORY_NOT_AUTHORIZED'});
});

test('legacy pages cover older turns with a stable cursor and omit originals already owned by the canonical source',async t=>{
  const f=await fixture(t);
  for(let n=0;n<5;n++)f.memory.archiveTurn(buildTurn({scope:scope.ownerSubject,namespace:'default',sessionId:'old-session-'+n,turn:1,completedAt:1000+n,
    messages:[{id:'old-'+n,role:'user',text:'虚构历史 '+n,ts:1000+n,seq:1}]}));
  const all=[];let after='';
  do{const page=f.reader.legacyPage({after,limit:2});all.push(...page.sources);after=page.nextAfter;}while(after);
  assert.equal(all.length,5);assert.equal(new Set(all.map(row=>row.id)).size,5);
  assert.ok(all.every(row=>f.reader.get(row.ref)?.text===row.text));
  f.memory.setControl({scope:scope.ownerSubject,targetType:'message',targetId:'old-2',excluded:true});
  assert.equal(f.reader.legacyPage().sources.some(row=>row.messageId==='old-2'),false);
});

function saveMessage(f,messageId,sequence,turn,patch={}){
  const saved=f.memory.messages.record(f.source({messageId,sequence,turn,rootTurn:turn,
    content:[{type:'text',text:'  原话 '+messageId+'  '}],...patch}),allowed).source;
  return {storage:'message',id:saved.id,revision:saved.revision};
}

test('embedding context keeps at most four exact prior sources in session order',async t=>{
  const f=await fixture(t),{reader}=f;
  saveMessage(f,'older-turn',1,1);
  const first=saveMessage(f,'first',2,2),second=saveMessage(f,'second',3,2,{role:'assistant'});
  const third=saveMessage(f,'third',4,2),fourth=saveMessage(f,'fourth',5,3);
  const fifth=saveMessage(f,'fifth',6,3,{role:'assistant'}),center=saveMessage(f,'center',7,3);
  const expected=[second,third,fourth,fifth].map(ref=>reader.get(ref));
  assert.deepEqual(reader.embeddingContext(center),expected);
  assert.deepEqual(reader.embeddingContext(center,{limit:12}),expected);
  assert.deepEqual(reader.embeddingContext(center,{limit:2}),expected.slice(-2));
  assert.deepEqual(reader.embeddingContext(center,{limit:0}),[]);
  assert.deepEqual(reader.embeddingContext(fourth),[first,second,third].map(ref=>reader.get(ref)));
  const otherTurn=saveMessage(f,'nonadjacent',8,5);
  assert.deepEqual(reader.embeddingContext(otherTurn),[]);
  saveMessage(f,'same-turn-followup',8,3);
  saveMessage(f,'next-turn',9,4);
  assert.deepEqual(reader.embeddingContext(center),expected);
});

test('embedding context stops at excluded, hidden and withdrawn slots even across proven event gaps',async t=>{
  const f=await fixture(t),{reader,memory}=f;
  const grant={authorization:{intervalId:'open-interval'}};
  const older=saveMessage(f,'older',1,1,grant),blocked=saveMessage(f,'blocked',4,1,grant);
  const near=saveMessage(f,'near',7,1,grant),center=saveMessage(f,'center',10,1,grant);
  const suffix=[reader.get(near)];
  assert.deepEqual(reader.embeddingContext(center),[older,blocked,near].map(ref=>reader.get(ref)));
  memory.setControl({scope:scope.ownerSubject,targetType:'message',targetId:'blocked',excluded:true});
  assert.deepEqual(reader.embeddingContext(center),suffix);
  assert.deepEqual(reader.embeddingContext(blocked),[]);
  memory.setControl({scope:scope.ownerSubject,targetType:'message',targetId:'blocked',excluded:false});
  const projection=buildTurn({scope:scope.ownerSubject,sessionId:f.source().sessionId,turn:1,completedAt:1000,
    messages:[{id:'blocked',role:'user',seq:4,text:'Hidden projection'}]});
  memory.archiveTurn(projection);
  memory.db.prepare('UPDATE turn_visibility SET source_hidden=1 WHERE turn_id=?').run(projection.turnId);
  assert.deepEqual(reader.embeddingContext(center),suffix);
  assert.deepEqual(reader.embeddingContext(blocked),[]);
  memory.markImportedVisible(scope.ownerSubject,projection.turnId);
  memory.messages.withdraw({...scope,id:blocked.id},allowed);
  assert.deepEqual(reader.embeddingContext(center),suffix);
  assert.deepEqual(reader.embeddingContext(blocked),[]);
  const afterGap=saveMessage(f,'after-gap',14,1);
  assert.deepEqual(reader.embeddingContext(afterGap),[]);
  saveMessage(f,'center',18,1);
  assert.deepEqual(reader.embeddingContext(center),[]);
  const closed=createRawQueryReader(memory,scope,{authorize:()=>false});
  assert.throws(()=>closed.embeddingContext(afterGap),{code:'MEMORY_NOT_AUTHORIZED'});
});

test('embedding context respects turn completion and does not cross into a reopened authorization interval',async t=>{
  const f=await fixture(t),{reader}=f,authorization={intervalId:'open-interval'};
  const user=saveMessage(f,'user',4,1,{authorization});
  const center=saveMessage(f,'center',16,2,{authorization});
  assert.deepEqual(reader.embeddingContext(center),[]);
  const complete=state=>f.memory.messages.completeTurn({...scope,sessionId:f.source().sessionId,turn:1,state},allowed);
  complete('interrupted');
  assert.deepEqual(reader.embeddingContext(center),[]);
  complete('completed');
  assert.deepEqual(reader.embeddingContext(center),[reader.get(user)]);
  const reopened=saveMessage(f,'center',17,2,{authorization:{intervalId:'reopened-interval'}});
  assert.deepEqual(reader.embeddingContext(reopened),[]);
  const afterReopen=saveMessage(f,'answer',20,2,{role:'assistant',authorization:{intervalId:'reopened-interval'}});
  assert.deepEqual(reader.embeddingContext(afterReopen),[reader.get(reopened)]);
  const adjacentAcrossIntervals=saveMessage(f,'adjacent-after-reopen',21,2,{authorization});
  assert.deepEqual(reader.embeddingContext(adjacentAcrossIntervals),[]);
  const reopenedAtBoundary=saveMessage(f,'reopened-at-boundary',16,2,{authorization:{intervalId:'reopened-interval'}});
  assert.deepEqual(reader.embeddingContext(reopenedAtBoundary),[]);
});

test('embedding context reads persisted native grants across request, tool and turn events',async t=>{
  const {directory,memory,reader}=await fixture(t),session=Session.create('session-native-context');
  const agent={id:session.id,session};
  const access=await createSessionMemory({directory,ownerSubject:scope.ownerSubject,
    agents:{get:id=>id===session.id?agent:undefined,list:()=>[agent],isOwnedBy:()=>false},
    sessions:{get:id=>id===session.id?session:undefined}});
  t.after(()=>access.close());
  await access.set(session.id,true);
  const append=(type,data)=>session.append(type,data);
  const record=(type,data)=>{
    const event=session.append(type,data,{surfaceOp:'append'});
    const {source,grant}=access.admitMessage(session,event);
    const authorize=()=>access.validateMessage(grant);
    const {source:saved}=memory.messages.record(source,{authorize});
    assert.equal(saved.sequence,event.seq);
    assert.equal(saved.authorization.intervalId,grant.intervalId);
    assert.ok(saved.authorization.intervalId);
    return {ref:{storage:'message',id:saved.id,revision:saved.revision},authorize};
  };
  const user=id=>record('user/message',{id,role:'user',source:{kind:'user'},content:[{type:'text',text:id}]});
  const assistant=(id,step)=>record('assistant/message',{turn:1,step,stream:[],message:{id,role:'assistant',
    source:{kind:'model',provider:'fixture',model:'fixture'},content:[{type:'text',text:id}]}});
  append('turn/start',{turn:1});
  append('step/start',{turn:1,step:1});
  const first=user('first-user');
  append('request/header',{header:{provider:'fixture',model:'fixture'},reason:'initial'});
  append('request/context',{provider:'fixture',model:'fixture'});
  const draft=assistant('before-tool',1);
  append('tool/call',{turn:1,step:1,callId:'fixture-call',name:'search',arguments:{}});
  append('step/end',{turn:1,step:1});
  append('step/start',{turn:1,step:2});
  const reply=assistant('after-tool',2);
  assert.deepEqual(reader.embeddingContext(reply.ref),[first,draft].map(({ref})=>reader.get(ref)));
  append('step/end',{turn:1,step:2});
  const end=append('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.equal(access.observe(session,end),true);
  memory.messages.completeTurn({...scope,sessionId:session.id,turn:end.data.turn,state:end.data.reason.kind},{authorize:reply.authorize});
  append('turn/start',{turn:2});
  append('step/start',{turn:2,step:3});
  const next=user('next-user');
  const slots=[1,2].flatMap(turn=>memory.messages.embeddingSlots({...scope,sessionId:session.id,turn}));
  assert.equal(new Set(slots.map(slot=>slot.intervalId)).size,1);
  assert.ok(reader.get(next.ref).sequence-reader.get(reply.ref).sequence>3);
  assert.deepEqual(reader.embeddingContext(next.ref),[first,draft,reply].map(({ref})=>reader.get(ref)));
});

test('embedding context preserves approved legacy fragments and stops at omitted messages',async t=>{
  const f=await fixture(t),{reader,memory}=f,sessionId=f.source().sessionId;
  const turn=buildTurn({scope:scope.ownerSubject,sessionId,turn:1,completedAt:1000,messages:[
    {id:'older',role:'user',seq:1,text:'Older approved.'},
    {id:'omitted',role:'assistant',seq:2,text:'OMITTED'},
    {id:'excerpt',role:'user',seq:3,text:'Approved. PRIVATE. Also approved.'},
    {id:'legacy-center',role:'assistant',seq:4,text:'Legacy center.'},
  ]});
  memory.archiveTurn(turn);
  const oldCenter=reader.legacyPage().sources.find(source=>source.messageId==='legacy-center');
  const {turnRevision}=memory.getLegacyScopeView({scope:scope.ownerSubject,turnId:turn.turnId});
  memory.setLegacyScopeView({scope:scope.ownerSubject,turnId:turn.turnId,turnRevision,messages:[
    {messageId:'older',ranges:[[0,15]]},
    {messageId:'omitted',ranges:[]},
    {messageId:'excerpt',ranges:[[0,9],[19,33]]},
    {messageId:'legacy-center',ranges:[[0,14]]},
  ]});
  const sources=reader.legacyPage().sources;
  const center=sources.find(source=>source.messageId==='legacy-center');
  const excerpt=sources.find(source=>source.messageId==='excerpt');
  assert.deepEqual(reader.embeddingContext(oldCenter.ref),[]);
  assert.deepEqual(reader.embeddingContext(center.ref),[reader.get(excerpt.ref)]);
  assert.match(excerpt.text,/Approved\./);
  assert.match(excerpt.text,/Also approved\./);
  assert.doesNotMatch(JSON.stringify(excerpt),/PRIVATE|OMITTED/);
  const next=saveMessage(f,'modern-center',7,2);
  assert.deepEqual(reader.embeddingContext(next),[excerpt,center].map(source=>reader.get(source.ref)));
  memory.setControl({scope:scope.ownerSubject,targetType:'turn',targetId:turn.turnId,excluded:true});
  assert.deepEqual(reader.embeddingContext(next),[]);
});

test('an old message with a default sequence cannot establish continuity',async t=>{
  const f=await fixture(t),{reader,memory}=f;
  memory.archiveTurn(buildTurn({scope:scope.ownerSubject,sessionId:f.source().sessionId,turn:1,completedAt:1000,messages:[
    {id:'unknown',role:'user',text:'Unknown event position.'},
    {id:'legacy-center',role:'assistant',seq:1,text:'Known event position.'},
  ]}));
  const {ref}=reader.legacyPage().sources.find(source=>source.messageId==='legacy-center');
  assert.deepEqual(reader.embeddingContext(ref),[]);
});

test('embedding context stays inside owner, project and session and uses canonical message projections once',async t=>{
  const f=await fixture(t),{reader,memory}=f,sessionId=f.source().sessionId;
  saveMessage(f,'older',1,1);
  saveMessage(f,'other-session',2,1,{sessionId:'another-session'});
  saveMessage(f,'other-owner',2,1,{ownerSubject:'another-owner'});
  const foreign=saveMessage(f,'other-project',2,1,{project:'another-project'});
  const mirror=(project,ref,sequence)=>{
    const saved=memory.messages.get({ownerSubject:scope.ownerSubject,project,id:ref.id});
    memory.archiveTurn(buildTurn({scope:scope.ownerSubject,sessionId,turn:1,completedAt:1000,
      turnId:'message:'+JSON.stringify([scope.ownerSubject,project,saved.id]),
      messages:[{id:saved.messageId,seq:sequence,role:saved.role,text:saved.text}]}));
  };
  mirror('another-project',foreign,2);
  const near=saveMessage(f,'near',3,1),center=saveMessage(f,'center',4,1);
  mirror(scope.project,near,3);
  assert.deepEqual(reader.embeddingContext(center),[reader.get(near)]);
  const legacyAlias=reader.legacyPage().sources.find(source=>source.id===foreign.id);
  assert.deepEqual(reader.embeddingContext(legacyAlias.ref),[]);
  const other=createRawQueryReader(memory,{...scope,project:'another-project'},allowed);
  assert.deepEqual(other.embeddingContext(center),[]);
});

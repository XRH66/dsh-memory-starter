import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {apply} from '../lib/platform-host.js';
import {deploymentStaticFingerprint} from '../lib/deployment-config.js';
import {memoryStore} from './fake-memory.js';

test('portable host replaces pure-mode isolation while retaining the fixed persona and ordinary tools',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'opt-in-host-')),base=path.join(directory,'persona.md');
  await fs.writeFile(base,'fixed-persona-fixture');
  const callbacks=new Map(),services=new Map(),effects=[],registered=new Map(),guards=[],events=[];
  const session={id:'session-first',seq:0,snapshotEvents:(from=0,to=events.length)=>events.slice(from,to),deriveMessages:()=>[]};
  const restrictions=[],scope={restrict(value){restrictions.push(value);return()=>restrictions.splice(restrictions.indexOf(value),1);}};
  const agent={id:session.id,session,status:'idle',ctx:{get:()=>scope}};
  let opens=0;const memory=memoryStore(),cfg={ownerDirectory:directory,dshSessionIds:[],fixture:true};
  const ctx={llm:{},logger:{warn(){}},sessions:{get:id=>id===session.id?session:undefined,ensure:async()=>session},
    agents:{get:id=>id===session.id?agent:undefined,list:()=>[agent],isOwnedBy:()=>false},
    tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);},guard(fn){guards.push(fn);return()=>{};},view(){return {restrictableNames:new Set([...registered.keys(),'ordinary_tool','mcp__basic_memory__read_note','recent_conversation'])};}},
    get:key=>services.get(key),provide:(key,value)=>services.set(key,value),effect(fn){effects.push(fn());},
    on(name,fn){callbacks.set(name,[...(callbacks.get(name)||[]),fn]);}};
  try{
    const service=await apply(ctx,{directory,sessionIds:[],ownerSubject:'fixture-owner',sessionMemory:true,
      persona:{basePersona:base,selfProfile:path.join(directory,'vault','must-not-read.md')},
      configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment:{async markApplied(){}},
      memory:{autoCapture:false,autoRecall:false,recentContext:false,rawRecall:false}},
      {acquire:async()=>{opens++;return memory;}});
    const control=services.get('sessionMemory');assert.equal(control.check(agent).allowed,false);assert.equal(opens,0);
    assert.equal(services.has('pureMode'),false);assert.equal(services.has('unifiedMemory'),false);
    assert.ok(restrictions.some(value=>value.deny.includes('dafeiyu_records')));
    assert.ok(guards.some(guard=>guard({name:'dafeiyu_records',agent})));
    assert.ok(guards.every(guard=>!guard({name:'ordinary_tool',agent})));
    const assembled=await callbacks.get('system-prompt/assemble')[0]({}, {agent},async()=>({sections:[],tools:[{name:'ordinary_tool'},{name:'dafeiyu_records'}]}));
    assert.match(assembled.sections[0].text,/fixed-persona-fixture/);assert.deepEqual(assembled.tools.map(t=>t.name),['ordinary_tool']);
    await service.applySessionSelection({...cfg,dshSessionIds:[session.id]},'saved',{action:'bind',value:session.id});assert.equal(control.check(agent).allowed,false);
    const event={type:'turn/start',seq:0,time:Date.now(),data:{turn:1}};events.push(event);session.seq=1;
    for(const fn of callbacks.get('session/event'))fn(session,event);
    assert.equal(control.check(agent).allowed,true);const grant=control.grant(agent);
    assert.deepEqual([...registered.keys()].sort(),['dafeiyu_records','memory_open','memory_recent','memory_search','soften_memory']);
    assert.ok(restrictions.some(value=>value.deny.includes('mcp__basic_memory__read_note')&&value.deny.includes('recent_conversation')&&!value.deny.includes('memory_search')));
    assert.ok(guards.some(guard=>guard({name:'mcp__basic_memory__read_note',agent})));
    assert.ok(guards.every(guard=>!guard({name:'memory_search',agent})));
    await fs.mkdir(path.join(directory,'vault'),{recursive:true});await fs.writeFile(path.join(directory,'vault','must-not-read.md'),'<!-- dafeiyu-record kind=thoughts -->\nEnabled fixture profile');
    const enabledPrompt=await callbacks.get('system-prompt/assemble')[0]({}, {agent},async()=>({sections:[],tools:[{name:'ordinary_tool'},{name:'dafeiyu_records'},{name:'memory_search'},{name:'mcp__basic_memory__read_note'}]}));
    assert.deepEqual(enabledPrompt.tools.map(tool=>tool.name),['ordinary_tool','dafeiyu_records','memory_search']);
    await service.applySessionSelection(cfg,'closed',{action:'unbind',value:session.id});assert.equal(control.check(agent).allowed,false);assert.equal(control.validate(grant),false);assert.equal(opens,0);
  }finally{for(const dispose of effects.reverse())await dispose?.();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));await fs.rm(directory,{recursive:true,force:true});}
});

test('changing one opt-in never authorizes other legacy bindings and survives restart',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'opt-in-legacy-'));
  assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
  const ids=['session-legacy-a','session-legacy-b'],cfg={ownerDirectory:directory,dshSessionIds:ids,fixture:true};
  let effects=[],opens=0;
  async function start(){
    const events=new Map(ids.map(id=>[id,[]]));
    const sessions=new Map(ids.map(id=>[id,{id,seq:0,snapshotEvents:(from=0,to)=>events.get(id).slice(from,to),deriveMessages:()=>[]}]));
    const agents=new Map(ids.map(id=>[id,{id,session:sessions.get(id),status:'idle',ctx:{}}]));
    const services=new Map(),ctx={llm:{},logger:{warn(){}},
      sessions:{get:id=>sessions.get(id),ensure:async id=>{if(!sessions.has(id))throw Error('unknown session');return sessions.get(id);}},
      agents:{get:id=>agents.get(id),list:()=>[...agents.values()],isOwnedBy:()=>false},
      tools:{register(){return()=>{};},guard(){return()=>{};}},get:key=>services.get(key),
      provide:(key,value)=>services.set(key,value),effect(fn){effects.push(fn());},on(){}};
    const service=await apply(ctx,{directory,sessionIds:ids,ownerSubject:'fixture-owner',sessionMemory:true,
      configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment:{async markApplied(){}},
      memory:{autoCapture:false,autoRecall:false,recentContext:false,rawRecall:false}},
      {acquire:async()=>{opens++;return memoryStore();}});
    return {service,control:services.get('sessionMemory')};
  }
  async function stop(){const current=effects;effects=[];for(const dispose of current.reverse())await dispose?.();}
  t.after(stop);
  t.after(async()=>{
    assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
    await fs.rm(directory,{recursive:true,force:true});
  });
  let {service,control}=await start();
  assert.deepEqual(ids.map(id=>control.status(id).requested),[false,false]);
  await service.applySessionSelection(cfg,'enable-a',{action:'bind',value:ids[0]});
  assert.deepEqual(ids.map(id=>control.status(id).requested),[true,false]);
  await stop();({service,control}=await start());
  assert.deepEqual(ids.map(id=>control.status(id).requested),[true,false]);
  await assert.rejects(service.applySessionSelection(cfg,'implicit-save'),/明确/);
  assert.deepEqual(ids.map(id=>control.status(id).requested),[true,false]);
  await service.applySessionSelection({...cfg,dshSessionIds:[ids[1]]},'disable-a',{action:'unbind',value:ids[0]});
  assert.deepEqual(ids.map(id=>control.status(id).requested),[false,false]);
  await service.applySessionSelection(cfg,'reenable-a',{action:'bind',value:ids[0]});
  assert.deepEqual(ids.map(id=>control.status(id).requested),[true,false]);
  await service.applySessionSelection({...cfg,dshSessionIds:[ids[1]]},'replace-b',{action:'replace',value:[ids[1]]});
  assert.deepEqual(ids.map(id=>control.status(id).requested),[false,true]);
  assert.equal(opens,0);
});

test('portable tool scopes refresh only for the affected family, except on tool catalog changes',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'opt-in-scopes-'));
  assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
  const agents=new Map(),sessions=new Map(),owners=new Map(),callbacks=new Map(),registered=new Map();
  const effects=[],guards=[],viewed=[],catalog=new Set(['ordinary_tool','mcp__basic_memory__read_note']);
  let lists=0;
  const emit=(name,...args)=>{for(const fn of callbacks.get(name)??[])fn(...args);};
  function actor(id,owner){
    const events=[],denied=new Set();
    const session={id,get seq(){return events.length;},snapshotEvents:(from=0,to=events.length)=>events.slice(from,to),deriveMessages:()=>[]};
    const agent={id,session,status:'idle',events,denied,ctx:{tools:{restrict({deny}){
      for(const name of deny)denied.add(name);
      emit('tools/change');
      return ()=>{for(const name of deny)denied.delete(name);emit('tools/change');};
    }}}};
    agents.set(id,agent);sessions.set(id,session);
    if(owner)owners.set(id,owner);
    return agent;
  }
  function commit(agent,type,data={}){
    const event={type,seq:agent.session.seq,time:Date.now(),data};
    agent.events.push(event);emit('session/event',agent.session,event);
  }
  const root=actor('session-root'),child=actor('session-child',root);
  const other=actor('session-unrelated'),otherChild=actor('session-unrelated-child',other);
  const ctx={llm:{},logger:{warn(){}},sessions:{get:id=>sessions.get(id)},
    agents:{get:id=>agents.get(id),list(){lists++;return [...agents.values()];},isOwnedBy:(id,owner)=>owners.get(id)===owner},
    tools:{
      register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);},
      guard(fn){guards.push(fn);return()=>{};},
      view(agent){viewed.push(agent.id);return {restrictableNames:new Set([...registered.keys(),...catalog])};}
    },
    effect(fn){effects.push(fn());},provide(){},
    on(name,fn){callbacks.set(name,[...(callbacks.get(name)??[]),fn]);}
  };
  t.after(async()=>{
    for(const dispose of effects.reverse())await dispose?.();
    await fs.rm(directory,{recursive:true,force:true});
  });
  const cfg={ownerDirectory:directory,dshSessionIds:[]};
  const service=await apply(ctx,{directory,sessionIds:[],ownerSubject:'fixture-owner',sessionMemory:true,
    configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment:{async markApplied(){}},
    memory:{autoCapture:false,autoRecall:false,recentContext:false,rawRecall:false}},
    {acquire:async()=>{throw Error('scope changes must not open the memory backend');}});
  const {sessionMemory:control}=service;
  const observe=t.mock.method(control,'observe'),check=t.mock.method(control,'check');
  const checked=()=>new Set(check.mock.calls.map(call=>call.arguments[0].id));
  const reset=()=>{viewed.length=0;lists=0;observe.mock.resetCalls();check.mock.resetCalls();};
  const memoryHidden=agent=>agent.denied.has('memory_search');

  assert.ok([...agents.values()].every(memoryHidden));
  reset();
  for(let i=0;i<12;i++){
    commit(other,'step/start');
    commit(other,'tool/result');
    emit('agent/status',{agent:other,status:'running'});
  }
  assert.equal(observe.mock.callCount(),24,'ordinary session events still reach observe');
  assert.equal(lists,0,'ordinary events do not enumerate live agents');
  assert.equal(check.mock.callCount(),0);
  assert.deepEqual(viewed,[]);

  commit(other,'turn/start',{turn:1});
  assert.deepEqual(checked(),new Set([other.id,otherChild.id]),'a root turn checks only its own family');
  assert.deepEqual(viewed,[],'unchanged authorization reuses the existing tool restriction');
  reset();
  await service.applySessionSelection({...cfg,dshSessionIds:[root.id]},'open',{action:'bind',value:root.id});
  assert.ok(memoryHidden(root)&&memoryHidden(child),'opening waits for the next root turn');
  assert.deepEqual(checked(),new Set([root.id,child.id]));
  assert.deepEqual(viewed,[]);
  reset();
  commit(child,'turn/start',{turn:1});
  assert.ok(memoryHidden(child),'a child turn cannot activate the root grant');
  assert.deepEqual(viewed,[]);
  reset();
  commit(root,'turn/start',{turn:1});
  assert.deepEqual(viewed,[root.id,child.id]);
  assert.ok(!memoryHidden(root)&&!memoryHidden(child)&&memoryHidden(other));

  reset();
  const grandchild=actor('session-grandchild',child);
  emit('agent/created',{agent:grandchild,source:'fresh'});
  assert.deepEqual(viewed,[grandchild.id]);
  assert.deepEqual(checked(),new Set([grandchild.id]));
  assert.equal(memoryHidden(grandchild),false,'a new descendant follows its active root');
  const grant=control.grant(grandchild);
  reset();
  const closing=service.applySessionSelection(cfg,'close',{action:'unbind',value:root.id});
  assert.deepEqual(viewed,[root.id,child.id,grandchild.id]);
  assert.ok([root,child,grandchild].every(memoryHidden),'descendants are hidden before the settings write completes');
  assert.equal(grant.signal.aborted,true);
  assert.ok(guards.some(guard=>guard({name:'memory_search',agent:grandchild})));
  await closing;
  assert.deepEqual(checked(),new Set([root.id,child.id,grandchild.id]));
  const prompt=await callbacks.get('system-prompt/assemble')[0]({}, {scope:{id:grandchild.id}},
    async()=>({sections:[],tools:[{name:'memory_search'},{name:'ordinary_tool'}]}));
  assert.deepEqual(prompt.tools.map(tool=>tool.name),['ordinary_tool']);

  // The policy captures its cutoff before replacing the file. A root turn
  // that starts during that write can activate memory once the write settles.
  const writing=Promise.withResolvers(),resumeWrite=Promise.withResolvers(),rename=fs.rename;
  const paused=t.mock.method(fs,'rename',async(from,to)=>{
    if(to===path.join(directory,'management','session-memory','policy.json')){
      writing.resolve();
      await resumeWrite.promise;
    }
    return rename(from,to);
  });
  const reopening=service.applySessionSelection({...cfg,dshSessionIds:[root.id]},'reopen',{action:'bind',value:root.id});
  try{
    await Promise.race([writing.promise,reopening]);
    commit(root,'turn/start',{turn:2});
    assert.ok([root,child,grandchild].every(memoryHidden),'pending enable is still closed');
  }finally{
    resumeWrite.resolve();
    paused.mock.restore();
    await reopening;
  }
  assert.ok([root,child,grandchild].every(agent=>!memoryHidden(agent)));
  reset();
  agents.delete(child.id);owners.delete(child.id);
  emit('agent/disposed',{agent:child});
  assert.equal(child.denied.size,0,'the removed agent releases its restriction');
  assert.ok(memoryHidden(grandchild),'losing the live owner removes inherited access');
  assert.deepEqual(viewed,[grandchild.id]);
  assert.deepEqual(checked(),new Set([grandchild.id]));

  reset();
  catalog.add('mcp__basic_memory__late_tool');emit('tools/change');
  assert.deepEqual(new Set(viewed),new Set(agents.keys()));
  assert.equal(viewed.length,agents.size);
  assert.ok([...agents.values()].every(agent=>agent.denied.has('mcp__basic_memory__late_tool')));
});

test('default owner is shared by session grants and raw memory queries',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'opt-in-default-owner-'));
  assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));
  const callbacks=new Map(),services=new Map(),registered=new Map(),effects=[],events=[];
  const session={id:'session-default-owner',seq:0,snapshotEvents:(from=0,to=events.length)=>events.slice(from,to),deriveMessages:()=>[]};
  const scope={restrict(){return()=>{};}};
  const agent={id:session.id,session,status:'idle',ctx:{get:()=>scope}};
  const ctx={llm:{},logger:{warn(){}},sessions:{get:id=>id===session.id?session:undefined,ensure:async()=>session},
    agents:{get:id=>id===session.id?agent:undefined,list:()=>[agent],isOwnedBy:()=>false},
    tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);},guard(){return()=>{};},view(){return {restrictableNames:new Set(registered.keys())};}},
    get:key=>services.get(key),provide:(key,value)=>services.set(key,value),effect(fn){effects.push(fn());},
    on(name,fn){callbacks.set(name,[...(callbacks.get(name)??[]),fn]);}};
  t.after(async()=>{
    for(const dispose of effects.reverse())await dispose?.();
    await fs.rm(directory,{recursive:true,force:true});
  });
  const cfg={ownerDirectory:directory,dshSessionIds:[]};
  const service=await apply(ctx,{directory,sessionIds:[],sessionMemory:true,
    configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment:{async markApplied(){}},
    memory:{autoCapture:false,autoRecall:false,recentContext:false,rawRecall:false}});
  assert.equal(service.ownerSubject,'用户');
  await service.applySessionSelection({...cfg,dshSessionIds:[session.id]},'bind-default',{action:'bind',value:session.id});
  const event={type:'turn/start',seq:0,time:Date.now(),data:{turn:1}};
  events.push(event);session.seq=1;
  for(const fn of callbacks.get('session/event'))fn(session,event);
  assert.equal(service.sessionMemory.status(session.id).requested,true);
  const tool=registered.get('memory_recent');
  assert.ok(tool,'memory_recent should be registered for an enabled session');
  const result=await tool.execute({limit:1},{agent,signal:new AbortController().signal});
  assert.equal(result.status,'empty');
  assert.deepEqual(result.records,[]);
});

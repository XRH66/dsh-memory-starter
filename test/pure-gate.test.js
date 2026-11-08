import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createPersonaRenderer,addSelectedPersona} from '../lib/persona-source.js';
import {createPureGate} from '../lib/pure-gate.js';
import {apply} from '../lib/platform-host.js';
import {memoryStore} from './fake-memory.js';

async function personaFixture(){
  const root=await fsp.mkdtemp(path.resolve('.local/pure-gate-')),vault=path.join(root,'vault'),base=path.join(root,'persona.md'),self=path.join(vault,'self.md');
  await fsp.mkdir(vault);
  await fsp.writeFile(base,'BASE_PERSONA_TEXT');
  await fsp.writeFile(self,'---\ntitle: test\n---\n<!-- dafeiyu-record kind=thoughts -->\nSELF_PROFILE_TEXT');
  return {root,base,self};
}

/** Count filesystem touches so "not injected" can never hide a real read. */
function spyFileAccess(t){
  const realRead=fs.readFileSync,realReal=fs.realpathSync,hits=[];
  fs.readFileSync=(file,...rest)=>{hits.push(String(file));return realRead(file,...rest);};
  fs.realpathSync=(file,...rest)=>{hits.push(String(file));return realReal(file,...rest);};
  t.after(()=>{fs.readFileSync=realRead;fs.realpathSync=realReal;});
  return {hits};
}
const ACTIVE=Object.freeze({ready:true,active:true}),INACTIVE=Object.freeze({ready:true,active:false}),STARTING=Object.freeze({ready:false,active:null});
/** A fake same-process service: the gate always asks it for the host agent's state. */
const serviceOf=ref=>({check:()=>ref.value});
const gateFor=value=>{const ref={value};return {ref,pure:createPureGate({getService:()=>serviceOf(ref)})};};

test('without the pure-mode plugin the persona is read and injected as before',async t=>{
  const {root,base,self}=await personaFixture(),spy=spyFileAccess(t),render=createPersonaRenderer({directory:root,basePersona:base,selfProfile:self});
  const text=render({session:{id:'session-a'}});
  assert.match(text,/BASE_PERSONA_TEXT[\s\S]*SELF_PROFILE_TEXT/);
  assert.equal(spy.hits.length,4,'base read, vault and profile realpath, profile read');
});

test('an active pure turn suppresses the renderer before any filesystem access',async t=>{
  const {root,base,self}=await personaFixture(),spy=spyFileAccess(t),{pure}=gateFor(ACTIVE);
  const render=createPersonaRenderer({directory:root,basePersona:base,selfProfile:self,pure});
  assert.equal(pure.check({session:{id:'session-a'}}).suppressed,true);
  assert.equal(render({session:{id:'session-a'}}),'');
  assert.equal(spy.hits.length,0,'pure mode must not read the persona files at all');
});

test('a loaded but not ready pure service is unknown, not normal',async t=>{
  const {root,base,self}=await personaFixture(),spy=spyFileAccess(t),{pure,ref}=gateFor(STARTING);
  const render=createPersonaRenderer({directory:root,basePersona:base,selfProfile:self,pure});
  const state=pure.check({session:{id:'session-a'}});
  assert.deepEqual([state.installed,state.ready,state.active,state.suppressed],[true,false,null,true]);
  assert.equal(render({session:{id:'session-a'}}),'');
  assert.equal(spy.hits.length,0);
  ref.value=INACTIVE;
  assert.match(render({session:{id:'session-a'}}),/BASE_PERSONA_TEXT/);
  assert.ok(spy.hits.length>0,'reads resume once the service reports a state');
});

test('the next turn reads again after pure mode is switched off',async t=>{
  const {root,base,self}=await personaFixture(),spy=spyFileAccess(t),{pure,ref}=gateFor(ACTIVE);
  const render=createPersonaRenderer({directory:root,basePersona:base,selfProfile:self,pure});
  render({session:{id:'session-a'}});assert.equal(spy.hits.length,0);
  ref.value=INACTIVE;
  assert.match(render({session:{id:'session-a'}}),/SELF_PROFILE_TEXT/);
  assert.equal(spy.hits.length,4);
});

test('selected persona keeps one persona source and strips both sections when suppressed',async()=>{
  let calls=0;const render=()=>{calls++;return 'RENDERED_PERSONA';};
  const existing={sections:[{name:'deployment:dafeiyu-persona',text:'GLOBAL_PERSONA'}]};
  assert.equal(addSelectedPersona(existing,render),existing);assert.equal(calls,0);
  const plain={sections:[{name:'engineering:AGENTS',text:'KEEP'}]},{pure}=gateFor(INACTIVE);
  const added=addSelectedPersona(plain,render,{session:{id:'session-a'}},pure);
  assert.deepEqual(added.sections.map(s=>s.name),['memory:selected-persona','engineering:AGENTS']);assert.equal(calls,1);
  const blocked=addSelectedPersona(existing,render,{session:{id:'session-a'}},gateFor(ACTIVE).pure);
  assert.deepEqual(blocked.sections,[]);assert.equal(calls,1,'no renderer call while suppressed');
});

test('the personal host gates every renderer, including an external connections.renderPersona',async t=>{
  const directory=await fsp.mkdtemp(path.resolve('.local/pure-host-')),handlers=new Map(),effects=[],memory=memoryStore();
  let calls=0,installed=true,state=STARTING;
  const ctx={llm:{},logger:{},agents:{get:()=>undefined},tools:{register(){return()=>{};}},
    memoryConnections:{acquire:async()=>memory,renderPersona(){calls++;return 'EXTERNAL_PERSONA';}},
    on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},effect(fn){effects.push(fn());},
    provide(){},get(name){return name==='pureMode'&&installed?{check:()=>state}:undefined;}};
  await apply(ctx,{directory,sessionIds:['session-personal'],ownerSubject:'owner:test',memory:{captureProvider:'fixture',captureModel:'fixture'}});
  const assemble=handlers.get('system-prompt/assemble');
  const withPersona={sections:[{name:'deployment:dafeiyu-persona',text:'GLOBAL_PERSONA'},{name:'engineering:AGENTS',text:'KEEP'}]};
  const plain={sections:[{name:'engineering:AGENTS',text:'KEEP'}]};
  try{
    state=ACTIVE;
    assert.deepEqual((await assemble(withPersona,{agent:{id:'session-personal'}},async()=>withPersona)).sections.map(s=>s.name),['engineering:AGENTS']);
    assert.equal(calls,0,'suppressed before the external renderer callback');
    state=STARTING;
    assert.deepEqual((await assemble(withPersona,{agent:{id:'session-personal'}},async()=>withPersona)).sections.map(s=>s.name),['engineering:AGENTS']);
    assert.equal(calls,0);
    state=INACTIVE;
    const added=await assemble(plain,{agent:{id:'session-personal'}},async()=>plain);
    assert.deepEqual(added.sections.map(s=>s.name),['memory:selected-persona','engineering:AGENTS']);
    assert.equal(added.sections[0].text,'EXTERNAL_PERSONA');assert.equal(calls,1);
    const untouched=await assemble(withPersona,{agent:{id:'session-other'}},async()=>withPersona);
    assert.equal(untouched,withPersona);assert.equal(calls,1,'unselected sessions are not injected');
    installed=false;
    const noPlugin=await assemble(plain,{agent:{id:'session-personal'}},async()=>plain);
    assert.equal(noPlugin.sections[0].name,'memory:selected-persona');assert.equal(calls,2,'missing plugin keeps normal behaviour');
  }finally{for(const dispose of effects.reverse())await dispose?.();}
});

test('a scope-only prompt context resolves the real host agent before deciding',async t=>{
  const directory=await fsp.mkdtemp(path.resolve('.local/pure-scope-')),handlers=new Map(),effects=[],memory=memoryStore();
  const seen=[],hostAgent={session:{id:'session-personal'}};
  const ctx={llm:{},logger:{},agents:{get:id=>id==='session-personal'?hostAgent:undefined},tools:{register(){return()=>{};}},
    memoryConnections:{acquire:async()=>memory},on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},effect(fn){effects.push(fn());},provide(){},
    get:name=>name==='pureMode'?{check:agent=>{seen.push(agent);return {ready:true,active:true};}}:undefined};
  await apply(ctx,{directory,sessionIds:['session-personal'],ownerSubject:'owner:test',memory:{captureProvider:'fixture',captureModel:'fixture'}});
  const assemble=handlers.get('system-prompt/assemble'),assembly={sections:[{name:'deployment:dafeiyu-persona',text:'GLOBAL_PERSONA'}]};
  try{
    const out=await assemble(assembly,{scope:{id:'session-personal'}},async()=>assembly);
    assert.equal(seen.length,1);assert.equal(seen[0],hostAgent,'the registry agent, not a fabricated scope object');
    assert.deepEqual(out.sections,[],'a pure turn suppresses even when the hook only passed a scope id');
  }finally{for(const dispose of effects.reverse())await dispose?.();}
});

test('an installed service with no resolvable host agent suppresses instead of reading',async t=>{
  const directory=await fsp.mkdtemp(path.resolve('.local/pure-unresolved-')),handlers=new Map(),effects=[],memory=memoryStore(),warnings=[];
  let calls=0;
  const ctx={llm:{},logger:{warn:message=>warnings.push(message)},agents:{get:()=>undefined},tools:{register(){return()=>{};}},
    memoryConnections:{acquire:async()=>memory,renderPersona(){calls++;return 'EXTERNAL_PERSONA';}},
    on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},effect(fn){effects.push(fn());},provide(){},
    get:name=>name==='pureMode'?{check:()=>({ready:true,active:false})}:undefined};
  await apply(ctx,{directory,sessionIds:['session-personal'],ownerSubject:'owner:test',memory:{captureProvider:'fixture',captureModel:'fixture'}});
  const assemble=handlers.get('system-prompt/assemble'),assembly={sections:[{name:'engineering:AGENTS',text:'KEEP'}]};
  try{
    const out=await assemble(assembly,{scope:{id:'session-personal'}},async()=>assembly);
    assert.deepEqual(out.sections.map(s=>s.name),['engineering:AGENTS'],'unknown identity strips persona and keeps other sections');
    assert.equal(calls,0);assert.ok(warnings.some(text=>/没有可信的宿主 agent/.test(text)));
  }finally{for(const dispose of effects.reverse())await dispose?.();}
});

test('a throwing pure-mode service or check fails closed, never as "not installed"',async()=>{
  const assembly={sections:[{name:'deployment:dafeiyu-persona',text:'GLOBAL_PERSONA'}]};
  const unreadable=createPureGate({getService:()=>{throw Error('provider exploded');}}).check({session:{id:'session-a'}});
  assert.deepEqual([unreadable.installed,unreadable.ready,unreadable.suppressed,unreadable.reason],[true,false,true,'service-unreadable']);
  assert.match(unreadable.error.message,/provider exploded/);
  const failed=createPureGate({getService:()=>({check:()=>{throw Error('controller detached');}})}).check({session:{id:'session-a'}});
  assert.deepEqual([failed.installed,failed.suppressed,failed.reason],[true,true,'service-failed']);
  assert.match(failed.error.message,/controller detached/);
  assert.equal(createPureGate({getService:()=>undefined}).check(undefined).suppressed,false,'only a missing provider is normal');
});

test('a real Cordis provider appears, is unknown while not ready, and disappears on unload',async()=>{
  const {Context}=await import('@deepseek-ai/cordis'),ctx=new Context(),gate=createPureGate({getService:()=>ctx.get('pureMode',false)});
  assert.equal(gate.check({session:{id:'session-a'}}).installed,false);
  const fiber=ctx.plugin({name:'fake-pure-mode',apply(c){c.provide('pureMode',{check:()=>({ready:false,active:null})});}});
  await fiber.await();
  const starting=gate.check({session:{id:'session-a'}});
  assert.deepEqual([starting.installed,starting.ready,starting.suppressed],[true,false,true]);
  await fiber.dispose();
  const removed=gate.check({session:{id:'session-a'}});
  assert.deepEqual([removed.installed,removed.suppressed],[false,false]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createPersonaRenderer,addSelectedPersona} from '../lib/persona-source.js';

async function fixture(t){
  const root=await fsp.mkdtemp(path.join(os.tmpdir(),'persona-opt-in-'));
  const vault=path.join(root,'vault'),basePersona=path.join(root,'persona.md'),selfProfile=path.join(vault,'self.md');
  await fsp.mkdir(vault);
  await fsp.writeFile(basePersona,'FIXED_PERSONA {{literal}}');
  await fsp.writeFile(selfProfile,'---\ntitle: self\n---\n<!-- dafeiyu-record kind=thoughts -->\nPRIVATE_SELF');
  t.after(()=>fsp.rm(root,{recursive:true,force:true}));
  const hits=[],read=fs.readFileSync,realpath=fs.realpathSync;
  fs.readFileSync=(file,...args)=>{hits.push(String(file));return read(file,...args);};
  fs.realpathSync=(file,...args)=>{hits.push(String(file));return realpath(file,...args);};
  t.after(()=>{fs.readFileSync=read;fs.realpathSync=realpath;});
  return {directory:root,basePersona,selfProfile,hits};
}

test('positive access keeps the base persona and gates every self-profile filesystem operation',async t=>{
  const f=await fixture(t),host={id:'session-owner'};
  let enabled=false;
  const seen=[],access={check(agent){seen.push(agent);return {allowed:agent===host&&enabled};}};
  const render=createPersonaRenderer({...f,access});
  assert.equal(render(host),'FIXED_PERSONA {{literal}}');
  assert.deepEqual(f.hits,[f.basePersona]);
  f.hits.length=0;enabled=true;
  assert.match(render(host),/FIXED_PERSONA[\s\S]*PRIVATE_SELF/);
  assert.equal(f.hits.length,4,'base, canonical vault and profile, then self body');
  assert.ok(seen.every(agent=>agent===host));
  f.hits.length=0;enabled=false;
  assert.equal(render(host),'FIXED_PERSONA {{literal}}');
  assert.deepEqual(f.hits,[f.basePersona],'revocation stops new reads and no cached self is replayed');
});

test('unresolved agents, missing authorization and service failures never read the self-profile',async t=>{
  const f=await fixture(t),host={id:'session-owner'};
  const access={check:agent=>({allowed:agent===host})};
  for(const [gate,agent] of [[access,undefined],[access,{id:host.id}],[null,host],[{check:()=>({allowed:1})},host],[{check(){throw Error('not ready');}},host]]){
    f.hits.length=0;
    assert.equal(createPersonaRenderer({...f,access:gate})(agent),'FIXED_PERSONA {{literal}}');
    assert.deepEqual(f.hits,[f.basePersona]);
  }
});

test('positive access supersedes pure mode while old pure-only callers retain their contract',async t=>{
  const f=await fixture(t),host={id:'session-owner'},pure={check:()=>({suppressed:true})};
  assert.equal(createPersonaRenderer({...f,pure})(host),'');
  assert.deepEqual(f.hits,[]);
  assert.equal(createPersonaRenderer({...f,pure,access:{check:()=>({allowed:false})}})(host),'FIXED_PERSONA {{literal}}');
  assert.deepEqual(f.hits,[f.basePersona]);
  assert.match(createPersonaRenderer(f)(host),/PRIVATE_SELF/,'no access option preserves legacy reads');
});

test('selected persona remains a single literal section and does not reread an existing global source',async t=>{
  const f=await fixture(t),host={id:'session-owner'};
  const render=createPersonaRenderer({...f,access:{check:()=>({allowed:false})}});
  const existing={sections:[{name:'deployment:dafeiyu-persona',text:'GLOBAL_FIXED'}]};
  assert.equal(addSelectedPersona(existing,render,host),existing);
  assert.deepEqual(f.hits,[]);
  const added=addSelectedPersona({sections:[{name:'deployment:persona-prefix',text:'PREFIX'}]},render,host);
  assert.deepEqual(added.sections.map(s=>s.name),['deployment:persona-prefix','memory:selected-persona']);
  assert.equal(added.sections[1].text,'FIXED_PERSONA {{literal}}');
  assert.equal(added.sections[1].interpolate,false);
});

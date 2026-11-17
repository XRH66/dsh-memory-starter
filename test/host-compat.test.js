import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostCompatibility} from '../lib/host-compat.js';

function actor(id,header={}){
  const session={id,header:{id,...header}};
  return {id,session};
}

test('native isOwnedBy remains the authoritative runtime ownership API',()=>{
  const root=actor('session-root'),child=actor('session-child');
  const agents={get:id=>id===root.id?root:id===child.id?child:undefined,list:()=>[root,child],
    isOwnedBy:(id,owner)=>id===child.id&&owner===root,currentInitiator(){throw Error('unexpected fallback');}};
  const compatibility=createHostCompatibility({agents,logger:{warn(){throw Error('unexpected warning');}}});
  assert.equal(compatibility.hasNativeOwnership,true);
  assert.deepEqual(compatibility.ownersOf(child,[root,child]),[root]);
  assert.deepEqual(compatibility.ownersOf(root,[root,child]),[]);
  assert.equal(compatibility.isRoot(root,[root,child]),true);
  assert.equal(compatibility.isRoot(child,[root,child]),false);
  assert.equal(compatibility.observeAgentCreated({agent:child}),false);
});

test('agent creation captures and validates currentInitiator when isOwnedBy is absent',()=>{
  const root=actor('session-root'),child=actor('session-child',{origin:'subagent',parentSession:'session-root'});
  const agents={get:id=>id===root.id?root:id===child.id?child:undefined,list:()=>[root,child],
    currentInitiator:()=>root};
  const compatibility=createHostCompatibility({agents,logger:{warn(){}}});
  assert.equal(compatibility.hasNativeOwnership,false);
  assert.equal(compatibility.observeAgentCreated({agent:child,source:'startup'}),true);
  assert.deepEqual(compatibility.ownersOf(child,[root,child]),[root]);
  assert.deepEqual(compatibility.ownersOf(root,[root,child]),[]);
  assert.equal(compatibility.isRoot(root,[root,child]),true);
  assert.equal(compatibility.isRoot(child,[root,child]),false);
});

test('durable fork lineage without subagent origin remains a root',()=>{
  const root=actor('session-root'),fork=actor('session-fork',{parentSession:'session-root',isSeeded:true});
  const agents={get:id=>id===root.id?root:id===fork.id?fork:undefined,list:()=>[root,fork],
    currentInitiator:()=>undefined};
  const compatibility=createHostCompatibility({agents,logger:{warn(){throw Error('unexpected warning');}}});
  assert.deepEqual(compatibility.ownersOf(fork,[root,fork]),[]);
  assert.equal(compatibility.isRoot(fork,[root,fork]),true);
});

test('missing ownership APIs fail closed to an independent session and warn once',()=>{
  const root=actor('session-root'),child=actor('session-child',{origin:'subagent',parentSession:'session-root'});
  const warnings=[];
  const agents={get:id=>id===root.id?root:id===child.id?child:undefined,list:()=>[root,child]};
  const compatibility=createHostCompatibility({agents,logger:{warn:message=>warnings.push(message)}});
  assert.equal(compatibility.observeAgentCreated({agent:child}),false);
  assert.deepEqual(compatibility.ownersOf(child,[root,child]),[]);
  assert.deepEqual(compatibility.ownersOf(child,[root,child]),[]);
  assert.deepEqual(compatibility.ownersOf(root,[root,child]),[]);
  assert.equal(compatibility.isRoot(root,[root,child]),true);
  assert.equal(compatibility.isRoot(child,[root,child]),false);
  assert.equal(warnings.length,1);
  assert.match(warnings[0],/独立会话/);
});

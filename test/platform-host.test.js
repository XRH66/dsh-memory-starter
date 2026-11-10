import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {apply} from '../lib/platform-host.js';
import {apply as applyBundle,Config as BundleConfig} from '../lib/bundle-entry.js';
import {createPersonaRenderer} from '../lib/persona-source.js';
import {deploymentStaticFingerprint} from '../lib/deployment-config.js';
import {scratchDirectory} from './helpers.js';

test('explicit persona reads the selected vault and refuses outside profiles',async()=>{
 const root=await scratchDirectory('persona-source-'),vault=path.join(root,'vault'),base=path.join(root,'persona.md'),self=path.join(vault,'self.md'),outside=path.join(root,'outside.md');await fs.mkdir(vault);await fs.writeFile(base,'基础人设');await fs.writeFile(self,'---\ntitle: test\n---\n<!-- dafeiyu-record kind=thoughts -->\n成长经历');await fs.writeFile(outside,'<!-- dafeiyu-record kind=thoughts -->\n外部档案');
 const render=createPersonaRenderer({directory:root,basePersona:base,selfProfile:self});assert.match(render(),/基础人设[\s\S]*成长经历/);assert.throws(()=>createPersonaRenderer({directory:root,selfProfile:outside})(),/inside the selected personal vault/);
 await fs.writeFile(self,'无标记档案');assert.throws(()=>render(),/owned thoughts record/);
});

test('bundle rejects removed and unknown modes and only serves setup until configured',async()=>{
 const registered=new Map(),ctx={tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);}},agents:{},llm:{},logger:{},on(){}};
 assert.throws(()=>applyBundle(ctx,{mode:'typo'}),/Unknown memory runtime mode/);
 const parsed=BundleConfig({mode:'portable',personal:{directory:'fixture'}});assert.equal(parsed.mode,'portable');assert.equal(parsed.personal.directory,'fixture');
 for(const mode of ['legacy','unified'])assert.throws(()=>applyBundle(ctx,{mode}),new RegExp('已不支持 '+mode+' 模式'));
 assert.equal(applyBundle(ctx,{}),undefined);assert.equal(registered.size,0);
});

test('personal host exposes one core service with explicitly selected DSH sessions',async()=>{
 const directory=await scratchDirectory('personal-host-'),handlers=new Map(),effects=[],services=new Map(),registered=new Map();
 const ctx={llm:{},logger:{},agents:{get:()=>undefined},tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);}},on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},effect(fn){const dispose=fn();effects.push(dispose);},provide(name,value){services.set(name,value);}};
 await apply(ctx,{directory,sessionIds:['session-personal'],ownerSubject:'owner:test',memory:{captureProvider:'fixture',captureModel:'fixture'}});
 const service=services.get('memoryPersonal');assert.ok(service);assert.equal(service.ownerSubject,'owner:test');assert.equal(service.acceptsDshSession('session-personal'),true);assert.equal(service.acceptsDshSession('session-foreign'),false);
 assert.equal(await handlers.get('agent/request')({agent:{id:'session-other'}},async()=>42),42);
 assert.deepEqual([...registered.keys()].sort(),['dafeiyu_records','soften_memory'].sort());
 for(const tool of registered.values())await assert.rejects(tool.execute({}, {agent:{session:{id:'session-other'}}}),/limited to selected/);
 const listing=await registered.get('dafeiyu_records').execute({action:'list',kind:'thoughts'},{agent:{session:{id:'session-personal'}}});assert.equal(listing.ok,true);
 const rejected={sessionId:'session-other'};handlers.get('basic-memory/retry-session')(rejected);assert.equal(rejected.accepted,undefined);
 await service.personal.recentStore.record({sessionId:'session-personal',turn:1,user:{id:'one',text:'虚构 DSH 内容',time:'2026-10-31T12:00:00Z'}});
 assert.match((await service.personal.recentStore.page({sessionId:'session-other',turn:2,maxChars:1000})).text,/虚构 DSH 内容/);
 for(const dispose of effects.reverse())await dispose?.();assert.equal(registered.size,0);
});
test('personal host refuses implicit directories and transport session IDs',async()=>{
 const ctx={};
 await assert.rejects(apply(ctx,{directory:'relative',sessionIds:[]}),/explicit/);
 await assert.rejects(apply(ctx,{directory:path.resolve('.local'),sessionIds:['not-a-session']}),/explicit/);
});
test('live selection changes wait for each already-running turn to finish',async()=>{
 const directory=await scratchDirectory('personal-live-'),handlers=new Map(),effects=[],services=new Map(),agents=new Map([['session-one',{status:'running'}],['session-two',{status:'running'}]]),cfg={ownerDirectory:directory,dshSessionIds:['session-one'],extra:'stable'};let applied='';
 const ctx={llm:{},logger:{},agents:{get:id=>agents.get(id)},tools:{register(){return()=>{};}},on(name,fn){handlers.set(name,fn);},effect(fn){effects.push(fn());},provide(name,value){services.set(name,value);}};
 await apply(ctx,{directory,sessionIds:cfg.dshSessionIds,ownerSubject:'owner:test',memory:{captureProvider:'fixture',captureModel:'fixture'},configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment:{async markApplied(value){applied=value;}}});
 const service=services.get('memoryPersonal');assert.equal(service.acceptsDshSession('session-one'),true);assert.equal(service.acceptsDshSession('session-two'),false);
 await service.applySessionSelection({...cfg,dshSessionIds:['session-two']},'rev-new');assert.equal(applied,'rev-new');
 assert.equal(service.acceptsDshSession('session-one'),true);assert.equal(service.acceptsDshSession('session-two'),false);
 handlers.get('session/event')({id:'session-two'},{type:'turn/start',data:{turn:1}});assert.equal(service.acceptsDshSession('session-two'),false);
 handlers.get('session/event')({id:'session-one'},{type:'turn/end',data:{}});handlers.get('session/event')({id:'session-two'},{type:'turn/end',data:{}});
 assert.equal(service.acceptsDshSession('session-one'),false);assert.equal(service.acceptsDshSession('session-two'),true);
 await service.applySessionSelection({...cfg,extra:'changed',dshSessionIds:[]},'rev-invalid');assert.equal(applied,'rev-new');assert.equal(service.acceptsDshSession('session-two'),true);
 await service.applySessionSelection({...cfg,dshSessionIds:[]},'rev-next');assert.equal(service.acceptsDshSession('session-two'),true);handlers.get('agent/status')({agent:{id:'session-two'},status:'idle'});assert.equal(service.acceptsDshSession('session-two'),false);
 for(const dispose of effects.reverse())await dispose?.();
});

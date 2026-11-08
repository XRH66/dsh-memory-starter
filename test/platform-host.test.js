import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import path from 'node:path';
import {apply} from '../lib/platform-host.js';import {memoryStore} from './fake-memory.js';
import {apply as applyBundle,Config as BundleConfig} from '../lib/bundle-entry.js';
import {createPersonaRenderer} from '../lib/persona-source.js';
import {deploymentStaticFingerprint} from '../lib/deployment-config.js';
import {Readable} from 'node:stream';

test('explicit persona reads the selected vault and refuses outside profiles',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/persona-source-')),vault=path.join(root,'vault'),base=path.join(root,'persona.md'),self=path.join(vault,'self.md'),outside=path.join(root,'outside.md');await fs.mkdir(vault);await fs.writeFile(base,'基础人设');await fs.writeFile(self,'---\ntitle: test\n---\n<!-- dafeiyu-record kind=thoughts -->\n成长经历');await fs.writeFile(outside,'<!-- dafeiyu-record kind=thoughts -->\n外部档案');
 const render=createPersonaRenderer({directory:root,basePersona:base,selfProfile:self});assert.match(render(),/基础人设[\s\S]*成长经历/);assert.throws(()=>createPersonaRenderer({directory:root,selfProfile:outside})(),/inside the selected personal vault/);
 await fs.writeFile(self,'无标记档案');assert.throws(()=>render(),/owned thoughts record/);
});

test('bundle defaults to the existing bridge and rejects unknown modes',async()=>{
 const registered=new Map(),ctx={tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);}},agents:{},llm:{},logger:{},on(){}};
 assert.throws(()=>applyBundle(ctx,{mode:'typo'}),/Unknown memory runtime mode/);
 const parsed=BundleConfig({mode:'portable',personal:{directory:'fixture'}});assert.equal(parsed.mode,'portable');assert.equal(parsed.personal.directory,'fixture');
 const bridge=applyBundle(ctx,{});assert.equal(typeof bridge.onRequest,'function');assert.equal(registered.size,3);await bridge.dispose();
});

test('personal host exposes one core service with explicitly selected DSH sessions',async()=>{
 const directory=await fs.mkdtemp(path.resolve('.local/personal-host-')),handlers=new Map(),effects=[],services=new Map(),registered=new Map(),memory=memoryStore();let opens=0;
 const ctx={llm:{},logger:{},agents:{get:()=>undefined},tools:{register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);}},memoryConnections:{acquire:async()=>{opens++;return memory;}},on(name,fn){handlers.set(name,fn);return()=>handlers.delete(name);},effect(fn){const dispose=fn();effects.push(dispose);},provide(name,value){services.set(name,value);}};
 await apply(ctx,{directory,sessionIds:['session-personal'],ownerSubject:'owner:test',memory:{captureProvider:'fixture',captureModel:'fixture'}});
 const service=services.get('memoryPersonal');assert.ok(service);assert.equal(service.ownerSubject,'owner:test');assert.equal(opens,1);assert.equal(service.acceptsDshSession('session-personal'),true);assert.equal(service.acceptsDshSession('qq-session'),false);
 assert.equal(await handlers.get('agent/request')({agent:{id:'session-other'}},async()=>42),42);
 assert.deepEqual([...registered.keys()].sort(),['dafeiyu_records','recent_conversation','soften_memory'].sort());
 for(const tool of registered.values())await assert.rejects(tool.execute({}, {agent:{session:{id:'session-other'}}}),/limited to selected/);
 const listing=await registered.get('dafeiyu_records').execute({action:'list',kind:'thoughts'},{agent:{session:{id:'session-personal'}}});assert.equal(listing.ok,true);
 const rejected={sessionId:'session-other'};handlers.get('basic-memory/retry-session')(rejected);assert.equal(rejected.accepted,undefined);
 await service.personal.recentStore.record({sessionId:'session-personal',turn:1,user:{id:'one',text:'虚构 DSH 内容',time:'2026-10-31T12:00:00Z'}});
 assert.match((await service.personal.recentStore.page({sessionId:'session-other',turn:2,maxChars:1000})).text,/虚构 DSH 内容/);
 for(const dispose of effects.reverse())await dispose?.();assert.equal(registered.size,0);
});
test('personal host refuses implicit directories and transport session IDs',async()=>{
 const ctx={memoryConnections:{acquire:async()=>{throw Error('must not connect');}}};
 await assert.rejects(apply(ctx,{directory:'relative',sessionIds:[]}),/explicit/);
 await assert.rejects(apply(ctx,{directory:path.resolve('.local'),sessionIds:['qq-chat']}),/explicit/);
});
test('live selection changes wait for each already-running turn to finish',async()=>{
 const directory=await fs.mkdtemp(path.resolve('.local/personal-live-')),handlers=new Map(),effects=[],services=new Map(),memory=memoryStore(),agents=new Map([['session-one',{status:'running'}],['session-two',{status:'running'}]]),cfg={ownerDirectory:directory,dshSessionIds:['session-one'],extra:'stable'};let applied='';
 const ctx={llm:{},logger:{},agents:{get:id=>agents.get(id)},tools:{register(){return()=>{};}},memoryConnections:{acquire:async()=>memory},on(name,fn){handlers.set(name,fn);},effect(fn){effects.push(fn());},provide(name,value){services.set(name,value);}};
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
test('QQ binding edit and attachment exclude each other and the new revision stays usable',async()=>{
 const root=await fs.mkdtemp(path.resolve('.local/personal-qq-settings-')),directory=path.join(root,'memory'),bridge=path.join(root,'bridge'),file=path.join(root,'config.json'),services=new Map(),effects=[],memory=memoryStore(),ownerId='710000001',cfg={ownerDirectory:directory,socialRoot:path.join(root,'social'),ownerId,botId:'710000002',ownerSubject:`qq:${ownerId}`,qqBridgeRoot:bridge,dshSessionIds:['session-one'],dshHome:path.join(root,'dsh')};
 await fs.mkdir(path.join(bridge,'plugins/qq-agent-presets'),{recursive:true});await fs.writeFile(path.join(bridge,'plugins/qq-agent-presets/qq-self-key.mjs'),'export {}');await fs.writeFile(file,JSON.stringify(cfg));let handler,releaseWrite,startedWrite,revision;const gate=new Promise(r=>releaseWrite=r),started=new Promise(r=>startedWrite=r);
 const ctx={llm:{},logger:{},agents:{get:()=>undefined},tools:{register(){return()=>{};}},memoryConnections:{acquire:async()=>memory},on(){},effect(fn){effects.push(fn());},provide(name,value){services.set(name,value);},inject(deps,callback){callback({webServer:{register(value){handler=value.handler;return()=>{};}},effect(fn){effects.push(fn());}});}};
 await apply(ctx,{directory,sessionIds:cfg.dshSessionIds,ownerSubject:cfg.ownerSubject,memory:{captureProvider:'fixture',captureModel:'fixture'},configurationFile:file,configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment:{async markApplied(value){revision=value;startedWrite();await gate;}}});
 const service=services.get('memoryPersonal'),send=async(input)=>{const req=Readable.from([Buffer.from(JSON.stringify(input))]);req.method='POST';req.url='/api/basic-memory-settings/qq';req.socket={remoteAddress:'127.0.0.1'};req.headers={host:'127.0.0.1:15680','content-type':'application/json','x-basic-memory-settings':'1'};const res={setHeader(){},end(text){this.body=JSON.parse(text);}};await handler(req,res);return res;};
 const {deploymentFingerprint}=await import('../lib/deployment-config.js'),input={ownerId,botId:'710000003',qqBridgeRoot:bridge,revision:deploymentFingerprint(cfg)};
 try{const releaseAttachment=service.reserveQQAttachment();const blocked=await send(input);assert.equal(blocked.statusCode,400);assert.match(blocked.body.error,/停用/);releaseAttachment();
  const saving=send(input);await started;assert.throws(()=>service.reserveQQAttachment(),/正在修改/);releaseWrite();const result=await saving;assert.equal(result.statusCode,200);assert.equal(service.configurationFingerprint,revision);
  const release=service.reserveQQAttachment();release();await service.applySessionSelection({...cfg,botId:'710000003',dshSessionIds:[]},'session-revision');assert.equal(service.configurationFingerprint,'session-revision');
 }finally{releaseWrite();for(const dispose of effects.reverse())await dispose?.();}
});

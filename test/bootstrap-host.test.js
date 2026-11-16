import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readBootstrap,createBootstrap,stageBootstrapActivation,readScheduledBootstrap,recordBootstrapActivation,updateBootstrapSessions,registerLoadedBootstrapRoute} from '../lib/bootstrap-host.js';
import {apply as applyBundle} from '../lib/bundle-entry.js';
import {deploymentFingerprint} from '../lib/deployment-config.js';
import {scratchDirectory} from './helpers.js';

function loadedRouteFixture(){
  const active=new Map();let next=1;
  const cleanups=[];
  const child={
    get(){return undefined;},
    effect(factory){const cleanup=factory();cleanups.push(cleanup);return cleanup;},
    webServer:{register(route){const id=next++;active.set(id,route);return()=>active.delete(id);}},
  };
  registerLoadedBootstrapRoute({inject(names,callback){assert.deepEqual(names,['webServer']);callback(child);}});
  return {
    active,
    async request({method='GET',url='/api/basic-memory-bootstrap',headers={}}={}){
      const handler=[...active.values()][0]?.handler;assert.equal(typeof handler,'function');
      return new Promise(resolve=>{
        const req={method,url,socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:15680',...headers}};
        const res={statusCode:200,headers:{},setHeader(name,value){this.headers[name]=value;},end(value){resolve({status:this.statusCode,headers:this.headers,body:JSON.parse(value)});}};
        handler(req,res);
      });
    },
    dispose(){for(const cleanup of cleanups.splice(0).reverse())cleanup?.();},
  };
}

test('bootstrap uses the current profile and refuses existing or overlapping memory',async()=>{
  const root=await scratchDirectory('bootstrap-test-'),home=path.join(root,'home'),dir=path.join(home,'profiles','fixture'),old=path.join(root,'daily','vault');
  await fs.mkdir(dir,{recursive:true});await fs.mkdir(old,{recursive:true});await fs.writeFile(path.join(old,'keep.md'),'unchanged');
  const profile={name:'fixture',dir,home},raw={vaultPath:old},input={directory:path.join(root,'daily')};
  const initial=await readBootstrap(profile,raw);assert.equal(initial.configured,false);assert.equal(initial.profile,'fixture');
  await assert.rejects(createBootstrap(profile,raw,{directory:''}),/请填写独立记忆目录/);await assert.rejects(fs.access(path.join(dir,'basic-memory-bridge','configuration.json')),{code:'ENOENT'});
  await assert.rejects(createBootstrap(profile,raw,input),/必须与现有/);assert.equal(await fs.readFile(path.join(old,'keep.md'),'utf8'),'unchanged');
  const configFile=path.join(dir,'basic-memory-bridge','configuration.json');await fs.writeFile(configFile,'{"untouched":true}');await assert.rejects(createBootstrap(profile,raw,{...input,directory:path.join(root,'new')}),/已存在/);assert.equal(await fs.readFile(configFile,'utf8'),'{"untouched":true}');
  await assert.rejects(readBootstrap({...profile,name:'other'},raw),/profile 路径/);
});
test('first setup no longer requires an organizer model and old config fields remain readable',async()=>{
  const root=await scratchDirectory('bootstrap-no-organizer-'),home=path.join(root,'home'),dir=path.join(home,'profiles','fixture');
  await fs.mkdir(dir,{recursive:true});
  const profile={name:'fixture',dir,home},directory=path.join(root,'personal'),old=path.join(root,'old-vault');
  await fs.mkdir(old,{recursive:true});
  const created=await createBootstrap(profile,{vaultPath:old},{directory});
  assert.equal(created.configured,true);
  const file=path.join(dir,'basic-memory-bridge','configuration.json'),cfg=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(Object.hasOwn(cfg,'memory'),false);
  await fs.writeFile(file,JSON.stringify({...cfg,memory:{autoCapture:true,organizerReasoningEffort:'high',
    captureProvider:'retired-provider',captureModel:'retired-model'}}));
  const loaded=await readBootstrap(profile);
  assert.equal(loaded.configured,true);assert.equal(loaded.personalDirectory,directory);
  await assert.rejects(fs.access(path.join(directory,'management','pipeline')),{code:'ENOENT'});
});
test('bootstrap reports loaded only for the current process ready runtime receipt',async()=>{
  const root=await scratchDirectory('bootstrap-loaded-'),home=path.join(root,'home'),dir=path.join(home,'profiles','fixture');
  await fs.mkdir(dir,{recursive:true});
  const profile={name:'fixture',dir,home},directory=path.join(root,'personal');
  await createBootstrap(profile,{}, {directory});
  const configFile=path.join(dir,'basic-memory-bridge','configuration.json'),cfg=JSON.parse(await fs.readFile(configFile,'utf8'));
  assert.equal((await readBootstrap(profile)).frameworkLoaded,false);
  const receipt=configFile+'.runtime.json';
  await fs.writeFile(receipt,JSON.stringify({pid:process.pid,state:'starting',fingerprint:deploymentFingerprint(cfg)}));
  assert.equal((await readBootstrap(profile)).frameworkLoaded,false);
  await fs.writeFile(receipt,JSON.stringify({pid:process.pid,state:'ready',fingerprint:'stale'}));
  assert.equal((await readBootstrap(profile)).frameworkLoaded,false);
  await fs.writeFile(receipt,JSON.stringify({pid:process.pid+1,state:'ready',fingerprint:deploymentFingerprint(cfg)}));
  assert.equal((await readBootstrap(profile)).frameworkLoaded,false);
  await fs.writeFile(receipt,JSON.stringify({pid:process.pid,state:'ready',fingerprint:deploymentFingerprint(cfg)}));
  assert.equal((await readBootstrap(profile)).frameworkLoaded,true);
});
test('loaded bootstrap route reports status without reading configuration and rejects changes',async t=>{
  const fixture=loadedRouteFixture();
  t.after(()=>fixture.dispose());
  const loaded=await fixture.request();
  assert.equal(loaded.status,200);assert.deepEqual(loaded.body,{ok:true,configured:true,frameworkLoaded:true});
  const post=await fixture.request({method:'POST',headers:{'content-type':'application/json','x-basic-memory-settings':'1'}});
  assert.equal(post.status,409);assert.deepEqual(post.body,{ok:false,error:'记忆框架已在运行，请在设置页「记忆框架」里调整。'});
  const child=await fixture.request({url:'/api/basic-memory-bootstrap/activation'});
  assert.equal(child.status,409);assert.deepEqual(child.body,post.body);
  const denied=await fixture.request({headers:{'sec-fetch-site':'cross-site'}});
  assert.equal(denied.status,403);assert.equal(denied.body.error,'访问被拒绝');
});
test('a failed scheduled portable start removes the loaded route and leaves full first-run setup',async t=>{
  const root=await scratchDirectory('bootstrap-start-failure-'),home=path.join(root,'home'),dir=path.join(home,'profiles','fixture'),old=path.join(root,'old-vault'),memoryDirectory=path.join(root,'memory');
  await fs.mkdir(dir,{recursive:true});await fs.mkdir(old,{recursive:true});await fs.mkdir(path.join(home,'storages'),{recursive:true});
  const profile={name:'fixture',dir,home};
  await createBootstrap(profile,{vaultPath:old},{directory:memoryDirectory});
  const configFile=path.join(dir,'basic-memory-bridge','configuration.json'),cfg={...JSON.parse(await fs.readFile(configFile,'utf8')),dshSessionIds:['session-one'],memory:{rawRecall:false,autoCapture:false,autoRecall:false,recentContext:false}};
  await fs.writeFile(configFile,JSON.stringify(cfg));
  await fs.writeFile(path.join(home,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{},tables:{workspaces:{w:{title:'测试',sessionIds:['session-one']}}}}));
  const activationFile=path.join(dir,'basic-memory-bridge','activation.json');
  await fs.writeFile(activationFile,JSON.stringify({version:1,state:'scheduled',profile:'fixture',configFile,fingerprint:deploymentFingerprint(cfg),scheduledPid:999999999}));

  let next=1;const active=new Map(),rootCleanups=[];
  const webServer={register(route){const id=next++;active.set(id,route);return()=>active.delete(id);}};
  function context({failBundleEffect=false}={}){
    const services=new Map(),cleanups=[];
    const value={
      llm:{},logger:{warn(){}},
      sessions:{get(){return undefined;}},
      agents:{get(){return undefined;},list(){return [];},isOwnedBy(){return false;}},
      tools:{register(){return()=>{};},guard(){return()=>{};},view(){return {restrictableNames:new Set()};}},
      get:key=>key==='profileContext'?profile:services.get(key),
      provide(key,service){services.set(key,service);},
      on(){},
      inject(_names,callback){return callback(value);},
      effect(factory,label){
        if(failBundleEffect&&String(factory).includes('personalServiceKey'))throw Error('fixture failure after loaded route');
        const cleanup=factory();cleanups.push(cleanup);return cleanup;
      },
      webServer,
    };
    return {value,cleanups};
  }
  const rootContext=context();
  rootContext.value.effect=(factory)=>{const cleanup=factory();rootCleanups.push(cleanup);return cleanup;};
  rootContext.value.plugin=callback=>{
    const child=context({failBundleEffect:true}),task=Promise.resolve().then(()=>callback(child.value));
    const fiber={
      then:(resolve,reject)=>task.then(resolve,reject),
      catch:reject=>task.catch(reject),
      async dispose(){for(const cleanup of child.cleanups.splice(0).reverse())await cleanup?.();},
    };
    return fiber;
  };
  t.after(async()=>{for(const cleanup of rootCleanups.reverse())await cleanup?.();});

  await applyBundle(rootContext.value,{});
  const bootstrapRoutes=[...active.values()].filter(route=>route.path==='/api/basic-memory-bootstrap');
  assert.equal(bootstrapRoutes.length,1,'the loaded route must be removed before full setup is registered');
  const response=await new Promise(resolve=>{
    const req={method:'GET',url:'/api/basic-memory-bootstrap',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:15680'}};
    const res={setHeader(){},end(value){resolve(JSON.parse(value));}};
    bootstrapRoutes[0].handler(req,res);
  });
  assert.equal(response.configured,true);assert.equal(response.frameworkLoaded,false);assert.equal(response.activation,'failed');
  assert.equal(JSON.parse(await fs.readFile(activationFile,'utf8')).state,'failed');
});
test('next-start activation preserves the current process and only checks the selected isolated library',async()=>{
  const root=await scratchDirectory('bootstrap-activation-'),home=path.join(root,'home'),dir=path.join(home,'profiles','fixture'),base=path.join(dir,'basic-memory-bridge'),vault=path.join(base,'personal','vault'),state=path.join(base,'personal','basic-memory-state'),old=path.join(root,'old','vault');
  await fs.mkdir(vault,{recursive:true});await fs.mkdir(state,{recursive:true});await fs.mkdir(old,{recursive:true});await fs.mkdir(path.join(home,'storages'),{recursive:true});await fs.writeFile(path.join(home,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},global:{},tables:{workspaces:{w:{title:'测试',sessionIds:['session-one']}}}}));
  await fs.writeFile(path.join(state,'config.json'),JSON.stringify({projects:{main:{path:vault,mode:'local'}}}));await fs.writeFile(path.join(state,'memory.db'),'fixture');const file=path.join(base,'configuration.json'),cfg={ownerDirectory:path.dirname(vault),socialRoot:path.join(base,'social'),dshHome:home,dshSessionIds:['session-one'],memory:{autoCapture:true,captureProvider:'retired',captureModel:'retired'}};await fs.writeFile(file,JSON.stringify(cfg));const profile={name:'fixture',dir,home},raw={vaultPath:old};
  await stageBootstrapActivation(profile,raw,deploymentFingerprint(cfg));assert.equal(await readScheduledBootstrap(profile,raw),null);await assert.rejects(updateBootstrapSessions(profile,[],deploymentFingerprint(cfg)),/先取消/);
  const marker=path.join(base,'activation.json'),saved=JSON.parse(await fs.readFile(marker));saved.scheduledPid=999999999;await fs.writeFile(marker,JSON.stringify(saved));const plan=await readScheduledBootstrap(profile,raw);assert.ok(plan);
  const receipt=plan.configFile+'.runtime.json';await fs.writeFile(receipt,JSON.stringify({pid:process.pid,state:'starting'}));await assert.rejects(recordBootstrapActivation(plan,'failed'),/已有 DSH 进程正在加载/);assert.equal(JSON.parse(await fs.readFile(marker)).state,'scheduled');await fs.rm(receipt);
  await recordBootstrapActivation(plan,'active');await assert.rejects(stageBootstrapActivation(profile,raw,deploymentFingerprint(cfg),'cancel'),/已有 DSH 进程/);
  const statusDir=path.join(cfg.ownerDirectory,'management','memory-status');await fs.mkdir(statusDir,{recursive:true});await fs.writeFile(path.join(statusDir,'recovery.json'),JSON.stringify({version:1,project:'main',jobs:[{id:'retained'}],pending:[]}));const recoveryPlan=await readScheduledBootstrap(profile,raw);assert.ok(recoveryPlan&&!recoveryPlan.error,'active configuration must allow recovery jobs');
  const active=JSON.parse(await fs.readFile(marker));active.activePid=process.ppid;await fs.writeFile(marker,JSON.stringify(active));const otherProcessPlan=await readScheduledBootstrap(profile,raw);assert.match(otherProcessPlan.error,/已有 DSH 进程/);await assert.rejects(recordBootstrapActivation(otherProcessPlan,'failed'),/已有 DSH 进程/);
  active.activePid=999999999;await fs.writeFile(marker,JSON.stringify(active));const retryPlan=await readScheduledBootstrap(profile,raw);await recordBootstrapActivation(retryPlan,'failed');const failed=JSON.parse(await fs.readFile(marker));assert.equal(failed.state,'failed');assert.equal(failed.activePid,undefined);assert.ok((await readBootstrap(profile,raw)).activationError);await stageBootstrapActivation(profile,raw,deploymentFingerprint(cfg),'cancel');assert.equal(await readScheduledBootstrap(profile,raw),null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {createSessionMemory} from '../lib/session-memory.js';
import {apply} from '../lib/platform-host.js';
import {createSettingsHandler} from '../lib/settings-host.js';
import {
  applyDeploymentSessionChange,
  deploymentFingerprint,
  deploymentStaticFingerprint,
  readDeploymentSettings,
  stageDeploymentSessionDefault,
} from '../lib/deployment-config.js';

async function temporaryRoot(t,prefix){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),prefix));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return root;
}

async function sessionFixture(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'session-auto-enable-'));
  const actors=new Map(),sessions=new Map(),owners=new Map();
  const agents={get:id=>actors.get(id),list:()=>[...actors.values()],isOwnedBy:(id,owner)=>owners.get(id)===owner};
  const service={get:id=>sessions.get(id)};
  let memory=await createSessionMemory({directory,ownerSubject:'测试用户',agents,sessions:service,logger:{warn(){}}});
  t.after(async()=>{memory.close();await fs.rm(directory,{recursive:true,force:true});});
  function actor(id,{parent,seed=[],inherited=0}={}){
    const events=[...seed];
    const session={id,inheritedEventCount:inherited,get seq(){return events.length;},
      snapshotEvents:(from=0,to=events.length)=>events.slice(from,to)};
    const agent={id,session};
    actors.set(id,agent);sessions.set(id,session);if(parent)owners.set(id,parent);
    return agent;
  }
  function emit(agent,type,data,surfaceOp){
    const events=agent.session.snapshotEvents(),event={seq:events.length,type,data,...(surfaceOp?{surfaceOp}:{})};
    events.push(event);
    agent.session.snapshotEvents=(from=0,to=events.length)=>events.slice(from,to);
    Object.defineProperty(agent.session,'seq',{configurable:true,get:()=>events.length});
    assert.equal(memory.observe(agent.session,event),true);
    return event;
  }
  return {directory,actor,emit,
    begin(agent,turn){return emit(agent,'turn/start',{turn});},
    user(agent,id='u-'+agent.session.seq){
      return emit(agent,'user/message',{id,role:'user',source:{kind:'user'},content:[{type:'text',text:'虚构第一句话'}]},'append');
    },
    get memory(){return memory;},
  };
}

test('autoEnable grants a brand-new root before its first user message',async t=>{
  const f=await sessionFixture(t),agent=f.actor('session-brand-new');
  assert.equal(await f.memory.autoEnable(agent),true);
  assert.deepEqual(f.memory.enabledSessionIds(),[agent.id]);
  assert.equal(f.memory.status(agent.id).requested,true);
  assert.equal(f.memory.check(agent).allowed,false);
  f.begin(agent,1);
  const user=f.user(agent);
  assert.equal(f.memory.check(agent).allowed,true);
  const admitted=f.memory.admitMessage(agent.session,user);
  assert.ok(admitted);
  assert.equal(admitted.source.text,'虚构第一句话');
});

test('autoEnable leaves existing turns, explicit choices, children and forks alone',async t=>{
  const f=await sessionFixture(t),existing=f.actor('session-existing');
  f.begin(existing,1);
  assert.equal(await f.memory.autoEnable(existing),false);

  const disabled=f.actor('session-disabled');
  await f.memory.set(disabled.id,false);
  assert.equal(await f.memory.autoEnable(disabled),false);
  assert.equal(f.memory.status(disabled.id).requested,false);

  const root=f.actor('session-root'),child=f.actor('session-child',{parent:root});
  assert.equal(await f.memory.autoEnable(child),false);
  assert.equal(f.memory.status(child.id).requested,false);

  const inherited=f.actor('session-inherited',{inherited:1});
  assert.equal(await f.memory.autoEnable(inherited),false);
  assert.equal(f.memory.status(inherited.id).requested,false);
});

test('autoEnable returns false after close and never throws for malformed agents',async t=>{
  const f=await sessionFixture(t),agent=f.actor('session-closing');
  f.memory.close();
  assert.equal(await f.memory.autoEnable(agent),false);
  assert.equal(await f.memory.autoEnable(null),false);
});

async function hostFixture(t,{autoEnable=true,withSettings=false}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-auto-host-'));
  const events=new Map(),actors=new Map(),sessions=new Map(),owners=new Map();
  const callbacks=new Map(),effects=[],services=new Map(),warnings=[];
  t.after(async()=>{for(const dispose of effects.reverse())await dispose?.();await fs.rm(root,{recursive:true,force:true});});
  let settingsHandler;
  const cfg={ownerDirectory:root,dshHome:root,dshSessionIds:[],autoEnableNewSessions:autoEnable,memory:{rawRecall:false}};
  let configurationFile;
  if(withSettings){
    await fs.mkdir(path.join(root,'storages'));
    await fs.writeFile(path.join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{}}}));
    configurationFile=path.join(root,'deployment.json');
    await fs.writeFile(configurationFile,JSON.stringify(cfg));
  }
  const ctx={
    llm:{},logger:{warn:message=>warnings.push(String(message))},
    agents:{get:id=>actors.get(id),list:()=>[...actors.values()],isOwnedBy:(id,owner)=>owners.get(id)===owner},
    sessions:{get:id=>sessions.get(id),ensure:async id=>{const session=sessions.get(id);if(!session)throw Error('unknown session');return session;}},
    tools:{register(){return()=>{};},guard(){return()=>{};},view(){return {restrictableNames:new Set(['ordinary_tool','memory_search'])}}},
    get:key=>services.get(key),provide:(key,value)=>services.set(key,value),
    effect(fn){const dispose=fn();if(typeof dispose==='function')effects.push(dispose);},
    on(name,fn){callbacks.set(name,[...(callbacks.get(name)||[]),fn]);},
    inject(_names,fn){
      if(!configurationFile)return;
      fn({effect(work){const dispose=work();if(typeof dispose==='function')effects.push(dispose);},
        webServer:{register({handler}){settingsHandler=handler;return()=>{};}}});
    },
  };
  function actor(id){
    const log=[];
    const session={id,inheritedEventCount:0,get seq(){return log.length},snapshotEvents:(from=0,to=log.length)=>log.slice(from,to)};
    const denied=new Set(),scope={restrict({deny}){for(const name of deny)denied.add(name);return()=>deny.forEach(name=>denied.delete(name));}};
    const agent={id,session,status:'idle',ctx:{get:()=>scope},denied};
    events.set(id,log);actors.set(id,agent);sessions.set(id,session);
    return agent;
  }
  const service=await apply(ctx,{directory:root,sessionIds:[],ownerSubject:'测试用户',sessionMemory:true,autoEnableNewSessions:autoEnable,
    configurationFile,configurationFingerprint:configurationFile?deploymentFingerprint(cfg):undefined,
    configurationStaticFingerprint:deploymentStaticFingerprint(cfg),deployment:{async markApplied(){}},
    memory:{autoCapture:false,autoRecall:false,recentContext:false,rawRecall:false}});
  async function created(agent){
    const handlers=callbacks.get('agent/created')||[];
    assert.ok(handlers.length);
    for(const handler of handlers)await handler({agent});
  }
  function emit(agent,type,data,surfaceOp){
    const event={seq:agent.session.seq,type,data,...(surfaceOp?{surfaceOp}:{})};
    events.get(agent.id).push(event);
    assert.equal(service.sessionMemory.observe(agent.session,event),true);
    sessionMemoryEvent(agent.session,event);
    return event;
  }
  function sessionMemoryEvent(session,event){
    for(const handler of callbacks.get('session/event')||[])handler(session,event);
  }
  return {root,cfg,service,actor,created,emit,warnings,get handler(){return settingsHandler;}};
}

async function request(handler,method,sub,body){
  const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
  Object.assign(req,{method,url:'/api/basic-memory-settings'+sub,socket:{remoteAddress:'127.0.0.1'},
    headers:{host:'127.0.0.1:15680','content-type':'application/json','x-basic-memory-settings':'1'}});
  const res={headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=JSON.parse(value);}};
  await handler(req,res);
  return res;
}

test('host waits for automatic authorization and exposes it outside the legacy binding list',async t=>{
  const f=await hostFixture(t,{autoEnable:true,withSettings:true}),agent=f.actor('session-auto-host');
  await f.created(agent);
  assert.equal(f.service.sessionMemory.status(agent.id).requested,true);
  const listed=await request(f.handler,'GET','/sessions');
  assert.equal(listed.statusCode,200,JSON.stringify(listed.body));
  assert.equal(listed.body.sessionMemory.autoEnableNew,true);
  assert.deepEqual(listed.body.sessionMemory.enabledSessions,[agent.id]);
  assert.deepEqual(listed.body.sessionMemory.states.map(state=>state.sessionId),[agent.id]);
  assert.deepEqual(listed.body.sessions,[]);
  f.emit(agent,'turn/start',{turn:1});
  assert.equal(f.service.sessionMemory.check(agent).allowed,true);
});

test('host disabled default writes nothing and a thrown autoEnable cannot fail creation',async t=>{
  const off=await hostFixture(t,{autoEnable:false}),first=off.actor('session-auto-off');
  await off.created(first);
  assert.equal(off.service.sessionMemory.status(first.id).requested,false);

  const broken=await hostFixture(t,{autoEnable:true}),second=broken.actor('session-auto-error');
  broken.service.sessionMemory.autoEnable=async()=>{throw Error('fixture failure');};
  await broken.created(second);
  assert.equal(broken.warnings.some(message=>message.includes('自动开启失败')&&message.includes('fixture failure')),true);
  assert.equal(broken.service.sessionMemory.status(second.id).requested,false);
});

test('host unbind and replace close automatically enabled sessions',async t=>{
  const f=await hostFixture(t,{autoEnable:true});
  const first=f.actor('session-auto-unbind'),second=f.actor('session-auto-replace');
  await f.created(first);await f.created(second);
  assert.deepEqual(new Set(f.service.sessionMemory.enabledSessionIds()),new Set([first.id,second.id]));
  await f.service.applySessionSelection(f.cfg,'unbind-auto',{action:'unbind',value:first.id});
  assert.equal(f.service.sessionMemory.status(first.id).requested,false);
  assert.equal(f.service.sessionMemory.status(second.id).requested,true);
  await f.service.applySessionSelection(f.cfg,'replace-auto',{action:'replace',value:[]});
  assert.equal(f.service.sessionMemory.status(second.id).requested,false);
  // A replace must still enable a conversation that was never bound or enabled before.
  const third=f.actor('session-manual-replace');
  await f.service.applySessionSelection(f.cfg,'replace-manual',{action:'replace',value:[third.id]});
  assert.equal(f.service.sessionMemory.status(third.id).requested,true);
  assert.equal(f.service.sessionMemory.status(second.id).requested,false);
});

async function deploymentFixture(t){
  const root=await temporaryRoot(t,'session-default-config-');
  await fs.mkdir(path.join(root,'storages'));
  await fs.writeFile(path.join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{}}}));
  const file=path.join(root,'deployment.json'),cfg={ownerDirectory:root,dshHome:root,dshSessionIds:[],autoEnableNewSessions:false,memory:{rawRecall:false}};
  await fs.writeFile(file,JSON.stringify(cfg));
  return {root,file,cfg,revision:deploymentFingerprint(cfg)};
}

test('session default staging writes atomically, rejects stale or non-boolean input and calls afterSave',async t=>{
  const f=await deploymentFixture(t);
  let applied;
  const result=await stageDeploymentSessionDefault(f.file,true,f.revision,async(cfg,revision)=>{applied={cfg,revision};});
  assert.deepEqual(result,{autoEnableNewSessions:true,revision:applied.revision,applied:true});
  assert.equal(applied.cfg.autoEnableNewSessions,true);
  assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).autoEnableNewSessions,true);
  await assert.rejects(stageDeploymentSessionDefault(f.file,false,f.revision),error=>error.code==='REVISION_CONFLICT');
  await assert.rejects(stageDeploymentSessionDefault(f.file,'yes',applied.revision),/请选择有效的开关状态/);
  assert.equal((await readDeploymentSettings(f.file)).autoEnableNewSessions,true);
  const changed={...f.cfg,dshSessionIds:[]};
  assert.strictEqual(await applyDeploymentSessionChange(changed,{action:'unbind',value:'session-auto'}),changed);
  await assert.rejects(applyDeploymentSessionChange(changed,{action:'unbind',value:'not-a-session'}),/会话选择无效/);
});

test('deployment settings reject a non-boolean persisted default',async t=>{
  const f=await deploymentFixture(t);
  await fs.writeFile(f.file,JSON.stringify({...f.cfg,autoEnableNewSessions:'yes'}));
  await assert.rejects(readDeploymentSettings(f.file),/新对话记忆设置无效/);
});

test('session-default route saves the default and returns the session receipt',async t=>{
  const f=await deploymentFixture(t);
  let applied=0;
  const handler=createSettingsHandler({},f.file,undefined,async()=>({sessionMemory:{
    defaultEnabled:false,effective:'next-user-turn',autoEnableNew:true,enabledSessions:[],states:[]}}),{
    sessionMemory:{},
    async afterSessionDefaultSave(){applied++;},
  });
  t.after(()=>handler.dispose());
  const saved=await request(handler,'POST','/session-default',{enabled:true,revision:f.revision});
  assert.equal(saved.statusCode,200,JSON.stringify(saved.body));
  assert.equal(applied,1);
  assert.equal(saved.body.autoEnableNewSessions,true);
  assert.equal(saved.body.sessionMemory.autoEnableNew,true);
  assert.deepEqual(saved.body.sessions,[]);
  const missing=createSettingsHandler({},f.file,undefined,async()=>({}));
  t.after(()=>missing.dispose());
  const rejected=await request(missing,'POST','/session-default',{enabled:false,revision:saved.body.revision});
  assert.equal(rejected.statusCode,404);
  assert.equal(rejected.body.error,'当前入口尚未启用对话记忆开关');
});

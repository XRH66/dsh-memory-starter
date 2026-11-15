import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readBootstrap,createBootstrap,stageBootstrapActivation,readScheduledBootstrap,recordBootstrapActivation,updateBootstrapSessions} from '../lib/bootstrap-host.js';
import {deploymentFingerprint} from '../lib/deployment-config.js';
import {scratchDirectory} from './helpers.js';

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

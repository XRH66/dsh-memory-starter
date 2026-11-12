#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {resolveConfig} from '../lib/config.js';
import {RawMemoryStore,rawMaintenanceRevision} from '../lib/raw-rag/store.js';
import {managementDirectory} from '../lib/review.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {rawModelSpec} from '../lib/raw-rag/models.js';
import {previewHistory,applyHistory} from '../lib/raw-rag/history.js';
import {syncFactualPriorities} from '../lib/raw-rag/fact-priority.js';

const {positionals,values}=parseArgs({allowPositionals:true,options:{
  deployment:{type:'string'},out:{type:'string'},plan:{type:'string'},progress:{type:'string'},
  'normal-default':{type:'boolean'},'exclude-session':{type:'string',multiple:true},
  'max-turns':{type:'string'},'batch-size':{type:'string'},'max-source-mb':{type:'string'},
  session:{type:'string'},turn:{type:'string'},message:{type:'string'},weight:{type:'string'},
  exclude:{type:'boolean'},include:{type:'boolean'},reason:{type:'string'},help:{type:'boolean'},
}});
const command=positionals[0];
const write=async(file,value)=>{
  const dest=path.resolve(file);await fs.mkdir(path.dirname(dest),{recursive:true});
  const temp=dest+'.tmp-'+process.pid;await fs.writeFile(temp,JSON.stringify(value,null,2)+'\n');await fs.rename(temp,dest);
};
const number=(name,fallback)=>{
  if(values[name]===undefined)return fallback;
  const n=Number(values[name]);if(!Number.isSafeInteger(n)||n<=0)throw Error('Invalid positive integer --'+name);return n;
};
let store,recall;
// The live process owns vector-queue.json. The CLI only reads its acknowledgement;
// durable maintenance changes remain in raw_controls / legacy_scope_views.
async function indexReconciliation(config,ownerSubject,maintenanceRevision){
  const directory=path.join(managementDirectory(config),'vectors');
  const read=async name=>{try{return JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
  const [profiles,queue]=await Promise.all([read('profiles.json'),read('vector-queue.json')]);
  const sameScope=row=>row.ownerSubject===ownerSubject&&row.project===config.project;
  const scope=profiles?.scopes?.find(sameScope),active=scope?.active;
  const progress=scope?.progress?.find(row=>row.profileId===active?.id&&row.profileRevision===active?.revision);
  const boundaries=(queue?.catalogues??[]).filter(sameScope);
  const boundary=boundaries.find(row=>row.id==='catalog-change:authorized-domain-boundary'&&row.revision===1);
  const observed=maintenanceRevision===null||boundary?.maintenanceRevision===maintenanceRevision;
  const pending=!observed||boundaries.some(row=>row.delivery>row.acknowledged)||(queue?.jobs??[]).some(row=>sameScope(row)&&
    row.profile?.id===active?.id&&row.profile?.revision===active?.revision&&row.intentId===progress?.intentId&&['pending','running','held','error'].includes(row.state));
  const state=!active?'unprepared':progress?.state==='cancelled'?'cancelled':progress?.state==='error'?'error':pending?'pending':progress?.state??'unprepared';
  return {state,maintenanceObserved:observed,caughtUp:state==='ready',
    note:'Source controls apply immediately. DSH reconciles on status/resume or its existing background scan; no model is loaded by this report.'};
}
try{
  if(values.help||!command){
    console.log('Local raw memory maintenance: preview --deployment FILE --out PLAN [--normal-default]; apply --plan PLAN [--max-turns N]; status --deployment FILE; index --deployment FILE; control --deployment FILE (--session ID [--turn N] | --message ID) (--exclude | --include | --weight 0..1); sync-softening --deployment FILE');
  }else{
    let result;
    if(command==='preview'){
      if(!values.deployment||!values.out)throw Error('preview needs --deployment and --out');
      const plan=await previewHistory(path.resolve(values.deployment),{normalDefaultConfirmed:values['normal-default'],excludeSessionIds:values['exclude-session']||[],maxSourceBytes:number('max-source-mb',256)*1024*1024});
      await write(values.out,plan);result={ok:true,plan:path.resolve(values.out),id:plan.id,...plan.summary,reasons:plan.sources.reduce((a,s)=>(a[s.reason]=(a[s.reason]||0)+1,a),{})};
    }else{
      if(command==='apply'&&!values.plan)throw Error('apply needs --plan');
      const plan=command==='apply'?JSON.parse(await fs.readFile(path.resolve(values.plan),'utf8')):null;
      const deploymentFile=plan?.configurationFile||values.deployment;
      if(!deploymentFile)throw Error('Missing --deployment');
      const deployment=JSON.parse(await fs.readFile(path.resolve(deploymentFile),'utf8'));
      if(!path.isAbsolute(deployment.ownerDirectory||'')||typeof deployment.ownerSubject!=='string'||!deployment.ownerSubject.trim())throw Error('An explicit memory directory and owner are required');
      const config=resolveConfig({...deployment.memory,project:'main',vaultPath:path.join(deployment.ownerDirectory,'vault')});
      const scope=deployment.ownerSubject;
      const dbFile=config.rawRecallDbPath||path.join(deployment.ownerDirectory,'management','raw-recall','raw-recall.sqlite');
      let maintenanceRevision=null;
      if(command==='status'){
        result={ok:true,enabled:config.rawRecall,requestedModel:rawModelSpec(config).id,modelKey:null,database:dbFile,exists:fsSync.existsSync(dbFile),vectorIndexes:[]};
        if(result.exists){
          const db=new DatabaseSync(dbFile,{readOnly:true});
          try{
            maintenanceRevision=rawMaintenanceRevision(db,scope);
            for(const table of ['turns','windows'])result[table]=Number(db.prepare(`SELECT COUNT(*) n FROM ${table} x JOIN turns t ON x.namespace=t.namespace AND x.turn_id=t.turn_id WHERE t.scope=?`).get(scope).n);
            result.vectorIndexes=db.prepare('SELECT v.model_key modelKey,v.dim dimensions,COUNT(*) vectors FROM vectors v JOIN turns t ON t.namespace=v.namespace AND t.turn_id=v.turn_id WHERE t.scope=? GROUP BY v.model_key,v.dim').all(scope);
            result.vectors=result.vectorIndexes.reduce((sum,index)=>sum+Number(index.vectors),0);
            result.note='Read-only inventory. No model is prepared or loaded by status; modelKey is resolved only on an authorized index/query.';
            if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_usage'").get())result.embeddingUsage=db.prepare(`SELECT COUNT(*) calls,COALESCE(SUM(json_extract(receipt_json,'$.tokens')),0) reportedTokens,SUM(CASE WHEN json_extract(receipt_json,'$.tokens') IS NULL THEN 1 ELSE 0 END) unknownUsageCalls FROM embedding_usage WHERE namespace='default' AND scope=?`).get(scope);
            if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='turn_visibility'").get())result.excludedTurns=Number(db.prepare('SELECT COUNT(*) n FROM turn_visibility v JOIN turns t ON t.namespace=v.namespace AND t.turn_id=v.turn_id WHERE t.scope=? AND (v.excluded=1 OR v.source_hidden=1 OR v.weight<=0)').get(scope).n);
            if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='import_progress'").get())result.imports=db.prepare('SELECT source_id,position,completed,updated_at FROM import_progress WHERE scope=?').all(scope);
          }finally{db.close();}
        }
      }else{
        if(!['apply','control','sync-softening','index'].includes(command))throw Error('Unknown raw-memory command');
        if(command==='apply'&&!config.rawRecall)throw Error('Enable rawRecall before importing history');
        let backup=null;
        if(fsSync.existsSync(dbFile)){
          const dir=path.join(path.dirname(dbFile),'backups');await fs.mkdir(dir,{recursive:true});
          backup=path.join(dir,'before-'+command+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+process.pid+'.sqlite');
          const db=new DatabaseSync(dbFile,{readOnly:true});try{db.prepare('VACUUM INTO ?').run(backup);}finally{db.close();}
        }
        store=new RawMemoryStore(dbFile);
        recall=createRawRecall({config,ownerSubject:scope,store,logger:{warn:m=>process.stderr.write(m+'\n')}});
        const priorities=syncFactualPriorities(store,{scope,vaultPath:config.vaultPath,captureFolder:config.captureFolder});
        if(command==='apply'){
          const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
          const statistics=await applyHistory(plan,{store,recall,maxTurns:number('max-turns',Infinity),batchSize:number('batch-size',16),signal:controller.signal,onProgress:async progress=>{
            if(values.progress){await fs.mkdir(path.dirname(path.resolve(values.progress)),{recursive:true});await fs.appendFile(values.progress,JSON.stringify({at:new Date().toISOString(),...progress})+'\n');}
          }});
          result={ok:true,backup,priorities,...statistics,modelKey:recall.modelKey,stats:store.stats(recall.modelKey,scope)};
        }else if(command==='index'){
          const controller=new AbortController();process.once('SIGINT',()=>controller.abort());
          result={ok:true,backup,...await recall.indexPending({signal:controller.signal}),modelKey:recall.modelKey,stats:store.stats(recall.modelKey,scope)};
        }else if(command==='control'){
          const selected=Number(Boolean(values.session))+Number(Boolean(values.message));
          if(selected!==1||Number(Boolean(values.exclude))+Number(Boolean(values.include))+Number(values.weight!==undefined)!==1)throw Error('Choose one exact source and one control action');
          let targetType=values.message?'message':'session',targetId=values.message||values.session;
          if(values.turn!==undefined){
            if(!values.session||!/^\d+$/.test(values.turn))throw Error('--turn needs a session and nonnegative integer');
            targetType='turn';targetId=[scope,values.session,Number(values.turn)].join('\0');
          }
          const weight=values.weight===undefined?1:Number(values.weight);
          result={ok:true,backup,...store.setControl({scope,targetType,targetId,weight,excluded:Boolean(values.exclude),reason:values.reason||'explicit local operator control'})};
        }else if(command==='sync-softening')result={ok:true,backup,...priorities};
      }
      if(['status','control','sync-softening'].includes(command))result.indexReconciliation=await indexReconciliation(config,scope,store?store.maintenanceRevision(scope):maintenanceRevision);
      if(values.out)await write(values.out,result);
    }
    console.log(JSON.stringify(result));
  }
}catch(error){console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;}
finally{if(recall)await recall.dispose();else store?.close();}

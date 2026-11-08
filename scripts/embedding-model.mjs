#!/usr/bin/env node
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {createModelInstaller} from '../lib/raw-rag/install.js';
import {readDeploymentModelConfiguration,stageDeploymentRawModel} from '../lib/deployment-config.js';
import {inspectSelectedInstallation} from '../lib/raw-rag/install-files.js';
const [action,...args]=process.argv.slice(2),options={};
for(let index=0;index<args.length;index++){
  const name=args[index];if(!name.startsWith('--'))throw Error('请使用命名参数');
  if(['--download','--reuse','--gpu-info','--allow-cloud'].includes(name))options[name]=true;
  else{const value=args[++index];if(!value||value.startsWith('--'))throw Error('缺少参数 '+name);options[name]=value;}
}
const file=options['--deployment'];if(!path.isAbsolute(file || ''))throw Error('需要 --deployment 指定部署文件完整路径');
const readConfiguration=()=>readDeploymentModelConfiguration(file);
const {cfg,revision}=await readConfiguration();
const manager=createModelInstaller({readConfiguration,stageModel:(input,expected)=>stageDeploymentRawModel(file,input,expected)});
const input={revision,settings:{...cfg.memory,...(options['--model']?{rawRecallModel:options['--model'],rawRecallDimensions:0,rawRecallInstallReceipt:''}:{})},
  acceleration:options['--acceleration'] || 'cpu',readGpu:options['--gpu-info']===true};
const paths={'--python':'rawRecallPython','--onnx':'rawRecallOnnxModel','--tokenizer':'rawRecallOnnxTokenizer','--gguf':'rawRecallGgufModel','--server':'rawRecallLlamaServer','--bge-dir':'rawRecallBgeModelDir','--cache':'rawRecallCacheDir'};
for(const [flag,field] of Object.entries(paths))if(options[flag]){input.settings[field]=options[flag];input.settings.rawRecallInstallReceipt='';}
if(options['--threads'])input.settings.rawRecallThreads=Number(options['--threads']);
let cancelled=false;const cancel=()=>{cancelled=true;const job=manager.status();if(job?.state==='running')manager.cancel(job.id);};
process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
try{
  if(action==='plan')process.stdout.write(JSON.stringify(await manager.plan(input),null,2)+'\n');
  else if(action==='status')process.stdout.write(JSON.stringify({current:await inspectSelectedInstallation(cfg.memory),pending:cfg.pendingRawRecall?await inspectSelectedInstallation(cfg.pendingRawRecall):null,
    history:(cfg.rawModelHistory || []).map(item=>({id:item.id,model:item.settings.rawRecallModel,at:item.at}))},null,2)+'\n');
  else if(action==='prepare'){
    if(!options['--download']&&!options['--reuse'])throw Error('准备时显式选择 --download 或 --reuse');
    await manager.start({...input,allowDownload:options['--download']===true,useExisting:options['--reuse']===true});
    let previous='';
    while(true){const job=manager.status(),text=JSON.stringify(job);if(text!==previous){process.stdout.write(text+'\n');previous=text;}
      if(job?.state!=='running'){if(job?.state!=='prepared')process.exitCode=cancelled?130:1;break;}await delay(500);}
  }else if(action==='restore'){
    const id=options['--id'] || cfg.rawModelHistory?.[0]?.id;if(!id)throw Error('没有可恢复的向量设置');
    await stageDeploymentRawModel(file,{restoreId:id,allowCloud:options['--allow-cloud']===true},revision);
    process.stdout.write('已保存待恢复的向量设置，下次重新加载后生效；没有覆盖记忆数据。\n');
  }else if(action==='cancel-staged'){
    await stageDeploymentRawModel(file,{cancel:true},revision);process.stdout.write('已取消待切换的向量设置。\n');
  }else throw Error('用法：embedding-model.mjs plan|status|prepare|restore|cancel-staged --deployment <完整路径> [--model <Embedding型号>] [--download|--reuse] [--acceleration cpu|cuda]');
}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);await manager.dispose();}

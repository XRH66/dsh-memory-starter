import {readDeploymentSettings,updateDeploymentSession,createDeploymentLibrary,stageDeploymentLibrary,stageDeploymentFlags,stageDeploymentRawModel,manageEmbeddingServices,readDeploymentModelConfiguration,stageDeploymentTimeZone,stageDeploymentSessionDefault,stageDeploymentRerank} from './deployment-config.js';
import {createModelInstaller} from './raw-rag/install.js';
import {stageDeploymentHandoff} from './deployment-config.js';
import {normalizeHandoffTokens,MEMORY_HANDOFF_DEFAULTS} from './memory-contract.js';
import {personalTimeZone} from './personal-namespace.js';
import {testDeploymentConnection} from './connection-test.js';

const base='/api/basic-memory-settings';
export function trusted(ctx,req,write){
  const rejection=ctx.get?.('connection')?.requestRejection?.({headers:req.headers});if(rejection!==undefined)return false;
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket?.remoteAddress))return false;
  const host=req.headers?.host;let parsed;try{parsed=new URL('http://'+host);}catch{return false;}
  if(!['localhost','127.0.0.1','::1'].includes(parsed.hostname.replace(/^\[|\]$/g,'')))return false;
  if(req.headers?.['sec-fetch-site']==='cross-site')return false;
  const origin=req.headers?.origin;if(origin){if(origin==='null')return false;try{const source=new URL(origin);if(source.host!==host||source.protocol!==(req.socket?.encrypted?'https:':'http:'))return false;}catch{return false;}}
  return !write||(req.headers?.['x-basic-memory-settings']==='1'&&String(req.headers?.['content-type']??'').toLowerCase().startsWith('application/json'));
}
export function json(res,status,value){res.statusCode=status;res.setHeader('content-type','application/json; charset=utf-8');res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');res.end(JSON.stringify(value));}
export async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>32768)throw Error('请求内容过大');chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('请求格式无效');}}
export function createSettingsHandler(ctx,configurationFile,afterSessionsSaved,getRuntimeStatus,controls){
  const installer=createModelInstaller({readConfiguration:()=>readDeploymentModelConfiguration(configurationFile),
    stageModel:(input,revision)=>stageDeploymentRawModel(configurationFile,input,revision,controls?.afterSave)});
  let testing=false;
  const sessionReceipt=async saved=>{
    const {runtime,...status}=await getRuntimeStatus?.()??{};
    // The existing opt-in UI consumes the deployment runtime STRING. Keep the
    // new detailed runtime object under its own name in the sessions response.
    return {...saved,...status,activeTimeZone:personalTimeZone(),...(runtime&&typeof runtime==='object'?{memoryRuntime:runtime}:runtime!==undefined?{runtime}:{})};
  };
  const handler=async(req,res)=>{
    const url=new URL(req.url??'/', 'http://localhost'),sub=url.pathname.slice(base.length).replace(/\/+$/,'')||'/';
    if(!trusted(ctx,req,req.method==='POST'))return json(res,403,{ok:false,error:'访问被拒绝'});
    try{
      const checkManagement=()=>{
        if(req.aborted||res.destroyed||!trusted(ctx,req,req.method==='POST'))throw Error('管理权限已失效');
      };
      if(sub==='/documents'&&['GET','POST'].includes(req.method)){
        if(typeof controls?.manageMemoryDocuments!=='function')return json(res,404,{ok:false,error:'当前入口尚未接通资料选择'});
        let input={};
        if(req.method==='POST'){
          const value=await body(req);
          if(typeof value?.revision!=='string'||!value.revision||!Array.isArray(value.identifiers)||value.identifiers.length>100||
            value.identifiers.some(id=>typeof id!=='string'||!id.trim()||id.length>512))throw Error('请输入当前记忆库中的 Markdown 相对路径');
          input={revision:value.revision,identifiers:value.identifiers};
        }
        const value=await controls.manageMemoryDocuments(input,checkManagement);
        checkManagement();return json(res,200,{ok:true,...value});
      }
      if(sub==='/reviews'&&['GET','POST'].includes(req.method)){
        if(typeof controls?.manageMemoryReview!=='function')return json(res,404,{ok:false,error:'当前入口尚未接通人工审核'});
        const validId=value=>typeof value==='string'&&value.length>0&&value.length<=512;
        let input;
        if(req.method==='GET'){
          const operationId=url.searchParams.get('operationId'),afterId=url.searchParams.get('afterId')??'';
          if(operationId!==null&&!validId(operationId)||afterId&&!validId(afterId))throw Error('审核定位无效');
          input=operationId?{action:'read',operationId}:{action:'list',afterId};
        }else{
          const value=await body(req);
          if(!['approve','reject'].includes(value?.action)||!validId(value.operationId)||value.action==='approve'&&!validId(value.revision))
            throw Error('审核操作或版本无效');
          input={action:value.action,operationId:value.operationId,revision:value.revision};
        }
        const value=await controls.manageMemoryReview(input,checkManagement);
        checkManagement();
        return json(res,200,{ok:true,...value});
      }
      if(sub==='/raw-messages'&&['GET','POST'].includes(req.method)){
        if(typeof controls?.manageRawMessages!=='function')return json(res,404,{ok:false,error:'当前入口尚未接通原话删除'});
        const validId=value=>typeof value==='string'&&value.length>0&&value.length<=512;
        let input;
        if(req.method==='GET'){
          const query=(url.searchParams.get('query')??'').trim(),rawLimit=url.searchParams.get('limit'),limit=rawLimit===null?20:Number(rawLimit);
          if(!query||Array.from(query).length>100||!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('请输入 1–100 个字的搜索关键词');
          input={action:'search',query,limit};
        }else{
          const value=await body(req);
          if(value?.action!=='withdraw'||!validId(value.id)||!Number.isSafeInteger(value.revision)||value.revision<1)
            throw Error('原话删除操作或版本无效');
          input={action:'withdraw',id:value.id,revision:value.revision};
        }
        const value=await controls.manageRawMessages(input,checkManagement);
        checkManagement();return json(res,200,{ok:true,...value});
      }
      if(sub==='/legacy-import'&&['GET','POST'].includes(req.method)){
        if(typeof controls?.manageLegacyImport!=='function')return json(res,404,{ok:false,error:'当前入口尚未接通旧记忆迁移'});
        const validId=value=>typeof value==='string'&&value.length>0&&value.length<=512;
        let input;
        if(req.method==='GET'){
          const action=url.searchParams.get('action')??'status';
          if(!['status','pending','migrated'].includes(action))throw Error('未知旧记忆迁移读取操作');
          input={action,...(action==='migrated'?{afterId:url.searchParams.get('afterId')??''}:{})};
        }else{
          const value=await body(req);
          if(value?.action==='start'||value?.action==='pause'||value?.action==='resume')input={action:value.action};
          else if(value?.action==='decide'){
            const all=value.all===true;
            if(!all&&!validId(value.id))throw Error('请选择待确认的旧记忆');
            if(!['write','skip'].includes(value.decision))throw Error('请选择写入或不迁移');
            if(value.changes!==undefined&&(!value.changes||typeof value.changes!=='object'||Array.isArray(value.changes)))throw Error('待确认分类无效');
            input={action:'decide',all,id:value.id,decision:value.decision,changes:value.changes};
          }else if(value?.action==='edit'){
            if(!validId(value.id)||!validId(value.revision))throw Error('请选择当前迁移条目');
            const fields={};for(const key of ['type','validity','progress','importance'])if(value[key]!==undefined){
              if(typeof value[key]!=='string'||!value[key])throw Error('迁移条目分类无效');
              fields[key]=value[key];
            }
            input={action:'edit',id:value.id,revision:value.revision,...fields};
          }else throw Error('未知旧记忆迁移操作');
        }
        const result=await controls.manageLegacyImport(input,checkManagement);
        checkManagement();return json(res,200,{ok:true,...result});
      }
      if(sub==='/runtime'&&['GET','POST'].includes(req.method)){
        // These callbacks are the portable host's authority. Reading status must
        // not acquire a model; actions retain its authorization/foreground gates.
        if(req.method==='GET'){
          if(typeof controls?.getMemoryRuntime!=='function')return json(res,404,{ok:false,error:'当前入口尚未接入记忆运行管理'});
          return json(res,200,{ok:true,...await controls.getMemoryRuntime()});
        }
        const input=await body(req);
        if(!input||Array.isArray(input)||!['load','release','prepare','resume-prepare','cancel','resume','flush','retry','legacy-recover','plan','switch','cancel-switch','drop-index','probe','resume-rerank'].includes(input.action))throw Error('未知记忆运行操作');
        const operation={action:input.action};
        if(input.cloudConfirmed!==undefined){if(typeof input.cloudConfirmed!=='boolean')throw Error('云端确认无效');operation.cloudConfirmed=input.cloudConfirmed;}
        if(input.action==='legacy-recover'){
          if(typeof input.sessionId!=='string'||input.sessionId.length>512||!/^session-[a-zA-Z0-9_-]+$/.test(input.sessionId))throw Error('请选择旧任务原会话');
          operation.sessionId=input.sessionId;
        }
        if(input.action==='resume-prepare'){
          if(typeof input.intentId!=='string'||!input.intentId||input.intentId.length>512)throw Error('请选择原索引准备任务');
          operation.intentId=input.intentId;
        }
        for(const key of ['batchId','profileId'])if(input[key]!==undefined){
          if(typeof input[key]!=='string'||!input[key].trim()||input[key].length>512)throw Error('运行操作目标无效');
          operation[key]=input[key];
        }
        if(input.profileRevision!==undefined){
          if(!(typeof input.profileRevision==='string'&&input.profileRevision.length>0&&input.profileRevision.length<=512)&&!(Number.isSafeInteger(input.profileRevision)&&input.profileRevision>=0))throw Error('运行操作版本无效');
          operation.profileRevision=input.profileRevision;
        }
        if(typeof controls?.runMemoryRuntime!=='function')return json(res,404,{ok:false,error:'当前入口尚未接入记忆运行操作'});
        const value=await controls.runMemoryRuntime(operation);
        return json(res,value?.started?202:200,{ok:true,...value});
      }
      if(sub==='/handoff'&&['GET','POST'].includes(req.method)){
        if(!controls?.getHandoffState)return json(res,404,{ok:false,error:'当前入口尚未接通短期接续设置'});
        let saved;
        if(req.method==='POST'){
          const input=await body(req);
          saved=await stageDeploymentHandoff(configurationFile,input.tokens,input.revision,controls.afterHandoffSave);
        }else{
          const {cfg,revision}=await readDeploymentModelConfiguration(configurationFile);
          saved={tokens:normalizeHandoffTokens(cfg.memory?.handoffTokens??MEMORY_HANDOFF_DEFAULTS.tokens),revision};
        }
        return json(res,200,{ok:true,...saved,...await controls.getHandoffState(),presets:MEMORY_HANDOFF_DEFAULTS.presets,maxTokens:MEMORY_HANDOFF_DEFAULTS.maxTokens});
      }
      if(req.method==='POST'&&sub==='/time-zone'){
        const input=await body(req);
        if(typeof input?.timeZone!=='string')return json(res,400,{ok:false,error:'请输入有效的时区设置'});
        return json(res,200,{ok:true,activeTimeZone:personalTimeZone(),...await stageDeploymentTimeZone(configurationFile,input.timeZone,input.revision)});
      }
      if(req.method==='GET'&&sub==='/session-memory'){
        if(!controls?.sessionMemory)return json(res,404,{ok:false,error:'当前入口尚未启用对话记忆开关'});
        return json(res,200,{ok:true,...controls.sessionMemory.status(url.searchParams.get('sessionId'))});
      }
      if(req.method==='POST'&&sub==='/session-default'){
        if(!controls?.sessionMemory||typeof controls.afterSessionDefaultSave!=='function')return json(res,404,{ok:false,error:'当前入口尚未启用对话记忆开关'});
        const input=await body(req);
        await stageDeploymentSessionDefault(configurationFile,input.enabled,input.revision,controls.afterSessionDefaultSave);
        return json(res,200,{ok:true,...await sessionReceipt(await readDeploymentSettings(configurationFile))});
      }
      if(req.method==='GET'&&sub==='/model-install')return json(res,200,{ok:true,job:installer.status()});
      if(req.method==='POST'&&sub==='/model-install'){
        if(!controls)throw Error('当前安装尚不支持模型准备');
        const input=await body(req);
        if(input.action==='cancel')return json(res,200,{ok:true,job:installer.cancel(input.id)});
        if(typeof input.revision!=='string'||!input.revision)throw Error('需要有效的配置版本');
        if(input.action==='inventory')return json(res,200,{ok:true,inventory:await installer.inventory(input)});
        if(input.action==='plan')return json(res,200,{ok:true,plan:await installer.plan(input)});
        if(input.action==='start')return json(res,202,{ok:true,job:await installer.start(input)});
        throw Error('未知模型准备操作');
      }
      if(req.method==='GET'&&sub==='/sessions')return json(res,200,{ok:true,...await sessionReceipt(await readDeploymentSettings(configurationFile))});
      if(req.method==='POST'&&sub==='/sessions'){
        const input=await body(req);if(!['bind','unbind','replace'].includes(input.action)||!(typeof input.value==='string'||(input.action==='replace'&&Array.isArray(input.value)))||typeof input.revision!=='string')return json(res,400,{ok:false,error:'请选择有效的会话'});
        return json(res,200,{ok:true,...await sessionReceipt(await updateDeploymentSession(configurationFile,{action:input.action,value:input.value},input.revision,afterSessionsSaved))});
      }
      if(req.method==='POST'&&sub==='/flags'){
        if(!controls)throw Error('当前安装尚不支持记忆功能设置');const input=await body(req);
        return json(res,200,{ok:true,...await stageDeploymentFlags(configurationFile,input.flags,input.revision,controls.afterSave)});
      }
      if(req.method==='POST'&&sub==='/model'){
        if(!controls)throw Error('当前安装尚不支持原句检索模型设置');
        const input=await body(req);
        return json(res,200,{ok:true,...await stageDeploymentRawModel(configurationFile,input,input.revision,controls.afterSave)});
      }
      if(req.method==='POST'&&sub==='/embedding-services'){
        const input=await body(req);
        return json(res,200,{ok:true,...await manageEmbeddingServices(configurationFile,input,input?.revision,controls?.afterSave)});
      }
      if(req.method==='POST'&&sub==='/test'){
        // One paid probe at a time; a second click while waiting is refused, not queued.
        const input=await body(req);
        if(testing)return json(res,429,{ok:false,error:'上一次测试还没结束'});
        testing=true;
        try{return json(res,200,{ok:true,result:await testDeploymentConnection(configurationFile,input)});}
        finally{testing=false;}
      }
      if(req.method==='POST'&&sub==='/rerank'){
        const input=await body(req);
        return json(res,200,{ok:true,...await stageDeploymentRerank(configurationFile,input,input?.revision)});
      }
      if(req.method==='POST'&&sub==='/libraries'){
        const input=await body(req);if(!['create','select'].includes(input.action)||typeof input.directory!=='string'||typeof input.revision!=='string'||!input.revision)return json(res,400,{ok:false,error:'请输入记忆库的完整路径'});
        if(input.action==='create')return json(res,200,{ok:true,...await createDeploymentLibrary(configurationFile,input.directory,input.revision)});
        // The deployment file has its own lock; the QQ-era configuration reservation is gone.
        if(!controls)throw Error('当前安装尚不支持记忆库选择');
        return json(res,200,{ok:true,...await stageDeploymentLibrary(configurationFile,input.directory,input.revision,controls.afterSave)});
      }
      return json(res,404,{ok:false,error:'未找到设置'});
    }catch(error){
      const syncing=error.code==='MEMORY_NOTE_SYNC_PENDING';
      return json(res,syncing||['REVISION_CONFLICT','MEMORY_REVISION_CONFLICT'].includes(error.code)?409:400,
        {ok:false,error:syncing?'文件正在同步，请刷新后再审核。':String(error.message??'设置读取失败')});
    }
  };
  handler.dispose=()=>installer.dispose();return handler;
}
export function registerSettingsRoutes(ctx,configurationFile,afterSessionsSaved,getRuntimeStatus,controls){
  if(!configurationFile||typeof ctx.inject!=='function')return;
  ctx.inject(['webServer'],child=>child.effect(()=>{
    const handler=createSettingsHandler(child,configurationFile,afterSessionsSaved,getRuntimeStatus,controls);
    const unregister=child.webServer.register({kind:'prefix',path:base,handler});
    return async()=>{await handler.dispose();if(typeof unregister==='function')return unregister();};
  },'basic-memory: settings routes'));
}

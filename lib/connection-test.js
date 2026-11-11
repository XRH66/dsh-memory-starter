import fs from 'node:fs/promises';
import {embeddingEndpoint,rawModelSpec} from './raw-rag/models.js';
import {requestEmbeddingService} from './raw-rag/embedding-http.js';
import {requestRerank,rerankServiceUrl} from './raw-rag/rerank-http.js';

// One small request with the saved or typed settings, so a wrong key or address shows up
// before saving and restarting. Keys stay in this process; only the outcome is returned.
const TEST_TIMEOUT_MS=10000;
const failure=(code,message,hint,extra={})=>Object.assign(Error(message),{testFailure:{code,message,hint,...extra}});
const services=cfg=>Array.isArray(cfg.embeddingServices)?cfg.embeddingServices:[];
const text=value=>typeof value==='string'?value.trim():'';
const sameUrl=(a,b,normalize)=>{try{return normalize(a)===normalize(b);}catch{return false;}};
const loopback=value=>{try{return ['localhost','127.0.0.1','::1'].includes(new URL(value).hostname.replace(/^\[|\]$/g,''));}catch{return false;}};

async function readKey(file){
  if(!file)return '';
  try{return (await fs.readFile(file,'utf8')).trim();}
  catch{throw failure('key-missing','读不到已保存的 API Key','重新填写 API Key 后再测试');}
}
function typedKey(value){
  const key=value===undefined?'':String(value).trim();
  if(key.length>8192||/[\r\n\u0000]/.test(key))throw failure('key-invalid','API Key 格式不对','检查是否多复制了空格或换行');
  return key;
}

/** The embedding settings to try: a saved service, or the model form as typed. */
async function embeddingTarget(cfg,input){
  if(input.serviceId!==undefined){
    const service=services(cfg).find(item=>item.id===input.serviceId);
    if(!service)throw failure('service-missing','这个服务已不存在','刷新页面后再试');
    const key=typedKey(input.apiKey)||await readKey(service.apiKeyFile);
    return {config:{rawRecallModel:'custom-api',rawRecallApiBase:service.apiBase,rawRecallApiModel:service.apiModel,rawRecallDimensions:service.dimensions},key};
  }
  const model=text(input.model);
  const saved=[cfg.pendingRawRecall,cfg.memory].find(row=>row&&text(row.rawRecallModel)===model);
  const config={rawRecallModel:model,rawRecallApiBase:input.apiBase??saved?.rawRecallApiBase,rawRecallApiModel:input.apiModel??saved?.rawRecallApiModel,
    rawRecallDimensions:input.dimensions??saved?.rawRecallDimensions};
  let spec;
  try{spec=rawModelSpec(config);}catch(error){throw failure('settings',String(error.message||'设置不完整'),'补全地址、模型名和维数后再测试');}
  if(spec.engine!=='api')throw failure('settings','这个模型在本机运行','本机模型请在「状态」页试算');
  let key=typedKey(input.apiKey);
  // A saved key is reused only for the same address and model it was saved with.
  if(!key&&saved&&sameUrl(saved.rawRecallApiBase,config.rawRecallApiBase,embeddingEndpoint)&&text(saved.rawRecallApiModel)===text(config.rawRecallApiModel))
    key=saved.rawRecallApiKeyFile?await readKey(saved.rawRecallApiKeyFile):String(process.env[saved.rawRecallApiKeyEnv??'DASHSCOPE_API_KEY']||'').trim();
  return {config,key};
}

async function rerankTarget(cfg,input){
  const model=text(input.model);
  if(!model||model.length>120)throw failure('settings','请填写重排模型','填写服务商文档里的重排模型名');
  if(input.source==='service'){
    const service=services(cfg).find(item=>item.id===input.serviceId);
    if(!service)throw failure('service-missing','请选择一个已保存的服务','先在「向量」里保存带 API Key 的服务');
    return {baseUrl:service.apiBase,model,key:await readKey(service.apiKeyFile)};
  }
  const baseUrl=text(input.apiBase);
  try{rerankServiceUrl(baseUrl);}catch{throw failure('address','地址格式不对','需为 HTTPS，或本机 http://127.0.0.1:端口/v1');}
  const memory=cfg.memory??{};
  let key=typedKey(input.apiKey);
  if(!key&&memory.memoryRerankSource==='direct'&&sameUrl(memory.memoryRerankApiBase,baseUrl,rerankServiceUrl))key=await readKey(memory.memoryRerankApiKeyFile);
  if(!key&&!loopback(baseUrl))throw failure('key-missing','还没有 API Key','填写 API Key 后再测试');
  return {baseUrl,model,key};
}

/** Turns a request error into one plain sentence and what to do next. */
export function describeConnectionFailure(error,{httpStatus,timedOut}={}){
  if(error?.testFailure)return error.testFailure;
  const status=httpStatus??error?.httpStatus;
  if(timedOut)return {code:'timeout',message:'10 秒内没有响应',hint:'检查地址是否正确，或稍后再试'};
  if(status===401||status===403)return {code:'key',message:'API Key 无效或没有权限',hint:'重新填写 API Key 后再测试',httpStatus:status};
  if(status===404)return {code:'not-found',message:'地址或模型名不对',hint:'地址填到 /v1 为止，并核对模型名',httpStatus:status};
  if(status===400||status===422)return {code:'rejected',message:'服务拒绝了这个请求',hint:'多半是模型名不对，或这个模型不支持这种用途',httpStatus:status};
  if(status===429)return {code:'rate',message:'请求太频繁或额度不足',hint:'稍后再试，或检查账户余额',httpStatus:status};
  if(status>=500)return {code:'server',message:'服务商暂时出错（HTTP '+status+'）',hint:'稍后再试',httpStatus:status};
  if(status)return {code:'http',message:'服务返回 HTTP '+status,hint:'核对地址和模型名',httpStatus:status};
  const cause=String(error?.cause?.code??error?.code??'');
  if(/CERT|SSL|TLS/i.test(cause))return {code:'certificate',message:'这个地址的证书有问题',hint:'检查地址是否正确'};
  if(error?.name==='TypeError'||/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(cause))
    return {code:'network',message:'连不上这个地址',hint:'检查地址拼写和网络'};
  return {code:'invalid',message:'服务的返回格式不对',hint:'确认它兼容 OpenAI 接口'};
}

/** input.target is 'embedding' or 'rerank'. Resolves to {ok,ms,...} or {ok:false,error}. */
export async function testConnection(cfg,input,{fetchImpl=fetch,timeoutMs=TEST_TIMEOUT_MS,now=Date.now}={}){
  if(!input||typeof input!=='object'||!['embedding','rerank'].includes(input.target))throw Error('未知的测试对象');
  const timer=AbortSignal.timeout(timeoutMs);let httpStatus,lastBody;
  // Keep the status and body so a failure can say which part was wrong.
  const fetchWithReceipt=async(url,options)=>{
    const response=await fetchImpl(url,options);httpStatus=response.status;
    try{lastBody=response.clone?await response.clone().json():undefined;}catch{lastBody=undefined;}
    return response;
  };
  const started=now();
  try{
    if(input.target==='embedding'){
      const {config,key}=await embeddingTarget(cfg,input);
      if(!key)throw failure('key-missing','还没有 API Key','填写 API Key 后再测试');
      const spec=rawModelSpec(config);let baseUrl;
      try{baseUrl=embeddingEndpoint(config.rawRecallApiBase);}catch{throw failure('address','地址格式不对','需为 HTTPS，填到 /v1 为止');}
      try{
        const [vector]=await requestEmbeddingService({baseUrl,model:spec.apiModel||spec.id,texts:['连接测试'],dimensions:spec.dimensions,
          sendDimensions:!spec.custom,apiKey:key,kind:'query',signal:timer,fetchImpl:fetchWithReceipt});
        return {ok:true,target:'embedding',ms:Math.max(0,now()-started),dimensions:vector.length,host:new URL(baseUrl).hostname};
      }catch(error){
        const returned=lastBody?.data?.[0]?.embedding?.length;
        if(httpStatus>=200&&httpStatus<300&&Number.isInteger(returned)&&returned!==spec.dimensions)
          throw failure('dimensions','返回 '+returned+' 维，设置的是 '+spec.dimensions+' 维','把向量维数改成 '+returned,{dimensions:returned});
        throw error;
      }
    }
    const {baseUrl,model,key}=await rerankTarget(cfg,input);
    const result=await requestRerank({baseUrl,model,query:'连接测试',documents:['这是一条连接测试','今天天气不错'],apiKey:key,signal:timer,fetchImpl:fetchWithReceipt});
    if(!Array.isArray(result)||!result.length)throw failure('invalid','服务的返回格式不对','确认它兼容 /rerank 接口');
    return {ok:true,target:'rerank',ms:Math.max(0,now()-started),host:new URL(rerankServiceUrl(baseUrl)).hostname};
  }catch(error){
    return {ok:false,target:input.target,ms:Math.max(0,now()-started),error:describeConnectionFailure(error,{httpStatus,timedOut:timer.aborted})};
  }
}

export async function testDeploymentConnection(file,input,options){
  const cfg=JSON.parse(await fs.readFile(file,'utf8'));
  return testConnection(cfg,input,options);
}

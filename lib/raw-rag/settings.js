import path from 'node:path';
import { resolveConfig } from '../config.js';
import { rawModelSpec, rawModelOptions, embeddingEndpoint } from './models.js';

export const RAW_MODEL_FIELDS = Object.freeze([
  'rawRecallModel', 'rawRecallDimensions', 'rawRecallPython', 'rawRecallCacheDir', 'rawRecallBgeModelDir',
  'rawRecallOnnxModel', 'rawRecallOnnxTokenizer', 'rawRecallGgufModel', 'rawRecallLlamaServer',
  'rawRecallDevice', 'rawRecallLlamaCpuServer', 'rawRecallLlamaCudaServer', 'rawRecallCpuThreads', 'rawRecallGpuThreads',
  'rawRecallThreads', 'rawRecallTimeoutMs', 'rawRecallMaxTokens', 'rawRecallQueryInstruction', 'rawRecallPrepareTimeoutMs', 'rawRecallIndexTimeoutMs',
  'rawRecallLlamaContext', 'rawRecallLlamaGpuLayers', 'rawRecallAllowCloud', 'rawRecallApiBase', 'rawRecallApiKeyEnv', 'rawRecallApiRevision',
  'rawRecallInstallReceipt',
  'rawRecallApiKeyService',
  'rawRecallIdleMs',
]);

export function publicRawModel(memory = {}) {
  const config = resolveConfig(memory);
  const fields = Object.fromEntries(RAW_MODEL_FIELDS.map(key => [key, config[key]]));
  let error = null;
  try { fields.rawRecallModel = rawModelSpec(config).id; } catch (cause) { error = cause.message; }
  return { fields, hasSavedApiKey: Boolean(config.rawRecallApiKeyFile), error };
}

export function rawModelSettings(cfg) {
  return { rawModel: publicRawModel(cfg.memory), pendingRawModel: cfg.pendingRawRecall ? publicRawModel(cfg.pendingRawRecall) : null,
    rawModels: rawModelOptions };
}

export function normalizeRawModelSettings(input, base = {}, {apiKeyProvided=false,reuseApiKey=false}={}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请选择有效的原句检索模型');
  if (!base || typeof base !== 'object' || Array.isArray(base)) throw new Error('当前记忆配置无效');
  const defaults = resolveConfig(base), given = {};
  for (const key of RAW_MODEL_FIELDS) if (Object.hasOwn(input, key)) {
    if (typeof input[key] !== typeof defaults[key]) throw new Error('原句检索模型参数格式无效：' + key);
    given[key] = input[key];
  }
  const config = resolveConfig({ ...base, ...given });
  if (Object.hasOwn(given, 'rawRecallDevice') && !['auto', 'cpu', 'cuda'].includes(given.rawRecallDevice)) throw new Error('运行设备应为 auto、cpu 或 cuda');
  for (const [key, value] of Object.entries(given)) if (typeof value === 'number' && config[key] !== value) throw new Error('原句检索模型参数超出范围：' + key);
  const spec = rawModelSpec(config);
  const fields = Object.fromEntries(RAW_MODEL_FIELDS.map(key => [key, config[key]]));
  fields.rawRecallModel = spec.id;
  if (spec.engine !== 'api') fields.rawRecallAllowCloud = false;
  for (const key of ['rawRecallCacheDir', 'rawRecallBgeModelDir', 'rawRecallOnnxModel', 'rawRecallOnnxTokenizer', 'rawRecallGgufModel', 'rawRecallLlamaServer', 'rawRecallLlamaCpuServer', 'rawRecallLlamaCudaServer']) {
    if (fields[key] && !path.isAbsolute(fields[key])) throw new Error('请填写完整的本地文件或目录路径');
  }
  if (spec.engine === 'onnx' && (!fields.rawRecallOnnxModel || !fields.rawRecallOnnxTokenizer)) throw new Error('请填写 0.6B 模型文件和 tokenizer.json 路径');
  if (spec.engine === 'llamacpp') {
    if (!fields.rawRecallGgufModel || !(fields.rawRecallLlamaServer || fields.rawRecallLlamaCpuServer || fields.rawRecallLlamaCudaServer)) throw new Error('请填写 GGUF 模型与 llama-server 程序路径');
    if (fields.rawRecallMaxTokens >= fields.rawRecallLlamaContext) throw new Error('单条向量输入上限需小于本地模型上下文');
  }
  if (spec.engine !== 'llamacpp' && spec.engine !== 'api' && fields.rawRecallDevice === 'cuda') throw new Error('当前本地后端尚未支持 CUDA 运行设备');
  if (spec.engine === 'api') {
    embeddingEndpoint(fields.rawRecallApiBase);
    if (!fields.rawRecallAllowCloud) throw new Error('选择云端模型时，需要确认使用云端检索');
    if (fields.rawRecallApiKeyEnv&&!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(fields.rawRecallApiKeyEnv)) throw new Error('API Key 环境变量名称无效');
  }
  // The UI never receives or chooses the secret-file path. A changed env name
  // selects that reference instead of leaving an old file to shadow it.
  fields.rawRecallApiKeyFile=defaults.rawRecallApiKeyFile;
  fields.rawRecallApiKeyService=defaults.rawRecallApiKeyService;
  if(spec.engine==='api'){
    const endpoint=embeddingEndpoint(fields.rawRecallApiBase);
    const previousService=defaults.rawRecallApiKeyService||embeddingEndpoint(defaults.rawRecallApiBase);
    const newEnvironment=fields.rawRecallApiKeyEnv&&fields.rawRecallApiKeyEnv!==defaults.rawRecallApiKeyEnv;
    if(apiKeyProvided||newEnvironment){
      fields.rawRecallApiKeyFile='';
      if(apiKeyProvided)fields.rawRecallApiKeyEnv='';
    }else if(endpoint!==previousService&&!reuseApiKey){
      throw Error('API 服务地址已改变，请填写新密钥、选择新的环境变量，或明确复用现有凭据');
    }
    fields.rawRecallApiKeyService=endpoint;
  }else{
    // Switching to a local model does not silently reassign dormant API keys.
    fields.rawRecallApiBase=defaults.rawRecallApiBase;
    fields.rawRecallApiKeyEnv=defaults.rawRecallApiKeyEnv;
  }
  return fields;
}

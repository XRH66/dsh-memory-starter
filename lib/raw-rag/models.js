import { createHash } from 'node:crypto';
import { embeddingServiceUrl } from './embedding-http.js';

export const RAW_WINDOW_CHARS = 600;
export const QWEN_QUERY_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query';

// Exact aliases only: 4B/8B/cloud identifiers must never silently select 0.6B.
const MODELS = [
  { id: 'BAAI/bge-small-zh-v1.5', aliases: ['bge-small-zh-v1.5', 'light'], label: 'BGE-small-zh-v1.5 · 轻量', tier: 'light', engine: 'fastembed', dimensions: 512, format: 'onnx', batch: 4, maxTokens: 512 },
  { id: 'Qwen/Qwen3-Embedding-0.6B', aliases: ['qwen3-embedding-0.6b', 'balanced'], label: 'Qwen3-Embedding-0.6B · 均衡', tier: 'balanced', engine: 'onnx', dimensions: 1024, format: 'onnx-int8', batch: 1 },
  { id: 'Qwen/Qwen3-Embedding-4B', aliases: ['qwen3-embedding-4b', 'quality'], label: 'Qwen3-Embedding-4B · 高质量', tier: 'quality', engine: 'llamacpp', dimensions: 2560, format: 'gguf', batch: 1 },
  { id: 'Qwen/Qwen3-Embedding-8B', aliases: ['qwen3-embedding-8b'], label: 'Qwen3-Embedding-8B · 高级', tier: 'advanced', engine: 'llamacpp', dimensions: 4096, format: 'gguf', batch: 1 },
  { id: 'qwen3.7-text-embedding', aliases: [], label: 'qwen3.7-text-embedding · 标准版', tier: 'cloud', engine: 'api', dimensions: 2560, allowedDimensions: [256, 512, 768, 1024, 1536, 2048, 2560], format: 'service', batch: 4, maxTokens: 128000 },
  { id: 'qwen3.7-text-embedding-flash', aliases: [], label: 'qwen3.7-text-embedding-flash', tier: 'cloud', engine: 'api', dimensions: 1024, allowedDimensions: [256, 512, 768, 1024], format: 'service', batch: 4, maxTokens: 128000 },
  { id: 'text-embedding-v4', aliases: [], label: '云端 text-embedding-v4', tier: 'cloud', engine: 'api', dimensions: 1024, allowedDimensions: [64, 128, 256, 512, 768, 1024, 1536, 2048], format: 'service', batch: 4, maxTokens: 8192 },
];

export const rawModelOptions = Object.freeze(MODELS.map(({ id, label, tier, engine, dimensions, allowedDimensions }) =>
  Object.freeze({ id, label, task: 'embedding', tier, engine, dimensions, allowedDimensions: allowedDimensions || [dimensions], cloud: engine === 'api' })));

export function rawModelSpec(config = {}) {
  const name = String(config.rawRecallModel || MODELS[0].id).trim().toLowerCase();
  const definition = MODELS.find(model => [model.id, ...model.aliases].some(alias => alias.toLowerCase() === name));
  if (!definition) throw new Error('Unsupported raw embedding model: ' + name);
  const dimensions = Number(config.rawRecallDimensions) || definition.dimensions;
  if (!(definition.allowedDimensions || [definition.dimensions]).includes(dimensions)) throw new Error('Unsupported embedding dimensions for ' + definition.id);
  const family = definition.id.startsWith('Qwen/') ? 'qwen3-embedding' : definition.id.startsWith('BAAI/') ? 'bge-v15' : 'provider-embedding';
  return Object.freeze({ ...definition, task: 'embedding', family, dimensions,
    pooling: family === 'qwen3-embedding' ? 'last-token' : family === 'bge-v15' ? 'cls' : 'provider',
    maxTokens: definition.maxTokens || config.rawRecallMaxTokens || 2048,
    queryInstruction: family === 'qwen3-embedding' ? (config.rawRecallQueryInstruction || QWEN_QUERY_INSTRUCTION) : '',
  });
}

export function formatEmbeddingInput(spec, text, kind) {
  if (!['query', 'document'].includes(kind)) throw new Error('Unknown embedding input kind');
  return kind === 'query' && spec.family === 'qwen3-embedding'
    ? 'Instruct: ' + spec.queryInstruction + '\nQuery: ' + text : text;
}

export function embeddingEndpoint(value = 'https://dashscope.aliyuncs.com/compatible-mode/v1') {
  return embeddingServiceUrl(value, { allowLocal: false });
}

// Bind credentials to the canonical endpoint, including tenant/gateway paths.
// Existing unbound configurations remain usable at their original address;
// settings changes adopt this binding before they can become active.
export function embeddingCredentialEndpoint(config) {
  const endpoint=embeddingEndpoint(config.rawRecallApiBase);
  if(config.rawRecallApiKeyService&&config.rawRecallApiKeyService!==endpoint)
    throw Error('API 地址与密钥凭据绑定不一致，请重新配置该服务的密钥');
  return endpoint;
}

export function modelContract(spec, config = {}) {
  return { schema: 2, model: spec.id, engine: spec.engine, dimensions: spec.dimensions, format: spec.format,
    query: formatEmbeddingInput(spec, '', 'query') || 'plain-text',
    task: 'embedding', family: spec.family, document: 'plain-text', pooling: spec.pooling,
    normalization: 'l2', maxTokens: spec.maxTokens, windowing: 'token-bounded-chunks-v2:' + RAW_WINDOW_CHARS,
    tokenCounting: spec.engine === 'api' ? 'utf8-byte-upper-bound-plus-16' : 'model-tokenizer-with-special-tokens',
    ...(spec.engine === 'api' ? { endpoint: embeddingEndpoint(config.rawRecallApiBase) } : {}),
  };
}

export const identityDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function modelIdentity(contract, assets, runtime) {
  const descriptor = { ...contract, assets, runtime };
  return { modelKey: 'raw-v' + contract.schema + ':' + contract.model + ':' + identityDigest(descriptor), descriptor, dimensions: contract.dimensions };
}

/** Device policy is not an encoding contract. Keep the legacy server path as a
 * usable CPU target, and only infer legacy CUDA when GPU layers were selected.
 * Other models retain their existing four-thread CPU default. */
export function llamaRuntimeSettings(spec, config = {}) {
  const requestedDevice = config.rawRecallDevice || 'auto';
  if (!['auto', 'cpu', 'cuda'].includes(requestedDevice)) throw new Error('Unsupported embedding device');
  const fourB = spec.id === 'Qwen/Qwen3-Embedding-4B';
  const legacy = config.rawRecallLlamaServer || '';
  const cudaServer = config.rawRecallLlamaCudaServer || ((requestedDevice === 'cuda' || config.rawRecallLlamaGpuLayers) ? legacy : '');
  const cpuServer = config.rawRecallLlamaCpuServer || legacy || config.rawRecallLlamaCudaServer || '';
  const useCuda = requestedDevice === 'cuda' || requestedDevice === 'auto' && (fourB || Boolean(cudaServer));
  return { requestedDevice, initialDevice: useCuda ? 'cuda' : 'cpu', cpuServer, cudaServer,
    cpuThreads: fourB ? (config.rawRecallCpuThreads || 6) : (config.rawRecallThreads || 4),
    gpuThreads: config.rawRecallGpuThreads || 4,
    gpuLayers: config.rawRecallLlamaGpuLayers || 99 };
}

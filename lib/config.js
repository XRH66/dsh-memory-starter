import z from '@deepseek-ai/schemastery';
import { processingTargetMode } from './processing-model.js';
import { resolvePersonalTimeZone } from './personal-namespace.js';

/** Hard product limits from the v0.1 specification. */
export const HARD_MAX_RAW_RECALL_CHARS = 1200;
export const HARD_MAX_RAW_RECALL_TIMEOUT_MS = 10000;

export const DEFAULT_CONFIG = Object.freeze({
  project: 'personal',
  timeZone: '',
  autoRecall: true,
  prefetchMaxChars: 1200,
  autoCapture: true,
  recentContext: true,
  recentContextTokens: 16384,
  handoffTokens: 4096,
  maxIndexChars: 600,
  maxTimelineChars: 500,
  organizerReasoningEffort: 'low',
  captureFolder: 'chats',
  maxAutomaticFailures: 3,
  captureTargetMode: '',
  captureProvider: '',
  captureModel: '',
  vaultPath: '',
  softenFactor: 0.5,
  halfLifeDays: 30,
  priorityFloor: 0.01,
  // Stage A local original-turn recall. Disabled unless the user explicitly
  // turns it on; model assets are never bundled with the package.
  rawRecall: false,
  rawRecallModel: 'BAAI/bge-small-zh-v1.5',
  rawRecallPython: 'python',
  rawRecallCacheDir: '',
  rawRecallOnnxModel: '',
  rawRecallOnnxTokenizer: '',
  rawRecallBgeModelDir: '',
  rawRecallDimensions: 0,
  rawRecallThreads: 4,
  rawRecallDevice: 'auto',
  rawRecallCpuThreads: 6,
  rawRecallGpuThreads: 4,
  rawRecallIdleMs: 0,
  rawRecallResidentHours: '',
  rawRecallMaxTokens: 2048,
  rawRecallQueryInstruction: '',
  rawRecallPrepareTimeoutMs: 120000,
  rawRecallIndexTimeoutMs: 30000,
  rawRecallGgufModel: '',
  rawRecallLlamaServer: '',
  rawRecallLlamaCpuServer: '',
  rawRecallLlamaCudaServer: '',
  rawRecallLlamaContext: 4096,
  rawRecallLlamaGpuLayers: 0,
  rawRecallAllowCloud: false,
  rawRecallApiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  rawRecallApiKeyEnv: 'DASHSCOPE_API_KEY',
  rawRecallApiKeyFile: '',
  rawRecallApiKeyService: '',
  rawRecallInstallReceipt: '',
  rawRecallApiRevision: '',
  rawRecallDbPath: '',
  rawRecallMaxChars: 600,
  rawRecallTimeoutMs: 2500,
  rawRecallQueryWaitMs: 0,
  rawRecallMinScore: null,
  rawRecallCandidates: 40,
  rawRecallTop: 10,
});

/** Schemastery schema used by the DSH plugin loader. */
const ConfigObject = z.object({
  project: z.string().default('personal'),
  timeZone: z.string().default(''),
  autoRecall: z.boolean().default(true),
  prefetchMaxChars: z.number().min(0).max(4000).default(1200),
  autoCapture: z.boolean().default(true),
  recentContext: z.boolean().default(true),
  recentContextTokens: z.number().min(1024).max(131072).default(16384),
  handoffTokens: z.number().min(1).max(16384).default(4096),
  maxIndexChars: z.number().min(200).max(900).default(600),
  maxTimelineChars: z.number().min(200).max(800).default(500),
  organizerReasoningEffort: z.union([z.string(), null]),
  captureFolder: z.string().default('chats'),
  maxAutomaticFailures: z.number().min(1).max(10).default(3),
  captureTargetMode: z.string().default(''),
  captureProvider: z.string().default(''),
  captureModel: z.string().default(''),
  vaultPath: z.string().default(''),
  softenFactor: z.number().min(0.05).max(0.95).default(0.5),
  halfLifeDays: z.number().min(1).max(3650).default(30),
  priorityFloor: z.number().min(0.000001).max(0.5).default(0.01),
  rawRecall: z.boolean().default(false),
  rawRecallModel: z.string().default('BAAI/bge-small-zh-v1.5'),
  rawRecallPython: z.string().default('python'),
  rawRecallCacheDir: z.string().default(''),
  rawRecallOnnxModel: z.string().default(''),
  rawRecallOnnxTokenizer: z.string().default(''),
  rawRecallBgeModelDir: z.string().default(''),
  rawRecallDimensions: z.number().min(0).max(4096).default(0),
  rawRecallThreads: z.number().min(1).max(32).default(4),
  rawRecallDevice: z.union(['auto', 'cpu', 'cuda']).default('auto'),
  rawRecallCpuThreads: z.number().min(1).max(32).default(6),
  rawRecallGpuThreads: z.number().min(1).max(32).default(4),
  rawRecallIdleMs: z.number().min(0).max(3600000).default(0),
  rawRecallResidentHours: z.string().default(''),
  rawRecallMaxTokens: z.number().min(128).max(8192).default(2048),
  rawRecallQueryInstruction: z.string().default(''),
  rawRecallPrepareTimeoutMs: z.number().min(1000).max(300000).default(120000),
  rawRecallIndexTimeoutMs: z.number().min(1000).max(300000).default(30000),
  rawRecallGgufModel: z.string().default(''),
  rawRecallLlamaServer: z.string().default(''),
  rawRecallLlamaCpuServer: z.string().default(''),
  rawRecallLlamaCudaServer: z.string().default(''),
  rawRecallLlamaContext: z.number().min(512).max(32768).default(4096),
  rawRecallLlamaGpuLayers: z.number().min(-1).max(128).default(0),
  rawRecallAllowCloud: z.boolean().default(false),
  rawRecallApiBase: z.string().default('https://dashscope.aliyuncs.com/compatible-mode/v1'),
  rawRecallApiKeyEnv: z.string().default('DASHSCOPE_API_KEY'),
  rawRecallApiKeyFile: z.string().default(''),
  rawRecallApiKeyService: z.string().default(''),
  rawRecallInstallReceipt: z.string().default(''),
  rawRecallApiRevision: z.string().default(''),
  rawRecallDbPath: z.string().default(''),
  rawRecallMaxChars: z.number().min(120).max(HARD_MAX_RAW_RECALL_CHARS).default(600),
  rawRecallTimeoutMs: z.number().min(100).max(HARD_MAX_RAW_RECALL_TIMEOUT_MS).default(2500),
  rawRecallQueryWaitMs: z.union([z.number().min(1000).max(10000), 0]).default(0),
  rawRecallMinScore: z.union([z.number().min(0).max(1), null]).default(null),
  rawRecallCandidates: z.number().min(1).max(40).default(40),
  rawRecallTop: z.number().min(1).max(12).default(10),
});

export const Config = z.intersect([
  ConfigObject,
  z.object({ organizerReasoningEffort: z.string().default(DEFAULT_CONFIG.organizerReasoningEffort) }),
]);

function integerInRange(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function numberInRange(value, fallback, min, max) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function nonEmptyString(value, fallback) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function organizerReasoningEffort(value) {
  if (value === null || typeof value === 'string' && value.trim() === '') return '';
  return typeof value === 'string' && /^[a-z]{1,16}$/.test(value.trim())
    ? value.trim() : DEFAULT_CONFIG.organizerReasoningEffort;
}

/**
 * Normalize loader-provided or test-provided configuration without trusting it.
 * Invalid individual fields fall back to safe defaults instead of disabling chat.
 */
export function resolveConfig(raw) {
  const input = raw !== null && typeof raw === 'object' ? raw : {};
  const timeZone = resolvePersonalTimeZone(input.timeZone);

  return Object.freeze({
    project: nonEmptyString(input.project, DEFAULT_CONFIG.project),
    timeZone: timeZone.timeZone,
    timeZoneConfigured: timeZone.configuredTimeZone,
    timeZoneHost: timeZone.hostTimeZone,
    timeZoneError: timeZone.error,
    autoRecall: typeof input.autoRecall === 'boolean' ? input.autoRecall : DEFAULT_CONFIG.autoRecall,
    prefetchMaxChars: integerInRange(input.prefetchMaxChars, DEFAULT_CONFIG.prefetchMaxChars, 0, 4000),
    autoCapture: typeof input.autoCapture === 'boolean' ? input.autoCapture : DEFAULT_CONFIG.autoCapture,
    recentContext: typeof input.recentContext === 'boolean' ? input.recentContext : DEFAULT_CONFIG.recentContext,
    recentContextTokens: integerInRange(input.recentContextTokens, DEFAULT_CONFIG.recentContextTokens, 1024, 131072),
    handoffTokens: integerInRange(input.handoffTokens, DEFAULT_CONFIG.handoffTokens, 1, 16384),
    maxIndexChars: integerInRange(input.maxIndexChars, DEFAULT_CONFIG.maxIndexChars, 200, 900),
    maxTimelineChars: integerInRange(input.maxTimelineChars, DEFAULT_CONFIG.maxTimelineChars, 200, 800),
    organizerReasoningEffort: organizerReasoningEffort(input.organizerReasoningEffort),
    captureFolder: nonEmptyString(input.captureFolder, DEFAULT_CONFIG.captureFolder),
    maxAutomaticFailures: integerInRange(input.maxAutomaticFailures, DEFAULT_CONFIG.maxAutomaticFailures, 1, 10),
    captureTargetMode: processingTargetMode(input),
    captureProvider: typeof input.captureProvider === 'string' ? input.captureProvider.trim() : '',
    captureModel: typeof input.captureModel === 'string' ? input.captureModel.trim() : '',
    vaultPath: typeof input.vaultPath === 'string' ? input.vaultPath.trim() : '',
    softenFactor: numberInRange(input.softenFactor, DEFAULT_CONFIG.softenFactor, 0.05, 0.95),
    halfLifeDays: numberInRange(input.halfLifeDays, DEFAULT_CONFIG.halfLifeDays, 1, 3650),
    priorityFloor: numberInRange(input.priorityFloor, DEFAULT_CONFIG.priorityFloor, 0.000001, 0.5),
    rawRecall: typeof input.rawRecall === 'boolean' ? input.rawRecall : DEFAULT_CONFIG.rawRecall,
    rawRecallModel: nonEmptyString(input.rawRecallModel, DEFAULT_CONFIG.rawRecallModel),
    rawRecallPython: nonEmptyString(input.rawRecallPython, DEFAULT_CONFIG.rawRecallPython),
    rawRecallCacheDir: typeof input.rawRecallCacheDir === 'string' ? input.rawRecallCacheDir.trim() : '',
    rawRecallOnnxModel: typeof input.rawRecallOnnxModel === 'string' ? input.rawRecallOnnxModel.trim() : '',
    rawRecallOnnxTokenizer: typeof input.rawRecallOnnxTokenizer === 'string' ? input.rawRecallOnnxTokenizer.trim() : '',
    rawRecallBgeModelDir: typeof input.rawRecallBgeModelDir === 'string' ? input.rawRecallBgeModelDir.trim() : '',
    rawRecallDimensions: integerInRange(input.rawRecallDimensions, 0, 0, 4096),
    rawRecallThreads: integerInRange(input.rawRecallThreads, 4, 1, 32),
    rawRecallDevice: ['auto', 'cpu', 'cuda'].includes(input.rawRecallDevice) ? input.rawRecallDevice : 'auto',
    rawRecallCpuThreads: integerInRange(input.rawRecallCpuThreads, 6, 1, 32),
    rawRecallGpuThreads: integerInRange(input.rawRecallGpuThreads, 4, 1, 32),
    rawRecallIdleMs: integerInRange(input.rawRecallIdleMs, 0, 0, 3600000),
    rawRecallResidentHours: typeof input.rawRecallResidentHours === 'string' && /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(input.rawRecallResidentHours.trim()) ? input.rawRecallResidentHours.trim() : '',
    rawRecallMaxTokens: integerInRange(input.rawRecallMaxTokens, 2048, 128, 8192),
    rawRecallQueryInstruction: typeof input.rawRecallQueryInstruction === 'string' ? input.rawRecallQueryInstruction.trim() : '',
    rawRecallPrepareTimeoutMs: integerInRange(input.rawRecallPrepareTimeoutMs, 120000, 1000, 300000),
    rawRecallIndexTimeoutMs: integerInRange(input.rawRecallIndexTimeoutMs, 30000, 1000, 300000),
    rawRecallGgufModel: typeof input.rawRecallGgufModel === 'string' ? input.rawRecallGgufModel.trim() : '',
    rawRecallLlamaServer: typeof input.rawRecallLlamaServer === 'string' ? input.rawRecallLlamaServer.trim() : '',
    rawRecallLlamaCpuServer: typeof input.rawRecallLlamaCpuServer === 'string' ? input.rawRecallLlamaCpuServer.trim() : '',
    rawRecallLlamaCudaServer: typeof input.rawRecallLlamaCudaServer === 'string' ? input.rawRecallLlamaCudaServer.trim() : '',
    rawRecallLlamaContext: integerInRange(input.rawRecallLlamaContext, 4096, 512, 32768),
    rawRecallLlamaGpuLayers: integerInRange(input.rawRecallLlamaGpuLayers, 0, -1, 128),
    rawRecallAllowCloud: input.rawRecallAllowCloud === true,
    rawRecallApiBase: nonEmptyString(input.rawRecallApiBase, DEFAULT_CONFIG.rawRecallApiBase),
    rawRecallApiKeyEnv: typeof input.rawRecallApiKeyEnv === 'string' ? input.rawRecallApiKeyEnv.trim() : 'DASHSCOPE_API_KEY',
    rawRecallApiKeyFile: typeof input.rawRecallApiKeyFile === 'string' ? input.rawRecallApiKeyFile.trim() : '',
    rawRecallApiKeyService: typeof input.rawRecallApiKeyService === 'string' ? input.rawRecallApiKeyService.trim() : '',
    rawRecallInstallReceipt: typeof input.rawRecallInstallReceipt === 'string' ? input.rawRecallInstallReceipt.trim() : '',
    rawRecallApiRevision: typeof input.rawRecallApiRevision === 'string' ? input.rawRecallApiRevision.trim() : '',
    rawRecallDbPath: typeof input.rawRecallDbPath === 'string' ? input.rawRecallDbPath.trim() : '',
    rawRecallMaxChars: integerInRange(input.rawRecallMaxChars, DEFAULT_CONFIG.rawRecallMaxChars, 120, HARD_MAX_RAW_RECALL_CHARS),
    rawRecallTimeoutMs: integerInRange(input.rawRecallTimeoutMs, DEFAULT_CONFIG.rawRecallTimeoutMs, 100, HARD_MAX_RAW_RECALL_TIMEOUT_MS),
    rawRecallQueryWaitMs: input.rawRecallQueryWaitMs === 0 || input.rawRecallQueryWaitMs === undefined
      ? 0 : integerInRange(input.rawRecallQueryWaitMs, 0, 1000, 10000),
    rawRecallMinScore: input.rawRecallMinScore === null || input.rawRecallMinScore === undefined
      ? null : numberInRange(input.rawRecallMinScore, null, 0, 1),
    rawRecallCandidates: integerInRange(input.rawRecallCandidates, DEFAULT_CONFIG.rawRecallCandidates, 1, 40),
    rawRecallTop: integerInRange(input.rawRecallTop, DEFAULT_CONFIG.rawRecallTop, 1, 12),
  });
}

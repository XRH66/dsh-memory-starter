import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { resolveConfig } from '../lib/config.js';
import { rawModelSpec, modelContract, modelIdentity, llamaRuntimeSettings } from '../lib/raw-rag/models.js';
import { normalizeRawModelSettings, publicRawModel } from '../lib/raw-rag/settings.js';
import { LlamaEmbeddingTransport } from '../lib/raw-rag/local-backends.js';
import { EmbeddingBackend } from '../lib/raw-rag/backend.js';
import { identifyDeviceSpace } from '../lib/raw-rag/assets.js';

const MODEL = 'Qwen/Qwen3-Embedding-4B';
const settings = extra => resolveConfig({ rawRecallModel: MODEL, rawRecallLlamaCpuServer: path.resolve('cpu-server'),
  rawRecallLlamaCudaServer: path.resolve('cuda-server'), rawRecallGgufModel: path.resolve('model.gguf'), ...extra });

// Emulates the process/HTTP protocol without a model, GPU, network or vault.
function fakeLlama({ attempts = [], dimensions = 2560, gate, onSpawn } = {}) {
  const calls = [], children = [], requests = [], events = [];
  const answer = body => ({ ok: true, status: 200, headers: new Headers(), async json() { return body; } });
  let current, active = 0, peak = 0;
  const io = {
    async freePort() { return 41000 + calls.length; },
    async delay() { await delay(1); },
    spawn(server, args) {
      const plan = attempts[calls.length] || {};
      const device = args[args.indexOf('-ngl') + 1] === '0' ? 'cpu' : 'cuda';
      onSpawn?.({ server, args, device, active });
      active++; peak = Math.max(peak, active);
      const child = new EventEmitter(); child.stderr = new PassThrough();
      let diagnosticsWritten;
      const diagnostics = new Promise(resolve => { diagnosticsWritten = resolve; });
      current = { child, plan, device, args, server, diagnostics }; children.push(current);
      calls.push({ server, args, device }); events.push('start:' + device);
      let closed = false;
      const close = code => { if (closed) return; closed = true; active--; events.push('close:' + device); child.emit('close', code); };
      current.close = close;
      child.kill = () => { events.push('kill:' + device); setImmediate(() => close(0)); return true; };
      setImmediate(() => {
        if (plan.log) child.stderr.write(plan.log + '\n');
        else if (device === 'cuda' && !plan.noOffload) child.stderr.write('load_tensors: offloaded 37/37 layers to GPU\n');
        diagnosticsWritten();
        if (plan.errorCode) child.emit('error', Object.assign(new Error('spawn failed'), { code: plan.errorCode }));
        if (plan.exit || plan.errorCode) close(plan.exit || 1);
      });
      return child;
    },
    async fetch(url, options) {
      requests.push({ url, options });
      if (url.endsWith('/health')) {
        await current.diagnostics;
        return { ok: !current.plan.unhealthy };
      }
      if (url.endsWith('/v1/models')) {
        await current.diagnostics;
        return answer({ data: [{ id: current.plan.badAlias ? 'wrong-model' : MODEL }] });
      }
      if (url.endsWith('/tokenize')) return answer({ tokens: [1, 2, 3] });
      if (url.endsWith('/v1/embeddings')) {
        await gate?.(JSON.parse(options.body).input);
        const input = JSON.parse(options.body).input;
        return answer({ data: input.map((_, index) => ({ index, embedding: Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0) })) });
      }
      throw new Error('Unexpected fake route: ' + url);
    },
  };
  return { io, calls, children, requests, events, get active() { return active; }, get peak() { return peak; } };
}

test('device settings round-trip, defaults and older model thread defaults', () => {
  const config = settings();
  const fields = normalizeRawModelSettings({ ...publicRawModel(config).fields, rawRecallDevice: 'cuda' });
  assert.equal(fields.rawRecallDevice, 'cuda');
  assert.equal(fields.rawRecallCpuThreads, 6); assert.equal(fields.rawRecallGpuThreads, 4);
  assert.equal(fields.rawRecallIdleMs, 0);
  assert.equal(llamaRuntimeSettings(rawModelSpec(config), config).initialDevice, 'cuda');
  const eight = settings({ rawRecallModel: 'Qwen/Qwen3-Embedding-8B', rawRecallLlamaCudaServer: '', rawRecallLlamaServer: path.resolve('old-cpu') });
  assert.equal(llamaRuntimeSettings(rawModelSpec(eight), eight).initialDevice, 'cpu');
  assert.equal(llamaRuntimeSettings(rawModelSpec(eight), eight).cpuThreads, 4);
  assert.throws(() => normalizeRawModelSettings({ ...fields, rawRecallDevice: 'vulkan' }), /运行设备/u);
  assert.throws(() => normalizeRawModelSettings({ ...fields, rawRecallCpuThreads: 99 }), /超出范围/u);
  assert.throws(() => normalizeRawModelSettings({ ...fields, rawRecallLlamaCudaServer: 'relative.exe' }), /完整/u);
  assert.throws(() => normalizeRawModelSettings({ ...fields, rawRecallModel: 'Qwen/Qwen3-Embedding-0.6B', rawRecallDimensions: 0,
    rawRecallOnnxModel: path.resolve('model.onnx'), rawRecallOnnxTokenizer: path.resolve('tokenizer.json') }), /尚未支持 CUDA/u);
});

test('4B transports are lazy, coalesce startup and expose verified GPU/CPU threads', async () => {
  for (const device of ['cpu', 'cuda']) {
    const fake = fakeLlama(), config = settings({ rawRecallDevice: device });
    const transport = new LlamaEmbeddingTransport({ spec: rawModelSpec(config), config, io: fake.io });
    assert.equal(transport.status().actualDevice, null); assert.equal(fake.calls.length, 0);
    await Promise.all([transport.start(), transport.start()]);
    assert.equal(fake.calls.length, 1);
    const { args } = fake.calls[0], threads = device === 'cpu' ? 6 : 4;
    assert.equal(args[args.indexOf('-t') + 1], String(threads));
    assert.equal(args[args.indexOf('-tb') + 1], String(threads));
    assert.equal(args[args.indexOf('-m') + 1], config.rawRecallGgufModel);
    assert.equal(transport.status().actualDevice, device);
    assert.equal(transport.status().runtime.gpuLayers, device === 'cpu' ? 0 : 37);
    await transport.dispose();
    assert.equal(fake.active, 0); assert.equal(transport.status().actualDevice, null);
  }
});

test('auto fallback accepts only unavailable CUDA or OOM, and waits for the GPU to close', async () => {
  for (const failure of [
    { log: 'CUDA error: out of memory', exit: 1, code: 'RAW_GPU_MEMORY' },
    { log: 'no usable GPU found', exit: 1, code: 'RAW_GPU_UNAVAILABLE' },
    { errorCode: 'ENOENT', code: 'RAW_GPU_UNAVAILABLE' },
    { noOffload: true, code: 'RAW_GPU_UNAVAILABLE' },
  ]) {
    const fake = fakeLlama({ attempts: [failure] }), config = settings();
    const transport = new LlamaEmbeddingTransport({ spec: rawModelSpec(config), config, io: fake.io });
    await transport.start();
    assert.equal(transport.status().actualDevice, 'cpu');
    assert.equal(transport.status().fallbackReason.code, failure.code);
    assert.ok(fake.events.indexOf('close:cuda') < fake.events.indexOf('start:cpu'));
    assert.equal(fake.peak, 1);
    assert.equal(fake.calls[1].args[fake.calls[1].args.indexOf('-tb') + 1], '6');
    await transport.dispose(); assert.equal(fake.active, 0);
  }
});

test('explicit CUDA, model errors, alias failures and cancellation never silently use CPU', async () => {
  for (const scenario of [
    { device: 'cuda', plan: { log: 'CUDA error: out of memory', exit: 1 }, match: /CUDA/u },
    { device: 'cuda', plan: { noOffload: true }, match: /offload/u },
    { device: 'auto', plan: { log: 'invalid GGUF model file', exit: 1 }, match: /failed to start/u },
    { device: 'auto', plan: { badAlias: true }, match: /alias mismatch/u },
  ]) {
    const fake = fakeLlama({ attempts: [scenario.plan] }), config = settings({ rawRecallDevice: scenario.device });
    const transport = new LlamaEmbeddingTransport({ spec: rawModelSpec(config), config, io: fake.io });
    await assert.rejects(transport.start(), scenario.match);
    assert.equal(fake.calls.length, 1); await transport.dispose(); assert.equal(fake.active, 0);
  }
  const fake = fakeLlama({ attempts: [{ unhealthy: true }] }), config = settings(), abort = new AbortController();
  const transport = new LlamaEmbeddingTransport({ spec: rawModelSpec(config), config, io: fake.io });
  const starting = transport.start(abort.signal);
  setTimeout(() => abort.abort(), 5);
  await assert.rejects(starting, /abort/iu); assert.equal(fake.calls.length, 1);
  await transport.dispose(); assert.equal(fake.active, 0);
});

test('verified device space is reused only for identical weights/encoding and compatible outputs', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-device-space-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = settings(), contract = { ...modelContract(rawModelSpec(config), config), dimensions: 2 };
  const hashes = [{ name: 'embedding.gguf', sha256: 'weight-one' }, { name: 'llama-server', sha256: 'cpu-runtime' }];
  const file = path.join(dir, 'devices.json'), vectors = [[1, 0], [0, 1]];
  let probes = 0;
  const identify = extra => identifyDeviceSpace({ contract, hashes, runtime: { device: 'cpu', context: 4096 },
    cacheFile: file, ledger: {}, probe: async () => { probes++; return vectors; }, ...extra });
  const cpu = await identify(); assert.equal(probes, 1);
  assert.match(cpu.identity.modelKey, /^raw-v3:/u);
  assert.notEqual(cpu.identity.modelKey, modelIdentity(contract, hashes, { gpuLayers: 0 }).modelKey);
  const cuda = await identify({ hashes: [hashes[0], { name: 'llama-server', sha256: 'cuda-runtime' }], runtime: { device: 'cuda', context: 4096 } });
  assert.equal(cuda.identity.modelKey, cpu.identity.modelKey); assert.equal(cuda.compatibility, 'verified'); assert.equal(probes, 2);
  await identify({ hashes: [hashes[0], { name: 'llama-server', sha256: 'cuda-runtime' }], runtime: { device: 'cuda', context: 4096 } });
  assert.equal(probes, 2, 'verified runtime does not repeat public probes');
  const quantized = await identify({ hashes: [hashes[0], { name: 'llama-server', sha256: 'q4-rounding-runtime' }],
    probe: async () => [[0.9984, Math.sqrt(1 - 0.9984 ** 2)], [Math.sqrt(1 - 0.9965 ** 2), 0.9965]] });
  assert.equal(quantized.identity.modelKey, cpu.identity.modelKey);
  assert.equal(quantized.minCosine, 0.995); assert.ok(quantized.cosines.every(value => value >= 0.995));
  const incompatible = await identify({ hashes: [hashes[0], { name: 'llama-server', sha256: 'bad-runtime' }], probe: async () => [[0, 1], [1, 0]] });
  assert.equal(incompatible.compatibility, 'incompatible'); assert.notEqual(incompatible.identity.modelKey, cpu.identity.modelKey);
  assert.notEqual((await identify({ hashes: [{ ...hashes[0], sha256: 'weight-two' }, hashes[1]] })).identity.modelKey, cpu.identity.modelKey);
  assert.notEqual((await identify({ contract: { ...contract, query: 'different instruction' } })).identity.modelKey, cpu.identity.modelKey);
});

async function backendFixture(t, extra = {}, fakeOptions = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'raw-device-backend-'));
  const weight = path.join(dir, 'weights.gguf'), cpu = path.join(dir, 'cpu', 'llama-server.exe'), cuda = path.join(dir, 'cuda', 'llama-server.exe');
  await fs.mkdir(path.dirname(cpu)); await fs.mkdir(path.dirname(cuda));
  await fs.writeFile(weight, 'public fake GGUF weight'); await fs.writeFile(cpu, 'cpu-runtime'); await fs.writeFile(cuda, 'cuda-runtime');
  const fake = fakeLlama(fakeOptions), backends = [];
  const create = override => {
    const config = settings({ rawRecallGgufModel: weight, rawRecallLlamaCpuServer: cpu, rawRecallLlamaCudaServer: cuda, ...extra, ...override });
    const backend = new EmbeddingBackend({ config, cacheFile: path.join(dir, 'assets.json'),
      localTransportFactory: options => new LlamaEmbeddingTransport({ ...options, io: fake.io }) });
    backends.push(backend); return backend;
  };
  t.after(async () => { await Promise.all(backends.map(backend => backend.dispose())); await fs.rm(dir, { recursive: true, force: true }); });
  return { fake, create, weight };
}

test('backend status stays cold, CPU/GPU handover preserves verified space, idle release permits reload', async t => {
  const f = await backendFixture(t), cpu = f.create({ rawRecallDevice: 'cpu' });
  assert.equal(cpu.status().actualDevice, null); assert.equal(f.fake.calls.length, 0);
  const original = await cpu.prepare();
  assert.equal(cpu.status().runtime.threads, 6); await cpu.dispose();
  const gpu = f.create({ rawRecallDevice: 'auto', rawRecallIdleMs: 20 });
  const current = await gpu.prepare();
  assert.equal(current.modelKey, original.modelKey);
  assert.equal(gpu.status().runtime.compatibility, 'verified');
  assert.equal(gpu.status().actualDevice, 'cuda');
  await delay(70);
  assert.equal(gpu.status().prepared, false); assert.equal(gpu.status().actualDevice, null); assert.equal(f.fake.active, 0);
  const before = f.fake.requests.filter(item => item.url.endsWith('/v1/embeddings')).length;
  const result = await gpu.embed(['公开测试文本'], { kind: 'query' });
  assert.equal(result[0].length, 2560); assert.equal(gpu.modelKey, original.modelKey);
  assert.equal(f.fake.requests.filter(item => item.url.endsWith('/v1/embeddings')).length - before, 1);
  assert.equal(f.fake.peak, 1);
});

test('idle release never kills an admitted embedding job', async t => {
  let entered, release;
  const inside = new Promise(resolve => { entered = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const f = await backendFixture(t, { rawRecallIdleMs: 10 }, { gate: async texts => {
    if (texts[0] === 'held-public-job') { entered(); await wait; }
  } });
  const backend = f.create();
  await backend.prepare();
  const job = backend.embed(['held-public-job']); await inside; await delay(35);
  assert.equal(backend.status().active, true); assert.equal(f.fake.active, 1);
  release(); await job; await delay(45);
  assert.equal(backend.status().prepared, false); assert.equal(f.fake.active, 0);
});

test('a held backend is not idle-released between prepare and the last embed of its caller', async t => {
  const f = await backendFixture(t, { rawRecallIdleMs: 10 });
  const backend = f.create();
  const unhold = backend.hold(); const identity = await backend.prepare();
  await delay(45);
  assert.equal(backend.modelKey, identity.modelKey); assert.equal(f.fake.active, 1);
  unhold(); await delay(45);
  assert.equal(backend.status().prepared, false); assert.equal(f.fake.active, 0);
});

test('a full maintenance queue never refuses a query', async t => {
  let release; const wait = new Promise(resolve => { release = resolve; });
  const f = await backendFixture(t, {}, { gate: async texts => { if (texts[0] === 'doc-0') await wait; } });
  const backend = f.create(); await backend.prepare();
  const docs = Array.from({ length: 18 }, (_, i) => backend.embed(['doc-' + i]).catch(error => error));
  const refused = await docs[17]; assert.equal(refused.code, 'EMBEDDING_QUEUE_FULL');
  const query = backend.embed(['公开查询'], { kind: 'query' });
  release(); assert.equal((await query)[0].length, 2560); await Promise.all(docs);
});

test('local query cancellation releases the runtime only after transport dispatch', async t => {
  let authorizing, allow, sent, respond;
  const authorizationStarted = new Promise(resolve => { authorizing = resolve; });
  const authorization = new Promise(resolve => { allow = resolve; });
  const transportStarted = new Promise(resolve => { sent = resolve; });
  const response = new Promise(resolve => { respond = resolve; });
  const f = await backendFixture(t, { rawRecallDevice: 'cpu', rawRecallIdleMs: 0 }, { gate: async texts => {
    if (texts[0].includes('in-flight-query')) { sent(); await response; }
  } });
  const backend = f.create(), identity = await backend.prepare();
  const pending = new AbortController(), pendingStates = [];
  const before = f.fake.requests.length;
  const unsent = backend.embed(['unsent-query'], { kind: 'query', signal: pending.signal,
    onJobState: state => pendingStates.push(state), authorize: () => { authorizing(); return authorization; } });
  const unsentRejected = assert.rejects(unsent, { code: 'RAW_RECALL_CANCELLED' });
  try {
    await authorizationStarted;
    assert.equal(backend.status().queued, 0);
    pending.abort(); await unsentRejected;
  } finally { allow(true); await backend.idle; }
  assert.deepEqual(pendingStates, ['pending']);
  assert.equal(f.fake.requests.length, before);
  assert.equal(f.fake.active, 1);

  const dispatched = new AbortController(), dispatchedStates = [];
  const inFlight = backend.embed(['in-flight-query'], { kind: 'query', signal: dispatched.signal,
    onJobState: state => dispatchedStates.push(state) });
  const inFlightRejected = assert.rejects(inFlight, { code: 'RAW_RECALL_CANCELLED' });
  try {
    await transportStarted;
    dispatched.abort(); await inFlightRejected;
  } finally { respond(); await backend.idle; }
  assert.deepEqual(dispatchedStates, ['pending', 'dispatched']);
  assert.equal(f.fake.active, 0);
  assert.equal(backend.status().prepared, false);
  assert.equal((await backend.embed(['following-query'], { kind: 'query' })).length, 1);
  assert.equal(backend.modelKey, identity.modelKey);
  assert.equal(f.fake.calls.length, 2);
});

test('weight changes after release invalidate identity instead of borrowing an old index', async t => {
  const f = await backendFixture(t), first = f.create({ rawRecallDevice: 'cpu' });
  const original = await first.prepare(); await first.dispose();
  await fs.writeFile(f.weight, 'a different public fake GGUF weight');
  const second = f.create({ rawRecallDevice: 'cuda' });
  assert.notEqual((await second.prepare()).modelKey, original.modelKey);
});

test('a dead GPU process is re-prepared and CPU fallback is verified before reusing its index', async t => {
  const f = await backendFixture(t, {}, { attempts: [{}, { log: 'CUDA error: out of memory', exit: 1 }, {}] });
  const backend = f.create(); const original = await backend.prepare();
  f.fake.children[0].close(1);
  assert.equal(backend.status().prepared, false);
  assert.equal(backend.status().actualDevice, null); assert.equal(backend.status().runtime, null);
  const vectors = await backend.embed(['public-recovery-input']);
  assert.equal(vectors.length, 1); assert.equal(backend.modelKey, original.modelKey);
  assert.equal(backend.status().actualDevice, 'cpu');
  assert.equal(backend.status().runtime.compatibility, 'verified');
  assert.equal(backend.status().fallbackReason.code, 'RAW_GPU_MEMORY');
  assert.equal(f.fake.peak, 1);
});

test('empty jobs and invalid requests do not cancel the idle resource timer', async t => {
  const f = await backendFixture(t, { rawRecallIdleMs: 15 }), backend = f.create();
  await backend.prepare();
  assert.deepEqual(await backend.embed([]), []);
  await assert.rejects(backend.embed(['bad'], { kind: 'unsupported' }), /Unknown/u);
  await delay(50); assert.equal(backend.status().prepared, false); assert.equal(f.fake.active, 0);
});

test('local source boundary waits for async authorization before embedding and tokenization',async t=>{
  const f=await backendFixture(t),backend=f.create({rawRecallDevice:'cpu'});
  await backend.prepare();const before=f.fake.requests.length;
  const authorize=async()=>{await new Promise(r=>setImmediate(r));return false;};
  await assert.rejects(backend.embed(['FICTIONAL-REVOKED'],{authorize}),/source access changed/);
  await assert.rejects(backend.planChunks('FICTIONAL-REVOKED',{authorize}),/source access changed/);
  assert.equal(f.fake.requests.length,before,'revoked content never reaches either local endpoint');
});

test('resident hours keep the model loaded inside the window, including across midnight', async () => {
  const { residentFor } = await import('../lib/raw-rag/backend.js');
  // Wall times in the default personal zone (Asia/Shanghai, UTC+8), whatever the host zone is.
  const at = (h, m) => new Date(Date.UTC(2026, 0, 1, h - 8, m));
  assert.equal(residentFor('08:00-01:00', at(9, 0)).inside, true);
  assert.equal(residentFor('08:00-01:00', at(0, 30)).untilEndMs, 30 * 60000);
  assert.equal(residentFor('08:00-01:00', at(3, 0)).inside, false);
  assert.equal(residentFor('', at(12, 0)).inside, false);
});

test('resident hours follow the personal time zone, not the host zone', async t => {
  const { residentFor } = await import('../lib/raw-rag/backend.js');
  const { setPersonalTimeZone } = await import('../lib/personal-namespace.js');
  t.after(() => setPersonalTimeZone(''));
  const noonUtc = new Date(Date.UTC(2026, 0, 1, 12, 0));
  setPersonalTimeZone('Asia/Shanghai'); // 20:00 local
  assert.equal(residentFor('08:00-22:00', noonUtc).inside, true);
  setPersonalTimeZone('America/Los_Angeles'); // 04:00 local
  assert.equal(residentFor('08:00-22:00', noonUtc).inside, false);
});

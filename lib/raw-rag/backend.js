import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawModelSpec, modelContract, modelIdentity, formatEmbeddingInput } from './models.js';
import { embeddingAssets, identifyAssets, assertAssetsCurrent, identifyDeviceSpace, DEVICE_PROBES } from './assets.js';
import { PythonEmbeddingTransport, LlamaEmbeddingTransport } from './local-backends.js';
import { CloudEmbeddingTransport } from './cloud-backend.js';
import { planEmbeddingChunks } from './chunks.js';
import { localTime } from '../local-time.js';

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'embed_worker.py');

/** "08:00-01:00": keep the model loaded inside this window, read in the personal time zone
 * like every other time the user sees (the host may be set to another zone). The window may
 * cross midnight. Outside it the ordinary idle release applies. Returns how long until it ends. */
export function residentFor(hours,now=new Date()){
  const match=/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(hours??'');if(!match)return {inside:false};
  const start=Number(match[1])*60+Number(match[2]),end=Number(match[3])*60+Number(match[4]);
  const [hour,minuteOfHour]=localTime(now.getTime()).slice(11,16).split(':').map(Number);
  const minute=hour*60+minuteOfHour,inside=start===end||(start<end?minute>=start&&minute<end:minute>=start||minute<end);
  if(!inside)return {inside:false};
  const left=start===end?24*60:((end-minute+24*60)%(24*60))||24*60;
  return {inside:true,untilEndMs:left*60000-now.getSeconds()*1000};
}

export class EmbeddingTimeoutError extends Error {
  constructor(message) { super(message); this.name = 'EmbeddingTimeoutError'; this.code = 'RAW_RECALL_TIMEOUT'; }
}

function abortError(signal) {
  if (signal.reason?.name === 'TimeoutError') return new EmbeddingTimeoutError('Embedding request timed out');
  const error = new Error('Embedding request cancelled');
  error.code = 'RAW_RECALL_CANCELLED';
  error.name = 'AbortError';
  return error;
}

function normalize(vectors, count, dimensions) {
  if (!Array.isArray(vectors) || vectors.length !== count) throw new Error('Embedding result count mismatch');
  return vectors.map(vector => {
    if ((!Array.isArray(vector) && !ArrayBuffer.isView(vector)) || vector.length !== dimensions) throw new Error('Embedding dimension mismatch');
    const output = Float32Array.from(vector);
    let sum = 0;
    for (const value of output) { if (!Number.isFinite(value)) throw new Error('Invalid embedding value'); sum += value * value; }
    if (!sum) throw new Error('Zero embedding');
    const norm = Math.sqrt(sum);
    for (let i = 0; i < output.length; i += 1) output[i] /= norm;
    return output;
  });
}

/** One selected model, one bounded priority queue, one retrieval-facing API. */
export class EmbeddingBackend {
  constructor({ config, logger = console, cacheFile, deviceCacheFile = cacheFile ? cacheFile + '.devices.json' : null, onUsage, localTransportFactory }) {
    Object.assign(this, { config: Object.freeze({ ...config }), logger, cacheFile, deviceCacheFile, onUsage, localTransportFactory });
    this.identity = null;
    this.preparing = null;
    this.transport = null;
    this.assets = [];
    this.queue = [];
    this.running = false;
    this.idle = Promise.resolve();
    this.disposed = false;
    this.shutdown = new AbortController();
    this.prepareFailures = 0;
    this.usage = { calls: 0, tokens: 0, unknownUsageCalls: 0 };
    this.pinnedModelKey = null;
    this.observedKinds = new Set();
    this.idleTimer = null;
    this.releasing = null;
    this.deviceLedger = {};
    this.deviceReceipt = null;
  }

  get modelKey() { return this.identity?.modelKey || null; }
  get dimensions() { return this.identity?.dimensions || null; }
  get batchSize() { return this.spec?.batch || 1; }

  async prepare() {
    if (this.disposed) throw new Error('Embedding backend is disposed');
    if (this.identity && this.spec?.engine === 'llamacpp' && !this.transport?.status().actualDevice) await this.releaseTransport();
    if (this.identity) { this.scheduleIdleRelease(); return this.identity; }
    if (this.preparing) return this.preparing;
    if (this.prepareFailures >= 2) throw new Error('Embedding preparation failed twice; reload to retry');
    this.preparing = (async () => {
      await this.releasing;
      const signal = AbortSignal.any([this.shutdown.signal, AbortSignal.timeout(this.config.rawRecallPrepareTimeoutMs || 120000)]);
      this.spec = rawModelSpec(this.config);
      if (this.spec.task !== 'embedding') throw new Error('This interface accepts embedding models only');
      if (this.spec.engine === 'llamacpp' && this.spec.maxTokens >= (this.config.rawRecallLlamaContext || 4096)) throw new Error('Embedding token limit must be smaller than llama context');
      let hashes = [], runtime;
      if (this.spec.engine === 'api') {
        this.transport = new CloudEmbeddingTransport({ spec: this.spec, config: this.config, onUsage: async receipt => {
          this.usage.calls += 1;
          if (receipt.tokens == null) this.usage.unknownUsageCalls += 1;
          else this.usage.tokens += receipt.tokens;
          try { await this.onUsage?.({ ...receipt, modelKey: this.modelKey }); }
          catch { this.logger.warn?.('[raw-recall] Embedding usage receipt could not be saved'); }
        } });
        runtime = await this.transport.prepare();
      } else {
        if (this.spec.engine !== 'llamacpp' && this.config.rawRecallDevice === 'cuda') throw new Error('CUDA is not supported by this local embedding backend');
        if (this.spec.engine === 'llamacpp' && !this.config.rawRecallGgufModel) throw new Error('Qwen GGUF needs a local model path');
        // Verify the weight before loading and again after readiness. Runtime
        // assets are selected after auto fallback has chosen its actual server.
        const assets = this.spec.engine === 'llamacpp'
          ? { entries: [{ name: 'embedding.gguf', file: this.config.rawRecallGgufModel }] }
          : await embeddingAssets(this.spec, this.config, WORKER);
        signal.throwIfAborted();
        const identified = await identifyAssets(assets.entries, this.cacheFile, signal);
        signal.throwIfAborted();
        hashes = identified.hashes;
        this.assets = identified.stamps;
        const options = { spec: this.spec, config: this.config, workerFile: WORKER, directory: assets.directory,
          beforeStart: async ({ server, device }) => {
            try {
              const selected = await embeddingAssets(this.spec, this.config, WORKER, { server });
              const actual = await identifyAssets(selected.entries, this.cacheFile, signal);
              hashes = actual.hashes; this.assets = actual.stamps;
            } catch (error) {
              // Missing runtime files are a GPU availability failure; a missing
              // or changed weight/input is not a reason to silently use CPU.
              const failedPath = error.path && path.resolve(error.path);
              const directory = path.dirname(path.resolve(server));
              if (device === 'cuda' && ['ENOENT', 'EACCES'].includes(error.code) && failedPath &&
                  failedPath !== path.resolve(this.config.rawRecallGgufModel) &&
                  (failedPath === directory || failedPath.startsWith(directory + path.sep))) {
                throw Object.assign(new Error('CUDA embedding runtime assets are unavailable'), { code: 'RAW_GPU_UNAVAILABLE' });
              }
              throw error;
            }
          } };
        this.transport = this.localTransportFactory ? this.localTransportFactory(options)
          : this.spec.engine === 'llamacpp' ? new LlamaEmbeddingTransport(options) : new PythonEmbeddingTransport(options);
        const ready = await this.transport.start(signal);
        await assertAssetsCurrent(this.assets);
        if (this.spec.engine === 'llamacpp') {
          this.deviceReceipt = this.transport.status();
          runtime = { adapter: 'llama-server-embeddings-v2', context: this.config.rawRecallLlamaContext || 4096,
            device: ready.device, gpuLayers: ready.device === 'cuda' ? ready.offloadedLayers : 0 };
        } else runtime = ready;
      }
      signal.throwIfAborted();
      if (this.disposed) throw new Error('Embedding backend is disposed');
      const contract = modelContract(this.spec, this.config);
      let identity;
      if (this.spec.engine === 'llamacpp') {
        const space = await identifyDeviceSpace({ contract, hashes, runtime, cacheFile: this.deviceCacheFile,
          ledger: this.deviceLedger, signal, probe: async () => {
            const result = [];
            for (const item of DEVICE_PROBES) {
              const vectors = await this.transport.embed([formatEmbeddingInput(this.spec, item.text, item.kind)], { kind: item.kind, signal });
              result.push(Array.from(normalize(vectors, 1, this.spec.dimensions)[0]));
            }
            return result;
          } });
        identity = space.identity;
        this.deviceReceipt.runtime = { ...this.deviceReceipt.runtime, runtimeKey: space.runtimeKey, compatibility: space.compatibility,
          compatibilityCosines: space.cosines, compatibilityMinCosine: space.minCosine };
        await assertAssetsCurrent(this.assets);
      } else identity = modelIdentity(contract, hashes, runtime);
      if (this.pinnedModelKey && identity.modelKey !== this.pinnedModelKey) throw new Error('Embedding space changed; reload the bridge before using the new model identity');
      this.pinnedModelKey = identity.modelKey;
      this.identity = identity;
      this.prepareFailures = 0;
      return this.identity;
    })().catch(async error => {
      this.prepareFailures += 1;
      await this.releaseTransport();
      throw error;
    }).finally(() => { this.preparing = null; this.scheduleIdleRelease(); });
    return this.preparing;
  }

  embed(texts, options = {}) { return this.runJob(texts, { ...options, operation: 'embed' }); }

  // A caller between prepare() and its last embed (resolving documents, checking modelKey) holds
  // the model; idle release in that gap nulled the identity mid-operation.
  hold() {
    this.holds = (this.holds ?? 0) + 1; clearTimeout(this.idleTimer); this.idleTimer = null; let released = false;
    return () => { if (released) return; released = true; this.holds--; this.scheduleIdleRelease(); };
  }

  scheduleIdleRelease() {
    clearTimeout(this.idleTimer);this.idleTimer=null;
    const resident=residentFor(this.config.rawRecallResidentHours);
    const delay=resident.inside?resident.untilEndMs:(this.config.rawRecallIdleMs ?? 0);
    if(!delay||this.disposed||this.running||this.queue.length||this.holds||!this.identity||this.spec?.engine==='api')return;
    this.idleTimer=setTimeout(()=>{
      if(this.running||this.queue.length||this.holds||this.disposed)return;
      this.idleTimer=null;
      if(residentFor(this.config.rawRecallResidentHours).inside){this.scheduleIdleRelease();return;}
      this.releaseTransport().catch(()=>{ this.logger.warn?.('[raw-recall] Local embedding resource release failed'); });
    },delay);
    this.idleTimer.unref?.();
  }

  releaseTransport() {
    const transport = this.transport;
    if (!transport) return this.releasing || Promise.resolve();
    if (this.spec?.engine === 'llamacpp') this.deviceReceipt = { ...this.deviceReceipt, ...transport.status(), runtime: this.deviceReceipt?.runtime || transport.status().runtime };
    this.transport = null; this.identity = null;
    const release = Promise.resolve().then(() => transport.dispose());
    this.releasing = release;
    release.then(() => { if (this.releasing === release) this.releasing = null; }, () => {});
    return release;
  }

  async planChunks(text, { timeoutMs = 30000, signal, authorize, scope, maxChars = 600 } = {}) {
    await this.prepare();
    const deadline=Date.now()+timeoutMs;
    return planEmbeddingChunks(text,{maxTokens:this.spec.maxTokens,maxChars:Math.min(maxChars,4096),signal,authorize,countTokens: texts => {
      const remaining=deadline-Date.now();
      if(remaining<=0)throw new EmbeddingTimeoutError('Embedding chunk planning timed out');
      return this.runJob(texts,{operation:'tokenize',kind:'document',timeoutMs:remaining,signal,authorize,scope});
    }});
  }

  runJob(texts, { kind = 'document', operation = 'embed', timeoutMs = 15000, signal, queueSignal, authorize, scope, onJobState } = {}) {
    // Dequeuing still leaves authorization and preparation before dispatch.
    onJobState?.('pending');
    if (!['query', 'document'].includes(kind)) return Promise.reject(new Error('Unknown embedding kind'));
    const input = Array.from(texts || [], text => String(text ?? ''));
    if (!input.length) return Promise.resolve([]);
    if (this.disposed) return Promise.reject(new Error('Embedding backend is disposed'));
    // The cap guards against runaway maintenance. A query (one short text, sorted to the front)
    // must not be refused because document indexing filled the queue: that refusal surfaced as
    // an instant, code-less VECTOR_QUERY_UNAVAILABLE during real chats.
    if (kind !== 'query' && this.queue.filter(job => job.kind !== 'query').length >= 16) return Promise.reject(Object.assign(new Error('Embedding queue is full'), { code: 'EMBEDDING_QUEUE_FULL' }));
    const deadline = AbortSignal.timeout(Math.max(50, Math.round(Number(timeoutMs) || 15000)));
    const combined = AbortSignal.any([this.shutdown.signal, deadline, signal].filter(Boolean));
    if (combined.aborted) return Promise.reject(abortError(combined));
    if (queueSignal?.aborted) return Promise.reject(abortError(queueSignal));
    return new Promise((resolve, reject) => {
      const job = { texts: input, kind, operation, signal: combined, authorize, scope, resolve, reject, onJobState, active: false, dispatched: false };
      job.abort = () => {
        if (!job.active) { this.queue = this.queue.filter(item => item !== job); queueSignal?.removeEventListener('abort', job.abortQueued); }
        reject(abortError(combined));
      };
      job.queueSignal = queueSignal;
      job.abortQueued = () => {
        if (job.active) return;
        this.queue = this.queue.filter(item => item !== job);
        combined.removeEventListener('abort', job.abort);
        reject(abortError(queueSignal));
      };
      combined.addEventListener('abort', job.abort, { once: true });
      queueSignal?.addEventListener('abort', job.abortQueued, { once: true });
      clearTimeout(this.idleTimer);this.idleTimer=null;
      this.queue.push(job);
      // A query can pass queued maintenance; it never starts a second model.
      this.queue.sort((a, b) => Number(b.kind === 'query') - Number(a.kind === 'query'));
      if (!this.running) this.idle = this.drain();
    });
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length && !this.disposed) {
        const job = this.queue.shift();
        job.active = true;
        job.queueSignal?.removeEventListener('abort', job.abortQueued);
        try {
          job.signal.throwIfAborted();
          if (job.authorize && !await job.authorize()) throw new Error('Embedding source access changed');
          job.signal.throwIfAborted();
          await this.prepare();
          job.signal.throwIfAborted();
          await assertAssetsCurrent(this.assets);
          job.signal.throwIfAborted();
          if (job.authorize && !await job.authorize()) throw new Error('Embedding source access changed');
          job.signal.throwIfAborted();
          if(job.operation==='tokenize'){
            const counts=this.spec.engine==='api'?job.texts.map(text=>Buffer.byteLength(text,'utf8')+16)
              :await this.transport.countTokens(job.texts,{signal:job.signal});
            this.assertRuntimeCurrent();
            job.signal.throwIfAborted();job.resolve(counts);continue;
          }
          const inputs = job.texts.map(text => formatEmbeddingInput(this.spec, text, job.kind));
          if(this.spec.engine==='api'&&inputs.some(text=>Buffer.byteLength(text,'utf8')+16>this.spec.maxTokens))throw new Error('Embedding input exceeds the configured conservative token bound');
          job.dispatched = true;
          job.onJobState?.('dispatched');
          const vectors = await this.transport.embed(inputs, { kind: job.kind, signal: job.signal, scope: job.scope });
          this.assertRuntimeCurrent();
          job.signal.throwIfAborted();
          const normalized = normalize(vectors, job.texts.length, this.dimensions);
          this.observedKinds.add(job.kind);
          job.resolve(normalized);
        } catch (error) {
          if (job.signal.aborted) {
            if (this.spec?.engine !== 'api' && (job.kind !== 'query' || job.dispatched)) {
              await this.releaseTransport().catch(() => { this.logger.warn?.('[raw-recall] Local embedding resource release failed'); });
            }
            job.reject(abortError(job.signal));
          } else {
            if (error.code === 'RAW_RUNTIME_CHANGED') await this.releaseTransport().catch(() => {});
            job.reject(error);
          }
        } finally { job.signal.removeEventListener('abort', job.abort); }
      }
    } finally { this.running = false; this.scheduleIdleRelease(); }
  }

  assertRuntimeCurrent() {
    if (this.spec?.engine !== 'llamacpp') return;
    const actual = this.transport?.status().runtime, checked = this.deviceReceipt?.runtime;
    if (!actual || !checked || ['device', 'server', 'gpuLayers'].some(key => actual[key] !== checked[key])) {
      throw Object.assign(new Error('Embedding runtime changed; prepare and verify its encoding space before retrying'), { code: 'RAW_RUNTIME_CHANGED' });
    }
  }

  status() {
    const device = this.transport?.status?.();
    let spec = this.spec;
    if (!spec) try { spec = rawModelSpec(this.config); } catch { /* invalid configuration remains observable without loading */ }
    const local = spec?.engine !== 'api';
    const loaded = Boolean(this.identity) && (spec?.engine !== 'llamacpp' || Boolean(device?.actualDevice));
    return { requestedModel: this.config.rawRecallModel, prepared: loaded, modelKey: this.modelKey,
      dimensions: this.dimensions, preparing: Boolean(this.preparing), queued: this.queue.length, active: this.running,
      task: 'embedding', observedKinds: [...this.observedKinds],
      idleReleaseMs:this.config.rawRecallIdleMs ?? 0,
      requestedDevice: local ? this.config.rawRecallDevice || 'auto' : null,
      actualDevice: spec?.engine === 'llamacpp' ? device?.actualDevice || null : this.identity && local ? 'cpu' : null,
      fallbackReason: device?.fallbackReason || this.deviceReceipt?.fallbackReason || null,
      runtime: loaded ? this.deviceReceipt?.runtime || device?.runtime || null : null,
      releasing: Boolean(this.releasing),
      cloud: spec?.engine === 'api', cloudPaused: Boolean(this.transport?.blocked), usage: { ...this.usage } };
  }

  async dispose() {
    clearTimeout(this.idleTimer);this.idleTimer=null;
    this.disposed = true;
    this.shutdown.abort();
    await this.releaseTransport();
    for (const job of this.queue.splice(0)) { job.signal.removeEventListener('abort', job.abort); job.queueSignal?.removeEventListener('abort',job.abortQueued); job.reject(new Error('Embedding backend disposed')); }
    await this.idle;
    try { await this.preparing; } catch { /* disposal aborts shared preparation */ }
  }
}

export function createEmbeddingBackend(options) { return new EmbeddingBackend(options); }

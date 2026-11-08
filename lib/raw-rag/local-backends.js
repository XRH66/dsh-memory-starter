import net from 'node:net';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { requestEmbeddingService } from './embedding-http.js';
import { llamaRuntimeSettings } from './models.js';

export class PythonEmbeddingTransport {
  constructor({ spec, config, workerFile, directory }) {
    Object.assign(this, { spec, config, workerFile, directory });
    this.run = null;
    this.disposed = false;
    this.nextId = 1;
    this.runtime = null;
  }

  async start(signal) {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('Embedding worker is disposed');
    if (this.run) return this.run.ready;
    const args = [this.workerFile, '--engine', this.spec.engine, '--threads', String(this.config.rawRecallThreads || 4),
      '--max-tokens', String(this.spec.maxTokens)];
    if (this.config.rawRecallCacheDir) args.push('--cache-dir', this.config.rawRecallCacheDir);
    if (this.directory) args.push('--bge-dir', this.directory);
    if (this.spec.engine === 'onnx') args.push('--onnx-model', this.config.rawRecallOnnxModel, '--onnx-tokenizer', this.config.rawRecallOnnxTokenizer);
    const child = spawn(this.config.rawRecallPython || 'python', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' } });
    const run = { child, pending: null };
    run.ready = new Promise((resolve, reject) => { run.resolve = resolve; run.reject = reject; });
    this.run = run;
    const fail = error => {
      run.reject(error);
      run.pending?.reject(error);
      if (this.run === run) this.run = null;
    };
    run.reader = createInterface({ input: child.stdout });
    // Drain library diagnostics; do not persist incidental model/input output.
    child.stderr.resume();
    run.reader.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event === 'fatal') { fail(new Error(message.error)); this.stop(run); return; }
      if (message.event === 'ready') {
        if (message.protocol !== 2 || !message.runtime?.packages) { fail(new Error('Unsupported embedding worker protocol')); this.stop(run); return; }
        if (this.runtime && JSON.stringify(this.runtime) !== JSON.stringify(message.runtime)) { fail(new Error('Embedding dependencies changed; reload the bridge')); this.stop(run); return; }
        this.runtime = message.runtime;
        run.resolve(message.runtime);
      } else if (run.pending?.id === message.id) {
        if (message.error) run.pending.reject(new Error(message.error));
        else run.pending.resolve(run.pending.operation==='tokenize'?message.counts:message.vectors);
      }
    });
    child.once('error', fail);
    child.once('exit', () => { fail(new Error('Local embedding worker exited')); run.reader.close(); });
    const abort = () => this.stop(run);
    signal?.addEventListener('abort', abort, { once: true });
    try { return await run.ready; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  countTokens(texts, { signal }) { return this.embed(texts,{kind:'document',operation:'tokenize',signal}); }

  async embed(texts, { kind, signal, operation='embed' }) {
    await this.start(signal);
    signal?.throwIfAborted();
    const run = this.run;
    if (!run) throw new Error('Local embedding worker is unavailable');
    if (run.pending) throw new Error('Embedding worker already has an active request');
    const id = this.nextId++;
    const reply = new Promise((resolve, reject) => { run.pending = { id, operation, resolve, reject }; });
    const abort = () => this.stop(run);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      run.child.stdin.write(JSON.stringify({ id, texts, kind, operation }) + '\n', error => { if (error) run.pending?.reject(error); });
      return await reply;
    } finally { signal?.removeEventListener('abort', abort); run.pending = null; }
  }

  stop(run = this.run) {
    if (!run) return;
    if (this.run === run) this.run = null;
    run.reject(new Error('Embedding worker stopped'));
    run.pending?.reject(new Error('Embedding worker stopped'));
    try { run.child.kill(); } catch { /* already exited */ }
  }
  dispose() { this.disposed = true; this.stop(); }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

export class LlamaEmbeddingTransport {
  constructor({ spec, config, io = {}, beforeStart }) {
    Object.assign(this, { spec, config, beforeStart });
    this.io = { spawn, fetch, freePort, delay, ...io };
    this.policy = llamaRuntimeSettings(spec, config);
    this.run = null;
    this.starting = null;
    this.stopping = Promise.resolve();
    this.fallbackReason = null;
    this.disposed = false;
  }

  async start(signal) {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('Local embedding server is disposed');
    if (this.starting) return this.starting;
    if (this.run?.ready) return this.run;
    this.starting = (async () => {
      await this.stopping;
      this.fallbackReason = null;
      try {
        return await this.startDevice(this.policy.initialDevice, signal);
      } catch (error) {
        if (!this.canFallback(error, signal)) throw error;
        this.fallbackReason = { code: error.code, message: error.message };
        // startDevice awaits process exit on failure; never overlap CPU/GPU.
        return this.startDevice('cpu', signal);
      }
    })();
    try { return await this.starting; }
    finally { this.starting = null; }
  }

  canFallback(error, signal) {
    return this.policy.requestedDevice === 'auto' && !signal?.aborted && !this.disposed &&
      ['RAW_GPU_UNAVAILABLE', 'RAW_GPU_MEMORY'].includes(error.code);
  }

  startupError(run) {
    if (run.device === 'cuda') {
      if (run.gpuFailure) return deviceError(run.gpuFailure,
        run.gpuFailure === 'RAW_GPU_MEMORY' ? 'CUDA embedding memory allocation failed' : 'CUDA embedding device is unavailable');
      if (['ENOENT', 'EACCES'].includes(run.error?.code) || [3221225781, -1073741515].includes(run.exitCode)) {
        return deviceError('RAW_GPU_UNAVAILABLE', 'CUDA embedding runtime is unavailable');
      }
    }
    return new Error('Local llama-server failed to start' + (run.error?.code ? ': ' + run.error.code : ''));
  }

  async startDevice(device, signal) {
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('Local embedding server is disposed');
    const server = device === 'cuda' ? this.policy.cudaServer : this.policy.cpuServer;
    if (!server) throw deviceError(device === 'cuda' ? 'RAW_GPU_UNAVAILABLE' : 'RAW_CPU_UNAVAILABLE', 'Local ' + device + ' embedding runtime is not configured');
    await this.beforeStart?.({ server, device, signal });
    const port = await this.io.freePort();
    signal?.throwIfAborted();
    if (this.disposed) throw new Error('Local embedding server is disposed');
    const token = randomBytes(32).toString('hex');
    const threads = device === 'cuda' ? this.policy.gpuThreads : this.policy.cpuThreads;
    const gpuLayers = device === 'cuda' ? this.policy.gpuLayers : 0;
    const args = ['-m', this.config.rawRecallGgufModel, '--host', '127.0.0.1', '--port', String(port),
      '--embeddings', '--pooling', 'last', '--parallel', '1', '--alias', this.spec.id,
      '-c', String(this.config.rawRecallLlamaContext || 4096), '-b', String(this.config.rawRecallLlamaContext || 4096),
      '-ub', String(this.config.rawRecallLlamaContext || 4096), '-t', String(threads), '-tb', String(threads),
      '--poll', '0', '--poll-batch', '0', '-ngl', String(gpuLayers), '-lv', '5', '--api-key', token];
    if (device === 'cuda') args.push('--device', 'CUDA0');
    const child = this.io.spawn(server, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const run = { child, server, device, threads, batchThreads: threads, gpuLayers, port, token,
      ready: false, error: null, offloadedLayers: 0, base: 'http://127.0.0.1:' + port };
    this.run = run;
    run.closed = new Promise(resolve => {
      child.once('error', error => { run.error = error; });
      child.once('close', code => { run.exited = true; run.exitCode = code; if (this.run === run) this.run = null; resolve(); });
    });
    // Parse only resource/device facts. Never retain diagnostics containing
    // paths, credentials, or (after startup) incidental request text.
    let tail = '';
    child.stderr?.on('data', chunk => {
      const lines = (tail + chunk.toString()).split(/\r?\n/u); tail = lines.pop().slice(-2048);
      for (const line of lines) {
        const layers = line.match(/offloaded\s+(\d+)\/\d+\s+layers to GPU/iu);
        if (layers) run.offloadedLayers = Number(layers[1]);
        if (/(?:CUDA.*(?:out of memory|allocat.*fail)|(?:cudaMalloc|cuMem\w*).*fail|out of (?:device |GPU )memory)/iu.test(line)) run.gpuFailure = 'RAW_GPU_MEMORY';
        if (/(?:no (?:usable |CUDA[- ]capable )?(?:GPU|CUDA device|device is detected)|CUDA.*(?:not available|not found|no.*device|driver.*(?:insufficient|fail)|initialization error)|CUDA_ERROR_(?:NO_DEVICE|INSUFFICIENT_DRIVER|INITIALIZATION_ERROR)|not compiled with.*(?:CUDA|GPU)|invalid device.*CUDA|device.*CUDA.*not found)/iu.test(line)) run.gpuFailure ||= 'RAW_GPU_UNAVAILABLE';
      }
    });
    const abort = () => { this.stop(run).catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      while (true) {
        signal?.throwIfAborted();
        if (this.disposed || run.exited || run.error || run.gpuFailure) throw this.startupError(run);
        let response;
        try { response = await this.io.fetch(run.base + '/health', { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)].filter(Boolean)) }); }
        catch (error) { if (signal?.aborted) throw error; }
        if (response?.ok) {
          const proof = await this.io.fetch(run.base + '/v1/models', { headers: { authorization: 'Bearer ' + token },
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)].filter(Boolean)) });
          if (!proof.ok) throw new Error('Local embedding server authentication failed');
          const metadata = await proof.json();
          if (!Array.isArray(metadata.data) || !metadata.data.some(model => model.id === this.spec.id)) throw new Error('Local embedding server model alias mismatch');
          if (run.exited || run.error || run.gpuFailure) throw this.startupError(run);
          if (device === 'cuda' && !run.offloadedLayers) throw deviceError('RAW_GPU_UNAVAILABLE', 'CUDA runtime did not offload embedding layers');
          run.ready = true;
          return run;
        }
        await this.io.delay(200, undefined, { signal });
      }
    } catch (error) { await this.stop(run); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  async embed(texts, { kind, signal }) {
    const run = await this.start(signal);
    const input = texts; // Query formatting is owned once by EmbeddingBackend.
    const counts=await this.countTokens(input,{signal});
    if(counts.some(count=>count>this.spec.maxTokens))throw new Error('Embedding input exceeds configured token limit');
    if (this.run !== run || run.exited || run.error) throw new Error('Local embedding server is unavailable');
    return requestEmbeddingService({ baseUrl: run.base + '/v1', model: this.spec.id, texts: input,
      dimensions: this.spec.dimensions, apiKey: run.token, signal, fetchImpl: this.io.fetch });
  }

  async countTokens(texts,{signal}){
    const run=await this.start(signal),counts=[];
    for(const text of texts){
      const result=await this.request(run,'/tokenize',{content:text,add_special:true},signal);
      if(!Array.isArray(result.tokens))throw new Error('Invalid local tokenizer response');
      counts.push(result.tokens.length);
    }
    return counts;
  }

  async request(run, route, body, signal) {
    signal?.throwIfAborted();
    if (this.run !== run || run.exited || run.error) throw new Error('Local embedding server is unavailable');
    const response = await this.io.fetch(run.base + route, { method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + run.token }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error('Local embedding HTTP ' + response.status);
    return response.json();
  }
  status() {
    const run = this.run;
    return { requestedDevice: this.policy.requestedDevice, actualDevice: run?.ready && !run.exited ? run.device : null,
      fallbackReason: this.fallbackReason, runtime: run?.ready && !run.exited ? {
        device: run.device, server: run.server, threads: run.threads, batchThreads: run.batchThreads,
        gpuLayers: run.device === 'cuda' ? run.offloadedLayers : 0 } : null };
  }

  stop(run = this.run) {
    if (!run) return this.stopping;
    if (run.stopping) return run.stopping;
    if (this.run === run) this.run = null;
    run.stopping = (async () => {
      if (run.exited) return;
      try { run.child.kill(); } catch { /* wait for confirmed closure below */ }
      let timeout;
      try { await Promise.race([run.closed, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Local embedding server did not exit')), 5000);
      })]); } finally { clearTimeout(timeout); }
    })();
    this.stopping = run.stopping;
    return run.stopping;
  }
  dispose() { this.disposed = true; return this.stop(); }
}

function deviceError(code, message) { return Object.assign(new Error(message), { code }); }

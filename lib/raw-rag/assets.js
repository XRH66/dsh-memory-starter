import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { identityDigest, modelIdentity } from './models.js';

async function filesUnder(directory, prefix = '') {
  const out = [];
  for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix + item.name, file = path.join(directory, item.name);
    if (item.isDirectory()) out.push(...await filesUnder(file, name + '/'));
    else if (item.isFile() || item.isSymbolicLink()) out.push({ name, file });
    if (out.length > 256) throw new Error('Embedding asset directory contains too many files; select the model snapshot directory');
  }
  return out;
}

export async function bgeModelDirectory(config) {
  if (config.rawRecallBgeModelDir) return path.resolve(config.rawRecallBgeModelDir);
  const cache = path.resolve(config.rawRecallCacheDir || process.env.FASTEMBED_CACHE_PATH || path.join(os.tmpdir(), 'fastembed_cache'));
  const entries = await fs.readdir(cache, { withFileTypes: true });
  const model = entries.find(entry => entry.isDirectory() && entry.name.toLowerCase() === 'models--qdrant--bge-small-zh-v1.5');
  if (!model) throw new Error('BGE assets not found; configure rawRecallBgeModelDir or its existing FastEmbed cache');
  const revision = (await fs.readFile(path.join(cache, model.name, 'refs', 'main'), 'utf8')).trim();
  if (!/^[a-f0-9]{40,64}$/i.test(revision)) throw new Error('Invalid BGE snapshot revision');
  return path.join(cache, model.name, 'snapshots', revision);
}

async function stamp(file) {
  const real = await fs.realpath(file), stat = await fs.stat(real, { bigint: true });
  if (!stat.isFile()) throw new Error('Embedding asset is not a file');
  return { real, size: stat.size.toString(), mtime: stat.mtimeNs.toString(), ctime: stat.ctimeNs.toString() };
}
const sameStamp = (a, b) => a.real === b.real && a.size === b.size && a.mtime === b.mtime && a.ctime === b.ctime;

// Read weights once when necessary, never synchronously on every query. Cache
// only hashes and file stamps, not input text, credentials, or model contents.
export async function identifyAssets(entries, cacheFile, signal) {
  let cache = {};
  if (cacheFile) try { const saved=JSON.parse(await fs.readFile(cacheFile, 'utf8')); if(saved&&typeof saved==='object'&&!Array.isArray(saved))cache=saved; } catch { /* optional cache */ }
  const stamps = [], hashes = [];
  for (const entry of entries) {
    signal?.throwIfAborted();
    const before = await stamp(entry.file);
    let hash = cache[before.real]?.hash;
    if (!/^[a-f0-9]{64}$/.test(hash||'') || !sameStamp(before, cache[before.real])) {
      const digest = createHash('sha256');
      for await (const chunk of createReadStream(before.real)) { signal?.throwIfAborted(); digest.update(chunk); }
      hash = digest.digest('hex');
    }
    if (!sameStamp(before, await stamp(entry.file))) throw new Error('Embedding assets changed during preparation');
    stamps.push({ file: entry.file, ...before });
    hashes.push({ name: entry.name, sha256: hash });
    cache[before.real] = { ...before, hash };
  }
  if (cacheFile) {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const temporary = cacheFile + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify(cache), { mode: 0o600 });
    await fs.rename(temporary, cacheFile);
  }
  return { hashes, stamps };
}

export async function assertAssetsCurrent(stamps) {
  for (const saved of stamps || []) if (!sameStamp(saved, await stamp(saved.file))) {
    const error = new Error('Embedding assets changed; reload the bridge to prepare a new model identity');
    error.code = 'RAW_MODEL_CHANGED';
    throw error;
  }
}

export async function embeddingAssets(spec, config, workerFile, { server: selectedServer } = {}) {
  if (spec.engine === 'fastembed') {
    const directory = await bgeModelDirectory(config);
    await fs.access(path.join(directory, 'model_optimized.onnx'));
    await fs.access(path.join(directory, 'tokenizer.json'));
    return { directory, entries: [...await filesUnder(directory), { name: 'bridge-worker.py', file: workerFile }] };
  }
  if (spec.engine === 'onnx') {
    if (!config.rawRecallOnnxModel || !config.rawRecallOnnxTokenizer) throw new Error('Qwen 0.6B needs local ONNX model and tokenizer paths');
    const model = path.resolve(config.rawRecallOnnxModel), tokenizer = path.resolve(config.rawRecallOnnxTokenizer);
    await fs.access(model);
    await fs.access(tokenizer);
    // Include external ONNX tensor data/config files in this dedicated asset
    // directory; do not silently treat a replaced sidecar as the same weights.
    const entries = [{ name: 'selected-model.onnx', file: model }, { name: 'selected-tokenizer.json', file: tokenizer },
      ...(await filesUnder(path.dirname(model))).filter(entry => path.resolve(entry.file)!==tokenizer && /\.(?:onnx_data|data|json|txt|model)$/i.test(entry.name))];
    entries.push({ name: 'bridge-worker.py', file: workerFile });
    return { entries };
  }
  if (spec.engine === 'llamacpp') {
    const chosen = selectedServer || config.rawRecallLlamaServer || config.rawRecallLlamaCpuServer || config.rawRecallLlamaCudaServer;
    if (!config.rawRecallGgufModel || !chosen) throw new Error('Qwen GGUF needs local model and llama-server paths');
    const server = path.resolve(chosen);
    const libraries = (await fs.readdir(path.dirname(server))).filter(name => /\.(?:dll|so|dylib)$/i.test(name));
    return { entries: [{ name: 'embedding.gguf', file: path.resolve(config.rawRecallGgufModel) }, { name: 'llama-server', file: server },
      ...libraries.sort().map(name => ({ name: 'runtime/' + name, file: path.join(path.dirname(server), name) }))] };
  }
  return { entries: [] };
}

/** Public canaries only, never private text. The caller probes the already
 * loaded instance; this function never loads a second CPU/GPU model. */
export const DEVICE_PROBES = Object.freeze([
  { kind: 'document', text: '小猫在窗边看雨。The train arrives at noon.' },
  { kind: 'query', text: '上次讨论的计划是什么？' },
]);
// Public Q4_K_M checks on the pinned b12102 CPU/CUDA builds measured
// 0.998418 / 0.996540. Keep the accepted device drift explicit.
// This is a device encoding tolerance, not a retrieval-quality benchmark.
export const DEVICE_COMPATIBILITY_MIN_COSINE = 0.995;

function similarities(reference, actual, dimensions) {
  if (!Array.isArray(reference) || !Array.isArray(actual) || reference.length !== DEVICE_PROBES.length || actual.length !== reference.length) return null;
  const values = reference.map((left, i) => {
    const right = actual[i];
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== dimensions || right.length !== dimensions) return NaN;
    let dot = 0, a = 0, b = 0;
    for (let j = 0; j < dimensions; j++) {
      if (!Number.isFinite(left[j]) || !Number.isFinite(right[j])) return NaN;
      dot += left[j] * right[j]; a += left[j] ** 2; b += right[j] ** 2;
    }
    return a > 0 && b > 0 ? dot / Math.sqrt(a * b) : NaN;
  });
  return values.every(Number.isFinite) ? values : null;
}
const compatibleScores = values => Array.isArray(values) && values.length === DEVICE_PROBES.length &&
  values.every(value => Number.isFinite(value) && value >= DEVICE_COMPATIBILITY_MIN_COSINE);
const compatible = (reference, actual, dimensions) => compatibleScores(similarities(reference, actual, dimensions));

/** The anchor identity remains tied to its complete original runtime digest.
 * A different runtime/device can use that space only after a bounded numerical
 * compatibility check with the SAME weights and full encoding contract. New
 * schema-3 keys deliberately do not borrow schema-2 historical indexes.
 * Share cacheFile across runtime-only revisions to retain verified receipts. */
export async function identifyDeviceSpace({ contract, hashes, runtime, cacheFile, ledger, probe, signal }) {
  const weights = hashes.filter(item => item.name === 'embedding.gguf');
  if (weights.length !== 1) throw new Error('Missing GGUF encoding weight identity');
  const encoding = { ...contract, schema: 3 };
  const adapter = { adapter: 'llama-server-embeddings-v2', context: runtime.context };
  const encodingKey = identityDigest({ encoding, weights, adapter });
  const runtimeKey = identityDigest({ assets: hashes.filter(item => item.name !== 'embedding.gguf'),
    device: runtime.device, gpuLayers: runtime.gpuLayers || 0, ...adapter });
  if (!ledger.spaces) {
    let saved;
    if (cacheFile) try { saved = JSON.parse(await fs.readFile(cacheFile, 'utf8')); } catch { /* no previous verified space */ }
    ledger.spaces = saved?.schema === 1 && saved.spaces && typeof saved.spaces === 'object' && !Array.isArray(saved.spaces) ? saved.spaces : {};
  }
  const space = ledger.spaces[encodingKey];
  const strict = modelIdentity(encoding, weights, { ...adapter, encodingRuntime: runtimeKey });
  const anchor = space && typeof space.anchorRuntime === 'string' && /^[a-f0-9]{64}$/u.test(space.anchorRuntime)
    ? modelIdentity(encoding, weights, { ...adapter, encodingRuntime: space.anchorRuntime }) : null;
  if (anchor && compatible(space.reference, space.reference, contract.dimensions) && compatibleScores(space.verified?.[runtimeKey])) {
    return { identity: anchor, runtimeKey, cosines: space.verified[runtimeKey], minCosine: DEVICE_COMPATIBILITY_MIN_COSINE,
      compatibility: space.anchorRuntime === runtimeKey ? 'reference' : 'verified' };
  }
  signal?.throwIfAborted();
  const vectors = await probe();
  signal?.throwIfAborted();
  if (!compatible(vectors, vectors, contract.dimensions)) throw new Error('Invalid device compatibility probe vectors');
  let identity = strict, compatibility = 'reference';
  const cosines = anchor ? similarities(space.reference, vectors, contract.dimensions) : [1, 1];
  if (anchor && compatibleScores(cosines)) {
    if (!space.verified || Array.isArray(space.verified) || typeof space.verified !== 'object') space.verified = {};
    space.verified[runtimeKey] = cosines;
    identity = anchor; compatibility = 'verified';
  } else if (!anchor) {
    ledger.spaces[encodingKey] = { anchorRuntime: runtimeKey, reference: vectors, verified: { [runtimeKey]: cosines } };
  } else {
    // Keep the original reference intact. An incompatible device gets its own
    // space, rather than overwriting or silently reading the anchor's index.
    compatibility = 'incompatible';
  }
  if (cacheFile && compatibility !== 'incompatible') {
    await fs.mkdir(path.dirname(cacheFile), { recursive: true });
    const temporary = cacheFile + '.' + randomUUID() + '.tmp';
    await fs.writeFile(temporary, JSON.stringify({ schema: 1, spaces: ledger.spaces }), { mode: 0o600 });
    await fs.rename(temporary, cacheFile);
  }
  return { identity, runtimeKey, compatibility, cosines, minCosine: DEVICE_COMPATIBILITY_MIN_COSINE };
}

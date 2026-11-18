// Memory map layout: pure functions, no I/O. Runs inside the layout worker.
// Neighbour graph + UMAP-style force layout (same family as UMAP: fuzzy kNN
// graph optimised with attractive/repulsive SGD), cosine k-means and keyword
// picking. Deterministic for the same input and seed.

export const LAYOUT_ALGORITHM_VERSION = 'map-layout-1';
const PROJECTED_DIMENSIONS = 128;
const NEIGHBORS = 15;
export const NEAR_LIMIT = 8;
const DEPTH_NEIGHBORS = 5;
const CURVE_A = 1.4, CURVE_B = 0.9;
const TARGET_MEDIAN_RADIUS = 50;

export function seededRandom(seed) {
  let s = seed | 0;
  return () => {
    s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
export function seedFrom(text) {
  let h = 2166136261;
  for (const ch of String(text)) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h | 0;
}
function gaussian(random) {
  let u = 0; while (!u) u = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

/** Normalise each row in place; zero rows stay zero. */
export function normalizeRows(data, n, d) {
  for (let i = 0; i < n; i++) {
    let sum = 0; const o = i * d;
    for (let q = 0; q < d; q++) sum += data[o + q] * data[o + q];
    const scale = sum > 0 ? 1 / Math.sqrt(sum) : 0;
    for (let q = 0; q < d; q++) data[o + q] *= scale;
  }
  return data;
}

/** Gaussian random projection (Johnson–Lindenstrauss), rows re-normalised. */
export function projectRows(data, n, d, target, random) {
  if (d <= target) return { data: Float32Array.from(data), d };
  const matrix = new Float32Array(d * target);
  for (let i = 0; i < matrix.length; i++) matrix[i] = gaussian(random);
  const out = new Float32Array(n * target);
  for (let i = 0; i < n; i++) {
    const o = i * d, p = i * target;
    for (let q = 0; q < d; q++) {
      const v = data[o + q]; if (!v) continue;
      const m = q * target;
      for (let t = 0; t < target; t++) out[p + t] += v * matrix[m + t];
    }
  }
  return { data: normalizeRows(out, n, target), d: target };
}

function dot(a, ao, b, bo, d) {
  let s = 0;
  for (let q = 0; q < d; q++) s += a[ao + q] * b[bo + q];
  return s;
}

/** Top-k by similarity. Exact when cheap, otherwise candidates come from a
 * random projection and are re-scored exactly on the full vectors. */
export function nearestNeighbors(data, n, d, k, { random = seededRandom(1), progress } = {}) {
  k = Math.max(0, Math.min(k, n - 1));
  const idx = new Int32Array(n * k).fill(-1), sim = new Float32Array(n * k).fill(-Infinity);
  if (!k) return { idx, sim, k };
  const exact = n * n * d <= 1.5e9;
  const space = exact ? { data, d } : projectRows(data, n, d, PROJECTED_DIMENSIONS, random);
  const wide = exact ? k : Math.min(n - 1, k + 8);
  const candIdx = new Int32Array(n * wide).fill(-1), candSim = new Float32Array(n * wide).fill(-Infinity);
  const insert = (row, j, s) => {
    const o = row * wide;
    if (s <= candSim[o + wide - 1]) return;
    let p = wide - 1;
    while (p > 0 && candSim[o + p - 1] < s) { candSim[o + p] = candSim[o + p - 1]; candIdx[o + p] = candIdx[o + p - 1]; p--; }
    candSim[o + p] = s; candIdx[o + p] = j;
  };
  for (let i = 0; i < n; i++) {
    const io = i * space.d;
    for (let j = i + 1; j < n; j++) {
      const s = dot(space.data, io, space.data, j * space.d, space.d);
      insert(i, j, s); insert(j, i, s);
    }
    if (progress && i % 256 === 0) progress(i, n);
  }
  for (let i = 0; i < n; i++) {
    const row = [];
    for (let c = 0; c < wide; c++) {
      const j = candIdx[i * wide + c]; if (j < 0) continue;
      row.push([j, exact ? candSim[i * wide + c] : dot(data, i * d, data, j * d, d)]);
    }
    row.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    row.slice(0, k).forEach(([j, s], c) => { idx[i * k + c] = j; sim[i * k + c] = s; });
  }
  return { idx, sim, k };
}

/** UMAP fuzzy simplicial set from a kNN graph, symmetrised (a + b − ab). */
export function fuzzyGraph({ idx, sim, k }, n) {
  const weights = new Map(), target = Math.log2(Math.max(2, k));
  for (let i = 0; i < n; i++) {
    const o = i * k, dist = [];
    for (let c = 0; c < k; c++) if (idx[o + c] >= 0) dist.push(Math.max(0, 1 - sim[o + c]));
    if (!dist.length) continue;
    const rho = dist.find(v => v > 0) ?? 0;
    let lo = 0, hi = Infinity, sigma = 1;
    for (let iter = 0; iter < 64; iter++) {
      let sum = 0;
      for (const v of dist) sum += Math.exp(-Math.max(0, v - rho) / sigma);
      if (Math.abs(sum - target) < 1e-5) break;
      if (sum > target) { hi = sigma; sigma = (lo + hi) / 2; }
      else { lo = sigma; sigma = hi === Infinity ? sigma * 2 : (lo + hi) / 2; }
    }
    sigma = Math.max(sigma, 1e-3 * (dist.reduce((a, b) => a + b, 0) / dist.length || 1));
    for (let c = 0; c < dist.length; c++) {
      const j = idx[o + c], w = Math.exp(-Math.max(0, dist[c] - rho) / sigma);
      weights.set(i * n + j, w);
    }
  }
  const heads = [], tails = [], values = [];
  for (const [key, w] of weights) {
    const i = Math.floor(key / n), j = key - i * n;
    if (i > j && weights.has(j * n + i)) continue;
    const back = weights.get(j * n + i) ?? 0, value = w + back - w * back;
    heads.push(i); tails.push(j); values.push(value);
  }
  return { heads: Int32Array.from(heads), tails: Int32Array.from(tails), weights: Float32Array.from(values) };
}

/** First `dims` principal components (power iteration with deflation). */
export function principalComponents(data, n, d, dims, random) {
  const mean = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let q = 0; q < d; q++) mean[q] += data[i * d + q] / n;
  const out = new Float32Array(n * dims), components = [];
  for (let c = 0; c < dims; c++) {
    let v = new Float64Array(d).map(() => gaussian(random));
    for (let iter = 0; iter < 40; iter++) {
      const next = new Float64Array(d);
      for (let i = 0; i < n; i++) {
        let s = 0; const o = i * d;
        for (let q = 0; q < d; q++) s += (data[o + q] - mean[q]) * v[q];
        for (let q = 0; q < d; q++) next[q] += s * (data[o + q] - mean[q]);
      }
      for (const prev of components) {
        let s = 0; for (let q = 0; q < d; q++) s += next[q] * prev[q];
        for (let q = 0; q < d; q++) next[q] -= s * prev[q];
      }
      let norm = 0; for (let q = 0; q < d; q++) norm += next[q] * next[q];
      norm = Math.sqrt(norm); if (!norm) break;
      for (let q = 0; q < d; q++) next[q] /= norm;
      v = next;
    }
    components.push(v);
    for (let i = 0; i < n; i++) {
      let s = 0; const o = i * d;
      for (let q = 0; q < d; q++) s += (data[o + q] - mean[q]) * v[q];
      out[i * dims + c] = s;
    }
  }
  let max = 0; for (const v of out) max = Math.max(max, Math.abs(v));
  const scale = max ? 10 / max : 1;
  for (let i = 0; i < out.length; i++) out[i] = out[i] * scale + (random() - 0.5) * 1e-3;
  return out;
}

const clip = v => v > 4 ? 4 : v < -4 ? -4 : v;
/** UMAP-style SGD over the fuzzy graph with negative sampling. Mutates embedding. */
export function optimizeLayout(embedding, n, dims, graph, { epochs, random, alpha = 1, negativeRate = 5, progress } = {}) {
  const { heads, tails, weights } = graph;
  if (!heads.length || n < 3) return embedding;
  let max = 0; for (const w of weights) max = Math.max(max, w);
  const every = new Float32Array(heads.length), next = new Float32Array(heads.length);
  const negEvery = new Float32Array(heads.length), negNext = new Float32Array(heads.length);
  for (let e = 0; e < heads.length; e++) {
    const perSample = weights[e] > max / epochs ? max / weights[e] : -1;
    every[e] = perSample; next[e] = perSample;
    negEvery[e] = perSample / negativeRate; negNext[e] = negEvery[e];
  }
  for (let epoch = 0; epoch < epochs; epoch++) {
    const rate = alpha * (1 - epoch / epochs);
    for (let e = 0; e < heads.length; e++) {
      if (every[e] < 0 || next[e] > epoch + 1) continue;
      const i = heads[e], j = tails[e];
      let dist = 0;
      for (let q = 0; q < dims; q++) { const t = embedding[i * dims + q] - embedding[j * dims + q]; dist += t * t; }
      if (dist > 0) {
        const coeff = -2 * CURVE_A * CURVE_B * Math.pow(dist, CURVE_B - 1) / (CURVE_A * Math.pow(dist, CURVE_B) + 1);
        for (let q = 0; q < dims; q++) {
          const g = clip(coeff * (embedding[i * dims + q] - embedding[j * dims + q])) * rate;
          embedding[i * dims + q] += g; embedding[j * dims + q] -= g;
        }
      }
      next[e] += every[e];
      const samples = Math.floor((epoch + 1 - negNext[e]) / negEvery[e]);
      for (let s = 0; s < samples; s++) {
        const m = Math.floor(random() * n); if (m === i) continue;
        let d2 = 0;
        for (let q = 0; q < dims; q++) { const t = embedding[i * dims + q] - embedding[m * dims + q]; d2 += t * t; }
        const coeff = d2 > 0 ? 2 * CURVE_B / ((0.001 + d2) * (CURVE_A * Math.pow(d2, CURVE_B) + 1)) : 0;
        for (let q = 0; q < dims; q++) {
          const g = coeff > 0 ? clip(coeff * (embedding[i * dims + q] - embedding[m * dims + q])) : 4;
          embedding[i * dims + q] += g * rate;
        }
      }
      negNext[e] += samples * negEvery[e];
    }
    if (progress && epoch % 20 === 0) progress(epoch, epochs);
  }
  return embedding;
}

/** Cosine k-means with k-means++ seeding. Labels ordered by cluster size (largest first). */
export function clusterRows(data, n, d, k, random) {
  k = Math.max(1, Math.min(k, n));
  const centers = new Float32Array(k * d), labels = new Int32Array(n), best = new Float32Array(n).fill(-Infinity);
  const first = Math.floor(random() * n);
  centers.set(data.subarray(first * d, first * d + d), 0);
  for (let c = 1; c < k; c++) {
    let total = 0; const weights = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      best[i] = Math.max(best[i], dot(data, i * d, centers, (c - 1) * d, d));
      weights[i] = Math.max(0, 1 - best[i]) ** 2; total += weights[i];
    }
    let pick = random() * total, chosen = n - 1;
    for (let i = 0; i < n; i++) { pick -= weights[i]; if (pick <= 0) { chosen = i; break; } }
    centers.set(data.subarray(chosen * d, chosen * d + d), c * d);
  }
  for (let iter = 0; iter < 25; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let label = 0, top = -Infinity;
      for (let c = 0; c < k; c++) { const s = dot(data, i * d, centers, c * d, d); if (s > top) { top = s; label = c; } }
      if (labels[i] !== label || iter === 0) { changed++; labels[i] = label; }
    }
    centers.fill(0);
    const counts = new Int32Array(k);
    for (let i = 0; i < n; i++) { counts[labels[i]]++; for (let q = 0; q < d; q++) centers[labels[i] * d + q] += data[i * d + q]; }
    for (let c = 0; c < k; c++) if (!counts[c]) { const r = Math.floor(random() * n); centers.set(data.subarray(r * d, r * d + d), c * d); }
    normalizeRows(centers, k, d);
    if (!changed && iter) break;
  }
  const sizes = new Int32Array(k); for (const label of labels) sizes[label]++;
  const order = [...sizes.keys()].filter(c => sizes[c] > 0).sort((a, b) => sizes[b] - sizes[a] || a - b);
  const remap = new Int32Array(k).fill(-1); order.forEach((c, r) => { remap[c] = r; });
  for (let i = 0; i < n; i++) labels[i] = remap[labels[i]];
  return { labels, count: order.length };
}
export const clusterCount = n => Math.max(Math.min(3, n), Math.min(16, Math.round(Math.sqrt(n / 2.5))));

const STOP = new Set(('今天 明天 昨天 这个 那个 一下 一点 还是 已经 觉得 感觉 可以 时候 现在 因为 所以 如果 但是 不过 就是 其实 然后 这样 那样 什么 怎么 没有 不是 自己 一些 比较 一直 确实 可能 应该 知道 东西 事情 时间 我们 你们 他们 这里 那里 不用 不要 需要 记得 起来 出来 下来 一起 直接 先把 之后 之前 最近 有点 好像 一般 继续 顺手 再说 这次 那次 还有 只是 也许 当然 而且 一样 这种 那种 先记 记一下 看看 想想 试试 准备 打算 下午 上午 晚上 早上 中午 今晚 一个 免得 以后 重新 确认 包含 位置 空间 一次 两个 几个 地方 问题 情况 方便 估计 '
  + '你好 谢谢 好的 是的 对的 这些 那些 或者 还要 已经 可以 不会 能够 为了 以及 另外 比如 例如 关于 进行 我的 你的 他的 她的 它的 一种 一下子 怎么样 为什么 这么 那么 多少 一样 只要 只有 然而 此外 同时 部分 方面 内容 时候 这边 那边 用户 助手').split(' '));
const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
function words(text) {
  const out = new Set();
  if (!text) return out;
  const clean = String(text).slice(0, 2000);
  if (segmenter) {
    for (const s of segmenter.segment(clean)) {
      const w = s.segment;
      if (s.isWordLike && w.length >= 2 && w.length <= 12 && !STOP.has(w) && !/^[0-9a-z_.\-]+$/i.test(w)) out.add(w);
    }
  } else for (const w of clean.match(/[\p{Script=Han}]{2,4}|[A-Za-z][A-Za-z0-9]{2,}/gu) ?? []) if (!STOP.has(w)) out.add(w);
  return out;
}
/** Per cluster: words frequent inside it and rare in other clusters (tf-idf over clusters). */
export function clusterKeywords(texts, labels, count, limit = 3) {
  const tf = Array.from({ length: count }, () => new Map()), sizes = new Int32Array(count);
  texts.forEach((text, i) => {
    const c = labels[i]; if (c < 0) return; sizes[c]++;
    for (const w of words(text)) tf[c].set(w, (tf[c].get(w) ?? 0) + 1);
  });
  const df = new Map();
  tf.forEach(map => map.forEach((_, w) => df.set(w, (df.get(w) ?? 0) + 1)));
  return tf.map((map, c) => [...map]
    .filter(([, n]) => n >= 2 || sizes[c] < 4)
    .map(([w, n]) => [w, n * Math.log(1 + count / df.get(w))])
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit).map(([w]) => w));
}

/** Memory depth from the near lists: see MEMORY-MAP.zh-CN.md. */
export function memoryDepth(near, n) {
  if (n === 1) return new Float32Array([1]);
  const score = new Float64Array(n);
  near.forEach((list, i) => list.slice(0, DEPTH_NEIGHBORS).forEach(([j, s]) => {
    const w = Math.max(0, (s - 0.5) / 0.5); score[i] += w; score[j] += w;
  }));
  const order = [...score.keys()].sort((a, b) => score[a] - score[b] || a - b), depth = new Float32Array(n);
  order.forEach((i, rank) => { depth[i] = Math.pow(rank / Math.max(1, n - 1), 1.6); });
  return depth;
}

/** Centre at the origin and scale so the median radius is TARGET_MEDIAN_RADIUS. */
export function scaleLayout(embedding, n, dims) {
  const out = Float32Array.from(embedding), mean = new Float64Array(dims);
  for (let i = 0; i < n; i++) for (let q = 0; q < dims; q++) mean[q] += out[i * dims + q] / n;
  const radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let q = 0; q < dims; q++) { out[i * dims + q] -= mean[q]; r += out[i * dims + q] ** 2; }
    radii[i] = Math.sqrt(r);
  }
  const sorted = Float64Array.from(radii).sort(), median = sorted[Math.floor(n / 2)] || 1;
  const scale = TARGET_MEDIAN_RADIUS / median;
  for (let i = 0; i < out.length; i++) out[i] *= scale;
  return out;
}

/** Warm start: known ids keep their previous raw position, new ones sit at the mean of known neighbours. */
function warmStart(previous, ids, knn, dims, random, fallback) {
  if (!previous) return null;
  const n = ids.length, out = new Float32Array(n * dims), known = new Uint8Array(n);
  let count = 0;
  ids.forEach((id, i) => {
    const p = previous.get(id);
    if (Array.isArray(p) && p.length === dims && p.every(Number.isFinite)) { out.set(p, i * dims); known[i] = 1; count++; }
  });
  if (count < Math.max(3, n * 0.5)) return null;
  for (let i = 0; i < n; i++) {
    if (known[i]) continue;
    let m = 0;
    for (let c = 0; c < knn.k; c++) {
      const j = knn.idx[i * knn.k + c];
      if (j < 0 || !known[j]) continue;
      for (let q = 0; q < dims; q++) out[i * dims + q] += out[j * dims + q];
      m++;
    }
    for (let q = 0; q < dims; q++) out[i * dims + q] = m ? out[i * dims + q] / m + (random() - 0.5) * 0.4 : fallback[i * dims + q];
  }
  return out;
}

/**
 * Build the whole layout. vectors: Float32Array(n*d), already one per item.
 * previous: {raw3: Map(id→[x,y,z]), raw2: Map(id→[x,y])} from the last cache.
 */
export function buildLayout({ ids, vectors, dimensions: d, texts, previous, seed = 1, progress = () => {} }) {
  const n = ids.length;
  const random = seededRandom(seed);
  if (!n) return { pos: new Float32Array(0), pos2: new Float32Array(0), raw3: new Float32Array(0), raw2: new Float32Array(0), near: [], labels: new Int32Array(0), keywords: [], depth: new Float32Array(0), incremental: false, clusters: 0 };
  normalizeRows(vectors, n, d);
  progress('neighbors', 0, n);
  const knn = nearestNeighbors(vectors, n, d, NEIGHBORS, { random, progress: (i, total) => progress('neighbors', i, total) });
  const near = Array.from({ length: n }, (_, i) => {
    const row = [];
    for (let c = 0; c < Math.min(NEAR_LIMIT, knn.k); c++) {
      const j = knn.idx[i * knn.k + c];
      if (j >= 0) row.push([j, Math.round(Math.max(-1, Math.min(1, knn.sim[i * knn.k + c])) * 1000) / 1000]);
    }
    return row;
  });
  const graph = fuzzyGraph(knn, n);
  const compact = projectRows(vectors, n, d, PROJECTED_DIMENSIONS, random);
  progress('layout', 0, 1);
  const pca = principalComponents(compact.data, n, compact.d, 3, random);
  const pca2 = new Float32Array(n * 2); for (let i = 0; i < n; i++) { pca2[i * 2] = pca[i * 3]; pca2[i * 2 + 1] = pca[i * 3 + 1]; }
  const warm3 = warmStart(previous?.raw3, ids, knn, 3, random, pca), warm2 = warmStart(previous?.raw2, ids, knn, 2, random, pca2);
  const incremental = Boolean(warm3 && warm2);
  const epochs = incremental ? 120 : n > 5000 ? 200 : 400;
  const raw3 = optimizeLayout(warm3 ?? pca, n, 3, graph, { epochs, random, alpha: incremental ? 0.35 : 1,
    progress: (e, total) => progress('layout', e, total * 2) });
  const raw2 = optimizeLayout(warm2 ?? pca2, n, 2, graph, { epochs, random, alpha: incremental ? 0.35 : 1,
    progress: (e, total) => progress('layout', total + e, total * 2) });
  progress('clusters', 0, 1);
  const { labels, count } = clusterRows(compact.data, n, compact.d, clusterCount(n), random);
  const keywords = clusterKeywords(texts, labels, count);
  return { pos: scaleLayout(raw3, n, 3), pos2: scaleLayout(raw2, n, 2), raw3, raw2, near, labels, clusters: count, keywords,
    depth: memoryDepth(near, n), incremental };
}

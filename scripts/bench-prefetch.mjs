import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {createMemoryQueryAnswer} from '../lib/memory-query.js';
import {resolveConfig} from '../lib/config.js';
import {lexicalMatch} from '../lib/raw-rag/lexical.js';

const ROUNDS = 2000, ENTRIES = 300, SAMPLES = 50, LIMIT = 4;

function option(name, fallback) {
  const prefix = `--${name}=`, found = process.argv.slice(2).find(value => value.startsWith(prefix));
  if (found === undefined) return fallback;
  const value = Number(found.slice(prefix.length));
  if (!Number.isFinite(value) || value < 0) throw Error(`Invalid --${name}`);
  return value;
}

const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.max(0, Math.ceil(fraction * ordered.length) - 1)] ?? 0;
};
const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const rounded = value => Math.round(value * 100) / 100;

function sourceRecord(index, role) {
  const id = `${role}-${index}`;
  return {
    id, revision: 1, messageId: id, sessionId: 'bench-session', sequence: index * 2 + (role === 'user' ? 1 : 2),
    turn: index + 1, role, text: role === 'user'
      ? `虚构第 ${index} 轮：阿岑记录了虚构事项 ${index}，仅用于离线测速。`
      : `虚构回复 ${index}：已记录阿岑的虚构事项，仅用于离线测速。`,
    time: Date.UTC(2026, 0, 1) + index * 1000, completion: 'completed', weight: 1,
    ref: {storage: 'message', id, revision: 1},
  };
}

function entryRecord(index, source) {
  return {
    id: `bench-entry-${index}`, revision: `bench-revision-${index}`,
    content: `虚构条目 ${index}：阿岑整理了离线测速事项。`,
    type: 'fact', permalink: `main/chats/entries/bench-${index}.md`,
    occurred_at: '2026-10-01T00:00:00.000Z',
    source_refs: [{id: source.id, revision: source.revision, role: source.role}],
    sourceStatus: {eligible: true, manualBody: false}, priorityMetadata: {},
  };
}

async function buildFixture(root) {
  const sources = [];
  for (let index = 0; index < ROUNDS; index++) {
    sources.push(sourceRecord(index, 'user'), sourceRecord(index, 'assistant'));
  }
  const sourceById = new Map(sources.map(source => [source.id, source]));
  const entries = Array.from({length: ENTRIES}, (_, index) => entryRecord(index, sources[0]));
  await fs.writeFile(path.join(root, 'fixture.json'), JSON.stringify({rounds: ROUNDS, entries: ENTRIES, sources}), 'utf8');
  return {
    sources: JSON.parse(await fs.readFile(path.join(root, 'fixture.json'), 'utf8')).sources,
    sourceById, entries,
  };
}

function adapters(fixture, vectorDelay, dispatchTimes) {
  const valid = new WeakSet();
  const access = {
    ownerSubject: 'fictional-owner',
    validate(grant) { return valid.has(grant) && !grant.signal.aborted; },
    validateMessage() { return true; },
    assertCurrent() {},
    withGrant(_grant, task) { return task(); },
    grant() {
      const controller = new AbortController();
      const grant = {
        kind: 'read', ownerSubject: access.ownerSubject, project: 'main', sessionId: 'bench-session',
        rootSessionId: 'bench-session', epoch: 'bench', signal: controller.signal,
        cancel() { valid.delete(grant); controller.abort(); },
      };
      valid.add(grant);
      return grant;
    },
  };
  const raw = {
    queryReader() {
      return {
        search({query, limit}) {
          const rows = fixture.sources.map(source => ({source, score: lexicalMatch(query, source.text)}))
            .filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
            .map(row => row.source);
          return {sources: rows, partial: false};
        },
        get(ref) {
          const source = fixture.sourceById.get(ref.id);
          return source && source.revision === ref.revision ? source : null;
        },
        recent() { return []; },
        embeddingContext() { return []; },
        neighbors() { return []; },
      };
    },
    status() { return {backend: {actualDevice: 'fixture'}}; },
  };
  const entries = {
    forGrant() {
      return {
        async search(query, {limit}) {
          return fixture.entries.filter(entry => lexicalMatch(query, entry.content) > 0).slice(0, limit);
        },
        async read() { return null; },
      };
    },
  };
  const vectorRecord = {
    id: 'bench-vector', revision: 'bench-vector-v1', kind: 'entry',
    text: '虚构向量候选：阿岑的离线测速事项。',
    state: {validity: 'current', progress: null},
    sourceStatus: {eligible: true, manualBody: false},
    source_refs: [{id: fixture.sources[0].id, revision: fixture.sources[0].revision, role: fixture.sources[0].role}],
    anchor: {id: 'bench-vector', revision: 'bench-vector-v1', ref: {storage: 'entry', id: 'bench-vector'}},
  };
  let sampleStart = performance.now();
  let dispatch;
  const vectors = {
    async getSnapshot() { return {id: 'bench-profile', revision: 'v1', modelKey: 'bench-model'}; },
    async query({signal}) {
      dispatch = performance.now() - sampleStart;
      dispatchTimes.push(dispatch);
      if (vectorDelay) await delay(vectorDelay, undefined, {signal});
      return {records: [vectorRecord], state: 'ready'};
    },
    async resolveDocument({id, revision}) {
      return id === vectorRecord.id && revision === vectorRecord.revision ? vectorRecord : null;
    },
  };
  return {
    access, raw, entries, vectors,
    beginSample() { sampleStart = performance.now(); dispatch = undefined; },
  };
}

async function run() {
  const vectorDelay = option('vector-delay', 300);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-prefetch-bench-'));
  try {
    const config = resolveConfig({project: 'main', vaultPath: path.join(root, 'vault'), rawRecall: false});
    const fixture = await buildFixture(root);
    const dispatchTimes = [];
    const runtime = adapters(fixture, vectorDelay, dispatchTimes);
    const agent = {session: {id: 'bench-session'}};
    const totals = [], channels = {originals: [], structured: [], vector: []};
    const prefetchOnce = async () => {
      runtime.beginSample();
      const started = performance.now();
      const answer = createMemoryQueryAnswer({
        access: runtime.access, agent, raw: runtime.raw, entries: runtime.entries, tools: {},
        config, vectors: runtime.vectors, now: Date.now, searchWaitMs: 1300,
      });
      try {
        const result = await answer.search({query: '阿岑', limit: LIMIT});
        let injected = 0, injectedChars = 0;
        for (const record of result.records.slice(0, LIMIT)) {
          const text = String(record.text ?? '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          injected++;
          injectedChars += text.length;
        }
        for (const name of Object.keys(channels)) {
          const elapsed = result.channels?.[name]?.elapsedMs;
          if (Number.isFinite(elapsed)) channels[name].push(elapsed);
        }
        totals.push(performance.now() - started);
        return {result, injected, injectedChars};
      } finally {
        answer.dispose();
      }
    };
    const first = await prefetchOnce();
    for (let index = 0; index < SAMPLES; index++) await prefetchOnce();
    return {
      fixture: {rounds: ROUNDS, entries: ENTRIES, samples: SAMPLES, vectorDelayMs: vectorDelay},
      prefetch: {p50Ms: rounded(percentile(totals, .5)), p95Ms: rounded(percentile(totals, .95))},
      vectorDispatchMs: {p50: rounded(percentile(dispatchTimes, .5))},
      channelsMeanMs: Object.fromEntries(Object.entries(channels).map(([name, values]) => [name, rounded(average(values))])),
      firstInjected: first.injected,
      firstInjectedChars: first.injectedChars,
    };
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}

try {
  console.log(JSON.stringify(await run(), null, 2));
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}

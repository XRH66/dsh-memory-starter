import fs from 'node:fs/promises';
import path from 'node:path';
import inspector from 'node:inspector';
import {performance} from 'node:perf_hooks';
import {createMemoryPolicy} from '../lib/memory-policy/index.js';
import {createUnifiedProfiles} from '../lib/storage/profiles.js';

const DOCUMENTS = 700;
const PROFILE = 'BAAI/bge-small-zh-v1.5';
const OWNER = 'fictional-profile-owner';
const PROJECT = 'main';

function option(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find(value => value.startsWith(prefix));
  if (found === undefined) return fallback;
  const value = Number(found.slice(prefix.length));
  if (!Number.isSafeInteger(value) || value < 1) throw Error(`Invalid --${name}`);
  return value;
}

function percentage(value, total) {
  return Math.round((value / Math.max(1, total)) * 10000) / 100;
}

function summarizeProfile(profile) {
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const counts = new Map();
  for (const id of profile.samples ?? []) {
    const node = nodes.get(id);
    if (!node) continue;
    const frame = node.callFrame;
    const key = `${frame.functionName || '(anonymous)'}\t${frame.url || '(native)'}\t${frame.lineNumber + 1}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 15)
    .map(([key, hits]) => {
      const [functionName, url, line] = key.split('\t');
      return {functionName, url, line: Number(line), selfPct: percentage(hits, total)};
    });
}

function sessionIdentity(sessionId) {
  return {
    sessionId,
    rootSessionId: sessionId,
    ownerSubject: OWNER,
    project: PROJECT,
    sequence: 1,
    turn: 1,
    rootTurn: 1,
    historyUserOnly: true,
  };
}

async function writePolicy(file, sessions) {
  const state = {
    version: 1,
    revision: 'fictional-profile-revision',
    sessions: Array.from({length: sessions}, (_, index) => {
      const sessionId = `fictional-session-${index}`;
      return {
        rootSessionId: sessionId,
        ownerSubject: OWNER,
        project: PROJECT,
        enabled: true,
        epoch: `fictional-epoch-${index}`,
        intervals: [{
          id: `fictional-interval-${index}`,
          startSequence: 0,
          startTurn: 0,
          endSequence: null,
          endTurn: null,
          openedAt: '2026-01-01T00:00:00.000Z',
          closedAt: null,
          historyUserOnly: true,
        }],
      };
    }),
  };
  await fs.writeFile(file, JSON.stringify(state, null, 2), 'utf8');
}

function document(index) {
  const id = `fictional-document-${index}`;
  return {
    id,
    revision: 1,
    domain: 'raw',
    text: `Fictional profile document ${index} about a harmless local fixture.`,
    sourceIds: [`fictional-source-${index}`],
    anchor: {id, revision: 1},
  };
}

function fakeBackend(metrics, dimensions = 512) {
  return {
    modelKey: null,
    dimensions,
    batchSize: 8,
    async prepare() {
      this.modelKey = 'fictional-profile-space';
      return {modelKey: this.modelKey, dimensions};
    },
    async planChunks(text) {
      return [{start: 0, end: text.length, text, tokenBound: text.length}];
    },
    async embed(texts, options) {
      const started = performance.now();
      try {
        return texts.map(() => Array.from({length: dimensions}, (_, index) => index === 0 ? 1 : 0));
      } finally {
        if (options?.kind === 'query') metrics.encodeMs += performance.now() - started;
      }
    },
    async dispose() {
      this.modelKey = null;
    },
  };
}

async function run() {
  const sessions = option('sessions', 100);
  const profileOutput = process.argv.slice(2).find(value => value.startsWith('--cpu-profile='))?.slice('--cpu-profile='.length);
  const workspace = path.resolve(process.cwd());
  const local = path.join(workspace, '.local');
  await fs.mkdir(local, {recursive: true});
  const root = await fs.mkdtemp(path.join(local, 'profile-vector-'));
  const policyFile = path.join(root, 'policy.json');
  await writePolicy(policyFile, sessions);
  const activeId = `fictional-session-${sessions - 1}`;
  const metrics = {encodeMs: 0};
  const policy = createMemoryPolicy({
    file: policyFile,
    resolveAgent: agent => sessionIdentity(agent.session.id),
    resolveSession: sessionIdentity,
  });
  await policy.ready();
  const grant = policy.grant({session: {id: activeId}});
  const rows = Array.from({length: DOCUMENTS}, (_, index) => document(index));
  const valid = new WeakSet([grant]);
  const authorize = value => valid.has(value) && policy.validate(value);
  const profiles = createUnifiedProfiles({
    file: path.join(root, 'profiles.json'),
    indexFile: path.join(root, 'vectors.sqlite'),
    authorize,
    queryCandidateLimit: 120,
    async *listDocuments() {
      for (const row of rows) yield structuredClone(row);
    },
    async *listDocumentMetadata() {
      for (const row of rows) {
        const {text, ...metadata} = row;
        yield {...structuredClone(metadata), length: text.length, cjk: 0};
      }
    },
    async resolveDocument({id, revision, grant: current}) {
      if (!authorize(current)) throw Error('Authorization changed');
      const row = rows.find(item => item.id === id && item.revision === revision);
      return row ? structuredClone(row) : null;
    },
    createBackend: () => fakeBackend(metrics),
  });

  const session = new inspector.Session();
  let cpuProfile;
  try {
    await profiles.ready();
    await profiles.register({profile: {id: PROFILE, model: PROFILE}, grant});
    await profiles.select({profileId: PROFILE, grant});
    await profiles.prepare({grant});
    const started = performance.now();
    if (profileOutput) {
      session.connect();
      await new Promise((resolve, reject) => session.post('Profiler.enable', error => error ? reject(error) : resolve()));
      await new Promise((resolve, reject) => session.post('Profiler.start', error => error ? reject(error) : resolve()));
    }
    const result = await profiles.query({
      query: 'fictional harmless local fixture',
      grant,
      deadline: Date.now() + 5000,
      limit: 10,
    });
    const wallMs = performance.now() - started;
    const searchMs = Math.max(0, wallMs - metrics.encodeMs);
    if (profileOutput) {
      cpuProfile = await new Promise((resolve, reject) => session.post('Profiler.stop',
        (error, value) => error ? reject(error) : resolve(value.profile)));
      await fs.writeFile(path.resolve(workspace, profileOutput), JSON.stringify(cpuProfile), 'utf8');
    }
    console.log(JSON.stringify({
      sessions,
      documents: DOCUMENTS,
      records: result.records.length,
      wallMs: Math.round(wallMs * 100) / 100,
      totalMs: Math.round(wallMs * 100) / 100,
      encodeMs: Math.round(metrics.encodeMs * 100) / 100,
      searchMs: Math.round(searchMs * 100) / 100,
      degraded: result.degraded === true,
      cpuProfile: cpuProfile ? summarizeProfile(cpuProfile) : null,
    }, null, 2));
  } finally {
    if (profileOutput) session.disconnect();
    grant.cancel();
    await profiles.close();
    await fs.rm(root, {recursive: true, force: true});
  }
}

try {
  await run();
} catch (error) {
  console.error(error.stack || error.message || String(error));
  process.exitCode = 1;
}

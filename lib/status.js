import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {writeFileAtomic} from './atomic-file.js';
import { managementDirectory } from './review.js';
import {ORIGINAL_HANDOFF_SAMPLE, originalRecentStats} from './recent-context.js';

export const statusKey = (id) => createHash('sha256').update(id).digest('hex');
export function createMemoryStatus(config, logger) {
  const dir = config.vaultPath ? path.join(managementDirectory(config), 'memory-status') : '';
  const cache = new Map();
  let chain = Promise.resolve();
  const runId = randomUUID();
  const recentEnabled = config.recentContext !== false;
  const statsFile = dir ? path.join(dir, 'recent-original-stats.json') : '';
  const recentContext = {enabled: recentEnabled, capacityTokens: null, file: statsFile, source: ORIGINAL_HANDOFF_SAMPLE};
  let recentSnapshot;
  async function writeAtomic(file, json, canCommit = () => true) {
    return writeFileAtomic(file, json, {flag: 'wx', beforeRename: canCommit});
  }
  let ready = Promise.resolve();
  if (dir) ready = (async () => {
    await fs.mkdir(dir, { recursive: true });
    if (statsFile) {
      const initial = JSON.stringify({stats: originalRecentStats(recentEnabled)});
      try {
        await writeAtomic(statsFile, initial);
        recentSnapshot = initial;
      } catch (error) { logger?.warn?.('[basic-memory-bridge] recent stats initialization failed: ' + error.code); }
    }
    await writeAtomic(path.join(dir, 'runtime.json'), JSON.stringify({ runId, startedAt: new Date().toISOString(), recentContext, features: ['natural-decay-reinforcement', 'personal-entry-decay-reinforcement', 'recent-cross-session-activity', 'memory-usage-recall-status', 'unified-recall-context', 'transient-memory-context', 'current-requirements-history', 'recent-conversation-context'] }));
  })();
  ready.catch((error) => logger?.warn?.('[basic-memory-bridge] status initialization failed: ' + error.code));
  async function load(id) {
    await ready;
    if (cache.has(id)) return cache.get(id);
    let value = { version: 1, sessionId: id, jobs: [] };
    if (dir) {
      try { value = JSON.parse(await fs.readFile(path.join(dir, statusKey(id) + '.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const job of value.jobs) {
      if (['queued', 'processing'].includes(job.state)) {
        job.state = 'failed'; job.reason = 'interrupted';
      }
    }
    value.runId = runId;
    cache.set(id, value);
    return value;
  }
  async function persist(value) {
    value.updatedAt = new Date().toISOString();
    if (!dir) return;
    await fs.mkdir(dir, { recursive: true });
    await writeAtomic(path.join(dir, statusKey(value.sessionId) + '.json'), JSON.stringify(value, null, 2));
  }
  function serialize(fn) {
    const run = chain.then(fn);
    chain = run.catch((error) => logger?.warn?.('[basic-memory-bridge] status persistence failed: ' + error.code));
    return run;
  }
  return {
    refreshRecentStats: statsFile && recentEnabled ? (sources, {authorize}) => {
      if (!authorize()) return Promise.resolve();
      const json = JSON.stringify({stats: originalRecentStats(true, sources, new Date().toISOString())});
      return serialize(async () => {
        await ready;
        if (authorize() && json !== recentSnapshot && await writeAtomic(statsFile, json, authorize)) recentSnapshot = json;
      });
    } : undefined,
    get: (id) => serialize(async () => structuredClone(await load(id))),
    set: (id, turn, patch) => serialize(async () => {
      const value = await load(id);
      let job = value.jobs.find((item) => item.turn === turn);
      if (!job) { job = { turn, at: new Date().toISOString() }; value.jobs.push(job); }
      Object.assign(job, patch);
      value.jobs = value.jobs.sort((a, b) => a.turn - b.turn).slice(-20);
      await persist(value);
    }),
    usage: (id, turn, record) => serialize(async () => {
      const value = await load(id);
      let job = value.jobs.find(item => item.turn === turn);
      if (!job) { job = { turn, at: new Date().toISOString() }; value.jobs.push(job); }
      job.usage ??= [];
      const previous = job.usage.find(item => item.id === record.id);
      if (previous) Object.assign(previous, record); else job.usage.push(record);
      value.jobs = value.jobs.sort((a,b) => a.turn - b.turn).slice(-20);
      await persist(value);
    }),
  };
}


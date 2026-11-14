import fs from 'node:fs/promises';
import path from 'node:path';
import {writeJsonAtomic} from './atomic-file.js';
import { managementDirectory } from './review.js';

/**
 * Durable runtime state for natural decay, processing scope and any pre-existing
 * recovery fields. Legacy jobs stay opaque and are neither migrated nor consumed.
 */
export function createRecoveryStore(config) {
  const directory = config.vaultPath ? path.join(managementDirectory(config), 'memory-status') : '';
  const file = directory ? path.join(directory, 'recovery.json') : '';
  let value;
  let chain = Promise.resolve();

  async function load() {
    if (value) return value;
    if (file) {
      try {
        const saved = JSON.parse(await fs.readFile(file, 'utf8'));
        if (saved?.version !== 1 || saved.project !== config.project) throw new Error('INVALID_RECOVERY_STORE');
        value = saved;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    value ??= { version: 1, project: config.project };
    return value;
  }

  function serial(fn) {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  }

  async function persist(next) {
    if (file) {
      await fs.mkdir(directory, { recursive: true });
      await writeJsonAtomic(file, next, {flag: 'wx', fsync: true, space: 2});
    }
    value = next;
  }

  function update(fn) {
    return serial(async () => {
      const next = structuredClone(await load());
      const result = fn(next);
      await persist(next);
      return result;
    });
  }

  return {
    read: () => serial(async () => structuredClone(await load())),
    update,
  };
}

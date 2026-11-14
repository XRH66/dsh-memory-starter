import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {writeJsonAtomic} from '../atomic-file.js';
import { memoryError } from './contract.js';

/** One host process owns this metadata store. No personal backend is opened here. */
export function createUnifiedStateStore({ file, initial, validate = () => {} }) {
  if (!path.isAbsolute(file || '') || typeof initial !== 'function') throw new TypeError('Explicit metadata file and initial state required');
  let value, loading, chain = Promise.resolve();
  const inspect = state => {
    if (!state || state.version !== 1 || typeof state.revision !== 'string' || !state.revision) throw memoryError('INVALID_MEMORY_STATE', '记忆状态文件无效');
    validate(state);
    return state;
  };
  const load = () => loading ||= (async () => {
    try { value = inspect(JSON.parse(await fs.readFile(file, 'utf8'))); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      value = inspect({ ...initial(), version: 1, revision: randomUUID() });
    }
    return value;
  })();
  async function commit(state) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await writeJsonAtomic(file, state, {flag: 'wx', mode: 0o600, space: 2, trailingNewline: true});
  }
  const api = {
    file,
    get ready() { return Boolean(value); },
    // Internal selectors are synchronous and read-only. Clone only their result
    // so a single locator lookup does not copy the entire catalogue.
    async read(select = state => state) { await chain; await load(); return structuredClone(select(value)); },
    snapshot(select = state => state) {
      if (!value) throw memoryError('MEMORY_NOT_READY', '记忆授权尚未就绪', 503);
      return structuredClone(select(value));
    },
    update(mutator, { expectedRevision } = {}) {
      const task = chain.then(async () => {
        await load();
        if (expectedRevision !== undefined && expectedRevision !== value.revision) throw memoryError('MEMORY_REVISION_CONFLICT', '设置已变化，请刷新后重试', 409);
        const next = structuredClone(value);
        const result = await mutator(next);
        next.revision = randomUUID(); inspect(next);
        await commit(next);
        value = next;
        return { value: structuredClone(next), result };
      });
      chain = task.then(() => {}, () => {});
      return task;
    },
    async idle() { await chain; },
  };
  return api;
}

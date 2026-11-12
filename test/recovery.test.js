import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRecoveryStore} from '../lib/recovery.js';
import {resolveConfig} from '../lib/config.js';
import {managementDirectory} from '../lib/review.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-recovery-state-'));
  const config = resolveConfig({ project: 'main', vaultPath: path.join(root, 'vault') });
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, config, directory: path.join(managementDirectory(config), 'memory-status') };
}

test('runtime state persists while pre-existing legacy task fields stay opaque', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.directory, { recursive: true });
  const file = path.join(f.directory, 'recovery.json');
  await fs.writeFile(file, JSON.stringify({
    version: 1,
    project: 'main',
    jobs: [{ id: 'old-job' }],
    pending: [{ permalink: 'main/chats/facts/old' }],
  }));

  const store = createRecoveryStore(f.config);
  await store.update(state => {
    state.processingScopeId = 'scope-fixture';
    state.naturalDecayStartedAt = '2026-11-11T00:00:00.000Z';
  });
  const saved = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(saved.processingScopeId, 'scope-fixture');
  assert.equal(saved.naturalDecayStartedAt, '2026-11-11T00:00:00.000Z');
  assert.deepEqual(saved.jobs, [{ id: 'old-job' }]);
  assert.deepEqual(saved.pending, [{ permalink: 'main/chats/facts/old' }]);
});

test('failed durable state writes do not replace the cached runtime state', async t => {
  const f = await fixture(t);
  const store = createRecoveryStore(f.config);
  await store.update(state => { state.naturalDecayStartedAt = 'original'; });

  const file = path.join(f.directory, 'recovery.json');
  const saved = await fs.readFile(file, 'utf8');
  await fs.rm(file);
  await fs.mkdir(file);
  await assert.rejects(store.update(state => { state.naturalDecayStartedAt = 'must-not-cache'; }));
  assert.equal((await store.read()).naturalDecayStartedAt, 'original');

  await fs.rmdir(file);
  await fs.writeFile(file, saved);
  await store.update(state => { state.processingScopeId = 'scope-after-retry'; });
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).processingScopeId, 'scope-after-retry');
});

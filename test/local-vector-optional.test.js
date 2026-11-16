import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beginDeploymentConfiguration, deploymentFingerprint, readDeploymentSettings } from '../lib/deployment-config.js';
import { resolveConfig } from '../lib/config.js';

const LOCAL = 'BAAI/bge-small-zh-v1.5';
const CLOUD = 'custom-api';

async function fixture(t, memory, { selectedProfile = null } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-vector-optional-'));
  const dshHome = path.join(directory, 'dsh-home');
  await fs.mkdir(path.join(dshHome, 'storages'), { recursive: true });
  await fs.writeFile(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({unit:{name:'workspace',version:2},global:{},tables:{workspaces:{}}}));
  if (selectedProfile) {
    const vectors = path.join(directory, 'management', 'vectors');
    await fs.mkdir(vectors, { recursive: true });
    await fs.writeFile(path.join(vectors, 'profiles.json'), JSON.stringify({
      version: 1,
      revision: 'fictional-profile-revision',
      scopes: [{
        ownerSubject: 'fictional-owner',
        project: 'main',
        profiles: [{
          id: selectedProfile,
          currentRevision: 'fictional-selected-revision',
          versions: [{ id: selectedProfile, revision: 'fictional-selected-revision', model: selectedProfile }],
        }],
        selectedProfileId: selectedProfile,
        active: null,
        progress: [],
      }],
    }));
  }
  const file = path.join(directory, 'deployment.json');
  const cfg = {
    ownerDirectory: directory,
    ownerSubject: 'fictional-owner',
    dshHome,
    dshSessionIds: [],
    memory,
  };
  await fs.writeFile(file, JSON.stringify(cfg, null, 2) + '\n');
  t.after(async () => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, file };
}

async function load(t, memory, options) {
  const f = await fixture(t, memory, options);
  const runtime = await beginDeploymentConfiguration(f.file);
  try {
    await runtime.ready();
    return { ...f, cfg: runtime.cfg, saved: JSON.parse(await fs.readFile(f.file, 'utf8')) };
  } finally {
    await runtime.close();
  }
}

test('a fresh deployment keeps the cloud default without writing a local model', async t => {
  const result = await load(t, { project: 'main' });
  assert.equal(resolveConfig(result.cfg.memory).rawRecallModel, CLOUD);
  assert.equal(Object.hasOwn(result.saved.memory, 'rawRecallModel'), false);
});

test('a first-run config without memory stays byte-identical and reports loaded', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.file, 'utf8');
  const runtime = await beginDeploymentConfiguration(f.file);
  try {
    await runtime.ready();
    const after = await fs.readFile(f.file, 'utf8');
    const saved = JSON.parse(after);
    const settings = await readDeploymentSettings(f.file);
    assert.equal(after, before);
    assert.deepEqual(runtime.cfg, saved);
    assert.equal(deploymentFingerprint(runtime.cfg), deploymentFingerprint(saved));
    assert.equal(settings.runtime, 'loaded');
  } finally {
    await runtime.close();
  }
});

test('a required local-model migration still writes back and reports loaded', async t => {
  const f = await fixture(t, { project: 'main', rawRecallInstallReceipt: '/fictional/receipt.json' });
  const before = await fs.readFile(f.file, 'utf8');
  const runtime = await beginDeploymentConfiguration(f.file);
  try {
    await runtime.ready();
    const after = await fs.readFile(f.file, 'utf8');
    const saved = JSON.parse(after);
    const settings = await readDeploymentSettings(f.file);
    assert.notEqual(after, before);
    assert.equal(saved.memory.rawRecallModel, LOCAL);
    assert.deepEqual(runtime.cfg, saved);
    assert.equal(deploymentFingerprint(runtime.cfg), deploymentFingerprint(saved));
    assert.equal(settings.runtime, 'loaded');
  } finally {
    await runtime.close();
  }
});

test('a default-local install receipt migrates to an explicit local model', async t => {
  const result = await load(t, { project: 'main', rawRecallInstallReceipt: '/fictional/receipt.json' });
  assert.equal(result.cfg.memory.rawRecallModel, LOCAL);
  assert.equal(result.saved.memory.rawRecallModel, LOCAL);
});

test('a selected default-local vector archive migrates to an explicit local model', async t => {
  const result = await load(t, { project: 'main' }, { selectedProfile: LOCAL });
  assert.equal(result.cfg.memory.rawRecallModel, LOCAL);
  assert.equal(result.saved.memory.rawRecallModel, LOCAL);
});

test('an explicit cloud choice is never replaced by stale local evidence', async t => {
  const result = await load(t, {
    project: 'main',
    rawRecallModel: CLOUD,
    rawRecallInstallReceipt: '/fictional/receipt.json',
  }, { selectedProfile: LOCAL });
  assert.equal(result.cfg.memory.rawRecallModel, CLOUD);
  assert.equal(result.saved.memory.rawRecallModel, CLOUD);
});

test('runtime entry points do not statically import optional local implementations', async () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = [
    'lib/bundle-entry.js',
    'lib/settings-host.js',
    'lib/deployment-config.js',
    'lib/raw-rag/backend.js',
    'lib/raw-rag/cloud-backend.js',
    'lib/raw-rag/index.js',
    'lib/storage/profiles.js',
  ];
  for (const relative of files) {
    const source = await fs.readFile(path.join(root, relative), 'utf8');
    for (const line of source.split(/\r?\n/u)) {
      if (!/(?:^|\s)(?:import|export)\b/u.test(line) || /\bimport\s*\(/u.test(line)) continue;
      assert.doesNotMatch(line, /['"][^'"]*(?:raw-rag\/)?local\//u, relative + ': ' + line.trim());
    }
  }
});

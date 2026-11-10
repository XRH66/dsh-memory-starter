import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { switchFixture, profile, doc } from './unified-switch-fixture.js';
import { scratchDirectory } from './helpers.js';
import { stageDeploymentRawModel, beginDeploymentConfiguration, deploymentFingerprint, readDeploymentSettings } from '../lib/deployment-config.js';
import { resolveConfig } from '../lib/config.js';

const cloud = (allow = true) => profile('C', { model: 'text-embedding-v4', backend: { config: { rawRecallAllowCloud: allow } } });

test('no intent field means no intent; a confirmed switch is cleared once the profile becomes active', async t => {
  const f = await switchFixture(t);
  f.setRows([doc('one'), doc('two')]); await f.choose(profile('A')); await f.api.prepare({ grant: f.g });
  assert.equal((await f.api.status({ grant: f.g })).switchIntent, null);
  assert.equal(f.api.switchIntent({ ownerSubject: 'fictional-owner', project: 'fictional-project' }), null);
  await f.choose(profile('B'));
  const { switchIntent } = await f.api.setSwitchIntent({ grant: f.g, profileId: 'B' });
  assert.equal(switchIntent.profileId, 'B');
  assert.equal((await f.api.status({ grant: f.g })).switchIntent.profileId, 'B');
  await f.api.prepare({ grant: f.g });
  const status = await f.api.status({ grant: f.g });
  assert.equal(status.activeProfileId, 'B'); assert.equal(status.switchIntent, null);
});

test('a staged confirmation is consumed once across restarts', async t => {
  const f = await switchFixture(t);
  await f.choose(profile('A'));
  assert.ok((await f.api.setSwitchIntent({ grant: f.g, profileId: 'A', confirmedAt: 't1' })).switchIntent);
  await f.api.clearSwitchIntent({ grant: f.g }); await f.restart();
  assert.equal((await f.api.setSwitchIntent({ grant: f.g, profileId: 'A', confirmedAt: 't1' })).switchIntent, null);
  assert.equal((await f.api.status({ grant: f.g })).switchIntent, null);
});

test('choosing another profile or a new revision voids the intent', async t => {
  const f = await switchFixture(t);
  await f.choose(profile('A')); await f.choose(profile('B'));
  await f.api.setSwitchIntent({ grant: f.g, profileId: 'B' });
  await f.api.select({ profileId: 'A', grant: f.g });
  assert.equal((await f.api.status({ grant: f.g })).switchIntent, null);
  await f.api.select({ profileId: 'B', grant: f.g });
  await f.api.setSwitchIntent({ grant: f.g, profileId: 'B' });
  await f.api.register({ profile: profile('B', { backend: { config: { rawRecallBgeModelDir: 'fictional-moved' } } }), grant: f.g });
  assert.equal((await f.api.status({ grant: f.g })).switchIntent, null);
});

test('cloud intent needs the cloud opt-in, and revoking it clears the intent', async t => {
  const f = await switchFixture(t);
  await f.choose(cloud(false));
  await assert.rejects(f.api.setSwitchIntent({ grant: f.g, profileId: 'C', cloudConfirmed: true }), { code: 'CLOUD_PERMISSION_REVOKED' });
  await f.choose(cloud(true));
  assert.equal((await f.api.setSwitchIntent({ grant: f.g, profileId: 'C', cloudConfirmed: true })).switchIntent.cloudConfirmed, true);
  await f.api.register({ profile: cloud(false), grant: f.g });
  assert.equal((await f.api.status({ grant: f.g })).switchIntent, null);
});

test('dropIndex refuses the active and the pending-switch profile, and clears only its own index', async t => {
  const f = await switchFixture(t);
  // Distinct models: removal also refuses any profile sharing the active model.
  f.setRows([doc('one')]); await f.choose(profile('A')); await f.api.prepare({ grant: f.g });
  await f.choose(profile('B', { model: 'Qwen/Qwen3-Embedding-0.6B' })); await f.api.prepare({ grant: f.g });
  await assert.rejects(f.api.dropIndex({ grant: f.g, profileId: 'B' }), { code: 'MODEL_ACTIVE' });
  await f.api.select({ profileId: 'A', grant: f.g });
  await f.api.setSwitchIntent({ grant: f.g, profileId: 'A' });
  await assert.rejects(f.api.dropIndex({ grant: f.g, profileId: 'A' }), { code: 'MODEL_SWITCH_PENDING' });
  await f.api.clearSwitchIntent({ grant: f.g });
  const result = await f.api.dropIndex({ grant: f.g, profileId: 'A' });
  assert.equal(result.indexCleared, true);
  const status = await f.api.status({ grant: f.g });
  const a = status.profiles.find(row => row.id === 'A'), b = status.profiles.find(row => row.id === 'B');
  assert.deepEqual([a.index.hasSnapshot, a.progress.state], [false, 'unprepared']);
  assert.deepEqual([b.index.hasSnapshot, b.progress.state, status.activeProfileId], [true, 'ready', 'B']);
  assert.equal((await f.api.query({ query: 'x', grant: f.g })).records.length, 1);
});

test('config passes a valid staged confirmation through and ignores malformed ones', () => {
  assert.equal(resolveConfig({}).rawRecallSwitch, null);
  assert.equal(resolveConfig({ rawRecallSwitch: { cloudConfirmed: true } }).rawRecallSwitch, null);
  assert.deepEqual({ ...resolveConfig({ rawRecallSwitch: { confirmedAt: 'x', cloudConfirmed: 1 } }).rawRecallSwitch }, { confirmedAt: 'x', cloudConfirmed: false });
});

async function deployment(t) {
  const directory = await scratchDirectory('switch-deploy-');
  const dshHome = path.join(directory, 'dsh'); await fs.mkdir(path.join(dshHome, 'storages'), { recursive: true });
  await fs.writeFile(path.join(dshHome, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 2 }, tables: { workspaces: {} } }));
  const keyFile = path.join(directory, 'fictional.key'); await fs.writeFile(keyFile, 'fictional-key');
  const memory = { rawRecallApiKeyFile: keyFile, rawRecallModel: 'text-embedding-v4', rawRecallAllowCloud: true, rawRecallApiBase: 'https://service-a.example/v1', rawRecallDimensions: 64, rawRecallApiKeyEnv: 'FICTIONAL_A_KEY' };
  const file = path.join(directory, 'deployment.json');
  await fs.writeFile(file, JSON.stringify({ ownerDirectory: directory, ownerSubject: 'fictional-owner', dshHome, dshSessionIds: [], memory }));
  const read = async () => JSON.parse(await fs.readFile(file, 'utf8'));
  const stage = async input => stageDeploymentRawModel(file, input, deploymentFingerprint(await read()));
  const apply = async () => { const runtime = await beginDeploymentConfiguration(file); try { await runtime.ready(); return runtime.cfg; } finally { await runtime.close(); } };
  return { file, read, stage, apply };
}

test('deployment: confirmation is staged with the model and lands in memory config after reload', async t => {
  const d = await deployment(t);
  const settings = { rawRecallModel: 'text-embedding-v4', rawRecallDimensions: 128 };
  await assert.rejects(d.stage({ settings, confirmSwitch: true }), /明确确认/);
  const staged = await d.stage({ settings, confirmSwitch: true, cloudConfirmed: true });
  assert.deepEqual(staged.pendingRawModelSwitch, { cloudConfirmed: true });
  const cfg = await d.apply();
  assert.equal(cfg.memory.rawRecallSwitch.cloudConfirmed, true);
  assert.equal(typeof cfg.memory.rawRecallSwitch.confirmedAt, 'string');
  assert.equal((await d.read()).pendingRawRecallSwitch, undefined);
});

test('deployment: without confirmation nothing new is staged, and cancel drops a confirmation', async t => {
  const d = await deployment(t);
  const settings = { rawRecallModel: 'text-embedding-v4', rawRecallDimensions: 128 };
  await d.stage({ settings, confirmSwitch: true, cloudConfirmed: true });
  await d.stage({ cancel: true });
  assert.equal((await d.read()).pendingRawRecallSwitch, undefined);
  const plain = await d.stage({ settings });
  assert.equal(plain.pendingRawModelSwitch, null);
  const cfg = await d.apply();
  assert.equal(cfg.memory.rawRecallSwitch, undefined);
  assert.equal((await readDeploymentSettings(d.file)).pendingRawModelSwitch, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatRecordedAt } from '../lib/dates.js';
import { localTime } from '../lib/local-time.js';
import { PERSONAL_TIME_ZONE, hostTimeZone, personalTimeZone, resolvePersonalTimeZone, setPersonalTimeZone } from '../lib/personal-namespace.js';
import { resolveConfig } from '../lib/config.js';
import { deploymentFingerprint, readDeploymentSettings, stageDeploymentTimeZone } from '../lib/deployment-config.js';

const instant = Date.parse('2026-06-10T03:27:00.000Z');
const original = personalTimeZone();
test.after(() => setPersonalTimeZone(original));

test('the personal time zone changes formatting and date conversion', () => {
  setPersonalTimeZone('America/Los_Angeles');
  assert.equal(PERSONAL_TIME_ZONE, 'America/Los_Angeles');
  assert.equal(localTime(instant), '2026-06-09 20:27 -07:00');
  assert.equal(formatRecordedAt(new Date(instant).toISOString()), '2026-06-09 20:27');

  setPersonalTimeZone('Asia/Shanghai');
  assert.equal(PERSONAL_TIME_ZONE, 'Asia/Shanghai');
  assert.equal(localTime(instant), '2026-06-10 11:27 +08:00');
  assert.equal(formatRecordedAt(new Date(instant).toISOString()), '2026-06-10 11:27');
});

test('an invalid personal time zone falls back to Beijing time', () => {
  const resolved = resolvePersonalTimeZone('Not/A_Real_Zone');
  assert.equal(resolved.timeZone, 'Asia/Shanghai');
  assert.match(resolved.error, /已使用默认时区 Asia\/Shanghai/);
  assert.equal(setPersonalTimeZone('Not/A_Real_Zone'), 'Asia/Shanghai');
});

test('the deployment setting saves the configured zone and reports fallback status', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dafeiyu-time-zone-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'deployment.json');
  const dshHome = path.join(root, 'dsh');
  await mkdir(path.join(dshHome, 'storages'), { recursive: true });
  await writeFile(path.join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { archivedSessionIds: [] },
    tables: { workspaces: {} },
  }));
  const config = {
    dshHome,
    dshSessionIds: [],
    ownerDirectory: path.join(root, 'memory'),
    backend: 'basic-memory',
    memory: {},
  };
  await writeFile(file, JSON.stringify(config));
  await stageDeploymentTimeZone(file, 'America/Los_Angeles', deploymentFingerprint(config));
  let saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.memory.timeZone, 'America/Los_Angeles');
  assert.equal((await readDeploymentSettings(file)).timeZone, 'America/Los_Angeles');

  await stageDeploymentTimeZone(file, 'Not/A_Real_Zone', deploymentFingerprint(saved));
  saved = await readDeploymentSettings(file);
  assert.equal(saved.timeZone, 'Asia/Shanghai');
  assert.equal(saved.timeZoneConfigured, 'Not/A_Real_Zone');
  assert.match(saved.timeZoneError, /无效时区/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Config, DEFAULT_CONFIG, resolveConfig } from '../lib/config.js';
import { hostTimeZone } from '../lib/personal-namespace.js';

test('config defaults apply the product limits without a session allowlist', () => {
  const config = resolveConfig({});
  assert.equal(config.project, 'personal');
  assert.equal(config.timeZone, 'Asia/Shanghai');
  assert.equal(config.autoRecall, true);
  assert.equal(config.autoCapture, true);
  assert.equal(config.rawRecallMinScore, null);
  assert.equal(config.rawRecallQueryWaitMs, 0);
  assert.equal(config.captureFolder, 'chats');
  assert.equal(config.organizerReasoningEffort, 'low');
  assert.equal(Config({}).organizerReasoningEffort, 'low');
});

test('organizer reasoning effort honors explicit values and empty model defaults', () => {
  assert.equal(resolveConfig({ organizerReasoningEffort: 'high' }).organizerReasoningEffort, 'high');
  assert.equal(resolveConfig({ organizerReasoningEffort: '' }).organizerReasoningEffort, '');
  assert.equal(resolveConfig({ organizerReasoningEffort: null }).organizerReasoningEffort, '');
  assert.equal(Config({ organizerReasoningEffort: 'high' }).organizerReasoningEffort, 'high');
  assert.equal(Config({ organizerReasoningEffort: null }).organizerReasoningEffort, null);
});

test('invalid personal time zones fall back to Beijing time without stopping configuration', () => {
  const config = resolveConfig({ timeZone: 'Not/A_Real_Zone' });
  assert.equal(config.timeZone, 'Asia/Shanghai');
  assert.equal(config.timeZoneConfigured, 'Not/A_Real_Zone');
  assert.match(config.timeZoneError, /无效时区 Not\/A_Real_Zone/);
});

test('schemastery schema accepts an empty config and applies defaults', () => {
  const value = Config({});
  assert.equal(value.captureFolder, 'chats');
  // Options removed with the old injection path are still accepted and ignored.
  const old = {
    maxRecallNotes: 3, personalRecall: false, maxIndexNotes: 0, maxTimelineEntries: 0,
    recallTimeoutMs: 1500, maxIndexChars: 600, maxTimelineChars: 500,
    recentContextTokens: 8192, maxAutomaticFailures: 7,
    rawRecallMaxChars: 900, rawRecallCandidates: 20, rawRecallTop: 6, rawRecallTimeoutMs: 7000,
  };
  assert.doesNotThrow(() => Config(old));
  assert.equal(resolveConfig(old).maxRecallNotes, undefined);
  assert.equal(resolveConfig(old).maxIndexChars, undefined);
  assert.equal(resolveConfig(old).maxTimelineChars, undefined);
  assert.equal(resolveConfig(old).recentContextTokens, undefined);
  assert.equal(resolveConfig(old).maxAutomaticFailures, undefined);
  assert.equal(resolveConfig(old).rawRecallMaxChars, undefined);
  assert.equal(resolveConfig(old).rawRecallCandidates, undefined);
  assert.equal(resolveConfig(old).rawRecallTop, undefined);
  assert.equal(resolveConfig(old).rawRecallTimeoutMs, undefined);
});


test('public bundle parameters preserve current schema and runtime defaults', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  const marker = '      config:';
  assert.equal(patch.split(marker).length, 2, 'one public bundle config');
  const config = {};
  // The release template deliberately contains only flat, unquoted scalars.
  // Reject unsupported syntax instead of silently ignoring an override.
  for (const line of patch.split(marker)[1].split(/\r?\n/).filter(line => line.trim())) {
    const match = /^ {8}(\w+): (true|false|\d+|[a-z][a-z0-9_-]*)$/.exec(line);
    assert.ok(match, 'unexpected bundle config syntax: ' + line);
    const [, key, scalar] = match;
    assert.ok(Object.hasOwn(DEFAULT_CONFIG, key), 'unknown bundle parameter: ' + key);
    assert.ok(!Object.hasOwn(config, key), 'duplicate bundle parameter: ' + key);
    config[key] = scalar === 'true' ? true : scalar === 'false' ? false : /^\d+$/.test(scalar) ? Number(scalar) : scalar;
    assert.equal(config[key], DEFAULT_CONFIG[key], key + ' overrides the current default');
  }
  assert.deepEqual(Config(config), Config({}));
  assert.deepEqual(resolveConfig(config), resolveConfig({}));
});

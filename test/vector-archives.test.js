import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {archiveIdentity, profileFromLegacy} from '../lib/unified/profiles.js';
import {doc, switchFixture} from './unified-switch-fixture.js';

const cloud = ({id = 'custom-api', apiBase = 'https://api-a.example/v1', apiModel = 'embed-a', keyFile = ''} = {}) =>
  profileFromLegacy({id, settings:{rawRecallModel:'custom-api',rawRecallAllowCloud:true,rawRecallApiBase:apiBase,
    rawRecallApiModel:apiModel,rawRecallDimensions:8,...(keyFile ? {rawRecallApiKeyFile:keyFile} : {})}});
const local4b = modelFile => profileFromLegacy({id:'Qwen/Qwen3-Embedding-4B',
  settings:{rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallGgufModel:modelFile,rawRecallLlamaServer:'/fictional/llama-server'}});
const prepare = (fixture, profileId = 'custom-api') => fixture.api.prepare({grant:fixture.g, profileId});

test('the same cloud archive reuses its revision and only encodes changed documents', async t => {
  const f = await switchFixture(t), a = cloud({apiBase:'https://api-a.example/v1',apiModel:'embed-a'});
  f.setRows([doc('one', 'one'), doc('two', 'two')]);
  await f.choose(a); await prepare(f);
  const revision = (await f.api.status({grant:f.g})).profiles[0].revision;

  await f.choose(cloud({apiBase:'https://api-b.example/v1',apiModel:'embed-b'})); await prepare(f);
  f.setRows([doc('one', 'one changed', 2), doc('three', 'three')]);
  const beforeReturn = f.embedded('custom-api').length;

  const returned = await f.api.register({profile:a,grant:f.g}); await f.api.select({profileId:'custom-api',grant:f.g});
  await prepare(f);

  assert.equal(returned.profile.revision, revision);
  assert.deepEqual(f.embedded('custom-api').slice(beforeReturn).sort(), ['one changed', 'three']);
});

test('cloud services with different addresses or model names keep separate revisions', async t => {
  const f = await switchFixture(t);
  const first = cloud({apiBase:'https://api-one.example/v1',apiModel:'shared-model'});
  const second = cloud({apiBase:'https://api-two.example/v1',apiModel:'shared-model'});
  const one = await f.api.register({profile:first,grant:f.g});
  const two = await f.api.register({profile:second,grant:f.g});
  const back = await f.api.register({profile:first,grant:f.g});
  const third = cloud({apiBase:'https://api-one.example/v1',apiModel:'another-model'});
  const other = await f.api.register({profile:third,grant:f.g});

  assert.notEqual(one.profile.revision, two.profile.revision);
  assert.equal(back.profile.revision, one.profile.revision);
  assert.notEqual(other.profile.revision, one.profile.revision);
});

test('directory, executable and credential changes retain the archive revision', async t => {
  const f = await switchFixture(t);
  const firstLocal = local4b('/models/a/Qwen3-Embedding-4B-Q4_K_M.gguf');
  const firstCloud = cloud({keyFile:'/keys/one.key'});
  const localRevision = (await f.api.register({profile:firstLocal,grant:f.g})).profile.revision;
  const cloudRevision = (await f.api.register({profile:firstCloud,grant:f.g})).profile.revision;

  const movedLocal = local4b('/models/b/Qwen3-Embedding-4B-Q4_K_M.gguf');
  movedLocal.backend.config.rawRecallLlamaServer = '/runtime/llama-server';
  const movedCloud = cloud({keyFile:'/keys/two.key'});

  assert.equal((await f.api.register({profile:movedLocal,grant:f.g})).profile.revision, localRevision);
  assert.equal((await f.api.register({profile:movedCloud,grant:f.g})).profile.revision, cloudRevision);
  assert.deepEqual(Object.keys(archiveIdentity(firstLocal)).sort(),
    ['adapter','assetName','dimensions','encoding','engine','model','queryInstruction']);
  assert.deepEqual(Object.keys(archiveIdentity(firstCloud)).sort(),
    ['adapter','apiBase','apiModel','dimensions','encoding','engine','model','queryInstruction']);
});

test('changing the local quantization filename creates a new archive', async t => {
  const f = await switchFixture(t);
  const q4 = await f.api.register({profile:local4b('/models/Qwen3-Embedding-4B-Q4_K_M.gguf'),grant:f.g});
  const q8 = await f.api.register({profile:local4b('/models/Qwen3-Embedding-4B-Q8_0.gguf'),grant:f.g});
  assert.notEqual(q8.profile.revision, q4.profile.revision);
});

test('legacy 4B and custom-api state keeps its original revisions', async t => {
  const f = await switchFixture(t);
  const oldLocal = local4b('/fictional/legacy/Qwen3-Embedding-4B-Q4_K_M.gguf');
  const oldCloud = cloud({apiBase:'https://api.siliconflow.cn/v1',apiModel:'BAAI/bge-m3',keyFile:'/fictional/legacy/bge.key'});
  const localRevision = 'legacy-local-revision', cloudRevision = 'legacy-cloud-revision';
  const state = {version:1,revision:'legacy-state-revision',scopes:[{
    ownerSubject:'fictional-owner',project:'fictional-project',assetCacheId:'00000000-0000-4000-8000-000000000001',
    profiles:[
      {id:oldLocal.id,versions:[{...structuredClone(oldLocal),revision:localRevision,createdAt:1}],currentRevision:localRevision},
      {id:oldCloud.id,versions:[{...structuredClone(oldCloud),revision:cloudRevision,createdAt:2}],currentRevision:cloudRevision},
    ],
    selectedProfileId:oldCloud.id,active:null,progress:[],
  }]};
  await fs.writeFile(f.file, JSON.stringify(state) + '\n');

  const local = await f.api.register({profile:oldLocal,grant:f.g});
  const remote = await f.api.register({profile:oldCloud,grant:f.g});
  const archives = await f.api.listArchives({grant:f.g});

  assert.equal(local.profile.revision, localRevision);
  assert.equal(remote.profile.revision, cloudRevision);
  assert.deepEqual(new Set(archives.map(row => row.revision)), new Set([localRevision, cloudRevision]));
});

test('archive listing reports active, selected and index stats without protected paths', async t => {
  const f = await switchFixture(t), active = cloud({apiBase:'https://api.alpha.example/v1',apiModel:'alpha-embed',keyFile:'/keys/fictional.key'});
  const selected = cloud({apiBase:'https://api.beta.example/v1',apiModel:'beta-embed'});
  f.setRows([doc('one'), doc('two')]);
  await f.choose(active); await prepare(f);
  await f.api.register({profile:selected,grant:f.g}); await f.api.select({profileId:'custom-api',grant:f.g});
  await f.restart();

  const archives = await f.api.listArchives({grant:f.g});
  const alpha = archives.find(row => row.apiModel === 'alpha-embed');
  const beta = archives.find(row => row.apiModel === 'beta-embed');

  assert.equal(archives.length, 2);
  assert.equal(alpha.name, 'alpha-embed · api.alpha.example');
  assert.equal(alpha.active, true); assert.equal(alpha.selected, false);
  assert.equal(alpha.indexed, true); assert.equal(alpha.documents, 2); assert.equal(alpha.chunks, 2);
  assert.equal(alpha.estimatedBytes, 2 * 8 * 4); assert.ok(Number.isFinite(alpha.lastReadyAt));
  assert.equal(alpha.needsCatchUp, null);
  assert.equal(beta.active, false); assert.equal(beta.selected, true); assert.equal(beta.indexed, false);
  const fields = new Set();
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) { fields.add(key); visit(child); }
  };
  visit(archives);
  for (const forbidden of ['config','backend','rawRecallApiKeyFile','rawRecallGgufModel','rawRecallPython','rawRecallCacheDir']) {
    assert.equal(fields.has(forbidden), false, forbidden);
  }
  assert.doesNotMatch(JSON.stringify(archives), /\/keys\/|fictional\.key|\/fictional\//);
});

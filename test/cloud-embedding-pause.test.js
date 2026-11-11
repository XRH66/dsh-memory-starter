import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConfig } from '../lib/config.js';
import { rawModelSpec } from '../lib/raw-rag/models.js';
import { CloudEmbeddingTransport } from '../lib/raw-rag/cloud-backend.js';

const CLOUD_PAUSE_MS = 5 * 60_000;
const DIMENSIONS = 3;

function fixture(t, { fetchImpl, now = Date.now, envName }) {
  const previous = process.env[envName];
  process.env[envName] = ['fictional', 'key'].join('-');
  t.after(() => {
    if (previous === undefined) delete process.env[envName];
    else process.env[envName] = previous;
  });
  const config = resolveConfig({
    rawRecallModel: 'custom-api',
    rawRecallApiBase: 'https://fictional-embed.example/v1',
    rawRecallApiModel: 'fictional-embed',
    rawRecallDimensions: DIMENSIONS,
    rawRecallAllowCloud: true,
    rawRecallApiKeyEnv: envName,
  });
  const transport = new CloudEmbeddingTransport({
    spec: rawModelSpec(config),
    config,
    now,
    fetchImpl,
  });
  t.after(() => transport.dispose());
  return transport;
}

function vectorResponse(embedding = [0.1, 0.2, 0.3]) {
  return new Response(JSON.stringify({ data: [{ index: 0, embedding }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('503 responses do not pause cloud embedding', async t => {
  let calls = 0;
  const transport = fixture(t, {
    envName: 'FICTIONAL_CLOUD_PAUSE_503_KEY',
    fetchImpl: async () => (++calls === 1 ? new Response('overloaded', { status: 503 }) : vectorResponse()),
  });
  await transport.prepare();

  await assert.rejects(transport.embed(['fictional text'], { kind: 'document' }), error => {
    assert.equal(error.code, 'EMBEDDING_HTTP_ERROR');
    assert.equal(error.status, 503);
    assert.equal(error.retryable, true);
    return true;
  });
  assert.equal(transport.blocked, false);
  assert.deepEqual(await transport.embed(['fictional text'], { kind: 'document' }), [[0.1, 0.2, 0.3]]);
  assert.equal(calls, 2);
});

test('400 responses do not pause cloud embedding', async t => {
  let calls = 0;
  const transport = fixture(t, {
    envName: 'FICTIONAL_CLOUD_PAUSE_400_KEY',
    fetchImpl: async () => (++calls === 1 ? new Response('invalid request', { status: 400 }) : vectorResponse()),
  });
  await transport.prepare();

  await assert.rejects(transport.embed(['fictional text'], { kind: 'document' }), error => {
    assert.equal(error.code, 'EMBEDDING_HTTP_ERROR');
    assert.equal(error.status, 400);
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(transport.blocked, false);
  assert.deepEqual(await transport.embed(['fictional text'], { kind: 'document' }), [[0.1, 0.2, 0.3]]);
  assert.equal(calls, 2);
});

test('caller cancellation does not pause cloud embedding', async t => {
  let calls = 0;
  const transport = fixture(t, {
    envName: 'FICTIONAL_CLOUD_PAUSE_CANCEL_KEY',
    fetchImpl: async (url, { signal }) => {
      calls += 1;
      if (calls > 1) return vectorResponse();
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  await transport.prepare();

  const controller = new AbortController();
  const pending = transport.embed(['fictional text'], { kind: 'document', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(transport.blocked, false);
  assert.deepEqual(await transport.embed(['fictional text'], { kind: 'document' }), [[0.1, 0.2, 0.3]]);
  assert.equal(calls, 2);
});

test('network failures pause cloud embedding until five minutes have elapsed', async t => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const transport = fixture(t, {
    envName: 'FICTIONAL_CLOUD_PAUSE_NETWORK_KEY',
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return vectorResponse();
    },
  });
  await transport.prepare();

  await assert.rejects(transport.embed(['fictional text'], { kind: 'document' }), /fetch failed/);
  assert.equal(transport.blocked, true);
  assert.equal(transport.blockedUntil, now + CLOUD_PAUSE_MS);
  await assert.rejects(transport.embed(['fictional text'], { kind: 'document' }), /retrying after/);
  assert.equal(calls, 1);

  now += CLOUD_PAUSE_MS + 1;
  assert.deepEqual(await transport.embed(['fictional text'], { kind: 'document' }), [[0.1, 0.2, 0.3]]);
  assert.equal(calls, 2);
  assert.equal(transport.blocked, false);
});

test('invalid 2xx vectors pause cloud embedding like an uncertain response', async t => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const transport = fixture(t, {
    envName: 'FICTIONAL_CLOUD_PAUSE_INVALID_KEY',
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? vectorResponse([0.1, 0.2]) : vectorResponse();
    },
  });
  await transport.prepare();

  await assert.rejects(transport.embed(['fictional text'], { kind: 'document' }), /invalid vector dimensions/);
  assert.equal(transport.blocked, true);
  await assert.rejects(transport.embed(['fictional text'], { kind: 'document' }), /retrying after/);
  assert.equal(calls, 1);

  now += CLOUD_PAUSE_MS + 1;
  assert.deepEqual(await transport.embed(['fictional text'], { kind: 'document' }), [[0.1, 0.2, 0.3]]);
  assert.equal(calls, 2);
  assert.equal(transport.blocked, false);
});

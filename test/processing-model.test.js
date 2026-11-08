import test from 'node:test';
import assert from 'node:assert/strict';
import { Config, resolveConfig } from '../lib/config.js';
import { measuredLlm } from '../lib/usage.js';
import { ensureProcessingScope, memoryProcessingCapabilities, processingCacheNamespace,
  resolveProcessingTarget, streamMemoryProcessing } from '../lib/processing-model.js';

const SCOPE = '00000000-0000-4000-8000-000000000000';
const agent = { session: { requestHeader: () => ({ config: { provider: 'answer', model: 'current' } }) },
  options: { provider: 'same-agent', model: 'fallback' } };

test('legacy selections preserve fixed routes while an explicit follow ignores stale fixed fields', () => {
  assert.equal(resolveConfig(Config({})).captureTargetMode, 'follow');
  const fixed = resolveConfig({ captureProvider: ' old ', captureModel: ' model ' });
  assert.equal(fixed.captureTargetMode, 'fixed');
  assert.deepEqual(resolveProcessingTarget(fixed, agent), { provider: 'old', model: 'model' });
  assert.deepEqual(resolveProcessingTarget({ ...fixed, captureTargetMode: 'follow' }, agent), { provider: 'answer', model: 'current' });
  assert.equal(resolveProcessingTarget(resolveConfig({ captureProvider: 'old' }), agent), null);
  assert.equal(resolveProcessingTarget({ captureTargetMode: 'unknown' }, agent), null);
});

test('follow uses only the original agent and never combines partial targets', () => {
  assert.deepEqual(resolveProcessingTarget({}, { session: { requestHeader() { throw Error('unavailable'); } }, options: agent.options }), agent.options);
  assert.equal(resolveProcessingTarget({}, { options: { provider: 'half' } }), null);
});

test('the processing entry preserves source identity, cancellation and frozen task targets', async () => {
  const seen = [], signal = new AbortController().signal;
  const chunks = [{ type: 'text-delta', text: 'fixture' }, { type: 'finish', reason: { kind: 'completed' } }];
  const llm = { async *stream(options) { seen.push(options); yield* chunks; } };
  const input = { llm, config: { captureTargetMode: 'follow', processingScopeId: SCOPE }, agent,
    target: { provider: 'frozen', model: 'original' }, sessionId: 'source-session', purpose: 'memory-capture',
    system: 'fixture rules', messages: [], signal, maxTokens: 200 };
  assert.deepEqual(await Array.fromAsync(streamMemoryProcessing(input)), chunks);
  assert.equal(seen[0].sessionId, 'source-session');
  assert.equal(seen[0].provider, 'frozen');
  assert.equal(seen[0].model, 'original');
  assert.equal(seen[0].signal, signal);
  assert.equal(seen[0].purpose, 'memory-capture');
  assert.equal(seen[0].cacheNamespace, processingCacheNamespace({ scopeId: SCOPE, purpose: 'memory-capture' }));
  assert.equal(seen[0].system, input.system);
  assert.equal(seen[0].maxTokens, 200);
  assert.ok(!seen[0].cacheNamespace.includes('source-session'));
});

test('purposes and prompt versions have stable, separate namespaces without copying identifiers', () => {
  const capture = processingCacheNamespace({ scopeId: SCOPE, purpose: 'memory-capture' });
  assert.equal(capture, processingCacheNamespace({ scopeId: SCOPE, purpose: 'memory-capture' }));
  assert.notEqual(capture, processingCacheNamespace({ scopeId: SCOPE, purpose: 'memory-maintenance' }));
  assert.notEqual(capture, processingCacheNamespace({ scopeId: SCOPE, purpose: 'memory-capture', promptVersion: '2' }));
  assert.equal(processingCacheNamespace({ purpose: 'memory-capture' }), undefined);
  assert.throws(() => processingCacheNamespace({ scopeId: 'personal-name', purpose: 'memory-capture' }), { code: 'MEMORY_PROCESSING_SCOPE_INVALID' });
});

test('invalid targets and purposes stop before generation instead of borrowing a route', () => {
  let calls = 0;
  const base = { llm: { stream() { calls++; } }, config: { captureProvider: 'half' }, agent,
    sessionId: 'source-session', purpose: 'memory-capture' };
  assert.throws(() => streamMemoryProcessing(base), { code: 'MEMORY_PROCESSING_TARGET_INCOMPLETE' });
  assert.throws(() => streamMemoryProcessing({ ...base, config: {}, target: null }), { code: 'MEMORY_PROCESSING_TARGET_UNAVAILABLE' });
  assert.throws(() => streamMemoryProcessing({ ...base, config: {}, purpose: 'answer' }), { code: 'MEMORY_PROCESSING_PURPOSE_INVALID' });
  assert.throws(() => streamMemoryProcessing({ ...base, sessionId: '' }), { code: 'MEMORY_PROCESSING_SESSION_REQUIRED' });
  assert.equal(calls, 0);
});

test('library identity commits once through the existing serialized store and survives recreation', async () => {
  let saved = {}, updates = 0, chain = Promise.resolve();
  const store = () => ({ read: async () => structuredClone(saved), update(fn) {
    const result = chain.then(() => { const next = structuredClone(saved); fn(next); saved = next; updates++; });
    chain = result.catch(() => {}); return result;
  } });
  const mounted = store();
  const ids = await Promise.all([ensureProcessingScope(mounted), ensureProcessingScope(mounted)]);
  assert.equal(ids[0], ids[1]);
  assert.equal(await ensureProcessingScope(store()), ids[0]);
  assert.match(ids[0], /^[0-9a-f-]{36}$/);
  const before = updates;
  assert.equal(await ensureProcessingScope(mounted), ids[0]);
  assert.equal(updates, before);
});

test('invalid saved identity or a failed durable write is not replaced by an ephemeral success', async () => {
  await assert.rejects(ensureProcessingScope({ read: async () => ({ processingScopeId: 'invalid' }), update() { throw Error('must not repair'); } }),
    { code: 'MEMORY_PROCESSING_SCOPE_INVALID' });
  await assert.rejects(ensureProcessingScope({ read: async () => ({}), async update() { throw Error('fixture write failed'); } }), /fixture write failed/);
});

test('host support is declared independently from the presence of request fields', () => {
  assert.deepEqual(memoryProcessingCapabilities({}), { version: 0, cacheNamespace: false, catalogProvider: false });
  assert.deepEqual(memoryProcessingCapabilities({ memoryProcessingCapabilities: { version: 1, cacheNamespace: true, catalogProvider: false } }),
    { version: 1, cacheNamespace: true, catalogProvider: false });
});

test('usage observes one request with its real session and distinguishes declared support', async () => {
  const reports = [], seen = [];
  const capability = { version: 1, cacheNamespace: true, catalogProvider: false };
  const llm = { memoryProcessingCapabilities: capability, async *stream(options) {
    seen.push(options);
    yield { type: 'finish', reason: { kind: 'completed' }, usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 } };
  } };
  const measured = measuredLlm(llm, item => reports.push(item), { phase: 'capture' });
  assert.equal(measured.memoryProcessingCapabilities, capability);
  await Array.fromAsync(streamMemoryProcessing({ llm: measured, config: { processingScopeId: SCOPE }, agent,
    sessionId: 'source-session', purpose: 'memory-capture', messages: [] }));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, 'source-session');
  assert.equal(new Set(reports.map(item => item.id)).size, 1);
  assert.equal(reports.at(-1).purpose, 'memory-capture');
  assert.equal(reports.at(-1).cacheNamespaceRequested, true);
  assert.equal(reports.at(-1).cacheNamespaceDeclaredSupported, true);
  assert.equal(reports.at(-1).usage.total, 3);
});

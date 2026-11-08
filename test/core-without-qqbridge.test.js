import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('ordinary core loads without QQBridge and gives a clear error for the unified candidate', async t => {
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  const tempParent = path.join(sourceRoot, '.local');
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, 'core-without-qq-'));
  t.after(async () => {
    assert.equal(path.dirname(root), tempParent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, 'lib');
  const { files } = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  for (const file of files.filter(file => file.startsWith('lib/') && !file.startsWith('lib/qqbridge/'))) {
    const destination = path.join(root, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, file), destination);
  }
  await assert.rejects(fs.access(path.join(target, 'qqbridge')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(target, 'unified/index.js')), { code: 'ENOENT' });
  const { apply } = await import(pathToFileURL(path.join(target, 'bundle-entry.js')).href);
  await assert.rejects(apply({}, { mode: 'unified' }), {
    code: 'UNIFIED_CANDIDATE_REQUIRED',
    message: /standalone unified candidate.*portable or legacy/,
  });
  const { createBridge } = await import(pathToFileURL(path.join(target, 'index.js')).href);
  const bridge = createBridge({ config: {}, tools: {}, llm: {} });
  try {
    assert.equal(typeof bridge.onRequest, 'function');
    assert.equal(typeof bridge.onSessionEvent, 'function');
  } finally {
    await bridge.dispose();
  }
  const { createPersonalMemoryRuntime } = await import(pathToFileURL(path.join(target, 'personal-runtime.js')).href);
  const personal = await createPersonalMemoryRuntime({
    directory: path.join(root, 'personal'), config: {},
    acquireMemory: async () => ({tools: {}}), llm: {},
  });
  try {
    await personal.recentStore.record({sessionId:'session-fixture',turn:1,user:{id:'fixture-1',text:'测试短期交流',time:'2026-10-31T12:00:00Z'}});
    const page=await personal.recentStore.page({sessionId:'session-other',turn:2,maxChars:1000});
    assert.match(page.text,/测试短期交流/);
    await assert.rejects(personal.recentStore.record({channel:'qqbridge',accountId:'710000002',conversationKey:'private:710000001',senderId:'710000001',sessionId:'qq',turn:1,user:{id:'qq-1',text:'未绑定',time:'2026-10-31T12:00:00Z'}}),/outside the bound owner scope/);
  } finally { await personal.close(); }
});

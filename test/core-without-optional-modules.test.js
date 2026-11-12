import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

test('ordinary core loads without optional modules and rejects removed runtime entry points', async t => {
  const sourceRoot = path.resolve(import.meta.dirname, '..');
  const tempParent = path.join(sourceRoot, '.local');
  await fs.mkdir(tempParent, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempParent, 'core-without-optional-'));
  t.after(async () => {
    assert.equal(path.dirname(root), tempParent);
    await fs.rm(root, { recursive: true, force: true });
  });
  const target = path.join(root, 'lib');
  const { files } = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'));
  for (const file of files.filter(file => file.startsWith('lib/'))) {
    const destination = path.join(root, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, file), destination);
  }
  const { apply } = await import(pathToFileURL(path.join(target, 'bundle-entry.js')).href);
  assert.throws(() => apply({}, { mode: 'unified' }), /已不支持 unified 模式/);
  assert.throws(() => apply({}, { mode: 'portable', sessionMemory: false }), /不再支持不用对话开关的运行方式/);
  const { createBridge } = await import(pathToFileURL(path.join(target, 'index.js')).href);
  assert.equal(typeof createBridge, 'function');
  assert.throws(() => createBridge({ config: {}, tools: {}, llm: {} }), /对话记忆授权未接入/);
});

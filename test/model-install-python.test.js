import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { findPython } from '../lib/raw-rag/install-files.js';

test('an inaccessible automatic Python alias cannot block a usable runtime; explicit paths report their error', async t => {
  const parent = path.resolve(os.tmpdir()), root = await fs.mkdtemp(path.join(parent, 'dsh-python-discovery-'));
  const previousPath = process.env.PATH, previousLocal = process.env.LOCALAPPDATA;
  t.after(async () => {
    process.env.PATH = previousPath;
    if (previousLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocal;
    const relative = path.relative(parent, root);
    assert.ok(relative.startsWith('dsh-python-discovery-') && !relative.startsWith('..') && !path.isAbsolute(relative));
    await fs.rm(root, { recursive: true, force: true });
  });
  const aliasDir = path.join(root, 'store-alias'), goodDir = path.join(root, 'python312');
  await fs.mkdir(aliasDir); await fs.mkdir(goodDir);
  const executable = process.platform === 'win32' ? 'python.exe' : 'python3';
  const alias = path.join(aliasDir, executable), good = path.join(goodDir, executable);
  await fs.writeFile(alias, 'fixture'); await fs.writeFile(good, 'fixture');
  await fs.writeFile(path.join(goodDir, 'python312.dll'), 'fixture');
  process.env.PATH = [aliasDir, goodDir].join(path.delimiter); process.env.LOCALAPPDATA = root;
  const original = fs.stat.bind(fs);
  t.mock.method(fs, 'stat', async (file, ...args) => {
    if (file === alias) throw Object.assign(new Error('Inaccessible optional alias'), { code: 'EACCES' });
    return original(file, ...args);
  });
  const config = { backend: { command: path.join(root, 'missing', 'backend.exe') } };
  assert.equal((await findPython(config)).file, good);
  await assert.rejects(findPython(config, { rawRecallPython: alias }), { code: 'EACCES' });
});

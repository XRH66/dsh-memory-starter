import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratchDirectory } from './helpers.js';

const script = path.resolve(import.meta.dirname, '..', 'scripts', 'check-release-export.mjs');

function git(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
}

async function fixture(t) {
  const available = git(process.cwd(), ['--version']);
  if (available.status !== 0) {
    t.skip('Git is unavailable');
    return null;
  }
  const root = await scratchDirectory('release-check-');
  await fs.mkdir(path.join(root, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  await fs.copyFile(script, path.join(root, 'scripts', 'check-release-export.mjs'));
  await fs.writeFile(path.join(root, 'lib', 'fixture.js'), 'export const fixture = true;\n');
  const manifest = ['lib/fixture.js', 'scripts/check-release-export.mjs'];
  await fs.writeFile(path.join(root, 'release-files.json'), JSON.stringify(manifest, null, 2));
  assert.equal(git(root, ['init', '--quiet']).status, 0);
  assert.equal(git(root, ['add', '.']).status, 0);
  return { root, manifest };
}

function validate(root, env = process.env) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'check-release-export.mjs'), '--validate-only'], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('release validation accepts only tracked allowlisted files', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const result = validate(f.root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /白名单跟踪状态通过: 2 个文件/u);
  assert.match(result.stdout, /源码白名单完整性通过: 2 个 Git 跟踪代码文件/u);
});

test('release validation rejects an existing but untracked allowlisted file', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await fs.writeFile(path.join(f.root, 'local-only.txt'), 'fixture\n');
  await fs.writeFile(path.join(f.root, 'release-files.json'), JSON.stringify([...f.manifest, 'local-only.txt'], null, 2));
  const result = validate(f.root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /local-only\.txt: allowlisted file is not tracked/u);
});

test('release validation rejects a tracked code file omitted from the manifest', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  await fs.writeFile(path.join(f.root, 'release-files.json'), JSON.stringify(['scripts/check-release-export.mjs'], null, 2));
  const result = validate(f.root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lib\/fixture\.js: tracked code file is absent from release-files\.json/u);
});

test('release validation ignores hostile Git environment overrides', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const result = validate(f.root, {
    ...process.env,
    GIT_DIR: path.join(f.root, 'must-not-be-used.git'),
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.http://127.0.0.1:9/.insteadOf',
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /白名单跟踪状态通过: 2 个文件/u);
});

test('release check removes its temporary export when a child step fails', async (t) => {
  const f = await fixture(t);
  if (!f) return;
  const fakeNpm = path.join(f.root, 'fake-npm.cjs');
  await fs.writeFile(fakeNpm, 'process.exit(7);\n');
  await fs.writeFile(path.join(f.root, 'package-lock.json'), '{}\n');
  await fs.writeFile(path.join(f.root, 'release-files.json'), JSON.stringify([...f.manifest, 'package-lock.json'], null, 2));
  assert.equal(git(f.root, ['add', 'package-lock.json']).status, 0);
  const result = spawnSync(process.execPath, [path.join(f.root, 'scripts', 'check-release-export.mjs')], {
    cwd: f.root,
    env: { ...process.env, npm_execpath: fakeNpm },
    encoding: 'utf8',
    windowsHide: true,
  });
  const output = result.stdout + result.stderr;
  assert.equal(result.status, 1);
  const match = /导出目录: (.+?)[\\/]export/u.exec(output);
  assert.ok(match, output);
  const tempRoot = match[1];
  await assert.rejects(fs.access(tempRoot), { code: 'ENOENT' });
});

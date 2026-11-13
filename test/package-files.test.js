import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { scratchDirectory } from './helpers.js';

const root = path.resolve(import.meta.dirname, '..');

function npmPack() {
  const npmCli = process.env.npm_execpath || [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((file) => fs.existsSync(file));
  const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [
    ...(npmCli ? [npmCli] : []),
    'pack',
    '--dry-run',
    '--json',
    '--ignore-scripts',
  ];
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    shell: !npmCli && process.platform === 'win32',
  });
}

function trackedFiles() {
  const result = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return new Set(result.stdout.split('\0').filter(Boolean));
}

function entrypoints(pkg) {
  const values = [pkg.main, pkg.dsh?.bundle?.patch];
  const visit = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) values.push(value.slice(2));
    } else if (value && typeof value === 'object') {
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(pkg.exports);
  return [...new Set(values.filter(Boolean).map((file) => path.posix.normalize(file)))];
}

function resolveRelative(from, specifier) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  return [base, base + '.js', base + '.mjs', base + '.cjs', base + '.json', path.posix.join(base, 'index.js')]
    .find((file) => fs.existsSync(path.join(root, file)));
}

function runtimeClosure(files) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const pending = entrypoints(pkg);
  const seen = new Set(['package.json']);
  const patterns = [
    /(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/gu,
    /import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu,
    /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/gu,
    /new\s+URL\s*\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/gu,
  ];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(fs.existsSync(path.join(root, file)), `entry or import does not exist: ${file}`);
    if (!/\.(?:js|mjs|cjs)$/u.test(file)) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of source.matchAll(pattern)) {
        const resolved = resolveRelative(file, match[1]);
        assert.ok(resolved, `relative import from ${file} cannot be resolved: ${match[1]}`);
        pending.push(resolved);
      }
    }
  }
  for (const file of seen) assert.ok(files.has(file), `runtime closure file is not packaged: ${file}`);
  for (const entry of pkg.files.filter((file) => !file.endsWith('/'))) {
    assert.ok(files.has(entry), `package.json files entry is not packaged: ${entry}`);
  }
}

test('npm package is self-contained and contains only tracked files', () => {
  const result = npmPack();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const output = JSON.parse(result.stdout);
  const files = new Set(output.flatMap((entry) => entry.files.map((file) => file.path)));
  const required = [
    'NOTICE.md',
    'scripts/install/configure.mjs',
    'scripts/install/dsh-cli.mjs',
    'scripts/install/optional-patches.mjs',
    'scripts/install/use-deployment.ps1',
    'third-party/dsh-mcp-control.LICENSE',
    'third-party/suzu-memory.LICENSE',
    'third-party/patches/genui-prompt-on-demand.js',
    'third-party/patches/manifest.json',
  ];
  for (const file of required) assert.ok(files.has(file), `missing package file: ${file}`);
  const releaseFiles = JSON.parse(fs.readFileSync(path.join(root, 'release-files.json'), 'utf8'));
  for (const file of releaseFiles.filter((file) => file.startsWith('third-party/') || file.startsWith('scripts/install/'))) {
    assert.ok(files.has(file), `required release asset is not packaged: ${file}`);
  }
  for (const file of files) assert.equal(file.startsWith('vendor/'), false, `vendor local data is packaged: ${file}`);
  runtimeClosure(files);

  const tracked = trackedFiles();
  if (tracked) {
    const untracked = [...files].filter((file) => !tracked.has(file)).sort();
    assert.deepEqual(untracked, []);
  }
});

test('packed optional patch command resolves its manifest and asset directory', async (t) => {
  const result = npmPack();
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const entries = JSON.parse(result.stdout);
  const files = entries.flatMap((entry) => entry.files.map((file) => file.path));
  const staging = await scratchDirectory('package-files-');
  for (const file of files) {
    const destination = path.join(staging, file);
    await fsPromises.mkdir(path.dirname(destination), { recursive: true });
    await fsPromises.copyFile(path.join(root, file), destination);
  }
  const run = spawnSync(process.execPath, [path.join(staging, 'scripts', 'install', 'optional-patches.mjs')], {
    cwd: staging,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /Select genui or billion/u);
  assert.doesNotMatch(run.stderr, /ENOENT/u);
});

test('third-party version table matches the lockfile', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const notice = fs.readFileSync(path.join(root, 'NOTICE.md'), 'utf8');
  const rows = [...notice.matchAll(/^\| `([^`]+)` \| ([^| ]+) \|/gmu)];
  const mismatches = [];
  for (const [, name, declared] of rows) {
    const actual = lock.packages?.['node_modules/' + name]?.version;
    if (actual && actual !== declared) mismatches.push({ name, declared, actual });
  }
  assert.deepEqual(mismatches, []);
});

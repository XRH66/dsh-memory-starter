import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifestPath = path.join(root, 'release-files.json');
const codeRoots = ['lib/', 'scripts/', 'test/'];

// Keep this table empty unless a tracked code file must stay out of the source release.
// Every entry is [repository-relative path, non-empty reason].
const trackedCodeExclusions = new Map([
]);

function throwErrors(title, errors) {
  if (!errors.length) return;
  throw new Error(title + '\n- ' + errors.join('\n- '));
}

function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest) || manifest.some((entry) => typeof entry !== 'string')) {
    throw new Error('release-files.json 必须是字符串数组');
  }
  return manifest;
}

function validateManifest(manifest) {
  const errors = [];
  const seen = new Set();
  for (const entry of manifest) {
    const normalized = path.posix.normalize(entry);
    if (
      !entry
      || entry.includes('\\')
      || entry.includes('\0')
      || path.posix.isAbsolute(entry)
      || normalized !== entry
      || normalized === '..'
      || normalized.startsWith('../')
    ) {
      errors.push(entry + ': must be a normalized repository-relative path');
      continue;
    }
    if (entry.split('/').some((part) => ['.git', '.local', 'node_modules'].includes(part))) {
      errors.push(entry + ': local or dependency directory is not exportable');
      continue;
    }
    if (seen.has(entry)) errors.push(entry + ': duplicate allowlist entry');
    seen.add(entry);
    const source = path.join(root, entry);
    let stat;
    try {
      stat = fs.lstatSync(source);
    } catch {
      errors.push(entry + ': allowlisted file missing');
      continue;
    }
    if (stat.isSymbolicLink()) errors.push(entry + ': symlink is not exportable');
    else if (!stat.isFile()) errors.push(entry + ': allowlisted path is not a regular file');
  }
  throwErrors('release-files.json 校验失败', errors);
}

function gitEnvironment() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const nullConfig = process.platform === 'win32' ? 'NUL' : os.devNull;
  return {
    ...env,
    GIT_CONFIG_GLOBAL: nullConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: nullConfig,
    GIT_TERMINAL_PROMPT: '0',
  };
}

function listTrackedFiles(roots = null) {
  const pathspec = roots?.length ? ['--', ...roots] : [];
  const result = spawnSync(
    'git',
    ['-c', 'core.quotepath=false', 'ls-files', '-z', ...pathspec],
    { cwd: root, env: gitEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || 'git ls-files failed';
    if (/not a git repository|not a git work tree/i.test(detail)) return null;
    throw new Error('无法读取 Git 跟踪文件: ' + detail);
  }
  return result.stdout.split('\0').filter(Boolean);
}

function checkManifestTracking(manifest, trackedFiles) {
  if (!trackedFiles) {
    console.log('[release:check] 未检测到 Git 工作树，跳过白名单跟踪状态检查');
    return;
  }
  const tracked = new Set(trackedFiles);
  const errors = manifest
    .filter((file) => !tracked.has(file))
    .map((file) => file + ': allowlisted file is not tracked');
  throwErrors('白名单跟踪状态检查失败', errors);
  console.log(`[release:check] 白名单跟踪状态通过: ${manifest.length} 个文件`);
}

function checkTrackedCodeCompleteness(manifest, trackedFiles) {
  if (!trackedFiles) {
    console.log('[release:check] 未检测到 Git 工作树，跳过源码白名单完整性检查');
    return null;
  }

  const errors = [];
  const allowed = new Set(manifest);
  for (const [file, reason] of trackedCodeExclusions) {
    if (!codeRoots.some((prefix) => file.startsWith(prefix))) {
      errors.push(file + ': exclusion must be under lib/, scripts/, or test/');
    }
    if (typeof reason !== 'string' || !reason.trim()) {
      errors.push(file + ': exclusion reason is required');
    }
    if (!trackedFiles.includes(file)) errors.push(file + ': exclusion is not a tracked code file');
  }
  for (const file of trackedFiles) {
    if (!allowed.has(file) && !trackedCodeExclusions.has(file)) {
      errors.push(file + ': tracked code file is absent from release-files.json');
    }
  }
  throwErrors('源码白名单完整性检查失败', errors);
  console.log(`[release:check] 源码白名单完整性通过: ${trackedFiles.length} 个 Git 跟踪代码文件`);
  return trackedFiles.length;
}

function sensitiveEnvironmentKey(key) {
  if (/^npm_config_/i.test(key)) return true;
  if (/^GIT_/i.test(key)) return true;
  if (/^(?:NODE_PATH|NODE_OPTIONS|NODE_USE_ENV_PROXY|SSH_AUTH_SOCK|SSH_ASKPASS|GIT_ASKPASS)$/i.test(key)) return true;
  if (/^(?:(?:HTTP|HTTPS|ALL|NO)_PROXY)$/i.test(key)) return true;
  if (/^(?:HOME|USERPROFILE|APPDATA|LOCALAPPDATA|XDG_CONFIG_HOME|XDG_CACHE_HOME|CODEX_HOME|TEMP|TMP|TMPDIR)$/i.test(key)) return true;
  if (/^(?:OPENAI|ANTHROPIC|DEEPSEEK|DSH|GEMINI|AZURE_OPENAI)_/i.test(key)) return true;
  return /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_KEY|PRIVATE_KEY|AUTH)(?:_|$)/i.test(key);
}

function releaseEnvironment(paths) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (sensitiveEnvironmentKey(key)) delete env[key];
  }
  return {
    ...env,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CONFIG_HOME: paths.xdgConfig,
    XDG_CACHE_HOME: path.join(paths.home, '.cache'),
    CODEX_HOME: paths.codexHome,
    TEMP: paths.temp,
    TMP: paths.temp,
    TMPDIR: paths.temp,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    NO_PROXY: '',
    GIT_ALLOW_PROTOCOL: 'https',
    GIT_CONFIG_GLOBAL: paths.gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: paths.gitConfig,
    GIT_SSH_COMMAND: 'git-ssh-disabled',
    GIT_TERMINAL_PROMPT: '0',
    NO_UPDATE_NOTIFIER: '1',
    npm_config_audit: 'false',
    npm_config_cache: paths.npmCache,
    npm_config_fund: 'false',
    npm_config_globalconfig: paths.npmGlobalConfig,
    npm_config_registry: 'https://registry.npmjs.org/',
    npm_config_update_notifier: 'false',
    npm_config_userconfig: paths.npmUserConfig,
  };
}

function run(command, args, cwd, env) {
  console.log(`[release:check] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 失败，退出码 ${result.status}`);
}

function npmCliPath() {
  if (process.env.npm_execpath) return process.env.npm_execpath;
  return [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ].find((file) => fs.existsSync(file)) || null;
}

function runNpm(args, cwd, env) {
  const cli = npmCliPath();
  if (!cli) throw new Error('未找到 npm CLI；请通过 npm run release:check 调用，或从 Node.js 安装目录执行');
  run(process.execPath, [cli, ...args], cwd, env);
}

const validateOnly = process.argv.includes('--validate-only');
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== '--validate-only');
if (unknownArguments.length) throw new Error('未知参数: ' + unknownArguments.join(' '));

const manifest = readManifest();
validateManifest(manifest);
const trackedFiles = listTrackedFiles();
checkManifestTracking(manifest, trackedFiles);
const trackedCodeFiles = trackedFiles
  ? checkTrackedCodeCompleteness(manifest, trackedFiles.filter((file) => codeRoots.some((prefix) => file.startsWith(prefix))))
  : checkTrackedCodeCompleteness(manifest, null);

if (validateOnly) {
  console.log(JSON.stringify({ ok: true, validatedFiles: manifest.length, trackedCodeFiles, validateOnly: true }, null, 2));
  process.exit(0);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-basic-memory-bridge-release-'));
const exportRoot = path.join(tempRoot, 'export');
const toolsRoot = path.join(tempRoot, 'tools');
const paths = {
  home: path.join(tempRoot, 'home'),
  temp: path.join(tempRoot, 'tmp'),
  appData: path.join(tempRoot, 'home', 'AppData', 'Roaming'),
  localAppData: path.join(tempRoot, 'home', 'AppData', 'Local'),
  xdgConfig: path.join(tempRoot, 'home', '.config'),
  codexHome: path.join(tempRoot, 'home', '.codex'),
  gitConfig: path.join(toolsRoot, 'gitconfig'),
  npmCache: path.join(tempRoot, 'npm-cache'),
  npmGlobalConfig: path.join(toolsRoot, 'npm-globalrc'),
  npmUserConfig: path.join(toolsRoot, 'npmrc'),
};
let completed = false;

try {
  fs.mkdirSync(exportRoot, { recursive: true });
  fs.mkdirSync(toolsRoot, { recursive: true });
  for (const directory of [paths.home, paths.temp, paths.appData, paths.localAppData, paths.xdgConfig, paths.codexHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  for (const entry of manifest) {
    const destination = path.join(exportRoot, entry);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, entry), destination, fs.constants.COPYFILE_EXCL);
  }

  fs.writeFileSync(paths.gitConfig, '');
  fs.writeFileSync(paths.npmGlobalConfig, '');
  fs.writeFileSync(paths.npmUserConfig, [
    'audit=false',
    'fund=false',
    'registry=https://registry.npmjs.org/',
    'update-notifier=false',
    '',
  ].join('\n'));

  const env = releaseEnvironment(paths);
  const lockPath = path.join(exportRoot, 'package-lock.json');
  const lockBefore = fs.readFileSync(lockPath);

  console.log(`[release:check] 导出目录: ${exportRoot}`);
  runNpm(['ci', '--no-audit', '--no-fund', '--ignore-scripts'], exportRoot, env);
  if (!lockBefore.equals(fs.readFileSync(lockPath))) {
    throw new Error('npm ci 改写了导出目录中的 package-lock.json；应修正锁文件或记录可复现的规避方法');
  }

  runNpm(['test'], exportRoot, env);
  runNpm(['run', 'privacy'], exportRoot, env);
  runNpm(['run', 'links'], exportRoot, env);
  completed = true;
  console.log(JSON.stringify({ ok: true, exportedFiles: manifest.length, trackedCodeFiles }, null, 2));
} catch (error) {
  console.error('[release:check] 失败: ' + (error.stack || error.message));
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  } catch (error) {
    console.error('[release:check] 临时目录清理失败，现场保留在: ' + tempRoot);
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

if (completed && process.exitCode !== 1) {
  console.log('[release:check] 临时目录已清理');
}

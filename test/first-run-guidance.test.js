import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { setImmediate as idle } from 'node:timers/promises';

const source = await fs.readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
const children = node => node && typeof node === 'object' ? node.props?.children || [] : [];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : children(node).map(text).join('');
function nodes(tree, predicate) {
  if (!tree || typeof tree !== 'object') return [];
  return [...(predicate(tree) ? [tree] : []), ...children(tree).flatMap(child => nodes(child, predicate))];
}
function button(tree, label) {
  const found = nodes(tree, node => node.type === 'button' && text(node) === label)[0];
  assert.ok(found, 'Missing button: ' + label);
  return found;
}
const bootstrap = (extra = {}) => ({ ok: true, configured: false, frameworkLoaded: false, activation: null, consent: null, revision: null, sessions: [], personalDirectory: '/fictional/memory', ...extra });
const unavailableModel = {
  rawModel: { fields: { rawRecallModel: 'custom-api', rawRecallApiBase: 'https://example.invalid/v1', rawRecallApiModel: '', rawRecallApiKeyEnv: '' }, hasSavedApiKey: false },
  rawModels: [{ id: 'custom-api', label: '自定义 API', cloud: true }],
};
const availableModel = {
  rawModel: { fields: { rawRecallModel: 'custom-api', rawRecallApiBase: 'https://example.invalid/v1', rawRecallApiModel: 'fixture-embedding', rawRecallApiKeyEnv: '' }, hasSavedApiKey: true },
  pendingRawModel: null,
  rawModels: [{ id: 'custom-api', label: '自定义 API', cloud: true }],
};
const loadedMemory = (extra = {}) => ({
  ok: true, revision: 'r1', runtime: 'loaded', directory: '/fictional/memory',
  sessions: [
    { id: 'session-a', title: '测试对话 A', workspace: '测试项目', bound: false },
    { id: 'session-b', title: '测试对话 B', workspace: '测试项目', bound: false },
  ],
  sessionMemory: { defaultEnabled: false, effective: 'next-user-turn', autoEnableNew: false, enabledSessions: [], states: [] },
  ...unavailableModel,
  ...extra,
});

function environment({ bootstrapValue = bootstrap(), settingsValue = loadedMemory(), uiWorkspace = null, fetchHandler = null } = {}) {
  let rendering, plugin, timerId = 0;
  const registrations = new Map(), calls = [], hosts = [], storage = new Map();
  const state = { bootstrap: structuredClone(bootstrapValue), settings: structuredClone(settingsValue) };
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const cell = () => { const host = rendering, index = host.index++; return { host, index, previous: host.hooks[index] }; };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...items) {
      return { type, props: { ...props, children: items.flat(12).filter(item => item !== null && item !== undefined && item !== false) } };
    },
    useRef(value) { const c = cell(); return c.previous || (c.host.hooks[c.index] = { current: value }); },
    useState(initial) {
      const c = cell();
      const row = c.previous || (c.host.hooks[c.index] = { value: typeof initial === 'function' ? initial() : initial });
      return [row.value, value => { const next = typeof value === 'function' ? value(row.value) : value; if (!Object.is(next, row.value)) { row.value = next; c.host.dirty = true; } }];
    },
    useMemo(fn, deps) { const c = cell(); if (!c.previous || !same(c.previous.deps, deps)) c.host.hooks[c.index] = { value: fn(), deps }; return c.host.hooks[c.index].value; },
    useCallback(fn, deps) { return React.useMemo(() => fn, deps); },
    useEffect(fn, deps) {
      const c = cell();
      if (!c.previous || !same(c.previous.deps, deps)) {
        const row = { deps, cleanup: null }; c.host.hooks[c.index] = row;
        c.host.effects.push(() => { c.previous?.cleanup?.(); row.cleanup = fn(); });
      }
    },
  };
  const window = new EventTarget();
  Object.defineProperty(window, 'localStorage', { value: {
    getItem(key) { return storage.has(key) ? storage.get(key) : null; },
    setItem(key, value) { storage.set(key, String(value)); },
  } });
  window.__ModuleLoader__ = { load(value) { plugin = value.factory(name => { assert.equal(name, 'react'); return React; }); } };
  const jsonResponse = value => {
    const status = value?.httpStatus ?? (typeof value?.status === 'number' ? value.status : 200);
    return { ok: status >= 200 && status < 300, status, json: async () => {
      if (value?.invalidJson) throw new SyntaxError('Unexpected token o, "not found" is not valid JSON');
      const body = value?.body ?? value;
      return typeof body === 'object' ? structuredClone(body) : body;
    } };
  };
  vm.runInNewContext(source, {
    window, Event, AbortController, console,
    document: { getElementById: () => null },
    setInterval(fn) { const id = ++timerId; queueMicrotask(fn); return id; },
    clearInterval() {},
    setTimeout(fn) { const id = ++timerId; queueMicrotask(fn); return id; },
    clearTimeout() {},
    async fetch(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body, options });
      if (fetchHandler) {
        const handled = await fetchHandler(path, body, options, state);
        if (handled !== undefined) return jsonResponse(handled);
      }
      if (path === '/api/basic-memory-bootstrap' && (!options.method || options.method === 'GET')) return jsonResponse({ ok: true, ...state.bootstrap });
      if (path === '/api/basic-memory-bootstrap/location') return jsonResponse({ ok: true, status: 'missing', usable: true, directory: body.directory, message: '这个文件夹还不存在，继续后会在本机新建。' });
      if (path === '/api/basic-memory-bootstrap' && options.method === 'POST') {
        state.bootstrap = bootstrap({ configured: true, revision: 'r-config', personalDirectory: body.directory, sessions: state.settings.sessions });
        return jsonResponse({ ok: true, configured: true, directory: body.directory, initialised: true });
      }
      if (path === '/api/basic-memory-bootstrap/activation' && options.method === 'POST') {
        if (body.action === 'cancel') state.bootstrap = { ...state.bootstrap, activation: null, consent: null };
        else state.bootstrap = { ...state.bootstrap, activation: 'scheduled', consent: { sessionIds: body.sessionIds, autoEnableNewSessions: body.autoEnableNewSessions } };
        return jsonResponse({ ok: true, ...state.bootstrap });
      }
      if (path === '/api/basic-memory-settings/sessions') return jsonResponse({ ok: true, ...state.settings });
      if (path.startsWith('/api/basic-memory-settings/')) return jsonResponse({ ok: true, ...state.settings });
      return jsonResponse({ status: 404, ok: false, error: '未找到设置' });
    },
  }, { filename: 'fictional/client.js' });
  const services = new Map();
  if (uiWorkspace) services.set('uiWorkspace', uiWorkspace);
  plugin.apply({
    get: name => services.get(name),
    inject(names, callback) { if (names.every(name => services.has(name))) callback({ ...Object.fromEntries(services), get: name => services.get(name) }); },
    effect() {},
    slots: {
      inject(_name, register) { register(); },
      register(meta, render) { registrations.set(meta.name, render); },
    },
  });
  class Host {
    constructor(fn, props) { this.fn = fn; this.props = props; this.hooks = []; this.dirty = true; this.tree = null; hosts.push(this); }
    render(effects = true) {
      this.index = 0; this.effects = []; this.dirty = false; rendering = this;
      this.tree = this.fn(this.props); rendering = null;
      if (effects) for (const effect of this.effects) effect();
      return this.tree;
    }
    async flush() {
      let stable = 0;
      for (let i = 0; i < 80; i++) {
        if (this.dirty || !this.tree) { this.render(); stable = 0; }
        await idle();
        if (this.dirty) stable = 0; else stable++;
        if (stable >= 4) return;
      }
      throw Error('UI did not settle');
    }
    close() { for (const hook of this.hooks) hook?.cleanup?.(); }
  }
  return {
    calls, registrations, window, state, storage,
    page() { const tree = registrations.get('settings.section')(); return new Host(tree.type, tree.props); },
    wizard(page) {
      const node = nodes(page.tree, value => typeof value.type === 'function' && value.type.name === 'FirstRunWizard')[0];
      assert.ok(node, 'Missing FirstRunWizard'); return new Host(node.type, node.props);
    },
    header(sessionId = 'session-a') { return new Host(registrations.get('conversation.session.header.utilities'), { sessionId }); },
    component(node) { return new Host(node.type, node.props); },
    close() { for (const host of hosts) host.close(); },
  };
}

const settingsCalls = env => env.calls.filter(call => call.path.startsWith('/api/basic-memory-settings/'));

test('first-run wizard shows five named steps and keeps directory picking optional', async t => {
  const env = environment();
  t.after(() => env.close());
  const page = env.page(); await page.flush();
  const wizard = env.wizard(page); await wizard.flush();
  assert.match(text(wizard.tree), /第 1 步 \/ 共 5 步/);
  for (const label of ['选记忆库位置', '选择聊天', '启用并重启', '配置检索模型', '完成']) assert.match(text(wizard.tree), new RegExp(label));
  assert.match(text(wizard.tree), /这个文件夹只存在本机/);
  assert.doesNotMatch(text(wizard.tree), /选择文件夹…/);
  assert.equal(nodes(wizard.tree, node => node.type === 'input' && node.props?.value === '/fictional/memory').length, 1);
  assert.equal(settingsCalls(env).length, 0);
  for (const tab of ['检索模型', '状态', '维护']) {
    button(page.tree, tab).props.onClick(); await page.flush();
    assert.match(text(page.tree), /当前在第 1 步|首次使用还在第 1 步/);
    button(page.tree, '继续第 1 步').props.onClick(); await page.flush();
  }
});

test('directory picker uses uiWorkspace and falls back to browse primitives when native is unavailable', async t => {
  let mode = 'native', picks = 0, listed = 0;
  const uiWorkspace = {
    async pickDirectory() { picks++; if (mode === 'native') return null; throw Error('directoryPicker.pick needs the native capability; the composed picker serves "browse"'); },
    async listDirectory() { listed++; return { path: '/fictional', home: '/fictional', crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'fictional', path: '/fictional', hidden: false }], entries: [{ name: 'picked', path: '/fictional/picked', hidden: false }], truncated: false }; },
    async createDirectory(_path, name) { return '/fictional/' + name; },
  };
  const env = environment({ uiWorkspace }); t.after(() => env.close());
  const page = env.page(); await page.flush();
  const wizard = env.wizard(page); await wizard.flush();
  await button(wizard.tree, '选择文件夹…').props.onClick(); await wizard.flush();
  assert.equal(picks, 1);
  mode = 'browse';
  await button(wizard.tree, '选择文件夹…').props.onClick(); await wizard.flush();
  assert.equal(picks, 2, text(wizard.tree));
  const browseNode = nodes(wizard.tree, node => typeof node.type === 'function' && node.type.name === 'DirectoryBrowseFallback')[0];
  assert.ok(browseNode);
  const browse = env.component(browseNode); await browse.flush();
  assert.equal(listed, 1, text(browse.tree));
  assert.match(text(browse.tree), /选择这个文件夹/);
  assert.match(text(browse.tree), /picked/);
});

test('wizard creates the library, records explicit chat consent and resumes at step 3 after scheduling', async t => {
  const env = environment(); t.after(() => env.close());
  const page = env.page(); await page.flush();
  const wizard = env.wizard(page); await wizard.flush();
  const input = nodes(wizard.tree, node => node.type === 'input' && node.props?.placeholder === '文件夹的完整路径')[0];
  input.props.onChange({ target: { value: '/fictional/chosen-memory' } }); await wizard.flush();
  button(wizard.tree, '下一步').props.onClick(); await wizard.flush();
  assert.match(text(wizard.tree), /第 2 步 \/ 共 5 步/);
  assert.match(text(wizard.tree), /测试对话 A/);
  const sessionCheckbox = nodes(wizard.tree, node => node.type === 'input' && node.props?.type === 'checkbox')[0];
  sessionCheckbox.props.onChange({ target: { checked: true } });
  const autoCheckbox = nodes(wizard.tree, node => node.type === 'input' && node.props?.type === 'checkbox').at(-1);
  autoCheckbox.props.onChange({ target: { checked: true } });
  button(wizard.tree, '下一步').props.onClick(); await wizard.flush();
  button(wizard.tree, '启用').props.onClick(); await wizard.flush();
  assert.match(text(wizard.tree), /已安排下次 DSH 启动时启用/);
  assert.deepEqual(env.state.bootstrap.consent, { sessionIds: ['session-a'], autoEnableNewSessions: true });
  assert.equal(env.calls.filter(call => call.path === '/api/basic-memory-bootstrap/sessions').length, 0);

  env.state.bootstrap = bootstrap({ configured: true, frameworkLoaded: true, activation: 'active', revision: 'r1', personalDirectory: '/fictional/chosen-memory', consent: env.state.bootstrap.consent });
  env.state.settings = loadedMemory({ directory: '/fictional/chosen-memory', sessionMemory: {
    defaultEnabled: false, effective: 'next-user-turn', autoEnableNew: true, enabledSessions: ['session-a'],
    states: [{ sessionId: 'session-a', requested: true, active: false, pending: true }],
  } });
  const refreshed = env.page(); await refreshed.flush();
  const modelStep = env.wizard(refreshed); await modelStep.flush();
  assert.match(text(modelStep.tree), /第 4 步 \/ 共 5 步/);
  button(modelStep.tree, '先跳过').props.onClick(); await modelStep.flush();
  assert.match(text(modelStep.tree), /第 5 步 \/ 共 5 步/);
  assert.match(text(modelStep.tree), /session-a|测试对话 A/);
  assert.match(text(modelStep.tree), /新对话自动打开是/);
  button(modelStep.tree, '完成，返回记忆设置').props.onClick(); await modelStep.flush(); await refreshed.flush();
  assert.match(text(refreshed.tree), /记忆框架已加载/);
  assert.match(text(refreshed.tree), /测试对话 A/);
});

test('loaded users with an available retrieval model keep the existing settings page', async t => {
  const env = environment({ bootstrapValue: bootstrap({ configured: true, frameworkLoaded: true, activation: 'active' }), settingsValue: loadedMemory(availableModel) });
  t.after(() => env.close());
  const page = env.page(); await page.flush();
  assert.equal(settingsCalls(env).length, 1);
  assert.match(text(page.tree), /记忆框架已加载/);
  assert.match(text(page.tree), /测试对话 A/, JSON.stringify(env.calls));
  assert.equal(nodes(page.tree, node => typeof node.type === 'function' && node.type.name === 'FirstRunWizard').length, 0);
});

test('unloaded conversation control points to the current setup step', async t => {
  const env = environment({ bootstrapValue: bootstrap({ configured: true, activation: 'scheduled', consent: { sessionIds: [], autoEnableNewSessions: false } }) });
  t.after(() => env.close());
  const header = env.header(); await header.flush();
  assert.match(text(header.tree), /记忆未启用/);
  assert.match(text(header.tree), /请到设置页的「记忆框架」准备并启用，重启 DSH 后再使用/);
  assert.equal(button(header.tree, '记忆未启用').props.disabled, true);
  assert.equal(settingsCalls(env).length, 0);
});

test('non-json responses never expose parser messages', async t => {
  const first = environment({ fetchHandler: async path => path === '/api/basic-memory-bootstrap' ? { invalidJson: true } : undefined });
  t.after(() => first.close());
  const firstPage = first.page(); await firstPage.flush();
  assert.match(text(firstPage.tree), /无法读取记忆框架状态，请刷新页面后重试/);
  assert.doesNotMatch(text(firstPage.tree), /Unexpected token|not valid JSON/);

  const second = environment({
    bootstrapValue: bootstrap({ configured: true, frameworkLoaded: true, activation: 'active' }),
    fetchHandler: async path => path === '/api/basic-memory-settings/sessions' ? { invalidJson: true } : undefined,
  });
  t.after(() => second.close());
  const secondPage = second.page(); await secondPage.flush();
  assert.match(text(secondPage.tree), /对话记忆状态返回了无法识别的内容，请刷新页面后重试/);
  assert.doesNotMatch(text(secondPage.tree), /Unexpected token|not valid JSON/);
});

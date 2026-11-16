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
const bootstrap = (extra = {}) => ({ ok: true, configured: false, frameworkLoaded: false, activation: null, sessions: [], ...extra });
const loadedMemory = {
  ok: true, revision: 'r1', runtime: 'loaded', directory: '/fictional-memory',
  sessions: [{ id: 'session-a', title: '测试对话', workspace: '测试项目', bound: false }],
  sessionMemory: { defaultEnabled: false, effective: 'next-user-turn', enabledSessions: [], states: [] },
};

function environment({ bootstrapValue = bootstrap(), handler = () => loadedMemory } = {}) {
  let rendering, plugin, timerId = 0;
  const registrations = new Map(), calls = [], hosts = [];
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
  window.__ModuleLoader__ = { load(value) { plugin = value.factory(name => { assert.equal(name, 'react'); return React; }); } };
  vm.runInNewContext(source, {
    window, Event, AbortController, console,
    document: { getElementById: () => null },
    setInterval(fn) { const id = ++timerId; return id; },
    clearInterval() {},
    setTimeout(fn) { const id = ++timerId; queueMicrotask(fn); return id; },
    clearTimeout() {},
    async fetch(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body, options });
      const value = path === '/api/basic-memory-bootstrap' ? bootstrapValue : await handler(path, body, options);
      const status = value.status || 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => {
          if (value.invalidJson) throw new SyntaxError('Unexpected token o, "not found" is not valid JSON');
          return structuredClone(value.body || value);
        },
      };
    },
  }, { filename: 'fictional/client.js' });
  plugin.apply({
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
    async flush() { for (let i = 0; i < 30; i++) { if (this.dirty || !this.tree) this.render(); await idle(); if (!this.dirty) return; } throw Error('UI did not settle'); }
    close() { for (const hook of this.hooks) hook?.cleanup?.(); }
  }
  return {
    calls,
    registrations,
    window,
    page() { const tree = registrations.get('settings.section')(); return new Host(tree.type, tree.props); },
    header(sessionId = 'session-a') { return new Host(registrations.get('conversation.session.header.utilities'), { sessionId }); },
    component(node) { return new Host(node.type, node.props); },
    close() { for (const host of hosts) host.close(); },
  };
}

const settingsCalls = env => env.calls.filter(call => call.path.startsWith('/api/basic-memory-settings/'));

test('unloaded first run opens setup without requesting any settings endpoint', async t => {
  const env = environment();
  t.after(() => env.close());
  const page = env.page();
  await page.flush();
  const setupNode = nodes(page.tree, node => typeof node.type === 'function' && node.type.name === 'BootstrapSetup')[0];
  assert.ok(setupNode);
  const setup = env.component(setupNode);
  await setup.flush();
  assert.match(text(setup.tree), /准备独立记忆库/);
  assert.match(text(setup.tree), /准备新库和配置/);
  assert.doesNotMatch(text(setup.tree), /Unexpected token|not found/);
  assert.equal(nodes(page.tree, node => node.props?.role === 'alert').length, 0);
  assert.equal(settingsCalls(env).length, 0);
  for (const tab of ['检索模型', '状态', '维护']) {
    button(page.tree, tab).props.onClick();
    await page.flush();
    assert.match(text(page.tree), /记忆框架还没启用/);
    assert.match(text(page.tree), /先在「记忆」页准备记忆库并启用，重启 DSH 后再来这里配置/);
    assert.equal(nodes(page.tree, node => node.type === 'button' && text(node) === '去「记忆」页').length, 1);
  }
  assert.equal(settingsCalls(env).length, 0);
});

test('scheduled activation tells the user to restart before configuring vector service', async t => {
  const env = environment({ bootstrapValue: bootstrap({ configured: true, activation: 'scheduled', revision: 'r1' }) });
  t.after(() => env.close());
  const page = env.page();
  await page.flush();
  const setupNode = nodes(page.tree, node => typeof node.type === 'function' && node.type.name === 'BootstrapSetup')[0];
  assert.ok(setupNode);
  const setup = env.component(setupNode);
  await setup.flush();
  assert.match(text(setup.tree), /已安排下次 DSH 启动时启用/);
  assert.match(text(setup.tree), /重启 DSH 后生效/);
  assert.match(text(setup.tree), /生效后再到「检索模型」页配置向量服务/);
  assert.equal(settingsCalls(env).length, 0);
});

test('loaded memory keeps the existing settings page behavior', async t => {
  const env = environment({ bootstrapValue: bootstrap({ configured: true, frameworkLoaded: true, activation: 'active' }) });
  t.after(() => env.close());
  const page = env.page();
  await page.flush();
  assert.equal(settingsCalls(env).length, 1);
  assert.match(text(page.tree), /记忆框架已加载/);
  assert.match(text(page.tree), /测试对话/);
});

test('unloaded conversation control points to settings and does not retry settings requests', async t => {
  const env = environment();
  t.after(() => env.close());
  const header = env.header();
  await header.flush();
  assert.match(text(header.tree), /记忆未启用/);
  assert.match(text(header.tree), /请到设置页的「记忆框架」准备并启用，重启 DSH 后再使用/);
  assert.equal(button(header.tree, '记忆未启用').props.disabled, true);
  assert.equal(settingsCalls(env).length, 0);
});

test('non-json bootstrap and settings responses never expose the parser message', async t => {
  const first = environment({ bootstrapValue: { invalidJson: true } });
  t.after(() => first.close());
  const firstPage = first.page();
  await firstPage.flush();
  assert.match(text(firstPage.tree), /无法读取记忆框架状态，请刷新页面后重试/);
  assert.doesNotMatch(text(firstPage.tree), /Unexpected token|not valid JSON/);

  const second = environment({
    bootstrapValue: bootstrap({ configured: true, frameworkLoaded: true, activation: 'active' }),
    handler: () => ({ invalidJson: true }),
  });
  t.after(() => second.close());
  const secondPage = second.page();
  await secondPage.flush();
  assert.match(text(secondPage.tree), /对话记忆状态返回了无法识别的内容，请刷新页面后重试/);
  assert.doesNotMatch(text(secondPage.tree), /Unexpected token|not valid JSON/);
});

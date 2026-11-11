// Portable UI only: fictional receipts and requests, no server, model, or live configuration.
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
  assert.ok(found, 'Missing button: ' + label); return found;
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function environment(handler) {
  let rendering, plugin, timerId = 0;
  const registrations = new Map(), calls = [], timers = new Map(), hosts = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const cell = () => { const host = rendering, index = host.index++; return { host, index, previous: host.hooks[index] }; };
  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...items) { return { type, props: { ...props, children: items.flat(12).filter(item => item !== null && item !== undefined && item !== false) } }; },
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
    window, Event, console,
    document: { getElementById: () => null },
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    async fetch(path, options = {}) {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, body, options });
      const result = await handler(path, body, options), status = result.status || 200;
      return { ok: status >= 200 && status < 300, status, json: async () => structuredClone(result.body || result) };
    },
  }, { filename: 'portable/client.js' });
  plugin.apply({
    effect() {},
    remote: { pluginManager: {
      async listPlugins() { return { ok: true, value: [{ moduleName: '@local/dsh-basic-memory-bridge', enabled: true, fiberPhase: 'active' }] }; },
      async listBundles() { return { ok: true, value: [] }; },
    } },
    slots: { inject(_name, register) { register(); }, register(meta, render) { registrations.set(meta.name, render); } },
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
    async update(props) { this.props = { ...this.props, ...props }; this.dirty = true; await this.flush(); }
    close() { for (const hook of this.hooks) hook?.cleanup?.(); }
  }
  return {
    calls, timers, registrations, window,
    header: (sessionId = 'session-a', slot = 'conversation.session.header.utilities') => new Host(registrations.get(slot), { sessionId }),
    page() { const tree = registrations.get('settings.section')(); return new Host(tree.type, tree.props); },
    component:node=>new Host(node.type,node.props),
    close() { for (const host of hosts) host.close(); },
  };
}
const path = '/api/basic-memory-settings/sessions';
const snapshot = (enabled = [], extra = {}) => ({
  ok: true, revision: 'r1', runtime: 'loaded', directory: 'X:/fixture/memory', pendingTurns: 0,
  // Deliberately retained old bindings must never count as new consent in the UI.
  sessions: [
    { id: 'session-a', title: '测试对话甲', workspace: '测试项目', bound: true },
    { id: 'session-b', title: '测试对话乙', workspace: '另一项目', bound: true },
  ],
  sessionMemory: { defaultEnabled: false, effective: 'next-user-turn', enabledSessions: enabled,
    states: ['session-a', 'session-b'].map(sessionId => ({ sessionId, requested: enabled.includes(sessionId), active: enabled.includes(sessionId), pending: false })) },
  ...extra,
});
const autoSnapshot = (enabled = false, extra = {}) => {
  const value = snapshot([], extra);
  value.sessionMemory = { ...value.sessionMemory, autoEnableNew: enabled };
  return value;
};
// Each conversation row carries one on/off switch; its label says what clicking it will do.
const sessionSwitches = host => nodes(host.tree, n => n.type === 'input' && n.props.role === 'switch' && /^(启用|关闭)本对话记忆：/.test(n.props['aria-label']));
const checkbox = (host, title = '测试对话甲') => sessionSwitches(host).find(n => n.props['aria-label'].endsWith('：' + title));
const helpTexts = host => nodes(host.tree, n => typeof n.type === 'function' && n.type.name === 'Help').map(n => n.props.text);
const writes = env => env.calls.filter(call => call.body);

test('handoff control offers presets and custom tokens, validates capacity and saves through the actual settings endpoint',async t=>{
  let info={ok:true,tokens:4096,activeTokens:4096,revision:'handoff-one'};
  const env=environment((url,body)=>{
    if(url.includes('/handoff')){if(body)info={...info,tokens:body.tokens,activeTokens:body.tokens,revision:'handoff-two'};return info;}
    return snapshot();
  });t.after(()=>env.close());
  const page=env.page();await page.flush();
  const element=nodes(page.tree,node=>typeof node.type==='function'&&node.type.name==='HandoffSettings')[0];assert.ok(element);
  const control=env.component(element);await control.flush();
  assert.match(text(control.tree),/4K（推荐）/);assert.match(text(control.tree),/8K（保留更多）/);
  const select=nodes(control.tree,node=>node.type==='select')[0];select.props.onChange({target:{value:'custom'}});await control.flush();
  let input=nodes(control.tree,node=>node.type==='input'&&node.props.type==='number')[0];input.props.onChange({target:{value:'16385'}});await control.flush();
  assert.equal(button(control.tree,'保存接续长度').props.disabled,true);assert.equal(writes(env).length,0);
  input=nodes(control.tree,node=>node.type==='input'&&node.props.type==='number')[0];input.props.onChange({target:{value:'1234'}});await control.flush();
  await button(control.tree,'保存接续长度').props.onClick();await control.flush();
  const write=writes(env).find(call=>call.path.includes('/handoff'));assert.deepEqual(JSON.parse(JSON.stringify(write.body)),{tokens:1234,revision:'handoff-one'});
  assert.match(text(control.tree),/下次真正触发接续时使用/);
});

test('portable registers the same opt-in control before the first message and in the header', async t => {
  const env = environment(() => snapshot()); t.after(() => env.close());
  assert.equal(env.registrations.get('conversation.hero.options'), env.registrations.get('conversation.session.header.utilities'));
  const header = env.header('session-a', 'conversation.hero.options'); await header.flush();
  assert.ok(button(header.tree, '启用本对话记忆'));
  assert.match(text(header.tree), /已关闭：不读不记/);
  assert.equal(writes(env).length, 0);
  assert.ok(env.calls.every(call => call.path === path && call.options.cache === 'no-store'));
  assert.doesNotMatch(source, /纯净模式|api\/dsh-memory|api\/dsh-pure-mode/);
});

test('new conversations can default to memory on through the dedicated setting', async t => {
  const held = deferred();
  let info = autoSnapshot(false);
  const env = environment((_path, body) => {
    if (body?.enabled !== undefined) return held.promise;
    return info;
  });
  t.after(() => env.close());
  const page = env.page(); await page.flush();
  const toggle = nodes(page.tree, node => node.type === 'input' && node.props['aria-label'] === '新对话自动开启记忆')[0];
  assert.ok(toggle);
  assert.equal(toggle.props.checked, false);
  assert.ok(helpTexts(page).some(value => /新建的对话从第一句起就会被记住/.test(value)));
  const saving = toggle.props.onChange({ target: { checked: true } });
  await page.flush();
  assert.equal(nodes(page.tree, node => node.type === 'input' && node.props['aria-label'] === '新对话自动开启记忆')[0].props.disabled, true);
  assert.deepEqual(writes(env)[0].body, { enabled: true, revision: 'r1' });
  assert.equal(writes(env)[0].path, '/api/basic-memory-settings/session-default');
  assert.equal(writes(env)[0].options.headers['x-basic-memory-settings'], '1');
  held.resolve(autoSnapshot(true, { revision: 'r2' }));
  await saving; await page.flush();
  const updated = nodes(page.tree, node => node.type === 'input' && node.props['aria-label'] === '新对话自动开启记忆')[0];
  assert.equal(updated.props.checked, true);
  assert.equal(updated.props.disabled, false);
  assert.match(text(page.tree), /新对话自动开启记忆已开启/);
});

test('old bound sessions remain unselected without new authorization', async t => {
  const env = environment(() => snapshot()), page = env.page(); t.after(() => env.close()); await page.flush();
  assert.equal(checkbox(page).props.checked, false);
  assert.equal(checkbox(page, '测试对话乙').props.checked, false);
  assert.ok(helpTexts(page).some(value => /只有开启记忆的对话会被记住/.test(value) && /关闭不会删除已记住的内容/.test(value)));
  assert.equal(sessionSwitches(page).filter(n => n.props['aria-label'].startsWith('启用本对话记忆：')).length, 2);
  assert.equal(writes(env).length, 0);
});

test('header uses bind, shows saving, blocks duplicate clicks and then shows pending activation', async t => {
  const held = deferred();
  const next = snapshot(['session-a'], { revision: 'r2', pendingTurns: 1 });
  Object.assign(next.sessionMemory.states[0], { active: false, pending: true });
  const env = environment((_path, body) => body ? held.promise : snapshot()); t.after(() => env.close());
  const header = env.header(); await header.flush();
  const trigger = button(header.tree, '启用本对话记忆'), saving = trigger.props.onClick(); trigger.props.onClick(); await header.flush();
  assert.equal(button(header.tree, '保存中…').props.disabled, true);
  assert.equal(writes(env).length, 1);
  assert.deepEqual(writes(env)[0].body, { action: 'bind', value: 'session-a', revision: 'r1' });
  assert.equal(writes(env)[0].options.headers['x-basic-memory-settings'], '1');
  held.resolve(next); await saving; await header.flush();
  assert.ok(button(header.tree, '关闭本对话记忆'));
  assert.match(text(header.tree), /已保存开启，下一新回合生效/);
  assert.ok(env.timers.size > 0);
});

test('header closes immediately and reopening sends no historical replay request', async t => {
  let info = snapshot(['session-a', 'session-b']);
  const env = environment((_path, body) => {
    if (body) info = snapshot(body.action === 'unbind' ? ['session-b'] : ['session-a', 'session-b'], { revision: info.revision + 'x' });
    return info;
  }); t.after(() => env.close());
  const header = env.header(); await header.flush();
  await button(header.tree, '关闭本对话记忆').props.onClick(); await header.flush();
  assert.match(text(header.tree), /已关闭：不读不记/);
  assert.deepEqual(info.sessionMemory.enabledSessions, ['session-b']);
  await button(header.tree, '启用本对话记忆').props.onClick(); await header.flush();
  assert.deepEqual(writes(env).map(call => call.body.action), ['unbind', 'bind']);
  assert.ok(writes(env).every(call => Object.keys(call.body).sort().join(',') === 'action,revision,value'));
});

test('pending activation refreshes into actual active permission', async t => {
  let info = snapshot(['session-a'], { pendingTurns: 1 });
  Object.assign(info.sessionMemory.states[0], { active: false, pending: true });
  const env = environment(() => info), header = env.header(); t.after(() => env.close()); await header.flush();
  assert.match(text(header.tree), /下一新回合生效/);
  info = snapshot(['session-a']);
  for (const tick of [...env.timers.values()]) await tick(); await header.flush();
  assert.match(text(header.tree), /本回合允许使用记忆/);
  assert.equal(env.timers.size, 0);
});

test('a conversation switch saves through bind and respects runtime states instead of old bound fields', async t => {
  let info = snapshot();
  const env = environment((_path, body) => {
    if (body) {
      info = snapshot([body.value], { revision: 'r2', pendingTurns: 1 });
      Object.assign(info.sessionMemory.states[0], { active: false, pending: true });
    }
    return info;
  }); t.after(() => env.close());
  const page = env.page(); await page.flush();
  await checkbox(page).props.onChange({ target: { checked: true } }); await page.flush();
  assert.equal(writes(env).length, 1);
  assert.deepEqual(writes(env)[0].body, { action: 'bind', value: 'session-a', revision: 'r1' });
  assert.equal(checkbox(page).props.checked, true);
  assert.equal(checkbox(page).props['aria-label'], '关闭本对话记忆：测试对话甲');
  assert.equal(checkbox(page, '测试对话乙').props.checked, false);
  assert.match(text(page.tree), /测试项目 · 下一新回合生效/);
  assert.match(text(page.tree), /已保存，从下一新回合生效/);
});

test('page can find a chosen conversation and directly bind it without replacing others', async t => {
  let info = snapshot(['session-a']);
  const env = environment((_path, body) => {
    if (body) info = snapshot(['session-a', 'session-b'], { revision: 'r2' });
    return info;
  }); t.after(() => env.close());
  const page = env.page(); await page.flush();
  nodes(page.tree, n => n.type === 'input' && n.props.type === 'search')[0].props.onChange({ target: { value: '另一项目' } }); await page.flush();
  assert.equal(sessionSwitches(page).length, 1);
  await checkbox(page, '测试对话乙').props.onChange({ target: { checked: true } }); await page.flush();
  assert.deepEqual(writes(env)[0].body, { action: 'bind', value: 'session-b', revision: 'r1' });
  assert.deepEqual(info.sessionMemory.enabledSessions, ['session-a', 'session-b']);
});

test('revision conflict refreshes authoritative state and never retries the write', async t => {
  let info = snapshot();
  const env = environment((_path, body) => {
    if (body) { info = snapshot(['session-b'], { revision: 'r-new' }); return { status: 409, body: { ok: false, error: '配置已修改，请刷新后重试' } }; }
    return info;
  }); t.after(() => env.close());
  const page = env.page(); await page.flush();
  await checkbox(page).props.onChange({ target: { checked: true } }); await page.flush();
  assert.equal(writes(env).length, 1);
  assert.match(text(page.tree), /配置已修改/);
  assert.equal(checkbox(page).props.checked, false);
  assert.equal(checkbox(page, '测试对话乙').props.checked, true);
  assert.doesNotMatch(text(page.tree), /已保存/);
});

test('late save for a previous conversation cannot overwrite the newly opened conversation', async t => {
  const held = deferred();
  const env = environment((_path, body) => body ? held.promise : snapshot()); t.after(() => env.close());
  const header = env.header(); await header.flush();
  const saving = button(header.tree, '启用本对话记忆').props.onClick();
  await header.update({ sessionId: 'session-b' });
  assert.match(text(header.tree), /已关闭：不读不记/);
  held.resolve(snapshot(['session-a'], { revision: 'r2' })); await saving; await header.flush();
  assert.ok(button(header.tree, '启用本对话记忆'));
  assert.equal(writes(env).length, 1);
});

test('header changes update the open settings list through the shared receipt', async t => {
  let info = snapshot();
  const env = environment((_path, body) => { if (body) info = snapshot(['session-a'], { revision: 'r2' }); return info; }); t.after(() => env.close());
  const page = env.page(), header = env.header(); await page.flush(); await header.flush();
  await button(header.tree, '启用本对话记忆').props.onClick(); await page.flush(); await header.flush();
  assert.equal(checkbox(page).props.checked, true);
  assert.equal(writes(env).length, 1);
});

test('missing opt-in receipt never presents legacy bindings as granted permission', async t => {
  const legacy = snapshot(); delete legacy.sessionMemory;
  const env = environment(() => legacy), page = env.page(), header = env.header(); t.after(() => env.close());
  await page.flush(); await header.flush();
  assert.equal(checkbox(page).props.checked, false);
  assert.equal(button(header.tree, '启用本对话记忆').props.disabled, true);
  assert.match(text(page.tree), /尚未接入对话记忆开关/);
  assert.equal(nodes(page.tree, n => n.type === 'fieldset')[0].props.disabled, true);
  assert.match(text(header.tree), /尚未接通/);
  assert.equal(writes(env).length, 0);
});

test('unloaded runtime is shown as saved or pending, never as an active memory turn', async t => {
  const env = environment(() => snapshot(['session-a'], { runtime: 'reload-required' })); t.after(() => env.close());
  const header = env.header(); await header.flush();
  assert.match(text(header.tree), /已保存开启；等待记忆框架加载/);
  assert.doesNotMatch(text(header.tree), /本回合允许/);
});

test('existing model settings save refreshes the opt-in receipt without changing authorization', async t => {
  let info = snapshot(['session-a'], { rawModel: { model: 'fixture' } });
  const env = environment(() => info), page = env.page(); t.after(() => env.close()); await page.flush();
  button(page.tree, '维护').props.onClick(); await page.flush();
  const modelSettings = nodes(page.tree, n => n.type?.name === 'RawModelSettings')[0];
  assert.ok(modelSettings);
  info = snapshot(['session-a'], { revision: 'r2', rawModel: { model: 'fixture' } });
  const savedConfiguration = structuredClone(info); delete savedConfiguration.sessionMemory;
  modelSettings.props.onSaved(savedConfiguration); await page.flush();
  button(page.tree, '记忆').props.onClick(); await page.flush();
  assert.equal(checkbox(page).props.checked, true);
  assert.doesNotMatch(text(page.tree), /下一新回合生效/);
  assert.doesNotMatch(text(page.tree), /尚未接入对话记忆开关/);
  assert.equal(writes(env).length, 0);
});

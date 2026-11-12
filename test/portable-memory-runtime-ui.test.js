// P08 portable UI and HTTP fixtures: no live DSH, model, download, or paid calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createSettingsHandler } from '../lib/settings-host.js';
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
function environment(handler, plugins = [{ moduleName: '@local/dsh-basic-memory-bridge', enabled: true, fiberPhase: 'active' }]) {
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
    window, Event, AbortController, console,
    document: { getElementById: () => null },
    setInterval(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
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
      async listPlugins() { return { ok: true, value: plugins }; },
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
const BASE='/api/basic-memory-settings';
const MODEL='Qwen/Qwen3-Embedding-4B';
const OTHER_LOCAL='Qwen/Qwen3-Embedding-0.6B';
const LARGE_LOCAL='Qwen/Qwen3-Embedding-8B';
const CLOUD='text-embedding-v4';
const snapshot=()=>({ok:true,revision:'r1',runtime:'loaded',directory:'/fictional-memory',sessions:[],
  timeZone:'America/Los_Angeles',timeZoneConfigured:'',timeZoneHost:'America/Los_Angeles',timeZoneError:'',activeTimeZone:'America/Los_Angeles',
  sessionMemory:{defaultEnabled:false,effective:'next-user-turn',enabledSessions:[],states:[]},
  rawModel:{fields:{rawRecallModel:MODEL,rawRecallThreads:3,rawRecallDimensions:0,rawRecallGgufModel:'/fixture/model.gguf',rawRecallLlamaServer:'/fixture/llama.exe'}},
  rawModels:[{id:MODEL,label:'Qwen 4B',engine:'llamacpp',dimensions:2560},
    {id:'Qwen/Qwen3-Embedding-0.6B',label:'Qwen 0.6B',engine:'onnx',dimensions:1024},
    {id:CLOUD,label:'云端 v4',engine:'api',cloud:true,dimensions:1024,allowedDimensions:[512,1024]}]});
const runtime=()=>({ok:true,vectors:{activeProfileId:MODEL,selectedProfileId:MODEL,
  runtime:{profileId:MODEL,requestedDevice:'auto',actualDevice:'cpu',fallbackReason:'CUDA 不可用'},
  profiles:[{id:MODEL,model:MODEL,revision:2,modelState:{prepared:true,requestedDevice:'auto',actualDevice:'cpu',fallbackReason:'CUDA 不可用',runtime:{threads:6,batchThreads:6},idleReleaseMs:120000},progress:{state:'ready',completed:4,total:4},
    embeddingUsage:{calls:3,reportedTokens:20,unknownUsageCalls:1}}]},
  pipeline:{enabled:true,busy:false,pending:2,running:0,held:1,completed:5,deliveryPending:1,waitingReason:'foreground-busy',
    batches:[{id:'batch-one',state:'held',error:'MEMORY_INTERRUPTED_REVIEW_REQUIRED'}]}});
const component=(tree,name)=>{const node=nodes(tree,n=>typeof n.type==='function'&&n.type.name===name)[0];assert.ok(node,'Missing component: '+name);return node;};
const select=(tree,label)=>{const node=nodes(tree,n=>n.type==='select'&&n.props['aria-label']===label)[0];assert.ok(node,'Missing select: '+label);return node;};
const field=(tree,label)=>{const parent=nodes(tree,n=>n.type==='label'&&text(n).startsWith(label))[0];assert.ok(parent,'Missing field: '+label);return nodes(parent,n=>n.type==='input')[0];};
// A status line: name (and optional meta) on the left, value on the right.
const rowOf=(tree,name)=>{const node=nodes(tree,n=>n.props?.className==='memory-row'&&text(children(children(n)[0])[0]).startsWith(name))[0];assert.ok(node,'Missing row: '+name);
  const [main,value]=children(node);return {value:text(value),meta:text(children(main)[1]??'')};};
const helpTexts=tree=>nodes(tree,n=>typeof n.type==='function'&&n.type.name==='Help').map(n=>n.props.text);
const serviceRadios=tree=>nodes(tree,n=>n.type==='input'&&n.props.type==='radio'&&n.props.name==='memory-service');
const chosenService=tree=>serviceRadios(tree).find(n=>n.props.checked)?.props.value;
const pickService=(tree,id)=>{const radio=serviceRadios(tree).find(n=>n.props.value===id);assert.ok(radio,'Missing service: '+id);radio.props.onChange();};
const writes=env=>env.calls.filter(call=>call.body);
const inventoryResponse=models=>({ok:true,inventory:{revision:'r1',models}});
async function modelPage(env){const page=env.page();await page.flush();button(page.tree,'维护').props.onClick();await page.flush();const model=env.component(component(page.tree,'RawModelSettings'));await model.flush();return {page,model};}
async function statusRuntime(env){const page=env.page();await page.flush();button(page.tree,'状态').props.onClick();await page.flush();const view=env.component(component(page.tree,'MemoryRuntimeSettings'));await view.flush();return {page,view};}

test('maintenance time zone shows the active and host zones and saves the configured IANA name',async t=>{
  let info=snapshot();
  const env=environment((url,body)=>{
    if(url===BASE+'/time-zone'){
      info={...info,revision:'tz-two',timeZone:body.timeZone,timeZoneConfigured:body.timeZone};
      return info;
    }
    return info;
  });
  t.after(()=>env.close());
  const page=env.page();await page.flush();
  const zone=env.component(component(page.tree,'TimeZoneSettings'));await zone.flush();
  assert.match(text(zone.tree),/当前生效：America\/Los_Angeles；本机时区：America\/Los_Angeles/);
  const zones=select(zone.tree,'个人时区');
  const offered=nodes(zones,n=>n.type==='option').map(n=>n.props.value);
  assert.equal(offered[0],'');assert.ok(offered.includes('Asia/Shanghai'));assert.ok(offered.includes('America/Los_Angeles'));
  assert.equal(new Set(offered).size,offered.length);
  assert.match(text(zones),/北京时间　UTC\+8 · Asia\/Shanghai/);
  zones.props.onChange({target:{value:'Asia/Shanghai'}});await zone.flush();
  assert.equal(select(zone.tree,'个人时区').props.value,'Asia/Shanghai');
  await button(zone.tree,'保存时区').props.onClick();await zone.flush();
  const write=writes(env).at(-1);
  assert.equal(write.path,BASE+'/time-zone');
  assert.deepEqual(JSON.parse(JSON.stringify(write.body)),{timeZone:'Asia/Shanghai',revision:'r1'});
});

test('cloud expert settings keep only environment and timing fields and preserve the saved endpoint',async t=>{
  const info=snapshot();info.rawModel={fields:{rawRecallModel:CLOUD,rawRecallApiBase:'https://fictional-a.example/v1',rawRecallApiKeyEnv:'FICTIONAL_A_KEY',rawRecallAllowCloud:true}};
  const env=environment(()=>info);t.after(()=>env.close());const {model}=await modelPage(env);
  assert.equal(rowOf(model.tree,'当前模型').value,'云端 v4');assert.match(rowOf(model.tree,'当前模型').meta,/更换模型请到「检索模型」页/);
  assert.equal(nodes(model.tree,n=>n.type==='label'&&text(n).startsWith('API 地址')).length,0);
  assert.equal(nodes(model.tree,n=>n.type==='input'&&n.props.type==='password').length,0);
  assert.doesNotMatch(text(model.tree),/复用.*密钥|允许云端|向量维度/);
  button(model.tree,'专家模式').props.onClick();await model.flush();
  assert.equal(field(model.tree,'API Key 环境变量').props.value,'FICTIONAL_A_KEY');
  field(model.tree,'API Key 环境变量').props.onChange({target:{value:'FICTIONAL_B_KEY'}});await model.flush();
  field(model.tree,'检索总等待（毫秒，0 为自动）').props.onChange({target:{value:'2500'}});await model.flush();
  await button(model.tree,'应用运行设置').props.onClick();await model.flush();
  const call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');
  assert.equal(call.body.settings.rawRecallApiBase,'https://fictional-a.example/v1');
  assert.equal(call.body.settings.rawRecallApiKeyEnv,'FICTIONAL_B_KEY');
  assert.equal(call.body.settings.rawRecallQueryWaitMs,2500);
  assert.equal(call.body.apiKey,undefined);assert.equal(call.body.reuseApiKey,undefined);
});

test('review screen sends the displayed revision and allows comparison again after conflict',async t=>{
  let changed=false,applied=false;
  const env=environment((url,body)=>{
    if(url===BASE+'/runtime')return runtime();
    if(url===BASE+'/reviews'&&!body)return {ok:true,items:applied?[]:[{operationId:'op-one',type:'plan',reason:'target-revision-changed'}]};
    if(url.startsWith(BASE+'/reviews?operationId='))return {ok:true,review:{operationId:'op-one',revision:changed?'new':'old',
      current:{type:'plan',content:changed?'人工修改':'原正文'},proposed:{type:'plan',content:'整理建议正文'},sources:[{id:'origin',revision:1,role:'user',text:'原文证据'}],canApprove:true,canReject:true}};
    if(url===BASE+'/reviews'&&body){
      if(body.revision==='old'){changed=true;return {status:409,body:{ok:false,error:'条目版本已变化，请刷新并重新对照。'}};}
      assert.equal(body.revision,'new');applied=true;return {ok:true,result:{state:'committed'}};
    }
    return snapshot();
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'状态').props.onClick();await page.flush();
  const review=env.component(component(page.tree,'MemoryReviewSettings'));await review.flush();
  await button(review.tree,'读取待审核').props.onClick();await review.flush();
  await button(review.tree,'plan · 条目已被修改').props.onClick();await review.flush();
  assert.match(text(review.tree),/原正文.*整理建议正文.*原文证据/);
  await button(review.tree,'接受建议').props.onClick();await review.flush();
  assert.match(text(review.tree),/版本已变化/);
  await button(review.tree,'刷新当前条目').props.onClick();await review.flush();
  assert.match(text(review.tree),/人工修改/);
  await button(review.tree,'接受建议').props.onClick();await review.flush();
  assert.match(text(review.tree),/已接受.*写入记忆库/);
  assert.deepEqual(writes(env).filter(call=>call.path===BASE+'/reviews').map(call=>call.body.revision),['old','new']);
});

test('settings page recognizes the active Include entry at a frozen version file URI',async t=>{
  const frozen={entryId:'include:basic-memory-bridge',moduleName:'file:///fixture/dsh-basic-memory-bridge/.local/runtime/versions/memory-pipeline-4b-fixture/lib/bundle-entry.js',enabled:true,fiberPhase:'active'};
  const env=environment(()=>snapshot(),[frozen]);t.after(()=>env.close());
  const page=env.page();await page.flush();
  const line=nodes(page.tree,node=>node.type==='div'&&node.props.className==='memory-group-head'&&text(children(node)[0])==='记忆框架')[0];
  assert.ok(line);assert.equal(text(line),'记忆框架已加载');
  assert.equal(nodes(line,node=>typeof node.type==='function'&&node.type.name==='Help')[0].props.text,'记忆框架已加载，设置已生效。');
  assert.equal(writes(env).length,0);assert.ok(env.calls.every(call=>call.path===BASE+'/sessions'));
});

test('core status requires enabled active identity and retains legacy aliases and paths',async t=>{
  const included={entryId:'include:basic-memory-bridge',moduleName:'file:///fixture/versions/memory-pipeline-4b-fixture/lib/bundle-entry.js',enabled:true,fiberPhase:'active'};
  const legacy={moduleName:'@local/dsh-basic-memory-bridge',enabled:true,fiberPhase:'active'};
  const cases=[
    [[{...included,enabled:false}],false],
    [[{...included,fiberPhase:'inactive'}],false],
    [[{...included,entryId:'include:another-plugin'}],false],
    [[{...included,enabled:false},legacy],false],
    [[legacy],true],
    [[{...legacy,moduleName:'@local/dsh-basic-memory-bridge/bundle-entry'}],true],
    [[{...legacy,moduleName:'@local/dsh-basic-memory-bridge/platform-host'}],true],
    [[{...legacy,moduleName:'file:///fixture/dsh-basic-memory-bridge/lib/bundle-entry.js'}],true],
    [[{...legacy,enabled:false}],false],
    [[{...legacy,fiberPhase:'inactive'}],false],
  ];
  for(const [plugins,loaded] of cases){
    const env=environment(()=>snapshot(),plugins);t.after(()=>env.close());
    const page=env.page();await page.flush();
    const line=nodes(page.tree,node=>node.type==='div'&&node.props.className==='memory-group-head'&&text(children(node)[0])==='记忆框架')[0];
    assert.ok(line);assert.equal(text(line),'记忆框架'+(loaded?'已加载':'未加载'),JSON.stringify(plugins));
    assert.equal(writes(env).length,0);
  }
});

test('expert panel fixes the current model, collapses resource paths and preserves device drafts across modes',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());const {model}=await modelPage(env);
  assert.equal(button(model.tree,'标准模式').props['aria-pressed'],true);
  assert.equal(nodes(model.tree,n=>n.type==='details')[0].props.open,false);
  assert.equal(rowOf(model.tree,'当前模型').value,'Qwen 4B');assert.match(rowOf(model.tree,'当前模型').meta,/更换模型请到「检索模型」页/);
  assert.equal(nodes(model.tree,n=>n.type==='select'&&n.props['aria-label']==='查看向量模型').length,0);
  assert.equal(nodes(model.tree,n=>n.type==='button'&&['切换到此模型','恢复上次向量设置','下载'].includes(text(n))).length,0);
  assert.equal(select(model.tree,'运行设备').props.value,'auto');
  assert.equal(nodes(model.tree,n=>n.type==='option'&&n.props.value==='cuda')[0].props.disabled,undefined);
  assert.equal(field(model.tree,'4B CPU 备用线程数').props.value,6);
  assert.equal(field(model.tree,'GPU 辅助 CPU 线程数').props.value,4);
  assert.equal(field(model.tree,'空闲后多少分钟').props.value,0);
  select(model.tree,'运行设备').props.onChange({target:{value:'cpu'}});await model.flush();
  button(model.tree,'专家模式').props.onClick();await model.flush();
  assert.equal(nodes(model.tree,n=>n.type==='details')[0].props.open,true);
  assert.equal(select(model.tree,'运行设备').props.value,'cpu');
  field(model.tree,'4B CPU 备用线程数').props.onChange({target:{value:'7'}});await model.flush();
  button(model.tree,'标准模式').props.onClick();await model.flush();
  assert.equal(field(model.tree,'4B CPU 备用线程数').props.value,7);
  assert.equal(writes(env).length,0);
  assert.doesNotMatch(text(model.tree),/事实笔记仍使用 BGE/);
});

test('saving runtime settings posts new fields and retains legacy threads without starting any model',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());const {model}=await modelPage(env);
  select(model.tree,'运行设备').props.onChange({target:{value:'cuda'}});await model.flush();
  field(model.tree,'CPU llama-server 程序').props.onChange({target:{value:'/fixture/cpu.exe'}});await model.flush();
  field(model.tree,'CUDA llama-server 程序').props.onChange({target:{value:'/fixture/cuda.exe'}});await model.flush();
  field(model.tree,'空闲后多少分钟').props.onChange({target:{value:'3'}});await model.flush();
  assert.equal(field(model.tree,'检索总等待（毫秒，0 为自动）').props.value,0);
  field(model.tree,'检索总等待（毫秒，0 为自动）').props.onChange({target:{value:'3500'}});await model.flush();
  await button(model.tree,'应用运行设置').props.onClick();await model.flush();
  assert.equal(writes(env).length,1);const call=writes(env)[0];assert.equal(call.path,BASE+'/model');
  assert.equal(call.body.settings.rawRecallModel,MODEL);
  assert.equal(call.body.settings.rawRecallDevice,'cuda');
  assert.equal(call.body.settings.rawRecallCpuThreads,6);assert.equal(call.body.settings.rawRecallGpuThreads,4);
  assert.equal(call.body.settings.rawRecallIdleMs,180000);assert.equal(call.body.settings.rawRecallThreads,3);
  assert.equal(call.body.settings.rawRecallQueryWaitMs,3500);
  assert.equal(call.body.settings.rawRecallLlamaCpuServer,'/fixture/cpu.exe');
  assert.equal(call.body.settings.rawRecallLlamaCudaServer,'/fixture/cuda.exe');
  assert.match(text(model.tree),/保存不会启动模型/);
});

test('the model picker shows device choices only for llamacpp and saves onnx models as CPU',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  const device=select(picker.tree,'运行设备');
  assert.equal(device.props.value,'auto');
  assert.equal(nodes(device,n=>n.type==='option'&&n.props.value==='cuda')[0].props.disabled,undefined);
  device.props.onChange({target:{value:'cuda'}});await picker.flush();
  assert.equal(select(picker.tree,'运行设备').props.value,'cuda');
  select(picker.tree,'检索模型').props.onChange({target:{value:OTHER_LOCAL}});await picker.flush();
  assert.equal(nodes(picker.tree,n=>n.type==='select'&&n.props['aria-label']==='运行设备').length,0);
  assert.match(text(picker.tree),/此模型只用 CPU。/);
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  const call=writes(env).filter(item=>item.path===BASE+'/model').at(-1);
  assert.equal(call.body.settings.rawRecallModel,OTHER_LOCAL);
  assert.equal(call.body.settings.rawRecallDevice,'cpu');
  assert.equal(call.body.confirmSwitch,true);assert.equal('cloudConfirmed' in call.body,false);
  assert.match(text(picker.tree),/重启 DSH 后切换到新模型，并自动开始建索引/);
  assert.doesNotMatch(text(picker.tree),/在后台切换/);
});

test('the expert panel hides device choices for an onnx model without mentioning GPU',async t=>{
  const info=snapshot();info.rawModel={fields:{rawRecallModel:OTHER_LOCAL,rawRecallDevice:'cpu',rawRecallThreads:4,rawRecallDimensions:0,
    rawRecallOnnxModel:'/fixture/model.onnx',rawRecallOnnxTokenizer:'/fixture/tokenizer.json'}};
  const env=environment(()=>info);t.after(()=>env.close());const {model}=await modelPage(env);
  assert.equal(nodes(model.tree,n=>n.type==='select'&&n.props['aria-label']==='运行设备').length,0);
  assert.match(text(model.tree),/此模型只用 CPU。/);
  assert.doesNotMatch(text(model.tree),/GPU/);
});

test('cloud models never show local device, path or lifecycle controls in the expert panel',async t=>{
  const info=snapshot();info.rawModel={fields:{rawRecallModel:CLOUD,rawRecallApiBase:'https://fictional-a.example/v1',rawRecallAllowCloud:true}};
  const env=environment(()=>info);t.after(()=>env.close());const {model}=await modelPage(env);
  assert.equal(nodes(model.tree,n=>n.type==='select'&&n.props['aria-label']==='运行设备').length,0);
  assert.equal(nodes(model.tree,n=>n.type==='input'&&n.props.value==='/fixture/llama.exe').length,0);
  assert.equal(nodes(model.tree,n=>n.type?.name==='MemoryRuntimeSettings').length,0);
  const {view}=await statusRuntime(env);
  assert.equal(nodes(view.tree,n=>n.type==='button'&&['加载／预热','释放运行资源'].includes(text(n))).length,0);
  assert.equal(writes(env).length,0);
});

test('status page owns runtime controls and shows the pending model, current cloud model and unbuilt index',async t=>{
  const info=snapshot();
  info.rawModel={fields:{rawRecallModel:'custom-api',rawRecallApiModel:'fictional-embed',rawRecallApiBase:'https://fictional-a.example/v1',rawRecallDimensions:768,rawRecallAllowCloud:true}};
  info.rawModels=[...info.rawModels,{id:'custom-api',label:'自定义 API（OpenAI 兼容）',engine:'api',cloud:true,custom:true,dimensions:1024}];
  info.pendingRawModel={fields:{rawRecallModel:OTHER_LOCAL,rawRecallOnnxModel:'/fixture/model.onnx',rawRecallOnnxTokenizer:'/fixture/tokenizer.json'}};
  const env=environment(url=>url===BASE+'/runtime'?runtime():info);t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'状态').props.onClick();await page.flush();
  const view=env.component(component(page.tree,'MemoryRuntimeSettings'));await view.flush();
  const shown=text(page.tree),runtimeText=text(view.tree);
  // Without a confirmed switch nothing builds by itself after the reload; say where to start it.
  assert.match(shown,/待生效：Qwen 0\.6B，重启 DSH 后切换；切换后在这里点「准备索引」。/);
  const confirmed=environment(url=>url===BASE+'/runtime'?runtime():{...info,pendingRawModelSwitch:{cloudConfirmed:false}});t.after(()=>confirmed.close());
  const confirmedPage=confirmed.page();await confirmedPage.flush();button(confirmedPage.tree,'状态').props.onClick();await confirmedPage.flush();
  assert.match(text(confirmedPage.tree),/切换后会自动开始建索引/);
  assert.equal(rowOf(view.tree,'当前模型').meta,'fictional-embed');
  assert.equal(rowOf(view.tree,'索引').value,'未建立');
  assert.equal(rowOf(view.tree,'索引').meta,'点「准备索引」建立；云端模型会按量计费');void runtimeText;
  assert.ok(nodes(page.tree,n=>n.type?.name==='MemoryReviewSettings').length<=1);
  button(page.tree,'维护').props.onClick();await page.flush();
  assert.equal(nodes(page.tree,n=>n.type?.name==='MemoryRuntimeSettings').length,0);
  assert.equal(writes(env).length,0);
});

test('runtime distinguishes a completed old index count from pending catalogue coverage',async t=>{
  const value=runtime();value.vectors.profiles[0].progress={state:'pending',completed:4,total:4,pendingBoundaries:1};
  const env=environment(url=>url===BASE+'/runtime'?value:snapshot());t.after(()=>env.close());
  const {view}=await statusRuntime(env);
  assert.equal(rowOf(view.tree,'索引').value,'4 / 4 待追平');assert.equal(rowOf(view.tree,'索引').meta,'有新内容待补进索引');
  assert.doesNotMatch(rowOf(view.tree,'索引').value,/已就绪/);
  value.vectors.profiles[0].progress={state:'ready',completed:5,total:5};
  await view.update({tick:1});
  assert.equal(rowOf(view.tree,'索引').value,'5 / 5 已就绪');assert.equal(writes(env).length,0);
});

test('runtime status is read-only, keeps actual CPU fallback separate and dispatches explicit lifecycle targets',async t=>{
  let value=runtime();const env=environment((url,body)=>{
    if(url!==BASE+'/runtime')return snapshot();
    if(body){if(body.action==='release'){value.vectors.runtime.actualDevice=null;value.vectors.profiles[0].modelState='released';}return {ok:true,started:body.action==='prepare'};}
    return value;
  });t.after(()=>env.close());const {view}=await statusRuntime(env);
  assert.equal(rowOf(view.tree,'运行设备').value,'CPU');assert.match(rowOf(view.tree,'运行设备').meta,/回退原因：CUDA 不可用/);
  assert.equal(rowOf(view.tree,'索引').value,'4 / 4 已就绪');
  assert.match(rowOf(view.tree,'用量').value,/20 tokens/);
  assert.equal(writes(env).length,0);
  for(const action of [['加载／预热','load'],['准备索引','prepare'],['释放运行资源','release']]){
    await button(view.tree,action[0]).props.onClick();await view.flush();
    const call=writes(env).at(-1);assert.equal(call.path,BASE+'/runtime');
    assert.deepEqual(call.body,{action:action[1],profileId:MODEL,profileRevision:2});
    if(action[1]==='prepare')assert.match(text(view.tree),/操作已启动/);
  }
  assert.equal(rowOf(view.tree,'运行设备').value,'未加载');
  assert.ok(env.calls.filter(call=>call.path===BASE+'/runtime').every(call=>call.options.cache==='no-store'));
});

test('runtime errors do not simulate success and blocked actions never send force or authorization overrides',async t=>{
  const held=deferred();let attempts=0;
  const env=environment((url,body)=>url===BASE+'/runtime'?body?(attempts++,held.promise):runtime():snapshot());t.after(()=>env.close());
  const {view}=await statusRuntime(env);
  const trigger=button(view.tree,'尝试整理待办'),pending=trigger.props.onClick();trigger.props.onClick();await view.flush();
  assert.equal(attempts,1);
  held.resolve({status:403,body:{ok:false,error:'原始会话授权已撤销'}});await pending;await view.flush();
  assert.match(text(view.tree),/原始会话授权已撤销/);assert.doesNotMatch(text(view.tree),/操作已返回/);
  assert.deepEqual(writes(env)[0].body,{action:'flush'});
});

test('scheduling resume and selected-batch retry use real runtime requests',async t=>{
  const env=environment((url,body)=>url===BASE+'/runtime'?body?{ok:true}:runtime():snapshot());t.after(()=>env.close());
  const {view}=await statusRuntime(env);
  assert.match(text(view.tree),/foreground-busy/);assert.ok(helpTexts(view.tree).some(value=>/授权和前台是否占用/.test(value)));
  assert.equal(button(view.tree,'重试所选批次').props.disabled,true);
  await button(view.tree,'恢复后台任务').props.onClick();await view.flush();
  select(view.tree,'重试批次').props.onChange({target:{value:'batch-one'}});await view.flush();
  await button(view.tree,'重试所选批次').props.onClick();await view.flush();
  assert.deepEqual(writes(env).map(call=>call.body),[{action:'resume'},{action:'retry',batchId:'batch-one'}]);
});

test('missing runtime callbacks remain visibly unconnected, with unknown counts and disabled model actions',async t=>{
  const env=environment(url=>url===BASE+'/runtime'?{status:404,body:{ok:false,error:'当前入口尚未接入记忆运行管理'}}:snapshot());t.after(()=>env.close());
  const {view}=await statusRuntime(env);
  assert.match(text(view.tree),/尚未接入记忆运行管理/);assert.equal(rowOf(view.tree,'索引').value,'未建立');
  assert.doesNotMatch(text(view.tree),/统一向量服务已接入/);
  assert.equal(button(view.tree,'加载／预热').props.disabled,true);assert.equal(button(view.tree,'尝试整理待办').props.disabled,true);
  assert.equal(writes(env).length,0);
});

function httpFixture(t,controls={},ctx={}){
  // Runtime routes never touch this deliberately nonexistent config file.
  const handler=createSettingsHandler(ctx,'/fictional-unused-memory-config.json',undefined,undefined,controls);t.after(()=>handler.dispose());
  return async(method,input,extra={})=>{
    const req=Readable.from(input===undefined?[]:[Buffer.from(typeof input==='string'?input:JSON.stringify(input))]);
    Object.assign(req,{method,url:BASE+'/runtime',socket:{remoteAddress:extra.remoteAddress??'127.0.0.1'},headers:{host:'127.0.0.1:15680','content-type':'application/json','x-basic-memory-settings':'1',...extra.headers}});
    const res={headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=JSON.parse(value);}};
    await handler(req,res);return res;
  };
}
test('runtime HTTP status only calls the supplied read callback; actions preserve started/error receipts',async t=>{
  let reads=0;const operations=[];
  const request=httpFixture(t,{getMemoryRuntime:()=>{reads++;return runtime();},runMemoryRuntime:async input=>{
    operations.push(input);if(input.action==='flush')throw Error('foreground-busy');return {started:input.action==='prepare',state:'queued'};
  }});
  const status=await request('GET');assert.equal(status.statusCode,200);assert.equal(reads,1);assert.equal(operations.length,0);
  assert.equal(status.headers['cache-control'],'no-store');assert.equal(status.body.vectors.activeProfileId,MODEL);
  for(const action of ['load','release','prepare','cancel','resume','retry']){
    const result=await request('POST',{action,batchId:'batch-one',profileId:MODEL,profileRevision:2,force:true,authorization:'ignored'});
    assert.equal(result.statusCode,action==='prepare'?202:200);
    assert.deepEqual(operations.at(-1),{action,batchId:'batch-one',profileId:MODEL,profileRevision:2});
  }
  const failed=await request('POST',{action:'flush'});assert.equal(failed.statusCode,400);assert.equal(failed.body.ok,false);assert.match(failed.body.error,/foreground-busy/);
  assert.equal(reads,1,'POST never starts a second status or model path implicitly');
});

test('runtime HTTP rejects untrusted requests and unsupported actions before dispatch',async t=>{
  let calls=0;const request=httpFixture(t,{getMemoryRuntime:()=>{calls++;return runtime();},runMemoryRuntime:()=>{calls++;return {};}});
  assert.equal((await request('POST',{action:'load'},{headers:{'x-basic-memory-settings':'0'}})).statusCode,403);
  assert.equal((await request('GET',undefined,{headers:{origin:'https://other.example'}})).statusCode,403);
  assert.equal((await request('GET',undefined,{remoteAddress:'192.0.2.1'})).statusCode,403);
  for(const input of [{action:'remove'},{action:'load',profileId:''},{action:'retry',batchId:[]},{action:'load',profileRevision:{}},null,[],'not json'])assert.equal((await request('POST',input)).statusCode,400);
  assert.equal(calls,0);
});

test('runtime HTTP reports missing integration and retains connection-layer authentication',async t=>{
  const request=httpFixture(t);assert.equal((await request('GET')).statusCode,404);assert.equal((await request('POST',{action:'load'})).statusCode,404);
  const blocked=httpFixture(t,{getMemoryRuntime:()=>{throw Error('must not call');}},{get:()=>({requestRejection:()=>({status:401})})});
  assert.equal((await blocked('GET')).statusCode,403);
});

test('started operations poll read-only receipts, disable competing actions and permit cancellation',async t=>{
  const value=runtime();value.operation={state:'idle'};
  const env=environment((url,body)=>{
    if(url!==BASE+'/runtime')return snapshot();
    if(!body)return value;
    if(body.action==='cancel'){value.operation={id:'op-one',action:'prepare',state:'failed',error:'PROFILE_CANCELLED'};return {ok:true,cancelled:true};}
    value.operation={id:'op-one',action:body.action,state:'running'};return {ok:true,started:true,id:'op-one',action:body.action};
  });t.after(()=>env.close());const {view}=await statusRuntime(env);
  await button(view.tree,'准备索引').props.onClick();await view.flush();
  assert.match(text(view.tree),/操作已启动/);assert.match(text(view.tree),/准备索引：进行中/);
  assert.equal(button(view.tree,'尝试整理待办').props.disabled,true);
  assert.equal(env.timers.size,1);const before=writes(env).length;
  for(const tick of [...env.timers.values()])await tick();await view.flush();assert.equal(writes(env).length,before);
  await button(view.tree,'取消向量操作').props.onClick();await view.flush();
  assert.deepEqual(writes(env).at(-1).body,{action:'cancel',profileId:MODEL,profileRevision:2});
  assert.match(text(view.tree),/取消请求已返回/);assert.match(text(view.tree),/PROFILE_CANCELLED/);assert.equal(env.timers.size,0);
});

test('clicking cancel after viewing B still targets the running load or prepare operation on A',async t=>{
  const other='Qwen/Qwen3-Embedding-0.6B';
  for(const [label,action] of [['加载／预热','load'],['准备索引','prepare']]){
    const value=runtime();value.operation={state:'idle'};
    value.vectors.profiles.push({id:other,model:other,revision:9,modelState:'unloaded'});
    const env=environment((url,body)=>{
      if(url!==BASE+'/runtime')return snapshot();
      if(!body)return value;
      if(body.action==='cancel'){value.operation={...value.operation,state:'failed',error:'PROFILE_CANCELLED'};return {ok:true,cancelled:true};}
      value.operation={id:'operation-a',action:body.action,state:'running',profileId:body.profileId,profileRevision:body.profileRevision};
      return {ok:true,started:true,id:'operation-a',action:body.action};
    });t.after(()=>env.close());
    const {view}=await statusRuntime(env);
    await button(view.tree,label).props.onClick();await view.flush();
    assert.deepEqual(writes(env)[0].body,{action,profileId:MODEL,profileRevision:2});
    value.vectors.selectedProfileId=other;
    await view.update({...view.props,modelId:other});
    assert.equal(rowOf(view.tree,'当前模型').meta,'Qwen 0.6B');
    const cancel=button(view.tree,'取消向量操作');assert.equal(cancel.props.disabled,false);
    await cancel.props.onClick();await view.flush();
    assert.deepEqual(writes(env).at(-1).body,{action:'cancel',profileId:MODEL,profileRevision:2});
    assert.equal(writes(env).length,2);assert.equal(env.timers.size,0);
  }
});

test('string model-state receipts use top-level actual device and do not borrow another profile runtime',async t=>{
  const value=runtime();Object.assign(value.vectors.profiles[0],{modelState:'loaded',actualDevice:'cuda',fallbackReason:null,runtime:{threads:4},idleReleaseMs:120000});
  const env=environment(url=>url===BASE+'/runtime'?value:snapshot());t.after(()=>env.close());const {view}=await statusRuntime(env);
  assert.equal(rowOf(view.tree,'运行设备').value,'GPU（NVIDIA CUDA）');assert.doesNotMatch(rowOf(view.tree,'运行设备').meta,/回退原因/);
  assert.match(rowOf(view.tree,'运行设备').meta,/空闲 120 秒后释放 · 4 线程/);
  value.vectors.profiles[0].actualDevice=null;
  await view.update({tick:2});
  assert.equal(rowOf(view.tree,'当前模型').value,'未加载');assert.equal(rowOf(view.tree,'运行设备').value,'未加载');
  await view.update({modelId:'Qwen/Qwen3-Embedding-0.6B'});assert.equal(rowOf(view.tree,'运行设备').value,'未报告');
});

test('session HTTP adapter preserves the deployment status string and separates the detailed runtime object',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'portable-runtime-http-')),file=path.join(root,'config.json');
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'storages'));await fs.writeFile(path.join(root,'storages','workspace.json'),JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{}}}));
  await fs.writeFile(file,JSON.stringify({ownerDirectory:root,dshHome:root,dshSessionIds:[],memory:{rawRecall:false}}));
  const value=runtime(),sessionMemory={defaultEnabled:false,effective:'next-user-turn',enabledSessions:[],states:[]};
  const handler=createSettingsHandler({},file,undefined,()=>({runtime:value,sessionMemory}));t.after(()=>handler.dispose());
  const req=Readable.from([]);Object.assign(req,{method:'GET',url:BASE+'/sessions',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:15680'}});
  const res={setHeader(){},end(text){this.body=JSON.parse(text);}};await handler(req,res);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body.runtime,'stopped-or-unreported');assert.deepEqual(res.body.memoryRuntime,value);assert.deepEqual(res.body.sessionMemory,sessionMemory);
  const post=Readable.from([Buffer.from(JSON.stringify({action:'replace',value:[],revision:res.body.revision}))]);
  Object.assign(post,{method:'POST',url:req.url,socket:req.socket,headers:{...req.headers,'content-type':'application/json','x-basic-memory-settings':'1'}});
  await handler(post,res);assert.equal(res.statusCode,200,JSON.stringify(res.body));assert.equal(res.body.runtime,'stopped-or-unreported');assert.deepEqual(res.body.memoryRuntime,value);
});

test('the model tab offers a dropdown of models and saving a cloud choice requires consent',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  assert.equal(nodes(picker.tree,n=>n.type==='input'&&n.props.type==='radio').length,0);
  const select=nodes(picker.tree,n=>n.type==='select'&&n.props['aria-label']==='检索模型')[0];assert.ok(select);
  const options=nodes(select,n=>n.type==='option');
  assert.ok(options.length>=2);assert.equal(options.filter(n=>n.props.value===select.props.value).length,1);
  assert.deepEqual(nodes(select,n=>n.type==='optgroup').map(n=>n.props.label),['本地运行','云端 API']);
  assert.ok(options.some(n=>n.props.value===CLOUD&&text(n).includes('云端 · v4')));
  select.props.onChange({target:{value:CLOUD}});await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,true);
  assert.match(text(picker.tree),/保存并重启后会自动建索引，费用按服务商价格计算/);
  field(picker.tree,'我知道检索内容会发送到云端').props.onChange({target:{checked:true}});await picker.flush();
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  const call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');assert.equal(call.body.settings.rawRecallModel,CLOUD);assert.equal(call.body.settings.rawRecallAllowCloud,true);
  assert.equal(call.body.confirmSwitch,true);assert.equal(call.body.cloudConfirmed,true);
  assert.match(text(picker.tree),/建索引会把纳入索引的内容发送到服务商并计费/);
});

test('a custom API model needs an address and a model name, and vendor presets are not offered',async t=>{
  const env=environment(()=>{const info=snapshot();info.rawModels=[...info.rawModels,
    {id:'custom-api',label:'自定义 API（OpenAI 兼容）',tier:'cloud',engine:'api',cloud:true,custom:true,dimensions:1024},
    {id:'fictional-preset',label:'厂商预设',engine:'api',cloud:true,hidden:true,dimensions:1024}];return info;});t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  const choices=()=>nodes(select(picker.tree,'检索模型'),n=>n.type==='option').map(n=>n.props.value);
  assert.ok(choices().includes('custom-api'));assert.ok(!choices().includes('fictional-preset'));
  assert.equal(nodes(picker.tree,n=>n.type==='label'&&text(n).startsWith('API 地址')).length,0);
  select(picker.tree,'检索模型').props.onChange({target:{value:'custom-api'}});await picker.flush();
  assert.equal(field(picker.tree,'API 地址').props.value,'');
  field(picker.tree,'我知道检索内容会发送到云端').props.onChange({target:{checked:true}});await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,true);
  field(picker.tree,'API 地址').props.onChange({target:{value:'https://fictional-b.example/v1'}});await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,true);
  field(picker.tree,'模型名称').props.onChange({target:{value:'fictional-embed'}});await picker.flush();
  field(picker.tree,'向量维数').props.onChange({target:{value:'768'}});await picker.flush();
  field(picker.tree,'API Key').props.onChange({target:{value:'fictional-key'}});await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,false);
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  const call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');assert.equal(call.body.apiKey,'fictional-key');
  assert.deepEqual([call.body.settings.rawRecallModel,call.body.settings.rawRecallApiBase,call.body.settings.rawRecallApiModel,call.body.settings.rawRecallDimensions,call.body.settings.rawRecallAllowCloud],
    ['custom-api','https://fictional-b.example/v1','fictional-embed',768,true]);
  assert.equal(call.body.confirmSwitch,true);assert.equal(call.body.cloudConfirmed,true);
});

test('saved custom services can be selected and save the model with serviceId',async t=>{
  const info=snapshot();
  info.rawModels=[...info.rawModels,{id:'custom-api',label:'自定义 API（OpenAI 兼容）',tier:'cloud',engine:'api',cloud:true,custom:true,dimensions:1024}];
  info.embeddingServices=[{id:'service-a',name:'虚构甲',apiBase:'https://fictional-a.example/v1',apiModel:'fictional-embed',dimensions:768,hasKey:true,inUse:false},
    {id:'service-b',name:'虚构乙',apiBase:'https://fictional-b.example/v1',apiModel:'fictional-embed-b',dimensions:1024,hasKey:false,inUse:false}];
  const env=environment(()=>info);t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:'custom-api'}});await picker.flush();
  assert.deepEqual(serviceRadios(picker.tree).map(n=>n.props.value),['service-a','service-b','']);
  assert.match(text(picker.tree),/虚构甲fictional-a\.example · fictional-embed · 768 维/);
  pickService(picker.tree,'service-a');await picker.flush();
  assert.equal(chosenService(picker.tree),'service-a');
  // A saved service carries its own address, model and size; the new-service fields are hidden.
  assert.equal(nodes(picker.tree,n=>n.type==='label'&&text(n).startsWith('API 地址')).length,0);
  // The saved service already has a key, so no key field is offered for it.
  assert.equal(nodes(picker.tree,n=>n.type==='label'&&text(n).startsWith('API Key')).length,0);
  field(picker.tree,'我知道检索内容会发送到云端').props.onChange({target:{checked:true}});await picker.flush();
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  const call=writes(env).filter(item=>item.path===BASE+'/model').at(-1);
  assert.equal(call.body.serviceId,'service-a');assert.equal(call.body.apiKey,undefined);
  assert.equal(call.body.confirmSwitch,true);assert.equal(call.body.cloudConfirmed,true);
});

test('saved services support edit, delete confirmation and an in-use locked state',async t=>{
  const serviceA={id:'service-a',name:'虚构甲',apiBase:'https://fictional-a.example/v1',apiModel:'fictional-embed-a',dimensions:768,hasKey:true,inUse:true};
  const serviceB={id:'service-b',name:'虚构乙',apiBase:'https://fictional-b.example/v1',apiModel:'fictional-embed-b',dimensions:1024,hasKey:true,inUse:false};
  let info=snapshot();
  info.rawModel={fields:{rawRecallModel:'custom-api',rawRecallApiBase:serviceA.apiBase,rawRecallApiModel:serviceA.apiModel,
    rawRecallDimensions:serviceA.dimensions,rawRecallAllowCloud:true},hasSavedApiKey:true};
  info.rawModels=[...info.rawModels,{id:'custom-api',label:'自定义 API（OpenAI 兼容）',tier:'cloud',engine:'api',cloud:true,custom:true,dimensions:1024}];
  info.embeddingServices=[serviceA,serviceB];
  const env=environment((url,body)=>{
    if(url!==BASE+'/embedding-services')return info;
    if(body.action==='delete')info={...info,revision:'r2',embeddingServices:info.embeddingServices.filter(service=>service.id!==body.id)};
    else info={...info,revision:'r3',embeddingServices:info.embeddingServices.map(service=>
      service.id===body.id?{...service,name:body.name}:service)};
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  assert.equal(chosenService(picker.tree),'service-a');
  assert.equal(button(picker.tree,'删除').props.disabled,true);
  assert.equal(button(picker.tree,'删除').props.title,'正在使用，不能删除');

  pickService(picker.tree,'service-b');await picker.flush();
  assert.equal(button(picker.tree,'删除').props.disabled,false);
  button(picker.tree,'删除').props.onClick();await picker.flush();
  assert.match(text(picker.tree),/删除「虚构乙」？只删除这条服务配置和它的密钥，不影响已有记忆和索引。/);
  button(picker.tree,'返回').props.onClick();await picker.flush();
  assert.equal(nodes(picker.tree,n=>n.props?.role==='dialog').length,0);
  button(picker.tree,'删除').props.onClick();await picker.flush();
  await button(picker.tree,'确认删除').props.onClick();await picker.flush();
  assert.equal(writes(env).at(-1).body.action,'delete');assert.equal(writes(env).at(-1).body.id,'service-b');

  pickService(picker.tree,'service-a');await picker.flush();
  button(picker.tree,'编辑').props.onClick();await picker.flush();
  assert.equal(field(picker.tree,'服务名称').props.value,'虚构甲');
  assert.equal(nodes(picker.tree,n=>n.type==='label'&&text(n).startsWith('服务 API 地址')).length,0);
  field(picker.tree,'服务名称').props.onChange({target:{value:'虚构甲改名'}});await picker.flush();
  await button(picker.tree,'保存服务').props.onClick();await picker.flush();
  const saved=writes(env).filter(item=>item.path===BASE+'/embedding-services').at(-1);
  assert.equal(saved.body.action,'save');assert.equal(saved.body.id,'service-a');assert.equal(saved.body.name,'虚构甲改名');
  assert.equal(saved.body.apiKey,undefined);
});

test('only storing a new service writes the list and never calls the model endpoint',async t=>{
  let info=snapshot();
  info.rawModels=[...info.rawModels,{id:'custom-api',label:'自定义 API（OpenAI 兼容）',tier:'cloud',engine:'api',cloud:true,custom:true,dimensions:1024}];
  const env=environment((url,body)=>{
    if(url!==BASE+'/embedding-services')return info;
    const saved={id:'service-new',name:'fictional-new.example · fictional-new',apiBase:'https://fictional-new.example/v1',
      apiModel:'fictional-new',dimensions:768,hasKey:true,inUse:false};
    info={...info,revision:'r2',embeddingServices:[saved]};
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:'custom-api'}});await picker.flush();
  field(picker.tree,'API 地址').props.onChange({target:{value:'https://fictional-new.example/v1'}});await picker.flush();
  field(picker.tree,'模型名称').props.onChange({target:{value:'fictional-new'}});await picker.flush();
  field(picker.tree,'向量维数').props.onChange({target:{value:'768'}});await picker.flush();
  field(picker.tree,'API Key').props.onChange({target:{value:'fictional-key'}});await picker.flush();
  await button(picker.tree,'只存入列表').props.onClick();await picker.flush();
  assert.equal(writes(env).filter(call=>call.path===BASE+'/model').length,0);
  const call=writes(env).filter(item=>item.path===BASE+'/embedding-services').at(-1);
  assert.equal(call.body.action,'save');assert.equal(call.body.apiKey,'fictional-key');
  await picker.update({info});assert.equal(chosenService(picker.tree),'service-new');
  assert.match(text(picker.tree),/已存入服务列表；尚未切换模型/);
});

test('saved-service actions disable while a request is in progress',async t=>{
  const held=deferred(),service={id:'service-a',name:'虚构甲',apiBase:'https://fictional-a.example/v1',
    apiModel:'fictional-embed',dimensions:768,hasKey:true,inUse:false};
  let info=snapshot();
  info.rawModel={fields:{rawRecallModel:'custom-api',rawRecallApiBase:service.apiBase,rawRecallApiModel:service.apiModel,
    rawRecallDimensions:service.dimensions,rawRecallAllowCloud:true},hasSavedApiKey:true};
  info.rawModels=[...info.rawModels,{id:'custom-api',label:'自定义 API（OpenAI 兼容）',tier:'cloud',engine:'api',cloud:true,custom:true,dimensions:1024}];
  info.embeddingServices=[service];
  const env=environment((url,body)=>url===BASE+'/embedding-services'?held.promise:info);t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  button(picker.tree,'删除').props.onClick();await picker.flush();
  const pending=button(picker.tree,'确认删除').props.onClick();await picker.flush();
  assert.equal(button(picker.tree,'编辑').props.disabled,true);
  assert.equal(button(picker.tree,'删除').props.disabled,true);
  assert.equal(button(picker.tree,'确认删除').props.disabled,true);
  assert.equal(button(picker.tree,'保存中').props.disabled,true);
  held.resolve({ok:true,revision:'r2',embeddingServices:[]});await pending;await picker.flush();
});

test('the model tab saves scheduled residency and resets the idle timeout for always-loaded mode',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  const residency=()=>{const label=nodes(picker.tree,n=>n.type==='label'&&text(n).startsWith('模型常驻'))[0];assert.ok(label);const control=nodes(label,n=>n.type==='select')[0];assert.ok(control);return control;};
  residency().props.onChange({target:{value:'hours'}});await picker.flush();
  assert.equal(field(picker.tree,'常驻时段').props.value,'08:00-01:00');
  field(picker.tree,'常驻时段').props.onChange({target:{value:'09:30-23:45'}});await picker.flush();
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  let call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');
  assert.equal(call.body.settings.rawRecallResidentHours,'09:30-23:45');assert.equal(call.body.settings.rawRecallIdleMs,600000);
  assert.equal('confirmSwitch' in call.body,false);assert.equal('cloudConfirmed' in call.body,false);
  assert.match(text(picker.tree),/已保存，重启 DSH 后生效/);
  residency().props.onChange({target:{value:'always'}});await picker.flush();
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');
  assert.equal(call.body.settings.rawRecallResidentHours,'');assert.equal(call.body.settings.rawRecallIdleMs,0);
  assert.equal('confirmSwitch' in call.body,false);assert.equal('cloudConfirmed' in call.body,false);
});

test('local model inventory marks installed and missing choices without repeating the current model',async t=>{
  const info=snapshot();info.rawModels=[...info.rawModels,
    {id:LARGE_LOCAL,label:'Qwen 8B',engine:'llamacpp',dimensions:4096}];
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install'&&body?.action==='inventory')return inventoryResponse([
      {id:MODEL,installed:true,source:'current',issues:[],downloadBytes:0,settings:{}},
      {id:OTHER_LOCAL,installed:false,source:null,issues:['missing'],downloadBytes:613527631,settings:null},
      {id:LARGE_LOCAL,installed:true,source:'history',issues:[],downloadBytes:0,settings:{rawRecallGgufModel:'/fixture/8b.gguf'}}]);
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  const options=nodes(select(picker.tree,'检索模型'),node=>node.type==='option');
  const option=id=>text(options.find(node=>node.props.value===id));
  assert.match(option(MODEL),/当前使用/);assert.doesNotMatch(option(MODEL),/已安装/);
  assert.match(option(OTHER_LOCAL),/未安装/);assert.match(option(LARGE_LOCAL),/已安装/);
});

test('choosing another model and returning to the one in use saves its original paths',async t=>{
  const info=snapshot();info.rawModels=[...info.rawModels,{id:LARGE_LOCAL,label:'Qwen 8B',engine:'llamacpp',dimensions:4096}];
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install'&&body?.action==='inventory')return inventoryResponse([
      {id:MODEL,installed:true,source:'current',issues:[],downloadBytes:0,settings:{}},
      {id:LARGE_LOCAL,installed:false,source:null,issues:['missing'],downloadBytes:4700000000,settings:null}]);
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:LARGE_LOCAL}});await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:MODEL}});await picker.flush();
  const residency=nodes(nodes(picker.tree,n=>n.type==='label'&&text(n).startsWith('模型常驻'))[0],n=>n.type==='select')[0];
  residency.props.onChange({target:{value:'idle'}});await picker.flush();
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  const call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');
  assert.deepEqual([call.body.settings.rawRecallModel,call.body.settings.rawRecallGgufModel,call.body.settings.rawRecallLlamaServer],
    [MODEL,'/fixture/model.gguf','/fixture/llama.exe']);
});

test('a missing local model can download files but cannot save or write model settings',async t=>{
  const info=snapshot();
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install'){
      if(body?.action==='inventory')return inventoryResponse([
        {id:MODEL,installed:true,source:'current',issues:[],downloadBytes:0,settings:{}},
        {id:OTHER_LOCAL,installed:false,source:null,issues:['missing'],downloadBytes:613527631,settings:null}]);
      if(body?.action==='start')return {ok:true,job:{id:'download',model:OTHER_LOCAL,state:'running',step:'fixture'}};
      return {ok:true,job:null};
    }return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:OTHER_LOCAL}});await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,true);
  const preparation=env.component(component(picker.tree,'ModelPreparation'));await preparation.flush();
  assert.match(text(preparation.tree),/尚未下载（约 585\.1 MB）。下载只保存文件，不切换模型。/);
  await button(preparation.tree,'下载').props.onClick();await preparation.flush();
  const start=writes(env).find(call=>call.path===BASE+'/model-install'&&call.body.action==='start');
  assert.equal(start.body.downloadOnly,true);assert.equal(start.body.allowDownload,true);
  assert.equal(writes(env).filter(call=>call.path===BASE+'/model').length,0);
});

test('a completed download refreshes inventory and saves the installed paths',async t=>{
  const info=snapshot();let completed=false,downloaded=false,job=null;
  const installedSettings={rawRecallPython:'/fixture/python.exe',rawRecallOnnxModel:'/fixture/downloaded.onnx',
    rawRecallOnnxTokenizer:'/fixture/downloaded.tokenizer.json',rawRecallInstallReceipt:'/fixture/receipt.json'};
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install'){
      if(body?.action==='inventory')return inventoryResponse([
        {id:MODEL,installed:true,source:'current',issues:[],downloadBytes:0,settings:{}},
        {id:OTHER_LOCAL,installed:downloaded,source:downloaded?'current':null,issues:downloaded?[]:['missing'],
          downloadBytes:downloaded?0:613527631,settings:downloaded?installedSettings:null}]);
      if(body?.action==='start'){job={id:'download',model:OTHER_LOCAL,state:'running',step:'fixture'};return {ok:true,job};}
      if(!body){
        if(completed&&job?.state==='running'){downloaded=true;job={...job,state:'downloaded',step:'已下载；选中后点「保存」启用'};}
        return {ok:true,job};
      }
    }
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:OTHER_LOCAL}});await picker.flush();
  const preparation=env.component(component(picker.tree,'ModelPreparation'));await preparation.flush();
  await button(preparation.tree,'下载').props.onClick();await preparation.flush();
  completed=true;
  for(const tick of [...env.timers.values()])await tick();
  await preparation.flush();await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,false);
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  const call=writes(env).filter(item=>item.path===BASE+'/model').at(-1);
  assert.equal(call.body.settings.rawRecallOnnxModel,installedSettings.rawRecallOnnxModel);
  assert.equal(call.body.settings.rawRecallInstallReceipt,installedSettings.rawRecallInstallReceipt);
});

test('an installed local model offers save without a download button',async t=>{
  const info=snapshot();info.rawModels=[...info.rawModels,
    {id:LARGE_LOCAL,label:'Qwen 8B',engine:'llamacpp',dimensions:4096}];
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install'&&body?.action==='inventory')return inventoryResponse([
      {id:MODEL,installed:true,source:'current',issues:[],downloadBytes:0,settings:{}},
      {id:OTHER_LOCAL,installed:false,source:null,issues:['missing'],downloadBytes:613527631,settings:null},
      {id:LARGE_LOCAL,installed:true,source:'history',issues:[],downloadBytes:0,
        settings:{rawRecallGgufModel:'/fixture/8b.gguf',rawRecallLlamaServer:'/fixture/8b-server.exe'}}]);
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:LARGE_LOCAL}});await picker.flush();
  assert.equal(nodes(picker.tree,node=>node.type==='button'&&text(node)==='下载').length,0);
  assert.match(text(picker.tree),/已安装。点「保存」后启用。/);
  assert.equal(button(picker.tree,'保存').props.disabled,false);
});

test('inventory failure leaves the page usable and does not block save',async t=>{
  const info=snapshot();
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install'&&body?.action==='inventory')
      return {status:500,body:{ok:false,error:'fixture inventory failure'}};
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:OTHER_LOCAL}});await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,false);
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  assert.equal(writes(env).filter(call=>call.path===BASE+'/model').length,1);
});

test('runtime HTTP forwards switch actions with an explicit boolean cloud confirmation only',async t=>{
  const operations=[];
  const request=httpFixture(t,{getMemoryRuntime:()=>runtime(),runMemoryRuntime:async input=>{operations.push(input);return {ok:true};}});
  for(const action of ['plan','switch','cancel-switch','drop-index']){
    assert.equal((await request('POST',{action,profileId:MODEL,cloudConfirmed:true,force:true})).statusCode,200);
    assert.deepEqual(operations.at(-1),{action,profileId:MODEL,cloudConfirmed:true});
  }
  assert.equal((await request('POST',{action:'switch',profileId:MODEL})).statusCode,200);
  assert.deepEqual(operations.at(-1),{action:'switch',profileId:MODEL});
  assert.equal((await request('POST',{action:'switch',profileId:MODEL,cloudConfirmed:'yes'})).statusCode,400);
  assert.equal(operations.length,5);
});

test('model status panel reports the index estimate and drops only an unused index',async t=>{
  const OLD='Qwen/Qwen3-Embedding-0.6B';
  const state=runtime();state.vectors.profiles.push({id:OLD,model:OLD,revision:7,modelState:'unloaded',progress:{state:'ready',completed:3,total:3},index:{hasSnapshot:true}});
  state.vectors.profiles[0].index={hasSnapshot:true};state.vectors.active={id:MODEL,revision:2};
  const plans={[MODEL]:{total:5,reusable:5,pending:0,pendingChars:0,estimatedTokens:0},[OLD]:{total:5,reusable:3,pending:2,pendingChars:12000,estimatedTokens:9000}};
  const env=environment((url,body)=>{
    if(url===BASE+'/runtime'){
      if(!body)return state;
      if(body.action==='plan')return {ok:true,plan:plans[body.profileId]};
      return {ok:true};
    }
    return snapshot();
  });t.after(()=>env.close());
  const {model}=await modelPage(env);
  const panel=env.component(component(model.tree,'ModelSwitch'));await panel.flush();
  assert.equal(rowOf(panel.tree,'此模型').value,'使用中');
  assert.equal(nodes(panel.tree,n=>n.type==='button'&&text(n)==='切换到此模型').length,0);
  assert.equal(nodes(panel.tree,n=>n.type==='button'&&text(n)==='清理此模型的索引').length,0,'active index cannot be dropped');
  await panel.update({...panel.props,modelId:OLD});
  assert.match(text(panel.tree),/可切回，需补 2 篇/);
  assert.equal(nodes(panel.tree,n=>n.type==='button'&&text(n)==='切换到此模型').length,0);
  button(panel.tree,'清理此模型的索引').props.onClick();await panel.flush();
  assert.match(text(panel.tree),/下次切回需全量重建/);
  await button(panel.tree,'确认清理').props.onClick();await panel.flush();
  assert.deepEqual(writes(env).filter(call=>call.path===BASE+'/runtime'&&call.body.action!=='plan').map(call=>call.body),[{action:'drop-index',profileId:OLD}]);
});

test('a preparation refused by an in-flight chat query asks to retry after the conversation',async t=>{
  const state=runtime();state.vectors.profiles[0].progress={state:'error',completed:0,total:4,error:'EMBEDDING_BUSY'};
  state.operation={action:'prepare',state:'failed',error:'EMBEDDING_BUSY'};
  const env=environment(url=>url===BASE+'/runtime'?state:snapshot());t.after(()=>env.close());
  const {view:panel}=await statusRuntime(env);
  const shown=text(panel.tree);
  assert.equal(rowOf(panel.tree,'索引').value,'0 / 4 出错');assert.match(rowOf(panel.tree,'索引').meta,/对话查询正在使用向量模型，请等这次对话结束后再点击/);
  assert.match(shown,/准备索引：失败（对话查询正在使用向量模型/);
  assert.equal(shown.includes('EMBEDDING_BUSY'),false);
});

test('status page shows the last search time, what it lost, and a summary that leaves out model loads',async t=>{
  let value={...runtime(),searches:[]};
  const env=environment((url,body)=>{
    if(url!==BASE+'/runtime')return snapshot();
    if(body?.action==='probe')return {ok:true,probe:{loadMs:2100,encodeMs:80,dimensions:2560,expectedDimensions:2560,device:'cuda'}};
    return value;
  });t.after(()=>env.close());const {view}=await statusRuntime(env);
  assert.equal(rowOf(view.tree,'检索耗时').value,'暂无');assert.equal(rowOf(view.tree,'检索耗时').meta,'还没有检索记录，聊一句后再看');
  const at=new Date().toISOString();
  value={...value,searches:[
    {kind:'search',at,totalMs:600,state:'ok',records:5,skippedVisible:0,vector:{state:'ready',ms:130},rerank:{state:'applied',ms:410},cold:false},
    {kind:'search',at,totalMs:9000,state:'ok',records:5,skippedVisible:0,vector:{state:'ready',ms:8800},rerank:null,cold:true},
    {kind:'prefetch',at,totalMs:1250,state:'ok',records:3,skippedVisible:2,vector:{state:'ready',ms:120},rerank:{state:'timeout',ms:1100},cold:false}]};
  await view.update({tick:1});
  assert.equal(rowOf(view.tree,'检索耗时').value,'1.25 秒 打折扣');
  assert.equal(rowOf(view.tree,'检索耗时').meta,'回答前 · 刚刚 · 附上 3 条 · 跳过 2 条对话里已有的 · 向量 0.12 秒 · 重排 1.10 秒 · 重排超时，已按原顺序');
  assert.equal(rowOf(view.tree,'近 3 次').value,'中位 0.60 秒');
  assert.equal(rowOf(view.tree,'近 3 次').meta,'最慢 1.25 秒 · 打折扣或超时 1 次 · 不含 1 次模型加载');
  await button(view.tree,'试算').props.onClick();await view.flush();
  assert.deepEqual(writes(env).at(-1).body,{action:'probe',profileId:MODEL});
  assert.equal(rowOf(view.tree,'试算正常').value,'0.08 秒 通过');
  assert.match(rowOf(view.tree,'试算正常').meta,/^刚刚 · 先加载了 2\.10 秒 · .+ · 2560 维$/);
});

test('a size mismatch from the probe fails, and a paused rerank can be resumed early',async t=>{
  const info=snapshot();info.rerank={enabled:true};
  const value={...runtime(),rerank:{enabled:true,model:'fixture/reranker',service:'fictional-rerank.example',state:'paused',reason:'重排服务调用失败，暂停 10 分钟',
    pausedUntil:new Date(Date.now()+5*60000-1000).toISOString(),calls:3,failures:1,tokens:0}};
  const env=environment((url,body)=>{
    if(url!==BASE+'/runtime')return info;
    if(body?.action==='probe')return {ok:true,probe:{loadMs:0,encodeMs:50,dimensions:1024,expectedDimensions:2560}};
    if(body?.action==='resume-rerank'){value.rerank={...value.rerank,state:'ready',reason:''};delete value.rerank.pausedUntil;return {ok:true,rerank:value.rerank};}
    return value;
  });t.after(()=>env.close());const {view}=await statusRuntime(env);
  await button(view.tree,'试算').props.onClick();await view.flush();
  assert.equal(rowOf(view.tree,'试算失败').meta,'返回 1024 维，索引用的是 2560 维');
  assert.equal(rowOf(view.tree,'重排').value,'暂停中恢复使用');
  assert.equal(rowOf(view.tree,'重排').meta,'重排服务调用失败，暂停 10 分钟 · 约 5 分钟后自动恢复');
  await button(view.tree,'恢复使用').props.onClick();await view.flush();
  assert.deepEqual(writes(env).at(-1).body,{action:'resume-rerank'});
  assert.match(text(view.tree),/重排已恢复。/);assert.equal(rowOf(view.tree,'重排').value,'已开启');
});

test('vector services test from their row, a new service tests what is typed, and an edit hides the old result',async t=>{
  const info=snapshot();
  info.rawModels=[...info.rawModels,{id:'custom-api',label:'自定义 API（OpenAI 兼容）',tier:'cloud',engine:'api',cloud:true,custom:true,dimensions:1024}];
  info.embeddingServices=[{id:'service-a',name:'虚构甲',apiBase:'https://fictional-a.example/v1',apiModel:'fictional-embed',dimensions:768,hasKey:true,inUse:false}];
  const env=environment((url,body)=>{
    if(url!==BASE+'/test')return info;
    return body.serviceId?{ok:true,result:{ok:true,target:'embedding',ms:142,dimensions:768,host:'fictional-a.example'}}
      :{ok:true,result:{ok:false,target:'embedding',error:{code:'key',message:'API Key 无效或没有权限',hint:'重新填写 API Key 后再测试'}}};
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  select(picker.tree,'检索模型').props.onChange({target:{value:'custom-api'}});await picker.flush();
  pickService(picker.tree,'service-a');await picker.flush();
  assert.match(button(picker.tree,'测试').props.title,/可能产生极少费用/);
  await button(picker.tree,'测试').props.onClick();await picker.flush();
  assert.deepEqual(writes(env).at(-1).body,{target:'embedding',serviceId:'service-a'});
  assert.equal(rowOf(picker.tree,'连接正常').value,'0.14 秒 通过');
  assert.equal(rowOf(picker.tree,'连接正常').meta,'刚刚 · 返回 768 维 · fictional-a.example');
  pickService(picker.tree,'');await picker.flush();
  assert.equal(nodes(picker.tree,n=>n.props?.className==='memory-row'&&text(n).startsWith('连接')).length,0);
  assert.equal(button(picker.tree,'测试连接').props.disabled,true);
  field(picker.tree,'API 地址').props.onChange({target:{value:'https://fictional-new.example/v1'}});await picker.flush();
  field(picker.tree,'模型名称').props.onChange({target:{value:'fictional-new'}});await picker.flush();
  field(picker.tree,'API Key').props.onChange({target:{value:'fictional-typed-key'}});await picker.flush();
  await button(picker.tree,'测试连接').props.onClick();await picker.flush();
  assert.deepEqual(writes(env).at(-1).body,{target:'embedding',model:'custom-api',apiBase:'https://fictional-new.example/v1',apiModel:'fictional-new',dimensions:1024,apiKey:'fictional-typed-key'});
  assert.equal(rowOf(picker.tree,'连接失败').meta,'API Key 无效或没有权限。重新填写 API Key 后再测试');
  assert.doesNotMatch(JSON.stringify(nodes(picker.tree,n=>n.props?.role==='status').map(text)),/fictional-typed-key/);
  field(picker.tree,'API Key').props.onChange({target:{value:'fictional-other-key'}});await picker.flush();
  assert.equal(nodes(picker.tree,n=>n.props?.className==='memory-row'&&text(n).startsWith('连接失败')).length,0);
});

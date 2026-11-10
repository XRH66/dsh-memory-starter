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
const writes=env=>env.calls.filter(call=>call.body);
async function modelPage(env){const page=env.page();await page.flush();button(page.tree,'维护').props.onClick();await page.flush();const model=env.component(component(page.tree,'RawModelSettings'));await model.flush();return {page,model};}

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
  const page=env.page();await page.flush();button(page.tree,'维护').props.onClick();await page.flush();
  const zone=env.component(component(page.tree,'TimeZoneSettings'));await zone.flush();
  assert.match(text(zone.tree),/当前生效：America\/Los_Angeles；本机时区：America\/Los_Angeles/);
  field(zone.tree,'个人时区').props.onChange({target:{value:'Asia/Shanghai'}});await zone.flush();
  await button(zone.tree,'保存时区').props.onClick();await zone.flush();
  const write=writes(env).at(-1);
  assert.equal(write.path,BASE+'/time-zone');
  assert.deepEqual(JSON.parse(JSON.stringify(write.body)),{timeZone:'Asia/Shanghai',revision:'r1'});
});

test('cloud credential reuse is explicit, resets on address edits, and stays out of the password field',async t=>{
  const info=snapshot();info.rawModel={hasSavedApiKey:true,fields:{rawRecallModel:CLOUD,rawRecallApiBase:'https://fictional-a.example/v1',rawRecallApiKeyEnv:'FICTIONAL_A_KEY',rawRecallAllowCloud:true}};
  const env=environment(()=>info);t.after(()=>env.close());const {model}=await modelPage(env);
  const reuse='我确认当前填写的服务地址可以使用现有密钥或环境变量凭据';
  assert.equal(field(model.tree,reuse).props.checked,false);assert.equal(field(model.tree,'API Key（').props.value,'');
  field(model.tree,'API 地址').props.onChange({target:{value:'https://fictional-b.example/v1'}});await model.flush();
  field(model.tree,reuse).props.onChange({target:{checked:true}});await model.flush();
  const save=()=>button(model.tree,'应用运行设置');
  assert.ok(save());await save().props.onClick();await model.flush();
  assert.equal(writes(env).at(-1).body.reuseApiKey,true);
  field(model.tree,'API 地址').props.onChange({target:{value:'https://fictional-c.example/v1'}});await model.flush();
  assert.equal(field(model.tree,reuse).props.checked,false);
  field(model.tree,'API Key（').props.onChange({target:{value:'fixture-new-key'}});await model.flush();
  assert.equal(field(model.tree,reuse).props.disabled,true);await save().props.onClick();await model.flush();
  assert.equal(writes(env).at(-1).body.apiKey,'fixture-new-key');assert.equal(writes(env).at(-1).body.reuseApiKey,undefined);
  button(model.tree,'专家模式').props.onClick();await model.flush();assert.equal(field(model.tree,'API Key 环境变量').props.value,'FICTIONAL_A_KEY');
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
  const line=nodes(page.tree,node=>node.type==='div'&&node.props.className==='memory-line'&&text(children(node)[0])==='记忆框架')[0];
  assert.ok(line);assert.equal(text(line),'记忆框架已加载');
  assert.match(text(page.tree),/记忆框架已加载，各对话记忆状态见下方/);
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
    const line=nodes(page.tree,node=>node.type==='div'&&node.props.className==='memory-line'&&text(children(node)[0])==='记忆框架')[0];
    assert.ok(line);assert.equal(text(line),'记忆框架'+(loaded?'已加载':'未加载'),JSON.stringify(plugins));
    assert.equal(writes(env).length,0);
  }
});

test('standard mode shows one selected model, collapses resource paths and preserves device drafts across modes',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());const {model}=await modelPage(env);
  assert.equal(button(model.tree,'标准模式').props['aria-pressed'],true);
  assert.equal(nodes(model.tree,n=>n.type==='details')[0].props.open,false);
  assert.equal(select(model.tree,'查看向量模型').props.value,MODEL);
  assert.equal(select(model.tree,'运行设备').props.value,'auto');
  assert.equal(nodes(model.tree,n=>n.type==='option'&&n.props.value==='cuda')[0].props.disabled,false);
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
  field(model.tree,'单次编码超时（毫秒）').props.onChange({target:{value:'10000'}});await model.flush();
  assert.equal(field(model.tree,'检索总等待（毫秒，0 为自动）').props.value,0);
  field(model.tree,'检索总等待（毫秒，0 为自动）').props.onChange({target:{value:'3500'}});await model.flush();
  await button(model.tree,'应用运行设置').props.onClick();await model.flush();
  assert.equal(writes(env).length,1);const call=writes(env)[0];assert.equal(call.path,BASE+'/model');
  assert.equal(call.body.settings.rawRecallDevice,'cuda');
  assert.equal(call.body.settings.rawRecallCpuThreads,6);assert.equal(call.body.settings.rawRecallGpuThreads,4);
  assert.equal(call.body.settings.rawRecallIdleMs,180000);assert.equal(call.body.settings.rawRecallThreads,3);
  assert.equal(call.body.settings.rawRecallTimeoutMs,10000);
  assert.equal(call.body.settings.rawRecallQueryWaitMs,3500);
  assert.equal(call.body.settings.rawRecallLlamaCpuServer,'/fixture/cpu.exe');
  assert.equal(call.body.settings.rawRecallLlamaCudaServer,'/fixture/cuda.exe');
  assert.match(text(model.tree),/保存不会启动模型/);
});

test('changing the dropdown is local only and cloud models never show local device or lifecycle controls',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());const {model}=await modelPage(env);
  select(model.tree,'查看向量模型').props.onChange({target:{value:'Qwen/Qwen3-Embedding-0.6B'}});await model.flush();
  assert.equal(nodes(model.tree,n=>n.type==='option'&&n.props.value==='cuda')[0].props.disabled,true);
  select(model.tree,'查看向量模型').props.onChange({target:{value:CLOUD}});await model.flush();
  assert.equal(nodes(model.tree,n=>n.type==='select'&&n.props['aria-label']==='运行设备').length,0);
  assert.equal(nodes(model.tree,n=>n.type==='input'&&n.props.value==='/fixture/llama.exe').length,0);
  const view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
  assert.equal(nodes(view.tree,n=>n.type==='button'&&['加载／预热','释放运行资源'].includes(text(n))).length,0);
  assert.equal(writes(env).length,0);
});

test('runtime distinguishes a completed old index count from pending catalogue coverage',async t=>{
  const value=runtime();value.vectors.profiles[0].progress={state:'pending',completed:4,total:4,pendingBoundaries:1};
  const env=environment(url=>url===BASE+'/runtime'?value:snapshot());t.after(()=>env.close());
  const {model}=await modelPage(env),view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
  assert.match(text(view.tree),/全域索引：待追平（上次完成 4 \/ 4）/);
  assert.doesNotMatch(text(view.tree),/全域索引：已就绪/);
  value.vectors.profiles[0].progress={state:'ready',completed:5,total:5};
  await button(view.tree,'刷新运行状态').props.onClick();await view.flush();
  assert.match(text(view.tree),/全域索引：已就绪（5 \/ 5）/);assert.equal(writes(env).length,0);
});

test('runtime status is read-only, keeps actual CPU fallback separate and dispatches explicit lifecycle targets',async t=>{
  let value=runtime();const env=environment((url,body)=>{
    if(url!==BASE+'/runtime')return snapshot();
    if(body){if(body.action==='release'){value.vectors.runtime.actualDevice=null;value.vectors.profiles[0].modelState='released';}return {ok:true,started:body.action==='prepare'};}
    return value;
  });t.after(()=>env.close());const {model}=await modelPage(env),view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
  assert.match(text(view.tree),/实际运行设备：CPU；回退原因：CUDA 不可用/);
  assert.match(text(view.tree),/全域索引：已就绪（4 \/ 4）/);
  assert.match(text(view.tree),/已报告 20 tokens/);
  assert.equal(writes(env).length,0);
  for(const action of [['加载／预热','load'],['准备索引','prepare'],['释放运行资源','release']]){
    await button(view.tree,action[0]).props.onClick();await view.flush();
    const call=writes(env).at(-1);assert.equal(call.path,BASE+'/runtime');
    assert.deepEqual(call.body,{action:action[1],profileId:MODEL,profileRevision:2});
    if(action[1]==='prepare')assert.match(text(view.tree),/操作已启动/);
  }
  assert.match(text(view.tree),/实际运行设备：未加载/);
  assert.ok(env.calls.filter(call=>call.path===BASE+'/runtime').every(call=>call.options.cache==='no-store'));
});

test('runtime errors do not simulate success and blocked actions never send force or authorization overrides',async t=>{
  const held=deferred();let attempts=0;
  const env=environment((url,body)=>url===BASE+'/runtime'?body?(attempts++,held.promise):runtime():snapshot());t.after(()=>env.close());
  const {model}=await modelPage(env),view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
  const trigger=button(view.tree,'尝试整理待办'),pending=trigger.props.onClick();trigger.props.onClick();await view.flush();
  assert.equal(attempts,1);
  held.resolve({status:403,body:{ok:false,error:'原始会话授权已撤销'}});await pending;await view.flush();
  assert.match(text(view.tree),/原始会话授权已撤销/);assert.doesNotMatch(text(view.tree),/操作已返回/);
  assert.deepEqual(writes(env)[0].body,{action:'flush'});
});

test('scheduling resume and selected-batch retry use real runtime requests',async t=>{
  const env=environment((url,body)=>url===BASE+'/runtime'?body?{ok:true}:runtime():snapshot());t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'维护').props.onClick();await page.flush();
  const view=env.component(component(page.tree,'MemoryRuntimeSettings'));await view.flush();
  assert.match(text(view.tree),/foreground-busy/);assert.match(text(view.tree),/原始授权及前台占用/);
  assert.equal(button(view.tree,'重试所选批次').props.disabled,true);
  await button(view.tree,'恢复后台任务').props.onClick();await view.flush();
  select(view.tree,'重试批次').props.onChange({target:{value:'batch-one'}});await view.flush();
  await button(view.tree,'重试所选批次').props.onClick();await view.flush();
  assert.deepEqual(writes(env).map(call=>call.body),[{action:'resume'},{action:'retry',batchId:'batch-one'}]);
});

test('missing runtime callbacks remain visibly unconnected, with unknown counts and disabled model actions',async t=>{
  const env=environment(url=>url===BASE+'/runtime'?{status:404,body:{ok:false,error:'当前入口尚未接入记忆运行管理'}}:snapshot());t.after(()=>env.close());
  const {model}=await modelPage(env),view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
  assert.match(text(view.tree),/尚未接入记忆运行管理/);assert.match(text(view.tree),/未知 \/ 未知/);
  assert.doesNotMatch(text(view.tree),/统一向量服务已接入/);
  assert.equal(button(view.tree,'加载／预热').props.disabled,true);assert.equal(button(view.tree,'尝试整理待办').props.disabled,true);
  assert.equal(writes(env).length,0);
});

test('existing installer plan, download, cancel and configuration recovery remain available',async t=>{
  const info=snapshot();info.rawModelHistory=[{id:'old',model:MODEL}];let job=null;
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install'){
      if(!body)return {ok:true,job};
      if(body.action==='plan')return {ok:true,plan:{downloadBytes:1024,resources:{freeRamGiB:16,suggestedThreads:6,recommendedModel:MODEL,gpuState:'unavailable'},source:'https://example.com/model'}};
      job={id:'download',model:MODEL,state:body.action==='start'?'running':'cancelled',step:'fixture'};return {ok:true,job};
    }return info;
  });t.after(()=>env.close());const {model}=await modelPage(env);
  assert.ok(button(model.tree,'恢复上次向量设置'));
  const installer=env.component(component(model.tree,'ModelPreparation'));await installer.flush();
  await button(installer.tree,'查看安装与资源建议').props.onClick();await installer.flush();
  await button(installer.tree,'下载准备并保存选择').props.onClick();await installer.flush();
  await button(installer.tree,'取消准备（保留已下载部分）').props.onClick();await installer.flush();
  assert.deepEqual(writes(env).map(call=>call.body.action),['plan','start','cancel']);
  assert.equal(writes(env)[1].body.acceleration,'cuda');
  assert.equal(writes(env)[1].body.settings.rawRecallGgufModel,'/fixture/model.gguf');
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
  });t.after(()=>env.close());const {model}=await modelPage(env),view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
  await button(view.tree,'准备索引').props.onClick();await view.flush();
  assert.match(text(view.tree),/操作已启动/);assert.match(text(view.tree),/操作回执：准备索引 · 进行中/);
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
    const {model}=await modelPage(env),view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
    await button(view.tree,label).props.onClick();await view.flush();
    assert.deepEqual(writes(env)[0].body,{action,profileId:MODEL,profileRevision:2});
    select(model.tree,'查看向量模型').props.onChange({target:{value:other}});await model.flush();
    value.vectors.selectedProfileId=other;
    await view.update(component(model.tree,'MemoryRuntimeSettings').props);
    assert.match(text(view.tree),new RegExp('正在查看：'+other.replaceAll('.','\\.')));
    const cancel=button(view.tree,'取消向量操作');assert.equal(cancel.props.disabled,false);
    await cancel.props.onClick();await view.flush();
    assert.deepEqual(writes(env).at(-1).body,{action:'cancel',profileId:MODEL,profileRevision:2});
    assert.equal(writes(env).length,2);assert.equal(env.timers.size,0);
  }
});

test('string model-state receipts use top-level actual device and do not borrow another profile runtime',async t=>{
  const value=runtime();Object.assign(value.vectors.profiles[0],{modelState:'loaded',actualDevice:'cuda',fallbackReason:null,runtime:{threads:4},idleReleaseMs:120000});
  const env=environment(url=>url===BASE+'/runtime'?value:snapshot());t.after(()=>env.close());const {model}=await modelPage(env);
  const view=env.component(component(model.tree,'MemoryRuntimeSettings'));await view.flush();
  assert.match(text(view.tree),/实际运行设备：GPU（NVIDIA CUDA）/);assert.doesNotMatch(text(view.tree),/回退原因/);
  assert.match(text(view.tree),/实际空闲释放设置：120 秒；计算线程 4/);
  value.vectors.profiles[0].actualDevice=null;
  await button(view.tree,'刷新运行状态').props.onClick();await view.flush();
  assert.match(text(view.tree),/运行状态：未加载/);assert.match(text(view.tree),/实际运行设备：未加载/);
  await view.update({modelId:'Qwen/Qwen3-Embedding-0.6B'});assert.match(text(view.tree),/实际运行设备：未报告/);
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

test('the model tab offers one card per model and saving a cloud choice requires consent',async t=>{
  const env=environment(()=>snapshot());t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  const radios=nodes(picker.tree,n=>n.type==='input'&&n.props.type==='radio');
  assert.ok(radios.length>=2);assert.equal(radios.filter(n=>n.props.checked).length,1);
  const cloud=nodes(picker.tree,n=>n.type==='label'&&n.props.className==='memory-model-card'&&text(n).includes('云端 · v4'))[0];
  nodes(cloud,n=>n.type==='input')[0].props.onChange();await picker.flush();
  assert.equal(button(picker.tree,'保存').props.disabled,true);
  field(picker.tree,'我知道检索内容会发送到云端').props.onChange({target:{checked:true}});await picker.flush();
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  const call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');assert.equal(call.body.settings.rawRecallModel,CLOUD);assert.equal(call.body.settings.rawRecallAllowCloud,true);
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
  residency().props.onChange({target:{value:'always'}});await picker.flush();
  await button(picker.tree,'保存').props.onClick();await picker.flush();
  call=writes(env).at(-1);assert.equal(call.path,BASE+'/model');
  assert.equal(call.body.settings.rawRecallResidentHours,'');assert.equal(call.body.settings.rawRecallIdleMs,0);
});

test('the model tab requests installation when the local model has no install receipt',async t=>{
  const info=snapshot();delete info.rawModel.fields.rawRecallInstallReceipt;
  const env=environment((url,body)=>{
    if(url===BASE+'/model-install')return body?{ok:true,job:{id:'download',model:MODEL,state:'running',step:'fixture'}}:{ok:true,job:null};
    return info;
  });t.after(()=>env.close());
  const page=env.page();await page.flush();button(page.tree,'检索模型').props.onClick();await page.flush();
  const picker=env.component(component(page.tree,'ModelPicker'));await picker.flush();
  const preparation=env.component(component(picker.tree,'ModelPreparation'));await preparation.flush();
  await button(preparation.tree,'下载并启用').props.onClick();await preparation.flush();
  assert.equal(writes(env).length,1);const call=writes(env)[0];
  assert.equal(call.path,BASE+'/model-install');assert.equal(call.body.action,'start');assert.equal(call.body.allowDownload,true);
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

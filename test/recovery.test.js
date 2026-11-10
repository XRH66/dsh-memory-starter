import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../lib/index.js';
import { createRecoveryStore, jobId, mergePending, observeLocalFacts } from '../lib/recovery.js';
import { applyMemoryActions } from '../lib/memory.js';
import { memoryCall } from '../lib/navigation.js';
import { resolveConfig } from '../lib/config.js';
import { createSessionMemory } from '../lib/session-memory.js';
import { createMemoryWorker } from '../lib/worker.js';
import { memoryStore } from './fake-memory.js';
import { directUser, fakeAgent, fakeLlm, TARGET_SESSION } from './helpers.js';

const action = (value, attribute='饮茶偏好') => ({action:'ADD',kind:'fact',category:'preference',subject:'用户',attribute,value,evidence:value,occurredAt:'日期未明'});
async function setup(t, llm, transform) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-recovery-'));
  const vaultPath = path.join(root,'vault'); await fs.mkdir(vaultPath);
  const memory = memoryStore();
  const tools = transform ? transform(memory.tools) : memory.tools;
  const config = resolveConfig({vaultPath,autoRecall:false,personalRecall:false,maxIndexNotes:0});
  const bridges=[];
  const make=(model=llm, findAgent) => { const b=createBridge({config,tools,llm:model,findAgent});bridges.push(b);return b; };
  t.after(async()=>{for(const b of bridges){await b.dispose();await b.getMemoryStatus(TARGET_SESSION);}assert.ok(root.startsWith(path.join(os.tmpdir(),'dafeiyu-recovery-')));await fs.rm(root,{recursive:true,force:true});});
  return {root,config,memory,tools,make,bridge:make()};
}
test('an old failed action cannot overwrite a newer statement, and correction replay creates only one history',async(t)=>{
  const f=await setup(t,fakeLlm(''));
  const ctx={config:f.config,project:'personal',tools:f.tools,agent:fakeAgent(TARGET_SESSION)};
  const first={sessionId:TARGET_SESSION,turn:1,messageId:'a',sourceEventTime:1000000,operationId:'first'};
  await applyMemoryActions(ctx,[action('喝温茶')],first);
  const next={...first,turn:3,messageId:'c',sourceEventTime:3000000,operationId:'newest'};
  await applyMemoryActions(ctx,[action('现在喝花茶')],next);
  const count=f.memory.notes.size;
  const old=await applyMemoryActions(ctx,[action('曾经喝咖啡')],{...first,turn:2,messageId:'b',sourceEventTime:2000000,operationId:'delayed'});
  assert.equal(old.results[0].skipped,'superseded');
  await applyMemoryActions(ctx,[action('现在喝花茶')],next);
  assert.equal(f.memory.notes.size,count);
  const current=[...f.memory.notes.values()].find(n=>n.frontmatter.memory_kind==='fact');
  assert.match(current.content,/现在喝花茶/);
  assert.doesNotMatch(current.content,/曾经喝咖啡/);
});

test('manual edits detected across restart queue a correction; first baseline and metadata-only edits do not',async(t)=>{
  const f=await setup(t,fakeLlm(''));
  const folder=path.join(f.config.vaultPath,'chats','facts');await fs.mkdir(folder,{recursive:true});
  const file=path.join(folder,'用户 - 饮茶偏好.md');
  const content='---\npermalink: personal/chats/facts/用户-饮茶偏好\nstatus: active\n---\n<!-- dsh-fact-memory -->\n# 用户 - 饮茶偏好\n- [preference] 喝温茶\n';
  await fs.writeFile(file,content);
  const store=createRecoveryStore(f.config);
  await observeLocalFacts(f.config,store);
  assert.equal((await store.read()).pending.length,0);
  await fs.writeFile(file,content.replace('喝温茶','喝花茶'));
  const restored=createRecoveryStore(f.config);
  await observeLocalFacts(f.config,restored);
  const state=await restored.read();
  assert.equal(state.pending.length,1);
  assert.equal(state.pending[0].expectedValue,'喝花茶');
  assert.ok(state.observed[state.pending[0].permalink].externalEditedAt>0);
  await restored.update(s=>{s.pending=[];});
  await fs.appendFile(file,'\n手写的一句无关备注');
  await observeLocalFacts(f.config,restored);
  assert.equal((await restored.read()).pending.length,0);
});

test('failed durable checkpoint does not update the cache; retry can persist it',async(t)=>{
  const f=await setup(t,fakeLlm(''));
  const store=createRecoveryStore(f.config);
  await store.add({id:'original'});
  const dir=path.join(f.root,'management','memory-status');
  const file=path.join(dir,'recovery.json');
  const saved=await fs.readFile(file,'utf8');await fs.rm(file);await fs.mkdir(file);
  await assert.rejects(store.add({id:'new'}));
  assert.deepEqual((await store.read()).jobs.map(j=>j.id),['original']);
  await fs.rmdir(file);await fs.writeFile(file,saved);
  await store.add({id:'new'});
  assert.equal(JSON.parse(await fs.readFile(file,'utf8')).jobs.length,2);
});

async function portableRecovery(t) {
  const llm = fakeLlm(new Error('explicit recovery cannot generate'));
  const f = await setup(t, llm);
  const agent = fakeAgent(TARGET_SESSION);
  const events = [];
  Object.defineProperty(agent.session, 'seq', { get: () => events.length });
  agent.session.snapshotEvents = (from, to) => events.slice(from, to);
  const agents = { get: id => id === TARGET_SESSION ? agent : undefined, list: () => [agent], isOwnedBy: () => false };
  const openAccess = () => createSessionMemory({ directory: f.root, ownerSubject: '用户', agents, sessions: { get: id => agents.get(id)?.session } });
  let access = await openAccess();
  await access.set(TARGET_SESSION, true);
  t.after(() => access.close());
  const append = (type, data) => {
    const event = { type, data, seq: events.length, time: Date.now(), ...(type === 'user/message' ? { surfaceOp: 'append' } : {}) };
    events.push(event);
    assert.equal(access.observe(agent.session, event), true);
    return event;
  };
  const job = (turn, userText, fields = {}) => {
    append('turn/start', { turn });
    const event = append('user/message', directUser(userText, `legacy-${turn}`));
    const source = { sessionId: TARGET_SESSION, messageId: event.data.id, sequence: event.seq, turn, rootTurn: turn, role: 'user' };
    const memoryAuthorization = JSON.parse(JSON.stringify(access.grant(agent, source)));
    append('turn/end', { turn, reason: { kind: 'completed' } });
    return { id: jobId(TARGET_SESSION, turn), sessionId: TARGET_SESSION, turn, sourceMessageId: source.messageId,
      sourceEventSeq: source.sequence, sourceEventTime: event.time, userText, memoryAuthorization,
      target: { provider: 'old-provider', model: 'old-model' }, historyPolicy: 'user-only', completed: {}, ...fields };
  };
  const worker = (tools = f.tools, findAgent = agents.get) => {
    const store = createRecoveryStore(f.config);
    const w = createMemoryWorker({ config: f.config, tools, llm, access, findAgent, recoveryStore: store,
      canProcess: () => false, available: () => false, status: { set: async () => {}, pending: async () => {}, usage: async () => {} } });
    t.after(() => w.dispose());
    return w;
  };
  return { ...f, agent, llm, job, worker, get access() { return access; }, async restart() { access.close(); access = await openAccess(); } };
}

for (const suspended of [false, true]) {
  test(`explicit portable recovery continues a ${suspended ? 'suspended' : 'current'} prepared maintenance plan without replanning`, async t => {
    const f = await portableRecovery(t);
    const owner = f.job(1, '晚上常喝温茶');
    const ctx = { config: f.config, agent: f.agent, tools: f.tools };
    const fact = await memoryCall(ctx, 'write_note', { title: '饮茶', directory: 'chats/facts',
      content: '<!-- dsh-fact-memory -->\n# 饮茶\n- [fact] 晚上常喝温茶\n', tags: ['dsh-memory'], metadata: { memory_id: 'tea', status: 'active' } });
    const index = await memoryCall(ctx, 'write_note', { title: '日常', directory: 'index', content: '# 日常\n\n手写说明。\n', tags: ['index'] });
    const store = createRecoveryStore(f.config);
    await store.update(state => {
      mergePending(state, { ...owner, permalink: fact.permalink, action: 'ADD' });
      const change = state.pending[0];
      const plan = { key: change.revision, changes: [change], bundle: {
        at: new Date().toISOString(), sources: { [fact.permalink]: fact.checksum }, entries: [],
        plan: { assignments: [{ fact: fact.permalink, index: index.permalink }], creations: [], removals: [], headings: [], profile: [] },
      } };
      if (suspended) state.suspendedIndexMaintenance = [plan];
      else state.indexMaintenance = plan;
      mergePending(state, { ...owner, permalink: 'personal/chats/facts/unprepared' });
    });
    const [prepared, unprepared] = (await store.read()).pending;
    let writes = 0;
    const tools = { ...f.tools, get(name, agent) {
      const tool = f.tools.get(name, agent);
      return { ...tool, async execute(args, exec) {
        const response = await tool.execute(args, exec);
        if (name.endsWith('__edit_note') && ++writes === 1) throw new Error('lost maintenance response');
        return response;
      } };
    } };
    let worker = f.worker(tools);
    f.memory.notes.get(fact.permalink).checksum = 'changed';
    assert.deepEqual((await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION })).held, [
      { kind: 'maintenance', id: prepared.revision, reason: 'legacy-maintenance-source-changed' },
      { kind: 'maintenance', id: unprepared.revision, reason: 'legacy-maintenance-unprepared' },
    ]);
    assert.equal(writes, 0);
    f.memory.notes.get(fact.permalink).checksum = fact.checksum;
    assert.equal((await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION })).held[0].reason, 'legacy-maintenance-effect-unconfirmed');
    assert.equal(writes, 1);
    await worker.dispose();
    await f.restart();
    worker = f.worker(tools);
    const result = await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION });
    assert.deepEqual(result.resumed, [{ kind: 'maintenance', id: prepared.revision }]);
    assert.deepEqual(result.held, [{ kind: 'maintenance', id: unprepared.revision, reason: 'legacy-maintenance-unprepared' }]);
    assert.equal(writes, 1);
    assert.match(f.memory.notes.get(index.permalink).content, /手写说明/);
    assert.equal(f.llm.calls.length, 0);
    const after = await worker.store.read();
    assert.equal(after.indexMaintenance, undefined);
    assert.equal(after.suspendedIndexMaintenance, undefined);
    assert.deepEqual(after.pending.map(item => item.revision), [unprepared.revision]);
  });
}

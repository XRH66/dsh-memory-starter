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
import { directUser, fakeAgent, fakeLlm, runPreStep, turnStart, userMessage, assistantMessage, turnEnd, TARGET_SESSION, OTHER_SESSION } from './helpers.js';

const action = (value, attribute='饮茶偏好') => ({action:'ADD',kind:'fact',category:'preference',subject:'用户',attribute,value,evidence:value,occurredAt:'日期未明'});
const reply = (...actions) => JSON.stringify({actions});
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
async function turn(bridge, n, text, time=Date.now(), id=TARGET_SESSION) {
  const agent=fakeAgent(id);
  bridge.onSessionEvent(agent.session,turnStart(n));
  bridge.onSessionEvent(agent.session,userMessage(text,{id:'message-'+n,time}));
  await runPreStep(bridge,{agent,turn:n,messages:[]});
  bridge.onSessionEvent(agent.session,assistantMessage(n,'嗯，知道了。'));
  bridge.onSessionEvent(agent.session,turnEnd(n));
  await bridge.waitForIdle(id);
  return agent;
}

test('timer retries a failed model call without another user turn; payload is removed on success',async(t)=>{
  t.mock.timers.enable({apis:['setInterval','Date']});
  const llm=fakeLlm([new Error('offline'),reply(action('晚上常喝温茶'))]);
  const {bridge,memory}=await setup(t,llm);
  await turn(bridge,1,'晚上常喝温茶');
  assert.equal((await bridge.getRecoveryState()).jobs.length,1);
  assert.equal((await bridge.getMemoryStatus(TARGET_SESSION)).jobs[0].state,'failed');
  t.mock.timers.tick(31_000);
  await bridge.waitForIdle();
  assert.equal((await bridge.getRecoveryState()).jobs.length,0);
  assert.equal(memory.notes.size,1);
  assert.equal(llm.calls.length,2);
  assert.equal((await bridge.getMemoryStatus(TARGET_SESSION)).jobs[0].state,'saved');
});

test('partial write survives worker restart and resumes only the unfinished action',async(t)=>{
  let fail=true;
  const llm=fakeLlm(reply(action('晚上常喝温茶'),action('周日去拍照','周末安排')));
  const fixture=await setup(t,llm,(base)=>({get(name,agent){const d=base.get(name,agent);return {...d,async execute(args,exec){
    if(name.endsWith('__write_note')&&args.content.includes('周日去拍照')&&fail)throw new Error('disk temporary failure');
    return d.execute(args,exec);
  }};}}));
  await turn(fixture.bridge,1,'晚上常喝温茶，周日去拍照');
  const pending=await fixture.bridge.getRecoveryState();
  assert.equal(Object.keys(pending.jobs[0].completed).length,1);
  fixture.bridge.dispose();fail=false;
  const model=fakeLlm(new Error('must not synthesize saved actions again'));
  const resumed=fixture.make(model,()=>fakeAgent(TARGET_SESSION));
  await resumed.retryPending({force:true});
  assert.equal((await resumed.getRecoveryState()).jobs.length,0);
  assert.equal(fixture.memory.notes.size,2);
  assert.equal(model.calls.length,0);
});

test('write committed but response lost: replay uses the operation marker instead of duplicating',async(t)=>{
  let lose=true;
  const fixture=await setup(t,fakeLlm(reply(action('晚上常喝温茶'))),(base)=>({get(name,agent){const d=base.get(name,agent);return {...d,async execute(args,exec){
    const r=await d.execute(args,exec);
    if(name.endsWith('__write_note')&&lose){lose=false;throw new Error('connection lost after commit');}return r;
  }};}}));
  await turn(fixture.bridge,1,'晚上常喝温茶');
  assert.equal((await fixture.bridge.getRecoveryState()).jobs.length,1);
  fixture.bridge.dispose();
  const resumed=fixture.make(fakeLlm(new Error('no new extraction')),()=>fakeAgent(OTHER_SESSION));
  await resumed.retryPending({force:true});
  assert.equal(fixture.memory.notes.size,1);
  assert.equal((await resumed.getRecoveryState()).jobs.length,0);
});

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

test('group observation baselines member facts separately and queues verified external edits across restart',async t=>{
 const f=await setup(t,fakeLlm('')),folder=path.join(f.config.vaultPath,'members','710000001','facts');await fs.mkdir(folder,{recursive:true});const file=path.join(folder,'偏好.md'),body='---\npermalink: personal/members/710000001/facts/偏好\nmemory_id: fixture-id\nsubject: qq:710000001\nstatus: active\n---\n<!-- dsh-fact-memory -->\n# 偏好\n- [preference] 喜欢竹笛\n';await fs.writeFile(file,body);
 const store=createRecoveryStore(f.config);await store.add({id:'fixture',sessionId:'qqb-g-720000001',turn:1});await store.finish('fixture');await store.update(s=>{s.initialized=true;});await observeLocalFacts(f.config,store,{scope:'group'});let state=await store.read();assert.equal(state.pending.length,0);assert.equal(state.groupObservationInitialized,true);assert.equal(Object.keys(state.observed).length,0);
 await fs.writeFile(file,body.replace('喜欢竹笛','喜欢古筝'));const restored=createRecoveryStore(f.config);await observeLocalFacts(f.config,restored,{scope:'group'});state=await restored.read();assert.equal(state.pending.length,1);assert.equal(state.pending[0].expectedValue,'喜欢古筝');assert.equal(state.pending[0].owners[0].sessionId,'qqb-g-720000001');assert.ok(state.groupObserved[state.pending[0].permalink].externalEditedAt>0);
 const heldRevision=state.pending[0].revision;await fs.writeFile(file,body.replace('喜欢竹笛','喜欢口琴'));await observeLocalFacts(f.config,restored,{scope:'group',protectedPending:p=>p.revision===heldRevision});state=await restored.read();assert.equal(state.pending.length,2);assert.equal(state.pending.find(p=>p.revision===heldRevision).expectedValue,'喜欢古筝');assert.ok(state.pending.some(p=>p.revision!==heldRevision&&p.expectedValue==='喜欢口琴'));
 await restored.update(s=>{s.pending=[];});await fs.appendFile(file,'\n无关备注');await observeLocalFacts(f.config,restored,{scope:'group'});assert.equal((await restored.read()).pending.length,0);
 await fs.writeFile(file,body.replace('qq:710000001','qq:710000003'));await assert.rejects(observeLocalFacts(f.config,restored,{scope:'group'}),/GROUP_SCOPE_MISMATCH/);assert.equal((await restored.read()).pending.length,0);
});

test('new changes do not replace a held group synchronization revision for the same fact',async t=>{
 const f=await setup(t,fakeLlm('')),store=createRecoveryStore(f.config,{protectedPending:item=>item.revision==='held-revision'}),permalink='personal/members/710000001/facts/偏好';
 await store.update(s=>{s.pending.push({permalink,revision:'held-revision',owners:[{sessionId:'qqb-g-720000001',turn:1}],attempts:2,expectedValue:'旧值'});});await store.add({id:'new',sessionId:'qqb-g-720000001',turn:2});await store.checkpoint('new',0,{permalink,action:'UPDATE',expectedValue:'新值'});let state=await store.read();assert.equal(state.pending.length,2);assert.equal(state.pending.find(x=>x.revision==='held-revision').expectedValue,'旧值');assert.equal(state.pending.find(x=>x.revision==='held-revision').attempts,2);assert.ok(state.pending.some(x=>x.revision!=='held-revision'&&x.expectedValue==='新值'));
});

test('group observation rejects a linked member directory instead of reading another scope',async t=>{
 const f=await setup(t,fakeLlm('')),outside=path.join(f.root,'outside'),members=path.join(f.config.vaultPath,'members');await fs.mkdir(outside,{recursive:true});await fs.mkdir(f.config.vaultPath,{recursive:true});await fs.symlink(outside,members,process.platform==='win32'?'junction':'dir');const store=createRecoveryStore(f.config);await assert.rejects(observeLocalFacts(f.config,store,{scope:'group'}),/GROUP_OBSERVATION_INVALID_PATH/);const state=await store.read();assert.equal(state.pending.length,0);assert.notEqual(state.groupObservationInitialized,true);
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

test('a new completed turn is durable while an older extraction is still blocked',async(t)=>{
  let entered,release;
  const started=new Promise(r=>{entered=r;}), gate=new Promise(r=>{release=r;});
  let first=true;
  const llm={async *stream(){if(first){first=false;entered();await gate;}yield {type:'text-delta',text:'{"actions":[]}'};}};
  const f=await setup(t,llm);
  const one=turn(f.bridge,1,'随便聊聊');
  await started;
  const two=turn(f.bridge,2,'今天歇一会儿',Date.now(),OTHER_SESSION);
  // Give accept's async filesystem commit time, without releasing the model call.
  let jobs=[];
  for(let i=0;i<20;i++){jobs=(await f.bridge.getRecoveryState()).jobs;if(jobs.length===2)break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(jobs.length,2);
  const disk=JSON.parse(await fs.readFile(path.join(f.root,'management','memory-status','recovery.json'),'utf8'));
  assert.equal(disk.jobs.length,2);
  release();await Promise.all([one,two]);
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

test('explicit portable recovery uses the original credential and only commits unfinished saved actions', async t => {
  const f = await portableRecovery(t);
  const first = action('晚上常喝温茶'), second = action('周日去拍照', '周末安排');
  const job = f.job(1, '晚上常喝温茶，周日去拍照', { actions: [first, second] });
  const ctx = { config: f.config, project: f.config.project, tools: f.tools, agent: f.agent };
  const initial = await applyMemoryActions(ctx, [first], { sessionId: job.sessionId, turn: job.turn, messageId: job.sourceMessageId,
    eventSeq: job.sourceEventSeq, sourceEventTime: job.sourceEventTime, operationId: job.id });
  job.completed[0] = initial.results[0];
  const original = f.memory.notes.get(initial.results[0].permalink).checksum;
  const store = createRecoveryStore(f.config);
  await store.add(job);
  const unprepared = f.job(2, '周一去散步');
  await store.add(unprepared);
  await store.add(f.job(3, '周二去散步', { actions: [action('周二去散步')], target: { provider: 'old-provider' } }));
  await store.add(f.job(4, '周三去散步', { actions: [action('周三去散步')], completed: { 2: { skipped: 'superseded' } } }));
  await store.add({ ...job, id: 'other-session-job', sessionId: OTHER_SESSION });
  await f.restart();
  f.access.grant = () => assert.fail('recovery must use the saved grant');
  const worker = f.worker();
  await worker.wake({ force: true, resumeSessionId: TARGET_SESSION });
  assert.equal((await worker.store.read()).jobs.length, 5);
  const result = await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION });
  assert.deepEqual(result.resumed, [{ kind: 'job', id: job.id }]);
  assert.deepEqual(result.held.map(({ reason }) => reason).sort(), [
    'legacy-action-checkpoint-unproven', 'legacy-actions-unprepared', 'legacy-target-unproven',
  ]);
  assert.equal(f.memory.notes.size, 2);
  assert.equal(f.memory.notes.get(initial.results[0].permalink).checksum, original);
  assert.equal(f.llm.calls.length, 0);
  assert.deepEqual((await worker.store.read()).jobs.map(saved => saved.id).sort(), [unprepared.id, jobId(TARGET_SESSION, 3), jobId(TARGET_SESSION, 4), 'other-session-job'].sort());
});

test('explicit portable recovery holds unknown outcomes and will not renew an old credential', async t => {
  const f = await portableRecovery(t);
  const job = f.job(1, '晚上常喝温茶', { actions: [action('晚上常喝温茶')] });
  const store = createRecoveryStore(f.config);
  await store.add(job);
  let lose = true, writes = 0;
  const tools = { get(name, agent) {
    const tool = f.tools.get(name, agent);
    return { ...tool, async execute(args, exec) {
      const response = await tool.execute(args, exec);
      if (name.endsWith('__write_note')) {
        writes++;
        if (lose) { lose = false; throw new Error('reply lost after commit'); }
      }
      return response;
    } };
  } };
  let worker = f.worker(tools, () => fakeAgent(OTHER_SESSION));
  assert.equal((await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION })).held[0].reason, 'legacy-session-unavailable');
  assert.equal(writes, 0);
  await worker.dispose();
  worker = f.worker(tools);
  assert.equal((await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION })).held[0].reason, 'legacy-commit-unconfirmed');
  assert.equal((await worker.store.read()).jobs.length, 1);
  assert.equal(writes, 1);
  await worker.dispose();
  await f.restart();
  worker = f.worker(tools);
  assert.deepEqual((await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION })).resumed, [{ kind: 'job', id: job.id }]);
  assert.equal(writes, 1);

  const revoked = f.job(2, '周日去拍照', { actions: [action('周日去拍照')] });
  await worker.store.add(revoked);
  await f.access.set(TARGET_SESSION, false);
  await f.access.set(TARGET_SESSION, true);
  f.job(3, '新的一轮');
  assert.equal((await worker.resumeLegacyRecovery({ sessionId: TARGET_SESSION })).held.find(item => item.id === revoked.id).reason, 'memory-authorization-unproven');
  assert.equal((await worker.store.read()).jobs.length, 1);
  assert.equal(writes, 1);
  assert.equal(f.llm.calls.length, 0);
});

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
    const tools = { get(name, agent) {
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

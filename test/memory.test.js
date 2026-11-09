import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { applyMemoryActions, createSoftenTool, loadCaptureCandidates, MEMORY_MARKER, MemoryError, softenMemory } from '../lib/memory.js';
import { fakeAgent } from './helpers.js';
import { memoryStore, makeVault } from './fake-memory.js';

const SESSION = 'session-memory-test';
const NOW = () => new Date('2026-10-24T04:00:00.000Z');

test('successful factual downweight synchronizes exact raw source identities',async()=>{
  const store=memoryStore(),vault=await makeVault();
  try{
    const ctx=context(store,vault);
    await applyMemoryActions(ctx,[{action:'ADD',kind:'fact',subject:'用户',attribute:'饮品',value:'不加糖',evidence:'不加糖'}],opts(0));
    const note=[...store.notes.values()][0],seen=[];
    ctx.onSourcesSoftened=async input=>{seen.push(input);return {affected:1};};
    const result=await softenMemory(ctx,{memoryId:note.frontmatter.memory_id,reason:'少提'});
    assert.equal(result.ok,true);assert.equal(seen.length,1);assert(seen[0].sources.length>0);assert.equal(seen[0].weight,0.5);
    assert.match(result.summary,/同步降低相同来源/);
  }finally{assert.equal(path.dirname(vault),path.resolve(os.tmpdir()));assert(path.basename(vault).startsWith('dafeiyu-memory-'));await fs.rm(vault,{recursive:true,force:true});}
});

function context(store, vault, tools = store.tools) {
  return {
    tools,
    agent: fakeAgent(SESSION),
    project: 'personal',
    config: { project: 'personal', captureFolder: 'chats', vaultPath: vault },
    now: NOW,
    logger: { warn() {} },
  };
}

function factAction(overrides = {}) {
  return {
    action: 'ADD',
    kind: 'fact',
    category: 'preference',
    title: '饮品偏好 - 甜度',
    subject: '饮品偏好',
    attribute: '甜度',
    value: '不加糖',
    evidence: '不加糖',
    ...overrides,
  };
}

test('a later failed write reports the earlier committed memory instead of losing it', async () => {
  const store=memoryStore();
  let writes=0;
  const tools={...store.tools,get(name,agent){
    const def=store.tools.get(name,agent);
    if(name!=='mcp__basic_memory__write_note') return def;
    return {...def,async execute(args,exec){
      if(++writes===2) throw new Error('disk unavailable');
      return def.execute(args,exec);
    }};
  }};
  const result=await applyMemoryActions(context(store,'',tools),[
    factAction(),factAction({title:'阅读习惯',subject:'用户',attribute:'阅读习惯',value:'睡前看书',evidence:'睡前看书'}),
  ],opts());
  assert.equal(result.partial,true);
  assert.equal(result.reason,'partial-write');
  assert.equal(result.results.length,1);
  assert.ok(result.results[0].permalink);
  assert.equal(store.notes.size,1);
});

function opts(epoch = 0, overrides = {}) {
  return { sessionId: SESSION, turn: 3, messageId: 'msg-1', eventSeq: 11, epoch, now: NOW, sourceEventTime: Date.parse('2026-10-24T04:00:00.000Z'), ...overrides };
}

function yamlValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

/**
 * Basic Memory's real read_note returns the whole Markdown file including YAML
 * frontmatter. The fake normally returns only the body, so this wrapper puts
 * the current frontmatter back exactly as production does.
 */
function withYamlFrontmatter(store, { changeBodyOnEdit = false } = {}) {
  const base = store.tools;
  const findNote = (identifier) => {
    const raw = String(identifier ?? '');
    return store.notes.get(raw)
      || store.notes.get(raw.replace(/^personal\//, ''))
      || [...store.notes.values()].find((note) => note.permalink === raw);
  };
  return {
    ...base,
    get(name, agent) {
      const definition = base.get(name, agent);
      if (!definition) return definition;
      if (name === 'mcp__basic_memory__read_note') {
        return {
          ...definition,
          async execute(args, exec) {
            const payload = await definition.execute(args, exec);
            const note = findNote(payload?.permalink ?? args?.identifier);
            if (!note) return payload;
            const yaml = Object.entries(note.frontmatter ?? {})
              .filter(([, value]) => value !== undefined)
              .map(([key, value]) => key + ': ' + yamlValue(value))
              .join('\n');
            return { ...payload, content: '---\n' + yaml + '\n---\n' + String(note.content ?? '') };
          },
        };
      }
      if (changeBodyOnEdit && name === 'mcp__basic_memory__edit_note') {
        return {
          ...definition,
          async execute(args, exec) {
            const payload = await definition.execute(args, exec);
            const note = findNote(payload?.permalink ?? args?.identifier);
            if (note) note.content += '\n\n## 外部改动\n\n这段变化不是 metadata。\n';
            return payload;
          },
        };
      }
      return definition;
    },
  };
}

test('body text wins over stale frontmatter and user paragraphs survive an update', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    const added = await applyMemoryActions(ctx, [factAction()], opts(0));
    assert.equal(added.committed, true);
    const note = [...store.notes.values()][0];
    assert.ok(note);
    assert.equal(note.content.includes(MEMORY_MARKER), true);

    // A person edits the managed value in Obsidian and adds their own paragraph,
    // while the old frontmatter cache still says 加糖.
    note.content = note.content.replace('- [preference] 不加糖', '- [preference] 完全不加糖');
    note.content += '\n\n## 手工补充\n\n记得问白茶。\n';
    note.frontmatter.value = '加糖';
    note.frontmatter.memory_type = 'preference';
    note.frontmatter.state_validity = 'current';
    note.frontmatter.state_progress = '';
    note.frontmatter.importance = JSON.stringify({level:'high',basis:'user_explicit',reason:'用户明确表达'});
    note.frontmatter.obsidian_custom = '保留手工元数据';

    const loaded = await loadCaptureCandidates(ctx, '不加糖');
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].value, '完全不加糖');
    assert.equal(loaded[0].entry.content, '完全不加糖');
    assert.equal(loaded[0].entry.type, 'preference');
    assert.equal(loaded[0].entry.importance.level, 'high');

    const updated = await applyMemoryActions(ctx, [factAction({
      action: 'UPDATE',
      targetMemoryId: loaded[0].memoryId,
      value: '无糖',
      evidence: '无糖',
      effectiveDate: '2026-10-24',
    })], opts(0, { turn: 4 }));
    assert.equal(updated.committed, true);
    assert.match(note.content, /- \[preference\] 无糖/);
    assert.match(note.content, /## 手工补充/);
    assert.match(note.content, /记得问白茶/);
    assert.equal(note.frontmatter.obsidian_custom, '保留手工元数据');
    assert.equal(note.frontmatter.memory_type, 'preference');
    assert.equal(JSON.parse(note.frontmatter.importance).level, 'high');

    const history = [...store.notes.values()].find((item) => item.permalink.includes('/history/'));
    assert.ok(history);
    assert.equal(history.frontmatter.status, 'history');
    assert.equal(history.frontmatter.state_validity, 'historical');
    assert.match(history.content, /## 完整旧版/);
    assert.match(history.content, /完全不加糖/);
    assert.match(history.content, /记得问白茶/);
    assert.match(history.content, /- valid_until: 2026-10-24/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('facts show occurrence and record dates separately and keep the first record time on update', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [factAction({ occurredAt: '2026-10-20' })], opts(0));
    const note = [...store.notes.values()][0];
    assert.match(note.content, /- 发生日期: 2026-10-20/);
    assert.match(note.content, /- 记录日期: 2026-10-24 12:00/);
    assert.equal(note.frontmatter.recorded_at, '2026-10-24T04:00:00.000Z');

    const later = () => new Date('2026-10-25T04:00:00.000Z');
    await applyMemoryActions(ctx, [factAction({
      action: 'UPDATE', targetMemoryId: note.frontmatter.memory_id, value: '无糖', evidence: '无糖', effectiveDate: '2026-10-25',
    })], opts(0, { turn: 4, now: later }));
    assert.match(note.content, /- 记录日期: 2026-10-24 12:00/);
    const history = [...store.notes.values()].find((item) => item.permalink.includes('/history/'));
    assert.ok(history);
    assert.match(history.content, /- 记录日期: 2026-10-25 12:00/);
    assert.match(history.content, /- 发生日期: 2026-10-20/);

    await applyMemoryActions(ctx, [factAction({
      subject: '旅行计划', attribute: '月份', title: '旅行计划 - 月份', value: '十月', evidence: '十月', occurredAt: '2026-10',
    })], opts(0, { turn: 5 }));
    const monthNote = [...store.notes.values()].find((item) => item.frontmatter.subject === '旅行计划');
    assert.ok(monthNote);
    assert.match(monthNote.content, /- 发生日期: 2026-10/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('corrections keep a revoked old copy instead of rewriting history', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [factAction({ value: '杭州', subject: '居住地', attribute: '城市', title: '居住地 - 城市', evidence: '杭州' })], opts(0));
    const note = [...store.notes.values()][0];
    const corrected = await applyMemoryActions(ctx, [factAction({
      action: 'CORRECT', targetMemoryId: note.frontmatter.memory_id, value: '苏州', subject: '居住地', attribute: '城市', title: '居住地 - 城市', evidence: '苏州',
    })], opts(0, { turn: 4 }));
    assert.equal(corrected.committed, true);
    const history = [...store.notes.values()].find((item) => item.permalink.includes('/history/'));
    assert.equal(history.frontmatter.status, 'revoked');
    assert.match(history.content, /已撤销\/错误，仅供审阅/);
    assert.equal(history.frontmatter.supersedes_memory_id, note.frontmatter.memory_id);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('impossible calendar dates are rejected before any write', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await assert.rejects(
      () => applyMemoryActions(ctx, [{
        action: 'ADD', kind: 'event', value: '交付在 2 月 30 日', eventSummary: '交付', occurredAt: '2026-02-30', evidence: '2 月 30 日',
      }], opts(0)),
      (error) => error instanceof MemoryError && error.code === 'INVALID_DATE',
    );
    assert.equal(store.notes.size, 0);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('a new value for the same subject and attribute updates the existing note and keeps its soft priority', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [factAction()], opts(0));
    const note = [...store.notes.values()][0];
    note.frontmatter.base_priority = 0.5;
    note.frontmatter.softened_at = '2026-09-24T04:00:00.000Z';
    note.frontmatter.soften_count = 1;

    const changed = await applyMemoryActions(ctx, [factAction({ value: '半糖', evidence: '半糖' })], opts(0, { turn: 4, messageId: 'msg-2', eventSeq: 12 }));
    assert.equal(changed.results[0].updatedExisting, true);
    assert.equal([...store.notes.values()].filter((item) => item.permalink.includes('/facts/')).length, 1);
    assert.match(note.content, /- \[preference\] 半糖/);
    assert.equal(note.frontmatter.base_priority, 0.5);
    assert.equal(note.frontmatter.softened_at, '2026-09-24T04:00:00.000Z');

    const history = [...store.notes.values()].find((item) => item.permalink.includes('/history/'));
    assert.ok(history);
    assert.match(history.content, /不加糖/);
    assert.equal(history.frontmatter.valid_from, undefined);
    assert.equal(history.frontmatter.valid_until, undefined);

    const sources = JSON.parse(note.frontmatter.sources);
    assert.deepEqual(sources.map((item) => item.event_seq), [11, 12]);
    assert.equal(sources[1].message_id, 'msg-2');
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('a fuzzy soften query only lists candidates; only an exact id changes priority', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [factAction()], opts(0));
    const note = [...store.notes.values()][0];
    const before = { checksum: note.checksum, content: note.content };

    const fuzzy = await softenMemory(ctx, { query: '不加糖', reason: '少提' });
    assert.equal(fuzzy.ok, false);
    assert.equal(fuzzy.errorCode, 'NEEDS_SELECTION');
    assert.equal(fuzzy.candidates.length, 1);
    assert.equal(note.checksum, before.checksum);
    assert.equal(note.content, before.content);

    const applied = await softenMemory(ctx, { memoryId: note.frontmatter.memory_id, reason: '少提' });
    assert.equal(applied.ok, true);
    assert.equal(applied.bodyUnchanged, true);
    assert.equal(applied.basePriority, 0.5);
    assert.equal(note.content, before.content);
    assert.equal(note.frontmatter.base_priority, 0.5);
    assert.ok(note.frontmatter.softened_at);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

function structuredSoftenFixture() {
  const store = memoryStore();
  const id = 'fixture-structured-plan';
  const note = {
    title: 'QA 书架计划', permalink: 'personal/chats/entries/qa-books', directory: 'chats/entries',
    checksum: 'fixture-original-checksum', tags: ['fixture'],
    content: '# QA 书架计划\n\n<!-- dsh-memory-entry:start -->\n整理书架。\n<!-- dsh-memory-entry:end -->\n\n人工附注 ![[fixture.jpg]]\n',
    frontmatter: {
      memory_entry_schema: 'memory-entry-v1', memory_entry_id: id, memory_type: 'plan',
      state_validity: 'current', state_progress: 'planned',
      importance: JSON.stringify({ level: 'high', basis: 'user_explicit', reason: '虚构用户明确说明' }),
      memory_source_refs: JSON.stringify([{ id: 'fixture-source', revision: 2, role: 'user' }]),
      memory_body_operation_id: 'fixture-operation', manual_field: '手动元数据',
    },
  };
  store.notes.set(note.permalink, note);
  const entry = () => ({
    id, permalink: note.permalink, revision: note.checksum, type: 'plan',
    state: { validity: 'current', progress: 'planned' }, sourceStatus: { eligible: true },
  });
  const ctx = { ...context(store), resolveStructuredEntry: lookup => lookup === id ? entry() : null };
  return { store, note, ctx, entry, id };
}

test('native soften accepts a structured ID or exact permalink and writes only its priority metadata', async t => {
  for (const selector of ['memoryId', 'identifier']) {
    await t.test(selector, async () => {
      const { store, note, ctx, entry, id } = structuredSoftenFixture();
      Object.assign(note.frontmatter, { base_priority: 0.8, softened_at: '2026-09-24T04:00:00.000Z', soften_count: 1 });
      const before = structuredClone(note);
      const other = { ...structuredClone(note), permalink: 'personal/chats/entries/other', frontmatter: { memory_entry_id: 'other-id' } };
      store.notes.set(other.permalink, other);
      const otherBefore = structuredClone(other);
      const seen = [], softened = [], raw = [];
      const signal = new AbortController().signal;
      const tool = createSoftenTool({
        ...ctx, tools: withYamlFrontmatter(store),
        resolveStructuredEntry(lookup, execution) { seen.push({ lookup, ...execution }); return entry(); },
        onSoftened: (...args) => softened.push(args), onSourcesSoftened: value => raw.push(value),
      });
      const result = await tool.execute({ [selector]: selector === 'memoryId' ? id : note.permalink, reason: '少提' }, { agent: ctx.agent, signal });
      assert.equal(result.ok, true, result.summary);
      assert.equal(result.kind, 'plan');
      assert.equal(result.memoryId, id);
      assert.equal(result.permalink, note.permalink);
      assert.equal(result.bodyUnchanged, true);
      assert.equal(result.basePriority, 0.282843);
      assert.equal(result.effectivePriority, 0.282843);
      assert.ok(seen.length && seen.every(call => call.lookup === id && call.agent === ctx.agent && call.signal === signal));
      assert.deepEqual(softened, [[SESSION, result]]);
      assert.deepEqual(raw, []);
      const edits = store.tools.calls.filter(call => call.name.endsWith('__edit_note'));
      assert.equal(edits.length, 1);
      const edit = edits[0].arguments;
      assert.equal(edit.identifier, note.permalink);
      assert.equal(edit.expected_checksum, before.checksum);
      assert.equal(edit.project, ctx.project);
      assert.equal(edit.operation, 'append');
      assert.equal(edit.content, '');
      assert.deepEqual(edit.metadata, {
        base_priority: 0.282843, softened_at: NOW().toISOString(), decay_anchor_at: NOW().toISOString(),
        half_life_days: 30, priority_floor: 0.01, soften_count: 2, soften_factor: 0.5, soften_reason: '少提',
      });
      assert.deepEqual(note.frontmatter, { ...before.frontmatter, ...edit.metadata });
      assert.equal(note.content, before.content);
      assert.deepEqual(store.notes.get(other.permalink), otherBefore);
    });
  }
});

test('structured soften rejects inexact, unscoped, historical or stale targets before editing', async t => {
  const cases = [
    ['title alias', ({ note }) => ({ identifier: note.title }), 'INVALID_TARGET'],
    ['fuzzy query', ({ note }) => ({ query: note.title }), 'TARGET_NOT_FOUND'],
    ['conflicting identifiers', ({ note }) => ({ identifier: note.permalink, memoryId: 'other-id' }), 'INVALID_TARGET'],
    ['outside scope', ({ ctx, note }) => { ctx.resolveStructuredEntry = () => null; return { identifier: note.permalink }; }, 'TARGET_NOT_FOUND'],
    ['resolver absent', ({ ctx, note }) => { delete ctx.resolveStructuredEntry; return { identifier: note.permalink }; }, 'TARGET_NOT_FOUND'],
    ['historical entry', ({ ctx, id, entry }) => {
      ctx.resolveStructuredEntry = () => ({ ...entry(), state: { validity: 'historical' } });
      return { memoryId: id };
    }, 'INACTIVE_TARGET'],
    ['stale version', ({ ctx, id, entry }) => {
      ctx.resolveStructuredEntry = () => ({ ...entry(), revision: 'old-checksum' });
      return { memoryId: id };
    }, 'STALE_REVISION'],
    ['missing checksum', ({ note, id }) => { note.checksum = ''; return { memoryId: id }; }, 'MISSING_CHECKSUM'],
    ['source revision revoked before write', ({ ctx, id, entry }) => {
      let reads = 0;
      ctx.resolveStructuredEntry = () => ({ ...entry(), sourceStatus: { eligible: ++reads === 1 } });
      return { memoryId: id };
    }, 'INVALID_TARGET'],
  ];
  for (const [label, setup, code] of cases) {
    await t.test(label, async () => {
      const fixture = structuredSoftenFixture();
      const args = setup(fixture);
      const before = structuredClone(fixture.note);
      const result = await softenMemory(fixture.ctx, args);
      assert.equal(result.ok, false);
      assert.equal(result.errorCode, code, result.summary);
      assert.equal(fixture.store.tools.calls.some(call => call.name.endsWith('__edit_note')), false);
      assert.deepEqual(fixture.note, before);
    });
  }
});

test('structured soften leaves a concurrent Markdown revision untouched', async () => {
  const { store, note, ctx, id } = structuredSoftenFixture();
  const frontmatter = structuredClone(note.frontmatter);
  const editedBody = note.content + '并发人工修改。\n';
  ctx.tools = { get(name, agent) {
    const definition = store.tools.get(name, agent);
    if (!name.endsWith('__edit_note')) return definition;
    return { ...definition, execute(args, exec) {
      note.content = editedBody;
      note.checksum = 'concurrent-checksum';
      return definition.execute(args, exec);
    } };
  } };
  const result = await softenMemory(ctx, { memoryId: id });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'STALE_REVISION');
  assert.equal(note.checksum, 'concurrent-checksum');
  assert.equal(note.content, editedBody);
  assert.deepEqual(note.frontmatter, frontmatter);
});

test('one whole personal note can be softened without touching its body or other notes', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    store.notes.set('personal/dafeiyu/thoughts/one', {
      title: 'One thought', permalink: 'personal/dafeiyu/thoughts/one', directory: 'dafeiyu/thoughts',
      content: '今天想少提这件事。', frontmatter: { status: 'active' }, tags: ['dafeiyu', 'subjective'],
      checksum: 'c1', updated: '2026-10-24T04:00:00.000Z',
    });
    store.notes.set('personal/dafeiyu/thoughts/two', {
      title: 'Other thought', permalink: 'personal/dafeiyu/thoughts/two', directory: 'dafeiyu/thoughts',
      content: '无关记录。', frontmatter: { status: 'active' }, tags: ['dafeiyu', 'subjective'],
      checksum: 'c2', updated: '2026-10-24T04:00:00.000Z',
    });
    const otherBefore = { ...store.notes.get('personal/dafeiyu/thoughts/two') };
    const result = await softenMemory(ctx, { identifier: 'personal/dafeiyu/thoughts/one', reason: '少提' });
    assert.equal(result.ok, true);
    assert.equal(result.kind, 'thoughts');
    assert.equal(store.notes.get('personal/dafeiyu/thoughts/one').content, '今天想少提这件事。');
    assert.equal(store.notes.get('personal/dafeiyu/thoughts/one').frontmatter.base_priority, 0.5);
    assert.equal(store.notes.get('personal/dafeiyu/thoughts/two').checksum, otherBefore.checksum);
    assert.equal(store.notes.get('personal/dafeiyu/thoughts/two').frontmatter.base_priority, undefined);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('duplicate facts merge sources instead of creating a second note', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [factAction()], opts(0));
    await applyMemoryActions(ctx, [factAction({ evidence: '不加糖' })], opts(0, { turn: 5 }));
    assert.equal([...store.notes.values()].filter((note) => note.permalink.includes('/facts/')).length, 1);
    const note = [...store.notes.values()][0];
    assert.match(note.frontmatter.sources, /turn/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('an exact target id cannot rewrite a different subject or attribute', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [factAction()], opts(0));
    const note = [...store.notes.values()][0];
    const before = note.content;

    const changedAttribute = await applyMemoryActions(ctx, [factAction({
      action: 'UPDATE',
      targetMemoryId: note.frontmatter.memory_id,
      attribute: '召回策略',
      value: '以后少主动想起',
      evidence: '以后少主动想起',
    })], opts(0, { turn: 4 }));
    assert.equal(changedAttribute.committed, false);
    assert.equal(changedAttribute.results[0].skipped, 'target-mismatch');
    assert.equal(note.content, before);

    const changedSubject = await applyMemoryActions(ctx, [factAction({
      action: 'CORRECT',
      targetMemoryId: note.frontmatter.memory_id,
      subject: '另一个人',
      value: '别人的偏好',
      evidence: '别人的偏好',
    })], opts(0, { turn: 5 }));
    assert.equal(changedSubject.committed, false);
    assert.equal(changedSubject.results[0].skipped, 'target-mismatch');
    assert.equal(note.content, before);
    assert.equal([...store.notes.values()].filter((item) => item.permalink.includes('/history/')).length, 0);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('soften compares the body after stripping YAML frontmatter and succeeds for metadata-only edits', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const base = context(store, vault);
    await applyMemoryActions(base, [factAction()], opts(0));
    const note = [...store.notes.values()][0];
    const before = note.content;
    const ctx = context(store, vault, withYamlFrontmatter(store));

    const result = await softenMemory(ctx, { memoryId: note.frontmatter.memory_id, reason: '少提' });
    assert.equal(result.ok, true);
    assert.equal(result.bodyUnchanged, true);
    assert.match(result.summary, /0\.5/);
    assert.match(result.summary, /减半/);
    assert.equal(note.content, before);
    assert.equal(note.frontmatter.base_priority, 0.5);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('soften still reports BODY_CHANGED when the body really changes during the metadata edit', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const base = context(store, vault);
    await applyMemoryActions(base, [factAction()], opts(0));
    const note = [...store.notes.values()][0];
    const ctx = context(store, vault, withYamlFrontmatter(store, { changeBodyOnEdit: true }));

    const result = await softenMemory(ctx, { identifier: note.permalink, reason: '少提' });
    assert.equal(result.ok, false);
    assert.equal(result.bodyUnchanged, false);
    assert.equal(result.errorCode, 'BODY_CHANGED');
    assert.match(result.summary, /正文变化/);
    assert.match(note.content, /外部改动/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});
test('relative time keeps its source anchor and a restated phrase re-anchors to the new message', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    const action = {
      action: 'ADD', kind: 'event', category: 'event', value: '在河边市集买黄铜书签', eventSummary: '河边市集买黄铜书签',
      occurredAt: '日期未明', timeExpression: '上周', evidence: '上周',
    };
    const first = await applyMemoryActions(ctx, [action], opts(0, { sourceEventTime: Date.parse('2026-10-17T06:30:00.000Z') }));
    assert.equal(first.committed, true);
    const note = [...store.notes.values()][0];
    assert.match(note.content, /- time_expression: 上周/);
    assert.match(note.content, /- time_anchor: 2026-10-17 14:30 Asia\/Shanghai/);
    assert.match(note.content, /- source_event_time: 2026-10-17T06:30:00.000Z/);
    assert.equal(note.frontmatter.occurred_at, '日期未明');

    // No new relative phrase: keep the existing expression and anchor.
    await applyMemoryActions(ctx, [{
      action: 'UPDATE', targetMemoryId: note.frontmatter.memory_id, kind: 'event', value: '在河边市集买黄铜书签和信封',
      eventSummary: '河边市集买黄铜书签和信封', evidence: '信封',
    }], opts(0, { turn: 4, sourceEventTime: Date.parse('2026-10-24T04:00:00.000Z') }));
    assert.match(note.content, /- time_expression: 上周/);
    assert.match(note.content, /- time_anchor: 2026-10-17 14:30 Asia\/Shanghai/);
    assert.match(note.content, /- source_event_time: 2026-10-17T06:30:00.000Z/);

    // The same phrase said on a later day is anchored to that later message.
    await applyMemoryActions(ctx, [{
      action: 'UPDATE', targetMemoryId: note.frontmatter.memory_id, kind: 'event', value: '在河边市集买黄铜书签、信封和邮票',
      eventSummary: '河边市集买黄铜书签、信封和邮票', timeExpression: '上周', evidence: '上周',
    }], opts(0, { turn: 5, sourceEventTime: Date.parse('2026-10-25T05:15:00.000Z') }));
    assert.match(note.content, /- time_expression: 上周/);
    assert.match(note.content, /- time_anchor: 2026-10-25 13:15 Asia\/Shanghai/);
    assert.match(note.content, /- source_event_time: 2026-10-25T05:15:00.000Z/);

    const history = [...store.notes.values()].filter((item) => item.frontmatter.status === 'history');
    assert.equal(history.length >= 2, true);
    assert.equal(history.some((item) => /2026-10-17 14:30 Asia\/Shanghai/.test(item.content)), true);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('an event rename keeps the same memory id and permalink, changes H1/frontmatter/file name, and keeps the old version', async () => {
  const vault = await makeVault();
  const store = memoryStore({ vault });
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [{
      action: 'ADD', kind: 'event', value: '周末陶艺课在周六上午', eventSummary: '陶艺课周六上午',
      occurredAt: '2026-10-17', evidence: '周六上午',
    }], opts(0));
    const note = [...store.notes.values()][0];
    const oldId = note.frontmatter.memory_id;
    const oldPermalink = note.permalink;
    assert.match(note.content, /^# 2026-10-17 - 陶艺课周六上午$/m);

    const updated = await applyMemoryActions(ctx, [{
      action: 'UPDATE', targetMemoryId: oldId, kind: 'event', value: '周末陶艺课改到周日下午',
      eventSummary: '陶艺课改到周日下午', occurredAt: '2026-10-17', evidence: '周日下午',
    }], opts(0, { turn: 4 }));
    assert.equal(updated.committed, true);
    const current = [...store.notes.values()].find((item) => item.frontmatter.memory_id === oldId);
    assert.ok(current);
    assert.equal(current.permalink, oldPermalink);
    assert.equal(current.title, '2026-10-17 - 陶艺课改到周日下午');
    assert.equal(current.frontmatter.title, current.title);
    assert.match(current.content, /^# 2026-10-17 - 陶艺课改到周日下午$/m);
    assert.match(current.filePath, /2026-10-17 - 陶艺课改到周日下午\.md$/);
    assert.equal([...store.notes.values()].filter((item) => item.frontmatter.memory_id === oldId).length, 1);
    const history = [...store.notes.values()].find((item) => item.frontmatter.status === 'history');
    assert.ok(history);
    assert.match(history.content, /陶艺课周六上午/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('an event rename does not overwrite an existing destination file', async () => {
  const vault = await makeVault();
  const store = memoryStore({ vault });
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [{
      action: 'ADD', kind: 'event', value: '旧标题事件', eventSummary: '旧标题事件',
      occurredAt: '2026-10-17', evidence: '旧标题事件',
    }], opts(0));
    const note = [...store.notes.values()][0];
    const oldContent = note.content;
    const oldFilePath = note.filePath;
    const blocker = await applyMemoryActions(ctx, [{
      action: 'ADD', kind: 'event', value: '目标占位', eventSummary: '新标题事件',
      occurredAt: '2026-10-17', evidence: '目标占位',
    }], opts(0, { turn: 4 }));
    assert.equal(blocker.committed, true);
    const blockerNote = [...store.notes.values()].find((item) => item.frontmatter.memory_id === blocker.results[0].memoryId);
    blockerNote.filePath = path.posix.join(path.posix.dirname(note.filePath), '2026-10-17 - 新标题事件.md');

    await assert.rejects(
      () => applyMemoryActions(ctx, [{
        action: 'UPDATE', targetMemoryId: note.frontmatter.memory_id, kind: 'event', value: '改名后的事件',
        eventSummary: '新标题事件', occurredAt: '2026-10-17', evidence: '改名',
      }], opts(0, { turn: 5 })),
      (error) => error instanceof MemoryError && error.code === 'TITLE_MOVE_FAILED',
    );
    assert.equal(note.title, '2026-10-17 - 旧标题事件');
    assert.equal(note.frontmatter.title, '2026-10-17 - 旧标题事件');
    assert.equal(note.content, oldContent);
    assert.equal(note.filePath, oldFilePath);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('an event value change without event_summary still renames the title and file', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    await applyMemoryActions(ctx, [{
      action: 'ADD', kind: 'event', value: '周六上午有陶艺课', eventSummary: '陶艺课周六上午',
      occurredAt: '2026-10-17', evidence: '周六上午',
    }], opts(0));
    const note = [...store.notes.values()][0];
    const oldPath = note.filePath;

    await applyMemoryActions(ctx, [{
      action: 'UPDATE', targetMemoryId: note.frontmatter.memory_id, kind: 'event',
      value: '陶艺课改到周日下午', occurredAt: '2026-10-17', evidence: '周日下午',
    }], opts(0, { turn: 4 }));

    assert.equal(note.title, '2026-10-17 - 陶艺课改到周日下午');
    assert.equal(note.frontmatter.title, note.title);
    assert.match(note.content, /^# 2026-10-17 - 陶艺课改到周日下午$/m);
    assert.notEqual(note.filePath, oldPath);
    assert.match(note.filePath, /2026-10-17 - 陶艺课改到周日下午\.md$/);
  } finally {
    await fs.rm(vault, { recursive: true, force: true });
  }
});


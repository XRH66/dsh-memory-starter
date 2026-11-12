import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSoftenTool, MEMORY_MARKER, parseMemoryContent, softenMemory } from '../lib/memory.js';
import { setPersonalTimeZone } from '../lib/personal-namespace.js';
import { resolveConfig } from '../lib/config.js';
import { fakeAgent, toolVaultBackend, writeLegacyMemoryNote } from './helpers.js';
import { memoryStore, makeVault } from './fake-memory.js';

setPersonalTimeZone('Asia/Shanghai');

const SESSION = 'session-memory-test';
const NOW = () => new Date('2026-10-24T04:00:00.000Z');

function context(store, vault = '', tools = store.tools) {
  return {
    tools,
    agent: fakeAgent(SESSION),
    project: 'personal',
    config: resolveConfig({ project: 'personal', captureFolder: 'chats', vaultPath: vault }),
    now: NOW,
    logger: { warn() {} },
  };
}

function yamlValue(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(String(value));
}

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
    get vaultBackend() { return toolVaultBackend(this); },
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

test('legacy body parser preserves requirement scope and history title', () => {
  const parsed = parseMemoryContent('<!-- dsh-fact-memory -->\n# 长度\n- [preference] 自行决定\n- 适用范围: general\n- 历史证据: [[旧长度]]\n');
  assert.equal(parsed.requirementScope, 'general');
  assert.equal(parsed.historyTitle, '旧长度');
  assert.equal(parsed.lines[0], MEMORY_MARKER);
});

test('successful factual downweight synchronizes exact raw source identities', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    const note = writeLegacyMemoryNote(store, {
      memoryId: 'memory-sync',
      subject: '用户',
      attribute: '饮品',
      value: '不加糖',
      sources: [{ session_id: SESSION, turn: 3, message_id: 'msg-1', event_seq: 11, at: NOW().toISOString() }],
    });
    const seen = [];
    ctx.onSourcesSoftened = async input => {
      seen.push(input);
      return { affected: 1 };
    };
    const result = await softenMemory(ctx, { memoryId: note.frontmatter.memory_id, reason: '少提' });
    assert.equal(result.ok, true);
    assert.equal(seen.length, 1);
    assert(seen[0].sources.length > 0);
    assert.equal(seen[0].weight, 0.5);
    assert.match(result.summary, /同步降低相同来源/);
  } finally {
    assert.equal(path.dirname(vault), path.resolve(os.tmpdir()));
    assert(path.basename(vault).startsWith('dafeiyu-memory-'));
    await fs.rm(vault, { recursive: true, force: true });
  }
});

test('a fuzzy soften query only lists candidates; only an exact id changes priority', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const ctx = context(store, vault);
    const note = writeLegacyMemoryNote(store, {
      memoryId: 'memory-fuzzy',
      subject: '饮品偏好',
      attribute: '甜度',
      value: '不加糖',
    });
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
  ctx.tools = { get vaultBackend() { return toolVaultBackend(this); }, get(name, agent) {
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

test('soften compares the body after stripping YAML frontmatter and succeeds for metadata-only edits', async () => {
  const store = memoryStore();
  const vault = await makeVault();
  try {
    const note = writeLegacyMemoryNote(store, { memoryId: 'memory-yaml', subject: '饮品偏好', attribute: '甜度' });
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
    const note = writeLegacyMemoryNote(store, { memoryId: 'memory-body-change', subject: '饮品偏好', attribute: '甜度' });
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

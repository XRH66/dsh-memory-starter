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

test('native soften only accepts an exact original message ID', async () => {
  const calls = [], softened = [];
  const tool = createSoftenTool({
    softenRawMessage(id) {
      calls.push(id);
      return { ok: true, weight: 0.5 };
    },
    onSoftened: (...args) => softened.push(args),
  });
  const rejected = await tool.execute({ memoryId: 'retired-entry' }, { agent: { session: { id: SESSION } } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'INVALID_ARGUMENT');
  assert.deepEqual(calls, []);
  const result = await tool.execute({ rawMessageId: 'raw-one', reason: '少提' }, { agent: { session: { id: SESSION } } });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'raw');
  assert.deepEqual(calls, ['raw-one']);
  assert.deepEqual(softened, [[SESSION, result]]);
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

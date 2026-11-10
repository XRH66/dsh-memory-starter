import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveConfig } from '../lib/config.js';
import { createRecordsTool } from '../lib/records.js';
import { setPersonalTimeZone } from '../lib/personal-namespace.js';
import { vaultMemoryStore } from './vault-memory.js';
import {formatBytes} from '../lib/review.js';

setPersonalTimeZone('Asia/Shanghai');

const NOW = () => new Date('2026-10-24T04:00:00.000Z');
const memoryStore = vault => vaultMemoryStore({vault});
async function makeVault(){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'dafeiyu-records-'));
  const vault=path.join(root,'vault');
  await fs.mkdir(vault);
  return vault;
}

function makeTool(store, vault, now = NOW) {
  return createRecordsTool({
    tools: {},
    vaultBackend: store.backend,
    config: { project: 'personal', vaultPath: vault },
    logger: { warn() {} },
    now,
  });
}

async function call(tool, args) {
  const result = await tool.execute(args, { agent: { session: { id: 'session-test' } } });
  return result.ok ? { ok: true, ...JSON.parse(result.data) } : result;
}

test('thoughts, people and diary persist through the Vault file layer', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    const thought = await call(tool, { action: 'save', kind: 'thoughts', text: '今天有点想早点收工。' });
    assert.equal(thought.ok, true);
    assert.match(thought.permalink, /^personal\/dafeiyu\/thoughts\//);
    assert.equal(store.notes.size, 1);

    const person = await call(tool, { action: 'save', kind: 'people', name: '老大', text: '说话直接，喜欢先看结果。' });
    assert.equal(person.ok, true);
    assert.match(person.permalink, /^personal\/dafeiyu\/people\//);

    for (const text of ['第一句。', '第二句。', '第三句。']) {
      assert.equal((await call(tool, { action: 'save', kind: 'diary', text })).ok, true);
    }
    const fourth = await call(tool, { action: 'save', kind: 'diary', text: '第四句。' });
    assert.equal(fourth.ok, false);
    assert.equal(fourth.errorCode, 'DIARY_LIMIT');

    const listed = await call(tool, { action: 'list', kind: 'diary' });
    assert.equal(listed.records.length, 1);
    assert.equal(listed.records[0].entries.length, 3);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('entries show occurrence and first record dates separately and revisions keep them', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    const saved = await call(tool, {
      action: 'save', kind: 'thoughts', text: '今天想早点收工。', occurredAt: '2026-10-20',
    });
    assert.equal(saved.ok, true);
    const read = await call(tool, { action: 'read', kind: 'thoughts', title: saved.permalink });
    assert.equal(read.entries[0].occurredAt, '2026-10-20');
    assert.equal(read.entries[0].recordedAt, '2026-10-24 12:00');
    assert.match(store.notes.get(saved.permalink).content, /- 笔记首次记录: 2026-10-24 12:00/);

    const laterTool = makeTool(store, vault, () => new Date('2026-10-25T04:00:00.000Z'));
    const revised = await call(laterTool, {
      action: 'save', kind: 'thoughts', title: saved.permalink, text: '改过的想法。',
      entryIndex: 1, expectedChecksum: read.checksum,
    });
    assert.equal(revised.ok, true);
    const after = await call(laterTool, { action: 'read', kind: 'thoughts', title: saved.permalink });
    assert.equal(after.entries[0].occurredAt, '2026-10-20');
    assert.equal(after.entries[0].recordedAt, '2026-10-24 12:00');
    assert.match(store.notes.get(saved.permalink).content, /- 笔记首次记录: 2026-10-24 12:00/);

    const appended = await call(laterTool, {
      action: 'save', kind: 'thoughts', title: saved.permalink, text: '新的一条。',
    });
    assert.equal(appended.ok, true);
    const both = await call(laterTool, { action: 'read', kind: 'thoughts', title: saved.permalink });
    assert.equal(both.entries[0].recordedAt, '2026-10-24 12:00');
    assert.equal(both.entries[1].recordedAt, '2026-10-25 12:00');
    assert.equal(both.entries[1].occurredAt, '日期未明');
    const content = store.notes.get(saved.permalink).content;
    assert.equal((content.match(/- 笔记首次记录:/g) || []).length, 1);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('diary limit holds under concurrent saves and a new Shanghai day resets it', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    const results = await Promise.all([
      call(tool, { action: 'save', kind: 'diary', text: 'a' }),
      call(tool, { action: 'save', kind: 'diary', text: 'b' }),
      call(tool, { action: 'save', kind: 'diary', text: 'c' }),
      call(tool, { action: 'save', kind: 'diary', text: 'd' }),
    ]);
    assert.equal(results.filter((item) => item.ok).length, 3);
    assert.equal(results.filter((item) => item.errorCode === 'DIARY_LIMIT').length, 1);

    const nextDayTool = makeTool(store, vault, () => new Date('2026-10-25T04:00:00.000Z'));
    const nextDay = await call(nextDayTool, { action: 'save', kind: 'diary', text: 'e' });
    assert.equal(nextDay.ok, true);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('new diary entries cannot be appended to an older day, but old entries stay revisable', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const day1 = makeTool(store, vault, () => new Date('2026-10-24T04:00:00.000Z'));
  try {
    const old = await call(day1, { action: 'save', kind: 'diary', text: '昨天的一句。' });
    const later = makeTool(store, vault, () => new Date('2026-10-25T04:00:00.000Z'));

    const appended = await call(later, { action: 'save', kind: 'diary', title: old.permalink, text: '今天想加到昨天。' });
    assert.equal(appended.ok, false);
    assert.equal(appended.errorCode, 'DIARY_OLD_DAY');

    const today = await call(later, { action: 'save', kind: 'diary', text: '今天的。' });
    assert.equal(today.ok, true);
    assert.notEqual(today.permalink, old.permalink);

    const revised = await call(later, {
      action: 'save', kind: 'diary', title: old.permalink, text: '补充一句。',
      entryIndex: 1, expectedChecksum: old.checksum,
    });
    assert.equal(revised.ok, true);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('entry-like heading lines in body text stay text and do not bypass the daily cap', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    const text = '想记一下排版：\n  ## 12:00\n这句只是正文。';
    const saved = await call(tool, { action: 'save', kind: 'diary', text });
    assert.equal(saved.ok, true);
    const read = await call(tool, { action: 'read', kind: 'diary', title: saved.permalink });
    assert.equal(read.entries.length, 1);
    assert.match(read.entries[0].text, /## 12:00/);
    assert.equal((await call(tool, { action: 'save', kind: 'diary', text: '第二条。' })).ok, true);
    assert.equal((await call(tool, { action: 'save', kind: 'diary', text: '第三条。' })).ok, true);
    const fourth = await call(tool, { action: 'save', kind: 'diary', text: '第四条。' });
    assert.equal(fourth.ok, false);
    assert.equal(fourth.errorCode, 'DIARY_LIMIT');
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('revisions require a matching checksum and stale writes are rejected', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    const saved = await call(tool, { action: 'save', kind: 'thoughts', text: '旧想法。' });
    const read = await call(tool, { action: 'read', kind: 'thoughts', title: saved.permalink });
    assert.equal(read.checksum, saved.checksum);

    const revised = await call(tool, {
      action: 'save', kind: 'thoughts', title: saved.permalink, text: '改过的想法。',
      entryIndex: 1, expectedChecksum: read.checksum,
    });
    assert.equal(revised.ok, true);
    const after = await call(tool, { action: 'read', kind: 'thoughts', title: saved.permalink });
    assert.match(after.entries[0].text, /改过的想法/);

    const stale = await call(tool, {
      action: 'save', kind: 'thoughts', title: saved.permalink, text: '又改。',
      entryIndex: 1, expectedChecksum: read.checksum,
    });
    assert.equal(stale.ok, false);
    assert.equal(stale.errorCode, 'STALE_REVISION');

    const missing = await call(tool, { action: 'save', kind: 'thoughts', title: saved.permalink, text: '没带版本。', entryIndex: 1 });
    assert.equal(missing.ok, false);
    assert.equal(missing.errorCode, 'MISSING_EXPECTED_CHECKSUM');

    const deleted = await call(tool, { action: 'delete', kind: 'thoughts', title: saved.permalink, expectedChecksum: after.checksum });
    assert.equal(deleted.ok, true);
    assert.match(deleted.reviewText, /尚未删除、尚未停用、尚未降权/);
    assert.ok(store.notes.has(saved.permalink), 'the original note must be retained');
    const stillThere = await call(tool, { action: 'read', kind: 'thoughts', title: saved.permalink });
    assert.match(stillThere.entries[0].text, /改过的想法/);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('archive selects a parsed entry, keeps whole-note and entry submissions distinct, and records real file size', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    const first = await call(tool, { action: 'save', kind: 'thoughts', text: '第一条。' });
    await call(tool, { action: 'save', kind: 'thoughts', title: first.permalink, text: '第二条。' });
    const read = await call(tool, { action: 'read', kind: 'thoughts', title: first.permalink });
    assert.equal(read.entries.length, 2);

    const note = store.notes.get(first.permalink);
    const notePath = path.join(vault, note.directory, note.title + '.md');
    const noteSize = (await fs.stat(notePath)).size;

    const whole = await call(tool, { action: 'archive', kind: 'thoughts', title: first.permalink, expectedChecksum: read.checksum });
    assert.equal(whole.ok, true);

    const entry = await call(tool, {
      action: 'archive', kind: 'thoughts', title: first.permalink, entryIndex: 1, expectedChecksum: read.checksum,
    });
    assert.equal(entry.ok, true);
    assert.equal(entry.target, 'entry');

    const reviewPath = path.join(path.dirname(vault), 'management', '待审清单.md');
    const review = await fs.readFile(reviewPath, 'utf8');
    assert.equal([...store.notes.values()].some((item) => item.title === '待审清单'), false, 'the review list must not be a Vault note');
    let lines = review.split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 2, 'whole-note and entry submissions are distinct');
    assert.match(lines[0], /整篇：/);
    assert.match(lines[1], /第 1 条：/);
    assert.match(lines[1], new RegExp(formatBytes(noteSize).replace('.', '\\.')));
    assert.match(review, /提交待审本身不删除、不停用、不降权/);
    assert.match(review, /soften_memory 是单独的显式降权操作/);
    assert.match(review, /采样时间：2026-10-24 12:00 Asia\/Shanghai/);
    const linkMatch = lines[1].match(/\[打开原文\]\(obsidian:\/\/open\?path=([^)]+)\)/);
    assert.ok(linkMatch, 'the review entry links the real note through Obsidian');
    assert.equal(decodeURIComponent(linkMatch[1]), notePath.replace(/\\/g, '/'));
    assert.match(linkMatch[1], /%E5%BE%85%E5%AE%A1|Dafeiyu|%20/);

    const repeated = await call(tool, {
      action: 'archive', kind: 'thoughts', title: first.permalink, entryIndex: 1, expectedChecksum: read.checksum,
    });
    assert.equal(repeated.ok, true);
    const reviewAgain = await fs.readFile(reviewPath, 'utf8');
    lines = reviewAgain.split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 2, 'the same entry is not appended twice');

    const invalid = await call(tool, {
      action: 'archive', kind: 'thoughts', title: first.permalink, entryIndex: 9, expectedChecksum: read.checksum,
    });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.errorCode, 'INVALID_ENTRY');

    const unchanged = await call(tool, { action: 'read', kind: 'thoughts', title: first.permalink });
    assert.deepEqual(unchanged.entries.map((item) => item.text), ['第一条。', '第二条。']);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('personal namespace rejects fact notes, foreign kinds and traversal', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    for (const target of ['personal/people/teac', 'dafeiyu/people/someone', 'dafeiyu/thoughts/../../chats/x', 'dafeiyu/thoughts/']) {
      const result = await call(tool, {
        action: 'save', kind: 'thoughts', title: target, text: '越界。', entryIndex: 1, expectedChecksum: 'c1',
      });
      assert.equal(result.ok, false);
      assert.ok(['NOT_PERSONAL', 'NOT_FOUND', 'INVALID_IDENTIFIER'].includes(result.errorCode), target + ' -> ' + result.errorCode);
    }
    assert.equal(store.notes.size, 0);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('gallery copies a real local image, revises text and keeps originals for human review', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const image = path.join(vault, 'source.png');
  let tick = 0;
  const now = () => new Date(Date.parse('2026-10-24T04:00:00.000Z') + (tick++) * 1000);
  const tool = makeTool(store, vault, now);
  try {
    await fs.writeFile(image, png);
    const first = await call(tool, { action: 'save', kind: 'gallery', text: '这张看着挺安静。', imagePath: image }, now);
    assert.equal(first.ok, true);
    const assetPath = path.join(vault, 'dafeiyu', 'gallery', 'assets', first.asset.replace(/^assets\//, ''));
    assert.deepEqual(await fs.readFile(assetPath), png);

    const read = await call(tool, { action: 'read', kind: 'gallery', title: first.permalink });
    assert.match(read.entries[0].text, /安静/);

    const revised = await call(tool, {
      action: 'save', kind: 'gallery', title: first.permalink, text: '现在看有点吵。',
      entryIndex: 1, expectedChecksum: read.checksum,
    }, now);
    assert.equal(revised.ok, true);

    const missingVersion = await call(tool, {
      action: 'save', kind: 'gallery', title: first.permalink, text: '没带版本。', entryIndex: 1,
    }, now);
    assert.equal(missingVersion.ok, false);
    assert.equal(missingVersion.errorCode, 'MISSING_EXPECTED_CHECKSUM');

    const staleVersion = await call(tool, {
      action: 'save', kind: 'gallery', title: first.permalink, text: '旧版本。',
      entryIndex: 1, expectedChecksum: read.checksum,
    }, now);
    assert.equal(staleVersion.ok, false);
    assert.equal(staleVersion.errorCode, 'STALE_REVISION');

    const second = await call(tool, { action: 'save', kind: 'gallery', text: '同图另一条。', imagePath: image }, now);
    assert.equal(second.ok, true);
    assert.equal(first.asset, second.asset);

    const removedFirst = await call(tool, { action: 'delete', kind: 'gallery', title: first.permalink, expectedChecksum: revised.checksum }, now);
    assert.equal(removedFirst.ok, true);
    assert.match(removedFirst.reviewText, /尚未删除、尚未停用、尚未降权/);
    assert.ok(await fs.stat(assetPath));

    const removedSecond = await call(tool, { action: 'delete', kind: 'gallery', title: second.permalink, expectedChecksum: second.checksum }, now);
    assert.equal(removedSecond.ok, true);
    assert.ok(await fs.stat(assetPath), 'review submission must not orphan or remove the image');

    const notImage = path.join(vault, 'note.txt');
    await fs.writeFile(notImage, 'plain text');
    const rejected = await call(tool, { action: 'save', kind: 'gallery', text: '假图。', imagePath: notImage }, now);
    assert.equal(rejected.ok, false);
    assert.equal(rejected.errorCode, 'INVALID_IMAGE');
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('a migrated old record keeps its note-level first-record date after a save', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  const content = [
    '<!-- dafeiyu-record kind=thoughts -->',
    '# Old Archive',
    '',
    '- 笔记首次记录: 2026-10-24 21:42',
    '',
    '## 21:58',
    '- 发生日期: 日期未明',
    '- 记录日期: 日期未明',
    '旧想法。',
    'source_date_confirmation: 2026-10-24',
    '',
  ].join('\n');
  const old = await store.backend.write({
    title: 'Old Archive',
    directory: 'dafeiyu/thoughts',
    content,
    metadata: { recorded_at: '2026-10-24T13:42:51.264Z', dafeiyu_kind: 'thoughts' },
    tags: ['dafeiyu', 'dafeiyu-thoughts', 'subjective'],
  });
  const permalink = old.permalink;
  try {
    const read = await call(tool, { action: 'read', kind: 'thoughts', title: permalink });
    assert.equal(read.entries[0].occurredAt, '日期未明');
    assert.equal(read.entries[0].recordedAt, '日期未明');

    const saved = await call(tool, {
      action: 'save', kind: 'thoughts', title: permalink, text: '改过的想法。',
      entryIndex: 1, expectedChecksum: old.checksum,
    });
    assert.equal(saved.ok, true);
    const after = store.notes.get(permalink).content;
    assert.match(after, /- 笔记首次记录: 2026-10-24 21:42/);
    assert.equal((after.match(/- 笔记首次记录:/g) || []).length, 1);
    assert.match(after, /- 记录日期: 日期未明/);

    const again = await call(tool, {
      action: 'save', kind: 'thoughts', title: permalink, text: '再改一次。',
      entryIndex: 1, expectedChecksum: saved.checksum,
    });
    assert.equal(again.ok, true);
    const finalContent = store.notes.get(permalink).content;
    assert.equal((finalContent.match(/- 笔记首次记录:/g) || []).length, 1);
    assert.match(finalContent, /- 笔记首次记录: 2026-10-24 21:42/);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('archive cannot write a management list when the Vault backend is unavailable', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const failing={...store.backend,read:async()=>{throw Object.assign(Error('vault unavailable'),{code:'MEMORY_BACKEND_ERROR'});}};
  const tool = createRecordsTool({
    tools: {},
    vaultBackend: failing,
    config: { project: 'personal', vaultPath: vault },
    logger: { warn() {} },
    now: NOW,
  });
  try {
    const result = await tool.execute(
      { action: 'archive', kind: 'thoughts', title: 'dafeiyu/thoughts/x', expectedChecksum: 'c1' },
      { agent: { session: { id: 'session-test' } } },
    );
    assert.equal(result.ok, false);
    assert.match(result.errorMessage, /vault|unavailable/i);
    const reviewPath = path.join(path.dirname(vault), 'management', '待审清单.md');
    assert.equal(await fs.stat(reviewPath).catch(() => null), null, 'a failed Vault read must not create a management list');
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

test('canonical project-prefixed permalinks round-trip through read, revision and review submission', async () => {
  const vault = await makeVault();
  const store = await memoryStore(vault);
  const tool = makeTool(store, vault);
  try {
    const created = await call(tool, { action: 'save', kind: 'thoughts', text: 'canonical 回归。' });
    assert.equal(created.ok, true);
    assert.match(created.permalink, /^personal\/dafeiyu\/thoughts\//);

    const read = await call(tool, { action: 'read', kind: 'thoughts', title: created.permalink });
    assert.equal(read.ok, true);
    assert.equal(read.entries.length, 1);
    assert.equal(read.entries[0].text, 'canonical 回归。');

    const revised = await call(tool, { action: 'save', kind: 'thoughts', title: created.permalink, entryIndex: 1, expectedChecksum: read.checksum, text: '改过的 canonical。' });
    assert.equal(revised.ok, true);
    assert.equal(revised.permalink, created.permalink);

    const stale = await call(tool, { action: 'save', kind: 'thoughts', title: created.permalink, entryIndex: 1, expectedChecksum: read.checksum, text: '旧版本。' });
    assert.equal(stale.ok, false);
    assert.equal(stale.errorCode, 'STALE_REVISION');

    const relative = await call(tool, { action: 'read', kind: 'thoughts', title: created.permalink.replace(/^personal\//, '') });
    assert.equal(relative.ok, true);

    const otherProject = await call(tool, { action: 'read', kind: 'thoughts', title: 'other/' + created.permalink.replace(/^personal\//, '') });
    assert.equal(otherProject.ok, false);
    assert.equal(otherProject.errorCode, 'NOT_PERSONAL');

    const sourcePath = path.join(vault, store.notes.get(created.permalink).filePath);
    assert.ok(await fs.stat(sourcePath));
    const removed = await call(tool, { action: 'delete', kind: 'thoughts', title: created.permalink, expectedChecksum: revised.checksum });
    assert.equal(removed.ok, true);
    assert.ok(store.notes.has(created.permalink), 'the original note must be retained');
    const reviewPath = path.join(path.dirname(vault), 'management', '待审清单.md');
    const reviewContent = await fs.readFile(reviewPath, 'utf8');
    assert.match(reviewContent, /Dafeiyu Thoughts/);
    assert.match(reviewContent, /obsidian:\/\/open\?path=/);
    assert.equal([...store.notes.values()].some((note) => /待审清单/.test(note.title)), false);
  } finally {
    await fs.rm(path.dirname(vault), { recursive: true, force: true });
  }
});

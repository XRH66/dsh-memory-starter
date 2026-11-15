import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendReviewEntry,
  managementDirectory,
  reviewAbsolutePath,
} from '../lib/review.js';

const NOW = () => new Date('2026-10-24T04:00:00.000Z');

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'review-list-'));
  const vault = path.join(root, 'vault');
  await fs.mkdir(vault);
  return { root, vault, config: { project: 'personal', vaultPath: vault } };
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

function listPath(config) {
  return path.join(managementDirectory(config), '待审清单.md');
}

test('review entries live outside the vault, dedupe, survive concurrent appends, and link through Obsidian', async () => {
  const { root, vault, config } = await setup();
  try {
    const note = path.join(vault, 'chats', 'events', '2026-09-17 - 示例人物 手账 #1.md');
    await fs.mkdir(path.dirname(note), { recursive: true });
    await fs.writeFile(note, 'actual note');
    const ctx = { vaultPath: vault, project: 'personal', config };
    const entry = (scope) => ({
      kind: 'event',
      title: '示例人物 手账 #1',
      reason: scope + '：用户要求提交人工审阅',
      scope,
      filePath: 'chats/events/2026-09-17 - 示例人物 手账 #1.md',
      bytes: 11,
      now: NOW,
    });

    const first = await appendReviewEntry(ctx, entry('整篇'));
    assert.equal(first.updated, true);
    const results = await Promise.all([
      appendReviewEntry(ctx, entry('第 1 条')),
      appendReviewEntry(ctx, entry('第 2 条')),
      appendReviewEntry(ctx, entry('第 3 条')),
      appendReviewEntry(ctx, entry('第 4 条')),
    ]);
    assert.equal(results.every((item) => item.updated), true);

    const reviewFile = listPath(config);
    const content = await fs.readFile(reviewFile, 'utf8');
    assert.equal(reviewFile.startsWith(vault + path.sep), false, 'the review list is outside the vault');
    assert.equal(await fs.stat(path.join(vault, 'chats', 'review', '待审清单.md')).catch(() => null), null);
    const lines = content.split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 5);
    assert.equal(new Set(lines).size, 5);
    assert.match(content, /Vault 所在卷可用 .*采样时间：2026-10-24 12:00 Asia\/Shanghai/);

    await appendReviewEntry(ctx, entry('第 1 条'));
    const again = await fs.readFile(reviewFile, 'utf8');
    assert.equal(again, content, 'a duplicate entry does not rewrite the list');
    assert.equal((await fs.readdir(path.dirname(reviewFile))).filter((name) => name.endsWith('.tmp')).length, 0);

    const linkMatch = again.match(/\[打开原文\]\(obsidian:\/\/open\?path=([^)]+)\)/);
    assert.ok(linkMatch);
    const decoded = decodeURIComponent(linkMatch[1]);
    assert.equal(decoded, path.resolve(note).replace(/\\/g, '/'));
    assert.equal(path.isAbsolute(decoded), true);
    assert.match(linkMatch[1], /%23/);
    assert.match(linkMatch[1], /%20/);
    assert.ok(linkMatch[1].includes(encodeURIComponent('示例人物')));
    assert.match(again, /本清单保存在 Vault 外的本地管理目录/);
  } finally {
    await cleanup(root);
  }
});

test('the same note can be submitted by scope without duplicate lines, and a changed target is not deduped', async () => {
  const { root, vault, config } = await setup();
  try {
    await fs.mkdir(path.join(vault, 'chats', 'facts'), { recursive: true });
    await fs.writeFile(path.join(vault, 'chats', 'facts', 'a.md'), 'a');
    await fs.writeFile(path.join(vault, 'chats', 'facts', 'b.md'), 'b');
    const ctx = { vaultPath: vault, project: 'personal', config };
    const base = { kind: 'fact', title: 'A', filePath: 'chats/facts/a.md', bytes: 1, now: NOW };
    const add = (scope, reason = scope + '：用户要求提交人工审阅', filePath = base.filePath) => appendReviewEntry(ctx, { ...base, scope, reason, filePath });
    assert.equal((await add('整篇')).updated, true);
    assert.equal((await add('第 1 条')).updated, true);
    assert.equal((await add('第 1 条')).updated, false);
    assert.equal((await add('第 1 条', '第 1 条：另一个理由')).updated, false, 'same scope and target is the same submission even if the reason text changed');
    assert.equal((await add('第 2 条')).updated, true);
    assert.equal((await add('整篇', '整篇：用户要求提交人工审阅', 'chats/facts/b.md')).updated, true);
    const lines = (await fs.readFile(listPath(config), 'utf8')).split(/\r?\n/).filter((line) => line.startsWith('- '));
    assert.equal(lines.length, 4);
  } finally {
    await cleanup(root);
  }
});

test('review read and write failures are errors, never an empty list that is overwritten', async () => {
  const { root, vault, config } = await setup();
  const ctx = { vaultPath: vault, project: 'personal', config };
  const entry = {
    kind: 'fact',
    title: 'A',
    reason: '整篇：用户要求提交人工审阅',
    scope: '整篇',
    filePath: 'a.md',
    bytes: 1,
    now: NOW,
  };
  try {
    const file = listPath(config);
    await fs.mkdir(file, { recursive: true });
    await assert.rejects(
      () => appendReviewEntry(ctx, entry),
      (error) => error?.code === 'REVIEW_READ_FAILED',
    );

    await fs.rm(file, { recursive: true, force: true });
    const originalMkdir = fs.mkdir;
    fs.mkdir = async (target, options) => {
      if (path.resolve(String(target)) === path.resolve(path.dirname(file))) {
        throw Object.assign(Error('simulated write denial'), { code: 'EACCES' });
      }
      return originalMkdir(target, options);
    };
    try {
      await assert.rejects(
        () => appendReviewEntry(ctx, entry),
        (error) => error?.code === 'REVIEW_WRITE_FAILED',
      );
    } finally {
      fs.mkdir = originalMkdir;
    }
    assert.equal(await fs.stat(file).catch(() => null), null, 'the failed write must not create a list');
  } finally {
    await cleanup(root);
  }
});

test('only real vault paths qualify for review links', async () => {
  const { root, vault } = await setup();
  try {
    const inside = path.join(vault, 'note.md');
    const outside = path.join(root, 'outside.md');
    await fs.writeFile(inside, 'note');
    await fs.writeFile(outside, 'outside');
    assert.equal(await reviewAbsolutePath(inside, { vaultPath: vault, project: 'personal' }), inside);
    assert.equal(await reviewAbsolutePath(outside, { vaultPath: vault, project: 'personal' }), '');
    assert.equal(await reviewAbsolutePath('../../outside.md', { vaultPath: vault, project: 'personal' }), '');
    assert.equal(await reviewAbsolutePath('personal/' + path.basename(inside), { vaultPath: vault, project: 'personal' }), inside);
  } finally {
    await cleanup(root);
  }
});

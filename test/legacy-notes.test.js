import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createLegacyNoteReader,parseLegacyNote} from '../lib/legacy-notes.js';

const NOTE=`---
title: 用户 - 虚构宠物
permalink: personal/chats/facts/用户-虚构宠物
memory_id: fixture-1
memory_kind: fact
status: active
subject: 用户
attribute: 养的宠物
value: 养了一只叫阿岑的猫
recorded_at: '2026-10-25T04:21:07.668Z'
tags:
- dsh-memory
- dsh-fact
---

<!-- dsh-fact-memory -->
# 用户 - 虚构宠物

- [fact] 养了一只叫阿岑的猫
`;

test('old-format notes are read from the Vault with the Basic Memory checksum and found by text', async t => {
  const vault = await fs.mkdtemp(path.join(os.tmpdir(), 'legacy-notes-'));
  t.after(() => fs.rm(vault, { recursive: true, force: true }));
  await fs.mkdir(path.join(vault, 'chats/facts'), { recursive: true });
  await fs.writeFile(path.join(vault, 'chats/facts/pet.md'), NOTE);
  const reader = createLegacyNoteReader({ vaultPath: vault, directories: ['chats/facts', 'chats/events'] });
  assert.equal(reader.available(), true);
  const [note] = reader.search('阿岑是什么');
  assert.equal(note.metadata.memory_id, 'fixture-1'); assert.deepEqual(note.metadata.tags, ['dsh-memory', 'dsh-fact']);
  assert.equal(note.metadata.recorded_at, '2026-10-25T04:21:07.668Z');
  assert.equal(note.checksum, createHash('sha256').update(NOTE).digest('hex'));
  assert.equal(note.file_path, 'chats/facts/pet.md');
  assert.equal(reader.search('小周的绿萝').length, 0);
  assert.equal(parseLegacyNote('no frontmatter'), null);
});

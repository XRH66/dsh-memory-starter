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

test('legacy note cache is shared across readers and invalidates edits and deletions',async t=>{
  const vault=await fs.mkdtemp(path.join(os.tmpdir(),'legacy-shared-cache-'));
  t.after(()=>fs.rm(vault,{recursive:true,force:true}));
  await fs.mkdir(path.join(vault,'chats/facts'),{recursive:true});
  const file=path.join(vault,'chats/facts/pet.md');
  await fs.writeFile(file,NOTE);
  const directories=['chats/facts','chats/events'];
  const firstReader=createLegacyNoteReader({vaultPath:vault,directories});
  const [first]=firstReader.notes();
  assert.equal(firstReader.search('阿岑').length,1);
  const secondReader=createLegacyNoteReader({vaultPath:vault,directories});
  const [shared]=secondReader.notes();
  assert.equal(shared,first,'a second reader reuses the cached note object and term set');

  const changed=NOTE.replaceAll('养了一只叫阿岑的猫','后来养了一只叫阿岑的白猫');
  await fs.writeFile(file,changed);
  const [updated]=secondReader.notes();
  assert.notEqual(updated,first);assert.match(updated.content,/后来养了一只叫阿岑的白猫/u);
  assert.equal(secondReader.search('后来').length,1);

  await fs.rm(file);
  assert.deepEqual(secondReader.notes(),[]);assert.deepEqual(secondReader.search('阿岑'),[]);
});

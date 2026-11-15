import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLegacyNote} from '../lib/legacy-notes.js';

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

test('old-format frontmatter parsing remains available to inheritance and Vault readers',()=>{
  const parsed=parseLegacyNote(NOTE);
  assert.equal(parsed.metadata.memory_id,'fixture-1');
  assert.deepEqual(parsed.metadata.tags,['dsh-memory','dsh-fact']);
  assert.equal(parsed.metadata.recorded_at,'2026-10-25T04:21:07.668Z');
  assert.match(parsed.content,/养了一只叫阿岑的猫/u);
  assert.equal(parseLegacyNote('no frontmatter'),null);
  assert.equal(parseLegacyNote('---\nmetadata:\n  nested: value\n---\nbody'),null);
});

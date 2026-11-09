import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../lib/index.js';
import { resolveConfig } from '../lib/config.js';
import {
  TARGET_SESSION as TARGET_SESSION_ID,
  assistantMessage,
  directUser,
  fakeAgent,
  fakeLlm,
  fakeTools,
  mcpResult,
  mcpTextOnlyResult,
  runPreStep,
  turnEnd,
  turnStart,
  userMessage,
} from './helpers.js';

const CAPTURE_JSON = JSON.stringify({
  actions: [{
    action: 'ADD',
    kind: 'fact',
    category: 'preference',
    title: 'tea',
    subject: 'user',
    attribute: 'tea',
    value: 'The user prefers oolong tea.',
    evidence: 'I prefer oolong tea.',
  }],
});

function searchPayload() {
  return {
    results: [{
      title: 'Tea preference',
      type: 'note',
      score: 0.87,
      permalink: 'personal/chats/facts/tea',
      matched_chunk: 'The user prefers jasmine tea without sugar.',
      metadata: { memory_id: 'memory-tea', status: 'active' },
    }],
    current_page: 1,
    page_size: 3,
    total: 1,
    total_is_exact: true,
    has_more: false,
  };
}

function emptySearchPayload() {
  return { results: [], current_page: 1, page_size: 3, total: 0, total_is_exact: true, has_more: false };
}

function notePayload() {
  return {
    title: 'Tea preference',
    permalink: 'personal/chats/facts/tea',
    file_path: 'chats/facts/tea.md',
    checksum: 'tea-checksum',
    content: '# Tea preference\n\n- [preference] The user prefers jasmine tea without sugar.',
    frontmatter: { memory_id: 'memory-tea', status: 'active' },
  };
}

function writePayload() {
  return {
    title: 'tea',
    permalink: 'personal/chats/facts/tea-preference',
    file_path: 'chats/facts/tea-preference.md',
    checksum: 'abc123',
    action: 'created',
    similar_notes: [],
  };
}

test('offline: the bridge never calls an alternate memory backend or tool', async () => {
  const allowed = new Set([
    'mcp__basic_memory__search_notes',
    'mcp__basic_memory__read_note',
    'mcp__basic_memory__list_directory',
    'mcp__basic_memory__write_note',
    'mcp__basic_memory__edit_note',
  ]);
  const tools = fakeTools((input) => {
    assert.ok(allowed.has(input.name), 'unexpected tool ' + input.name);
    if (input.name === 'mcp__basic_memory__search_notes') {
      return mcpResult(input.arguments.query.includes('tea') ? searchPayload() : emptySearchPayload());
    }
    if (input.name === 'mcp__basic_memory__read_note') return mcpResult(notePayload());
    if (input.name === 'mcp__basic_memory__list_directory') return mcpResult({ nodes: [] });
    return mcpResult(writePayload());
  });
  const bridge = createBridge({
    config: resolveConfig({ personalRecall: false }),
    tools,
    llm: fakeLlm(CAPTURE_JSON),
    logger: { warn() {} },
  });
  const session = fakeAgent(TARGET_SESSION_ID).session;
  await runPreStep(bridge, { turn: 6, messages: [directUser('tea')], agent: fakeAgent(TARGET_SESSION_ID) });
  bridge.onSessionEvent(session, turnStart(6));
  bridge.onSessionEvent(session, userMessage('tea'));
  bridge.onSessionEvent(session, assistantMessage(6, 'ok'));
  bridge.onSessionEvent(session, turnEnd(6));
  await bridge.waitForIdle(TARGET_SESSION_ID);
  assert.ok(tools.calls.length >= 3);
  assert.ok(tools.calls.every((call) => allowed.has(call.name)));
});

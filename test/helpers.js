import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after } from 'node:test';

export const TARGET_SESSION = 'session-fixture-primary';
export const OTHER_SESSION = 'session-00000000-0000-0000-0000-000000000000';

export function unwrapToolValue(result) {
  if (!result || typeof result !== 'object' || result.isError === true) return null;
  const value = result.value;
  if (!value || typeof value !== 'object') return null;
  if (value.structuredContent !== null && typeof value.structuredContent === 'object') {
    const structured = value.structuredContent;
    return structured.result !== undefined ? structured.result : structured;
  }
  if (Array.isArray(value.content)) {
    const block = value.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    if (!block) return null;
    try {
      return JSON.parse(block.text);
    } catch {
      return { text: block.text };
    }
  }
  return null;
}

export function toolFailureText(result) {
  if (!result || typeof result !== 'object') return 'tool returned no result';
  if (result.error && typeof result.error === 'object' && typeof result.error.message === 'string') return result.error.message;
  if (typeof result.error === 'string') return result.error;
  if (Array.isArray(result.content)) {
    const block = result.content.find((item) => item && item.type === 'text' && typeof item.text === 'string');
    if (block) return block.text.slice(0, 300);
  }
  return 'tool reported an error';
}

export function mcpResult(payload) {
  return {
    isError: false,
    value: {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: { result: payload },
    },
    content: [],
  };
}

export function mcpTextOnlyResult(payload) {
  return {
    isError: false,
    value: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
    content: [],
  };
}

export function mcpError(message) {
  return { isError: true, error: { message }, content: [{ type: 'text', text: message }] };
}

const VAULT_TOOL_NAMES = Object.freeze({
  read: 'mcp__basic_memory__read_note',
  write: 'mcp__basic_memory__write_note',
  edit: 'mcp__basic_memory__edit_note',
  list: 'mcp__basic_memory__list_directory',
  search: 'mcp__basic_memory__search_notes',
  move: 'mcp__basic_memory__move_note',
});
const CONFLICT_RE = /checksum|conflict|modified|already exists|no match|multiple|not found/i;
const vaultFail = (code, message, details = {}) => Object.assign(Error(message), { code, ...details });

/**
 * Test-only Vault backend that routes every operation through a scoped tool
 * double (`tools.get(name).execute`). It keeps per-call recording, lazy tool
 * lookup and fault injection available to tests; production code only knows the
 * backend contract of lib/vault-files.js.
 */
export function toolVaultBackend(tools, names = VAULT_TOOL_NAMES) {
  async function call(context, key, args) {
    context?.check?.();
    const name = names[key], execArgs = { project: context?.project, output_format: 'json', ...args };
    let definition;
    try { definition = tools?.get?.(name, context?.agent); }
    catch (error) { throw vaultFail('MEMORY_BACKEND_ERROR', error instanceof Error ? error.message : String(error)); }
    if (!definition || typeof definition.execute !== 'function') throw vaultFail('MEMORY_BACKEND_ERROR', 'scoped tool is unavailable: ' + name);
    const callId = 'vault-' + randomUUID();
    let raw;
    try {
      raw = await definition.execute(execArgs, {
        callId, rootCallId: callId, name, arguments: execArgs, agent: context?.agent,
        signal: context?.signal ?? new AbortController().signal, token: Symbol(name), deferContext() {}, concludeTurn() {},
        memoryAuthorization: () => { try { context?.check?.(); return true; } catch { return false; } },
      });
    } catch (error) { throw vaultFail('MEMORY_BACKEND_ERROR', error instanceof Error ? error.message : String(error)); }
    const result = raw && typeof raw === 'object' && Object.hasOwn(raw, 'isError') ? raw : { isError: false, value: raw, content: [] };
    context?.check?.();
    if (result?.isError) {
      const text = toolFailureText(result);
      throw vaultFail(key === 'read' || !CONFLICT_RE.test(text) ? 'MEMORY_BACKEND_ERROR' : 'MEMORY_WRITE_CONFLICT', text);
    }
    const value = unwrapToolValue(result);
    if (value?.error === 'NOTE_NOT_FOUND') return null;
    if (value?.error === 'NOTE_SYNC_PENDING') {
      throw vaultFail('MEMORY_NOTE_SYNC_PENDING', 'Local Markdown is awaiting synchronization', { retryable: true });
    }
    if (value?.error || value?.action === 'conflict') {
      const text = String(value.message ?? value.error ?? 'conflict');
      const conflict = key !== 'read' && (value.action === 'conflict' || CONFLICT_RE.test(text));
      throw vaultFail(conflict ? 'MEMORY_WRITE_CONFLICT' : 'MEMORY_BACKEND_ERROR', text);
    }
    return value;
  }
  return {
    async read(identifier, context) {
      const value = await call(context, 'read', { identifier, include_content: true, include_frontmatter: true,
        ...(context?.knownFilePath ? { known_file_path: context.knownFilePath } : {}) });
      return value ? { ...value, metadata: value.frontmatter ?? value.metadata ?? {} } : null;
    },
    write: (input, context) => call(context, 'write', input),
    edit: (input, context) => call(context, 'edit', input),
    async list(directory, context) {
      const nodes = [];
      for (let page = 1; page <= 10000; page++) {
        const value = await call(context, 'list', { dir_name: directory, depth: 1, page, page_size: 100, sort: 'updated_desc' });
        const pageNodes = Array.isArray(value) ? value : value?.nodes ?? value?.files ?? value?.results ?? [];
        nodes.push(...pageNodes);
        const more = typeof value?.has_more === 'boolean' ? value.has_more : typeof value?.total === 'number' ? page * 100 < value.total : pageNodes.length >= 100;
        if (!more || !pageNodes.length) break;
      }
      return nodes;
    },
    async search(input, context) {
      const value = await call(context, 'search', input);
      return Array.isArray(value) ? value : value?.results ?? [];
    },
    move: (input, context) => call(context, 'move', input),
  };
}

/**
 * A scratch directory under the repository's ignored .local folder. It is removed when the
 * calling test finishes, so repeated runs do not pile up fixture trees. Removal is best effort:
 * a handle still open on Windows leaves the directory behind instead of failing the test.
 */
export async function scratchDirectory(prefix) {
  const parent = path.resolve('.local');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, prefix));
  after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {}));
  return directory;
}

export function fakeTools(handler) {
  const calls = [];
  const getCalls = [];
  const tools = {
    calls,
    getCalls,
    get(name, agent) {
      getCalls.push({ name, agent });
      return {
        name,
        description: 'fake scoped tool',
        parameters: { type: 'object' },
        output: { schema: { type: 'object' }, render: () => [] },
        async execute(args, exec) {
          const input = {
            callId: exec.callId,
            rootCallId: exec.rootCallId,
            name,
            arguments: args,
            agent: exec.agent,
            signal: exec.signal,
          };
          calls.push(input);
          const result = await handler(input);
          if (result?.isError === true) {
            throw new Error(result.error?.message ?? result.content?.[0]?.text ?? 'fake tool failed');
          }
          return result?.value;
        },
      };
    },
    async execute(input) {
      calls.push(input);
      return handler(input);
    },
  };
  tools.vaultBackend=toolVaultBackend(tools);
  return tools;
}

export function ptcTools(handler) {
  const tools = fakeTools(handler);
  tools.execute = async () => {
    throw new Error('UNKNOWN_TOOL: native calls are collapsed under PTC');
  };
  return tools;
}

export function fakeLlm(outputs, finishReason = { kind: 'stop' }) {
  const calls = [];
  const queue = Array.isArray(outputs) ? [...outputs] : [outputs];
  return {
    calls,
    async *stream(options) {
      calls.push(options);
      const output = queue.length > 1 ? queue.shift() : queue[0];
      const text = typeof output === 'function' ? output(options) : output;
      if (text instanceof Error) throw text;
      for (const part of String(text ?? '').match(/[\s\S]{1,17}/g) ?? []) {
        yield { type: 'text-delta', index: 0, text: part };
      }
      yield { type: 'finish', reason: finishReason };
    },
  };
}

export function fakeAgent(sessionId, target = { provider: 'fake-provider', model: 'fake-model' }, options = {}) {
  return {
    session: {
      id: sessionId,
      requestHeader: () => ({ config: { ...target } }),
      toolHistory: () => ({}),
      ...options.session,
    },
    options: { provider: target.provider, model: target.model, ...options.agent },
  };
}

/**
 * Insert a legacy fact/event note without invoking the removed capture writer.
 * The body mirrors the former managed Markdown format so parser and soften
 * behavior keep their production inputs.
 */
export function writeLegacyMemoryNote(store, {
  memoryId = randomUUID(),
  kind = 'fact',
  status = 'active',
  category = kind === 'event' ? 'event' : 'preference',
  title = kind === 'event' ? '2026-10-17 - 虚构事件' : '饮品偏好 - 甜度',
  subject = '',
  attribute = '',
  value = '不加糖',
  occurredAt = '日期未明',
  recordedAt = '2026-10-24T04:00:00.000Z',
  recordedAtText = '2026-10-24 12:00',
  requirementScope = '',
  historyTitle = '',
  timeExpression = '',
  timeAnchor = '',
  sourceEventTime = '',
  sources = [],
  metadata = {},
  project = 'personal',
  captureFolder = 'chats',
  permalink,
  filePath,
  checksum = 'fixture-' + memoryId,
} = {}) {
  const directory = captureFolder + '/' + (kind === 'event' ? 'events' : 'facts');
  const lines = ['<!-- dsh-fact-memory -->', '# ' + title, ''];
  lines.push('- [' + category + '] ' + value);
  if (subject) lines.push('- subject: ' + subject);
  if (attribute) lines.push('- attribute: ' + attribute);
  lines.push('- 发生日期: ' + occurredAt);
  lines.push('- 记录日期: ' + recordedAtText);
  if (requirementScope) lines.push('- 适用范围: ' + requirementScope);
  if (historyTitle) lines.push('- 历史证据: [[' + historyTitle + ']]');
  if (timeExpression) lines.push('- time_expression: ' + timeExpression);
  if (timeAnchor) lines.push('- time_anchor: ' + timeAnchor);
  if (sourceEventTime) lines.push('- source_event_time: ' + sourceEventTime);
  const note = {
    title,
    permalink: permalink ?? project + '/' + directory + '/' + memoryId,
    directory,
    content: lines.join('\n').replace(/\n+$/, '') + '\n',
    frontmatter: {
      source: 'dsh',
      source_plugin: 'dsh-basic-memory-bridge',
      memory_id: memoryId,
      memory_kind: kind,
      status,
      subject,
      attribute,
      value,
      occurred_at: occurredAt,
      recorded_at: recordedAt,
      source_message_id: String(sources[0]?.message_id ?? ''),
      source_session_id: String(sources[0]?.session_id ?? ''),
      source_turn: String(sources[0]?.turn ?? ''),
      sources: JSON.stringify(sources),
      ...metadata,
    },
    tags: ['dsh-memory', kind === 'event' ? 'dsh-event' : 'dsh-fact'],
    checksum,
    updated: recordedAt,
  };
  note.filePath = filePath ?? directory + '/' + memoryId + '.md';
  store.notes.set(note.permalink, note);
  return note;
}

export function directUser(text, id = randomUUID()) {
  return { id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } };
}

export function syntheticMessage(text, kind = 'time-context') {
  return { id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind, form: 'snapshot' } };
}

export async function runPreStep(bridge, { sessionId = TARGET_SESSION, turn = 1, step = 1, messages = [directUser('hello')], agent, signal } = {}) {
  return bridge.onPreStep(
    {
      agent: agent ?? fakeAgent(sessionId),
      messages,
      turn,
      step,
      signal: signal ?? new AbortController().signal,
    },
    async () => ({ kind: 'enter', messages: [] }),
  );
}

export function turnStart(turn) {
  return { type: 'turn/start', data: { turn } };
}

export function userMessage(text, { id, time } = {}) {
  const event = { type: 'user/message', data: directUser(text, id) };
  if (time !== undefined) event.time = time;
  return event;
}

export function assistantMessage(turn, text, interrupted = false) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } },
      ...(interrupted ? { interrupted: true } : {}),
    },
  };
}

export function turnEnd(turn, kind = 'completed') {
  return { type: 'turn/end', data: { turn, reason: { kind } } };
}

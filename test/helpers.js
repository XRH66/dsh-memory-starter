import { randomUUID } from 'node:crypto';

export const TARGET_SESSION = 'session-fixture-primary';
export const OTHER_SESSION = 'session-00000000-0000-0000-0000-000000000000';

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

export function fakeTools(handler) {
  const calls = [];
  const getCalls = [];
  const tools = {
    calls,
    getCalls,
    legacyVaultToolNames:Object.freeze({
      read:'mcp__basic_memory__read_note',
      write:'mcp__basic_memory__write_note',
      edit:'mcp__basic_memory__edit_note',
      list:'mcp__basic_memory__list_directory',
      search:'mcp__basic_memory__search_notes',
      move:'mcp__basic_memory__move_note',
    }),
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
  const call=async(name,args)=>{
    const result=await handler({name:'mcp__basic_memory__'+name,arguments:args});
    return result?.value?.structuredContent?.result??result?.structuredContent?.result;
  };
  tools.vaultBackend={
    async read(identifier){
      const value=await call('read_note',{identifier});
      if(!value||value.error==='NOTE_NOT_FOUND')return null;
      return {...value,metadata:value.frontmatter??value.metadata??{}};
    },
    async write(input){
      const value=await call('write_note',input);
      if(value?.action==='conflict'||value?.error)throw Object.assign(Error(String(value.error??'write conflict')),{code:'MEMORY_WRITE_CONFLICT'});
      return value;
    },
    async edit(input){
      const value=await call('edit_note',input);
      if(value?.action==='conflict'||value?.error)throw Object.assign(Error(String(value.error??'edit conflict')),{code:'MEMORY_WRITE_CONFLICT'});
      return value;
    },
    async list(directory){
      const value=await call('list_directory',{dir_name:directory});
      return Array.isArray(value)?value:value?.nodes??[];
    },
    async search(input){
      const value=await call('search_notes',input);
      return Array.isArray(value)?value:value?.results??[];
    },
    async move(input){
      const value=await call('move_note',input);
      if(value?.error)throw Object.assign(Error(String(value.error)),{code:'MEMORY_WRITE_CONFLICT'});
      return value;
    },
  };
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

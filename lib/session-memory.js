import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isDeepStrictEqual } from 'node:util';
import { createMemoryPolicy } from './memory-policy/index.js';
import { isDirectUserMessage, contentText } from './text.js';

const disabled = () => Object.assign(new Error('本对话记忆未开启或授权已失效'), { code: 'MEMORY_DISABLED', status: 403 });
const position = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;

async function atomicWriteJson(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt++) {
      try {
        await fs.promises.rename(temporary, file);
        break;
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 30 * 2 ** attempt));
      }
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}

function readReadOnlyFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return new Set();
    throw error;
  }
  if (parsed?.version !== 1 || !Array.isArray(parsed.sessions)
    || parsed.sessions.some(sessionId => !text(sessionId))
    || new Set(parsed.sessions).size !== parsed.sessions.length) {
    throw Object.assign(Error('只读会话状态无效'), { code: 'INVALID_READ_ONLY_STATE' });
  }
  return new Set(parsed.sessions);
}

/** Positive session authorization only; no legacy opt-out, UI or memory backend.
 * directory owns management/session-memory/policy.json (and its grant journal).
 * One live host process owns this controller and the underlying policy store.
 */
export async function createSessionMemory({ directory, ownerSubject, agents, sessions, logger } = {}) {
  if (!path.isAbsolute(directory || '') || !text(ownerSubject)) throw new TypeError('Explicit directory and ownerSubject required');
  if (![agents?.get, agents?.list, agents?.isOwnedBy, sessions?.get].every(value => typeof value === 'function')) {
    throw new TypeError('Trusted agents and sessions services required');
  }
  const states = new WeakMap(), operations = new AsyncLocalStorage(), subscriptions = new Set();
  const policyFile = path.join(directory, 'management', 'session-memory', 'policy.json');
  const readOnlyFile = path.join(directory, 'management', 'session-memory', 'read-only.json');
  const readOnlyStates = readReadOnlyFile(readOnlyFile);
  let readOnlyWrites = Promise.resolve();
  let closed = false;
  const ensureOpen = () => { if (closed) throw disabled(); };

  function liveAgent(agent) {
    ensureOpen();
    if (!agent?.session || agents.get(agent.session.id) !== agent || sessions.get(agent.session.id) !== agent.session) throw disabled();
    return agent;
  }

  // Durable fork lineage never establishes runtime ownership.
  function rootAgent(agent) {
    let current = liveAgent(agent);
    const seen = new Set(), all = agents.list();
    while (true) {
      if (seen.has(current)) throw disabled();
      seen.add(current);
      const parents = all.filter(other => other !== current && agents.isOwnedBy(current.session.id, other));
      if (!parents.length) return current;
      if (parents.length !== 1) throw disabled();
      current = liveAgent(parents[0]);
    }
  }

  function state(session) {
    if (!position(session.seq) || typeof session.snapshotEvents !== 'function') throw disabled();
    let entry = states.get(session);
    if (!entry) {
      entry = { sequence: 0, turn: 0, users: new Map(), messages: new Map() };
      states.set(session, entry);
    }
    if (session.seq < entry.sequence) throw disabled();
    if (session.seq === entry.sequence) return entry;
    // Native seq is the next unassigned position. Only committed host events
    // advance turns; caller data.turn, header lineage and model arguments cannot.
    const events = session.snapshotEvents(entry.sequence, session.seq);
    if (!Array.isArray(events) || events.length !== session.seq - entry.sequence) throw disabled();
    for (const event of events) {
      if (event.seq !== entry.sequence) throw disabled();
      if (event.type === 'turn/start') {
        if (!position(event.data?.turn) || event.data.turn <= entry.turn) throw disabled();
        entry.turn = event.data.turn;
      }
      if (event.seq >= (session.inheritedEventCount || 0) && event.type === 'user/message'
        && event.surfaceOp === 'append' && isDirectUserMessage(event.data)) {
        entry.users.set(event.seq, { messageId: event.data.id || `${session.id}:event:${event.seq}`, turn: entry.turn });
        entry.messages.set(event.seq, { messageId: event.data.id || `${session.id}:event:${event.seq}`, turn: entry.turn, role: 'user' });
      }
      if (event.seq >= (session.inheritedEventCount || 0) && event.type === 'assistant/message' && event.surfaceOp === 'append'
        && event.data?.message?.role === 'assistant' && event.data.message.source?.kind === 'model' && event.data.turn === entry.turn) {
        entry.messages.set(event.seq, { messageId: event.data.message.id || `${session.id}:event:${event.seq}`, turn: entry.turn, role: 'assistant' });
      }
      entry.sequence++;
    }
    return entry;
  }

  function resolveAgent(agent) {
    const root = rootAgent(agent), own = state(agent.session), parent = state(root.session);
    return { sessionId: agent.session.id, rootSessionId: root.session.id, ownerSubject, project: 'main',
      sequence: own.sequence, turn: own.turn, rootTurn: parent.turn, historyUserOnly: true };
  }
  function resolveSession(id) {
    const agent = agents.get(id);
    if (agent) {
      if (agent.session?.id !== id) throw disabled();
      return resolveAgent(agent);
    }
    // A cached native session can be configured without starting its agent.
    // No live runtime owner means no inherited authorization from a parent.
    const session = sessions.get(id);
    if (!session || session.id !== id) throw disabled();
    const entry = state(session);
    return { sessionId: id, rootSessionId: id, ownerSubject, project: 'main', sequence: entry.sequence,
      turn: entry.turn, rootTurn: entry.turn, historyUserOnly: true };
  }

  const policy = createMemoryPolicy({ file: policyFile, resolveAgent, resolveSession });
  await policy.ready();
  let saved;
  function readSaved() {
    try { saved = JSON.parse(fs.readFileSync(policyFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; saved = { sessions: [] }; }
  }
  readSaved();
  const releaseSaved = policy.subscribe(event => {
    if (event.reason !== 'authorization-closing') readSaved();
  });

  function inactiveStatus(sessionId) {
    const record = saved.sessions.find(item => item.rootSessionId === sessionId && item.ownerSubject === ownerSubject && item.project === 'main');
    return { revision: saved.revision, sessionId, rootSessionId: sessionId, ownerSubject, project: 'main',
      explicit: Boolean(record), enabled: record?.enabled === true, effective: false, epoch: record?.epoch ?? null,
      intervals: record ? structuredClone(record.intervals) : [], readOnly: readOnlyStates.has(sessionId) };
  }

  function directSource(source, current = false) {
    if (!source || source.role !== 'user' || !text(source.sessionId) || !text(source.messageId)
      || ![source.sequence, source.turn, source.rootTurn].every(position) || source.rootTurn !== source.turn) throw disabled();
    const identity = resolveSession(source.sessionId);
    if (identity.rootSessionId !== source.sessionId) throw disabled();
    const entry = state(sessions.get(source.sessionId)), message = entry.users.get(source.sequence);
    if (!message || message.messageId !== source.messageId || message.turn !== source.turn
      || (current && source.turn !== entry.turn)) throw disabled();
    return source;
  }

  function validate(grant, source) {
    try {
      ensureOpen();
      if (!grant || grant.signal?.aborted || !['read', 'source'].includes(grant.kind)) return false;
      if (grant.kind === 'source') directSource(source ?? grant.source);
      return policy.validate(grant, source);
    } catch { return false; }
  }

  function directMessageSource(source) {
    if (!source || !['user','assistant'].includes(source.role) || !text(source.sessionId) || !text(source.messageId)
      || ![source.sequence,source.turn,source.rootTurn].every(position) || source.rootTurn!==source.turn) throw disabled();
    const identity=resolveSession(source.sessionId);
    if(identity.rootSessionId!==source.sessionId)throw disabled();
    const message=state(sessions.get(source.sessionId)).messages.get(source.sequence);
    if(!message||message.messageId!==source.messageId||message.turn!==source.turn||message.role!==source.role)throw disabled();
    return source;
  }

  function check(agent) {
    if (closed) return { allowed: false, installed: true, ready: false, epoch: null };
    const result = policy.check(agent);
    return { allowed: result.enabled === true, installed: true, ready: true, epoch: result.epoch ?? null };
  }

  function sourceFor(job) {
    if (!job || typeof job !== 'object') throw disabled();
    const source = { sessionId: job.sessionId, messageId: job.sourceMessageId, sequence: job.sourceEventSeq,
      turn: job.turn, rootTurn: job.turn, role: 'user' };
    if (!text(source.sessionId) || !text(source.messageId) || ![source.sequence, source.turn].every(position)
      || (job.rootTurn !== undefined && job.rootTurn !== job.turn)) throw disabled();
    return source;
  }

  const controller = {
    policy,
    ownerSubject,
    get ready() { return !closed; },
    check,
    isRootAgent(agent) {
      try { ensureOpen(); return rootAgent(agent) === agent; }
      catch { return false; }
    },
    historyPolicy(_agent) { return { installed: true, userOnly: true }; },
    status(sessionId) {
      ensureOpen();
      if (!text(sessionId)) throw disabled();
      let result;
      try { result = policy.status(sessionId); } catch { result = inactiveStatus(sessionId); }
      return { ...result, requested: result.enabled, enabled: result.enabled,
        active: Boolean(agents.get(sessionId) && result.effective),
        pending: Boolean(result.enabled&&!result.effective),
        effective: 'next-user-turn', defaultEnabled: false, installed: true, ready: true,
        readOnly: readOnlyStates.has(sessionId) };
    },
    enabledSessionIds() {
      return saved.sessions.filter(item => item.enabled === true && item.ownerSubject === ownerSubject && item.project === 'main')
        .map(item => item.rootSessionId);
    },
    async autoEnable(agent) {
      try {
        ensureOpen();
        const id = agent?.session?.id;
        if (typeof id !== 'string' || !/^session-[a-zA-Z0-9_-]+$/.test(id)
          || agents.get(id) !== agent || sessions.get(id) !== agent.session
          || rootAgent(agent) !== agent || agent.session.inheritedEventCount) return false;
        const current = state(agent.session);
        if (current.turn !== 0 || current.users.size !== 0
          || saved.sessions.some(item => item.rootSessionId === id && item.ownerSubject === ownerSubject && item.project === 'main')) return false;
        await policy.set(id, true);
        readSaved();
        return true;
      } catch {
        return false;
      }
    },
    async set(sessionId, enabled) {
      ensureOpen();
      if (!text(sessionId) || typeof enabled !== 'boolean') throw disabled();
      if (!enabled && sessions.get(sessionId)) {
        // A cached real session is sufficient to revoke synchronously. Do not
        // put an awaited loader in front of policy's immediate closing notice.
        resolveSession(sessionId);
        const saving = policy.set(sessionId, false);
        try {
          if (typeof sessions.ensure === 'function') await sessions.ensure(sessionId);
        } finally { await saving; }
      } else {
        if (typeof sessions.ensure === 'function') await sessions.ensure(sessionId);
        ensureOpen();
        resolveSession(sessionId);
        await policy.set(sessionId, enabled);
      }
      readSaved();
      return controller.status(sessionId);
    },
    isReadOnly(sessionId) {
      ensureOpen();
      if (!text(sessionId)) throw disabled();
      return readOnlyStates.has(sessionId);
    },
    async setReadOnly(sessionId, readOnly) {
      ensureOpen();
      if (!text(sessionId) || typeof readOnly !== 'boolean') throw disabled();
      if (typeof sessions.ensure === 'function') await sessions.ensure(sessionId);
      ensureOpen();
      resolveSession(sessionId);
      const operation = readOnlyWrites.then(async () => {
        ensureOpen();
        const next = new Set(readOnlyStates);
        if (readOnly) next.add(sessionId);
        else next.delete(sessionId);
        await atomicWriteJson(readOnlyFile, { version: 1, sessions: [...next].sort() });
        readOnlyStates.clear();
        for (const id of next) readOnlyStates.add(id);
      });
      readOnlyWrites = operation.catch(() => {});
      await operation;
      return controller.status(sessionId);
    },
    observe(session, event) {
      try {
        ensureOpen();
        if (!session || sessions.get(session.id) !== session || !position(event?.seq) || event.seq >= session.seq) return false;
        const recorded = session.snapshotEvents(event.seq, event.seq + 1)[0];
        if (!isDeepStrictEqual(recorded, event)) return false;
        state(session);
        return true;
      } catch (error) {
        logger?.warn?.('[session-memory] 无法核实宿主事件：' + (error.code || 'invalid-host-event'));
        return false;
      }
    },
    admitMessage(session,event) {
      ensureOpen();
      if(!session||sessions.get(session.id)!==session||!position(event?.seq)||event.seq>=session.seq)throw disabled();
      const current=state(session),message=current.messages.get(event.seq);
      if(!message||message.turn!==current.turn)return null;
      const agent=agents.get(session.id);
      if(!agent||rootAgent(agent)!==agent||!check(agent).allowed)return null;
      const recorded=session.snapshotEvents(event.seq,event.seq+1)[0];
      if(!isDeepStrictEqual(recorded,event))throw disabled();
      const coordinates={sessionId:session.id,messageId:message.messageId,sequence:event.seq,
        turn:message.turn,rootTurn:message.turn,role:message.role};
      directMessageSource(coordinates);
      const grant=policy.grantMessage(agent,coordinates);
      const body=message.role==='user'?recorded.data:recorded.data.message;
      const time=typeof recorded.time==='number'&&Number.isFinite(recorded.time)?recorded.time:null;
      return {grant,source:{...coordinates,ownerSubject:grant.ownerSubject,project:grant.project,
        text:contentText(body.content),content:structuredClone(body.content),origin:structuredClone(body.source??null),
        time,messageState:recorded.data.interrupted===true?'interrupted':'committed',authorization:JSON.parse(JSON.stringify(grant))}};
    },
    validateMessage(grant,source) {
      try{ensureOpen();if(grant?.kind!=='message-source'||grant.signal?.aborted)return false;
        directMessageSource(source??grant.source);return policy.validate(grant,source);
      }catch{return false;}
    },
    grant(agent, source) {
      ensureOpen();
      if (source !== undefined) directSource(source, true);
      // Return the original object: its non-enumerable signal/cancel belong to
      // policy. JSON.stringify keeps the durable credential, not the signal.
      return policy.grant(agent, source);
    },
    validate,
    sourceFor,
    checkSource(job) {
      try {
        if (job?.memoryAuthorization?.kind !== 'source') return false;
        return validate(job.memoryAuthorization, sourceFor(job));
      } catch { return false; }
    },
    withGrant(grant, work) {
      if (typeof work !== 'function') throw new TypeError('Operation callback required');
      if (!validate(grant)) throw disabled();
      return operations.run({ grant }, work);
    },
    assertCurrent(agent) {
      const context = operations.getStore();
      if (context) {
        if (!validate(context.grant)) throw disabled();
        if (agent !== undefined) {
          let identity;
          try { identity = resolveAgent(agent); } catch { throw disabled(); }
          if (identity.rootSessionId !== context.grant.rootSessionId) throw disabled();
        }
      } else if (!check(agent).allowed) throw disabled();
      return true;
    },
    subscribe(listener) {
      ensureOpen();
      const unsubscribe = policy.subscribe(listener);
      const release = () => { unsubscribe(); subscriptions.delete(release); };
      subscriptions.add(release);
      return release;
    },
    close() {
      closed = true;
      releaseSaved();
      for (const release of subscriptions) release();
      // Do not cancel persisted source credentials or change user choices on
      // process shutdown: reopened controllers must validate queued work.
    },
  };
  return controller;
}

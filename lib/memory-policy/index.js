import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createUnifiedStateStore } from '../unified/state-store.js';
import { memoryError, requiredText, sourcePosition } from '../unified/contract.js';

const denied = () => memoryError('MEMORY_NOT_AUTHORIZED', '当前会话或来源未获准使用记忆', 403);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const sameScope = (a, b) => a.rootSessionId === b.rootSessionId &&
  a.ownerSubject === b.ownerSubject && a.project === b.project;

function identity(value) {
  if (!value || typeof value !== 'object') throw denied();
  const result = {};
  for (const key of ['sessionId', 'rootSessionId', 'ownerSubject', 'project']) {
    result[key] = requiredText(value[key], key);
  }
  for (const key of ['sequence', 'turn', 'rootTurn']) result[key] = sourcePosition(value[key]);
  if (result.sessionId === result.rootSessionId && result.turn !== result.rootTurn) throw denied();
  result.historyUserOnly = value.historyUserOnly !== false;
  return result;
}

function sourceCoordinates(source) {
  if (!source || typeof source !== 'object') throw denied();
  const result = {
    sessionId: requiredText(source.sessionId, '来源会话'),
    messageId: requiredText(source.messageId, '来源消息'),
    sequence: sourcePosition(source.sequence),
    turn: sourcePosition(source.turn),
    rootTurn: sourcePosition(source.rootTurn),
    role: source.role,
  };
  if (result.role !== 'user' && result.role !== 'assistant') throw denied();
  return result;
}

function validateState(state) {
  if (!Array.isArray(state.sessions)) throw memoryError('INVALID_MEMORY_STATE', '授权记录无效');
  const roots = new Set();
  for (const record of state.sessions) {
    for (const key of ['rootSessionId', 'ownerSubject', 'project', 'epoch']) requiredText(record[key], key);
    if (roots.has(record.rootSessionId) || typeof record.enabled !== 'boolean' || !Array.isArray(record.intervals)) {
      throw memoryError('INVALID_MEMORY_STATE', '授权区间无效');
    }
    roots.add(record.rootSessionId);
    const ids = new Set();
    let previous;
    for (const interval of record.intervals) {
      requiredText(interval.id, '区间');
      requiredText(interval.openedAt, '开启时间');
      sourcePosition(interval.startSequence); sourcePosition(interval.startTurn);
      if (ids.has(interval.id) || typeof interval.historyUserOnly !== 'boolean') throw denied();
      ids.add(interval.id);
      if (previous && (previous.endTurn === null || interval.startTurn < previous.endTurn ||
          interval.startSequence < previous.endSequence)) throw denied();
      if (interval.endTurn !== null) {
        sourcePosition(interval.endTurn); sourcePosition(interval.endSequence);
        if (interval.endTurn < interval.startTurn || interval.endSequence < interval.startSequence) throw denied();
        requiredText(interval.closedAt, '关闭时间');
      } else if (interval.endSequence !== null || interval !== record.intervals.at(-1)) throw denied();
      previous = interval;
    }
    if (record.enabled !== Boolean(previous && previous.endTurn === null)) throw denied();
  }
}

/** Resolver inputs and source coordinates are host-owned, never model tool arguments.
 * The append-only grant journal contains metadata only. It lets synchronous grant()
 * durably register exact credentials without racing the asynchronous policy store.
 */
export function createMemoryPolicy({ file, resolveAgent, resolveSession, authorizeManagement = () => false, now = Date.now }) {
  if (typeof resolveAgent !== 'function' || typeof resolveSession !== 'function') throw new TypeError('Host resolvers required');
  const store = createUnifiedStateStore({ file, initial: () => ({ sessions: [] }), validate: validateState });
  const journal = file + '.grants.jsonl';
  const issued = new Map(), live = new Map(), revoked = new Set(), listeners = new Set(), pending = new Map();
  let initialized = false, loading;
  const timestamp = () => new Date(now()).toISOString();
  const rootRecord = (state, id) => state.sessions.find(item => item.rootSessionId === id);

  function management(grant) {
    if (!initialized || authorizeManagement(grant) !== true || grant?.signal?.aborted) throw denied();
    requiredText(grant.ownerSubject, '主体'); requiredText(grant.project, '项目');
    return grant;
  }
  function register(grant) {
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.appendFileSync(journal, JSON.stringify({ type: 'issue', grant }) + '\n', { mode: 0o600 });
    issued.set(grant.id, structuredClone(grant));
    const controller = new AbortController();
    live.set(grant.id, { rootSessionId: grant.rootSessionId, controller, historical: grant.kind === 'historical' });
    const id = grant.id;
    Object.defineProperties(grant, {
      signal: { value: controller.signal },
      cancel: { value: () => cancel(id) },
    });
    return grant;
  }
  function cancel(id) {
    revoked.add(id); issued.delete(id);
    live.get(id)?.controller.abort('cancelled'); live.delete(id);
    fs.appendFileSync(journal, JSON.stringify({ type: 'cancel', id }) + '\n', { mode: 0o600 });
  }
  function historicalScope(grant, source) {
    return (!own(source, 'ownerSubject') || source.ownerSubject === grant.ownerSubject)
      && (!own(source, 'project') || source.project === grant.project)
      && (!own(source, 'rootSessionId') || source.rootSessionId === grant.rootSessionId);
  }

  function resolved(sessionId) {
    const result = identity(resolveSession(sessionId));
    if (result.sessionId !== sessionId) throw denied();
    return result;
  }
  function context(actor) {
    const session = identity(actor);
    const fresh = resolved(session.sessionId), root = resolved(session.rootSessionId);
    if (!isDeepStrictEqual(session, fresh) || !sameScope(session, root) || root.sessionId !== root.rootSessionId ||
        session.rootTurn > root.turn) throw denied();
    return { session, root };
  }
  function active(actor) {
    if (!initialized) throw denied();
    const ctx = context(actor);
    const record = rootRecord(store.snapshot(), ctx.root.sessionId);
    const interval = record?.intervals.at(-1);
    // Sequence bounds are half-open; enabling still requires a subsequent root turn.
    if (pending.has(ctx.root.sessionId) || !record?.enabled || !sameScope(record, ctx.root) ||
        ctx.session.rootTurn <= interval.startTurn || ctx.root.turn <= interval.startTurn ||
        ctx.root.sequence <= interval.startSequence) throw denied();
    return { ...ctx, record, interval };
  }
  function notify(rootSessionId, epoch, reason) {
    // Includes credentials restored from disk, which have no live AbortController.
    for (const [id, grant] of issued) if (grant.kind !== 'historical' && grant.rootSessionId === rootSessionId) revoked.add(id);
    for (const [id, item] of live) {
      if (!item.historical && item.rootSessionId === rootSessionId) {
        item.controller.abort(reason); live.delete(id);
      }
    }
    const event = Object.freeze({ rootSessionId, epoch, reason });
    for (const listener of listeners) {
      try { listener(event); } catch { /* Listeners cannot undo a revocation. */ }
    }
  }
  function admitted(ctx, source, { message = false } = {}) {
    const coordinates = sourceCoordinates(source);
    // Owned children may search and process root sources. Their execution outputs
    // are not admitted experiences: child sequences cannot prove a root cutoff.
    if (coordinates.sessionId !== ctx.root.sessionId) throw denied();
    const sourceSession = resolved(coordinates.sessionId);
    const sourceRoot = resolved(sourceSession.rootSessionId);
    for (const key of ['ownerSubject', 'project', 'rootSessionId']) {
      if (own(source, key) && source[key] !== ctx.root[key]) throw denied();
    }
    if (!sameScope(sourceSession, ctx.root) || !sameScope(sourceRoot, ctx.root) ||
        sourceRoot.sessionId !== ctx.root.sessionId || coordinates.sequence >= sourceSession.sequence ||
        coordinates.turn > sourceSession.turn || coordinates.rootTurn > sourceSession.rootTurn ||
        coordinates.rootTurn > ctx.root.turn ||
        (sourceSession.sessionId === sourceSession.rootSessionId && coordinates.rootTurn !== coordinates.turn)) throw denied();
    const interval = ctx.record.intervals.find(item => coordinates.rootTurn > item.startTurn &&
      (item.endTurn === null || coordinates.rootTurn <= item.endTurn) &&
      // DSH sequence is the next unassigned position, including when opening/closing.
      coordinates.sequence >= item.startSequence &&
      (item.endSequence === null || coordinates.sequence < item.endSequence));
    if (!interval || (own(source, 'intervalId') && source.intervalId !== interval.id)) throw denied();
    const historyUserOnly = ctx.session.historyUserOnly || ctx.root.historyUserOnly ||
      ctx.interval.historyUserOnly || sourceSession.historyUserOnly || interval.historyUserOnly;
    if (!message && historyUserOnly && coordinates.role !== 'user') throw denied();
    return { coordinates, interval, historyUserOnly };
  }

  const api = {
    async ready() {
      loading ||= (async () => {
        await store.read();
        let text;
        try { text = await fs.promises.readFile(journal, 'utf8'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
        for (const line of text.split('\n')) {
          if (!line) continue;
          const entry = JSON.parse(line);
          if (entry?.type === 'issue' && typeof entry.grant?.id === 'string' && !issued.has(entry.grant.id)) {
            issued.set(entry.grant.id, entry.grant);
          } else if (entry?.type === 'cancel' && typeof entry.id === 'string') issued.delete(entry.id);
          else throw memoryError('INVALID_MEMORY_GRANT_JOURNAL', '授权凭据记录无效');
        }
        initialized = true;
      })();
      await loading;
    },
    status(sessionId) {
      if (!initialized) throw memoryError('MEMORY_NOT_READY', '记忆授权尚未就绪', 503);
      const { session, root } = context(resolved(sessionId));
      const state = store.snapshot(), record = rootRecord(state, root.sessionId);
      const matches = record && sameScope(record, root);
      let effective = false;
      try { active(session); effective = true; } catch { /* Default closed. */ }
      return {
        revision: state.revision, sessionId: session.sessionId, rootSessionId: root.sessionId,
        ownerSubject: root.ownerSubject, project: root.project, explicit: Boolean(matches),
        enabled: Boolean(matches && record.enabled), effective,
        epoch: matches ? record.epoch : null, intervals: matches ? structuredClone(record.intervals) : [],
      };
    },
    async set(sessionId, enabled, { expectedRevision } = {}) {
      if (!initialized) throw memoryError('MEMORY_NOT_READY', '记忆授权尚未就绪', 503);
      if (typeof enabled !== 'boolean') throw memoryError('INVALID_MEMORY_VALUE', '开启状态必须为布尔值');
      const initial = resolved(sessionId);
      if (initial.sessionId !== initial.rootSessionId) throw denied();
      if (expectedRevision !== undefined && expectedRevision !== store.snapshot().revision) {
        throw memoryError('MEMORY_REVISION_CONFLICT', '设置已变化，请刷新后重试', 409);
      }
      pending.set(sessionId, (pending.get(sessionId) || 0) + 1);
      if (!enabled) notify(sessionId, null, 'authorization-closing');
      try {
        const { result } = await store.update(state => {
          const { root } = context(resolved(sessionId));
          if (!sameScope(initial, root)) throw denied();
          let record = rootRecord(state, sessionId);
          if (record && !sameScope(record, root)) throw denied();
          if (!record) {
            record = { rootSessionId: sessionId, ownerSubject: root.ownerSubject, project: root.project,
              enabled: false, epoch: randomUUID(), intervals: [] };
            state.sessions.push(record);
          }
          if (record.enabled === enabled) return { epoch: record.epoch, changed: false };
          const date = timestamp();
          if (enabled) {
            const previous = record.intervals.at(-1);
            if (previous && (root.turn < previous.endTurn || root.sequence < previous.endSequence)) throw denied();
            record.intervals.push({ id: randomUUID(), startSequence: root.sequence, startTurn: root.turn,
              endSequence: null, endTurn: null, openedAt: date, closedAt: null,
              historyUserOnly: root.historyUserOnly });
          } else {
            const interval = record.intervals.at(-1);
            if (root.turn < interval.startTurn || root.sequence < interval.startSequence) throw denied();
            interval.endSequence = root.sequence; interval.endTurn = root.turn; interval.closedAt = date;
          }
          record.enabled = enabled; record.epoch = randomUUID();
          return { epoch: record.epoch, changed: true };
        }, { expectedRevision });
        if (result.changed) notify(sessionId, result.epoch, enabled ? 'authorization-opened' : 'authorization-closed');
      } finally {
        const count = pending.get(sessionId) - 1;
        if (count) pending.set(sessionId, count); else pending.delete(sessionId);
      }
      return api.status(sessionId);
    },
    check(agent) {
      let known;
      try {
        known = context(resolveAgent(agent));
        const ctx = active(known.session);
        return { enabled: true, sessionId: ctx.session.sessionId, rootSessionId: ctx.root.sessionId,
          ownerSubject: ctx.root.ownerSubject, project: ctx.root.project, epoch: ctx.record.epoch,
          historyUserOnly: ctx.session.historyUserOnly || ctx.root.historyUserOnly || ctx.interval.historyUserOnly };
      } catch {
        if (!known) return { enabled: false };
        return { enabled: false, sessionId: known.session.sessionId, rootSessionId: known.root.sessionId,
          ownerSubject: known.root.ownerSubject, project: known.root.project, epoch: null,
          historyUserOnly: true };
      }
    },
    grant(agent, source) {
      try {
        const ctx = active(resolveAgent(agent));
        const admittedSource = source === undefined ? null : admitted(ctx, source);
        const grant = {
          version: 1, id: randomUUID(), kind: admittedSource ? 'source' : 'read',
          sessionId: ctx.session.sessionId, rootSessionId: ctx.root.sessionId,
          ownerSubject: ctx.root.ownerSubject, project: ctx.root.project, epoch: ctx.record.epoch,
          historyUserOnly: admittedSource?.historyUserOnly ??
            (ctx.session.historyUserOnly || ctx.root.historyUserOnly || ctx.interval.historyUserOnly),
          issuedAt: timestamp(), intervalId: admittedSource?.interval.id ?? ctx.interval.id,
          ...(admittedSource ? { source: admittedSource.coordinates } : {}),
        };
        return register(grant);
      } catch (error) {
        if (error?.code && error.status) throw error;
        throw memoryError('MEMORY_GRANT_FAILED', '无法持久保存或核实授权凭据', 503);
      }
    },
    grantMessage(agent, source) {
      const ctx = active(resolveAgent(agent)), item = admitted(ctx, source, { message: true });
      // Only a current root message may mint this credential. It cannot turn
      // old transcript, a closed interval, or a child's output into new input.
      if (ctx.session.sessionId !== ctx.root.sessionId || item.interval.id !== ctx.interval.id ||
          item.coordinates.turn !== ctx.root.turn || item.coordinates.rootTurn !== ctx.root.turn) throw denied();
      return register({ version: 1, id: randomUUID(), kind: 'message-source',
        sessionId: ctx.session.sessionId, rootSessionId: ctx.root.sessionId,
        ownerSubject: ctx.root.ownerSubject, project: ctx.root.project, epoch: ctx.record.epoch,
        historyUserOnly: false, issuedAt: timestamp(), intervalId: item.interval.id, source: item.coordinates });
    },
    issueHistorical(source, { managementGrant, selectionId, allowAssistant = false } = {}) {
      const manager = management(managementGrant);
      requiredText(selectionId, '选定资料');
      const coordinates = sourceCoordinates(source);
      if (!historicalScope({ ...manager, rootSessionId: coordinates.sessionId }, source)
        || (coordinates.role === 'assistant' && allowAssistant !== true)
        || coordinates.rootTurn !== coordinates.turn) throw denied();
      const existing = api.getHistorical(source, { managementGrant, selectionId, allowAssistant });
      if (existing) return existing;
      return register({ version: 1, id: randomUUID(), kind: 'historical', selectionId,
        sessionId: coordinates.sessionId, rootSessionId: coordinates.sessionId,
        ownerSubject: manager.ownerSubject, project: manager.project,
        historyUserOnly: allowAssistant !== true, issuedAt: timestamp(), source: coordinates });
    },
    getHistorical(source, { managementGrant, selectionId, allowAssistant = false } = {}) {
      const manager = management(managementGrant);
      requiredText(selectionId, '选定资料');
      const coordinates = sourceCoordinates(source);
      if (!historicalScope({ ...manager, rootSessionId: coordinates.sessionId }, source)) throw denied();
      for (const grant of issued.values()) {
        if (grant.kind === 'historical' && grant.selectionId === selectionId && grant.ownerSubject === manager.ownerSubject
          && grant.project === manager.project && !revoked.has(grant.id)
          && (grant.source.role === 'user' || allowAssistant === true)
          && isDeepStrictEqual(grant.source, coordinates)) return structuredClone(grant);
      }
      return null;
    },
    revokeHistorical(selectionId, { managementGrant } = {}) {
      const manager = management(managementGrant); requiredText(selectionId, '选定资料');
      let count = 0;
      for (const grant of [...issued.values()]) if (grant.kind === 'historical' && grant.selectionId === selectionId
        && grant.ownerSubject === manager.ownerSubject && grant.project === manager.project) { cancel(grant.id); count++; }
      const event = Object.freeze({ selectionId, ownerSubject: manager.ownerSubject, project: manager.project, reason: 'historical-revoked' });
      for (const listener of listeners) { try { listener(event); } catch { /* Revocation is final. */ } }
      return { revoked: count };
    },
    validate(grant, source) {
      try {
        if (!initialized || !grant || typeof grant !== 'object') return false;
        const expected = issued.get(grant.id);
        if (!expected || revoked.has(grant.id) || !isDeepStrictEqual({ ...grant }, expected)) return false;
        if (grant.kind === 'historical') return source === undefined || historicalScope(grant, source)
          && isDeepStrictEqual(sourceCoordinates(source), grant.source);
        const ctx = active(resolved(grant.sessionId));
        if (!sameScope(grant, ctx.root) || grant.epoch !== ctx.record.epoch) return false;
        if (grant.kind === 'read') return source === undefined && grant.intervalId === ctx.interval.id;
        if (!['source', 'message-source'].includes(grant.kind) || !own(grant, 'source')) return false;
        if (source !== undefined && !isDeepStrictEqual(sourceCoordinates(source), grant.source)) return false;
        const admittedSource = admitted(ctx, source === undefined ? grant.source : source, { message: grant.kind === 'message-source' });
        return admittedSource.interval.id === grant.intervalId &&
          (grant.kind === 'message-source' || !admittedSource.historyUserOnly || grant.source.role === 'user');
      } catch { return false; }
    },
    subscribe(listener) {
      if (typeof listener !== 'function') throw new TypeError('Listener required');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return api;
}

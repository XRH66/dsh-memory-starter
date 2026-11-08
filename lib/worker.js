import { captureTurn } from './capture.js';
import { ensureProcessingScope, processingTargetMode, resolveProcessingTarget } from './processing-model.js';
import { maintainIndexes } from './maintenance.js';
import { createRecoveryStore, jobId, observeLocalFacts, retryDelay, mergePending } from './recovery.js';
import { measuredLlm } from './usage.js';
import { retryDue, retryPaused } from './recovery.js';
import { requestedIndexTopic } from './index-pages.js';
import { memoryCall } from './navigation.js';
import { randomUUID } from 'node:crypto';

export const memoryJobSource = job => ({sessionId:job.sessionId,messageId:job.sourceMessageId,sequence:job.sourceEventSeq,turn:job.turn,rootTurn:job.turn,role:'user'});
export const hasSessionMemory = access => typeof access?.grant === 'function' && typeof access?.validate === 'function';
export function memoryRevoked() { return Object.assign(new Error('MEMORY_AUTHORIZATION_REVOKED'),{code:'MEMORY_AUTHORIZATION_REVOKED'}); }
/** The wrapper keeps the original grant across every asynchronous tool boundary. */
export function authorizedTools(tools, access, grant, agent, assertExtra = () => {}) {
  if (!hasSessionMemory(access)) return tools;
  const assert = () => { if (!grant || !access.validate(grant)) throw memoryRevoked(); access.assertCurrent(agent); assertExtra(); };
  return {get(name, owner = agent) {
    const definition = tools?.get?.(name,owner);
    if (!definition) return definition;
    return {...definition,async execute(args,exec = {}) {
      return access.withGrant(grant,async () => {
        assert();
        const signal = AbortSignal.any([exec.signal,grant.signal].filter(Boolean));
        const result = await definition.execute(args,{...exec,signal,memoryAuthorization:() => {try {assert();return true;} catch {return false;}}});
        assert();
        return result;
      });
    }};
  }};
}
function authorizedLlm(llm,access,grant,agent,assertExtra=()=>{}) {
  if (!hasSessionMemory(access)) return llm;
  return {get memoryProcessingCapabilities(){return llm?.memoryProcessingCapabilities;},async *stream(options) {
    const assert = () => {if(!access.validate(grant))throw memoryRevoked();access.assertCurrent(agent);assertExtra();};
    assert();
    const signal=AbortSignal.any([options.signal,grant.signal].filter(Boolean));
    for await(const chunk of llm.stream({...options,signal})) {assert();yield chunk;}
    assert();
  }};
}

/** Reuses the mounted MCP scope and original model; never starts a chat turn. */
export function createMemoryWorker({ config, tools, llm, logger, now, status, available, findAgent, recoveryStore, captureSubject, maintenanceOwnerAllowed, maintenanceScope, observationEnabled, protectedPending, historyPolicy, accessAllowed, sourceAccess, access,canProcess=()=>true }) {
  const store = recoveryStore || createRecoveryStore(config);
  const runners = new Map();
  const incoming = new Map();
  const heldReported = new Set();
  const liveGrants = new Map(), grantReleases = new WeakMap();
  const gated = hasSessionMemory(access);
  const sourceAllowed = job => {try{return !gated || Boolean(access.checkSource(job));}catch{return false;}};
  const grantFor = (job,agent) => {
    if(!sourceAllowed(job))throw memoryRevoked();
    // Resume the credential issued on the original foreground turn. Issuing a
    // new one here would silently reauthorize old work under today's selection.
    const grant = liveGrants.get(job.memoryAuthorization.id) || {...job.memoryAuthorization};
    if(!grant || !access.validate(grant,memoryJobSource(job)))throw memoryRevoked();
    if(!grant.signal) {
      const controller=new AbortController();
      Object.defineProperty(grant,'signal',{value:controller.signal});
      const release=access.subscribe?.(()=>{if(!sourceAllowed(job))controller.abort(memoryRevoked());});
      if(release)grantReleases.set(grant,release);
      if(!sourceAllowed(job)){controller.abort(memoryRevoked());release?.();throw memoryRevoked();}
    }
    return grant;
  };
  let chain = Promise.resolve(), stopped = false, scheduled = 0;
  const warn = (error) => logger?.warn?.('[basic-memory-bridge] recovery pending: ' + (error.code || error.message));
  async function getConfig() {
    const processingScopeId = await ensureProcessingScope(store);
    let state = await store.read();
    if (!state.naturalDecayStartedAt) {
      await store.update(s => { s.naturalDecayStartedAt ||= new Date(typeof now === 'function' ? now() : now ?? Date.now()).toISOString(); });
      state = await store.read();
    }
    return { ...config, processingScopeId, naturalDecayStartedAt: state.naturalDecayStartedAt, now: typeof now === 'function' ? now() : now };
  }
  function serialize(fn) {
    scheduled++;
    const run = chain.then(fn, fn).finally(() => { scheduled--; });
    chain = run.catch(warn);
    return run;
  }
  function runner(id) {
    if(id&&maintenanceOwnerAllowed&&!maintenanceOwnerAllowed(id))return null;
    const own = runners.get(id) || (id ? findAgent?.(id) : null);
    if (own) {
      if (!available(own)||(maintenanceOwnerAllowed&&!maintenanceOwnerAllowed(own.session?.id))) return null;
      runners.set(own.session.id, own);
      return own;
    }
    // Same personal project, still gated by a currently mounted Basic Memory scope.
    if(gated)return null;
    return [...runners.values()].reverse().find(agent=>available(agent)&&(!maintenanceOwnerAllowed||maintenanceOwnerAllowed(agent.session?.id)));
  }
  /** Exact host agent for the original session, never a cross-session fallback. */
  function exactAgent(id) {
    if (!id) return null;
    const known = runners.get(id);
    if (known?.session?.id === id) return known;
    const found = findAgent?.(id);
    return found?.session?.id === id ? found : null;
  }
  async function restoreJobTarget(job) {
    if (job.target != null) return null;
    // requestHeader() is the latest folded header, not this queued turn's
    // historical target. Even the original agent cannot prove that target here.
    const reason = '后台处理目标未冻结，缺少原回合可核实的模型快照；任务保留，未借用当前或其他会话线路';
    if (job.reason !== reason) await store.update(s => {
      const saved = s.jobs.find(j => j.id === job.id);
      if (saved) saved.reason = reason;
    });
    return reason;
  }
  /**
   * Decide how a queued job may use history. New jobs carry the decision made
   * on their foreground turn. Jobs persisted before that marker are resolved
   * from the original session's own agent only; if the installed pure service
   * cannot prove a normal session, the job is held instead of trusting stored
   * assistant text. Prepared legacy actions are never replayed under strict
   * policy because they may already encode assistant history.
   */
  function resolveJobHistory(job) {
    if (job.historyPolicy === 'user-only') return { trusted:true, userOnly:true, reason:'user-only' };
    if (job.historyPolicy === 'conversation') return { trusted:true, userOnly:false, reason:'conversation' };
    const exact = exactAgent(job.sessionId);
    if (!exact) {
      const probe = typeof historyPolicy === 'function' ? historyPolicy(undefined) : null;
      if (probe?.installed === false) return { legacy:true, trusted:true, userOnly:false, reason:'no-pure-service' };
      return { legacy:true, trusted:false, userOnly:true, hold:'history-policy-unavailable' };
    }
    let allowed = true;
    try { allowed = typeof accessAllowed === 'function' ? accessAllowed(exact) : true; }
    catch { allowed = false; }
    if (!allowed) return { legacy:true, trusted:true, userOnly:true, hold:'session-not-allowed' };
    let policy;
    try { policy = typeof historyPolicy === 'function' ? historyPolicy(exact) : null; }
    catch { policy = { installed:true, userOnly:true, reason:'policy-failed' }; }
    if (!policy || policy.installed === false) return { legacy:true, trusted:true, userOnly:false, reason:'no-pure-service' };
    const resolved = { legacy:true, trusted:true, userOnly:policy.userOnly === true, reason:policy.reason || '' };
    if (resolved.userOnly && (job.actions?.length || Object.keys(job.completed || {}).length)) {
      return { ...resolved, hold:'history-policy-legacy-prepared' };
    }
    return resolved;
  }
  function maintenanceAllowed(item,state){
    if(gated && (!item.owners?.length || !item.owners.every(sourceAllowed)))return false;
    return !maintenanceOwnerAllowed||(item.owners?.length?item.owners.every(owner=>maintenanceOwnerAllowed(owner.sessionId,item)):Boolean(state.lastSessionId&&maintenanceOwnerAllowed(state.lastSessionId,item)));
  }
  function suspendedRevision(state, revision){return (state.suspendedIndexMaintenance||[]).some(plan=>plan.changes?.some(change=>change.revision===revision));}
  async function observe() {
    if(!gated)return observeLocalFacts(config,store,{scope:maintenanceScope??'personal',protectedPending});
    const grant=[...liveGrants.values()].reverse().find(value=>access.validate(value));
    if(!grant)return;
    return observeLocalFacts(config,store,{scope:maintenanceScope??'personal',protectedPending,
      assertAuthorized:()=>{if(!access.validate(grant))throw memoryRevoked();}});
  }
  async function pendingStatus() {
    const s = await store.read();
    const owners = new Map();
    for (const p of s.pending) for (const o of p.owners) {
      if (!owners.has(o.sessionId)) owners.set(o.sessionId, []);
      owners.get(o.sessionId).push(p);
    }
    for (const [id, pending] of owners) await status.pending(id, pending);
  }
  async function runCapture(job, agent, policy = resolveJobHistory(job), preparedOnly = false) {
    if(!gated)return runCaptureInner(job,agent,policy);
    const grant=grantFor(job,agent);
    try{return await access.withGrant(grant,()=>runCaptureInner(job,agent,policy,grant,preparedOnly));}
    finally{grantReleases.get(grant)?.();grantReleases.delete(grant);}
  }
  async function runCaptureInner(job, agent, policy, grant, preparedOnly = false) {
    const assert=()=>{if(gated){if((preparedOnly&&stopped)||!sourceAllowed(job))throw memoryRevoked();access.assertCurrent(agent);}};
    assert();
    const userOnly = policy?.userOnly === true;
    // A pre-upgrade payload that must be re-extracted under strict policy cannot
    // reuse its old prepared actions or completion checkpoints: both may encode
    // the assistant answer or earlier conversation.
    const reextract = policy?.legacy === true && userOnly;
    await status.set(job.sessionId, job.turn, { state: 'processing', retryAttempt: job.attempts || 0, nextRetryAt: null,
      ...(userOnly ? { historyPolicy: 'user-only' } : {}) });
    const state = await store.read();
    const result = await captureTurn({
      ...job, agent, config: await getConfig(), target: job.target,
      assistantText: userOnly ? '' : job.assistantText,
      priorUserMessages: userOnly ? [] : job.priorUserMessages,
      priorUserSourceIds: userOnly ? [] : job.priorUserSourceIds,
      historyUserOnly: userOnly,
      sourceAccess:sourceAccess?input=>{assert();return sourceAccess(input);}:undefined,
      subject: captureSubject?.(job),
      tools:authorizedTools(tools,access,grant,agent,assert), llm: preparedOnly ? undefined : measuredLlm(authorizedLlm(llm,access,grant,agent,assert), record => status.usage(job.sessionId, job.turn, record), { phase: 'capture', retry: (job.attempts || 0) > 0 || Boolean(job.manualResumes) }), logger, now,
      recovery: {
        id: job.id,
        actions: reextract ? undefined : job.actions,
        completed: reextract ? {} : job.completed,
        externalEdits: Object.fromEntries(Object.entries(state.observed).map(([k, v]) => [k, v.externalEditedAt || 0])),
        prepare: (actions) => {assert();return store.prepare(job.id, actions);},
        checkpoint: (index, value) => {assert();return store.checkpoint(job.id, index, value);},
      },
    });
    assert();
    const success = !result.partial && (result.persisted || ['no-durable-actions', 'superseded'].includes(result.reason));
    if (preparedOnly && !success) return result.reason === 'source-invalid' ? 'legacy-source-changed' : 'legacy-commit-unconfirmed';
    const fresh = (await store.read()).jobs.find((j) => j.id === job.id);
    const completed = Object.values(fresh?.completed || {});
    const count = completed.filter((r) => !r.skipped && !r.duplicate && !r.metadataOnly).length;
    const reinforcedCount = completed.filter(r => r.reinforced).length;
    if (!success) await store.fail(job.id, result.reason || 'capture-failed');
    const retry = (await store.read()).jobs.find((j) => j.id === job.id);
    await status.set(job.sessionId, job.turn, {
      state: success ? result.persisted ? 'saved' : result.reason : retryPaused(retry || job, config) ? 'paused' : 'failed',
      reason: result.reason || (result.error ? 'capture-failed' : ''), count, reinforcedCount,
      retryAttempt: retry?.attempts || job.attempts || 0, nextRetryAt: success ? null : retry?.nextAttemptAt,
      ...(userOnly ? { historyPolicy: 'user-only' } : {}),
    });
    if (success) {
      const requestedTopic = preparedOnly ? null : requestedIndexTopic(job.userText);
      if (requestedTopic) await store.update(s => {
        const permalink = 'index-request:' + job.id;
        if (!s.pending.some(p=>p.permalink===permalink)) mergePending(s, {permalink,action:'INDEX_REQUEST',requestedTopic,sessionId:job.sessionId,turn:job.turn,memoryAuthorization:job.memoryAuthorization,sourceMessageId:job.sourceMessageId,sourceEventSeq:job.sourceEventSeq});
      });
      if(preparedOnly)assert();
      await store.finish(job.id);
    }
  }

  async function publishMaintenance(batch, owners, result) {
    for (const o of owners) {
      const remaining = (await store.read()).pending.filter((p) => !batch.some((b) => b.revision === p.revision) && p.owners.some((owner) => owner.sessionId === o.sessionId));
      await status.pending(o.sessionId, remaining);
      await status.set(o.sessionId, o.turn, { maintenance: remaining.length ? 'pending' : 'saved', pendingCount: remaining.length, indexesUpdated: result.updated, indexesCreated: result.created || 0, profileUpdated: result.profileUpdated });
    }
  }
  async function syncPending(agent, force, trigger) {
    const before = await store.read();
    const old = before.indexMaintenance;
    const previous = old?.changes.map(c => before.pending.find(p => p.revision === c.revision)).filter(Boolean) || [];
    // Never discard a partially applied plan merely because its platform is held.
    if (old?.bundle && previous.some(p => !maintenanceAllowed(p,before))) return;
    const candidates = previous.length === old?.changes.length && previous.every(p => maintenanceAllowed(p,before)&&retryDue(p, config, force))
      ? previous : before.pending.filter(p => !suspendedRevision(before,p.revision)&&maintenanceAllowed(p,before)&&retryDue(p, config, force)).slice(0, 10);
    // One named topic per plan; leave other explicit requests in the outbox.
    const request = candidates.find(p=>p.requestedTopic);
    const batch = candidates.filter(p=>(!p.requestedTopic || p===request)
      && (!gated || p.owners.every(owner=>owner.sessionId===agent.session.id)));
    if (!batch.length) return;
    const key = batch.map(p=>p.revision).join(':');
    const saved = old?.key === key ? old.bundle : null;
    await store.update(s=>{s.indexMaintenance={key,changes:batch,bundle:saved};});
    const owners = [...new Map(batch.flatMap((p) => p.owners).map((o) => [o.sessionId + ':' + o.turn, o])).values()];
    // One billing owner per shared maintenance request: never multiply tokens across owners.
    const billing = owners.find(o => o.sessionId === agent.session.id) || owners[0] || { sessionId: agent.session.id, turn: 0 };
    const grant=gated?grantFor(owners[0],agent):null;
    const assert=()=>{if(gated){if(!owners.every(sourceAllowed)||!access.validate(grant))throw memoryRevoked();access.assertCurrent(agent);}};
    for (const o of owners) await status.set(o.sessionId, o.turn, { maintenance: 'processing' });
    try {
      const run=async()=>{assert();const result=await maintainIndexes({ config: await getConfig(), tools:authorizedTools(tools,access,grant,agent,assert), maintenanceScope,
        llm: measuredLlm(authorizedLlm(llm,access,grant,agent,assert), record => status.usage(billing.sessionId, billing.turn, record), { phase: 'maintenance', retry: batch.some(p => p.attempts > 0 || p.manualResumes) }),
        logger, agent, sessionId: agent.session.id,
        recovery:{saved,save:(bundle)=>{assert();return store.update(s=>{assert();if(s.indexMaintenance?.key!==key)throw new Error('MAINTENANCE_REPLACED');s.indexMaintenance.bundle=bundle;});}},
      }, batch);assert();return result;};
      let result;
      try{result = gated?await access.withGrant(grant,run):await run();}
      finally{if(grant){grantReleases.get(grant)?.();grantReleases.delete(grant);}}
      await publishMaintenance(batch, owners, result);
      // Remove intent only after readback and status writes both succeeded.
      await store.update((s) => { s.pending = s.pending.filter((p) => !batch.some((b) => b.revision === p.revision)); if(s.indexMaintenance?.key===key)delete s.indexMaintenance; });
    } catch (error) {
      warn(error);
      if(gated&&!owners.every(sourceAllowed)) {
        for(const o of owners)await status.set(o.sessionId,o.turn,{maintenance:'held',maintenanceReason:'memory-authorization-revoked'});
        return;
      }
      await store.update((s) => {
        // A saved semantic edit cannot be replayed against a changed anchor.
        if (s.indexMaintenance?.key === key && /^(?:INDEX_CHANGED|WRITE_CONFLICT|PROFILE_CHANGED|PROFILE_WRITE_FAILED)$/.test(error.code || error.message)) s.indexMaintenance.bundle = null;
        for (const p of s.pending) if (batch.some((b) => b.revision === p.revision)) {
          p.attempts++;
          p.nextAttemptAt = retryPaused(p, config) ? null : Date.now() + retryDelay(p.attempts);
          p.reason = error.code || error.message;
        }
      });
      const pending = (await store.read()).pending.filter(p => batch.some(b => b.revision === p.revision));
      for (const o of owners) await status.set(o.sessionId, o.turn, {
        maintenance: pending.some(p => retryPaused(p, config)) ? 'paused' : 'failed', maintenanceReason: 'sync-failed',
      });
    }
  }

  async function resumePreparedMaintenance(plan, batch, agent, suspended) {
    const owners = batch.flatMap(item => item.owners);
    const bundle = plan.bundle;
    const sources = Object.entries(bundle?.sources ?? {});
    if (!bundle?.sources || !Array.isArray(bundle.entries) || !bundle.at
      || !['assignments', 'creations', 'removals', 'headings', 'profile'].every(key => Array.isArray(bundle.plan?.[key]))
      || sources.some(([, checksum]) => typeof checksum !== 'string' || !checksum)
      || batch.some(item => !item.requestedTopic && !Object.hasOwn(bundle.sources, item.permalink))) {
      return 'legacy-maintenance-unprepared';
    }
    const grant = grantFor(owners[0], agent);
    const assert = () => {
      if (stopped || !owners.every(sourceAllowed) || !access.validate(grant)) throw memoryRevoked();
      access.assertCurrent(agent);
    };
    try {
      return await access.withGrant(grant, async () => {
        const ctx = { config, agent, sessionId: agent.session.id, maintenanceScope, tools: authorizedTools(tools, access, grant, agent, assert) };
        // The ordinary path can abandon stale decisions and ask for a new plan.
        // Explicit recovery only consumes the saved bundle and has no LLM.
        for (const [identifier, checksum] of sources) {
          let note;
          try { note = await memoryCall(ctx, 'read_note', { identifier, include_content: true }); }
          catch (error) { if (error.code === 'NOTE_NOT_FOUND') return 'legacy-maintenance-source-changed'; throw error; }
          if (note.checksum !== checksum) return 'legacy-maintenance-source-changed';
        }
        let consumed = false;
        const result = await maintainIndexes({ ...ctx, recovery: { get saved() { consumed = true; return bundle; } } }, batch);
        assert();
        if (!consumed) return 'legacy-maintenance-effect-unconfirmed';
        await publishMaintenance(batch, owners, result);
        await store.update(state => {
          assert();
          const current = suspended ? state.suspendedIndexMaintenance?.find(item => item.key === plan.key) : state.indexMaintenance;
          if (current?.key !== plan.key || batch.some(change => !state.pending.some(item => item.revision === change.revision))) {
            throw new Error('MAINTENANCE_REPLACED');
          }
          state.pending = state.pending.filter(item => !batch.some(change => change.revision === item.revision));
          if (suspended) {
            state.suspendedIndexMaintenance = state.suspendedIndexMaintenance.filter(item => item.key !== plan.key);
            if (!state.suspendedIndexMaintenance.length) delete state.suspendedIndexMaintenance;
          } else delete state.indexMaintenance;
        });
        return null;
      });
    } finally {
      grantReleases.get(grant)?.();
      grantReleases.delete(grant);
    }
  }

  async function resumeLegacyRecovery({ sessionId } = {}) {
    if (typeof sessionId !== 'string' || !/^session-[a-zA-Z0-9_-]+$/.test(sessionId)) {
      throw Object.assign(new Error('A native session is required'), { code: 'INVALID_LEGACY_RECOVERY_SESSION' });
    }
    const result = { resumed: [], held: [] };
    const record = (kind, id, reason) => {
      if (reason) result.held.push({ kind, id, reason });
      else result.resumed.push({ kind, id });
    };
    const agent = exactAgent(sessionId);
    const sessionHold = () => {
      if (!gated) return 'memory-authorization-unproven';
      if (stopped) return 'legacy-worker-closed';
      if (!agent) return 'legacy-session-unavailable';
      if (!access.check(agent)?.allowed) return 'memory-authorization-unproven';
      return null;
    };
    const before = await store.read();
    const belongsToSession = item => item?.owners?.some(owner => owner.sessionId === sessionId);
    const pending = before.pending.filter(belongsToSession);
    const planned = new Set();
    for (const [plan, suspended] of [[before.indexMaintenance, false], ...(before.suspendedIndexMaintenance ?? []).map(plan => [plan, true])]) {
      if (!Array.isArray(plan?.changes)) continue;
      const revisions = plan.changes.map(change => change.revision);
      const batch = revisions.map(revision => before.pending.find(item => item.revision === revision));
      const selected = new Set([...plan.changes, ...batch].filter(belongsToSession).map(item => item.revision));
      if (!selected.size) continue;
      let reason = sessionHold();
      if (!reason && (!plan.key || plan.key !== revisions.join(':') || new Set(revisions).size !== revisions.length || revisions.length > 10
        || revisions.some(revision => !revision || planned.has(revision)) || batch.some(item => !item))) {
        reason = 'legacy-maintenance-checkpoint-unproven';
      }
      if (!reason && batch.some(item => !item.owners?.length || item.owners.some(owner => owner.sessionId !== sessionId) || !maintenanceAllowed(item, before))) {
        reason = 'legacy-maintenance-owner-unproven';
      }
      if (!reason) {
        try { reason = await resumePreparedMaintenance(plan, batch, agent, suspended); }
        catch (error) {
          reason = batch.every(item => item.owners.every(sourceAllowed)) ? 'legacy-maintenance-effect-unconfirmed' : 'memory-authorization-revoked';
          warn(error);
        }
      }
      for (const id of selected) {
        if (!planned.has(id)) record('maintenance', id, reason);
        planned.add(id);
      }
    }
    for (const item of pending) if (!planned.has(item.revision)) record('maintenance', item.revision, 'legacy-maintenance-unprepared');

    // A capture checkpoint can merge a pending intent with the same grant.
    // Leave a still-held active plan's revisions intact. Suspended plans are
    // already protected by mergePending.
    const state = await store.read();
    const activeChanges = state.indexMaintenance?.bundle ? state.indexMaintenance.changes ?? [] : [];
    const reserved = new Set(activeChanges.flatMap(change =>
      state.pending.find(item => item.revision === change.revision)?.owners?.map(owner => owner.memoryAuthorization?.id) ?? []));
    const jobs = state.jobs.filter(job => !job.channel && job.sessionId === sessionId).sort((a, b) => a.sourceEventTime - b.sourceEventTime);
    for (const job of jobs) {
      let reason = sessionHold();
      if (!reason && (!sourceAllowed(job) || (maintenanceOwnerAllowed && !maintenanceOwnerAllowed(sessionId)))) reason = 'memory-authorization-unproven';
      if (!reason && ![job.target?.provider, job.target?.model].every(value => typeof value === 'string' && value.trim())) reason = 'legacy-target-unproven';
      if (!reason && !['user-only', 'conversation'].includes(job.historyPolicy)) reason = 'legacy-history-policy-unproven';
      if (!reason && !Array.isArray(job.actions)) reason = 'legacy-actions-unprepared';
      if (!reason && (!job.id || !Number.isFinite(job.sourceEventTime) || job.sourceEventTime <= 0 || !job.actions.length
        || job.actions.some(action => !['ADD', 'UPDATE', 'CORRECT', 'REINFORCE'].includes(action?.action))
        || Object.entries(job.completed ?? {}).some(([index, receipt]) => !/^(0|[1-9]\d*)$/.test(index) || Number(index) >= job.actions.length || !receipt || typeof receipt !== 'object'))) {
        reason = 'legacy-action-checkpoint-unproven';
      }
      if (!reason && reserved.has(job.memoryAuthorization?.id)) reason = 'legacy-maintenance-checkpoint-held';
      if (!reason) {
        try { reason = await runCapture(job, agent, resolveJobHistory(job), true); }
        catch (error) {
          reason = sourceAllowed(job) ? 'legacy-commit-unconfirmed' : 'memory-authorization-revoked';
          warn(error);
        }
      }
      if (reason) await status.set(sessionId, job.turn, { state: 'held', reason, count: null });
      record('job', job.id, reason);
    }
    return result;
  }

  async function drain({ force = false, resumeSessionId, trigger } = {}) {
    if(!canProcess())return;
    if (stopped) return;
    if(observationEnabled&&!observationEnabled())return;
    if(gated && ![...runners.values()].some(agent=>available(agent)&&access.check(agent)?.allowed))return;
    await getConfig();
    if (resumeSessionId) await store.update(s => {
      for (const job of s.jobs) if (job.sessionId === resumeSessionId && retryPaused(job, config)) { job.attempts = 0; job.nextAttemptAt = 0; job.manualResumes = (job.manualResumes || 0) + 1; }
      for (const item of s.pending) if (item.owners.some(o => o.sessionId === resumeSessionId) && retryPaused(item, config)) { item.attempts = 0; item.nextAttemptAt = 0; item.manualResumes = (item.manualResumes || 0) + 1; }
    });
    // If persistence temporarily fails, retain new inputs in RAM for the next tick.
    for (const [id, job] of incoming) { await store.add(job); incoming.delete(id); }
    await observe();
    // Preserve a partially applied platform plan without blocking unrelated DSH work.
    // Its exact revisions remain reserved until that platform is explicitly resumed.
    if (maintenanceOwnerAllowed) {
      const state = await store.read(), plan = state.indexMaintenance;
      const blocked = plan?.bundle && plan.changes?.some(change => {
        const item = state.pending.find(p => p.revision === change.revision);
        return item && !maintenanceAllowed(item,state);
      });
      const resumable = !plan?.bundle && (state.suspendedIndexMaintenance||[]).find(saved => saved.changes?.length && saved.changes.every(change => {
        const item=state.pending.find(p=>p.revision===change.revision);
        return item && maintenanceAllowed(item,state) && retryDue(item,config,force);
      }));
      if (blocked || resumable) await store.update(s => {
        if (blocked && s.indexMaintenance?.key===plan.key) {
          (s.suspendedIndexMaintenance??=[]).push(s.indexMaintenance);
          delete s.indexMaintenance;
        } else if (resumable && !s.indexMaintenance?.bundle) {
          const index=(s.suspendedIndexMaintenance||[]).findIndex(saved=>saved.key===resumable.key);
          if(index>=0){s.indexMaintenance=s.suspendedIndexMaintenance.splice(index,1)[0];if(!s.suspendedIndexMaintenance.length)delete s.suspendedIndexMaintenance;}
        }
      });
    }
    const state = await store.read();
    // Keep the original oldest-first order: an older queued write may need to
    // land before a newer correction. Held legacy jobs are skipped without
    // consuming one of the five runnable slots.
    const due = state.jobs.filter(j => !j.channel && retryDue(j, config, force))
      .sort((a, b) => a.sourceEventTime - b.sourceEventTime);
    let processable = 0;
    for (const job of due) {
      if (processable >= 5) break;
      const policy = resolveJobHistory(job);
      const hold = !sourceAllowed(job)?'memory-authorization-unproven':policy.hold || await restoreJobTarget(job);
      if (hold) {
        // Keep unresolved history or targets durable without consuming a
        // runnable slot or borrowing another session's model selection.
        if (!heldReported.has(job.id)) {
          heldReported.add(job.id);
          await status.set(job.sessionId, job.turn, { state: 'held', reason: hold, count: null });
        }
        continue;
      }
      processable += 1;
      heldReported.delete(job.id);
      const agent = runner(job.sessionId);
      if (!agent || stopped) {
        await status.set(job.sessionId, job.turn, { state: 'queued', reason: 'waiting-memory', count: null });
        continue;
      }
      try { await runCapture(job, agent, policy); }
      catch (error) {
        if(gated&&!sourceAllowed(job)){await status.set(job.sessionId,job.turn,{state:'held',reason:'memory-authorization-revoked'});continue;}
        await store.fail(job.id, 'recovery-failed'); warn(error);
        const failed = (await store.read()).jobs.find(j => j.id === job.id);
        await status.set(job.sessionId, job.turn, { state: retryPaused(failed || job, config) ? 'paused' : 'failed', reason: 'recovery-failed', retryAttempt: failed?.attempts, nextRetryAt: failed?.nextAttemptAt });
      }
    }
    await observe();
    // A shared fact can have both DSH and currently held platform owners.
    // Keep the held intent intact while allowing the DSH part to progress.
    if (maintenanceOwnerAllowed) {
      const current = await store.read();
      if (current.pending.some(p => p.owners?.some(o => maintenanceOwnerAllowed(o.sessionId,p)) && p.owners.some(o => !maintenanceOwnerAllowed(o.sessionId,p)))) await store.update(s => {
        const added = [];
        for (const item of s.pending) {
          // A partially applied plan must retain its saved decisions for recovery.
          if (suspendedRevision(s,item.revision) || (s.indexMaintenance?.bundle && s.indexMaintenance.changes?.some(change => change.revision === item.revision))) continue;
          const allowed = item.owners?.filter(o => maintenanceOwnerAllowed(o.sessionId,item)) || [];
          const held = item.owners?.filter(o => !maintenanceOwnerAllowed(o.sessionId,item)) || [];
          if (!allowed.length || !held.length) continue;
          item.owners = held;
          added.push({ ...item, owners: allowed, revision: randomUUID() });
          // The old plan may refer to both sets of owners; rebuild it safely.
          if (s.indexMaintenance?.changes?.some(change => change.revision === item.revision)) delete s.indexMaintenance;
        }
        s.pending.push(...added);
      });
    }
    await pendingStatus();
    const remaining = await store.read();
    const eligible=remaining.pending.find(p=>!suspendedRevision(remaining,p.revision)&&maintenanceAllowed(p,remaining)&&retryDue(p,config,force));
    const owner=eligible?.owners?.find(o=>!maintenanceOwnerAllowed||maintenanceOwnerAllowed(o.sessionId,eligible))?.sessionId;
    const agent = eligible?runner(owner || remaining.lastSessionId):null;
    if (agent && !stopped) await syncPending(agent, force, trigger);
  }
  // No polling of chat/model logs. This only wakes the existing local outbox.
  const timer = setInterval(() => { if (!stopped && scheduled === 0) serialize(() => drain()).catch(warn); }, 30_000);
  timer.unref?.();
  return {
    store,
    getConfig,
    accept(state, agent) {
      if(!canProcess())return Promise.resolve({held:true,reason:'memory-pipeline-owns-new-work'});
      if(gated && !sourceAllowed(state))return Promise.resolve({held:true,reason:'memory-authorization-unproven'});
      if(gated)liveGrants.set(state.memoryAuthorization.id,state.memoryAuthorization);
      runners.set(state.sessionId, agent);
      const id = jobId(state.sessionId, state.turn);
      const { userText, assistantText, sourceMessageId, sourceEventSeq, priorUserMessages, priorUserSourceIds, historyUserOnly } = state;
      const job = {
        id, sessionId: state.sessionId, turn: state.turn, userText, assistantText,
        sourceMessageId, sourceEventSeq, priorUserMessages, priorUserSourceIds,
        ...(gated?{memoryAuthorization:{...state.memoryAuthorization}}:{}),
        historyUserOnly: historyUserOnly === true,
        historyPolicy: historyUserOnly ? 'user-only' : 'conversation',
        sourceEventTime: state.sourceEventTime || Date.now(), target: resolveProcessingTarget(config, agent),
        targetMode: processingTargetMode(config),
        attempts: 0, nextAttemptAt: 0, completed: {},
      };
      incoming.set(id, job);
      // Durability must not wait behind an older model call in the worker queue.
      const saved = store.add(job).then(async () => {
        incoming.delete(id);
        await status.set(state.sessionId, state.turn, { state: 'queued', count: 0 });
      });
      saved.catch(warn);
      return serialize(async () => {
        await saved;
        await drain({ trigger: { sessionId: state.sessionId, turn: state.turn } });
      });
    },
    attach: (agent) => { if (available(agent)) runners.set(agent.session.id, agent); },
    wake: (options) => serialize(() => drain(options)),
    resumeLegacyRecovery: (options) => serialize(() => resumeLegacyRecovery(options)),
    idle: () => chain,
    dispose: () => { stopped = true; clearInterval(timer); return chain; },
  };
}

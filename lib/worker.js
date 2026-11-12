import { ensureProcessingScope } from './processing-model.js';
import { createRecoveryStore } from './recovery.js';

export const memoryJobSource = job => ({
  sessionId: job.sessionId,
  messageId: job.sourceMessageId,
  sequence: job.sourceEventSeq,
  turn: job.turn,
  rootTurn: job.turn,
  role: 'user',
});

export const hasSessionMemory = access =>
  typeof access?.grant === 'function'
  && typeof access?.validate === 'function';

export function memoryRevoked() {
  return Object.assign(new Error('MEMORY_AUTHORIZATION_REVOKED'), { code: 'MEMORY_AUTHORIZATION_REVOKED' });
}

/** Keep the original grant across every asynchronous tool boundary. */
export function authorizedTools(tools, access, grant, agent, assertExtra = () => {}) {
  if (!hasSessionMemory(access)) throw memoryRevoked();
  const assert = () => {
    if (!grant || !access.validate(grant)) throw memoryRevoked();
    access.assertCurrent(agent);
    assertExtra();
  };
  return {
    check: assert,
    vaultBackend: tools?.vaultBackend,
    get(name, owner = agent) {
      const definition = tools?.get?.(name, owner);
      if (!definition) return definition;
      return {
        ...definition,
        async execute(args, exec = {}) {
          return access.withGrant(grant, async () => {
            assert();
            const signal = AbortSignal.any([exec.signal, grant.signal].filter(Boolean));
            const result = await definition.execute(args, {
              ...exec,
              signal,
              memoryAuthorization: () => {
                try {
                  assert();
                  return true;
                } catch {
                  return false;
                }
              },
            });
            assert();
            return result;
          });
        },
      };
    },
  };
}

/** Durable runtime state shared by natural decay, query priority and processing scope. */
export function createMemoryWorker({ config, recoveryStore, now } = {}) {
  const store = recoveryStore || createRecoveryStore(config);
  const clock = () => new Date(typeof now === 'function' ? now() : now ?? Date.now());
  let chain = Promise.resolve();

  async function getConfig() {
    const processingScopeId = await ensureProcessingScope(store);
    let state = await store.read();
    if (!state.naturalDecayStartedAt) {
      const startedAt = clock().toISOString();
      await store.update(next => {
        next.naturalDecayStartedAt ||= startedAt;
      });
      state = await store.read();
    }
    return {
      ...config,
      processingScopeId,
      naturalDecayStartedAt: state.naturalDecayStartedAt,
      now: typeof now === 'function' ? now() : now,
    };
  }

  return {
    store,
    getConfig,
    // The host event remains wired for compatibility, but no legacy maintenance queue is read.
    wake: () => chain,
    idle: () => chain,
    dispose: () => chain,
  };
}

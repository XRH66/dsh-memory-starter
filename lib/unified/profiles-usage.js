import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const keyOf = value => JSON.stringify([value.ownerSubject, value.project, value.profileId]);
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const text = (value, max = 1024) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value) ? value : null;
const empty = () => ({ calls: 0, reportedTokens: 0, unknownUsageCalls: 0 });

// Same receipt semantics as RawMemoryStore.recordEmbeddingUsage/summary: one
// observed attempt is one call, and tokens=null means unknown. Costs are never
// estimated. Only the receipt's explicit metadata fields are accepted.
function cleanReceipt(receipt, { scope, profile }) {
  return { version: 1, ownerSubject: scope.ownerSubject, project: scope.project,
    profileId: profile.id, profileRevision: profile.revision,
    at: text(receipt?.at, 100), model: text(receipt?.model, 300), modelKey: text(receipt?.modelKey),
    dimensions: integer(receipt?.dimensions), kind: ['query', 'document'].includes(receipt?.kind) ? receipt.kind : null,
    inputs: integer(receipt?.inputs), tokens: integer(receipt?.tokens),
    outcome: ['unknown', 'ok', 'http-error', 'network-error', 'cancelled'].includes(receipt?.outcome) ? receipt.outcome : 'unknown',
    requestId: text(receipt?.requestId, 300),
    httpStatus: Number.isInteger(receipt?.httpStatus) && receipt.httpStatus >= 100 && receipt.httpStatus <= 599 ? receipt.httpStatus : null,
    durationMs: Number.isFinite(receipt?.durationMs) && receipt.durationMs >= 0 ? receipt.durationMs : null };
}

/** Append-only small metadata ledger, independent of private vector storage.
 * Construction/idle do no I/O. A late receipt must remain recordable after
 * cancellation/close: it describes an already attempted provider request.
 * Single host writer; callers await backend disposal and then idle on close.
 */
export function createProfileUsage({ file }) {
  if (!path.isAbsolute(file || '')) throw new TypeError('Absolute embedding usage file required');
  const totals = new Map();
  let loading, loaded = false, chain = Promise.resolve(), recordingError = null;
  function add(receipt) {
    const key = keyOf(receipt), value = totals.get(key) ?? empty();
    value.calls++;
    if (receipt.tokens === null) value.unknownUsageCalls++;
    else value.reportedTokens += receipt.tokens;
    totals.set(key, value);
  }
  async function load() {
    if (loaded) return;
    loading ||= (async () => {
      // Opening a missing ledger for reading does not create it or its folder.
      try { await fs.access(file); } catch (error) { if (error.code === 'ENOENT') { loaded = true; return; } throw error; }
      const input = createReadStream(file, { encoding: 'utf8' });
      const lines = createInterface({ input, crlfDelay: Infinity });
      const staged = new Map();
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          if (row.version !== 1 || !text(row.ownerSubject) || !text(row.project) || !text(row.profileId) || !text(row.profileRevision) ||
              row.tokens !== null && integer(row.tokens) === null) throw Object.assign(new Error('Invalid embedding usage metadata'), { code: 'INVALID_EMBEDDING_USAGE' });
          const key = keyOf(row), value = staged.get(key) ?? empty();
          value.calls++;
          if (row.tokens === null) value.unknownUsageCalls++;
          else value.reportedTokens += row.tokens;
          staged.set(key, value);
        }
        for (const [key, value] of staged) totals.set(key, value);
        loaded = true;
      } finally { lines.close(); input.destroy(); }
    })();
    try { await loading; } catch (error) { loading = undefined; throw error; }
  }
  return {
    record(receipt, identity) {
      // Capture trusted scope/profile at callback time, never receipt.scope.
      const row = cleanReceipt(receipt, identity);
      const task = chain.then(async () => {
        await load();
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, JSON.stringify(row) + '\n', { encoding: 'utf8', mode: 0o600 });
        add(row);
      });
      chain = task.then(() => {}, error => { recordingError = error.code || 'EMBEDDING_USAGE_WRITE_FAILED'; });
      return task;
    },
    async summary(identity) {
      await chain; await load();
      const value = { ...(totals.get(keyOf(identity)) ?? empty()) };
      return { ...value, totalTokens: recordingError || value.unknownUsageCalls ? null : value.reportedTokens,
        recordingError };
    },
    async idle() { await chain; },
  };
}

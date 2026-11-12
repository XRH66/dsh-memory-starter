import path from 'node:path';
import {createHash} from 'node:crypto';
import {managementDirectory} from './review.js';
import {estimateTokens} from './token-estimate.js';

export {estimateTokens as estimateRecentTokens} from './token-estimate.js';

export const RECENT_SOURCE = 'recent-conversation-context';
export const ORIGINAL_HANDOFF_SAMPLE = 'original-handoff-sample';
const hash = value => createHash('sha256').update(value).digest('hex');

export function recentContextFile(config) {
  return config.vaultPath
    ? path.join(managementDirectory(config), 'recent-context', hash(String(config.project)).slice(0, 20) + '.json')
    : '';
}

/** Summarize only the first page already read for handoff. */
export function originalRecentStats(enabled, sources, sampledAt = null) {
  const stats = {
    source: ORIGINAL_HANDOFF_SAMPLE,
    enabled,
    storage: enabled ? 'ready' : 'disabled',
    estimatedTokens: null,
    capacityTokens: null,
    turns: null,
    oldestAt: null,
    newestAt: null,
    evictedTurns: null,
    sampledMessages: null,
    sampledAt: null,
  };
  if (!enabled || !sources) return stats;
  const turns = new Set();
  let estimatedTokens = 0;
  let sampledMessages = 0;
  let oldest = Infinity;
  let newest = -Infinity;
  for (const source of sources) {
    if (!source?.isCurrent || source.withdrawn || !source.text) continue;
    sampledMessages++;
    estimatedTokens += estimateTokens(source.text);
    turns.add(JSON.stringify([source.sessionId, source.turn]));
    const time = source.time ?? source.recordedAt;
    if (Number.isFinite(time)) {
      oldest = Math.min(oldest, time);
      newest = Math.max(newest, time);
    }
  }
  return {
    ...stats,
    estimatedTokens,
    turns: turns.size,
    sampledMessages,
    sampledAt,
    oldestAt: Number.isFinite(oldest) ? new Date(oldest).toISOString() : null,
    newestAt: Number.isFinite(newest) ? new Date(newest).toISOString() : null,
  };
}

// Source identity is independent of the embedding model used to find it.
// Adapters may share this reference without creating another context pipeline.
const KINDS = new Set(['raw-turn', 'fact', 'recent', 'manual-note', 'personal']);

export function evidenceSource({ kind, id, scope, version = null, at = null, origins = [] }) {
  if (!KINDS.has(kind) || typeof id !== 'string' || !id || typeof scope !== 'string' || !scope) throw new Error('Invalid memory evidence source');
  return { schema: 'memory-evidence-v1', kind, id, scope, version, at, origins };
}

export const rawEvidenceKey = hit => JSON.stringify([hit.turnId, hit.sourceVersion]);

export function selectedRawSource(turn, selection) {
  if (!turn.scope) return null; // Prepared non-authoritative excerpts have no source claim.
  return evidenceSource({ kind: 'raw-turn', id: turn.turnId, scope: turn.scope, version: turn.sourceVersion || null,
    at: turn.completedAt, origins: selection.map(({ message, clauses }) => ({
      messageId: message.id, role: message.role, at: message.ts,
      // UTF-16 offsets in the original message, never offsets in rewritten text.
      ranges: clauses.map(clause => ({ start: clause.start, end: clause.end })),
    })) });
}

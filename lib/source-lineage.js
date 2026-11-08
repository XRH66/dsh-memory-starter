import { createHash } from 'node:crypto';
import { evidenceSource } from './evidence.js';

const FIELD = 'dsh_derivation';
const MARKER = '<!-- dsh-fact-memory -->';
export const sourceTextHash = text => createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex');

// Ignore frontmatter and appended sections. Only edits to the current managed
// body detach its automatic derivation; adding an annotation does not do so.
export function sourceBodyHash(content) {
  const text = String(content ?? '').replace(/\r\n/g, '\n');
  const start = text.indexOf(MARKER);
  const body = start < 0 ? text.replace(/^\uFEFF?---\n[\s\S]*?\n---(?:\n|$)/, '') : text.slice(start);
  const current = body.split(/^#{2,6}\s/m)[0];
  const managed = start < 0 ? current : current.split('\n').filter(line => line.trim()===MARKER || /^#\s/.test(line)
    || /^-\s*(?:\[[^\]]*\]|(?:subject|attribute|发生日期|记录日期|适用范围|历史证据|valid_from|valid_until|time_expression|time_anchor|source_event_time)\s*:)/i.test(line)).join('\n');
  return sourceTextHash(managed.trim());
}

function list(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return []; } }
  return Array.isArray(value) ? value : [];
}

export function readDerivation(metadata = {}) {
  let value = metadata[FIELD];
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  return value?.schema === 'memory-derivation-v1' && ['derived','manual'].includes(value.authority)
    && /^[a-f0-9]{64}$/.test(value.bodyHash || '') && Array.isArray(value.sources)
    && value.sources.every(ref => ref && typeof ref==='object' && typeof ref.messageId==='string' && ref.messageId.length)
    && (value.groups===undefined || (Array.isArray(value.groups) && value.groups.every(group => Array.isArray(group)
      && group.length && group.every(ref => ref && typeof ref==='object' && typeof ref.messageId==='string' && ref.messageId.length)))) ? value : null;
}

function uniqueSources(sources) {
  return [...new Map(sources.filter(source => source && typeof source === 'object' && source.scope && source.messageId)
    .map(source => [JSON.stringify([source.scope, source.messageId, source.sourceVersion, source.textHash, source.evidence]), source])).values()];
}

function manualBody(content, metadata = {}, derivation) {
  if (derivation?.authority==='manual') return true;
  if (typeof content!=='string') return false;
  if (derivation) return derivation.bodyHash!==sourceBodyHash(content);
  const value = /^\s*-\s*\[(?:preference|fact|decision|relationship|event)\]\s+(.+)$/m.exec(content)?.[1]?.trim();
  return Boolean(value && typeof metadata.value==='string' && value!==metadata.value.trim());
}

/** Audit sources include former values; only derivation.sources supports now. */
export function derivationMetadata({ note, content, sources = [], replace = false, supportMode = 'amend' }) {
  const old = readDerivation(note?.metadata);
  const incoming = sources.at(-1)?.raw_ref;
  const incomingGroup=uniqueSources([incoming,...(sources.at(-1)?.raw_dependencies || [])]);
  if (!incoming && !old) return {};
  const wasManual = manualBody(note?.content, note?.metadata, old);
  const manual = !replace && wasManual;
  const previous = old?.groups || (old?.sources || []).map(ref => [ref]);
  const inherited = wasManual ? [] : previous.length ? previous : legacySources(note?.metadata || {}).map(ref => [{...ref,scope:ref.scope || incoming?.scope}]);
  let groups = previous;
  if (replace) groups = incoming ? (supportMode==='amend' && inherited.length
    ? inherited.map(group => uniqueSources([...group,...incomingGroup])) : [incomingGroup]) : [];
  else if (incoming) groups = [...previous,incomingGroup];
  const refs = uniqueSources(groups.flat());
  return { [FIELD]: JSON.stringify({ schema: 'memory-derivation-v1', authority: manual ? 'manual' : 'derived',
    bodyHash: sourceBodyHash(content), sources: refs, groups }) };
}

/** Preserve old support, rather than attributing an old value to its correction. */
export function historicalDerivation(note, content) {
  const old = readDerivation(note?.metadata);
  const groups = old?.groups || (old?.sources || legacySources(note?.metadata || {})).map(ref=>[ref]);
  if (!old && !groups.length) return {};
  return { [FIELD]: JSON.stringify({ schema:'memory-derivation-v1', ...old,
    authority:manualBody(note?.content,note?.metadata,old)?'manual':'derived',
    sources:groups.flat(),groups,bodyHash:sourceBodyHash(content) }) };
}

function legacySources(metadata) {
  const refs = list(metadata.sources).flatMap(item => {
    if (typeof item === 'string') { try { item = JSON.parse(item); } catch { return []; } }
    return item?.raw_ref ? [item.raw_ref] : item?.message_id ? [{ messageId: item.message_id,
      sessionId: item.session_id || '', turn: item.turn, legacy: true }] : [];
  });
  // A content change supersedes audit entries from earlier values.
  const id = metadata.content_changed_message_id || metadata.source_message_id;
  return id ? refs.filter(ref => ref.messageId === id).concat(refs.some(ref => ref.messageId === id) ? [] : [{
    messageId: id, sessionId: metadata.content_changed_session_id || metadata.source_session_id || '', legacy: true,
  }]) : [];
}

/** Read-time invalidation does not rewrite or delete the user's note. */
export function memorySourceState(note, { scope, sourceState } = {}) {
  const metadata = note.priorityMetadata || note.frontmatter || note.metadata || {};
  const derivation = readDerivation(metadata);
  const content = note.sourceContent ?? note.content;
  if (metadata[FIELD] && !derivation) return { eligible: false, authority: 'derived', reason: 'source-metadata-invalid', refs: [], live: [] };
  const manual = manualBody(content,metadata,derivation);
  if (manual) return { eligible: true, authority: 'manual', reason: 'manual-body', refs: [], live: [] };
  const refs = derivation ? (derivation.groups?.flat() || derivation.sources) : legacySources(metadata);
  if (!refs.length) return { eligible: true, authority: 'legacy', reason: 'untracked', refs, live: [] };
  if (typeof sourceState !== 'function') return { eligible: !derivation, authority: derivation ? 'derived' : 'legacy', reason: 'source-policy-unavailable', refs, live: [] };
  if (derivation && typeof content !== 'string') return { eligible: false, authority: 'derived', reason: 'source-body-unavailable', refs, live: [] };
  const groups = derivation?.groups || refs.map(ref => [ref]);
  const states = groups.map(group => group.map(ref => ({ ref, state: sourceState({ ...ref, scope: ref.scope || scope }) })));
  const supported = states.filter(group => group.length && group.every(({state}) => ['live','unknown'].includes(state.state)));
  const live = supported.flat().filter(({ state }) => state.state === 'live');
  // Unknown legacy sources remain usable. A previously versioned source that
  // disappears is blocked by the store, never treated as a missing old import.
  const eligible = supported.length > 0;
  return { eligible, authority: derivation ? 'derived' : 'legacy', reason: eligible ? (live.length
    ? supported.some(group=>group.some(({ref,state})=>!ref.sourceVersion || state.state==='unknown'))?'source-partly-unversioned':'source-live'
    : 'source-untracked') : 'source-invalid',
    refs, live };
}

export function memoryEvidence(note, state, scope) {
  if (!scope) return null;
  const id = note.memoryId || note.permalink;
  if (!id) return null;
  return evidenceSource({ kind: state.authority === 'manual' ? 'manual-note' : 'fact', id, scope,
    version: note.checksum || sourceBodyHash(note.sourceContent ?? note.content ?? note.value ?? note.snippet),
    origins: state.live.map(({ ref }) => ({ messageId: ref.messageId, sourceVersion: ref.sourceVersion || null })) });
}

// Only a verbatim quote actually displayed by the fact can cover the matching
// original clause. A rewritten summary, uncertain source, or manual body cannot.
export function factCoverage(state, renderedBody) {
  return state.live.flatMap(({ ref, state: current }) => {
    const quote = ref.evidence;
    if (!quote || !ref.sourceVersion || !renderedBody.includes(quote) || !current.text?.includes(quote)) return [];
    return [{ id: ref.messageId, role: 'user', text: quote, sourceVersion: ref.sourceVersion }];
  });
}

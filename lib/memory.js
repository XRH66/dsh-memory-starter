/**
 * Durable factual memory: independently revisable fact/event notes and their
 * retained history. No forget channel is implemented.
 */
import { collapseWhitespace } from './text.js';
import { withCommitLock } from './coordinator.js';
import { priorityFromMetadata, softenPriorityPatch } from './priority.js';
import { PERSONAL_KINDS, isPersonalPermalink, personalRecordPath } from './personal-namespace.js';
import { stripFrontmatter } from './records.js';
import {readMemoryEntry} from './memory-entry.js';
import { MEMORY_ENTRY_TYPES } from './memory-contract.js';
import {vaultContextFor} from './vault-files.js';


export const MEMORY_MARKER = '<!-- dsh-fact-memory -->';
export const MEMORY_TAG = 'dsh-memory';
export const MEMORY_STATUS = Object.freeze({ active: 'active', history: 'history' });

const KIND_DIRS = Object.freeze({ fact: 'facts', event: 'events', history: 'history' });
const MAX_TITLE_CHARS = 80;
const MAX_FORGET_NOTES = 1000;

export class MemoryError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function memoryFolder(config) {
  const raw = String(config?.captureFolder ?? 'chats').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = raw.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) return 'chats';
  return parts.join('/');
}

export function memoryDirectory(config, kind) {
  const dir = KIND_DIRS[kind];
  if (!dir) throw new MemoryError('INVALID_MEMORY_KIND', 'unsupported memory kind: ' + kind);
  return memoryFolder(config) + '/' + dir;
}

export function sanitizeMemoryTitle(value) {
  let title = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (title.length > MAX_TITLE_CHARS) title = title.slice(0, MAX_TITLE_CHARS).trim();
  return title;
}


export function parseMemoryContent(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  const markerIndex = lines.findIndex((line) => line.trim() === MEMORY_MARKER);
  if (markerIndex < 0) return null;
  let index = markerIndex + 1;
  while (index < lines.length && lines[index].trim() === '') index += 1;
  let title = '';
  if (String(lines[index] ?? '').startsWith('# ')) {
    title = String(lines[index]).slice(2).trim();
    index += 1;
  }
  const fields = { category: '', value: '', subject: '', attribute: '', occurredAt: '', recordedAt: '', validFrom: '', validUntil: '', timeExpression: '', timeAnchor: '', sourceEventTime: '', requirementScope: '', historyTitle: '' };
  const tail = [];
  let lastManaged = markerIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    let match = /^- \[([^\]]*)\]\s*(.*)$/.exec(line);
    if (match) {
      fields.category = match[1].trim();
      fields.value = match[2];
      lastManaged = index;
      continue;
    }
    match = /^- subject:\s*(.*)$/i.exec(line);
    if (match) { fields.subject = match[1].trim(); lastManaged = index; continue; }
    match = /^- attribute:\s*(.*)$/i.exec(line);
    if (match) { fields.attribute = match[1].trim(); lastManaged = index; continue; }
    match = /^- 发生日期:\s*(.*)$/.exec(line);
    if (match) { fields.occurredAt = match[1].trim(); lastManaged = index; continue; }
    match = /^- 记录日期:\s*(.*)$/.exec(line);
    if (match) { fields.recordedAt = match[1].trim(); lastManaged = index; continue; }
    match = /^- 适用范围:\s*(.*)$/.exec(line);
    if (match) { fields.requirementScope = match[1].trim(); lastManaged = index; continue; }
    match = /^- 历史证据:\s*\[\[(.*)\]\]\s*$/.exec(line);
    if (match) { fields.historyTitle = match[1].trim(); lastManaged = index; continue; }
    match = /^- valid_from:\s*(.*)$/i.exec(line);
    if (match) { fields.validFrom = match[1].trim(); lastManaged = index; continue; }
    match = /^- valid_until:\s*(.*)$/i.exec(line);
    if (match) { fields.validUntil = match[1].trim(); lastManaged = index; continue; }
    match = /^- time_expression:\s*(.*)$/i.exec(line);
    if (match) { fields.timeExpression = match[1].trim(); lastManaged = index; continue; }
    match = /^- time_anchor:\s*(.*)$/i.exec(line);
    if (match) { fields.timeAnchor = match[1].trim(); lastManaged = index; continue; }
    match = /^- source_event_time:\s*(.*)$/i.exec(line);
    if (match) { fields.sourceEventTime = match[1].trim(); lastManaged = index; continue; }
    tail.push(line);
  }
  return {
    title,
    ...fields,
    value: fields.value,
    tail: tail.join('\n').replace(/^\n+|\n+$/g, ''),
    markerIndex,
    lastManaged,
    lines,
  };
}


function rawList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return value.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return [];
}

function stringList(value) {
  return rawList(value)
    .map((item) => (item && typeof item === 'object' ? JSON.stringify(item) : String(item)))
    .filter(Boolean);
}

function noteFrontmatter(payload) {
  if (payload?.frontmatter && typeof payload.frontmatter === 'object') return payload.frontmatter;
  if (payload?.metadata && typeof payload.metadata === 'object') return payload.metadata;
  return {};
}

function noteMetadata(payload) {
  const meta = noteFrontmatter(payload);
  return {
    memoryId: String(meta.memory_id ?? ''),
    kind: String(meta.memory_kind ?? ''),
    status: String(meta.status ?? ''),
    subject: String(meta.subject ?? ''),
    attribute: String(meta.attribute ?? ''),
    requirementScope: String(meta.requirement_scope ?? ''),
    value: String(meta.value ?? ''),
    occurredAt: String(meta.occurred_at ?? ''),
    title: String(payload?.title ?? ''),
    sources: stringList(meta.sources),
    sourceSessionId: String(meta.source_session_id ?? ''),
    sourceTurn: Number(meta.source_turn ?? 0) || 0,
    supersedes: String(meta.supersedes_memory_id ?? ''),
    recordedAt: String(meta.recorded_at ?? ''),
    validFrom: String(meta.valid_from ?? ''),
    validUntil: String(meta.valid_until ?? ''),
    timeExpression: String(meta.time_expression ?? ''),
    timeAnchor: String(meta.time_anchor ?? ''),
    sourceEventTime: String(meta.source_event_time ?? ''),
    basePriority: Number(meta.base_priority ?? 1) || 1,
    softenedAt: String(meta.softened_at ?? ''),
    halfLifeDays: Number(meta.half_life_days ?? 30) || 30,
    priorityFloor: Number(meta.priority_floor ?? 0.01) || 0.01,
    softenCount: Number(meta.soften_count ?? 0) || 0,
  };
}

function parseSourceList(value) {
  return rawList(value).map((item) => {
    if (item && typeof item === 'object') return item;
    try {
      const parsed = JSON.parse(String(item));
      return parsed && typeof parsed === 'object' ? parsed : { session_id: String(item) };
    } catch {
      return { session_id: String(item) };
    }
  });
}


export async function readMemoryNote(ctx, identifier) {
  const {backend,context}=vaultContextFor(ctx);
  const note=await backend.read(identifier,context);
  if(!note)throw new MemoryError('NOTE_NOT_FOUND','read_note failed: NOTE_NOT_FOUND');
  return {...note,frontmatter:note.metadata??{}};
}

async function listPage(ctx, directory, page, pageSize) {
  const {backend,context}=vaultContextFor(ctx);
  const all=await backend.list(directory,context);
  const wanted=String(directory??'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
  const nodes=all.filter(node=>!node.directory_path||node.directory_path===wanted);
  const start=(page-1)*pageSize;
  const selected=nodes.slice(start,start+pageSize);
  return {payload:{nodes:selected,has_more:start+selected.length<nodes.length},nodes:selected};
}

export async function listAllNotes(ctx, directory, { maxNotes = MAX_FORGET_NOTES } = {}) {
  const out = [];
  const pageSize = 100;
  for (let page = 1; page <= 10 && out.length < maxNotes; page += 1) {
    const { payload, nodes } = await listPage(ctx, directory, page, pageSize);
    const files = nodes.filter((node) => node && node.type !== 'directory' && node.permalink);
    out.push(...files);
    if (!payload.has_more || files.length === 0) break;
  }
  return out.slice(0, maxNotes);
}



async function editNote(ctx, args) {
  ctx.assertSourceCurrent?.();
  const {backend,context}=vaultContextFor(ctx);
  try{
    const payload=await backend.edit(args,context);
    return {conflict:false,payload};
  }catch(error){
    if(error?.code==='MEMORY_WRITE_CONFLICT')return {conflict:true,payload:{error:error.message,currentChecksum:error.currentChecksum??null}};
    throw new MemoryError('MEMORY_ERROR','edit_note failed: '+(error instanceof Error?error.message:String(error)));
  }
}

async function searchNotes(ctx, query, pageSize = 20) {
  if (!query) return [];
  try {
    const {backend,context}=vaultContextFor(ctx);
    return await backend.search({
      query,
      page_size: pageSize,
      tags: [MEMORY_TAG],
    },context);
  } catch {
    return [];
  }
}

function isMemoryPermalink(permalink) {
  return /\/(?:facts|events|history)\//i.test(String(permalink ?? ''));
}

export async function hydrateMemory(payload, node) {
  if (!payload || payload.error) return null;
  const meta = noteMetadata(payload);
  if (!meta.memoryId) return null;
  const content = String(payload.content ?? '');
  const body = parseMemoryContent(content);
  let entry;
  try{entry=readMemoryEntry({metadata:noteFrontmatter(payload),content:body?body.value:content,legacyKind:meta.kind,legacyStatus:meta.status});}
  catch(error){entry={type:null,content:body?body.value:content,error:{code:error.code||'INVALID_MEMORY_ENTRY',message:error.message}};}
  return {
    memoryId: meta.memoryId,
    kind: meta.kind,
    status: meta.status,
    subject: body?.subject || meta.subject,
    attribute: body?.attribute || meta.attribute,
    requirementScope: body?.requirementScope || meta.requirementScope,
    value: body?.value || meta.value,
    occurredAt: body?.occurredAt || meta.occurredAt,
    recordedAt: meta.recordedAt || body?.recordedAt || '',
    validFrom: body?.validFrom || meta.validFrom,
    validUntil: body?.validUntil || meta.validUntil,
    timeExpression: body?.timeExpression || meta.timeExpression,
    timeAnchor: body?.timeAnchor || meta.timeAnchor,
    sourceEventTime: body?.sourceEventTime || meta.sourceEventTime,
    title: body?.title || String(payload.title ?? node?.title ?? ''),
    permalink: String(payload.permalink ?? node?.permalink ?? ''),
    checksum: String(payload.checksum ?? ''),
    filePath: String(payload.file_path ?? ''),
    content,
    entry,
    metadata: noteFrontmatter(payload),
    meta,
    priority: priorityFromMetadata(noteFrontmatter(payload)),
    sources: parseSourceList(meta.sources),
  };
}


function personalKindFor(permalink, project) {
  for (const kind of PERSONAL_KINDS) {
    if (personalRecordPath(kind, permalink, project)) return kind;
  }
  return '';
}

function candidateLine(target) {
  const id = target.memoryId ? 'memory_id=' + target.memoryId : 'record=' + target.permalink;
  return [id, 'permalink=' + target.permalink, 'title=' + target.title].join(' | ');
}

function isStructuredSoftenNote(payload) {
  return Object.hasOwn(noteFrontmatter(payload), 'memory_entry_id');
}

async function scopedSoftenEntry(ctx, id) {
  if (!ctx.resolveStructuredEntry) return null;
  ctx.signal?.throwIfAborted();
  const entry = await ctx.resolveStructuredEntry(id, { agent: ctx.agent, signal: ctx.signal });
  ctx.signal?.throwIfAborted();
  if (!entry) return null;
  if (entry.id !== id || typeof entry.permalink !== 'string' || !entry.permalink) {
    throw new MemoryError('INVALID_TARGET', 'structured entry identity does not match');
  }
  if (!MEMORY_ENTRY_TYPES.includes(entry.type)) {
    throw new MemoryError('INVALID_TARGET', 'structured entry type is invalid');
  }
  if (entry.state?.validity === 'historical') {
    throw new MemoryError('INACTIVE_TARGET', 'history notes inherit priority from their active memory');
  }
  if (entry.sourceStatus?.eligible !== true) {
    throw new MemoryError('INVALID_TARGET', 'structured entry sources are unavailable');
  }
  return entry;
}

function structuredSoftenTarget(entry, payload) {
  const metadata = noteFrontmatter(payload);
  if (metadata.memory_entry_id !== entry.id || payload?.permalink !== entry.permalink) {
    throw new MemoryError('INVALID_TARGET', 'structured entry does not match the exact note');
  }
  if (!payload.checksum || !entry.revision) {
    throw new MemoryError('MISSING_CHECKSUM', 'cannot soften a structured entry without its current checksum');
  }
  if (String(payload.checksum) !== entry.revision) {
    throw new MemoryError('STALE_REVISION', 'structured entry changed before soften; read it again');
  }
  if (typeof payload.content !== 'string') {
    throw new MemoryError('INVALID_TARGET', 'structured entry body could not be read');
  }
  return {
    scope: 'structured', kind: entry.type, memoryId: entry.id, title: String(payload.title ?? ''),
    permalink: entry.permalink, checksum: entry.revision, content: payload.content, metadata,
  };
}

async function findMemoryById(ctx, memoryId) {
  const id = String(memoryId ?? '').trim();
  if (!id) return null;
  for (const item of await searchNotes(ctx, id, 20)) {
    const permalink = String(item?.permalink ?? '');
    if (!permalink || !isMemoryPermalink(permalink)) continue;
    const payload = await readMemoryNote(ctx, permalink);
    if (isStructuredSoftenNote(payload)) continue;
    const note = await hydrateMemory(payload, { permalink });
    if (note?.memoryId === id) return note;
  }
  for (const kind of ['fact', 'event']) {
    const nodes = await listAllNotes(ctx, memoryDirectory(ctx.config, kind), { maxNotes: 300 }).catch(() => []);
    for (const node of nodes) {
      if (!node?.permalink) continue;
      const payload = await readMemoryNote(ctx, node.permalink);
      if (isStructuredSoftenNote(payload)) continue;
      const note = await hydrateMemory(payload, node);
      if (note?.memoryId === id) return note;
    }
  }
  return null;
}

async function resolveSoftenTarget(ctx, { memoryId, identifier, query }) {
  const exact = String(identifier ?? '').trim();
  const byId = String(memoryId ?? '').trim();
  if (exact) {
    const payload = await readMemoryNote(ctx, exact);
    const permalink = String(payload?.permalink ?? exact);
    if (isStructuredSoftenNote(payload)) {
      const id = noteFrontmatter(payload).memory_entry_id;
      if (payload.permalink !== exact || typeof id !== 'string' || !id || (byId && byId !== id)) {
        throw new MemoryError('INVALID_TARGET', 'pass the exact structured entry permalink or ID');
      }
      const entry = await scopedSoftenEntry(ctx, id);
      if (!entry) throw new MemoryError('TARGET_NOT_FOUND', 'structured entry is not available in this scope');
      return structuredSoftenTarget(entry, payload);
    }
    if (isPersonalPermalink(permalink)) {
      const kind = personalKindFor(permalink, ctx.project);
      if (!kind) throw new MemoryError('INVALID_TARGET', 'outside the dafeiyu record namespace: ' + permalink);
      return {
        scope: 'personal',
        kind,
        memoryId: '',
        title: String(payload?.title ?? ''),
        permalink,
        checksum: String(payload?.checksum ?? ''),
        content: String(payload?.content ?? ''),
        metadata: noteFrontmatter(payload),
      };
    }
    const note = await hydrateMemory(payload, { permalink });
    if (!note) throw new MemoryError('INVALID_TARGET', 'not a managed fact/event memory: ' + permalink);
    if (note.kind === 'history') throw new MemoryError('INVALID_TARGET', 'history notes inherit priority from their active memory');
    if (note.kind !== 'fact' && note.kind !== 'event') throw new MemoryError('INVALID_TARGET', 'not a fact/event memory');
    if (note.status !== MEMORY_STATUS.active) throw new MemoryError('INACTIVE_TARGET', 'only active memories can be softened');
    return { scope: 'memory', kind: note.kind, memoryId: note.memoryId, title: note.title, permalink: note.permalink, checksum: note.checksum, content: note.content, metadata: note.metadata, sources:note.sources };
  }

  if (byId) {
    const entry = await scopedSoftenEntry(ctx, byId);
    if (entry) return structuredSoftenTarget(entry, await readMemoryNote(ctx, entry.permalink));
    const note = await findMemoryById(ctx, byId);
    if (!note) throw new MemoryError('TARGET_NOT_FOUND', 'no active memory has memory_id ' + byId);
    if (note.status !== MEMORY_STATUS.active) throw new MemoryError('INACTIVE_TARGET', 'only active memories can be softened');
    return { scope: 'memory', kind: note.kind, memoryId: note.memoryId, title: note.title, permalink: note.permalink, checksum: note.checksum, content: note.content, metadata: note.metadata, sources:note.sources };
  }

  const text = collapseWhitespace(String(query ?? ''));
  if (!text) throw new MemoryError('INVALID_ARGUMENT', 'pass memoryId, identifier, or query');
  const found = [];
  const seen = new Set();
  for (const item of await searchNotes(ctx, text, 8)) {
    const permalink = String(item?.permalink ?? '');
    if (!permalink || !isMemoryPermalink(permalink) || seen.has(permalink)) continue;
    seen.add(permalink);
    const payload = await readMemoryNote(ctx, permalink);
    if (isStructuredSoftenNote(payload)) continue;
    const note = await hydrateMemory(payload, { permalink });
    if (!note || note.kind === 'history' || note.status !== MEMORY_STATUS.active) continue;
    found.push(note);
  }
  if (found.length === 0) throw new MemoryError('TARGET_NOT_FOUND', 'no matching active memory for: ' + text);
  // A fuzzy query is only a candidate finder. Actual softening always needs
  // an exact memoryId or identifier so one query can never alter several notes.
  return { candidates: found.slice(0, 8).map(candidateLine) };
}

async function applySoftenPatch(ctx, target, { reason, now }) {
  if (!target.checksum) throw new MemoryError('MISSING_CHECKSUM', 'cannot soften a note without its current checksum');
  const structured = target.scope === 'structured';
  if (structured) {
    // Recheck authorization and lineage inside the mutation lock. The backend
    // checksum still guards against Markdown edits outside this process.
    const entry = await scopedSoftenEntry(ctx, target.memoryId);
    if (!entry || entry.permalink !== target.permalink || entry.revision !== target.checksum) {
      throw new MemoryError('STALE_REVISION', 'structured entry changed before soften; read it again');
    }
  }
  const patch = softenPriorityPatch(target.metadata, {
    factor: ctx.config.softenFactor,
    halfLifeDays: ctx.config.halfLifeDays,
    priorityFloor: ctx.config.priorityFloor,
    naturalDecayStartedAt: ctx.config.naturalDecayStartedAt,
    now,
    reason,
  });
  const written = await editNote(ctx, {
    identifier: target.permalink,
    operation: 'append',
    content: '',
    expected_checksum: target.checksum,
    project: ctx.project,
    metadata: patch,
    output_format: 'json',
  });
  if (written.conflict) throw new MemoryError('STALE_REVISION', 'memory changed before soften; read it again');
  const payload = await readMemoryNote(ctx, structured ? target.permalink : String(written.payload?.permalink ?? target.permalink));
  const afterMeta = noteFrontmatter(payload);
  if (structured && (afterMeta.memory_entry_id !== target.memoryId || payload.permalink !== target.permalink)) {
    throw new MemoryError('STALE_REVISION', 'structured entry identity changed during soften; read it again');
  }
  const priority = priorityFromMetadata(afterMeta, {
    now,
    halfLifeDays: ctx.config.halfLifeDays,
    priorityFloor: ctx.config.priorityFloor,
  });
  const bodyUnchanged = target.content === undefined || ((!structured || typeof payload?.content === 'string')
    && stripFrontmatter(payload?.content ?? '') === stripFrontmatter(target.content));
  if (structured && bodyUnchanged && (priority.basePriority !== patch.base_priority || priority.softenCount !== patch.soften_count
    || Date.parse(priority.softenedAt) !== Date.parse(patch.softened_at))) {
    throw new MemoryError('SOFTEN_FAILED', 'could not verify structured entry priority after editing');
  }
  return {
    scope: target.scope,
    kind: target.kind,
    memoryId: target.memoryId,
    permalink: String(payload?.permalink ?? target.permalink),
    title: String(payload?.title ?? target.title),
    basePriority: priority.basePriority,
    effectivePriority: priority.effectivePriority,
    softenedAt: priority.softenedAt,
    bodyUnchanged,
    patch,
  };
}

/** Apply one explicit soft-downweight request. Never deletes or edits note body. */
export async function softenMemory(ctx, args = {}) {
  const now = typeof ctx.now === 'function' ? ctx.now() : ctx.now;
  try {
    const resolved = await resolveSoftenTarget(ctx, args);
    if (Array.isArray(resolved?.candidates)) {
      return {
        ok: false,
        action: 'soften',
        kind: '',
        memoryId: '',
        permalink: '',
        basePriority: 0,
        effectivePriority: 0,
        softenedAt: '',
        bodyUnchanged: true,
        summary: '找到 ' + resolved.candidates.length + ' 个候选，尚未修改；请用其中一条的 memoryId 或 identifier 再调用以实际降权。',
        candidates: resolved.candidates,
        errorCode: 'NEEDS_SELECTION',
        errorMessage: 'multiple candidate memories match; choose one explicitly',
      };
    }
    const apply = () => applySoftenPatch(ctx, resolved, { reason: args.reason, now });
    const applied = resolved.scope === 'structured' ? await withCommitLock(apply) : await apply();
    const softenFactor = applied.patch?.soften_factor ?? ctx.config.softenFactor;
    let rawSummary='';
    if(applied.scope!=='structured'&&applied.bodyUnchanged&&typeof ctx.onSourcesSoftened==='function'){
      try{
        const sources=resolved.sources?.length?resolved.sources:resolved.metadata?.source_message_id?[{message_id:resolved.metadata.source_message_id}]:[];
        const linked=await ctx.onSourcesSoftened({sources,memoryId:applied.memoryId,
          weight:Math.pow(Number(softenFactor),Number(applied.patch?.soften_count)||1)});
        if(linked?.affected)rawSummary=' 已同步降低相同来源整轮原句的召回权重。';
      }catch(error){ctx.logger?.warn?.('[basic-memory-bridge] raw priority sync failed: '+error.message);rawSummary=' 原句关联降权未完成，需要重试同步。';}
    }
    return {
      ok: applied.bodyUnchanged,
      action: 'soften',
      kind: applied.kind,
      memoryId: applied.memoryId,
      permalink: applied.permalink,
      basePriority: applied.basePriority,
      effectivePriority: applied.effectivePriority,
      softenedAt: applied.softenedAt,
      bodyUnchanged: applied.bodyUnchanged,
      summary: applied.bodyUnchanged
        ? '已降权：从当前有效权重按系数 ' + softenFactor + ' 调整（默认 0.5，即减半），原文与附件保留；仅降低默认召回排序，明确强线索仍可召回。未删除、未停用、未影响其他记录。'+rawSummary
        : '已写入降权元数据，但回读发现正文变化，请人工核对；未删除任何内容。',
      candidates: [],
      errorCode: applied.bodyUnchanged ? '' : 'BODY_CHANGED',
      errorMessage: applied.bodyUnchanged ? '' : 'note body changed during metadata-only edit',
    };
  } catch (error) {
    const code = error instanceof MemoryError ? error.code : 'SOFTEN_FAILED';
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      action: 'soften',
      kind: '',
      memoryId: '',
      permalink: '',
      basePriority: 0,
      effectivePriority: 0,
      softenedAt: '',
      bodyUnchanged: true,
      summary: '未降权：' + code + ' — ' + message,
      candidates: [],
      errorCode: code,
      errorMessage: message,
    };
  }
}

/** Native tool for an explicit "forget/soften/stop bringing this up" request. */
export function createSoftenTool({ tools, config, getConfig, logger, now, onSoftened, onSourcesSoftened, softenRawMessage, resolveStructuredEntry } = {}) {
  return {
    name: 'soften_memory',
    description: 'Soft-downweight exactly one named long-term memory or one whole dafeiyu personal note when the user explicitly asks to stop bringing it up, downweight it, soften it, or forget it. This never deletes or rewrites the note body: it only lowers default recall ranking and records when it was softened. Strong cues can still retrieve it. Pass memory_id from a recall block, or an exact permalink; a fuzzy query returns candidates and changes nothing until one is chosen. Do not confirm the downweight until this tool succeeds.',
    parameters: {
      rawMessageId:{type:'string',description:'Exact original message ID from an authorized raw recall block; downweights that source turn, keeping its text.'},
      memoryId: {
        type: 'string',
        description: 'Exact memory ID of one active fact/event or structured entry (from a recall block or search).',
      },
      identifier: {
        type: 'string',
        description: 'Exact Basic Memory permalink of one active fact/event, structured entry, or dafeiyu personal note.',
      },
      query: {
        type: 'string',
        description: 'User wording used only to find candidates when no exact id/permalink is known. Multiple matches return candidates without writing.',
      },
      reason: {
        type: 'string',
        description: 'Short reason from the user request, stored as metadata for review.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          kind: { type: 'string' },
          memoryId: { type: 'string' },
          permalink: { type: 'string' },
          basePriority: { type: 'number' },
          effectivePriority: { type: 'number' },
          softenedAt: { type: 'string' },
          bodyUnchanged: { type: 'boolean' },
          summary: { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
          errorCode: { type: 'string' },
          errorMessage: { type: 'string' },
        },
        required: ['ok', 'action', 'kind', 'memoryId', 'permalink', 'basePriority', 'effectivePriority', 'softenedAt', 'bodyUnchanged', 'summary', 'candidates', 'errorCode', 'errorMessage'],
      },
      render(args, value) {
        const lines = [value.summary];
        if (Array.isArray(value.candidates) && value.candidates.length > 0) {
          lines.push('candidates:', ...value.candidates.map((item) => '- ' + item));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const runtimeConfig = getConfig ? await getConfig() : config;
      if(args?.rawMessageId){
        const raw=await softenRawMessage?.(String(args.rawMessageId));
        const result={ok:Boolean(raw?.ok),action:'soften',kind:'raw',memoryId:'',permalink:'raw-message:'+args.rawMessageId,
          basePriority:raw?.weight??0,effectivePriority:raw?.weight??0,softenedAt:raw?.ok?new Date().toISOString():'',bodyUnchanged:true,
          summary:raw?.ok?'已降低该消息所在整轮原句的默认召回权重，原文保留，明确线索仍可召回。':'没有找到当前主体可管理的原消息。',
          candidates:[],errorCode:raw?.ok?'':'TARGET_NOT_FOUND',errorMessage:raw?.ok?'':'no authorized raw source'};
        if(result.ok)await onSoftened?.(exec?.agent?.session?.id,result);
        return result;
      }
      const result = await softenMemory({
        tools,
        agent: exec?.agent,
        signal: exec?.signal,
        config: runtimeConfig,
        project: config?.project ?? 'personal',
        logger,
        now,
        onSourcesSoftened,
        resolveStructuredEntry,
      }, args ?? {});
      if (!result.ok) {
        logger?.warn?.('[basic-memory-bridge] soften_memory failed: ' + result.errorCode + ' ' + result.errorMessage);
      } else if (typeof onSoftened === 'function') {
        try {
          await onSoftened(exec?.agent?.session?.id, result);
        } catch (error) {
          logger?.warn?.('[basic-memory-bridge] soften callback failed: ' + (error instanceof Error ? error.message : String(error)));
        }
      }
      return result;
    },
  };
}

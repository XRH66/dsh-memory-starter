import fs from 'node:fs/promises';
import path from 'node:path';
import {parseLegacyNote} from '../legacy-notes.js';
import {
  MAX_INHERIT_FILE_BYTES,
  MAX_INHERIT_TEXT_CHARACTERS,
  inheritHeader,
  isInheritTime,
  splitInheritText,
} from './format.js';

const ENTRY_START = '<!-- dsh-memory-entry:start -->';
const ENTRY_END = '<!-- dsh-memory-entry:end -->';
const TOPIC_LINE_PREFIX = '主题：';
const ENTRY_SCHEMA = 'memory-entry-v1';
const SYSTEM_03 = 'basic-memory-0.3';
const SYSTEM_06 = 'basic-memory-0.6';

export const INHERIT_VAULT_DIRECTORIES = Object.freeze([
  'chats/facts',
  'chats/events',
  'chats/history',
  'chats/review',
  'chats/entries',
  'chats/topics',
]);

const toPosix = value => value.split(path.sep).join('/');
const characterLength = value => Array.from(String(value ?? '')).length;

function uniqueStrings(values) {
  return [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))];
}

function legacyTags(metadata) {
  const tags = Array.isArray(metadata.tags) ? metadata.tags : [];
  const tagged = [];
  for (const key of ['subject', 'attribute', 'memory_kind', 'type']) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) tagged.push(`${key}:${value.trim()}`);
  }
  return uniqueStrings([...tags, ...tagged]);
}

function originalTags(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return uniqueStrings(value);
  if (typeof value !== 'string') return [];
  const text = value.trim();
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return uniqueStrings(parsed);
    } catch {
      return [];
    }
  }
  return uniqueStrings(text.split(',').map(item => item.trim()));
}

function structuredTags(metadata) {
  const tagged = [];
  for (const key of [
    'memory_type',
    'state_validity',
    'state_progress',
    'evidence_basis',
    'occurred_at',
  ]) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) tagged.push(`${key}:${value.trim()}`);
  }
  return uniqueStrings([...originalTags(metadata.tags), ...tagged]);
}

async function childFiles(directory) {
  let entries;
  try { entries = await fs.readdir(directory,{withFileTypes:true}); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const files = [];
  for (const entry of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
    const full = path.join(directory,entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await childFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function skip(relative, reason) {
  return {file:relative, reason};
}

function isWithin(relative, directory) {
  return relative.startsWith(directory + '/');
}

function isBasic03Path(relative) {
  return ['chats/facts','chats/events','chats/review'].some(directory => isWithin(relative,directory));
}

function normalizeLegacyPath(value) {
  return String(value ?? '').replace(/\\/g,'/').replace(/^\.\/+/,'').replace(/^\/+/,'');
}

function parseJsonMetadata(metadata, key) {
  const value = metadata[key];
  if (value === undefined || value === null || value === '') return {value:null};
  if (typeof value !== 'string') return {value};
  try {
    return {value:JSON.parse(value)};
  } catch {
    return {error:true};
  }
}

function markerPositions(text, marker) {
  const output = [];
  let offset = 0;
  while ((offset = text.indexOf(marker,offset)) >= 0) {
    output.push(offset);
    offset += marker.length;
  }
  return output;
}

function entryUserSupplement(content, start, end, title) {
  const before = content.slice(0,start);
  const after = content.slice(end + ENTRY_END.length);
  const beforeLines = before.split(/\r?\n/);
  const firstContent = beforeLines.findIndex(line => line.trim());
  if (firstContent >= 0) {
    const line = beforeLines[firstContent].trimEnd();
    const expectedTitle = typeof title === 'string' && title.trim() ? '# ' + title.trim() : null;
    if ((expectedTitle && line === expectedTitle) || (!expectedTitle && /^#\s+/u.test(line))) {
      beforeLines.splice(firstContent,1);
    }
  }
  return [...beforeLines, ...after.split(/\r?\n/)]
    .filter(line => !line.startsWith(TOPIC_LINE_PREFIX))
    .join('\n')
    .trim();
}

function entryText(content, metadata) {
  const starts = markerPositions(content,ENTRY_START);
  const ends = markerPositions(content,ENTRY_END);
  if (!starts.length || !ends.length) return {reason:'正文标记缺失'};
  if (starts.length > 1 || ends.length > 1) return {reason:'正文标记重复'};
  const start = starts[0], end = ends[0];
  if (end < start) return {reason:'正文标记顺序错误'};
  const managed = content.slice(start + ENTRY_START.length,end).replace(/^\r?\n|\r?\n$/g,'');
  const supplement = entryUserSupplement(content,start,end,metadata.title);
  let text = managed;
  if (supplement) text = text.trim() ? text + '\n\n' + supplement : supplement;
  return text.trim() ? {text} : {reason:'正文为空'};
}

function topicSupplement(content, name) {
  const normalized = String(content ?? '').replace(/\r\n/g,'\n').replace(/^\n+/,'');
  const fixed = '# ' + name + '\n\n本页由记忆框架自动维护，可在下方自由补充\n';
  if (normalized.trimEnd() === fixed.trimEnd()) return {fixed:true,text:''};
  if (!normalized.startsWith(fixed)) return {reason:'主题页固定内容无法识别'};
  return {fixed:false,text:normalized.slice(fixed.length).trim()};
}

function isEntryMetadata(metadata) {
  return metadata.memory_entry_schema === ENTRY_SCHEMA;
}

function isEntryHistory(relative, metadata) {
  if (!isWithin(relative,'chats/history') || metadata.memory_id) return false;
  return metadata.memory_entry_schema === ENTRY_SCHEMA
    || Boolean(metadata.memory_entry_id)
    || Boolean(metadata.memory_type);
}

function splitRecords(relative, text, {
  sourceSystem,
  time,
  tags,
  maxTextCharacters,
  id = relative,
}) {
  const parts = splitInheritText(text,maxTextCharacters);
  if (!parts?.length) {
    return {reason:`正文超过 ${maxTextCharacters} 字，且找不到可保留原文的段落边界`};
  }
  const records = [];
  for (const [index,part] of parts.entries()) {
    if (characterLength(part) > maxTextCharacters) {
      return {reason:'正文切片后仍超过上限'};
    }
    const record = {
      id:parts.length > 1 ? `${id}#part-${index + 1}` : id,
      speaker:'summary',
      kind:'note',
      text:part,
      source:{system:sourceSystem,file:relative},
    };
    if (time !== undefined) record.time = String(time);
    if (tags.length) record.tags = tags;
    if (parts.length > 1) record.part = index + 1;
    records.push(record);
  }
  return {records};
}

function preparedEntry(relative, parsed, {
  includeDerived,
  maxTextCharacters,
}) {
  const metadata = parsed.metadata;
  const body = entryText(String(parsed.content ?? ''),metadata);
  if (body.reason) return {status:'skipped',reason:body.reason};

  const sourceRefs = parseJsonMetadata(metadata,'memory_source_refs');
  if (sourceRefs.error || (sourceRefs.value !== null && !Array.isArray(sourceRefs.value))) {
    return {status:'skipped',reason:'memory_source_refs 不是有效 JSON 数组'};
  }
  const legacyImport = parseJsonMetadata(metadata,'legacy_import_from');
  if (legacyImport.error
    || (legacyImport.value !== null
      && (!legacyImport.value || typeof legacyImport.value !== 'object' || Array.isArray(legacyImport.value)))) {
    return {status:'skipped',reason:'legacy_import_from 不是有效 JSON 对象'};
  }
  const importedFromLegacy = legacyImport.value !== null;
  const legacyTarget = importedFromLegacy && typeof legacyImport.value.path === 'string'
    ? normalizeLegacyPath(legacyImport.value.path)
    : '';
  if (importedFromLegacy && !legacyTarget) {
    return {status:'skipped',reason:'legacy_import_from 缺少旧笔记路径'};
  }

  const refs = sourceRefs.value ?? [];
  const manual = metadata.evidence_basis === 'manual';
  if (!importedFromLegacy && !manual && refs.length && !includeDerived) {
    return {
      status:'skipped',
      reason:'由对话整理而来，原话已在原话库',
      legacyTarget,
    };
  }

  const time = metadata.recorded_at ?? metadata.created;
  if (time !== undefined && !isInheritTime(String(time))) {
    return {status:'skipped',reason:'recorded_at/created 时间格式无法识别',legacyTarget};
  }
  // The entry's own id survives a rename in Obsidian, so a rerun still finds the earlier import.
  const entryId = typeof metadata.memory_entry_id === 'string' && metadata.memory_entry_id.trim()
    ? metadata.memory_entry_id.trim() : relative;
  const converted = splitRecords(relative,body.text,{
    sourceSystem:SYSTEM_06,
    time,
    tags:structuredTags(metadata),
    maxTextCharacters,
    id:entryId,
  });
  if (converted.reason) return {status:'skipped',reason:converted.reason,legacyTarget};
  return {status:'imported',records:converted.records,legacyTarget};
}

function preparedTopic(relative, parsed, maxTextCharacters) {
  const name = path.posix.basename(relative,'.md');
  const supplement = topicSupplement(parsed.content,name);
  if (supplement.reason) return {status:'skipped',reason:supplement.reason};
  if (supplement.fixed) return {status:'skipped',reason:'主题页固定内容'};
  if (!supplement.text) return {status:'skipped',reason:'主题页没有用户补充'};
  const metadata = parsed.metadata;
  const time = metadata.recorded_at ?? metadata.created;
  if (time !== undefined && !isInheritTime(String(time))) {
    return {status:'skipped',reason:'recorded_at/created 时间格式无法识别'};
  }
  const converted = splitRecords(relative,supplement.text,{
    sourceSystem:SYSTEM_06,
    time,
    tags:[`topic:${name}`],
    maxTextCharacters,
  });
  if (converted.reason) return {status:'skipped',reason:converted.reason};
  return {status:'imported',records:converted.records};
}

function legacy03File(relative, parsed, maxTextCharacters) {
  const metadata = parsed.metadata;
  const value = typeof metadata.value === 'string' ? metadata.value : '';
  const body = value.trim() ? value : String(parsed.content ?? '').trim();
  if (!body) return {status:'skipped',reason:'正文为空'};
  const time = metadata.recorded_at ?? metadata.created;
  if (time !== undefined && !isInheritTime(String(time))) {
    return {status:'skipped',reason:'recorded_at/created 时间格式无法识别'};
  }
  const converted = splitRecords(relative,body,{
    sourceSystem:SYSTEM_03,
    time,
    tags:legacyTags(metadata),
    maxTextCharacters,
  });
  if (converted.reason) return {status:'skipped',reason:converted.reason};
  return {status:'imported',records:converted.records};
}

function incrementReason(target, reason) {
  target[reason] = (target[reason] ?? 0) + 1;
}

function sortedCounts(value) {
  return Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)));
}

export async function convertLegacyVault(vaultPath, {
  directories = INHERIT_VAULT_DIRECTORIES,
  maxFileBytes = MAX_INHERIT_FILE_BYTES,
  maxTextCharacters = MAX_INHERIT_TEXT_CHARACTERS,
  includeDerived = false,
  now = new Date(),
} = {}) {
  const root = path.resolve(vaultPath);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Vault 路径必须是普通目录');
  const skipped = [];
  const files = [];
  for (const directory of directories) {
    const base = path.join(root,...directory.split('/'));
    for (const file of await childFiles(base)) files.push(file);
  }
  files.sort((a,b)=>toPosix(path.relative(root,a)).localeCompare(toPosix(path.relative(root,b))));

  const candidates = [];
  for (const full of files) {
    const relative = toPosix(path.relative(root,full));
    let fileStat;
    try { fileStat = await fs.lstat(full); }
    catch { continue; }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) continue;
    if (fileStat.size > maxFileBytes) {
      skipped.push(skip(relative,`文件超过 ${Math.floor(maxFileBytes / 1024 / 1024)}MB 上限`));
      continue;
    }
    let text;
    try { text = await fs.readFile(full,'utf8'); }
    catch (error) {
      skipped.push(skip(relative,'读取失败：' + (error?.message || String(error))));
      continue;
    }
    candidates.push({relative,parsed:parseLegacyNote(text)});
  }

  const summary = {
    basicMemory03:{imported:0,skipped:0},
    entries:{imported:0,skipped:0,skippedByReason:{}},
    topics:{imported:0,skipped:0,skippedByReason:{}},
    entryHistory:{skipped:0},
    replacedBasicMemory03:{skipped:0},
  };
  const prepared = new Map();
  const replacementTargets = new Set();

  for (const candidate of candidates) {
    if (!candidate.parsed || !isEntryMetadata(candidate.parsed.metadata)
      || !isWithin(candidate.relative,'chats/entries')) continue;
    const result = preparedEntry(candidate.relative,candidate.parsed,{includeDerived,maxTextCharacters});
    prepared.set(candidate.relative,result);
    if (result.status === 'imported' && result.legacyTarget) replacementTargets.add(result.legacyTarget);
  }

  const records = [];
  for (const candidate of candidates) {
    const {relative,parsed} = candidate;
    if (!parsed) {
      if (isWithin(relative,'chats/entries')) {
        summary.entries.skipped += 1;
        incrementReason(summary.entries.skippedByReason,'文件头无法解析');
        skipped.push(skip(relative,'文件头无法解析'));
      } else if (isWithin(relative,'chats/topics')) {
        summary.topics.skipped += 1;
        incrementReason(summary.topics.skippedByReason,'文件头无法解析');
        skipped.push(skip(relative,'文件头无法解析'));
      } else if (isWithin(relative,'chats/history')) {
        summary.entryHistory.skipped += 1;
        skipped.push(skip(relative,'文件头无法解析'));
      } else {
        if (isBasic03Path(relative)) summary.basicMemory03.skipped += 1;
        skipped.push(skip(relative,'文件头无法解析'));
      }
      continue;
    }

    const metadata = parsed.metadata;
    if (isEntryHistory(relative,metadata)) {
      summary.entryHistory.skipped += 1;
      skipped.push(skip(relative,'条目旧版本存档'));
      continue;
    }

    if (isEntryMetadata(metadata) && isWithin(relative,'chats/entries')) {
      const result = prepared.get(relative);
      if (result.status === 'imported') {
        summary.entries.imported += 1;
        records.push(...result.records);
      } else {
        summary.entries.skipped += 1;
        incrementReason(summary.entries.skippedByReason,result.reason);
        skipped.push(skip(relative,result.reason));
      }
      continue;
    }

    if (isWithin(relative,'chats/topics')) {
      const result = preparedTopic(relative,parsed,maxTextCharacters);
      if (result.status === 'imported') {
        summary.topics.imported += 1;
        records.push(...result.records);
      } else {
        summary.topics.skipped += 1;
        incrementReason(summary.topics.skippedByReason,result.reason);
        skipped.push(skip(relative,result.reason));
      }
      continue;
    }

    if (metadata.memory_id) {
      if (replacementTargets.has(relative)) {
        summary.replacedBasicMemory03.skipped += 1;
        skipped.push(skip(relative,'已由新版条目接替'));
        continue;
      }
      const result = legacy03File(relative,parsed,maxTextCharacters);
      if (result.status === 'imported') {
        summary.basicMemory03.imported += 1;
        records.push(...result.records);
      } else {
        summary.basicMemory03.skipped += 1;
        skipped.push(skip(relative,result.reason));
      }
    }
  }

  summary.entries.skippedByReason = sortedCounts(summary.entries.skippedByReason);
  summary.topics.skippedByReason = sortedCounts(summary.topics.skippedByReason);
  return {
    vault:root,
    scanned:files.length,
    header:inheritHeader('从旧版 Vault 导出',now.toISOString()),
    records,
    errors:[],
    unknownFields:[],
    conversionSkipped:skipped,
    conversion:summary,
  };
}

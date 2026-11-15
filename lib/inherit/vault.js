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

export const INHERIT_VAULT_DIRECTORIES = Object.freeze([
  'chats/facts',
  'chats/events',
  'chats/history',
  'chats/review',
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

export async function convertLegacyVault(vaultPath, {
  directories = INHERIT_VAULT_DIRECTORIES,
  maxFileBytes = MAX_INHERIT_FILE_BYTES,
  maxTextCharacters = MAX_INHERIT_TEXT_CHARACTERS,
  now = new Date(),
} = {}) {
  const root = path.resolve(vaultPath);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw Error('Vault 路径必须是普通目录');
  const records = [], skipped = [];
  const files = [];
  for (const directory of directories) {
    const base = path.join(root,...directory.split('/'));
    for (const file of await childFiles(base)) files.push(file);
  }
  files.sort((a,b)=>toPosix(path.relative(root,a)).localeCompare(toPosix(path.relative(root,b))));
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
    const parsed = parseLegacyNote(text);
    if (!parsed) {
      skipped.push(skip(relative,'文件头无法解析'));
      continue;
    }
    if (!parsed.metadata.memory_id) continue;
    const value = typeof parsed.metadata.value === 'string' ? parsed.metadata.value : '';
    const body = value.trim() ? value : String(parsed.content ?? '').trim();
    if (!body) {
      skipped.push(skip(relative,'正文为空'));
      continue;
    }
    const time = parsed.metadata.recorded_at ?? parsed.metadata.created;
    if (time !== undefined && !isInheritTime(String(time))) {
      skipped.push(skip(relative,'recorded_at/created 时间格式无法识别'));
      continue;
    }
    const parts = splitInheritText(body,maxTextCharacters);
    if (!parts?.length) {
      skipped.push(skip(relative,`正文超过 ${maxTextCharacters} 字，且找不到可保留原文的段落边界`));
      continue;
    }
    const tags = legacyTags(parsed.metadata);
    for (const [index,part] of parts.entries()) {
      if (characterLength(part) > maxTextCharacters) {
        skipped.push(skip(relative,'正文切片后仍超过上限'));
        break;
      }
      const record = {
        id:parts.length > 1 ? `${relative}#part-${index + 1}` : relative,
        speaker:'summary',
        kind:'note',
        text:part,
        source:{system:'basic-memory-0.3',file:relative},
      };
      if (time !== undefined) record.time = String(time);
      if (tags.length) record.tags = tags;
      if (parts.length > 1) record.part = index + 1;
      records.push(record);
    }
  }
  return {
    vault:root,
    scanned:files.length,
    header:inheritHeader('从旧版 Vault 导出',now.toISOString()),
    records,
    errors:[],
    unknownFields:[],
    conversionSkipped:skipped,
  };
}

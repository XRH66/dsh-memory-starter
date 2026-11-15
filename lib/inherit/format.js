import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const INHERIT_STANDARD = 'dsh-memory-inherit';
export const INHERIT_VERSION = 1;
export const MAX_INHERIT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_INHERIT_RECORDS = 100_000;
export const MAX_INHERIT_TEXT_CHARACTERS = 20_000;

const HEADER_FIELDS = new Set(['standard', 'version', 'source', 'created']);
const RECORD_FIELDS = new Set([
  'id', 'time', 'speaker', 'kind', 'text', 'source', 'conversation', 'order', 'part', 'tags',
]);
const SOURCE_FIELDS = new Set(['system', 'file', 'locator']);
const SPEAKERS = new Set(['user', 'assistant', 'summary']);
const KINDS = new Set(['message', 'note', 'diary']);
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/u;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/u;

const sha256 = value => createHash('sha256').update(String(value), 'utf8').digest('hex');
const characters = value => Array.from(String(value ?? '')).length;
const nonEmptyString = value => typeof value === 'string' && value.trim().length > 0;

function calendarDate(year, month, day) {
  const value = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return value.getUTCFullYear() === Number(year)
    && value.getUTCMonth() === Number(month) - 1
    && value.getUTCDate() === Number(day);
}

export function isInheritTime(value) {
  if (typeof value !== 'string') return false;
  const dateOnly = DATE_ONLY.exec(value);
  if (dateOnly) return calendarDate(dateOnly[1], dateOnly[2], dateOnly[3]);
  const match = DATE_TIME.exec(value);
  if (!match || !calendarDate(match[1], match[2], match[3])) return false;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (match[8] !== 'Z') {
    const offsetHour = Number(match[8].slice(1, 3));
    const offsetMinute = Number(match[8].slice(4, 6));
    if (offsetHour > 23 || offsetMinute > 59) return false;
  }
  return Number.isFinite(Date.parse(value));
}

export function inheritTimeMs(value) {
  if (!isInheritTime(value)) return null;
  if (DATE_ONLY.test(value)) return Date.parse(value + 'T00:00:00Z');
  return Date.parse(value);
}

export function inheritHeader(source = '从旧版 Vault 导出', created = new Date().toISOString()) {
  return {standard: INHERIT_STANDARD, version: INHERIT_VERSION, source: String(source), created};
}

export function canonicalInheritRecord(record) {
  const output = {
    speaker: record.speaker,
    kind: record.kind,
    text: record.text,
    source: {
      system: record.source.system,
      file: record.source.file,
      ...(record.source.locator === undefined ? {} : {locator: record.source.locator}),
    },
  };
  for (const key of ['id', 'time', 'conversation', 'order', 'part']) {
    if (record[key] !== undefined) output[key] = record[key];
  }
  if (record.tags !== undefined) output.tags = [...record.tags];
  return output;
}

export function inheritRecordIdentity(record) {
  const part = record.part ?? 1;
  const stable = record.id === undefined
    ? ['hash', record.source.system, record.time ?? null, record.speaker, record.text, part]
    : ['id', record.source.system, record.id, part];
  return {
    sourceKey: 'inherit:' + sha256(JSON.stringify(stable)),
    textHash: sha256(record.text),
  };
}

export function splitInheritText(text, limit = MAX_INHERIT_TEXT_CHARACTERS) {
  const source = String(text ?? '');
  if (!source.trim()) return [];
  if (characters(source) <= limit) return [source];
  const points = Array.from(source);
  const parts = [];
  let start = 0;
  while (start < points.length) {
    if (points.length - start <= limit) {
      parts.push(points.slice(start).join(''));
      break;
    }
    let boundary = -1;
    const ceiling = start + limit;
    for (let index = start + 1; index < ceiling; index += 1) {
      const current = points[index - 1];
      const next = points[index];
      if (current === '\n' && (next === '\n' || next === '\r')) boundary = index;
      else if (current === '\n' || current === '\r') boundary = index;
      else if ('。！？；!?;'.includes(current)) boundary = index;
    }
    if (boundary <= start) return null;
    parts.push(points.slice(start, boundary).join(''));
    start = boundary;
  }
  return parts;
}

function error(line, field, problem, fix) {
  return {line, field, problem, fix};
}

function addUnknown(unknown, field) {
  unknown.set(field, (unknown.get(field) ?? 0) + 1);
}

function validateHeader(value, errors, unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(error(1, '$', '文件头必须是 JSON 对象', '把第一行改成 {"standard":"dsh-memory-inherit","version":1,...}'));
    return false;
  }
  for (const key of Object.keys(value)) if (!HEADER_FIELDS.has(key)) addUnknown(unknown, key);
  let valid = true;
  if (value.standard !== INHERIT_STANDARD) {
    errors.push(error(1, 'standard', '标准标识不正确', '把 standard 改成 "dsh-memory-inherit"'));
    valid = false;
  }
  if (value.version !== INHERIT_VERSION) {
    errors.push(error(1, 'version', '版本号不正确', '把 version 改成数字 1'));
    valid = false;
  }
  if (value.source !== undefined && typeof value.source !== 'string') {
    errors.push(error(1, 'source', 'source 必须是字符串', '改成说明来源的字符串'));
    valid = false;
  }
  if (value.created !== undefined && !isInheritTime(value.created)) {
    errors.push(error(1, 'created', 'created 不是带时区的完整时间或日期', '改成如 2026-11-15T10:00:00+08:00'));
    valid = false;
  }
  return valid;
}

export function validateInheritRecord(value, line) {
  const errors = [], unknown = new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {errors:[error(line, '$', '记录必须是 JSON 对象', '把这一行写成一个 JSON 对象')], unknown};
  }
  for (const key of Object.keys(value)) if (!RECORD_FIELDS.has(key)) addUnknown(unknown, key);
  if (!nonEmptyString(value.text)) {
    errors.push(error(line, 'text', '正文缺失或为空', '补上原样正文字符串'));
  } else if (characters(value.text) > MAX_INHERIT_TEXT_CHARACTERS) {
    errors.push(error(line, 'text', `正文超过 ${MAX_INHERIT_TEXT_CHARACTERS} 个 Unicode 字符`,
      '在段落边界拆成多条，并用 part 从 1 编号'));
  }
  if (!SPEAKERS.has(value.speaker)) {
    errors.push(error(line, 'speaker', 'speaker 取值无效', '改成 user、assistant 或 summary'));
  }
  if (!KINDS.has(value.kind)) {
    errors.push(error(line, 'kind', 'kind 取值无效', '改成 message、note 或 diary'));
  }
  if (!value.source || typeof value.source !== 'object' || Array.isArray(value.source)) {
    errors.push(error(line, 'source', 'source 必须是对象', '写成 {"system":"来源系统","file":"来源文件"}'));
  } else {
    for (const key of Object.keys(value.source)) if (!SOURCE_FIELDS.has(key)) addUnknown(unknown, 'source.' + key);
    if (!nonEmptyString(value.source.system)) {
      errors.push(error(line, 'source.system', '来源系统缺失或为空', '补上非空字符串 system'));
    }
    if (!nonEmptyString(value.source.file)) {
      errors.push(error(line, 'source.file', '来源文件缺失或为空', '补上非空字符串 file'));
    }
    if (value.source.locator !== undefined && typeof value.source.locator !== 'string') {
      errors.push(error(line, 'source.locator', 'locator 必须是字符串', '改成字符串，或删除该字段'));
    }
  }
  if (value.time !== undefined && !isInheritTime(value.time)) {
    errors.push(error(line, 'time', '时间格式无效', '改成 YYYY-MM-DD 或带时区的完整 ISO 时间'));
  }
  if (value.id !== undefined && !nonEmptyString(value.id)) {
    errors.push(error(line, 'id', 'id 必须是非空字符串', '改成稳定编号，或删除 id'));
  }
  if (value.conversation !== undefined && !nonEmptyString(value.conversation)) {
    errors.push(error(line, 'conversation', 'conversation 必须是非空字符串', '改成对话编号，或删除该字段'));
  }
  if (value.order !== undefined && (!Number.isSafeInteger(value.order) || value.order < 0)) {
    errors.push(error(line, 'order', 'order 必须是非负整数', '改成对话中的非负整数顺序'));
  }
  if (value.part !== undefined && (!Number.isSafeInteger(value.part) || value.part < 1)) {
    errors.push(error(line, 'part', 'part 必须是大于等于 1 的整数', '从 1 开始给长文分片编号'));
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string'))) {
    errors.push(error(line, 'tags', 'tags 必须是字符串数组', '改成 ["标签一","标签二"]，或删除该字段'));
  }
  return {errors, unknown};
}

function appendUnknown(output, unknown) {
  for (const [field, count] of unknown) output.set(field, (output.get(field) ?? 0) + count);
}

async function statFile(file, maxBytes) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) throw Error('继承文件不能是符号链接');
  if (!stat.isFile()) throw Error('继承路径不是普通文件');
  if (stat.size > maxBytes) throw Error(`继承文件超过 ${Math.floor(maxBytes / 1024 / 1024)}MB，已拒绝读取`);
  return stat;
}

export async function readInheritJsonl(file, {
  maxBytes = MAX_INHERIT_FILE_BYTES,
  maxRecords = MAX_INHERIT_RECORDS,
} = {}) {
  const resolved = path.resolve(file);
  const stat = await statFile(resolved, maxBytes);
  const errors = [], records = [], unknown = new Map();
  let header = null, lineNumber = 0, sawAny = false;
  const input = createReadStream(resolved,{encoding:'utf8'});
  const lines = readline.createInterface({input,crlfDelay:Infinity});
  try {
    for await (let line of lines) {
      lineNumber += 1;
      if (lineNumber === 1 && line.charCodeAt(0) === 0xfeff) line = line.slice(1);
      if (!line.trim()) {
        errors.push(error(lineNumber, '$', '空行不是有效 JSON', '删除空行，每条记录一行'));
        continue;
      }
      let value;
      try { value = JSON.parse(line); }
      catch {
        errors.push(error(lineNumber, '$', 'JSON 解析失败', '修正这一行的引号、逗号或括号'));
        continue;
      }
      sawAny = true;
      if (lineNumber === 1) {
        header = value;
        validateHeader(value, errors, unknown);
        continue;
      }
      if (records.length >= maxRecords) {
        errors.push(error(lineNumber, '$', `记录数超过 ${maxRecords} 条上限`, '拆分文件后再导入'));
        break;
      }
      const checked = validateInheritRecord(value, lineNumber);
      errors.push(...checked.errors);
      appendUnknown(unknown, checked.unknown);
      records.push(value);
    }
    if (!sawAny) errors.push(error(1, '$', '文件为空', '第一行写文件头，之后每行写一条记录'));
  } finally {
    lines.close();
    input.destroy();
  }
  return {
    file: resolved,
    size: stat.size,
    header,
    records: records.map(record => {
      try { return canonicalInheritRecord(record); }
      catch { return record; }
    }),
    errors,
    unknownFields:[...unknown].map(([field,count])=>({field,count})).sort((a,b)=>a.field.localeCompare(b.field)),
  };
}

export function inheritReport(records, {
  source = '',
  errors = [],
  unknownFields = [],
  conversionSkipped = [],
  conversion = null,
  comparison = null,
  header = null,
} = {}) {
  const byKind = {}, bySpeaker = {};
  let charactersTotal = 0;
  const times = [];
  for (const record of records) {
    byKind[record.kind] = (byKind[record.kind] ?? 0) + 1;
    bySpeaker[record.speaker] = (bySpeaker[record.speaker] ?? 0) + 1;
    charactersTotal += characters(record.text);
    if (record.time !== undefined) times.push({value:record.time,ms:inheritTimeMs(record.time)});
  }
  times.sort((a,b)=>a.ms-b.ms||a.value.localeCompare(b.value));
  return {
    ok: errors.length === 0,
    source,
    header,
    summary: {
      total: records.length,
      byKind:Object.fromEntries(Object.entries(byKind).sort(([a],[b])=>a.localeCompare(b))),
      bySpeaker:Object.fromEntries(Object.entries(bySpeaker).sort(([a],[b])=>a.localeCompare(b))),
      timeRange: times.length ? {from:times[0].value,to:times.at(-1).value} : null,
      withoutTime: records.length - times.length,
    },
    estimatedEmbedding: {
      records: records.length,
      characters: charactersTotal,
      note: '向量编码会按所选模型和待编码处理实际计量；这里只预估导入正文。',
    },
    errors,
    unknownFields,
    conversionSkipped,
    conversion,
    comparison,
  };
}

export async function writeInheritJsonl(file, header, records) {
  const destination = path.resolve(file);
  await fs.mkdir(path.dirname(destination),{recursive:true});
  const temporary = destination + '.tmp-' + process.pid;
  const content = [JSON.stringify(header), ...records.map(record=>JSON.stringify(canonicalInheritRecord(record)))].join('\n') + '\n';
  try {
    await fs.writeFile(temporary,content,'utf8');
    await fs.rename(temporary,destination);
  } catch (cause) {
    await fs.rm(temporary,{force:true}).catch(()=>{});
    throw cause;
  }
  return destination;
}

/** Shared personal-record namespace helpers for the dafeiyu records. */
export const PERSONAL_ROOT = 'dafeiyu';
export const LEGACY_PROJECT = 'personal';
/** Only the portable main backend can still expose notes migrated from personal. */
export function migrationProject(project) {
  return String(project ?? '').trim().toLowerCase() === 'main' ? LEGACY_PROJECT : '';
}
export const PERSONAL_KINDS = Object.freeze(['thoughts', 'diary', 'gallery', 'people']);
export const PERSONAL_TAGS = Object.freeze(['dafeiyu', 'subjective']);
export const DIARY_DAILY_LIMIT = 3;

export function hostTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

// Default zone when none is configured. Existing memories were written in Beijing time, so the
// default stays there; a user elsewhere can set their own IANA zone in the settings page.
export const DEFAULT_PERSONAL_TIME_ZONE = 'Asia/Shanghai';

export function resolvePersonalTimeZone(value) {
  const host = hostTimeZone(), fallback = DEFAULT_PERSONAL_TIME_ZONE;
  const configured = typeof value === 'string' ? value.trim() : '';
  if (!configured) return { timeZone: fallback, configuredTimeZone: '', hostTimeZone: host, error: '' };
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured });
    return { timeZone: configured, configuredTimeZone: configured, hostTimeZone: host, error: '' };
  } catch {
    return {
      timeZone: fallback,
      configuredTimeZone: configured,
      hostTimeZone: host,
      error: '无效时区 ' + configured + '；已使用默认时区 ' + fallback,
    };
  }
}

let currentTimeZone = DEFAULT_PERSONAL_TIME_ZONE;
export let PERSONAL_TIME_ZONE = currentTimeZone;

export function personalTimeZone() {
  return currentTimeZone;
}

/** Set the one personal-library time zone for this process. */
export function setPersonalTimeZone(name) {
  currentTimeZone = resolvePersonalTimeZone(name).timeZone;
  PERSONAL_TIME_ZONE = currentTimeZone;
  return currentTimeZone;
}

/** True when a Basic Memory permalink points into the personal namespace. */
export function isPersonalPermalink(permalink) {
  return /(^|\/)dafeiyu(\/|$)/i.test(String(permalink ?? ''));
}

/** Directory for one personal record kind. */
export function personalDirectory(kind) {
  return `${PERSONAL_ROOT}/${kind}`;
}

function normalizePath(value) {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Basic Memory returns canonical permalinks prefixed with the project
 * (for example `personal/dafeiyu/thoughts/...`), while the Vault-relative
 * directory stays `dafeiyu/thoughts`. Strip the configured project prefix,
 * or the bounded main-to-personal migration alias, then normalize the record.
 * Returns '' for traversal, query fragments, cross-project, cross-kind or
 * factual paths.
 */
export function personalRecordPath(kind, permalink, project = '') {
  const raw = String(permalink ?? '').trim();
  if (!raw || /\.\.|[?#]/.test(raw) || raw.includes('\0')) return '';
  const normalized = normalizePath(raw);
  const scope = normalizePath(project);
  let relative = normalized;
  for (const candidate of [scope, migrationProject(scope)]) {
    if (candidate && normalized.toLowerCase().startsWith(candidate.toLowerCase() + '/')) {
      relative = normalized.slice(candidate.length + 1);
      break;
    }
  }
  const prefix = `${PERSONAL_ROOT}/${kind}/`;
  if (relative.length <= prefix.length) return '';
  if (!relative.toLowerCase().startsWith(prefix.toLowerCase())) return '';
  if (relative.slice(prefix.length).split('/').some((part) => part === '' || part === '.')) return '';
  return relative;
}

/** Canonical identifier accepted by Basic Memory read_note/delete_note. */
export function memoryIdentifier(value, project = '') {
  const normalized = normalizePath(value);
  const scope = normalizePath(project);
  if (!normalized) return '';
  if (!scope) return normalized;
  if (normalized.toLowerCase().startsWith(scope.toLowerCase() + '/')) return normalized;
  const legacy = migrationProject(scope);
  if (legacy && normalized.toLowerCase().startsWith(legacy + '/')) return normalized;
  return `${scope}/${normalized}`;
}

/** Parent directory of a normalized personal record permalink. */
export function personalParentDirectory(kind, permalink, project = '') {
  const normalized = personalRecordPath(kind, permalink, project);
  if (!normalized) return '';
  return normalized.slice(0, normalized.lastIndexOf('/'));
}

/** Wall clock in the personal time zone, formatted for note headings. */
export function shanghaiClock(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: personalTimeZone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return {
    date: `${pick('year')}-${pick('month')}-${pick('day')}`,
    time: `${pick('hour')}:${pick('minute')}`,
    stamp: `${pick('hour')}${pick('minute')}${pick('second')}`,
    iso: date.toISOString(),
  };
}

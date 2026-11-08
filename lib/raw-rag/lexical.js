// Explicit Chinese terms avoid treating an entire unspaced sentence as one
// unicode61 token. Numbers/identifiers remain whole, never substring matches.
const STOP = new Set(('什么 哪里 在哪 怎么 如何 多少 是谁 是否 时候 之前 以前 现在 今天 那天 我的 你的 我们 你们 这个 那个 这些 那些 有没有 记不 记得 记住 帮我 告诉 请问 一下 的是 是什 是多 放哪 ' +
  'the a an and or where what when who how is are was were do does did my me please').split(/\s+/));

// Modifiers and negation remain searchable and participate in ranking, but
// cannot alone qualify a hit when the query also names a concrete subject.
const MODIFIERS = new Set('完全 根本 一直 已经 只是 不是 没有 从未 不再 不要 不能 可以 应该 可能 说过 提过 not never'.split(' '));
const queryWords = new Intl.Segmenter('zh', { granularity: 'word' });

function subjectTerms({ content, literal, terms }) {
  if (literal) return terms;
  const available = new Set(terms), anchors = new Set();
  for (const { segment, isWordLike } of queryWords.segment(content)) {
    if (!isWordLike || STOP.has(segment) || MODIFIERS.has(segment)) continue;
    for (const term of termsFor(segment, { query: true })) {
      if (!term.startsWith('c:') && available.has(term)) anchors.add(term);
    }
  }
  // Preserve short names, exact identifiers and deliberate modifier-only
  // searches when segmentation cannot supply a separate subject anchor.
  return anchors.size ? [...anchors] : terms;
}

// Strip only anchored recall/request framing, never negation in the subject.
// Source indexing stays unchanged; queries and excerpt ranking share this path.
const RECALL_QUESTION = /^(?:(?:我|你|您|我们|咱们)?(?:以前|之前|曾经|刚才)?(?:有没有|是否)(?:以前|之前|曾经)?(?:跟你|对你|向你)?(?:说过|提过|讲过|聊过|提到过|记录过|告诉过你)|(?:你|您)?(?:还)?(?:记不记得|记得)(?:我(?:以前|之前|曾经)?(?:说过|提过|讲过|提到过)的?)?)[\s，,:：]*/u;
const POLITE_REQUEST = /^(?:(?:请|麻烦)(?:你|您)?(?:帮我)?(?:查一下|找一下|回忆一下|回想一下|告诉我)|(?:帮我)(?:查一下|找一下|回忆一下|回想一下)|请问)[\s，,:：]*/u;
const ENGLISH_QUESTION = /^(?:(?:have|had)\s+i\s+(?:ever\s+)?(?:said|mentioned|told\s+you)(?:\s+about)?|(?:do\s+you\s+)?remember(?:\s+(?:when|that)\s+i\s+(?:said|mentioned))?)(?:\s+|[:;,]\s*)/iu;

function queryContent(value) {
  let content = String(value ?? '').normalize('NFKC').toLowerCase().trim();
  const quotes = new Map([['"', '"'], ["'", "'"], ['“', '”'], ['「', '」'], ['『', '』']]);
  // A deliberately quoted phrase can include framing words, e.g. “没有”.
  if (content.length > 1 && quotes.get(content[0]) === content.at(-1)) {
    return { content: content.slice(1, -1), literal: true };
  }
  let framed = false;
  for (let depth = 0; depth < 4; depth += 1) {
    const next = content.replace(POLITE_REQUEST, '').replace(RECALL_QUESTION, '').replace(ENGLISH_QUESTION, '').trim();
    if (next === content) break;
    framed = true;
    content = next;
  }
  if (/[吗呢?？]\s*$/u.test(content)) {
    const next = content.replace(/^(?:我|我们|咱们)(?:以前|之前|曾经)?(?:跟你|对你|向你)?(?:说过|提过|讲过|聊过|提到过)[\s，,:：]*/u, '');
    if (next !== content) { framed = true; content = next; }
  }
  if (framed) content = content.replace(/^关于\s*/u, '').replace(/[吗呢?？]+\s*$/u, '').trim();
  return { content, literal: false };
}

function termsFor(value, { query = false, literal = false } = {}) {
  const text = String(value ?? '').normalize('NFKC').toLowerCase();
  const terms = [];
  for (const match of text.matchAll(/[\p{Script=Han}]+|[a-z0-9]+(?:[._:/-][a-z0-9]+)*/gu)) {
    const word = match[0];
    if (/\p{Script=Han}/u.test(word)) {
      const chars = Array.from(word);
      if (!query || chars.length === 1) for (const char of chars) terms.push('c:' + char);
      for (let i = 0; i < chars.length - 1; i += 1) {
        const pair = chars[i] + chars[i + 1];
        if (!query || literal || !STOP.has(pair)) terms.push('h:' + pair);
      }
    } else if (!query || literal || !STOP.has(word)) terms.push('a:' + word);
  }
  return terms;
}

export function queryProfile(value) {
  const { content, literal } = queryContent(value);
  return { content, literal, terms: [...new Set(termsFor(content, { query: true, literal }))] };
}

export function lexicalTerms(value, { query = false } = {}) {
  return query ? queryProfile(value).terms : termsFor(value);
}

// Encoding gives FTS only literal alphanumeric tokens, including for source
// identifiers with punctuation. User input can never become MATCH operators.
const token = term => 'x' + Buffer.from(term, 'utf8').toString('hex');

export function indexText(text) {
  return lexicalTerms(text).map(token).join(' ');
}

export function textQuery(text) {
  const profile = queryProfile(text), { terms } = profile;
  if (!terms.length) return null;
  const anchors = subjectTerms(profile);
  const exact = terms.filter(term => term.startsWith('a:') && /\d/.test(term));
  const any = '(' + terms.map(token).join(' OR ') + ')';
  const subject = anchors.length === terms.length ? '' : ' AND (' + anchors.map(token).join(' OR ') + ')';
  return { terms, match: any + subject + (exact.length ? ' AND ' + exact.map(token).join(' AND ') : '') };
}

export function lexicalOverlap(query, text) {
  const terms = new Set(queryProfile(query).terms);
  if (!terms.size) return 0;
  const target = new Set(lexicalTerms(text));
  let hits = 0;
  for (const term of terms) if (target.has(term)) hits += 1;
  return hits / terms.size;
}

/** Same deterministic subject/exact-identifier requirements as the FTS query,
 * used when a committed original is awaiting its text projection. */
export function lexicalMatch(query,text){
  const profile=queryProfile(query);if(!profile.terms.length)return 0;
  const target=new Set(lexicalTerms(text)),anchors=subjectTerms(profile);
  if(!anchors.some(term=>target.has(term)))return 0;
  if(profile.terms.some(term=>term.startsWith('a:')&&/\d/.test(term)&&!target.has(term)))return 0;
  return profile.terms.filter(term=>target.has(term)).length/profile.terms.length;
}

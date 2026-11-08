import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRawEmbeddingContext, planRawEmbeddingChunk } from '../lib/raw-rag/embedding-material.js';
import { sourceTextHash } from '../lib/source-lineage.js';

const source = { id: 'center', revision: 1, role: 'user', text: '就按刚才的限制执行' };
const message = (id, text, role = 'user') => ({ id, revision: 1, ref: { storage: 'message', id, revision: 1 }, text, role });

test('raw context formats full messages and fingerprints the ordered sources and center role', () => {
  const context = [message('a', '只允许本地执行。\n不要上传附件。'), message('b', '明白。', 'assistant')];
  const version = 'raw-context-v1';
  const result = buildRawEmbeddingContext(source, context);
  assert.deepEqual(result, {
    background: ['背景｜用户：只允许本地执行。\n不要上传附件。', '背景｜助手：明白。'],
    heading: '正文｜用户：',
    prefix: '背景｜用户：只允许本地执行。\n不要上传附件。\n背景｜助手：明白。\n正文｜用户：',
    proof: {
      version,
      fingerprint: sourceTextHash(JSON.stringify({ version, role: source.role, context })),
      sources: context.map(({ id, revision, ref }) => ({ id, revision, ref })),
    },
  });
  const otherRole = buildRawEmbeddingContext({ ...source, role: 'assistant' }, context);
  assert.equal(otherRole.heading, '正文｜助手：');
  assert.notEqual(otherRole.proof.fingerprint, result.proof.fingerprint);
  assert.deepEqual(buildRawEmbeddingContext({ ...source, revision: 2, text: '正文改版' }, context), result);
});

test('raw context keeps a contiguous suffix of up to four full messages within 2000 characters', () => {
  const older = Array.from({ length: 4 }, (_, i) => message(`old-${i}`, '短消息'));
  const exact = message('exact', '长'.repeat(2000 - '背景｜用户：\n'.length));
  const tooLong = message('over', exact.text + '。');
  assert.equal(buildRawEmbeddingContext(source, []), null);
  assert.deepEqual(buildRawEmbeddingContext(source, [...older, tooLong]), null);
  const atLimit = buildRawEmbeddingContext(source, [...older, exact]);
  assert.equal(atLimit.prefix.length - atLimit.heading.length, 2000);
  assert.deepEqual(atLimit.proof.sources.map(row => row.id), ['exact']);
  const newest = message('newest', '不要外传');
  assert.deepEqual(buildRawEmbeddingContext(source, [...older, tooLong, newest]).proof.sources.map(row => row.id), ['newest']);
  assert.deepEqual(buildRawEmbeddingContext(source, [...older, newest]).proof.sources.map(row => row.id),
    ['old-1', 'old-2', 'old-3', 'newest']);
});

test('raw context chunk requires a single exact span inside the model budget', async () => {
  const embedding = buildRawEmbeddingContext(source, [message('a', '不要外传')]);
  const chunk = { start: 20, end: 23, text: '正文 ', tokenBound: 3 };
  for (const makePlan of [
    text => [{ start: 0, end: text.length - 1, text: text.trimEnd(), tokenBound: 19 }],
    text => [{ start: 0, end: text.length, text, tokenBound: 21 }],
  ]) {
    assert.deepEqual(await planRawEmbeddingChunk(chunk, embedding, async text => makePlan(text), 20),
      { ...chunk, textHash: sourceTextHash(chunk.text) });
  }
});

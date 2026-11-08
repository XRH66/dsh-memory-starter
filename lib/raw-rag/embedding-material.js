import { sourceTextHash } from '../source-lineage.js';

// Adapted from vendor/suzu-memory/packages/embedding-indexer/src/index.mjs
// at 645c862470b1a207c9904e614083f8b77a8f15bf (Apache-2.0, Copyright 2026 儿玉诚也).
// This adaptation uses complete preceding messages and records source proofs.
const VERSION = 'raw-context-v1';
const MAX_BACKGROUND_MESSAGES = 4;
const MAX_BACKGROUND_CHARS = 2000;
const speaker = role => role === 'assistant' ? '助手' : '用户';

export function buildRawEmbeddingContext(source, contexts) {
  const selected = [], background = [];
  let length = 0;
  for (const context of contexts.slice(-MAX_BACKGROUND_MESSAGES).reverse()) {
    const { id, revision, ref, text, role } = context;
    const line = `背景｜${speaker(role)}：${text}`;
    length += line.length + 1;
    if (length > MAX_BACKGROUND_CHARS) break;
    selected.unshift({ id, revision, ref, text, role });
    background.unshift(line);
  }
  if (!background.length) return null;
  const heading = `正文｜${speaker(source.role)}：`;
  return { prefix: background.join('\n') + '\n' + heading, background, heading, proof: {
    version: VERSION,
    fingerprint: sourceTextHash(JSON.stringify({ version: VERSION, role: source.role, context: selected })),
    sources: selected.map(({ id, revision, ref }) => ({ id, revision, ref })),
  } };
}

export async function planRawEmbeddingChunk(chunk, embedding, planChunks, maxTokens) {
  const { prefix, background = [], heading } = embedding;
  const attempts = Math.max(1, Math.min(background.length, MAX_BACKGROUND_MESSAGES));
  for (let omitted = 0; omitted < attempts; omitted++) {
    const text = (omitted ? background.slice(omitted).join('\n') + '\n' + heading : prefix) + chunk.text;
    const plan = await planChunks(text, Math.max(600, text.length));
    if (!Array.isArray(plan) || plan.length !== 1) continue;
    const [part] = plan;
    if (part?.start === 0 && part.end === text.length && part.text === text &&
        Number.isSafeInteger(part.tokenBound) && part.tokenBound >= 0 && part.tokenBound <= maxTokens) {
      return { ...chunk, text, tokenBound: part.tokenBound, textHash: sourceTextHash(text) };
    }
  }
  return { ...chunk, textHash: sourceTextHash(chunk.text) };
}

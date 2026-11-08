import assert from 'node:assert/strict';
import { planEmbeddingChunks } from '../lib/raw-rag/chunks.js';

// Deterministic tokenizer/model contract; never opens a transport or model.
export function embeddingContract(modelKey, dimensions, maxTokens = 600) {
  const identity = { modelKey, dimensions, descriptor: {
    schema: 2, model: modelKey, engine: 'test-fixture', dimensions, maxTokens,
    tokenCounting: 'fixture-utf16-code-units', windowing: 'token-bounded-chunks-v2:600',
  } };
  return {
    modelKey,
    async prepare() { return identity; },
    planChunks(text, { signal, authorize } = {}) {
      return planEmbeddingChunks(text, { maxTokens, signal, authorize,
        countTokens: async texts => texts.map(value => value.length) });
    },
  };
}

// Prebuilt vectors must refer to the same registered model/chunks/source
// revision as the production indexer, rather than the legacy windows table.
export async function seedTurnVectors(store, embedder, turn, vectorFor) {
  const identity = await embedder.prepare();
  store.registerModel(identity);
  const source = store.sourcesNeedingChunks(identity.modelKey, { scope: turn.scope, limit: 40 })
    .find(value => value.turnId === turn.turnId);
  assert.ok(source, 'fixture source must need model-specific chunks');
  const chunks = await embedder.planChunks(source.docText);
  assert.equal(store.putChunks(identity.modelKey, source, chunks), true);
  const inserted = store.putVectors(identity.modelKey, chunks.map(chunk => ({
    turnId: turn.turnId, windowId: chunk.id, textHash: chunk.textHash,
    sourceVersion: source.sourceVersion, vector: vectorFor(chunk.text),
  })));
  assert.equal(inserted, chunks.length);
  return chunks;
}

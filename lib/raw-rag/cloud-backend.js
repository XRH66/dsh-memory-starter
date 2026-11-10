import fs from 'node:fs/promises';
import { embeddingCredentialEndpoint } from './models.js';
import { requestEmbeddingService } from './embedding-http.js';

export class CloudEmbeddingTransport {
  constructor({ spec, config, onUsage }) { Object.assign(this, { spec, config, onUsage }); this.disposed = false; }

  async prepare() {
    if (this.disposed) throw new Error('Embedding API is disposed');
    if (!this.config.rawRecallAllowCloud) throw new Error('Cloud embedding has not been selected and authorized');
    this.endpoint = embeddingCredentialEndpoint(this.config);
    this.key = this.config.rawRecallApiKeyFile
      ? (await fs.readFile(this.config.rawRecallApiKeyFile, 'utf8')).trim()
      : String(process.env[this.config.rawRecallApiKeyEnv ?? 'DASHSCOPE_API_KEY'] || '').trim();
    if (!this.key) throw new Error('Embedding API key is not configured');
    return { protocol: 'openai-compatible-embeddings-v1', revision: this.config.rawRecallApiRevision || 'provider-managed' };
  }

  async embed(texts, { kind, signal, scope }) {
    if (this.disposed || !this.key) throw new Error('Embedding API is not prepared');
    if (this.blocked) throw new Error('Cloud embedding paused after an unsuccessful request; reload to retry');
    signal?.throwIfAborted();
    try {
      return await requestEmbeddingService({ baseUrl: this.endpoint, model: this.spec.apiModel || this.spec.id, texts,
        // A custom service reports its native size; only the known presets accept a requested one.
        dimensions: this.spec.dimensions, sendDimensions: !this.spec.custom, apiKey: this.key,
        kind, scope, signal, onUsage: this.onUsage });
    } catch (error) {
      // A lost response may already have been billed. Pause this adapter rather
      // than resubmitting that pending window on every subsequent chat.
      this.blocked = true;
      throw error;
    }
  }
  dispose() { this.disposed = true; this.key = null; }
}

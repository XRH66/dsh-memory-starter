import fs from 'node:fs/promises';
import { embeddingCredentialEndpoint } from './models.js';
import { requestEmbeddingService } from './embedding-http.js';

const CLOUD_PAUSE_MS = 5 * 60_000;

export class CloudEmbeddingTransport {
  constructor({ spec, config, onUsage, now = Date.now, fetchImpl = fetch }) {
    Object.assign(this, { spec, config, onUsage, now, fetchImpl });
    this.disposed = false;
    this.blockedUntil = null;
  }

  get blocked() { return this.blockedUntil != null && this.now() < this.blockedUntil; }

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
    if (this.blocked) {
      throw new Error('Cloud embedding paused after an uncertain request; retrying after ' +
        new Date(this.blockedUntil).toISOString());
    }
    this.blockedUntil = null;
    signal?.throwIfAborted();
    try {
      return await requestEmbeddingService({ baseUrl: this.endpoint, model: this.spec.apiModel || this.spec.id, texts,
        // A custom service reports its native size; only the known presets accept a requested one.
        dimensions: this.spec.dimensions, sendDimensions: this.spec.sendDimensions, apiKey: this.key,
        kind, scope, signal, onUsage: this.onUsage, fetchImpl: this.fetchImpl });
    } catch (error) {
      // Cancellation and explicit HTTP errors are known outcomes, so they can be
      // retried immediately. Lost or malformed responses are uncertain and may
      // already have been billed, so pause briefly instead of resubmitting them.
      if (!signal?.aborted && error.code !== 'EMBEDDING_HTTP_ERROR') {
        this.blockedUntil = this.now() + CLOUD_PAUSE_MS;
      }
      throw error;
    }
  }
  dispose() { this.disposed = true; this.key = null; }
}

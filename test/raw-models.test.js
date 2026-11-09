import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveConfig} from '../lib/config.js';
import {BGE_QUERY_INSTRUCTION,QWEN_QUERY_INSTRUCTION,formatEmbeddingInput,minSimilarityFor,modelContract,queryWaitFor,rawModelOptions,rawModelSpec} from '../lib/raw-rag/models.js';

test('each raw embedding model has its own default similarity floor', () => {
  const expected = new Map([
    ['BAAI/bge-small-zh-v1.5', 0.45],
    ['Qwen/Qwen3-Embedding-0.6B', 0.30],
    ['Qwen/Qwen3-Embedding-4B', 0.20],
    ['Qwen/Qwen3-Embedding-8B', 0.20],
    ['qwen3.7-text-embedding', 0.30],
    ['qwen3.7-text-embedding-flash', 0.30],
    ['text-embedding-v4', 0.30],
  ]);
  assert.equal(rawModelOptions.length, expected.size);
  for (const model of rawModelOptions) {
    const config = resolveConfig({rawRecallModel:model.id});
    assert.equal(config.rawRecallMinScore, null);
    assert.equal(minSimilarityFor(config), expected.get(model.id), model.id);
  }
});

test('an explicit raw recall similarity floor overrides the model default', () => {
  const config = resolveConfig({rawRecallModel:'BAAI/bge-small-zh-v1.5', rawRecallMinScore:0.2});
  assert.equal(minSimilarityFor(config), 0.2);
});

test('BGE queries use the retrieval instruction while documents remain unchanged', () => {
  const config=resolveConfig({rawRecallModel:'BAAI/bge-small-zh-v1.5'}),spec=rawModelSpec(config);
  assert.equal(formatEmbeddingInput(spec,'示例查询','query'),BGE_QUERY_INSTRUCTION+'示例查询');
  assert.equal(formatEmbeddingInput(spec,'示例文档','document'),'示例文档');
  assert.equal(modelContract(spec,config).query,BGE_QUERY_INSTRUCTION);
});

test('Qwen and cloud query formats remain unchanged', () => {
  const qwen=resolveConfig({rawRecallModel:'Qwen/Qwen3-Embedding-0.6B'});
  assert.equal(formatEmbeddingInput(rawModelSpec(qwen),'query','query'),`Instruct: ${QWEN_QUERY_INSTRUCTION}\nQuery: query`);
  assert.equal(formatEmbeddingInput(rawModelSpec(qwen),'document','document'),'document');
  const cloud=resolveConfig({rawRecallModel:'text-embedding-v4'});
  assert.equal(formatEmbeddingInput(rawModelSpec(cloud),'query','query'),'query');
  assert.equal(modelContract(rawModelSpec(cloud),cloud).query,'plain-text');
});

test('query wait follows model, device and explicit override', () => {
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'BAAI/bge-small-zh-v1.5'})),2500);
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'Qwen/Qwen3-Embedding-0.6B'})),2500);
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'Qwen/Qwen3-Embedding-4B'})),2000);
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallDevice:'cpu'})),4000);
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'Qwen/Qwen3-Embedding-8B'})),4000);
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'Qwen/Qwen3-Embedding-8B'}), 'cuda'),2000);
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'text-embedding-v4'})),4000);
  assert.equal(queryWaitFor(resolveConfig({rawRecallModel:'Qwen/Qwen3-Embedding-4B',rawRecallQueryWaitMs:3500})),3500);
});

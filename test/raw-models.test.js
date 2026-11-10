import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveConfig} from '../lib/config.js';
import {normalizeRawModelSettings} from '../lib/raw-rag/settings.js';
import {CloudEmbeddingTransport} from '../lib/raw-rag/cloud-backend.js';
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
    ['custom-api', 0.30],
  ]);
  assert.equal(rawModelOptions.length, expected.size);
  for (const model of rawModelOptions) {
    const config = resolveConfig({rawRecallModel:model.id,...(model.custom?{rawRecallApiModel:'fictional-embed'}:{})});
    assert.equal(config.rawRecallMinScore, null);
    assert.equal(minSimilarityFor(config), expected.get(model.id), model.id);
  }
});

test('a custom API model takes its served model name and size from the configuration', () => {
  const base={rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-a.example/v1',rawRecallApiModel:' fictional/embed-large ',rawRecallDimensions:768};
  const config=resolveConfig(base),spec=rawModelSpec(config),contract=modelContract(spec,config);
  assert.deepEqual([spec.id,spec.engine,spec.apiModel,spec.dimensions],['custom-api','api','fictional/embed-large',768]);
  assert.equal(contract.apiModel,'fictional/embed-large');assert.equal(contract.endpoint,'https://fictional-a.example/v1/embeddings');
  // Another served model or size is a different index identity under the same registry id.
  const other=resolveConfig({...base,rawRecallApiModel:'fictional/embed-small'});
  assert.notDeepEqual(modelContract(rawModelSpec(other),other),contract);
  assert.equal(rawModelSpec(resolveConfig({...base,rawRecallDimensions:0})).dimensions,1024);
  assert.throws(()=>rawModelSpec(resolveConfig({...base,rawRecallApiModel:''})),/模型名称/);
  assert.throws(()=>rawModelSpec({...base,rawRecallDimensions:5000}),/向量维数/);
  assert.deepEqual(rawModelOptions.filter(model=>model.cloud&&!model.hidden).map(model=>model.id),['custom-api']);
});

test('saving a custom API model requires an explicit address and binds the key to it', () => {
  const input={rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-a.example/v1',rawRecallApiModel:'fictional-embed',rawRecallDimensions:768,rawRecallAllowCloud:true};
  const fields=normalizeRawModelSettings(input,{}, {apiKeyProvided:true});
  assert.deepEqual([fields.rawRecallModel,fields.rawRecallApiModel,fields.rawRecallDimensions,fields.rawRecallApiKeyService,fields.rawRecallApiKeyEnv],
    ['custom-api','fictional-embed',768,'https://fictional-a.example/v1/embeddings','']);
  assert.throws(()=>normalizeRawModelSettings({...input,rawRecallApiBase:''},{}, {apiKeyProvided:true}),/请填写 API 地址/);
  assert.throws(()=>normalizeRawModelSettings({...input,rawRecallApiBase:'http://fictional-a.example/v1'},{}, {apiKeyProvided:true}),/HTTPS/);
  assert.throws(()=>normalizeRawModelSettings({...input,rawRecallApiModel:''},{}, {apiKeyProvided:true}),/模型名称/);
});

test('a custom API request names the served model and does not ask for a size', async () => {
  const config=resolveConfig({rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-a.example/v1',rawRecallApiModel:'fictional-embed',rawRecallDimensions:3,rawRecallAllowCloud:true,rawRecallApiKeyEnv:'FICTIONAL_CUSTOM_EMBED_KEY'});
  const original=globalThis.fetch,previous=process.env.FICTIONAL_CUSTOM_EMBED_KEY;let sent;
  process.env.FICTIONAL_CUSTOM_EMBED_KEY='fictional-key';
  globalThis.fetch=async(url,init)=>{sent={url:String(url),body:JSON.parse(init.body)};
    return new Response(JSON.stringify({data:[{index:0,embedding:[0.1,0.2,0.3]}]}),{status:200,headers:{'content-type':'application/json'}});};
  try{
    const transport=new CloudEmbeddingTransport({spec:rawModelSpec(config),config});await transport.prepare();
    assert.deepEqual(await transport.embed(['虚构文本'],{kind:'document'}),[[0.1,0.2,0.3]]);
  }finally{globalThis.fetch=original;if(previous===undefined)delete process.env.FICTIONAL_CUSTOM_EMBED_KEY;else process.env.FICTIONAL_CUSTOM_EMBED_KEY=previous;}
  assert.equal(sent.url,'https://fictional-a.example/v1/embeddings');assert.equal(sent.body.model,'fictional-embed');assert.equal('dimensions' in sent.body,false);
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

test('custom Qwen3-Embedding uses the query instruction while its documents remain unchanged', () => {
  const config=resolveConfig({rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-qwen.example/v1',
    rawRecallApiModel:'Qwen/Qwen3-Embedding-8B',rawRecallDimensions:4096});
  const spec=rawModelSpec(config);
  assert.equal(spec.family,'qwen3-embedding');
  assert.equal(formatEmbeddingInput(spec,'示例查询','query'),`Instruct: ${QWEN_QUERY_INSTRUCTION}\nQuery: 示例查询`);
  assert.equal(formatEmbeddingInput(spec,'示例文档','document'),'示例文档');
  assert.equal(modelContract(spec,config).query,`Instruct: ${QWEN_QUERY_INSTRUCTION}\nQuery: `);
});

test('custom BGE-M3 remains provider-embedding without a query prefix or contract change', () => {
  const config=resolveConfig({rawRecallModel:'custom-api',rawRecallApiBase:'https://fictional-bge.example/v1',
    rawRecallApiModel:'BAAI/bge-m3',rawRecallDimensions:1024});
  const spec=rawModelSpec(config);
  assert.equal(spec.family,'provider-embedding');
  assert.equal(formatEmbeddingInput(spec,'示例查询','query'),'示例查询');
  assert.equal(formatEmbeddingInput(spec,'示例文档','document'),'示例文档');
  assert.deepEqual(modelContract(spec,config),{
    schema:2,model:'custom-api',engine:'api',dimensions:1024,format:'service',query:'plain-text',task:'embedding',
    family:'provider-embedding',document:'plain-text',pooling:'provider',normalization:'l2',maxTokens:2048,
    windowing:'token-bounded-chunks-v2:600',tokenCounting:'utf8-byte-upper-bound-plus-16',
    endpoint:'https://fictional-bge.example/v1/embeddings',apiModel:'BAAI/bge-m3',
  });
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

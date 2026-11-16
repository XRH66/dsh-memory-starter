import test from 'node:test';
import assert from 'node:assert/strict';
import {Config, DEFAULT_CONFIG, resolveConfig} from '../lib/config.js';
import {selectHandoff} from '../lib/handoff.js';
import {createMemoryQueryTools} from '../lib/memory-query.js';
import {createRecordsTool} from '../lib/records.js';
import {createSoftenTool} from '../lib/soften-tool.js';

const HOUR=3600000;

function captureLogger(){
  const warnings=[];
  return {warnings,warn:message=>warnings.push(String(message))};
}

function assertNeutralQueryFailure(result){
  assert.equal(result.status,'error');
  assert.deepEqual(result.records,[]);
  assert.equal(result.error.code,'BACKEND');
  assert.match(result.error.message,/这次没能读写记忆/u);
  assert.doesNotMatch(result.error.message,/[A-Za-z]/u);
  assert.deepEqual(Object.keys(result.budget).sort(),
    ['calls','counting','perOpenTokens','perSearchTokens','remainingCalls','remainingMs','remainingTokens','tokens']);
}

test('memory_search hides query creation failures and logs the cause',async()=>{
  const logger=captureLogger();
  const tools=createMemoryQueryTools({answer:()=>{throw Error('private setup failed in fixture-vault');},logger});
  const search=tools.find(tool=>tool.name==='memory_search');
  const result=await search.execute({query:'虚构线索'},{agent:{},signal:new AbortController().signal});
  assertNeutralQueryFailure(result);
  assert.ok(logger.warnings.some(line=>line.includes('private setup failed')));
});

test('memory_open hides unclassified backend failures and logs the cause',async()=>{
  const logger=captureLogger();
  const tools=createMemoryQueryTools({logger,answer:()=>({
    async expand(){throw Error('SQLITE_BUSY: database is locked');},
  })});
  const open=tools.find(tool=>tool.name==='memory_open');
  const result=await open.execute({ref:'m1'},{agent:{},signal:new AbortController().signal});
  assertNeutralQueryFailure(result);
  assert.ok(logger.warnings.some(line=>line.includes('SQLITE_BUSY')));
});

test('dafeiyu_records hides storage failures while preserving the structured code',async()=>{
  const logger=captureLogger();
  const tool=createRecordsTool({
    config:{project:'personal',vaultPath:'fictional-vault'},
    vaultBackend:{list:async()=>{throw Object.assign(Error('VAULT_STORAGE_DOWN: disk is full'),{code:'VAULT_STORAGE_DOWN'});}},
    logger,
  });
  const result=await tool.execute({action:'list',kind:'thoughts'},{agent:{session:{id:'session-test'}}});
  assert.equal(result.ok,false);
  assert.match(result.summary,/这次没能读写记忆/u);
  assert.doesNotMatch(result.summary,/[A-Za-z]/u);
  assert.equal(result.errorMessage,result.summary);
  assert.equal(typeof result.errorCode,'string');
  assert.ok(result.errorCode);
  assert.ok(logger.warnings.some(line=>line.includes('disk is full')));
});

test('dafeiyu_records gives a short Chinese hint for an invalid action',async()=>{
  const tool=createRecordsTool({
    config:{project:'personal',vaultPath:'fictional-vault'},
    vaultBackend:{},
    logger:captureLogger(),
  });
  const result=await tool.execute({action:'not-an-action',kind:'thoughts'},{});
  assert.equal(result.ok,false);
  assert.equal(result.errorCode,'INVALID_ACTION');
  assert.match(result.summary,/动作无效/u);
  assert.doesNotMatch(result.summary,/action must be/u);
  assert.equal(result.errorMessage,result.summary);
});

test('soften_memory converts a thrown backend failure into a neutral result',async()=>{
  const logger=captureLogger();
  const tool=createSoftenTool({logger,softenRawMessage:async()=>{throw Error('RAW_DATABASE_LOCKED');}});
  const result=await tool.execute({rawMessageId:'raw-fictional'},{agent:{session:{id:'session-test'}}});
  assert.equal(result.ok,false);
  assert.match(result.summary,/这次没能读写记忆/u);
  assert.doesNotMatch(result.summary,/[A-Za-z]/u);
  assert.equal(result.errorMessage,result.summary);
  assert.ok(logger.warnings.some(line=>line.includes('RAW_DATABASE_LOCKED')));
});

test('selectHandoff keeps only originals inside the age limit and stops after a page with nothing inside it',()=>{
  const now=Date.UTC(2026,10,15,12);
  const sources=[
    {id:'fresh',revision:1,position:4,sequence:4,sessionId:'source',turn:2,role:'user',
      text:'边界内的虚构原话。',recordedAt:now-72*HOUR,turnState:'completed'},
    {id:'missing-time',revision:1,position:3,sequence:3,sessionId:'source',turn:2,role:'assistant',
      text:'没有时间的虚构原话。',turnState:'completed'},
    {id:'expired',revision:1,position:2,sequence:2,sessionId:'source',turn:1,role:'user',
      text:'过期的虚构原话。',time:now-72*HOUR-1,turnState:'completed'},
    {id:'older',revision:1,position:1,sequence:1,sessionId:'source',turn:1,role:'assistant',
      text:'更早的虚构原话。',time:now-96*HOUR,turnState:'completed'},
  ];
  let pages=0;
  const reader={list({beforePosition=Infinity,limit}){
    pages++;
    const page=sources.filter(source=>source.position<beforePosition).slice(0,limit);
    return {sources:page,nextBefore:page.length?0:null};
  }};
  const selected=selectHandoff(reader,{tokens:4096,maxAgeMs:72*HOUR,now:()=>now});
  assert.equal(pages,1);
  assert.deepEqual(selected.items.map(item=>item.id),['fresh']);
  assert.deepEqual(selected.newest,{id:'fresh',revision:1});
  assert.match(selected.text,/边界内的虚构原话/u);
  assert.doesNotMatch(selected.text,/没有时间的虚构原话|过期的虚构原话|更早的虚构原话/u);

  const expiredReader={list:()=>({sources:[sources[2]],nextBefore:null})};
  const expired=selectHandoff(expiredReader,{tokens:4096,maxAgeMs:72*HOUR,now:()=>now});
  assert.equal(expired.text,'');
  assert.deepEqual(expired.items,[]);
  assert.equal(expired.newest,null);
});

test('selectHandoff still finds fresh originals behind an expired one stored later',()=>{
  const now=Date.UTC(2026,10,15,12);
  // A recovered old turn can be stored after newer ones; it must not hide them.
  const sources=[
    {id:'recovered-old',revision:1,position:3,sequence:3,sessionId:'old',turn:1,role:'user',
      text:'补录的很早的虚构原话。',time:now-200*HOUR,turnState:'completed'},
    {id:'fresh-user',revision:1,position:2,sequence:2,sessionId:'source',turn:1,role:'user',
      text:'昨天的虚构原话。',time:now-20*HOUR,turnState:'completed'},
    {id:'fresh-assistant',revision:1,position:1,sequence:1,sessionId:'source',turn:1,role:'assistant',
      text:'昨天的虚构回复。',time:now-20*HOUR,turnState:'completed'},
  ];
  const reader={list:()=>({sources,nextBefore:null})};
  const selected=selectHandoff(reader,{tokens:4096,maxAgeMs:72*HOUR,now:()=>now});
  assert.deepEqual(selected.items.map(item=>item.id),['fresh-assistant','fresh-user']);
  assert.doesNotMatch(selected.text,/补录的很早的虚构原话/u);
});

test('handoffMaxAgeHours defaults for missing and invalid values and validates the schema',()=>{
  assert.equal(DEFAULT_CONFIG.handoffMaxAgeHours,72);
  assert.equal(resolveConfig({}).handoffMaxAgeHours,72);
  assert.equal(resolveConfig({handoffMaxAgeHours:1}).handoffMaxAgeHours,1);
  assert.equal(resolveConfig({handoffMaxAgeHours:8760}).handoffMaxAgeHours,8760);
  for(const invalid of [0,-1,8761,1.5,NaN,Infinity,'72'])
    assert.equal(resolveConfig({handoffMaxAgeHours:invalid}).handoffMaxAgeHours,72,String(invalid));
  assert.equal(Config({}).handoffMaxAgeHours,72);
  assert.equal(Config({handoffMaxAgeHours:8760}).handoffMaxAgeHours,8760);
  for(const invalid of [0,-1,8761,1.5])
    assert.throws(()=>Config({handoffMaxAgeHours:invalid}),undefined,String(invalid));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {Readable} from 'node:stream';
import {RawMemoryStore} from '../lib/raw-rag/store.js';
import {createRawRecall} from '../lib/raw-rag/index.js';
import {createMemoryEntryAccess} from '../lib/memory-entry-access.js';
import {createMemoryQueryAnswer,rerankDocumentText} from '../lib/memory-query.js';
import {createMemoryReranker} from '../lib/memory-rerank.js';
import {requestRerank,rerankServiceUrl} from '../lib/raw-rag/rerank-http.js';
import {deploymentFingerprint,manageEmbeddingServices,readDeploymentSettings,stageDeploymentRerank} from '../lib/deployment-config.js';
import {Config,resolveConfig} from '../lib/config.js';
import {createSettingsHandler} from '../lib/settings-host.js';
import {memoryStore} from './fake-memory.js';
import {fakeAgent} from './helpers.js';

const clientSource=await fs.readFile(new URL('../lib/client.js',import.meta.url),'utf8');

async function queryFixture(t,options={}){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-rerank-query-'));
  const memory=new RawMemoryStore(path.join(directory,'existing.sqlite'),{warn(){}});
  const config=resolveConfig({project:'main',vaultPath:path.join(directory,'vault'),rawRecall:false,...options.config});
  const notes=memoryStore({project:'main'}),agent=fakeAgent('session-rerank');
  const access={
    ownerSubject:'owner',
    grant(){
      const controller=new AbortController();
      return {kind:'read',ownerSubject:'owner',project:'main',sessionId:agent.session.id,
        rootSessionId:agent.session.id,epoch:'one',signal:controller.signal,cancel:()=>controller.abort()};
    },
    validate:grant=>!grant.signal?.aborted,
    validateMessage:()=>true,
    assertCurrent(){},
    withGrant:(_grant,work)=>work(),
  };
  const raw=createRawRecall({config,store:memory,ownerSubject:'owner'});
  const entries=createMemoryEntryAccess({access,raw,tools:notes.tools,config});
  const save=(id,text,sequence)=>{
    const source={ownerSubject:'owner',project:'main',sessionId:agent.session.id,messageId:id,role:'user',
      sequence,turn:sequence,rootTurn:sequence,text,content:[{type:'text',text}],time:sequence*1000,
      authorization:{rootSessionId:agent.session.id}};
    return memory.messages.record(source,{authorize:()=>true}).source;
  };
  const answers=[];
  const answer=(reranker,extra={})=>{
    const value=createMemoryQueryAnswer({access,agent,raw,entries,tools:notes.tools,config,
      ...(reranker?{reranker}:{}),...(options.now?{now:options.now}:{}),...extra});
    answers.push(value);
    return value;
  };
  t.after(async()=>{
    for(const value of answers)value.dispose();
    await raw.dispose();
    await fs.rm(directory,{recursive:true,force:true});
  });
  return {directory,config,agent,notes,access,raw,entries,save,answer};
}

const response=(payload,status=200)=>({ok:status>=200&&status<300,status,headers:{get:()=>null},json:async()=>payload});

async function fixtureReranker(f,{fetchImpl,model='fixture/reranker',...patch}={}){
  const apiKeyFile=path.join(f.directory,'rerank.key');
  await fs.writeFile(apiKeyFile,'fictional-rerank-key');
  const config=resolveConfig({...f.config,memoryRerank:true,memoryRerankApiBase:'http://127.0.0.1:9',
    memoryRerankApiKeyFile:apiKeyFile,memoryRerankModel:model,...patch});
  return createMemoryReranker({config,fetchImpl,now:()=>Date.now()});
}

async function deploymentFixture(t){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'memory-rerank-settings-')),dshHome=path.join(root,'dsh');
  await fs.mkdir(path.join(dshHome,'storages'),{recursive:true});
  await fs.writeFile(path.join(dshHome,'storages','workspace.json'),
    JSON.stringify({unit:{name:'workspace',version:2},tables:{workspaces:{}}}));
  const file=path.join(root,'deployment.json');
  await fs.writeFile(file,JSON.stringify({ownerDirectory:root,ownerSubject:'fictional-owner',dshHome,dshSessionIds:[],
    memory:{rawRecall:false,memoryRerank:false}}));
  const read=async()=>JSON.parse(await fs.readFile(file,'utf8'));
  const revision=async()=>deploymentFingerprint(await read());
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  return {
    root,file,read,revision,
    async manageWithRevision(input){return manageEmbeddingServices(file,input,await revision());},
    async stage(input){return stageDeploymentRerank(file,input,await revision());},
  };
}

function uiEnvironment(handler){
  let rendering,plugin,timerId=0;
  const registrations=new Map(),hosts=[],calls=[];
  const same=(left,right)=>left&&right&&left.length===right.length&&left.every((value,index)=>Object.is(value,right[index]));
  const cell=()=>{const host=rendering,index=host.index++;return {host,index,previous:host.hooks[index]};};
  const React={
    Fragment:Symbol('Fragment'),
    createElement(type,props,...children){return {type,props:{...props,children:children.flat(12).filter(child=>child!==null&&child!==undefined&&child!==false)}};},
    useRef(value){const valueCell=cell();return valueCell.previous||(valueCell.host.hooks[valueCell.index]={current:value});},
    useState(initial){
      const valueCell=cell(),row=valueCell.previous||(valueCell.host.hooks[valueCell.index]={value:typeof initial==='function'?initial():initial});
      return [row.value,next=>{const value=typeof next==='function'?next(row.value):next;if(!Object.is(value,row.value)){row.value=value;valueCell.host.dirty=true;}}];
    },
    useMemo(fn,deps){const valueCell=cell();if(!valueCell.previous||!same(valueCell.previous.deps,deps))valueCell.host.hooks[valueCell.index]={value:fn(),deps};return valueCell.host.hooks[valueCell.index].value;},
    useCallback(fn,deps){return React.useMemo(()=>fn,deps);},
    useEffect(fn,deps){
      const valueCell=cell();
      if(!valueCell.previous||!same(valueCell.previous.deps,deps)){
        const row={deps,cleanup:null};valueCell.host.hooks[valueCell.index]=row;
        valueCell.host.effects.push(()=>{valueCell.previous?.cleanup?.();row.cleanup=fn();});
      }
    },
  };
  const window=new EventTarget();
  window.__ModuleLoader__={load(value){plugin=value.factory(()=>React);}};
  const context={window,Event,AbortController,console,document:{getElementById:()=>null},
    setInterval(){return ++timerId;},clearInterval(){},setTimeout(fn){const id=++timerId;queueMicrotask(fn);return id;},clearTimeout(){},
    async fetch(path,options={}){
      const body=options.body?JSON.parse(options.body):undefined,value=handler(path,body);
      calls.push({path,body});
      return {ok:true,status:200,json:async()=>structuredClone(value)};
    }
  };
  vm.runInNewContext(clientSource,context,{filename:'memory-rerank-client.js'});
  plugin.apply({effect(){},remote:{pluginManager:{async listPlugins(){return {ok:true,value:[{moduleName:'@local/dsh-basic-memory-bridge',enabled:true,fiberPhase:'active'}]};},
    async listBundles(){return {ok:true,value:[]};}}},slots:{inject(_name,register){register();},
    register(meta,render){registrations.set(meta.name,render);}}});
  class Host{
    constructor(fn,props){this.fn=fn;this.props=props;this.hooks=[];this.dirty=true;this.tree=null;hosts.push(this);}
    render(effects=true){this.index=0;this.effects=[];this.dirty=false;rendering=this;this.tree=this.fn(this.props);rendering=null;
      if(effects)for(const effect of this.effects)effect();return this.tree;}
    async flush(){for(let index=0;index<30;index++){if(this.dirty||!this.tree)this.render();await new Promise(resolve=>setImmediate(resolve));if(!this.dirty)return;}throw Error('UI did not settle');}
    close(){for(const hook of this.hooks)hook?.cleanup?.();}
  }
  return {calls,page(){const tree=registrations.get('settings.section')();return new Host(tree.type,tree.props);},
    component(node){return new Host(node.type,node.props);},close(){for(const host of hosts)host.close();}};
}

function uiChildren(node){return node&&typeof node==='object'?node.props?.children||[]:[];}
function uiText(node){return typeof node==='string'||typeof node==='number'?String(node):uiChildren(node).map(uiText).join('');}
function uiNodes(tree,predicate){
  if(!tree||typeof tree!=='object')return [];
  return [...(predicate(tree)?[tree]:[]),...uiChildren(tree).flatMap(child=>uiNodes(child,predicate))];
}

test('disabled rerank preserves the exact pre-rerank query order',async t=>{
  const f=await queryFixture(t);
  for(let index=1;index<=5;index++)f.save('candidate-'+index,'虚构候选记忆 '+index,index);
  const plain=await f.answer().search({query:'虚构候选',limit:5});
  const disabledReranker={
    enabled:()=>false,
    rerank(){throw Error('disabled reranker must not be called');},
    status:()=>({enabled:false,state:'off',reason:''}),
  };
  const disabled=await f.answer(disabledReranker).search({query:'虚构候选',limit:5});
  assert.deepEqual(disabled.records.map(record=>[record.id,record.revision,record.text]),
    plain.records.map(record=>[record.id,record.revision,record.text]));
  // Nothing reaches the model's tool result when rerank is off: same channels as without a reranker.
  assert.deepEqual(Object.keys(disabled.channels).sort(),Object.keys(plain.channels).sort());
  assert.equal(disabled.channels.rerank,undefined);
});

test('rerank configuration has safe defaults and validates its flat fields',()=>{
  const defaults=resolveConfig({});
  assert.deepEqual([defaults.memoryRerank,defaults.memoryRerankSource,defaults.memoryRerankApiBase,defaults.memoryRerankApiKeyFile,
    defaults.memoryRerankModel,defaults.memoryRerankServiceId,defaults.memoryRerankCandidates,defaults.memoryRerankTimeoutMs],
  [false,'service','','','BAAI/bge-reranker-v2-m3','',30,1500]);
  const absolute=path.join(os.tmpdir(),'fictional-rerank.key');
  const value=resolveConfig({memoryRerank:true,memoryRerankSource:' direct ',memoryRerankApiBase:' https://fictional.example/v1 ',
    memoryRerankApiKeyFile:absolute,memoryRerankModel:' fixture/reranker ',memoryRerankServiceId:' service-a ',
    memoryRerankCandidates:3,memoryRerankTimeoutMs:9000});
  assert.deepEqual([value.memoryRerank,value.memoryRerankSource,value.memoryRerankApiBase,value.memoryRerankApiKeyFile,value.memoryRerankModel,
    value.memoryRerankServiceId,value.memoryRerankCandidates,value.memoryRerankTimeoutMs],
  [true,'direct','https://fictional.example/v1',absolute,'fixture/reranker','service-a',5,5000]);
  assert.equal(resolveConfig({memoryRerankSource:'direct'}).memoryRerankSource,'direct');
  assert.equal(resolveConfig({memoryRerankApiKeyFile:'relative.key'}).memoryRerankApiKeyFile,'');
  assert.equal(resolveConfig({memoryRerankModel:'x'.repeat(121)}).memoryRerankModel,'BAAI/bge-reranker-v2-m3');
  assert.equal(Config({}).memoryRerankCandidates,30);
});

test('rerank service URL only accepts HTTPS or loopback HTTP and replaces embeddings paths',()=>{
  assert.equal(rerankServiceUrl('https://fictional-rerank.example/v1'),'https://fictional-rerank.example/v1/rerank');
  assert.equal(rerankServiceUrl('http://127.0.0.1:8080/v1'),'http://127.0.0.1:8080/v1/rerank');
  assert.equal(rerankServiceUrl('https://fictional-rerank.example/v1/embeddings'),'https://fictional-rerank.example/v1/rerank');
  assert.throws(()=>rerankServiceUrl('http://fictional-rerank.example/v1'),/HTTPS|loopback/u);
  const credentialedUrl=['https:','','//','user',':','pass','@','fictional-rerank.example/v1'].join('');
  assert.throws(()=>rerankServiceUrl(credentialedUrl),/HTTPS|loopback/u);
  assert.throws(()=>rerankServiceUrl('https://fictional-rerank.example/v1?secret=1'),/HTTPS|loopback/u);
  assert.throws(()=>rerankServiceUrl('https://fictional-rerank.example/v1#secret'),/HTTPS|loopback/u);
});

test('rerank HTTP sends the compatible request and exposes metadata-only usage',async t=>{
  let received;
  const server=http.createServer(async(req,res)=>{
    const chunks=[];
    for await(const chunk of req)chunks.push(chunk);
    received={path:req.url,authorization:req.headers.authorization,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))};
    const payload=received.body.query==='duplicate'
      ?{results:[{index:1,relevance_score:1},{index:1,relevance_score:.5}]}
      :received.body.query==='outside'?{results:[{index:9,relevance_score:1}]}
        :{id:'fixture-rerank',results:[{index:2,relevance_score:.91},{index:0,relevance_score:.42}],
          meta:{tokens:{input_tokens:9,output_tokens:2},billed_units:{input_tokens:9}}};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(payload));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {port}=server.address(),baseUrl=`http://127.0.0.1:${port}/v1`;
  const usage=[];
  const found=await requestRerank({baseUrl,model:'fixture/reranker',query:'虚构查询',documents:['甲','乙','丙'],
    apiKey:'fictional-rerank-key',onUsage:receipt=>usage.push(receipt)});
  assert.deepEqual(found,[{index:2,score:.91},{index:0,score:.42}]);
  assert.equal(received.path,'/v1/rerank');
  assert.equal(received.authorization,'Bearer fictional-rerank-key');
  assert.deepEqual(received.body,{model:'fixture/reranker',query:'虚构查询',documents:['甲','乙','丙'],return_documents:false});
  for(const field of ['instruction','top_n','max_chunks_per_doc','overlap_tokens'])assert.equal(Object.hasOwn(received.body,field),false);
  assert.equal(usage.length,1);assert.equal(usage[0].outcome,'ok');assert.equal(usage[0].httpStatus,200);
  assert.deepEqual(usage[0].tokens,{input_tokens:9,output_tokens:2});
  const receiptText=JSON.stringify(usage[0]);
  for(const secret of ['虚构查询','甲','乙','丙','fictional-rerank-key'])assert.equal(receiptText.includes(secret),false);
  await assert.rejects(requestRerank({baseUrl,model:'fixture/reranker',query:'duplicate',documents:['甲','乙'],
    apiKey:'fictional-rerank-key'}),/invalid result/u);
  await assert.rejects(requestRerank({baseUrl,model:'fixture/reranker',query:'outside',documents:['甲','乙'],
    apiKey:'fictional-rerank-key'}),/invalid result/u);
});

test('a successful query rerank puts the model-ranked third candidate first',async t=>{
  const f=await queryFixture(t);
  for(let index=1;index<=5;index++)f.save('rank-'+index,'虚构重排候选 '+index,index);
  const baseline=await f.answer().search({query:'虚构重排候选',limit:5});
  const reranker=await fixtureReranker(f,{fetchImpl:async()=>response({results:[{index:2,relevance_score:.99}],
    meta:{tokens:{input_tokens:5,output_tokens:1}}})});
  const found=await f.answer(reranker).search({query:'虚构重排候选',limit:5});
  assert.ok(baseline.records.length>=3);
  assert.equal(found.records[0].id,baseline.records[2].id);
  assert.equal(found.channels.rerank.state,'applied');
  assert.equal(found.channels.rerank.candidates,baseline.records.length);
  assert.equal(reranker.status().calls,1);assert.equal(reranker.status().failures,0);
});

test('HTTP failures keep query order and open a ten-minute rerank circuit',async t=>{
  const f=await queryFixture(t);
  for(let index=1;index<=4;index++)f.save('failure-'+index,'虚构失败候选 '+index,index);
  const baseline=await f.answer().search({query:'虚构失败候选',limit:4});
  let calls=0;
  const reranker=await fixtureReranker(f,{fetchImpl:async()=>{calls++;return response({error:'fictional'},500);}});
  const failed=await f.answer(reranker).search({query:'虚构失败候选',limit:4});
  assert.deepEqual(failed.records.map(record=>record.id),baseline.records.map(record=>record.id));
  assert.equal(failed.channels.rerank.state,'failed');assert.equal(calls,1);
  const paused=await f.answer(reranker).search({query:'虚构失败候选',limit:4});
  assert.deepEqual(paused.records.map(record=>record.id),baseline.records.map(record=>record.id));
  assert.equal(paused.channels.rerank.state,'paused');assert.equal(calls,1);
  assert.equal(reranker.status().state,'paused');assert.equal(reranker.status().failures,1);
});

test('rerank timeouts fall back without opening the circuit',async t=>{
  const f=await queryFixture(t);
  for(let index=1;index<=4;index++)f.save('timeout-'+index,'虚构超时候选 '+index,index);
  const baseline=await f.answer().search({query:'虚构超时候选',limit:4});
  let calls=0;
  const reranker=await fixtureReranker(f,{memoryRerankTimeoutMs:300,fetchImpl:(_url,{signal})=>{
    calls++;
    return new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(signal.reason??new Error('aborted')),{once:true});
    });
  }});
  const first=await f.answer(reranker).search({query:'虚构超时候选',limit:4});
  assert.deepEqual(first.records.map(record=>record.id),baseline.records.map(record=>record.id));
  assert.equal(first.channels.rerank.state,'timeout');
  const second=await f.answer(reranker).search({query:'虚构超时候选',limit:4});
  assert.equal(second.channels.rerank.state,'timeout');assert.equal(calls,2);
  assert.equal(reranker.status().state,'ready');assert.notEqual(reranker.status().state,'paused');
  assert.equal(reranker.status().failures,2);
});

test('a short search wait keeps a slow rerank inside the caller timeout and returns the original order',async t=>{
  const f=await queryFixture(t);
  for(let index=1;index<=4;index++)f.save('short-'+index,'虚构短等待候选 '+index,index);
  const baseline=await f.answer().search({query:'虚构短等待候选',limit:4});
  const reranker=await fixtureReranker(f,{fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason??new Error('aborted')),{once:true});
  })});
  // The caller gives up after 1100 ms; the search itself must finish before that.
  const found=await f.answer(reranker,{searchWaitMs:900}).search({query:'虚构短等待候选',limit:4},{signal:AbortSignal.timeout(1100)});
  assert.deepEqual(found.records.map(record=>record.id),baseline.records.map(record=>record.id));
  assert.equal(found.channels.rerank.state,'timeout');
});

test('originals still visible in the conversation are skipped so older lines fill the slots',async t=>{
  const f=await queryFixture(t);
  for(let index=1;index<=4;index++)f.save('visible-'+index,'虚构可见候选 '+index,index);
  const all=await f.answer().search({query:'虚构可见候选',limit:4});
  assert.equal(all.records.length,4);
  const visible=new Set(['visible-3','visible-4']);
  const found=await f.answer(null,{visibleMessageIds:visible}).search({query:'虚构可见候选',limit:4});
  assert.deepEqual(found.records.map(record=>record.source.messageId).sort(),['visible-1','visible-2']);
});

test('rerank is skipped when the remaining query budget is under 200 milliseconds',async t=>{
  const f=await queryFixture(t,{config:{rawRecallQueryWaitMs:1000}});
  for(let index=1;index<=4;index++)f.save('no-time-'+index,'虚构剩余预算候选 '+index,index);
  const original=f.notes.tools.get.bind(f.notes.tools);
  f.notes.tools.get=(name,agent)=>{
    const tool=original(name,agent);
    return name==='mcp__basic_memory__search_notes'?{...tool,async execute(...args){
      await new Promise(resolve=>setTimeout(resolve,850));
      return tool.execute(...args);
    }}:tool;
  };
  let calls=0;
  const reranker=await fixtureReranker(f,{fetchImpl:async()=>{calls++;return response({results:[]});}});
  const found=await f.answer(reranker).search({query:'虚构剩余预算候选',limit:4});
  assert.equal(found.channels.rerank.state,'no_time');assert.equal(calls,0);
});

test('rerank documents are capped at 1000 Unicode characters without splitting surrogate pairs',()=>{
  const source='a'.repeat(400)+'😀'.repeat(600);
  const truncated=rerankDocumentText(source);
  assert.equal(Array.from(truncated).length,1000);
  assert.equal(truncated.endsWith('😀'),true);
  assert.equal(/[\uD800-\uDBFF]$/u.test(truncated),false);
});

test('an unreadable rerank key disables the runtime without throwing from status',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-rerank-key-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const config=resolveConfig({memoryRerank:true,memoryRerankApiBase:'https://fictional-rerank.example/v1',
    memoryRerankApiKeyFile:path.join(directory,'missing.key'),memoryRerankModel:'fixture/reranker'});
  const reranker=createMemoryReranker({config,fetchImpl:async()=>response({results:[]})});
  assert.equal(reranker.enabled(),true);
  await assert.rejects(reranker.rerank({query:'虚构查询',documents:['甲','乙'],signal:new AbortController().signal}),
    {code:'RERANK_UNAVAILABLE'});
  const status=reranker.status();
  assert.equal(status.state,'unavailable');assert.equal(status.reason,'重排密钥不可用');
  assert.equal(status.lastState,'disabled');assert.equal(status.calls,0);
});

test('direct rerank settings store an independent key without exposing credentials',async t=>{
  const f=await deploymentFixture(t);
  const saved=await f.stage({enabled:true,source:'direct',apiBase:'https://fictional-direct.example/v1/',apiKey:'fictional-direct-key',
    model:'fixture/direct-reranker',candidates:11,cloudConfirmed:true});
  assert.deepEqual(saved.rerank,{enabled:true,source:'direct',serviceId:'',apiBase:'https://fictional-direct.example/v1',
    model:'fixture/direct-reranker',candidates:11,hasKey:true});
  const savedText=JSON.stringify(saved);
  assert.equal(savedText.includes('apiKeyFile'),false);
  assert.equal(savedText.includes('fictional-direct-key'),false);
  const cfg=await f.read(),keyFile=cfg.memory.memoryRerankApiKeyFile;
  assert.match(path.basename(keyFile),/^rerank-[a-f0-9-]{36}\.key$/i);
  assert.equal(await fs.readFile(keyFile,'utf8'),'fictional-direct-key');
  const settings=await readDeploymentSettings(f.file);
  assert.deepEqual(settings.rerank,saved.rerank);
  assert.equal(JSON.stringify(settings).includes('apiKeyFile'),false);
  assert.equal(JSON.stringify(settings).includes('fictional-direct-key'),false);
});

test('direct rerank does not keep a vector service in use',async t=>{
  const f=await deploymentFixture(t);
  const saved=await f.manageWithRevision({action:'save',name:'虚构独立重排',apiBase:'https://fictional-vector.example/v1',
    apiModel:'fictional-embed',dimensions:768,apiKey:'fictional-vector-key'});
  const serviceId=saved.embeddingServices[0].id;
  await f.stage({enabled:true,source:'direct',apiBase:'https://fictional-direct.example/v1',apiKey:'fictional-direct-key',
    model:'fixture/direct-reranker',candidates:10,cloudConfirmed:true});
  const settings=await readDeploymentSettings(f.file);
  assert.equal(settings.embeddingServices[0].inUse,false);
  const deleted=await f.manageWithRevision({action:'delete',id:serviceId});
  assert.equal(deleted.embeddingServices.some(service=>service.id===serviceId),false);
});

test('direct rerank reuses an unchanged key and deletes old dedicated keys on replacement or service mode',async t=>{
  const f=await deploymentFixture(t);
  const vector=await f.manageWithRevision({action:'save',name:'虚构重排服务',apiBase:'https://fictional-vector.example/v1',
    apiModel:'fictional-embed',dimensions:768,apiKey:'fictional-vector-key'});
  const serviceId=vector.embeddingServices[0].id;
  await f.stage({enabled:true,source:'direct',apiBase:'https://fictional-direct.example/v1',apiKey:'fictional-direct-key-one',
    model:'fixture/direct-reranker',candidates:10,cloudConfirmed:true});
  const firstKey=(await f.read()).memory.memoryRerankApiKeyFile;
  await f.stage({enabled:true,source:'direct',apiBase:'https://fictional-direct.example/v1',
    model:'fixture/direct-reranker',candidates:10,cloudConfirmed:true});
  assert.equal((await f.read()).memory.memoryRerankApiKeyFile,firstKey);
  await f.stage({enabled:true,source:'direct',apiBase:'https://fictional-direct.example/v1',apiKey:'fictional-direct-key-two',
    model:'fixture/direct-reranker',candidates:10,cloudConfirmed:true});
  const secondKey=(await f.read()).memory.memoryRerankApiKeyFile;
  assert.notEqual(secondKey,firstKey);
  await assert.rejects(fs.access(firstKey),{code:'ENOENT'});
  assert.equal(await fs.readFile(secondKey,'utf8'),'fictional-direct-key-two');
  await f.stage({enabled:true,source:'service',serviceId,model:'fixture/service-reranker',candidates:10,cloudConfirmed:true});
  await assert.rejects(fs.access(secondKey),{code:'ENOENT'});
});

test('direct rerank rejects changed remote addresses without a key and allows loopback HTTP without authorization',async t=>{
  const f=await deploymentFixture(t);
  await f.stage({enabled:true,source:'direct',apiBase:'https://fictional-direct.example/v1',apiKey:'fictional-direct-key',
    model:'fixture/direct-reranker',candidates:10,cloudConfirmed:true});
  await assert.rejects(f.stage({enabled:true,source:'direct',apiBase:'https://fictional-direct-two.example/v1',
    model:'fixture/direct-reranker',candidates:10,cloudConfirmed:true}),/请填写重排服务的 API Key/u);
  let authorization='unset';
  const server=http.createServer(async(req,res)=>{
    authorization=req.headers.authorization;
    for await(const _chunk of req){}
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({results:[{index:1,relevance_score:.9},{index:0,relevance_score:.2}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const {port}=server.address();
  const saved=await f.stage({enabled:true,source:'direct',apiBase:`http://127.0.0.1:${port}/v1`,
    model:'fixture/local-reranker',candidates:10,cloudConfirmed:true});
  assert.equal(saved.rerank.hasKey,false);
  const cfg=await f.read();
  assert.equal(cfg.memory.memoryRerankApiKeyFile,'');
  const reranker=createMemoryReranker({config:resolveConfig(cfg.memory),fetchImpl:fetch});
  const found=await reranker.rerank({query:'虚构查询',documents:['虚构甲','虚构乙'],signal:new AbortController().signal});
  assert.deepEqual(found,[{index:1,score:.9},{index:0,score:.2}]);
  assert.equal(authorization,undefined);
  assert.equal(reranker.status().service,'127.0.0.1');
});

test('direct rerank rejects non-loopback HTTP addresses',async t=>{
  const f=await deploymentFixture(t);
  await assert.rejects(f.stage({enabled:false,source:'direct',apiBase:'http://fictional-rerank.example/v1',
    model:'fixture/direct-reranker',candidates:10}),/HTTPS|本机回环/u);
});

test('rerank deployment settings require confirmation and keep the selected service locked until disabled',async t=>{
  const f=await deploymentFixture(t);
  const saved=await f.manageWithRevision({action:'save',name:'虚构重排服务',apiBase:'https://fictional-rerank.example/v1',
    apiModel:'fictional-embed',dimensions:768,apiKey:'fictional-embed-key'});
  const serviceId=saved.embeddingServices[0].id;
  await assert.rejects(f.stage({enabled:true,serviceId,model:'fixture/reranker',candidates:12,cloudConfirmed:false}),
    /开启重排会把候选记忆片段发送到所选服务，请先确认/u);
  await assert.rejects(f.stage({enabled:true,serviceId:'missing-service',model:'fixture/reranker',candidates:12,cloudConfirmed:true}),
    /已不存在/u);
  const enabled=await f.stage({enabled:true,serviceId,model:'fixture/reranker',candidates:12,cloudConfirmed:true});
  assert.deepEqual(enabled.rerank,{enabled:true,source:'service',serviceId,apiBase:'https://fictional-rerank.example/v1',
    model:'fixture/reranker',candidates:12,hasKey:true});
  assert.equal(JSON.stringify(enabled).includes('apiKeyFile'),false);
  let settings=await readDeploymentSettings(f.file);
  assert.equal(settings.rerank.enabled,true);assert.equal(settings.rerank.serviceId,serviceId);
  assert.equal(JSON.stringify(settings).includes('apiKeyFile'),false);
  assert.equal(settings.embeddingServices[0].inUse,true);
  const cfg=await f.read(),keyFile=cfg.memory.memoryRerankApiKeyFile;
  await assert.rejects(f.manageWithRevision({action:'delete',id:serviceId}),/这个服务正被重排使用；要删除请先关闭重排/u);
  const disabled=await f.stage({enabled:false});
  assert.equal(disabled.rerank.enabled,false);
  settings=await readDeploymentSettings(f.file);
  assert.equal(settings.rerank.enabled,false);
  assert.equal(settings.embeddingServices[0].inUse,false);
  await f.manageWithRevision({action:'delete',id:serviceId});
  await assert.rejects(fs.access(keyFile),{code:'ENOENT'});
});

test('settings route stages rerank without calling the live after-save hook',async t=>{
  const f=await deploymentFixture(t);
  const saved=await f.manageWithRevision({action:'save',name:'虚构路由服务',apiBase:'https://fictional-route.example/v1',
    apiModel:'fictional-embed',dimensions:768,apiKey:'fictional-route-key'});
  const serviceId=saved.embeddingServices[0].id;
  const handler=createSettingsHandler({},f.file,undefined,undefined,{afterSave(){throw Error('must not run');}});
  t.after(()=>handler.dispose());
  const req=Readable.from([Buffer.from(JSON.stringify({enabled:true,serviceId,model:'fixture/reranker',candidates:9,
    cloudConfirmed:true,revision:await f.revision()}))]);
  Object.assign(req,{method:'POST',url:'/api/basic-memory-settings/rerank',socket:{remoteAddress:'127.0.0.1'},
    headers:{host:'127.0.0.1:15680','content-type':'application/json','x-basic-memory-settings':'1'}});
  const res={headers:{},setHeader(key,value){this.headers[key]=value;},end(value){this.body=JSON.parse(value);}};
  await handler(req,res);
  assert.equal(res.statusCode,200,JSON.stringify(res.body));
  assert.equal(res.body.rerank.enabled,true);
  assert.equal(JSON.stringify(res.body).includes('apiKeyFile'),false);
});

test('model settings render the optional rerank section and status page renders its runtime line',async t=>{
  const service={id:'service-rerank',name:'虚构重排服务',apiBase:'https://fictional-rerank.example/v1',
    apiModel:'fictional-embed',dimensions:768,hasKey:true,inUse:false};
  const snapshot={ok:true,revision:'r1',runtime:'loaded',directory:'/fictional-memory',sessions:[],
    sessionMemory:{defaultEnabled:false,effective:'next-user-turn',enabledSessions:[],states:[]},
    rawModel:{fields:{rawRecallModel:'Qwen/Qwen3-Embedding-0.6B',rawRecallThreads:2}},
    rawModels:[{id:'Qwen/Qwen3-Embedding-0.6B',label:'Qwen 0.6B',engine:'onnx',dimensions:1024}],
    embeddingServices:[service],rerank:{enabled:true,serviceId:'',model:'BAAI/bge-reranker-v2-m3',candidates:30}};
  const runtimeValue={ok:true,rerank:{enabled:true,model:'fixture/reranker',service:'fictional-rerank.example',
    state:'ready',reason:'',calls:2,failures:1,lastState:'failed',lastAt:null,tokens:12}};
  const env=uiEnvironment(url=>{
    if(url==='/api/basic-memory-settings/runtime')return runtimeValue;
    if(url==='/api/basic-memory-settings/model-install')return {ok:true,inventory:{models:[]}};
    return snapshot;
  });
  t.after(()=>env.close());
  const waitText=async(host,pattern)=>{
    for(let index=0;index<100;index++){
      await new Promise(resolve=>setImmediate(resolve));await host.flush();
      if(pattern.test(uiText(host.tree)))return;
    }
    assert.fail('UI text did not appear: '+pattern+' in '+uiText(host.tree));
  };
  const page=env.page();
  await waitText(page,/记忆框架已加载/u);
  assert.ok(env.calls.some(call=>call.path==='/api/basic-memory-settings/sessions'),JSON.stringify(env.calls));
  const button=label=>{
    const found=uiNodes(page.tree,node=>node.type==='button'&&uiText(node)===label)[0];
    assert.ok(found,'missing button '+label);return found;
  };
  button('检索模型').props.onClick();
  const waitComponent=async name=>{
    for(let index=0;index<100;index++){
      await new Promise(resolve=>setImmediate(resolve));await page.flush();
      const found=uiNodes(page.tree,node=>typeof node.type==='function'&&node.type.name===name)[0];
      if(found)return env.component(found);
    }
    assert.fail('UI component did not appear: '+name);
  };
  const picker=await waitComponent('ModelPicker');
  await picker.flush();
  const subtab=label=>uiNodes(picker.tree,node=>node.type==='button'&&node.props.role==='tab'&&uiText(node)===label)[0];
  const panel=label=>uiNodes(picker.tree,node=>node.props?.role==='tabpanel'&&node.props?.['aria-label']===label)[0];
  assert.equal(subtab('向量').props['aria-selected'],true);
  assert.equal(subtab('重排').props['aria-selected'],false);
  assert.equal(panel('向量').props.hidden,false);
  assert.equal(panel('重排').props.hidden,true);
  assert.doesNotMatch(uiText(panel('向量')),/重排（可选）/u);
  const callsBeforeSwitch=env.calls.length;
  subtab('重排').props.onClick();
  await picker.flush();
  assert.equal(subtab('向量').props['aria-selected'],false);
  assert.equal(subtab('重排').props['aria-selected'],true);
  assert.equal(panel('向量').props.hidden,true);
  assert.equal(panel('重排').props.hidden,false);
  assert.equal(env.calls.length,callsBeforeSwitch);
  let rerankNode;
  for(let index=0;index<100&&!rerankNode;index++){
    await new Promise(resolve=>setImmediate(resolve));await picker.flush();
    rerankNode=uiNodes(panel('重排'),node=>typeof node.type==='function'&&node.type.name==='RerankSettings')[0];
  }
  assert.ok(rerankNode);
  const rerank=env.component(rerankNode);
  await waitText(rerank,/重排（可选）/u);
  assert.match(uiText(rerank.tree),/启用重排/u);
  assert.match(uiText(rerank.tree),/使用已保存的服务/u);
  assert.match(uiText(rerank.tree),/单独填写地址和 Key/u);
  const direct=uiNodes(rerank.tree,node=>node.type==='input'&&node.props.type==='radio'&&node.props.value==='direct')[0];
  assert.ok(direct);
  direct.props.onChange();
  await waitText(rerank,/服务地址/u);
  const address=uiNodes(rerank.tree,node=>node.type==='input'&&node.props['aria-label']==='重排服务地址')[0];
  const keyInput=uiNodes(rerank.tree,node=>node.type==='input'&&node.props['aria-label']==='重排 API Key')[0];
  assert.equal(address.props.placeholder,'https://api.siliconflow.cn/v1');
  assert.ok(keyInput);
  const enable=uiNodes(rerank.tree,node=>node.type==='input'&&node.props.type==='checkbox')[0];
  enable.props.onChange({target:{checked:true}});
  await waitText(rerank,/重排模型/u);
  const modelInput=uiNodes(rerank.tree,node=>node.type==='input'&&node.props['aria-label']==='重排模型')[0];
  assert.equal(modelInput.props.value,'BAAI/bge-reranker-v2-m3');
  button('状态').props.onClick();
  const runtime=await waitComponent('MemoryRuntimeSettings');
  await waitText(runtime,/重排fixture\/reranker · fictional-rerank\.example · 本次启动调用 2 次，失败 1 次已开启/u);
  assert.doesNotMatch(uiText(runtime.tree),/apiKeyFile|fictional-rerank-key/u);
  // Saved settings that differ from the running ones say a restart is needed instead of the old state.
  snapshot.rerank={...snapshot.rerank,enabled:false};
  button('刷新').props.onClick();
  for(let i=0;i<20;i++){await new Promise(r=>setImmediate(r));await page.flush();}
  await waitText(await waitComponent('MemoryRuntimeSettings'),/重排已保存，重启 DSH 后生效重启后关闭/u);
});

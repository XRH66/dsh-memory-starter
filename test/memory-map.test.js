import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {buildLayout,seededRandom,memoryDepth,clusterKeywords} from '../lib/memory-map/layout.js';
import {createVectorIndex,readLayoutVectors,readLayoutMembers} from '../lib/storage/vector-index.js';
import {createMemoryMapService} from '../lib/memory-map/service.js';
import {createMemoryMapHandler,listViews} from '../lib/memory-map/routes.js';

const scope={ownerSubject:'owner-fictional',project:'main'};
const allow=()=>{};

function clustered(n,d,k,seed=7){
  const random=seededRandom(seed),centers=[];
  for(let c=0;c<k;c++)centers.push(Float32Array.from({length:d},()=>random()-.5));
  const vectors=new Float32Array(n*d),truth=[],ids=[],texts=[];
  const words=['木工 刨子','周末 散步','截图 工作','轻音乐 午睡','配料 口感'];
  for(let i=0;i<n;i++){
    const c=i%k;truth.push(c);ids.push('m'+i);texts.push(words[c%words.length]+' 第'+i+'条');
    for(let q=0;q<d;q++)vectors[i*d+q]=centers[c][q]+(random()-.5)*1.4;
  }
  return {vectors,truth,ids,texts};
}

test('layout groups similar vectors, keeps near lists sorted and is deterministic',()=>{
  const {vectors,truth,ids,texts}=clustered(120,64,4);
  const a=buildLayout({ids,vectors:Float32Array.from(vectors),dimensions:64,texts,seed:3});
  const b=buildLayout({ids,vectors:Float32Array.from(vectors),dimensions:64,texts,seed:3});
  assert.deepEqual(Array.from(a.pos),Array.from(b.pos));
  assert.equal(a.pos.length,120*3);assert.equal(a.pos2.length,120*2);
  // Nearest neighbour in the 3D layout is from the same synthetic group.
  let same=0;
  for(let i=0;i<120;i++){
    let best=-1,bd=Infinity;
    for(let j=0;j<120;j++){if(j===i)continue;const d=(a.pos[i*3]-a.pos[j*3])**2+(a.pos[i*3+1]-a.pos[j*3+1])**2+(a.pos[i*3+2]-a.pos[j*3+2])**2;if(d<bd){bd=d;best=j;}}
    if(truth[best]===truth[i])same++;
  }
  assert.ok(same>=114,'local structure kept: '+same);
  for(const list of a.near){
    assert.ok(list.length<=8&&list.length>0);
    for(let k=1;k<list.length;k++)assert.ok(list[k-1][1]>=list[k][1]);
  }
  assert.ok(Math.max(...a.depth)===1&&Math.min(...a.depth)===0);
  assert.ok(a.keywords.some(words=>words.includes('木工')||words.includes('刨子')));
  assert.equal(a.incremental,false);
});

test('layout warm start keeps known items in place',()=>{
  const {vectors,ids,texts}=clustered(90,32,3);
  const first=buildLayout({ids,vectors:Float32Array.from(vectors),dimensions:32,texts,seed:5});
  const previous={raw3:new Map(ids.map((id,i)=>[id,Array.from(first.raw3.subarray(i*3,i*3+3))])),
    raw2:new Map(ids.map((id,i)=>[id,Array.from(first.raw2.subarray(i*2,i*2+2))]))};
  const second=buildLayout({ids,vectors:Float32Array.from(vectors),dimensions:32,texts,seed:5,previous});
  assert.equal(second.incremental,true);
  let moved=0;for(let i=0;i<first.pos.length;i++)moved+=Math.abs(second.pos[i]-first.pos[i]);
  assert.ok(moved/90<20,'average movement '+moved/90);
});

test('memory depth and keywords follow the documented rules',()=>{
  const depth=memoryDepth([[[1,.9],[2,.4]],[[0,.9]],[]],3);
  assert.equal(depth[2],0);assert.ok(depth[0]>0&&depth[1]>0);
  const words=clusterKeywords(['木工 课程 很好','木工 课程 开始','周末 散步'],Int32Array.from([0,0,1]),2);
  assert.ok(words[0].includes('木工'));
});

async function fixtureIndex(t){
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-map-index-'));
  const file=path.join(directory,'index.sqlite'),index=createVectorIndex({file});
  t.after(async()=>{index.close();await fs.rm(directory,{recursive:true,force:true});});
  const profile={id:'fictional-profile',revision:'r1',dimensions:4};
  const snapshot=index.checkpoint({scope,profile,modelKey:'fictional-model',indexIdentity:'identity-1',now:1,guard:allow});
  const chunk=(start,end,vector)=>({start,end,tokenBound:4,vector});
  // a: contextual and body variants of one span → body wins.
  index.put({scope,snapshotId:snapshot.id,dimensions:4,guard:allow,document:{id:'a',revision:1,domain:'raw',sourceIds:['a'],
    anchor:{id:'a',revision:1,ref:{storage:'legacy',id:'a',turnId:'turn-1',messageId:'m1',revision:'v1'}},chunks:[chunk(0,5,[0,1,0,0]),chunk(0,5,[1,0,0,0])]}});
  // b: two spans → averaged.
  index.put({scope,snapshotId:snapshot.id,dimensions:4,guard:allow,document:{id:'b',revision:1,domain:'raw',sourceIds:['b'],
    chunks:[chunk(0,5,[0,0,1,0]),chunk(5,9,[0,0,0,1])]}});
  index.put({scope,snapshotId:snapshot.id,dimensions:4,guard:allow,document:{id:'c',revision:1,domain:'raw',sourceIds:['c'],
    chunks:[chunk(0,3,[1,1,0,0])]}});
  // A persona note is not an original message and is never drawn.
  index.put({scope,snapshotId:snapshot.id,dimensions:4,guard:allow,document:{id:'p',revision:1,domain:'note',sourceIds:['p'],
    chunks:[chunk(0,3,[0,1,1,0])]}});
  const ready=index.finish({scope,snapshotId:snapshot.id,guard:allow});
  return {directory,file,snapshotId:ready.id};
}

test('layout vectors prefer the body-only variant and average spans',async t=>{
  const {file,snapshotId}=await fixtureIndex(t);
  const members=readLayoutMembers({file,scope,snapshotId});
  assert.deepEqual(members.members.map(m=>m.id),['a','b','c','p']);
  assert.deepEqual(members.members[0].ref,{storage:'legacy',id:'a',turnId:'turn-1',messageId:'m1',revision:'v1'});
  assert.equal(members.members[1].ref,null);
  assert.equal(members.indexIdentity,'identity-1');
  const {vectors,found}=readLayoutVectors({file,scope,snapshotId,ids:['b','a','missing']});
  assert.deepEqual(Array.from(found),[1,1,0]);
  assert.deepEqual(Array.from(vectors.subarray(0,4)),[0,0,.5,.5]);
  assert.deepEqual(Array.from(vectors.subarray(4,8)),[1,0,0,0]);
  assert.throws(()=>readLayoutMembers({file,scope:{...scope,project:'other'},snapshotId}),/快照无效/);
});

test('map service builds once in a worker, caches to disk and reuses the cache',async t=>{
  const {directory,file,snapshotId}=await fixtureIndex(t);
  const access={
    source:async()=>({state:'ready',layout:{indexFile:file,scope,snapshotId,profileId:'fictional-profile',modelKey:'fictional-model',dimensions:4,indexIdentity:'identity-1'}}),
    describe:async members=>{described=members;return members.map((m,i)=>({kind:i===0?'user':'assistant',time:1000+i,sessionId:i<2?'s1':'s2',text:'虚构原话 '+m.id}));},
  };
  let described=null;
  const service=createMemoryMapService({directory,access});
  const result=await service.data(allow,{wait:20000});
  assert.equal(result.state,'ready');
  const data=result.entry.data;
  assert.equal(data.format,'dsh-memory-map');assert.equal(data.version,1);
  assert.deepEqual(data.items.map(item=>item.id),['a','b','c']);
  // describe receives each member's storage locator, so legacy turns can be read back.
  assert.equal(described[0].ref.storage,'legacy');
  assert.equal((await service.ref('a')).turnId,'turn-1');assert.equal(await service.ref('p'),null);
  assert.equal(data.stats.sessions,2);assert.equal(data.items[0].session,0);assert.equal(data.items[2].session,1);
  assert.ok(data.items.every(item=>item.pos.length===3&&item.pos2.length===2&&item.depth>=0&&item.depth<=1));
  assert.ok(!JSON.stringify(data).includes('虚构原话'),'map data never carries message text');
  assert.ok(result.entry.gzip.length>0);
  const cached=JSON.parse(await fs.readFile(path.join(directory,'memory-map','map-v1.json'),'utf8'));
  assert.equal(cached.data.fingerprint,data.fingerprint);
  let ran=0;
  const again=createMemoryMapService({directory,access,runLayout:async()=>{ran++;throw Error('should not run');}});
  const reused=await again.data(allow,{wait:100});
  assert.equal(reused.state,'ready');assert.equal(ran,0);
  assert.equal(reused.entry.data.fingerprint,data.fingerprint);
});

test('map service reports a missing index without computing',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-map-empty-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const service=createMemoryMapService({directory,access:{source:async()=>({state:'no-index'}),describe:async()=>[]},runLayout:async()=>{throw Error('no');}});
  assert.deepEqual(await service.data(allow,{wait:0}),{state:'no-index'});
});

function call(handler,{method='GET',url,headers={},payload}={}){
  const req=Readable.from(payload===undefined?[]:[Buffer.from(JSON.stringify(payload))]);
  Object.assign(req,{method,url,socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:3080',...headers}});
  return new Promise((resolve,reject)=>{
    const res={headers:{},statusCode:200,setHeader(key,value){this.headers[key.toLowerCase()]=value;},
      end(value){this.raw=value;try{this.body=JSON.parse(String(value));}catch{this.body=null;}resolve(this);}};
    handler(req,res).catch(reject);
  });
}

test('map routes: static library is public, everything else needs a trusted request and the switch',async t=>{
  const viewsDirectory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-map-views-'));
  t.after(()=>fs.rm(viewsDirectory,{recursive:true,force:true}));
  await fs.writeFile(path.join(viewsDirectory,'timeline.html'),'<title>时间轴</title><meta name="description" content="虚构视图">');
  await fs.writeFile(path.join(viewsDirectory,'bad name.html'),'<title>x</title>');
  await fs.writeFile(path.join(viewsDirectory,'notes.txt'),'x');
  let enabled=true;
  const memoryMap={viewsDirectory,item:id=>({id,found:false}),search:async query=>({query,lanes:{},hits:[]})};
  const handler=createMemoryMapHandler({},{memoryMap,readEnabled:async()=>enabled,createService:()=>({data:async()=>({state:'no-index'}),status:()=>({building:false})})});
  const lib=await call(handler,{url:'/api/basic-memory-map/lib/three-r128.js',headers:{host:'evil.example'}});
  assert.equal(lib.statusCode,200);assert.match(lib.headers['content-type'],/javascript/);
  assert.equal((await call(handler,{url:'/api/basic-memory-map/lib/../shell.html'})).statusCode,404);
  assert.equal((await call(handler,{url:'/api/basic-memory-map/views',headers:{host:'evil.example'}})).statusCode,403);
  const shell=await call(handler,{url:'/api/basic-memory-map/'});
  assert.equal(shell.statusCode,200);assert.match(shell.headers['content-security-policy'],/frame-src 'self'/);
  assert.match(String(shell.raw),/sandbox="allow-scripts"/);
  const views=await call(handler,{url:'/api/basic-memory-map/views'});
  assert.deepEqual(views.body.views.map(v=>v.id),['starfield','plane','timeline']);
  assert.equal(views.body.views[2].name,'时间轴');assert.equal(views.body.views[2].builtin,false);
  const view=await call(handler,{url:'/api/basic-memory-map/views/timeline'});
  assert.match(view.body.html,/时间轴/);
  assert.equal((await call(handler,{url:'/api/basic-memory-map/views/..%2Fsecret'})).body.ok,false);
  const data=await call(handler,{url:'/api/basic-memory-map/data?wait=0'});
  assert.equal(data.body.state,'no-index');
  const search=await call(handler,{method:'POST',url:'/api/basic-memory-map/search',payload:{query:'木工'}});
  assert.equal(search.statusCode,403,'writes need the settings header');
  const searched=await call(handler,{method:'POST',url:'/api/basic-memory-map/search',payload:{query:'木工'},
    headers:{'content-type':'application/json','x-basic-memory-settings':'1'}});
  assert.equal(searched.body.query,'木工');
  enabled=false;
  const off=await call(handler,{url:'/api/basic-memory-map/views'});
  assert.equal(off.statusCode,404);assert.equal(off.body.state,'disabled');
  assert.equal((await call(handler,{url:'/api/basic-memory-map/'})).statusCode,200,'shell still explains how to switch it on');
});

test('built-in views declare a name and only load bundled libraries',async()=>{
  const views=await listViews(null);
  assert.deepEqual(views.map(v=>v.id),['starfield','plane']);
  for(const v of views)assert.ok(v.name&&v.description);
  const dir=path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')),'..','lib','memory-map','views');
  for(const name of await fs.readdir(dir)){
    const html=await fs.readFile(path.join(dir,name),'utf8');
    for(const src of html.matchAll(/<script[^>]+src="([^"]+)"/g))assert.match(src[1],/^\/api\/basic-memory-map\/lib\//);
    assert.ok(!/https?:\/\//.test(html.replace(/<!--[\s\S]*?-->/g,'')),name+' has no external URLs');
  }
});

test('deployment switch for the memory map defaults on and saves without restart',async t=>{
  const {stageDeploymentMemoryMap,readDeploymentMemoryMap,deploymentFingerprint}=await import('../lib/deployment-config.js');
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'memory-map-switch-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'deployment.json'),cfg={ownerDirectory:directory,memory:{rawRecall:true}};
  await fs.writeFile(file,JSON.stringify(cfg));
  assert.equal(await readDeploymentMemoryMap(file),true);
  const saved=await stageDeploymentMemoryMap(file,false,deploymentFingerprint(cfg));
  assert.equal(saved.enabled,false);assert.equal(await readDeploymentMemoryMap(file),false);
  const after=JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(after.memory.rawRecall,true);assert.equal(after.memory.memoryMap,false);
  await assert.rejects(stageDeploymentMemoryMap(file,true,'stale'),/其他操作/);
});

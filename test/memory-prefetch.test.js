import test from 'node:test';
import assert from 'node:assert/strict';
import {selectPrefetch,shouldPrefetch} from '../lib/memory-prefetch.js';

test('trivial prefetch input is limited to empty, pure social, and tokenless text',()=>{
  for(const text of ['', ' \n\t', '！？……', '😀😀', '好的', '好呀～', '嗯嗯吧', '哦！', '行啊',
    '可以', '谢谢啦', '谢了', '继续', '接着说', '哈哈哈哈哈！', '晚安', '早安呀', '在吗？',
    'OK', 'okay!', 'thanks', 'Thx', 'yes', 'no', '收到', '明白', '知道了', '对', '是的', '没事呀']){
    assert.deepEqual(shouldPrefetch(text),{ok:false,reason:'trivial'},text);
  }
});

test('uncertain or content-bearing short text still prefetches',()=>{
  for(const text of ['我上次说的那家店叫什么','阿岑','好的，那周末去哪吃','5号','继续说说我妈的事']) {
    assert.deepEqual(shouldPrefetch(text),{ok:true},text);
  }
});

const candidate=(id,text,signals={},patch={})=>({
  id,revision:1,text,label:'虚构记忆标签用于回放测试',signals:{lexical:0,similarity:null,rerank:null,lanes:['text'],...signals},...patch,
});

test('fallback admission uses lexical, vector, agreement and correction signals',()=>{
  const records=[
    candidate('lexical','门口蓝色雨伞挂在木质衣架',{lexical:.8}),
    candidate('vector','冰箱里有昨天买来的草莓酸奶',{similarity:.8,lanes:['vector']}),
    candidate('agree','地铁末班车时间改到晚上十一点',{lexical:.4,similarity:.5,lanes:['text','vector']}),
    candidate('correction','相册里保存着海边旅行的照片',{lexical:.35},{source:{changeKind:'correction'}}),
    candidate('historical','历史记录指出窗台摆着仙人掌',{lexical:1},{state:{validity:'historical'}}),
    candidate('disputed','争议记录提到桌面留有旧车票',{lexical:1},{state:{validity:'disputed'}}),
    candidate('weak','纸张边缘写着无关的铅笔编号',{lexical:.5,similarity:.5}),
    candidate('empty','', {lexical:1}),
  ];
  const {lines,stats}=selectPrefetch({records,minSimilarity:.45,options:{maxRecords:4}});
  assert.equal(lines.length,4,JSON.stringify(stats));assert.deepEqual(stats,{
    candidates:8,admitted:4,rejected:4,folded:0,injected:4,chars:stats.chars,
    lexical:1,vector:1,agree:1,correction:1,
  });
  assert.ok(stats.chars>0);
});

test('applied rerank gates on absolute scores and keeps the correction exception',()=>{
  const records=[
    candidate('high','重排高分的虚构长记录',{lexical:0,rerank:.9,lanes:['vector']}),
    candidate('low','重排低分的虚构长记录',{lexical:1,rerank:.2}),
    candidate('missing','没有进入重排结果的虚构记录',{lexical:1,rerank:null}),
    candidate('corrected','用户更正且重排稍低的长记录',{lexical:0,rerank:.3},{source:{changeKind:'correction'}}),
    candidate('historical','重排高分但已过时的长记录',{lexical:0,rerank:1},{state:{validity:'historical'}}),
  ];
  const {lines,stats}=selectPrefetch({records,minSimilarity:.45,options:{minRerank:.35,rerankApplied:true}});
  assert.equal(lines.length,2);assert.match(lines[0],/重排高分/u);assert.match(lines[1],/用户更正/u);
  assert.equal(stats.admitted,2);assert.equal(stats.rejected,3);assert.equal(stats.correction,1);
});

test('source-backed entries fold their originals while newer corrections survive',()=>{
  const records=[
    candidate('entry','当前条目确认用户喜欢靛蓝色的杯子并每天使用',{lexical:.8},{
      kind:'entry',state:{validity:'current'},source_refs:[{id:'old'},{id:'correction'}],time:2000,
    }),
    candidate('old','用户原话说明喜欢靛蓝色的杯子并每天使用',{lexical:.8},{kind:'original',role:'user',time:1000}),
    candidate('correction','用户更正为墨绿色的杯子且说明旧说法作废',{lexical:.8},{
      kind:'original',role:'user',time:3000,source:{changeKind:'correction'},
    }),
    candidate('legacy-note:same','当前条目确认用户喜欢靛蓝色的杯子并每天使用',{lexical:.8},{
      kind:'entry',state:{validity:'current'},time:1000,
    }),
  ];
  const {lines,stats}=selectPrefetch({records,minSimilarity:.45,options:{}});
  assert.equal(lines.length,2);assert.match(lines[0],/当前条目/u);assert.match(lines[1],/墨绿色/u);
  assert.equal(stats.admitted,4);assert.equal(stats.folded,2);
});

test('same-event text folds by Han bigram similarity and respects output limits',()=>{
  const records=[
    candidate('one','周末整理书架并且核对每一本书的编号',{lexical:.8}),
    candidate('two','周末整理书架，核对每一本书的编号。',{lexical:.8}),
    candidate('three','傍晚去河边散步然后买一杯热茶回家',{lexical:.8}),
    candidate('four','阿岑把旧照片放进蓝色盒子里保存',{lexical:.8}),
  ];
  const {lines,stats}=selectPrefetch({records,minSimilarity:.45,options:{maxRecords:2,maxChars:48}});
  assert.equal(stats.folded,1);assert.ok(lines.length<=2);assert.ok(stats.chars<=48);
  assert.match(lines[0],/周末整理书架/u);
});

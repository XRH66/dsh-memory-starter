import test from 'node:test';
import assert from 'node:assert/strict';
import {shouldPrefetch} from '../lib/memory-prefetch.js';

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

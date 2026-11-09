import test from 'node:test';
import assert from 'node:assert/strict';
import { lexicalMatch } from '../lib/raw-rag/lexical.js';

test('whole-sentence questions anchor on names the segmenter splits into single characters', () => {
  assert.ok(lexicalMatch('借了阿岑什么', '阿岑借我一把活动扳手') > 0);
  assert.ok(lexicalMatch('我姐考试什么时候', '我姐这阵在备考，下个月十五号考') > 0);
  assert.equal(lexicalMatch('借了阿岑什么', '小周送了我一盆绿萝'), 0);
});

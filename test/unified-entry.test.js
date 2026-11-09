import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/bundle-entry.js';

test('unified mode is explicitly unsupported', () => {
  assert.throws(() => apply({}, { mode: 'unified' }), /已不支持 unified 模式/);
});

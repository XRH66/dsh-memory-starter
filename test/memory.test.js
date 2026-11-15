import test from 'node:test';
import assert from 'node:assert/strict';
import { createSoftenTool } from '../lib/soften-tool.js';

const SESSION = 'session-memory-test';

test('native soften only accepts an exact original message ID', async () => {
  const calls = [], softened = [];
  const tool = createSoftenTool({
    softenRawMessage(id) {
      calls.push(id);
      return { ok: true, weight: 0.5 };
    },
    onSoftened: (...args) => softened.push(args),
  });
  const rejected = await tool.execute({ memoryId: 'retired-entry' }, { agent: { session: { id: SESSION } } });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.errorCode, 'INVALID_ARGUMENT');
  assert.deepEqual(calls, []);
  const result = await tool.execute({ rawMessageId: 'raw-one', reason: '少提' }, { agent: { session: { id: SESSION } } });
  assert.equal(result.ok, true);
  assert.equal(result.kind, 'raw');
  assert.deepEqual(calls, ['raw-one']);
  assert.deepEqual(softened, [[SESSION, result]]);
});

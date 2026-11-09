import test from 'node:test';
import assert from 'node:assert/strict';
import {createPureGate} from '../lib/pure-gate.js';
import {TARGET_SESSION} from './helpers.js';

test('history policy is normal without a pure provider, but strict when an installed one cannot prove the session', () => {
  const agent = {session:{id:TARGET_SESSION}};
  const absent = createPureGate({getService:() => undefined, logger:{warn(){}}}).historyPolicy(agent);
  assert.deepEqual([absent.installed, absent.userOnly, absent.reason], [false, false, 'not-installed']);

  const silent = createPureGate({getService:() => ({check:() => ({ready:true, active:false})}), logger:{warn(){}}})
    .historyPolicy(agent);
  assert.deepEqual([silent.installed, silent.supported, silent.userOnly, silent.reason], [true, false, true, 'unsupported']);

  const normal = createPureGate({getService:() => ({historyPolicy:() => ({userOnly:false})}), logger:{warn(){}}})
    .historyPolicy(agent);
  assert.deepEqual([normal.installed, normal.userOnly, normal.reason], [true, false, 'normal']);

  const strict = createPureGate({getService:() => ({historyPolicy:() => ({userOnly:true})}), logger:{warn(){}}})
    .historyPolicy(agent);
  assert.deepEqual([strict.installed, strict.userOnly, strict.reason], [true, true, 'user-only']);

  const failed = createPureGate({getService:() => ({historyPolicy:() => {throw Error('policy exploded');}}), logger:{warn(){}}})
    .historyPolicy(agent);
  assert.deepEqual([failed.installed, failed.userOnly, failed.reason], [true, true, 'policy-failed']);
  assert.match(failed.error.message, /policy exploded/);

  const invalid = createPureGate({getService:() => ({historyPolicy:() => ({})}), logger:{warn(){}}})
    .historyPolicy(agent);
  assert.deepEqual([invalid.userOnly, invalid.reason], [true, 'invalid-policy']);

  const unreadable = createPureGate({getService:() => {throw Error('provider exploded');}, logger:{warn(){}}})
    .historyPolicy(agent);
  assert.deepEqual([unreadable.userOnly, unreadable.reason], [true, 'service-unreadable']);

  const unresolved = createPureGate({getService:() => ({historyPolicy:() => ({userOnly:false})}), logger:{warn(){}}})
    .historyPolicy(undefined);
  assert.deepEqual([unresolved.userOnly, unresolved.reason], [true, 'unresolved-agent']);
});

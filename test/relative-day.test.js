import test from 'node:test';
import assert from 'node:assert/strict';
import {relativeDay,localTimeWithDay,currentLocalTime} from '../lib/local-time.js';
import {setPersonalTimeZone} from '../lib/personal-namespace.js';

const at=iso=>Date.parse(iso);

test('relative day follows the personal calendar, not elapsed hours or the host zone',t=>{
  setPersonalTimeZone('Asia/Shanghai');t.after(()=>setPersonalTimeZone(undefined));
  const now=at('2026-04-01T00:30:00+08:00');
  assert.equal(relativeDay(at('2026-03-31T23:50:00+08:00'),now),'昨天');
  assert.equal(relativeDay(at('2026-04-01T00:05:00+08:00'),now),'今天');
  assert.equal(relativeDay(at('2026-03-30T18:24:00+08:00'),now),'前天');
  assert.equal(relativeDay(at('2026-03-25T12:00:00+08:00'),now),'7 天前');
  assert.equal(relativeDay(at('2026-04-02T09:00:00+08:00'),now),'明天');
  assert.equal(relativeDay(at('2026-04-10T09:00:00+08:00'),now),'9 天后');
  assert.equal(relativeDay(at('2026-01-01T09:00:00+08:00'),now),null);
  assert.equal(relativeDay(Number.NaN,now),null);
});

test('another personal zone moves the day boundary',t=>{
  setPersonalTimeZone('America/Los_Angeles');t.after(()=>setPersonalTimeZone(undefined));
  // 2026-04-01 00:30 +08:00 is still 2026-03-31 in Los Angeles.
  const now=at('2026-04-01T00:30:00+08:00');
  assert.equal(relativeDay(at('2026-03-31T23:50:00+08:00'),now),'今天');
});

test('labels and current time are formatted for the model',t=>{
  setPersonalTimeZone('Asia/Shanghai');t.after(()=>setPersonalTimeZone(undefined));
  const now=at('2026-04-01T21:38:29+08:00');
  assert.equal(localTimeWithDay(at('2026-03-31T18:24:00+08:00'),now),'2026-03-31 18:24 +08:00（昨天）');
  assert.equal(localTimeWithDay(at('2025-03-31T18:24:00+08:00'),now),'2025-03-31 18:24 +08:00');
  assert.equal(currentLocalTime(now),'2026-04-01 21:38 +08:00 星期三');
});

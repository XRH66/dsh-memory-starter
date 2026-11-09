import test from 'node:test';
import assert from 'node:assert/strict';
import {selectHandoff} from '../lib/handoff.js';
import {personalTimeZone,setPersonalTimeZone} from '../lib/personal-namespace.js';

test('handoff labels its guidance and message times as local wall time',t=>{
  const original=personalTimeZone();t.after(()=>setPersonalTimeZone(original));setPersonalTimeZone('Asia/Shanghai');
  const time=Date.UTC(2026,2,22,6,5);
  const sources=[{id:'dsh:qa:message-local-time',revision:1,position:1,sequence:1,sessionId:'session-source',turn:1,
    role:'user',text:'本地时间测试',time,turnState:'completed'}];
  const reader={list({beforePosition=Infinity,limit}){
    const page=sources.filter(source=>source.position<beforePosition).reverse().slice(0,limit);
    return {sources:page,nextBefore:null};
  }};
  const result=selectHandoff(reader,{tokens:4096});
  const [opening,guidance]=result.text.split('\n');

  assert.equal(opening,'<memory_handoff>');
  assert.match(guidance,/时间均为本地时间/);
  assert.match(guidance,/计划、打算不等于已经发生/);

  // Shown in the personal time zone (Asia/Shanghai), whatever the host's zone is.
  const expected=new Date(time+8*3600_000).toISOString().replace('T',' ').slice(0,16)+' +08:00';
  assert.match(result.text,/消息时间=\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}/);
  assert.ok(result.text.includes(`消息时间=${expected}`));
});

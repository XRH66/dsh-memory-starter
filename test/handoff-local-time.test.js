import test from 'node:test';
import assert from 'node:assert/strict';
import {selectHandoff} from '../lib/handoff.js';

test('handoff labels its guidance and message times as local wall time',()=>{
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

  const date=new Date(time),pad=value=>String(value).padStart(2,'0'),offset=-date.getTimezoneOffset();
  const sign=offset<0?'-':'+',abs=Math.abs(offset);
  const expected=`${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
  assert.match(result.text,/消息时间=\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}/);
  assert.ok(result.text.includes(`消息时间=${expected}`));
});

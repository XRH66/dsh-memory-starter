import {personalTimeZone} from './personal-namespace.js';

// Records carry epoch-ms times; models had to run code to read them. Show the wall time in the
// personal memory time zone (the same zone the rest of the library uses), never the host's:
// a host set to another zone shifted every displayed date by a day.
const formatters=new Map();
function formatter(timeZone){
  let value=formatters.get(timeZone);
  if(!value){
    value=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});
    formatters.set(timeZone,value);
  }
  return value;
}
export function localTimeParts(ms){
  const date=ms instanceof Date?ms:new Date(ms??Date.now());
  const value=Object.fromEntries(formatter(personalTimeZone()).formatToParts(date).map(part=>[part.type,part.value]));
  const offset=(value.timeZoneName||'GMT').replace(/^GMT/,'')||'+00:00';
  return {
    date:`${value.year}-${value.month}-${value.day}`,
    time:`${value.hour}:${value.minute}`,
    stamp:`${value.year}${value.month}${value.day}${value.hour}${value.minute}${value.second}`,
    clockStamp:`${value.hour}${value.minute}${value.second}`,
    offset,
    iso:date.toISOString(),
  };
}
export function localTime(ms){
  if(!Number.isFinite(ms))return undefined;
  const parts=localTimeParts(ms);
  return `${parts.date} ${parts.time} ${parts.offset}`;
}

const WEEKDAYS=['星期日','星期一','星期二','星期三','星期四','星期五','星期六'];
// Calendar day number of an instant in the personal time zone.
function dayNumber(ms){
  const [y,m,d]=localTime(ms).slice(0,10).split('-').map(Number);
  return Date.UTC(y,m-1,d)/86400000;
}
/** Relative calendar day of `ms` seen from `now`, in the personal time zone. Models
 * miscounted "yesterday" from raw timestamps; the program states it instead. */
export function relativeDay(ms,now=Date.now()){
  if(!Number.isFinite(ms)||!Number.isFinite(now))return null;
  const days=dayNumber(now)-dayNumber(ms);
  if(days===0)return '今天';
  if(days===1)return '昨天';
  if(days===2)return '前天';
  if(days===-1)return '明天';
  if(days===-2)return '后天';
  if(days>2&&days<=30)return `${days} 天前`;
  if(days<-2&&days>=-30)return `${-days} 天后`;
  return null;
}
/** Wall time with its relative day, e.g. "2026-03-30 18:24 +08:00（昨天）". */
export function localTimeWithDay(ms,now=Date.now()){
  const when=localTime(ms);if(!when)return undefined;
  const day=relativeDay(ms,now);
  return day?`${when}（${day}）`:when;
}
/** Current local time and weekday, stated so the model never rounds or guesses it. */
export function currentLocalTime(now=Date.now()){
  const when=localTime(now);if(!when)return undefined;
  const [y,m,d]=when.slice(0,10).split('-').map(Number);
  return `${when} ${WEEKDAYS[new Date(Date.UTC(y,m-1,d)).getUTCDay()]}`;
}

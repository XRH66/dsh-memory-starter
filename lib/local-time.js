import {personalTimeZone} from './personal-namespace.js';

// Records carry epoch-ms times; models had to run code to read them. Show the wall time in the
// personal memory time zone (the same zone the rest of the library uses), never the host's:
// a host set to another zone shifted every displayed date by a day.
const formatters=new Map();
function formatter(timeZone){
  let value=formatters.get(timeZone);
  if(!value){
    value=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',
      hour:'2-digit',minute:'2-digit',hourCycle:'h23',timeZoneName:'longOffset'});
    formatters.set(timeZone,value);
  }
  return value;
}
export function localTime(ms){
  if(!Number.isFinite(ms))return undefined;
  const value=Object.fromEntries(formatter(personalTimeZone()).formatToParts(new Date(ms)).map(part=>[part.type,part.value]));
  const offset=(value.timeZoneName||'GMT').replace(/^GMT/,'')||'+00:00';
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute} ${offset}`;
}

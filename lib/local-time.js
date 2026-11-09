// Records carry epoch-ms times; models had to run code to read them. Add the host-local wall time.
export function localTime(ms){
  if(!Number.isFinite(ms))return undefined;
  const date=new Date(ms),pad=n=>String(n).padStart(2,'0'),offset=-date.getTimezoneOffset(),sign=offset<0?'-':'+',abs=Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())} ${sign}${pad(Math.floor(abs/60))}:${pad(abs%60)}`;
}


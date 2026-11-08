/** Independent foreground branches share one absolute deadline. Vector lanes
 * own their encode -> index dependency; text/structured lanes never await it. */
export async function runMemoryQueryLanes({lanes,deadline,signal,now=Date.now,reserveMs=50}){
  if(!lanes||!Number.isFinite(deadline))throw Error('Query lanes and a shared deadline required');
  signal?.throwIfAborted();
  const names=Object.keys(lanes),results={},channels={},controllers=new Map(),starts=new Map();
  const reserve=Math.min(Math.max(0,reserveMs),Math.max(0,deadline-now())/4);
  const cutoff=deadline-reserve,remaining=()=>Math.max(0,cutoff-now());
  if(!remaining())return {results,channels:Object.fromEntries(names.map(name=>[name,{state:'timeout',elapsedMs:0}])),degraded:true};
  let settled=0,finished=false,finish;
  const allDone=new Promise(resolve=>{finish=resolve;});
  if(!names.length)finish();
  for(const name of names){
    const controller=new AbortController(),started=now();controllers.set(name,controller);
    starts.set(name,started);
    const childSignal=AbortSignal.any([signal,controller.signal].filter(Boolean));
    channels[name]={state:'running',elapsedMs:0};
    Promise.resolve().then(()=>{
      childSignal.throwIfAborted();
      if(!remaining())return;
      return lanes[name]({signal:childSignal,deadline:cutoff,getRemainingMs:remaining});
    }).then(value=>{
      if(finished||!remaining())return;
      if(!value||!Array.isArray(value.records))throw Error('Invalid channel result');
      const state=value.state==='unavailable'?'unavailable':value.degraded?'partial':value.records.length?'ready':'empty';
      channels[name]={state,elapsedMs:Math.max(0,now()-started),records:value.records.length};results[name]=value;
    }).catch(()=>{
      if(!finished&&remaining())channels[name]={state:childSignal.aborted?'cancelled':'failed',elapsedMs:Math.max(0,now()-started)};
    }).finally(()=>{settled++;if(settled===names.length)finish();});
  }
  let timer,onAbort;
  try{
    const stop=new Promise((resolve,reject)=>{
      timer=setTimeout(resolve,remaining());
      if(signal){onAbort=()=>reject(signal.reason??Error('Query cancelled'));signal.addEventListener('abort',onAbort,{once:true});if(signal.aborted)onAbort();}
    });
    await Promise.race([allDone,stop]);signal?.throwIfAborted();
  }finally{
    clearTimeout(timer);signal?.removeEventListener('abort',onAbort);finished=true;
    for(const name of names)if(channels[name].state==='running'){
      channels[name]={state:signal?.aborted?'cancelled':'timeout',elapsedMs:Math.max(0,now()-starts.get(name))};
      controllers.get(name).abort(Error('Shared query deadline reached'));
    }
  }
  return {results,channels,degraded:Object.values(channels).some(channel=>!['ready','empty'].includes(channel.state))};
}

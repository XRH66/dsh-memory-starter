import {setImmediate as nextTick} from 'node:timers/promises';

const key=(sessionId,turn)=>JSON.stringify([sessionId,turn]);
const publicSource=source=>{if(!source)return source;const {authorization,...value}=source;return value;};

/** One native-event producer. Original commits do not wait for a model, vector
 * queue or filesystem cache. Those consume the committed source independently. */
export function createMessageRecorder({access,raw,recent,recentMode='cache',refreshRecentStats,report=()=>{},logger=console,processingContextFor}){
  const turns=new Map(),listeners=new Set(),resumedRoots=new Map();let projections=Promise.resolve(),pending=0,closed=false,lastError=null,recovery={state:'idle',held:0,restored:0};
  const consumers=recentMode==='originals'?['raw-text-v1']:['raw-text-v1','recent-v1'];
  let recentTask;
  const valid=grant=>!closed&&access.validateMessage(grant);
  function status(sessionId,turn,patch){try{Promise.resolve(report(sessionId,turn,{sourceRecording:patch})).catch(()=>{});}catch{}}
  function notify(notice){if(notice)for(const listener of listeners)try{Promise.resolve(listener(notice)).catch(error=>logger.warn?.('[message-source] consumer: '+error.message));}catch(error){logger.warn?.('[message-source] consumer: '+error.message);}}
  function queue(work){
    pending++;
    projections=projections.then(async()=>{await nextTick();if(!closed)await work();}).catch(error=>{
      lastError=error.message;logger.warn?.('[message-source] projection: '+error.message);
    }).finally(()=>{pending--;});
    return projections;
  }
  async function projectOne(source,grant,consumer){
    if(!valid(grant))return false;
    const authorize=()=>valid(grant);
    try{
      const current=raw.messageReader(source,{authorize}).get(source);
      if(!current?.isCurrent||current.position!==source.position)return false;
      let result;
      if(consumer==='raw-text-v1'){
        result=raw.projectMessage({...source,signal:grant.signal},{authorize});
        if(result.skipped==='source-changed')return false;
      }else result=await recent.recordSource({source,signal:grant.signal,authorize});
      if(!raw.messageProjectionReceipt({...source,consumer},{authorize}))return false;
      status(source.sessionId,source.turn,{state:'saved',revision:source.revision,role:source.role,
        [consumer==='raw-text-v1'?'textProjection':'recentProjection']:result.skipped??(result.enabled===false?'disabled':'ready')});
      return true;
    }catch(error){
      lastError=error.message;
      if(valid(grant))raw.messageProjectionReceipt({...source,consumer,error:error.message},{authorize});
      logger.warn?.('[message-source] projection: '+error.message);
      status(source.sessionId,source.turn,{state:'saved',projection:'held',consumer,error:error.message});
      return false;
    }
  }
  function project(source,grant){
    queue(()=>Promise.all(consumers.map(consumer=>projectOne(source,grant,consumer))));
  }
  function resume({sessionId}={}){
    return queue(async()=>{
      recovery={state:'running',held:0,restored:0};
      for(const consumer of consumers){
        let after=0;
        while(!closed){
          const refs=raw.messageProjectionWork({consumer,sessionId,after,limit:24},{authorize:()=>!closed&&access.ready});
          if(!refs.length)break;
          for(const ref of refs){
            after=ref.position;
            const grant=ref.authorization;
            if(!valid(grant)){recovery.held++;continue;}
            const source=raw.messageReader(ref,{authorize:()=>valid(grant)}).get(ref);
            if(source&&await projectOne(source,grant,consumer))recovery.restored++;
          }
          await nextTick();
        }
      }
      recovery.state=recovery.held?'held':'idle';
    });
  }
  function observe(session,event,changeKind){
    if(closed||!session?.id||!event?.type)return;
    if(event.type==='turn/start'){
      if(!access.observe(session,event))return;
      for(const [id,item] of turns)if(item.sessionId===session.id&&item.turn!==event.data?.turn)turns.delete(id);
      const state=access.status(session.id);
      if(state.requested&&resumedRoots.get(session.id)!==state.epoch){resumedRoots.set(session.id,state.epoch);resume({sessionId:session.id});}
      return;
    }
    if(event.type==='user/message'||event.type==='assistant/message'){
      try{
        const admitted=access.admitMessage(session,event);if(!admitted)return;
        const {source,grant}=admitted;
        if(processingContextFor)source.processingContext=processingContextFor(source);
        const receipt=raw.recordMessage(source,{authorize:()=>valid(grant)});
        if(!receipt.source||receipt.skipped)return;
        const id=key(session.id,source.turn),item=turns.get(id)??{sessionId:session.id,turn:source.turn};
        item.grant=grant;item.ownerSubject=source.ownerSubject;item.project=source.project;turns.set(id,item);
        notify(receipt.notice);project(receipt.source,grant);
        status(session.id,source.turn,{state:'saved',id:receipt.source.id,revision:receipt.source.revision,role:source.role,pendingProjections:pending});
      }catch(error){lastError=error.message;logger.warn?.('[message-source] save: '+error.message);status(session.id,event.data?.turn,{state:'error',error:error.message});}
      return;
    }
    if(event.type!=='turn/end'||!access.observe(session,event))return;
    const id=key(session.id,event.data?.turn),item=turns.get(id);turns.delete(id);
    if(!item||!valid(item.grant))return;
    try{
      const scope={ownerSubject:item.ownerSubject,project:item.project},authorize=()=>valid(item.grant);
      const notices=raw.completeMessageTurn({...scope,sessionId:session.id,turn:item.turn,state:event.data.reason?.kind==='completed'?'completed':'interrupted',changeKind},{authorize});
      const reader=raw.messageReader(scope,{authorize});
      for(const notice of notices){notify(notice);const source=reader.get({id:notice.id,revision:notice.revision});if(source)project(source,item.grant);}
    }catch(error){lastError=error.message;logger.warn?.('[message-source] completion: '+error.message);}
  }
  async function idle(){await Promise.all([projections,recentTask]);}
  resume();
  return {observe,resume,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    forAgent(agent,{trackRecent=false}={}){
      const grant=access.grant(agent),authorize=()=>!closed&&access.validate(grant);
      const reader=raw.messageReader({ownerSubject:grant.ownerSubject,project:grant.project},{authorize});
      let sampleFirstPage=trackRecent&&recentMode==='originals'&&Boolean(refreshRecentStats);
      return {get:ref=>publicSource(reader.get(ref)),list:options=>{
        const page=reader.list(options),sources=page.sources.map(publicSource);
        if(sampleFirstPage&&options?.beforePosition===undefined){
          sampleFirstPage=false;
          const warn=error=>logger.warn?.('[message-source] recent stats: '+error.message);
          try{recentTask=refreshRecentStats(sources,{authorize}).catch(warn);}catch(error){warn(error);}
        }
        return {...page,sources};
      },changes:options=>reader.changes(options)};
    },
    status:()=>({pendingProjections:pending,lastError,recovery:{...recovery}}),
    idle,
    async close(){await idle();closed=true;listeners.clear();turns.clear();resumedRoots.clear();},
  };
}

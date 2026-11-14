import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createUnifiedStateStore} from './storage/state-store.js';
import {managementDirectory} from './review.js';
import {estimateRecentTokens} from './recent-context.js';
import {normalizeHandoffTokens,MEMORY_HANDOFF_SOURCE} from './memory-contract.js';
import {localTimeWithDay} from './local-time.js';
import {ANSWER_RULES} from './memory-query.js';

const same=(a,b)=>a&&b&&['sessionId','provider','model','connection'].every(key=>(a[key]??null)===(b[key]??null));
const route=input=>{
  if(!input?.sessionId||!input.provider||!input.model)throw Error('Trusted request route required');
  return {sessionId:input.sessionId,provider:input.provider,model:input.model,connection:input.connection??null,coverage:input.coverage??'provider-model-only',platform:''};
};
const check=authorize=>{if(typeof authorize!=='function'||authorize()!==true)throw Object.assign(Error('Handoff authorization changed'),{code:'MEMORY_NOT_AUTHORIZED'});};

/** Metadata only. No conversation bodies, vectors or model calls live here. */
export function createHandoffController({config}){
  const file=path.join(managementDirectory(config),'session-handoff','state.json');
  const store=createUnifiedStateStore({file,initial:()=>({project:config.project,lastTarget:null,sessions:{}}),validate:state=>{
    if(state.project!==config.project||!state.sessions||typeof state.sessions!=='object')throw Error('Invalid handoff state');
  }});
  let observed=null;
  return {file,
    observeTarget(input){observed=route(input);},
    async begin(input,{authorize}){
      if(!Number.isSafeInteger(input.turn)||input.turn<1)throw Error('Trusted turn required');
      const target=route(input);check(authorize);
      const previousObserved=observed;observed=target;
      const result=await store.update(state=>{
        check(authorize);
        const entry=state.sessions[target.sessionId]??={generation:0,completedGeneration:0,attempt:null};
        const previous=entry.attempt;
        if(previous?.turn===input.turn&&same(previous.target,target))return {...previous,reused:true,lastDelivered:entry.lastDelivered??null};
        const baselines=[previousObserved,state.lastTarget].filter(Boolean),reasons=[];
        if(!baselines.length)reasons.push('first-use');
        else if(baselines.some(last=>last.sessionId!==target.sessionId))reasons.push('conversation-changed');
        if(baselines.some(last=>['provider','model','connection'].some(key=>(last[key]??null)!==(target[key]??null))))reasons.push('connection-changed');
        if(previous&&!previous.completed||entry.failedTurn)reasons.push('previous-incomplete');
        if(reasons.length)entry.generation++;
        const required=entry.generation>entry.completedGeneration;
        entry.attempt={id:randomUUID(),turn:input.turn,target,generation:entry.generation,
          reasons:reasons.length?reasons:required?previous?.reasons??['pending-handoff']:[],required,ready:false,delivered:false,completed:false};
        state.lastTarget=target;
        return {...entry.attempt,reused:false,lastDelivered:entry.lastDelivered??null};
      });
      check(authorize);return result.result;
    },
    async prepared(attempt,receipt,{authorize}){
      check(authorize);
      await store.update(state=>{
        check(authorize);const current=state.sessions[attempt.target.sessionId]?.attempt;
        if(current?.id!==attempt.id)return;
        current.ready=true;current.receipt={messageId:receipt.messageId??null,newest:receipt.newest??null,tokens:receipt.tokens??0,items:receipt.items??0,counting:receipt.counting??'estimated'};
      });
    },
    async finish({sessionId,turn,completed,delivered=false},{authorize}){
      check(authorize);
      await store.update(state=>{
        check(authorize);const entry=state.sessions[sessionId],current=entry?.attempt;
        if(current?.turn!==turn)return;
        current.completed=completed===true;
        current.delivered=delivered===true;
        if(completed)delete entry.failedTurn;
        if(completed&&current.ready&&current.delivered&&current.receipt?.messageId){
          entry.lastDelivered={messageId:current.receipt.messageId,newest:current.receipt.newest??null};
        }
        if(completed&&(!current.required||current.ready&&current.delivered))entry.completedGeneration=Math.max(entry.completedGeneration,current.generation);
      });
    },
    async failed({sessionId,turn},{authorize}){
      check(authorize);
      await store.update(state=>{
        check(authorize);const entry=state.sessions[sessionId]??={generation:0,completedGeneration:0,attempt:null};
        if((entry.attempt?.turn??0)>turn)return;
        entry.failedTurn=turn;
      });
    },
    status:()=>store.read(),idle:()=>store.idle(),
  };
}

const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
const header='<memory_handoff>\n以下是已保存的近期对话原文，用于接续。保留角色、假设和条件；助手的话不等于用户事实。\n';
const footer='\n使用以上材料时：\n'+ANSWER_RULES.map(rule=>'- '+rule+'。').join('\n')+
  '\n\n计量：估算 tokens；来源编号和版本可定位原文。\n</memory_handoff>';
function block(source,text,truncated){
  return `\n[${source.role==='user'?'用户':'助手'} | ${source.id} | revision=${source.revision} | ${source.time==null?'记录时间':'消息时间'}=${localTimeWithDay(source.time??source.recordedAt)} | ${source.turnState}]\n${escape(text)}${truncated?'\n[节选；完整原文仍保留]':''}\n`;
}

/** Latest originals first for selection, original order for display. Never asks
 * an LLM whether to save or summarize; originals themselves remain untouched. */
export function selectHandoff(reader,{tokens=4096,sessionId,turn,count=estimateRecentTokens}={}){
  tokens=normalizeHandoffTokens(tokens);
  const chosen=[];let body='',beforePosition,full=false,newest=null;
  while(!full){
    const page=reader.list({limit:24,...beforePosition?{beforePosition}:{}});
    for(const source of page.sources){
      if(source.sessionId===sessionId||!source.text)continue;
      newest??={id:source.id,revision:source.revision};
      let text=source.text,line=block(source,text,false),truncated=false;
      if(count(header+line+body+footer)>tokens){
        let low=0,high=text.length;
        while(low<high){const mid=Math.ceil((low+high)/2),tail=text.slice(-mid).replace(/^[\uDC00-\uDFFF]/u,'');
          if(count(header+block(source,tail,true)+body+footer)<=tokens)low=mid;else high=mid-1;}
        text=text.slice(-low).replace(/^[\uDC00-\uDFFF]/u,'');truncated=true;line=block(source,text,true);full=true;
        if(!low||count(header+line+body+footer)>tokens)break;
      }
      body=line+body;chosen.unshift({id:source.id,revision:source.revision,role:source.role,sequence:source.sequence,sessionId:source.sessionId,truncated});
      if(full)break;
    }
    if(!page.nextBefore||page.nextBefore===beforePosition)break;
    beforePosition=page.nextBefore;
  }
  const text=chosen.length?header+body+footer:'';
  return {text,items:chosen,newest,tokens:count(text),budgetTokens:tokens,counting:'estimated',source:MEMORY_HANDOFF_SOURCE};
}

/** Pure-mode persona gate shared by the renderer and the assemble hook. */
export const PERSONA_SECTIONS=['deployment:dafeiyu-persona','memory:selected-persona'];
const isPersonaSection=section=>PERSONA_SECTIONS.includes(section?.name);

/**
 * Resolve pure mode from the host-side `pureMode` service. The agent argument
 * is always a host-owned object; no model-supplied text can choose the mode.
 * Only a missing provider means "plugin not loaded" and normal behaviour. An
 * installed but not ready service, an unresolved agent, or a throwing service
 * is unknown and suppresses persona injection instead of reading files.
 */
export function createPureGate({getService,logger}={}){
  let warned='',warnedHistory='';
  const warn=(reason,error)=>{const text=reason+(error?.message?': '+error.message:'');if(warned===text)return;warned=text;logger?.warn?.('[basic-memory-bridge] 纯净模式状态不可用，人设注入已暂停（'+text+'）');};
  const warnHistory=(reason,error)=>{const text=reason+(error?.message?': '+error.message:'');if(warnedHistory===text)return;warnedHistory=text;logger?.warn?.('[basic-memory-bridge] 纯净模式历史策略不可用，后台输入已收紧为仅当前用户（'+text+'）');};
  return {
    check(agent){
      let held;
      try{held=getService?.()??null;}catch(error){warn('读取纯净模式服务失败',error);return {installed:true,ready:false,active:null,suppressed:true,reason:'service-unreadable',error};}
      if(!held)return {installed:false,ready:false,active:null,suppressed:false,reason:'not-installed'};
      if(!agent){warn('已安装纯净模式但没有可信的宿主 agent');return {installed:true,ready:false,active:null,suppressed:true,reason:'unresolved-agent'};}
      let state;
      try{state=held.check?.(agent);}catch(error){warn('查询纯净模式状态失败',error);return {installed:true,ready:false,active:null,suppressed:true,reason:'service-failed',error};}
      if(!state?.ready){
        if(!held.check)warn('纯净模式服务缺少状态接口');
        else if(!warned.startsWith('纯净模式服务尚未就绪'))warn('纯净模式服务尚未就绪');
        return {installed:true,ready:false,active:null,suppressed:true,reason:'not-ready'};
      }
      warned='';
      const active=Boolean(state.active);
      return {installed:true,ready:true,active,suppressed:active,reason:active?'pure':'normal'};
    },
    /**
     * Resolve the host-owned history policy for one agent. `userOnly:true` means
     * this same session has used pure mode at some point (including before a
     * restart), so background memory may only consume the current direct user
     * message. An installed service that lacks historyPolicy is a mixed-version
     * deployment that cannot prove the session never used pure mode, so it also
     * fails strict. Only a completely absent pure plugin keeps the old flow. An
     * installed service that exposes historyPolicy but throws or returns an
     * invalid value fails strict as well.
     */
    historyPolicy(agent){
      let held;
      try{held=getService?.()??null;}catch(error){warnHistory('读取纯净模式服务失败',error);return {installed:true,ready:false,supported:true,userOnly:true,reason:'service-unreadable',error};}
      if(!held)return {installed:false,ready:false,supported:false,userOnly:false,reason:'not-installed'};
      if(typeof held.historyPolicy!=='function'){warnHistory('纯净模式服务未提供 historyPolicy');return {installed:true,ready:false,supported:false,userOnly:true,reason:'unsupported'};}
      if(!agent){warnHistory('已安装纯净模式但没有可信的宿主 agent');return {installed:true,ready:false,supported:true,userOnly:true,reason:'unresolved-agent'};}
      let value;
      try{value=held.historyPolicy(agent);}catch(error){warnHistory('查询历史策略失败',error);return {installed:true,ready:false,supported:true,userOnly:true,reason:'policy-failed',error};}
      if(!value||typeof value.userOnly!=='boolean'){warnHistory('历史策略不完整');return {installed:true,ready:false,supported:true,userOnly:true,reason:'invalid-policy'};}
      warnedHistory='';
      return {installed:true,ready:true,supported:true,userOnly:value.userOnly,reason:value.userOnly?'user-only':'normal'};
    },
    /** Remove both persona sections; used only when pure mode suppresses them. */
    strip(assembly){return {...assembly,sections:assembly.sections.filter(section=>!isPersonaSection(section))};},
  };
}

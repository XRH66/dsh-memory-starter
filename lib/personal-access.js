import {createPureGate} from './pure-gate.js';

/**
 * Decide whether the personal memory backend may be touched for one turn.
 * The portable runtime reads and writes the Vault directly, so the host's
 * ctx.tools restriction proves nothing here; this gate is the one place the
 * core asks the host-owned pure-mode state instead of guessing from text.
 * Fail closed: an installed pure-mode plugin that cannot resolve the agent or
 * is not ready yet is treated as "do not touch personal memory", unlike a
 * plugin that is simply absent.
 */
export function createPersonalAccess({getService,logger}={}){
  const gate=createPureGate({getService,logger});
  return {
    check(agent){
      const state=gate.check(agent);
      if(state.installed===false)return {allowed:true,installed:false,active:null,reason:'not-installed'};
      if(!state.ready)return {allowed:false,installed:true,active:null,reason:state.reason};
      if(state.active===true)return {allowed:false,installed:true,active:true,reason:'pure-active'};
      if(state.active===false)return {allowed:true,installed:true,active:false,reason:'normal'};
      return {allowed:false,installed:true,active:null,reason:state.reason||'unknown-mode'};
    },
    /** Host-owned per-session history policy; only meaningful after check allows. */
    historyPolicy(agent){return gate.historyPolicy(agent);},
  };
}

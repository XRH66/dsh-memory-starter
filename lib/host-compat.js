const looksLikeChild = agent => {
  const header = agent?.session?.header;
  // parentSession is durable fork lineage; only origin marks a runtime subagent.
  return header?.origin === 'subagent';
};

const isLiveAgent = (agents, agent) => {
  const id = agent?.session?.id;
  return typeof id === 'string' && typeof agents?.get === 'function' && agents.get(id) === agent;
};

/** Normalize runtime agent ownership across DSH host API revisions. */
export function createHostCompatibility({agents,logger}={}){
  const capturedOwners=new WeakMap(),hasNativeOwnership=typeof agents?.isOwnedBy==='function';
  let warnedUnknown=false;

  function warnUnknown(){
    if(warnedUnknown)return;
    warnedUnknown=true;
    logger?.warn?.('[host-compat] 无法确认子代理的运行时归属，按独立会话处理且不继承记忆；后续不再重复提示');
  }

  function observeAgentCreated(payload){
    if(hasNativeOwnership)return false;
    const agent=payload?.agent;
    if(!isLiveAgent(agents,agent)||typeof agents?.currentInitiator!=='function')return false;
    let owner;
    try{owner=agents.currentInitiator();}catch{return false;}
    if(!owner||owner===agent||!isLiveAgent(agents,owner))return false;
    capturedOwners.set(agent,owner);
    return true;
  }

  function ownersOf(agent,liveAgents=agents?.list?.()??[]){
    if(!isLiveAgent(agents,agent))return [];
    if(hasNativeOwnership){
      const parents=liveAgents.filter(other=>other!==agent&&agents.isOwnedBy(agent.session.id,other));
      if(!parents.length&&looksLikeChild(agent))warnUnknown();
      return parents;
    }
    const owner=capturedOwners.get(agent);
    if(owner&&owner!==agent&&isLiveAgent(agents,owner)&&liveAgents.includes(owner))return [owner];
    if(owner)capturedOwners.delete(agent);
    if(looksLikeChild(agent))warnUnknown();
    return [];
  }

  function isRoot(agent,liveAgents=agents?.list?.()??[]){
    if(!isLiveAgent(agents,agent))return false;
    return ownersOf(agent,liveAgents).length===0&&!looksLikeChild(agent);
  }

  return Object.freeze({hasNativeOwnership,observeAgentCreated,ownersOf,isRoot});
}

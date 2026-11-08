/** Observe public live route settings without resolving credentials or making a
 * network call. Settings invalidation drops only this small in-memory cache. */
export function createChatConnectionResolver(ctx){
  const cache=new Map();
  const clear=()=>cache.clear();
  for(const event of ['settings/document-updated','loader/volatile-update','llm/adapters-updated'])ctx.on(event,clear);
  const endpoint=value=>{
    if(typeof value!=='string'||!value)return null;
    try{const url=new URL(value);url.username='';url.password='';url.search='';url.hash='';return url.href.replace(/\/+$/,'');}
    catch{return null;}
  };
  return ({provider,model})=>{
    const key=JSON.stringify([provider,model]);if(cache.has(key))return cache.get(key);
    const directory=ctx.llm.listConfigurableProviders?.().find(item=>item.provider===provider);
    let profile;
    if(directory){
      const settings=ctx.get?.('settings',false),section=settings?.describe?.({redactSecrets:true}).find(item=>item.ns===directory.settingsNs)?.value;
      profile=(directory.settingsPath??[]).reduce((value,name)=>value?.[name],section);
    }
    const declared=Array.isArray(profile?.models)?profile.models.find(item=>item.id===model):null;
    const configured=declared?.baseURL??profile?.baseURL;
    const envEndpoint=directory?.baseURLEnv?.map(name=>process.env[name]).find(value=>endpoint(value));
    const url=endpoint(configured??envEndpoint??directory?.defaultBaseURL),api=declared?.api??profile?.api??null;
    const result={connection:url?JSON.stringify([directory?.settingsNs??provider,api,url]):null,
      coverage:url?(configured?'configured-endpoint-path':'adapter-default-endpoint-path'):'provider-model-only'};
    cache.set(key,result);return result;
  };
}

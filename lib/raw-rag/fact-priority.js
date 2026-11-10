import fs from 'node:fs';
import path from 'node:path';
import {parseLegacyNote} from '../legacy-notes.js';

const folder=value=>{
  const parts=String(value??'chats').replace(/\\/g,'/').split('/').filter(Boolean);
  return !parts.length||parts.some(part=>part==='.'||part==='..')?'chats':parts.join('/');
};

/**
 * Re-apply the persistent downweight of softened fact/event notes to the sentences they came from.
 * The note frontmatter in the Vault is the authority, so a rebuilt raw database or a restart ends up
 * with the same weights as the notes. Read only: neither the notes nor their bodies are rewritten.
 */
export function syncFactualPriorities(store,{vaultPath,scope,captureFolder}={}){
  let notes=0,sources=0;
  if(!scope||!vaultPath)return {notes,sources};
  for(const kind of ['facts','events']){
    const directory=path.join(vaultPath,folder(captureFolder),kind);
    let names;try{names=fs.readdirSync(directory);}catch{continue;}
    for(const name of names){
      if(!name.endsWith('.md'))continue;
      let m;
      try{
        const text=fs.readFileSync(path.join(directory,name),'utf8');
        if(!text.includes('soften_count'))continue;
        m=parseLegacyNote(text)?.metadata;
      }catch{continue;}
      if(!m?.memory_id||!['fact','event'].includes(m.memory_kind)||!(Number(m.soften_count)>0))continue;
      const factor=Number(m.soften_factor)||0.5,weight=Math.pow(factor,Number(m.soften_count));
      if(!Number.isFinite(weight)||weight<0||weight>1)continue;
      let refs=m.sources;
      if(typeof refs==='string')try{refs=JSON.parse(refs);}catch{refs=[];}
      if(!Array.isArray(refs))refs=[];
      const ids=new Set(refs.flatMap(r=>{
        if(typeof r==='string')try{r=JSON.parse(r);}catch{return [];}
        return r?.message_id||r?.messageId?[r.message_id||r.messageId]:[];
      }));
      if(m.source_message_id)ids.add(m.source_message_id);
      for(const id of ids){
        // A sentence archived under another scope is not ours to reweight; the rest still apply.
        try{store.setControl({scope,targetType:'message',targetId:id,origin:'memory:'+m.memory_id,weight,reason:'persistent factual downweight'});sources++;}
        catch{}
      }
      notes++;
    }
  }
  return {notes,sources};
}

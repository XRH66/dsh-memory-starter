import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

/** Read managed-note metadata only; never rewrite the fact database or body. */
export function syncFactualPriorities(store,{vaultPath,scope}={}){
  if(!scope||!vaultPath)return {notes:0,sources:0};
  const file=path.join(path.dirname(vaultPath),'basic-memory-state','memory.db');
  if(!fs.existsSync(file))return {notes:0,sources:0};
  const db=new DatabaseSync(file,{readOnly:true});let notes=0,sources=0;
  try{
    const project=db.prepare('SELECT id,path FROM project WHERE name=?').get('main');
    if(!project)return {notes,sources};
    if(fs.realpathSync(project.path).toLowerCase()!==fs.realpathSync(vaultPath).toLowerCase())throw Error('factual priority database points at a different vault');
    for(const row of db.prepare('SELECT entity_metadata FROM entity WHERE project_id=?').iterate(project.id)){
      let m;try{m=JSON.parse(row.entity_metadata||'{}');}catch{continue;}
      if(!m.memory_id||!['fact','event'].includes(m.memory_kind)||!(Number(m.soften_count)>0))continue;
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
      for(const id of ids){store.setControl({scope,targetType:'message',targetId:id,origin:'memory:'+m.memory_id,weight,reason:'persistent factual downweight'});sources++;}
      notes++;
    }
    return {notes,sources};
  }finally{db.close();}
}

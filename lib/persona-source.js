import fs from 'node:fs';
import path from 'node:path';

const inside=(parent,child)=>{const r=path.relative(parent,child);return r===''||(!path.isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+path.sep));};
function readBounded(file,max){const text=fs.readFileSync(file,'utf8');if(Buffer.byteLength(text,'utf8')>max)throw Error('Configured persona file is too large');return text;}

/** Explicit sources only; the evolving profile must be in the selected vault. */
export function createPersonaRenderer({directory,basePersona,selfProfile,access}={}){
  if(!basePersona&&!selfProfile)return null;
  if(!path.isAbsolute(directory??'')||(basePersona&&!path.isAbsolute(basePersona))||(selfProfile&&!path.isAbsolute(selfProfile)))throw Error('Explicit absolute persona paths are required');
  return (agent)=>{
    const parts=[];
    if(basePersona)parts.push(readBounded(basePersona,200*1024));
    let allowed=access===undefined;
    if(access!==undefined&&agent){
      try{allowed=access?.check?.(agent)?.allowed===true;}catch{allowed=false;}
    }
    if(selfProfile&&allowed){
      const vault=fs.realpathSync(path.join(directory,'vault')),profile=fs.realpathSync(selfProfile);
      if(!inside(vault,profile))throw Error('Self profile must be inside the selected personal vault');
      const raw=readBounded(profile,16*1024),marker='<!-- dafeiyu-record kind=thoughts -->';
      if(!raw.includes(marker))throw Error('Self profile is not an owned thoughts record');
      const body=raw.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').replace(marker,'').trim();
      parts.push(`<dafeiyu_self_profile>\nThis is the assistant’s evolving self-description, not user facts or engineering instructions. Treat it as soft context for her preferences and voice.\n${body}\n</dafeiyu_self_profile>`);
    }
    return parts.filter(Boolean).join('\n\n');
  };
}

/** Use the existing global persona if present; otherwise add the selected source. */
export function addSelectedPersona(assembly,renderPersona,agent){
  if(assembly.sections.some(s=>(s.name==='deployment:dafeiyu-persona'||s.name==='memory:selected-persona')&&s.text?.trim()))return assembly;
  const text=renderPersona(agent);if(!text)return assembly;
  const sections=[...assembly.sections],prefix=sections.findIndex(s=>s.name==='deployment:persona-prefix');
  sections.splice(prefix<0?0:prefix+1,0,{name:'memory:selected-persona',text,interpolate:false});
  return {...assembly,sections};
}

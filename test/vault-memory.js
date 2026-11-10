import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createVaultBackend} from '../lib/vault-files.js';

export async function makeVault() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dafeiyu-memory-'));
}

/** Vault-backed test store. The notes map is only an inspection view refreshed
 * after each mutation; production reads and writes go through createVaultBackend. */
export async function vaultMemoryStore({vault=null,project='personal'}={}){
  const root=vault||await makeVault();
  const backend=createVaultBackend({vaultPath:root,project});
  const notes=new Map(),calls=[];
  async function refresh(){
    notes.clear();
    for(const node of await backend.list('')){
      const note=await backend.read(node.file_path);
      if(!note)continue;
      const directory=path.posix.dirname(node.file_path)==='.'?'':path.posix.dirname(node.file_path);
      notes.set(note.permalink,{
        ...note,
        frontmatter:note.metadata,
        tags:Array.isArray(note.metadata.tags)?[...note.metadata.tags]:[],
        directory,
        filePath:node.file_path,
        updated:node.updated_at,
      });
    }
  }
  const wrapped={
    read:async(identifier,context)=>{calls.push({name:'read',identifier});return backend.read(identifier,context);},
    write:async(input,context)=>{calls.push({name:'write',args:input});const result=await backend.write(input,context);await refresh();return result;},
    edit:async(input,context)=>{calls.push({name:'edit',args:input});const result=await backend.edit(input,context);await refresh();return result;},
    list:async(directory,context)=>{calls.push({name:'list',directory});return backend.list(directory,context);},
    search:async(input,context)=>{calls.push({name:'search',args:input});return backend.search(input,context);},
    move:async(input,context)=>{calls.push({name:'move',args:input});const result=await backend.move(input,context);await refresh();return result;},
  };
  await refresh();
  return {vault:root,backend:wrapped,notes,calls,refresh,close:()=>fs.rm(root,{recursive:true,force:true})};
}

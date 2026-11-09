import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {lexicalMatch} from './raw-rag/lexical.js';

// Old-format memory notes (chats/facts|events|history) are read straight from the Vault so the
// search path no longer needs Basic Memory. The checksum is the same SHA-256 of the file bytes
// Basic Memory reports, so anchors issued here still verify through memory_open.

const unquote=value=>{
  const text=value.trim();
  if(text.length>=2&&text.startsWith("'")&&text.endsWith("'"))return text.slice(1,-1).replace(/''/g,"'");
  if(text.length>=2&&text.startsWith('"')&&text.endsWith('"')){try{return JSON.parse(text);}catch{return text.slice(1,-1);}}
  return text;
};

/** The flat key: value frontmatter the old writer produced (scalars plus `tags:` lists). */
export function parseLegacyNote(text){
  const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if(!match)return null;
  const metadata={};let list=null;
  for(const line of match[1].split(/\r?\n/)){
    const item=/^\s*-\s+(.*)$/.exec(line);
    if(item&&list){metadata[list].push(unquote(item[1]));continue;}
    const pair=/^([A-Za-z_][\w-]*):\s?(.*)$/.exec(line);
    // Anything beyond flat scalars and simple lists (nesting, block scalars) is not ours to guess:
    // the caller falls back to Basic Memory's own parser.
    if(!pair||/^[|>][+-]?$/.test(pair[2].trim())||/^[\[{]/.test(pair[2].trim())&&!/^['"]/.test(pair[2].trim())){if(line.trim()==='')continue;return null;}
    if(pair[2]===''){metadata[pair[1]]=[];list=pair[1];}else{metadata[pair[1]]=unquote(pair[2]);list=null;}
  }
  return {metadata,content:text.slice(match[0].length)};
}

/** Cache keyed by file path and invalidated by size+mtime, so each search only stats files. */
export function createLegacyNoteReader({vaultPath,directories}){
  const cache=new Map();
  function notes(){
    const seen=new Set(),result=[];
    for(const directory of directories){
      let names;try{names=fs.readdirSync(path.join(vaultPath,directory));}catch{continue;}
      for(const name of names){
        if(!name.endsWith('.md'))continue;
        const filePath=directory+'/'+name,full=path.join(vaultPath,filePath);seen.add(filePath);
        let stat;try{stat=fs.statSync(full);}catch{continue;}
        const stamp=`${stat.size}:${stat.mtimeMs}`,cached=cache.get(filePath);
        if(cached?.stamp===stamp){if(cached.note)result.push(cached.note);continue;}
        const bytes=fs.readFileSync(full),parsed=parseLegacyNote(bytes.toString('utf8'));
        const note=parsed&&parsed.metadata.memory_id?{...parsed,file_path:filePath,permalink:parsed.metadata.permalink||filePath.replace(/\.md$/,''),
          title:parsed.metadata.title??name.replace(/\.md$/,''),checksum:createHash('sha256').update(bytes).digest('hex')}:null;
        cache.set(filePath,{stamp,note});if(note)result.push(note);
      }
    }
    for(const key of cache.keys())if(!seen.has(key))cache.delete(key);
    return result;
  }
  return {
    /** True when the old-format folders exist on disk; otherwise callers keep the Basic Memory path. */
    available(){return directories.some(directory=>{try{return fs.statSync(path.join(vaultPath,directory)).isDirectory();}catch{return false;}});},
    /** Best lexical matches first; the caller still applies scope, state and relevance rules. */
    search(query,limit=20){
      return notes().map(note=>({note,score:lexicalMatch(query,[note.metadata.subject,note.metadata.attribute,note.metadata.value,note.content].filter(Boolean).join('\n'))}))
        .filter(item=>item.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(item=>item.note);
    },
    notes,
  };
}

/** A Vault note read from disk in the shape Basic Memory's read_note returns (content keeps the
 * frontmatter; checksum is the SHA-256 of the bytes). Null when the file or its frontmatter is
 * outside what parseLegacyNote understands. */
export function readVaultNote(vaultPath,filePath){
  if(!vaultPath||typeof filePath!=='string'||!filePath.endsWith('.md')||filePath.includes('..'))return null;
  let bytes;try{bytes=fs.readFileSync(path.join(vaultPath,filePath));}catch{return null;}
  const text=bytes.toString('utf8'),parsed=parseLegacyNote(text);if(!parsed)return null;
  return {content:text,frontmatter:parsed.metadata,metadata:parsed.metadata,permalink:parsed.metadata.permalink??null,file_path:filePath,
    title:parsed.metadata.title??path.basename(filePath,'.md'),checksum:createHash('sha256').update(bytes).digest('hex')};
}

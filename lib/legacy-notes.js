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

import path from 'node:path';

function relativePath(value){
  if(typeof value!=='string')return null;
  const normalized=value.replace(/\\/g,'/');
  if(!normalized||path.isAbsolute(normalized)||/^[A-Za-z]:/.test(normalized)||/[\u0000-\u001f?#]/.test(normalized)||
    normalized.split('/').some(part=>!part||part==='.'||part==='..'))return null;
  return normalized;
}

export function noteIdentifierPath(identifier,project){
  const relative=relativePath(identifier);
  return project&&relative?.startsWith(project+'/')?relative.slice(project.length+1):relative;
}

import path from 'node:path';
import {migrationProject} from './personal-namespace.js';

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

// A legacy locator can be checked before a scoped read. It cannot establish the note's directory.
export function legacyNoteAliasPath(identifier,project){
  const legacy=migrationProject(project),relative=relativePath(identifier);
  return legacy&&relative?.startsWith(legacy+'/')?relative.slice(legacy.length+1):null;
}

// Supply a note returned by the selected Basic Memory project. The legacy
// permalink remains its identity; only the returned file path sets its area.
export function resolveMemoryNotePath({permalink,file_path,filePath=file_path},project){
  if(!legacyNoteAliasPath(permalink,project))return noteIdentifierPath(permalink??filePath,project);
  const relative=relativePath(filePath);
  return relative&&!/:|[. ]\//.test(relative)&&/\.md$/i.test(relative)?relative:null;
}

import { adjustedRelevance } from './priority.js';
import { migrationProject } from './personal-namespace.js';
import { memorySourceState } from './source-lineage.js';
import {vaultContextFor} from './vault-files.js';

export function wikiLinks(text) {
  return [...String(text).matchAll(/\[\[([^\]\n]+)\]\]/g)]
    .map((m) => ({ raw: m[0], target: m[1].split('|')[0].split('#')[0].trim() }))
    .filter((link) => link.target && !link.target.includes('..') && !/^[a-z]+:\/\//i.test(link.target));
}
export function lexicalMatch(text, query) {
  const hay = String(text).toLowerCase();
  const tokens = new Set(String(query).toLowerCase().match(/[a-z0-9]{3,}|[\p{Script=Han}]{2,}/gu) ?? []);
  for (const token of [...tokens]) if (/\p{Script=Han}/u.test(token)) {
    for (let i = 0; i < token.length - 1; i++) tokens.add(token.slice(i, i + 2));
  }
  return [...tokens].filter((token) => hay.includes(token)).length;
}
export async function memoryCall(ctx, name, args) {
  ctx.signal?.throwIfAborted?.();
  const {backend,context}=vaultContextFor(ctx);
  try{
    if(name==='read_note'){
      const note=await backend.read(args?.identifier,context);
      if(!note)throw Object.assign(Error('NOTE_NOT_FOUND'),{code:'NOTE_NOT_FOUND'});
      return {...note,frontmatter:note.metadata??{}};
    }
    if(name==='write_note'){
      ctx.assertSourceCurrent?.();
      return await backend.write(args??{},context);
    }
    if(name==='edit_note'){
      ctx.assertSourceCurrent?.();
      return await backend.edit(args??{},context);
    }
    if(name==='move_note'){
      ctx.assertSourceCurrent?.();
      return await backend.move(args??{},context);
    }
    if(name==='list_directory'){
      const nodes=await backend.list(args?.dir_name??'',context);
      const directory=String(args?.dir_name??'').replace(/\\/g,'/').replace(/^\/+|\/+$/g,'');
      return {nodes:Number(args?.depth??1)===1?nodes.filter(node=>!node.directory_path||node.directory_path===directory):nodes};
    }
    if(name==='search_notes'){
      return {results:await backend.search(args??{},context)};
    }
    throw Object.assign(Error('MEMORY_TOOL_FAILED'),{code:'MEMORY_TOOL_FAILED'});
  }catch(error){
    if(error?.code==='MEMORY_WRITE_CONFLICT'){
      throw Object.assign(Error('WRITE_CONFLICT'),{code:'WRITE_CONFLICT',currentChecksum:error.currentChecksum??null});
    }
    if(error?.code==='NOTE_NOT_FOUND')throw error;
    throw Object.assign(Error('MEMORY_TOOL_FAILED'),{code:'MEMORY_TOOL_FAILED'});
  }
}
/** Vault-relative path, never an absolute or traversing path. */
export function relativeNotePath(note) {
  const raw = String(note?.file_path ?? note?.filePath ?? '').normalize('NFKC').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!raw || raw.startsWith('/') || /^[A-Za-z]:\//.test(raw) || raw.split('/').some(part => part === '..' || part === '.')) return '';
  return raw;
}

/**
 * A note belongs to a project area only when its permalink carries that project
 * (or the bounded personal migration prefix) and, for the legacy form, its
 * actual vault-relative file_path still sits in the same area.
 */
export function noteMatchesProjectPath(note, project, relativePath, { exact = false } = {}) {
  const permalink = String(note?.permalink ?? '').replace(/^\/+/, '');
  const current = project + '/' + relativePath;
  const migration = migrationProject(project);
  const legacy = migration ? migration + '/' + relativePath : '';
  const permalinkOk = exact
    ? permalink === current || (legacy && permalink === legacy)
    : permalink.startsWith(current + '/') || (legacy && permalink.startsWith(legacy + '/'));
  if (!permalinkOk) return false;
  if (permalink === current || permalink.startsWith(current + '/')) return true;
  const file = relativeNotePath(note);
  return exact ? file === relativePath + '.md' : file.startsWith(relativePath + '/');
}

export const activeNote = (note) => {
  const meta = note.frontmatter ?? note.metadata ?? {};
  return String(meta.status ?? note.status ?? 'active') === 'active' && ![true, 'true'].includes(meta.qa_fixture);
};
export function factValue(note) {
  return [...String(note.content ?? '').matchAll(/^\s*-\s*\[(?:preference|fact|decision|relationship|event)\]\s+(.+)$/gm)]
    .map((m) => m[1]).join(' ');
}



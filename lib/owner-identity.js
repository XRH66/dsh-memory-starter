import {listAllNotes,readMemoryNote,parseMemoryContent} from './memory.js';

/** Explicitly bind one existing personal subject to a verified QQ account. */
export function matchesOwnerIdentity(subject, ownerId, identity) {
  if (typeof ownerId !== 'string' || !/^[1-9]\d{4,15}$/.test(ownerId)) return false;
  if (subject === `qq:${ownerId}`) return true;
  return typeof subject === 'string' && subject.length > 0 && subject.length <= 100 && subject === subject.trim()
    && !/^qq:/i.test(subject) && identity?.kind === 'existing-subject'
    && identity.ownerId === ownerId && identity.subject === subject;
}
/** On-demand preview only: list explicit subjects, never infer who they are. */
export async function listExistingOwnerSubjects({tools,config,limit=100,offset=0}) {
  if (!tools || !config?.project || !config?.captureFolder || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset<0 || offset>=1000) throw Error('Invalid subject preview scope');
  const agent={id:'memory-owner-subject-preview',session:{id:'memory-owner-subject-preview'}};
  const ctx={tools,agent,config,project:config.project,signal:AbortSignal.timeout(30_000)};
  const found=await listAllNotes(ctx,`${config.captureFolder}/facts`,{maxNotes:Math.min(1000,offset+limit+1)}),notes=found.slice(offset,offset+limit);
  const subjects=new Map();let skipped=0;
  for(const note of notes){
    try {
      const payload=await readMemoryNote(ctx,note.permalink),meta=payload?.frontmatter??payload?.metadata??{},body=parseMemoryContent(payload?.content);
      if(!meta.memory_id || (meta.status && meta.status!=='active'))continue;
      const subject=String(body?.subject||meta.subject||'').trim();
      if(!subject || subject.length>100 || /^qq:/i.test(subject))continue;
      subjects.set(subject,(subjects.get(subject)||0)+1);
    } catch {skipped++;}
  }
  const nextOffset=found.length>offset+limit&&offset+limit<1000?offset+limit:null;
  return {subjects:[...subjects].map(([subject,count])=>({subject,count,offset})),examined:notes.length,nextOffset,incomplete:Boolean(nextOffset)||skipped>0||(offset+limit>=1000&&found.length>=1000),skipped};
}

/** A new QQ subject may be created only when the personal fact/event folders are empty. */
export async function personalFactLibraryEmpty({tools,config}){
  if(!tools||!config?.project||!config?.captureFolder)throw Error('Invalid personal memory scope');
  const agent={id:'memory-owner-empty-check',session:{id:'memory-owner-empty-check'}},ctx={tools,agent,config,project:config.project,signal:AbortSignal.timeout(30_000)};
  for(const folder of ['facts','events'])if((await listAllNotes(ctx,`${config.captureFolder}/${folder}`,{maxNotes:1})).length)return false;
  return true;
}

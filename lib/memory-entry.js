import {MEMORY_ENTRY_TYPES,MEMORY_VALIDITY,MEMORY_PROGRESS,MEMORY_IMPORTANCE_LEVELS,MEMORY_IMPORTANCE_BASES} from './memory-contract.js';
import {memoryError,requiredText} from './storage/contract.js';

export const MEMORY_ENTRY_SCHEMA='memory-entry-v1';
const actionable=new Set(['goal','plan','todo','commitment']);
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const fail=message=>{throw memoryError('INVALID_MEMORY_ENTRY',message);};
const backendMetadata=new Set(['title','permalink','type','tags','embed']);
export const customNoteMetadata=(metadata={})=>Object.fromEntries(Object.entries(metadata).filter(([key])=>!backendMetadata.has(key)));
const optionalText=value=>value===null||value===undefined?null:typeof value==='string'?value:fail('文本字段无效');
function enumValue(value,values,label){if(!values.includes(value))fail(label+'无效');return value;}
function decoded(value,label){if(typeof value!=='string')return value;try{return JSON.parse(value);}catch{fail(label+'不是有效 JSON');}}
function importedRef(value){
  if(!value||typeof value!=='object'||Array.isArray(value))fail('导入来源无效');
  if(value.kind!=='legacy-note')fail('导入来源类型无效');
  const result={kind:'legacy-note',memoryId:requiredText(value.memoryId,'旧记忆标识',2000),
    path:requiredText(value.path,'旧记忆路径',4000),checksum:requiredText(value.checksum,'旧记忆校验和',256)};
  if(value.historyEvidence!==undefined){
    if(typeof value.historyEvidence!=='string'||!value.historyEvidence.trim())fail('旧记忆历史依据无效');
    result.historyEvidence=value.historyEvidence;
  }
  return result;
}
function sourceRef(source){
  if(!source||typeof source!=='object')fail('缺少真实来源映射');
  const id=requiredText(source.id,'来源身份',2000),revision=source.revision;
  if(!(Number.isSafeInteger(revision)&&revision>0)&&!(typeof revision==='string'&&revision.trim()))fail('缺少持久来源版本');
  return {id,revision,...(['user','assistant'].includes(source.role)?{role:source.role}:{})};
}
function importance(value){
  if(value===null||value===undefined)return null;
  if(typeof value!=='object'||Array.isArray(value))fail('重要程度无效');
  const level=enumValue(value.level,MEMORY_IMPORTANCE_LEVELS,'重要程度'),basis=enumValue(value.basis,MEMORY_IMPORTANCE_BASES,'重要程度依据');
  if(typeof value.reason!=='string'||(basis!=='unassessed'&&!value.reason.trim()))fail('需要重要程度依据说明');
  return {level,basis,reason:value.reason};
}
export function resolveMemoryEntryState(proposed,previous=null,{type='fact'}={}){
  const state=previous?{...previous}:{validity:'unverified',progress:actionable.has(type)?'unknown':null};
  if(proposed!==null&&proposed!==undefined){
    if(typeof proposed!=='object'||Array.isArray(proposed))fail('状态必须区分有效性与事项进展');
    if(proposed.validity!==null&&proposed.validity!==undefined)state.validity=enumValue(proposed.validity,MEMORY_VALIDITY,'有效性');
    if(proposed.progress!==null&&proposed.progress!==undefined)state.progress=enumValue(proposed.progress,MEMORY_PROGRESS,'事项进展');
  }
  enumValue(state.validity,MEMORY_VALIDITY,'有效性');
  if(state.progress!==null)enumValue(state.progress,MEMORY_PROGRESS,'事项进展');
  return state;
}

/** Resolves only supplied input references; this function neither grants access
 * nor judges the truth/importance of the model's semantic interpretation. */
export function normalizeSemanticEntry(raw,{sources,subjects,previous=null,imported=null}={}){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))fail('需要长期条目对象');
  for(const key of ['type','content','subject_ref','source_refs','state','tags','importance'])if(!own(raw,key))fail('缺少字段：'+key);
  const type=enumValue(raw.type,MEMORY_ENTRY_TYPES,'内容类型');
  if(typeof raw.content!=='string'||!raw.content.trim())fail('长期内容不能为空');
  let source_refs,imported_from;
  if(imported!==null){
    imported_from=importedRef(imported);
    if(!Array.isArray(raw.source_refs)||raw.source_refs.length)fail('导入条目的原文依据必须为空');
    if(raw.evidence_basis!==undefined&&raw.evidence_basis!==null&&raw.evidence_basis!=='manual')fail('导入条目的依据性质必须为 manual');
    source_refs=[];
  }else{
    if(!(sources instanceof Map)||!Array.isArray(raw.source_refs)||!raw.source_refs.length)fail('需要原文依据编号');
    const refs=raw.source_refs.map(ref=>{if(!sources.has(ref))fail('来源编号不存在');return sourceRef(sources.get(ref));});
    source_refs=[...new Map(refs.map(ref=>[JSON.stringify([ref.id,ref.revision]),ref])).values()];
  }
  let subject_ref=null;
  if(raw.subject_ref!==null){if(!(subjects instanceof Map)||!subjects.has(raw.subject_ref))fail('主体编号不存在');subject_ref=requiredText(subjects.get(raw.subject_ref),'主体引用',2000);}
  if(!Array.isArray(raw.tags)||raw.tags.some(tag=>typeof tag!=='string'))fail('主题标签无效');
  const result={type,content:raw.content,subject_ref,source_refs,
    state:resolveMemoryEntryState(raw.state,previous?.state,{type}),
    tags:[...new Set(raw.tags.map(tag=>tag.trim()).filter(Boolean))],
    importance:raw.importance===null?structuredClone(previous?.importance??null):importance(raw.importance)};
  if(imported_from)result.evidence_basis='manual';
  else if(raw.evidence_basis!==undefined&&raw.evidence_basis!==null)result.evidence_basis=enumValue(raw.evidence_basis,['self_report','reported','observed','inferred','manual'],'依据性质');
  for(const key of ['speaker_ref','viewpoint_holder_ref','inferred_by_ref'])if(own(raw,key)){
    if(raw[key]===null)result[key]=null;
    else{if(!(subjects instanceof Map)||!subjects.has(raw[key]))fail(key+'编号不存在');result[key]=requiredText(subjects.get(raw[key]),'主体引用',2000);}
  }
  if(imported_from)result.imported_from=imported_from;
  if(result.evidence_basis==='inferred'&&!result.inferred_by_ref)fail('模型推断必须标明推断主体');
  for(const key of ['occurred_at','valid_from','valid_until','due_at','time_expression'])if(own(raw,key))result[key]=optionalText(raw[key]);
  return result;
}

/** A patch for the existing Markdown/Basic Memory note, preserving unknown
 * human metadata. Tags remain the existing note's ordinary tags field. */
export function memoryEntryMetadata(entry,previous={}){
  enumValue(entry.type,MEMORY_ENTRY_TYPES,'内容类型');
  const state=resolveMemoryEntryState(entry.state,null,{type:entry.type});
  const meta={...customNoteMetadata(previous),embed:false,memory_entry_schema:MEMORY_ENTRY_SCHEMA,memory_type:entry.type,
    subject_ref:entry.subject_ref??'',memory_source_refs:JSON.stringify(entry.source_refs.map(sourceRef)),
    state_validity:state.validity,state_progress:state.progress??'',importance:JSON.stringify(importance(entry.importance)),tags:[...entry.tags]};
  if(entry.imported_from)meta.legacy_import_from=JSON.stringify(importedRef(entry.imported_from));
  for(const key of ['evidence_basis','speaker_ref','viewpoint_holder_ref','inferred_by_ref','occurred_at','valid_from','valid_until','due_at','time_expression'])if(own(entry,key))meta[key]=entry[key]??'';
  return meta;
}

export function historicalMemoryEntryMetadata(metadata={}){
  const keys=['memory_entry_schema','memory_type','subject_ref','memory_source_refs','state_validity','state_progress','importance','evidence_basis','speaker_ref','viewpoint_holder_ref','inferred_by_ref','due_at'];
  const result=Object.fromEntries(keys.filter(key=>own(metadata,key)).map(key=>[key,metadata[key]]));
  if(!result.memory_type&&result.memory_entry_schema===MEMORY_ENTRY_SCHEMA&&MEMORY_ENTRY_TYPES.includes(metadata.type))result.memory_type=metadata.type;
  if(result.memory_type||result.memory_entry_schema)result.state_validity='historical';
  return result;
}

/** The supplied content is the current Markdown managed body, never a cached
 * frontmatter value. Reading old notes does not rewrite or classify them. */
export function readMemoryEntry({metadata={},content='',legacyKind='',legacyStatus=''}={}){
  let type=null;
  if(metadata.memory_type!==undefined&&metadata.memory_type!=='')type=enumValue(metadata.memory_type,MEMORY_ENTRY_TYPES,'内容类型');
  else if(metadata.memory_entry_schema===MEMORY_ENTRY_SCHEMA&&MEMORY_ENTRY_TYPES.includes(metadata.type))type=metadata.type;
  else if(['fact','event'].includes(legacyKind))type=legacyKind;
  const explicit=metadata.memory_entry_schema===MEMORY_ENTRY_SCHEMA||Boolean(metadata.memory_type);
  const state=resolveMemoryEntryState({validity:metadata.state_validity||(explicit?'unverified':legacyStatus==='history'?'historical':'current'),progress:metadata.state_progress||null},null,{type:type??'fact'});
  let refs=[];
  if(metadata.memory_source_refs)refs=decoded(metadata.memory_source_refs,'来源引用');
  if(!Array.isArray(refs))fail('来源引用无效');
  refs=refs.map(sourceRef);
  let tags=metadata.tags??[];
  if(typeof tags==='string'){try{tags=JSON.parse(tags);}catch{tags=tags.split(',').map(value=>value.trim()).filter(Boolean);}}
  if(!Array.isArray(tags)||tags.some(tag=>typeof tag!=='string'))fail('主题标签无效');
  const result={type,content:String(content),subject_ref:metadata.subject_ref||null,source_refs:refs,state,tags,
    importance:importance(own(metadata,'importance')&&metadata.importance!==''?decoded(metadata.importance,'重要程度'):null),legacy:!explicit};
  if(own(metadata,'legacy_import_from')&&metadata.legacy_import_from!==''){
    result.imported_from=importedRef(decoded(metadata.legacy_import_from,'旧记忆导入来源'));
  }
  for(const key of ['evidence_basis','speaker_ref','viewpoint_holder_ref','inferred_by_ref','occurred_at','valid_from','valid_until','due_at','time_expression'])if(own(metadata,key))result[key]=metadata[key]||null;
  return result;
}

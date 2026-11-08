import {executeScopedTool} from './tool-call.js';
import {unwrapToolValue,toolFailureText} from './mcp.js';
import {stripFrontmatter} from './records.js';

async function callMemoryEntryTool({tools,project},name,args,context){
  context.check();
  const result=await executeScopedTool({tools,name:'mcp__basic_memory__'+name,args:{...args,project,output_format:'json'},agent:context.agent,signal:context.signal});
  context.check();
  if(result.isError){
    const text=toolFailureText(result);
    if(name==='read_note'&&/NOTE_NOT_FOUND|note not found/i.test(text))return null;
    const conflict=name!=='read_note'&&/checksum|conflict|already exists|modified/i.test(text);
    throw Object.assign(Error(text),{code:conflict?'MEMORY_WRITE_CONFLICT':'MEMORY_BACKEND_ERROR'});
  }
  const value=unwrapToolValue(result);
  if(!value)throw Error('Memory backend returned no value');
  if(name==='read_note'&&value.error==='NOTE_NOT_FOUND')return null;
  if(name==='read_note'&&value.error==='NOTE_SYNC_PENDING'){
    throw Object.assign(Error('Local Markdown is awaiting Basic Memory synchronization'),{code:'MEMORY_NOTE_SYNC_PENDING',retryable:true});
  }
  if(value.error==='NOTE_REVISION_CONFLICT'){
    throw Object.assign(Error('Basic Memory rejected the note revision'),{code:'MEMORY_WRITE_CONFLICT',backendCode:value.error,currentChecksum:value.currentChecksum??null});
  }
  const action=value.kind??value.action;
  if(value.error||['conflict','already_exists','target_moved','locked','revision_conflict'].includes(action)){
    throw Object.assign(Error(String(value.message??value.error??action)),{code:name==='read_note'?'MEMORY_BACKEND_ERROR':'MEMORY_WRITE_CONFLICT'});
  }
  return value;
}

export function readMemoryEntryNote(context,identifier,{filePath,tools=context.tools,project=context.project}={}){
  return callMemoryEntryTool({tools,project},'read_note',{identifier,include_content:true,include_frontmatter:true,
    ...(filePath?{known_file_path:filePath}:{})},context);
}

export const normalizeMemoryEntryNote=value=>value?{...value,content:stripFrontmatter(value.content??''),metadata:value.frontmatter??value.metadata??{}}:null;

/** The existing local Basic Memory connection; every call keeps the caller's
 * native agent, cancellation and authorization. This never selects an LLM. */
export function createMemoryEntryBackend({tools,project}){
  const call=(name,args,context)=>callMemoryEntryTool({tools,project},name,args,context);
  return {
    async read(identifier,context){const value=await readMemoryEntryNote(context,identifier,{tools,project});
      return normalizeMemoryEntryNote(value);},
    async write(input,context){
      const value=await call('write_note',input,context);
      if(!value.permalink||!value.checksum)throw Error('Memory write lacks a durable note receipt');
      return value;
    },
    async edit(input,context){
      const value=await call('edit_note',input,context);
      if(!value.permalink||!value.checksum)throw Error('Memory edit lacks a durable note receipt');
      return value;
    },
  };
}

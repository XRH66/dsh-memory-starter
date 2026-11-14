import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

const RETRY_CODES=new Set(['EPERM','EACCES','EBUSY']);
const MAX_RENAME_RETRIES=5;
const RETRY_DELAY_MS=30;

function temporaryPath(file,hiddenTemporary){
  if(!hiddenTemporary)return file+'.'+randomUUID()+'.tmp';
  return path.join(path.dirname(file),'.'+path.basename(file)+'.'+process.pid+'.'+randomUUID()+'.tmp');
}

export async function writeFileAtomic(file,data,{
  flag='w',mode,encoding='utf8',fsync=false,hiddenTemporary=false,beforeRename,
}={}){
  const temporary=temporaryPath(file,hiddenTemporary);
  try{
    const writeOptions={flag,encoding};
    if(mode!==undefined)writeOptions.mode=mode;
    await fs.writeFile(temporary,data,writeOptions);
    if(fsync){
      const handle=await fs.open(temporary,'r+');
      try{await handle.sync();}
      finally{await handle.close();}
    }
    if(beforeRename&&await beforeRename()===false)return false;
    for(let attempt=0;;attempt++){
      try{
        await fs.rename(temporary,file);
        return true;
      }catch(error){
        if(attempt>=MAX_RENAME_RETRIES||!RETRY_CODES.has(error?.code))throw error;
        await new Promise(resolve=>setTimeout(resolve,RETRY_DELAY_MS*2**attempt));
      }
    }
  }finally{
    await fs.rm(temporary,{force:true}).catch(()=>{});
  }
}

export async function writeJsonAtomic(file,value,{space,trailingNewline=false,...options}={}){
  return writeFileAtomic(file,JSON.stringify(value,null,space)+(trailingNewline?'\n':''),options);
}

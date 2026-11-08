import path from 'node:path';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';

export const inside=(root,file)=>{const relative=path.relative(root,file);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));};
async function actual(file){try{return await fs.realpath(file);}catch(error){if(error.code!=='ENOENT')throw error;const parent=path.dirname(file);if(parent===file)throw error;return path.join(await actual(parent),path.basename(file));}}
/** All installation writes stay in a real, explicitly selected memory root. */
export async function installPath(root,relative){
  const resolved=path.resolve(root),real=await fs.realpath(resolved);
  if(real.toLowerCase()!==resolved.toLowerCase())throw Error('安装目录不能经过链接或目录别名');
  const file=path.resolve(resolved,relative),target=await actual(file);
  if(!inside(real,target)||path.relative(file,target)!=='')throw Error('安装路径必须位于当前记忆库内，不能经过链接');
  return file;
}
export async function fileDigest(file,signal){
  const hash=createHash('sha256');for await(const bytes of createReadStream(file)){signal?.throwIfAborted();hash.update(bytes);}return hash.digest('hex');
}
async function optionalStat(file){try{return await fs.stat(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function saveInstallJson(root,relative,value){
  const file=await installPath(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});
  const temporary=file+'.'+randomUUID()+'.tmp';try{await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{flag:'wx'});await fs.rename(temporary,file);}finally{await fs.rm(temporary,{force:true});}
}
export async function verifiedDownload(root,relative,artifact,{signal,onProgress,allowDownload=false}={}){
  const file=await installPath(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});
  const before=await optionalStat(file);
  if(before){
    if(before.size===artifact.size&&await fileDigest(file,signal)===artifact.sha256)return {file,reused:true};
    throw Error('已有模型文件与所选安装配方不符，请保留它并选择其他位置，或在高级设置使用已有文件');
  }
  if(!allowDownload)throw Error('缺少本地文件；选择下载准备，或在高级设置提供已有文件');
  const part=await installPath(root,relative+'.part');let offset=(await optionalStat(part))?.size || 0;
  if(offset>artifact.size){await fs.rename(part,part+'.invalid-'+randomUUID());offset=0;}
  if(offset<artifact.size){
    const response=await fetch(artifact.url,{headers:offset?{Range:'bytes='+offset+'-'}:{},signal,redirect:'follow'});
    if(new URL(response.url).protocol!=='https:')throw Error('下载地址必须使用 HTTPS');
    if(!response.ok||!response.body)throw Error('模型下载未成功（HTTP '+response.status+'），可再次继续');
    if(response.status===206){
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if(!range||Number(range[1])!==offset||Number(range[3])!==artifact.size)throw Error('下载续接位置不一致，未拼接文件');
    }else if(response.status===200)offset=0;
    else throw Error('下载服务返回不支持的状态');
    const handle=await fs.open(part,offset?'a':'w');
    try{
      for await(const bytes of response.body){
        signal?.throwIfAborted();if(offset+bytes.length>artifact.size)throw Error('下载内容超过登记文件大小');
        await handle.writeFile(bytes);offset+=bytes.length;await onProgress?.({file:artifact.file,received:offset,total:artifact.size});
      }
      await handle.sync();
    }finally{await handle.close();}
  }
  signal?.throwIfAborted();
  if(offset!==artifact.size)throw Error('下载尚未完整，可再次继续');
  if(await fileDigest(part,signal)!==artifact.sha256){await fs.rename(part,part+'.invalid-'+randomUUID());throw Error('下载文件校验不符，已保留异常文件；再次准备会重新下载');}
  await fs.rename(part,file);return {file,reused:false};
}

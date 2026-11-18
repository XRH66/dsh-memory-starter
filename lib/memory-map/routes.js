// HTTP routes for the memory map page, mounted on DSH's own web server (the same
// capability the settings page already uses). Code and computation load lazily
// on the first data request; with the feature switched off nothing is computed.
import path from 'node:path';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {trusted,json,body} from '../settings-host.js';

export const MAP_BASE='/api/basic-memory-map';
const here=path.dirname(fileURLToPath(import.meta.url));
const VIEW_ID=/^[A-Za-z0-9_-]{1,64}$/;
const MAX_VIEW_BYTES=2*1024*1024;
const BUILTIN_VIEWS=['starfield','plane'];
const LIBS=new Map([['three-r128.js',path.join(here,'vendor','three-r128.js')]]);
// The shell may frame only its own srcdoc views; views also get a stricter policy of their own
// and never load anything over the network (the shell inlines bundled libraries into them).
const SHELL_CSP="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; "+
  "font-src 'self' data:; connect-src 'self'; frame-src 'self'; worker-src 'self' blob:; form-action 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'";

const textCache=new Map();
async function readText(file){
  const stat=await fs.stat(file),hit=textCache.get(file);
  if(hit&&hit.mtime===stat.mtimeMs&&hit.size===stat.size)return hit.text;
  const text=await fs.readFile(file,'utf8');textCache.set(file,{mtime:stat.mtimeMs,size:stat.size,text});return text;
}
function send(res,status,type,content,extra={}){
  res.statusCode=status;res.setHeader('content-type',type);res.setHeader('x-content-type-options','nosniff');
  for(const [key,value] of Object.entries(extra))res.setHeader(key,value);
  res.end(content);
}
const meta=(html,name)=>{
  const tag=html.slice(0,8192).match(new RegExp(`<meta[^>]+name=["']${name}["'][^>]*>`,'i'))?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1]?.trim().slice(0,200)??'';
};
const title=html=>html.slice(0,8192).match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim().slice(0,60)??'';

/** Lists built-in views first, then *.html files in the user's views folder. */
export async function listViews(viewsDirectory){
  const views=[];
  for(const id of BUILTIN_VIEWS){
    const html=await readText(path.join(here,'views',id+'.html'));
    views.push({id,name:title(html)||id,description:meta(html,'description'),builtin:true});
  }
  if(viewsDirectory){
    let names=[];try{names=await fs.readdir(viewsDirectory);}catch{names=[];}
    for(const name of names.sort()){
      if(!name.toLowerCase().endsWith('.html'))continue;
      const id=name.slice(0,-5);if(!VIEW_ID.test(id)||BUILTIN_VIEWS.includes(id))continue;
      try{
        const file=path.join(viewsDirectory,name),stat=await fs.stat(file);
        if(!stat.isFile()||stat.size>MAX_VIEW_BYTES)continue;
        const html=await readText(file);
        views.push({id,name:title(html)||id,description:meta(html,'description'),builtin:false});
      }catch{}
    }
  }
  return views;
}
export async function readView(viewsDirectory,id){
  if(!VIEW_ID.test(id??''))throw Error('视图名称无效');
  if(BUILTIN_VIEWS.includes(id))return readText(path.join(here,'views',id+'.html'));
  if(!viewsDirectory)throw Error('没有找到这个视图');
  const file=path.join(viewsDirectory,id+'.html');
  const stat=await fs.stat(file).catch(()=>null);
  if(!stat?.isFile())throw Error('没有找到这个视图');
  if(stat.size>MAX_VIEW_BYTES)throw Error('视图文件超过 2 MB');
  return readText(file);
}

/**
 * controls: {memoryMap, readEnabled():Promise<boolean>, createService(access):service}
 * memoryMap is the runtime's host-only access object (or null when vectors are off).
 */
export function createMemoryMapHandler(ctx,controls){
  let serviceTask=null;
  const service=()=>serviceTask??=import('./service.js').then(({createMemoryMapService})=>
    controls.createService?.(controls.memoryMap)??createMemoryMapService({directory:controls.memoryMap.directory,access:controls.memoryMap,logger:controls.logger}));
  const handler=async(req,res)=>{
    const url=new URL(req.url??'/','http://localhost'),sub=url.pathname.slice(MAP_BASE.length).replace(/\/+$/,'')||'/';
    // Library files are public static code: a sandboxed view has an opaque origin and no cookies.
    if(req.method==='GET'&&sub.startsWith('/lib/')){
      const file=LIBS.get(sub.slice(5));
      if(!file)return send(res,404,'text/plain; charset=utf-8','not found');
      return send(res,200,'text/javascript; charset=utf-8',await readText(file),{'cache-control':'public, max-age=86400','cross-origin-resource-policy':'cross-origin'});
    }
    const write=req.method==='POST';
    if(!trusted(ctx,req,write))return json(res,403,{ok:false,error:'访问被拒绝，请从 DSH 设置页打开记忆星图'});
    try{
      const enabled=await controls.readEnabled();
      if(req.method==='GET'&&(sub==='/'||sub==='/index.html')){
        const html=await readText(path.join(here,'shell.html'));
        return send(res,200,'text/html; charset=utf-8',html,{'cache-control':'no-store','content-security-policy':SHELL_CSP,'referrer-policy':'no-referrer','x-frame-options':'SAMEORIGIN'});
      }
      if(req.method==='GET'&&sub==='/status'){
        const status=enabled&&controls.memoryMap&&serviceTask?(await service()).status():null;
        return json(res,200,{ok:true,enabled,vectors:Boolean(controls.memoryMap),...status?{build:status}:{}});
      }
      if(!enabled)return json(res,404,{ok:false,state:'disabled',error:'记忆星图已关闭，可在 DSH 设置 → 记忆框架里打开'});
      if(req.method==='GET'&&sub==='/views')return json(res,200,{ok:true,views:await listViews(controls.memoryMap?.viewsDirectory)});
      if(req.method==='GET'&&sub.startsWith('/views/')){
        const html=await readView(controls.memoryMap?.viewsDirectory,decodeURIComponent(sub.slice(7)));
        return json(res,200,{ok:true,html});
      }
      if(!controls.memoryMap)return json(res,409,{ok:false,state:'no-vectors',error:'还没有启用原话检索或向量模型'});
      if(req.method==='GET'&&sub==='/data'){
        const wait=Math.max(0,Math.min(5000,Number(url.searchParams.get('wait')??1500)||0));
        const result=await (await service()).data(()=>{},{wait});
        const entry=result.entry;
        if(!entry)return json(res,result.state==='ready'?500:result.state==='failed'?500:202,{ok:result.state==='building',state:result.state,progress:result.progress??null,
          ...result.error?{error:'星图计算失败：'+result.error.message}:{}});
        const headers={'cache-control':'no-cache','etag':'"'+entry.data.fingerprint+'"','x-memory-map-state':result.state,
          ...result.progress?{'x-memory-map-progress':encodeURIComponent(JSON.stringify(result.progress))}:{}};
        if(result.state==='ready'&&req.headers['if-none-match']===headers.etag)return send(res,304,'application/json; charset=utf-8','',headers);
        const gzip=/\bgzip\b/.test(String(req.headers['accept-encoding']??''));
        return send(res,200,'application/json; charset=utf-8',gzip?entry.gzip:entry.body,{...headers,...gzip?{'content-encoding':'gzip',vary:'accept-encoding'}:{}});
      }
      if(req.method==='POST'&&sub==='/rebuild'){
        await body(req);const result=await (await service()).data(()=>{},{wait:0,rebuild:true});
        return json(res,202,{ok:true,state:result.state,progress:result.progress??null});
      }
      if(req.method==='GET'&&sub==='/item')return json(res,200,{ok:true,...controls.memoryMap.item(url.searchParams.get('id'))});
      if(req.method==='POST'&&sub==='/search'){
        const input=await body(req);
        return json(res,200,{ok:true,...await controls.memoryMap.search(input.query)});
      }
      return json(res,404,{ok:false,error:'未找到'});
    }catch(error){
      return json(res,400,{ok:false,error:String(error?.message??'记忆星图请求失败').slice(0,200)});
    }
  };
  handler.dispose=async()=>{if(serviceTask)await (await serviceTask).idle?.();};
  return handler;
}

export function registerMemoryMapRoutes(ctx,controls){
  if(typeof ctx.inject!=='function')return;
  ctx.inject(['webServer'],child=>child.effect(()=>{
    const handler=createMemoryMapHandler(child,controls);
    const unregister=child.webServer.register({kind:'prefix',path:MAP_BASE,handler});
    return async()=>{await handler.dispose();if(typeof unregister==='function')return unregister();};
  },'basic-memory: memory map routes'));
}

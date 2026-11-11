import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { verifiedDownload, userCancel } from '../lib/raw-rag/install-download.js';
import { scratchDirectory } from './helpers.js';

// A fictional artifact served in small chunks; the download is aborted after the first chunk lands.
async function partialDownload(t, reason) {
  const root=await scratchDirectory('install-download-cancel-');
  const artifact={file:'fictional.gguf',url:'https://fictional.example/fictional.gguf',size:64,sha256:'0'.repeat(64)};
  const controller=new AbortController(),original=globalThis.fetch;
  globalThis.fetch=async(url,{signal})=>{
    const body=new ReadableStream({
      async pull(stream){
        await new Promise(resolve=>setTimeout(resolve,5));
        if(signal.aborted)return stream.error(signal.reason);
        stream.enqueue(new Uint8Array(8));
      },
    });
    const response=new Response(body,{status:200});
    Object.defineProperty(response,'url',{value:url});
    return response;
  };
  t.after(()=>{globalThis.fetch=original;});
  const relative='models/fictional-model/'+artifact.file,part=path.join(root,relative+'.part');
  const download=verifiedDownload(root,relative,artifact,{signal:controller.signal,allowDownload:true,
    onProgress:()=>{if(!controller.signal.aborted)controller.abort(reason);}});
  await assert.rejects(download);
  return {root,part,directory:path.dirname(part)};
}

test('a cancel the user asked for removes the partial file and its empty folder',async t=>{
  const f=await partialDownload(t,userCancel());
  await assert.rejects(fs.access(f.part),{code:'ENOENT'});
  await assert.rejects(fs.access(f.directory),{code:'ENOENT'});
  await fs.access(f.root);
});

test('an abort without a user cancel keeps the partial file for a later resume',async t=>{
  const f=await partialDownload(t,undefined);
  assert.ok((await fs.stat(f.part)).size>0);
});

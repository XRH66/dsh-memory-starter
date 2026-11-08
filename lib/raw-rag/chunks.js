import { splitWindows, splitClauses, sha256 } from './store.js';

function splitPart(part) {
  const text = part.text, middle = Math.floor(text.length / 2);
  const boundaries = splitClauses(text).map(clause => clause.end).filter(end => end > 0 && end < text.length);
  let cut = boundaries.sort((a,b)=>Math.abs(a-middle)-Math.abs(b-middle))[0] ?? middle;
  // Keep UTF-16 surrogate pairs together. Offsets always refer to the source.
  if (cut>0 && cut<text.length && /[\uD800-\uDBFF]/.test(text[cut-1]) && /[\uDC00-\uDFFF]/.test(text[cut])) cut -= 1;
  if(cut===0&&text.length>2&&/[\uD800-\uDBFF]/.test(text[0])&&/[\uDC00-\uDFFF]/.test(text[1]))cut=2;
  if (cut<=0 || cut>=text.length) throw new Error('A source character cannot fit the embedding token limit');
  return [{text:text.slice(0,cut),start:part.start,end:part.start+cut},
    {text:text.slice(cut),start:part.start+cut,end:part.end}];
}

/** Plan model-specific derived chunks; never truncate or rewrite the source. */
export async function planEmbeddingChunks(text, { maxTokens, countTokens, signal, authorize, maxChars = 600 }) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0 || typeof countTokens !== 'function') {
    throw new Error('Chunk planning needs a model token limit and tokenizer');
  }
  const source = String(text ?? '');
  const work = splitWindows(source,maxChars), accepted = [];
  let cursor = 0;
  while(cursor<work.length){
    signal?.throwIfAborted();
    if(authorize&&!await authorize())throw new Error('Embedding source access changed');
    signal?.throwIfAborted();
    const batch=work.slice(cursor,cursor+16);cursor+=batch.length;
    const counts=await countTokens(batch.map(part=>part.text));
    if(!Array.isArray(counts)||counts.length!==batch.length||counts.some(count=>!Number.isSafeInteger(count)||count<0))throw new Error('Invalid tokenizer counts');
    for(let i=0;i<batch.length;i++){
      if(counts[i]<=maxTokens)accepted.push({...batch[i],tokenBound:counts[i]});
      else work.push(...splitPart(batch[i]));
    }
  }
  return accepted.sort((a,b)=>a.start-b.start).map((part,index)=>({...part,id:'e2-'+index,index,textHash:sha256(part.text)}));
}

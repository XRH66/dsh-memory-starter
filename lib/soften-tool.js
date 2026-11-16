/** Native tool for an explicit "forget/soften/stop bringing this up" request. */
export function createSoftenTool({logger,onSoftened,softenRawMessage}={}) {
  return {
    name: 'soften_memory',
    description: 'Soft-downweight exactly one saved original message when the user explicitly asks to stop bringing it up, downweight it, soften it, or forget it. This never deletes or rewrites the original: it only lowers default recall ranking. Strong cues can still retrieve it. Pass the exact rawMessageId from an authorized recall block. Do not confirm the downweight until this tool succeeds.',
    parameters: {
      rawMessageId:{type:'string',description:'Exact original message ID from an authorized raw recall block; downweights that source turn, keeping its text.'},
      reason: {type:'string',description:'Short reason from the user request.'},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          kind: { type: 'string' },
          memoryId: { type: 'string' },
          permalink: { type: 'string' },
          basePriority: { type: 'number' },
          effectivePriority: { type: 'number' },
          softenedAt: { type: 'string' },
          bodyUnchanged: { type: 'boolean' },
          summary: { type: 'string' },
          candidates: { type: 'array', items: { type: 'string' } },
          errorCode: { type: 'string' },
          errorMessage: { type: 'string' },
        },
        required: ['ok', 'action', 'kind', 'memoryId', 'permalink', 'basePriority', 'effectivePriority', 'softenedAt', 'bodyUnchanged', 'summary', 'candidates', 'errorCode', 'errorMessage'],
      },
      render(args, value) {
        const lines = [value.summary];
        if (Array.isArray(value.candidates) && value.candidates.length > 0) {
          lines.push('candidates:', ...value.candidates.map((item) => '- ' + item));
        }
        return [{ type: 'text', text: lines.join('\n') }];
      },
    },
    async execute(args, exec) {
      const id=String(args?.rawMessageId??'').trim();
      const runtimeMessage='这次没能读写记忆（技术原因已记录在状态页）。回答时自然地说这次没办成即可，不要提后端、接口、错误码，也不要编造。';
      let raw=null,failure=null;
      if(id)try{raw=await softenRawMessage?.(id);}catch(error){failure={error};}
      const runtimeCode=typeof failure?.error?.code==='string'&&failure.error.code?failure.error.code:'INTERNAL';
      const errorCode=failure?runtimeCode:id?raw?.ok?'':'TARGET_NOT_FOUND':'INVALID_ARGUMENT';
      const errorMessage=errorCode?failure?runtimeMessage:id?'没有找到当前主体可管理的原话，请重新搜索后确认编号。':'请提供要淡化的原话编号。':'';
      const result={ok:!failure&&Boolean(raw?.ok),action:'soften',kind:'raw',memoryId:'',permalink:id?'raw-message:'+id:'',
        basePriority:raw?.weight??0,effectivePriority:raw?.weight??0,softenedAt:raw?.ok?new Date().toISOString():'',bodyUnchanged:true,
        summary:raw?.ok?'已降低该消息所在整轮原句的默认召回权重，原文保留，明确线索仍可召回。':errorMessage,
        candidates:[],errorCode,errorMessage};
      if(failure){
        const detail=failure.error instanceof Error?failure.error.message:String(failure.error);
        logger?.warn?.('[basic-memory-bridge] soften_memory failed: '+runtimeCode+' '+detail);
      }
      if(result.ok)try{await onSoftened?.(exec?.agent?.session?.id,result);}catch(error){logger?.warn?.('[basic-memory-bridge] soften callback failed: '+(error instanceof Error?error.message:String(error)));}
      else if(!failure)logger?.warn?.('[basic-memory-bridge] soften_memory failed: '+result.errorCode+' '+result.errorMessage);
      return result;
    },
  };
}

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
      const raw=id?await softenRawMessage?.(id):null;
      const result={ok:Boolean(raw?.ok),action:'soften',kind:'raw',memoryId:'',permalink:id?'raw-message:'+id:'',
        basePriority:raw?.weight??0,effectivePriority:raw?.weight??0,softenedAt:raw?.ok?new Date().toISOString():'',bodyUnchanged:true,
        summary:raw?.ok?'已降低该消息所在整轮原句的默认召回权重，原文保留，明确线索仍可召回。':
          id?'没有找到当前主体可管理的原消息。':'请提供要淡化的原话 ID。',
        candidates:[],errorCode:raw?.ok?'':id?'TARGET_NOT_FOUND':'INVALID_ARGUMENT',errorMessage:raw?.ok?'':id?'no authorized raw source':'rawMessageId required'};
      if(result.ok)try{await onSoftened?.(exec?.agent?.session?.id,result);}catch(error){logger?.warn?.('[basic-memory-bridge] soften callback failed: '+(error instanceof Error?error.message:String(error)));}
      else logger?.warn?.('[basic-memory-bridge] soften_memory failed: '+result.errorCode+' '+result.errorMessage);
      return result;
    },
  };
}

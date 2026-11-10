import { randomUUID } from 'node:crypto';
import { contentText } from './text.js';
import { RECENT_SOURCE } from './recent-context.js';
import { RAW_RECALL_SOURCE } from './raw-rag/constants.js';
import {MEMORY_HANDOFF_SOURCE} from './memory-contract.js';

// Sources of messages the bridge injected in earlier versions; expiry still removes them
// from model context when an old session continues.
export const CONTEXT_SOURCE = 'basic-memory-context';
const OWN_SOURCES = new Set([CONTEXT_SOURCE, RECENT_SOURCE, RAW_RECALL_SOURCE, 'basic-memory-recall', 'dafeiyu-personal-recall', 'basic-memory-navigation', 'basic-memory-timeline', 'dafeiyu-memory-control', 'memory-answer-rules', 'memory-prefetch']);

/** Strip storage scaffolding, retaining dates only when they describe the event. */
export function memoryBody(text) {
  return String(text || '')
    .replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*#{1,6}[^\n]*$/gm, '')
    .replace(/^\s*-?\s*(?:发生日期|记录日期|笔记首次记录|历史证据|subject|attribute|memory_id|status|recorded_at|occurred_at|requirement_scope|latest_history_permalink|supersedes_memory_id|valid_from|valid_until)\s*[:：].*$/gm, '')
    .replace(/(^|\s+\|\s+)\s*(?:[-*]\s*)?\[(?:preference|fact|event|relationship|decision|history)\]\s*/gm, '$1')
    .replace(/\s+/g,' ').trim();
}

/** Model-only replacements require an already open step; raw events stay intact. */
export function expireMemoryContext(session, { turn, step }, {includeHandoff=false}={}) {
  if (!session?.surface || !session?.append) return { messages: 0, chars: 0 };
  const groups=[]; let group=[]; let chars=0;
  for (const seq of [...session.surface.nodes]) {
    const event=session.log[seq];
    const message=session.deriveEventMessage(event);
    if ((message?.role==='user' && OWN_SOURCES.has(message.source?.kind)) ||
      (includeHandoff&&message?.source?.kind===MEMORY_HANDOFF_SOURCE)) {
      group.push(seq); chars+=contentText(message.content).length;
    } else if (group.length) { groups.push(group); group=[]; }
  }
  if (group.length) groups.push(group);
  if (!groups.length) return { messages: 0, chars: 0 };
  const boundary = session.log.findLast(event => ['turn/start', 'turn/end', 'step/start', 'step/end'].includes(event.type));
  if (boundary?.type !== 'step/start' || boundary.data.turn !== turn || boundary.data.step !== step) {
    throw new Error('memory context expiry requires a matching open turn and step');
  }
  for (const seqs of groups) session.append('developer/message', {
    turn, step,
    message: { id:randomUUID(),role:'developer',content:[],source:{kind:CONTEXT_SOURCE,form:'expired'} },
  }, {surfaceOp:{op:'replace',startSeq:seqs[0],endSeq:seqs.at(-1)},sourceEventSeqs:seqs});
  return { messages:groups.reduce((n,g)=>n+g.length,0),chars };
}

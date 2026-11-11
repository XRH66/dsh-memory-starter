import {createSourceNotice,MEMORY_CHANGE_KINDS} from '../memory-contract.js';
import {textQuery,lexicalMatch} from './lexical.js';
import {contentText} from '../text.js';

function matchesLegacyPayload(saved,core,input){
  // The old writer kept the supplied projection and all content blocks.
  // Match those bytes so changes to discarded fields still conflict on old rows.
  try{
    return saved===JSON.stringify({...core,text:input.text,content:input.content});
  }catch{
    return false;
  }
}

/** Message authority in the existing raw SQLite connection. Retrieval windows
 * are projections; body-only message versions and commit events live here. */
export class RawMessageStore{
  constructor(db,namespace){
    this.db=db;this.namespace=namespace;
    db.function('memory_nfkc',{deterministic:true},value=>String(value??'').normalize('NFKC').toLowerCase());
    db.exec(`
      CREATE TABLE IF NOT EXISTS raw_messages (
        namespace TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
        session_id TEXT NOT NULL, message_id TEXT NOT NULL, turn INTEGER NOT NULL,
        revision INTEGER NOT NULL, position INTEGER NOT NULL, turn_state TEXT NOT NULL,
        withdrawn INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(namespace,owner,project,id)
      );
      CREATE INDEX IF NOT EXISTS raw_messages_turn ON raw_messages(namespace,owner,project,session_id,turn);
      CREATE TABLE IF NOT EXISTS raw_message_versions (
        namespace TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
        revision INTEGER NOT NULL, core_json TEXT NOT NULL, authorization_json TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY(namespace,owner,project,id,revision)
      );
      CREATE TABLE IF NOT EXISTS raw_message_events (
        position INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL,
        owner TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
        revision INTEGER NOT NULL, operation TEXT NOT NULL, notice_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS raw_message_feed ON raw_message_events(namespace,owner,project,position);
      CREATE TABLE IF NOT EXISTS raw_message_projection_receipts (
        namespace TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL,
        consumer TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0,
        failed_position INTEGER, error TEXT,
        PRIMARY KEY(namespace,owner,project,consumer,id)
      );
      CREATE TABLE IF NOT EXISTS raw_message_processing_context (
        namespace TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
        revision INTEGER NOT NULL, context_json TEXT NOT NULL,
        PRIMARY KEY(namespace,owner,project,id,revision)
      );
    `);
  }
  scope(input){
    if(typeof input?.ownerSubject!=='string'||!input.ownerSubject.trim()||typeof input.project!=='string'||!input.project.trim())throw Error('Explicit message owner and project required');
    return [this.namespace(),input.ownerSubject,input.project];
  }
  admit(authorize){if(typeof authorize!=='function'||authorize()!==true)throw Object.assign(Error('Message source authorization changed'),{code:'MEMORY_NOT_AUTHORIZED'});}
  event(source,operation){
    const notice=createSourceNotice({...source,kind:'message',operation});
    const row=this.db.prepare('INSERT INTO raw_message_events(namespace,owner,project,id,revision,operation,notice_json) VALUES(?,?,?,?,?,?,?)')
      .run(this.namespace(),notice.ownerSubject,notice.project,notice.id,notice.revision,operation,JSON.stringify(notice));
    return {...notice,position:Number(row.lastInsertRowid)};
  }
  record(input,{authorize}={}){
    const scope=this.scope(input);
    const identity=createSourceNotice({...input,kind:'message',operation:'saved',revision:1});
    for(const key of ['sequence','turn','rootTurn'])if(!Number.isSafeInteger(input[key])||input[key]<0)throw Error('Trusted message coordinates required');
    if(typeof input.text!=='string'||input.content===undefined)throw Error('Original text projection and payload required');
    const messageState=input.messageState??'committed',turnState=input.turnState??'pending';
    if(!['committed','interrupted'].includes(messageState)||!['pending','completed','interrupted'].includes(turnState))throw Error('Invalid message completion state');
    if(input.time!==null&&input.time!==undefined&&(!Number.isFinite(input.time)||input.time<0))throw Error('Invalid message timestamp');
    // Persist only plain text, not reasoning, tool calls/results or attachments.
    // Rebuild both representations from the same body so opaque payloads cannot
    // survive in core_json while the searchable text appears filtered.
    const text=contentText(input.content),content=text.length?[{type:'text',text}]:[];
    const core={sessionId:identity.sessionId,messageId:identity.messageId,role:identity.role,sequence:input.sequence,turn:input.turn,rootTurn:input.rootTurn,
      text,content,origin:input.origin??null,time:input.time??null,timeKind:input.time==null?'recorded':'message',messageState};
    const json=JSON.stringify(core),authorization=JSON.stringify(input.authorization??null);
    let processing;
    if(input.processingContext!==undefined){
      const value=input.processingContext,target=value?.target;
      if(!['legacy','pipeline-v1'].includes(value?.owner)||target!==null&&(!target||typeof target.provider!=='string'||!target.provider.trim()||typeof target.model!=='string'||!target.model.trim()))throw Error('Invalid frozen processing context');
      processing={owner:value.owner,target:target?{provider:target.provider,model:target.model}:null};
    }
    this.admit(authorize);this.db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.db.prepare('SELECT * FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND id=?').get(...scope,identity.id);
      if(previous){
        const saved=this.db.prepare('SELECT core_json FROM raw_message_versions WHERE namespace=? AND owner=? AND project=? AND id=? AND revision=?').get(...scope,identity.id,previous.revision).core_json;
        const sameCanonicalPayload=saved===json;
        const savedSequence=sameCanonicalPayload?input.sequence:JSON.parse(saved).sequence;
        if(input.sequence<=savedSequence){
          const stale=input.sequence<savedSequence;
          if(!stale&&!sameCanonicalPayload&&!matchesLegacyPayload(saved,core,input))throw Error('A committed native event cannot change its payload');
          const source=this.get({...input,id:identity.id});
          this.db.exec('COMMIT');
          return stale?{skipped:'stale-native-event',notice:null,source}:{duplicate:true,notice:null,source};
        }
      }
      const revision=previous?Number(previous.revision)+1:1;
      const notice=this.event({...identity,revision},previous?'updated':'saved');
      this.db.prepare('INSERT INTO raw_message_versions(namespace,owner,project,id,revision,core_json,authorization_json,recorded_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(...scope,identity.id,revision,json,authorization,Date.now());
      if(processing)this.db.prepare('INSERT INTO raw_message_processing_context(namespace,owner,project,id,revision,context_json) VALUES(?,?,?,?,?,?)')
        .run(...scope,identity.id,revision,JSON.stringify(processing));
      this.db.prepare(`INSERT INTO raw_messages(namespace,owner,project,id,session_id,message_id,turn,revision,position,turn_state,withdrawn)
        VALUES(?,?,?,?,?,?,?,?,?,?,0) ON CONFLICT(namespace,owner,project,id) DO UPDATE SET
        session_id=excluded.session_id,message_id=excluded.message_id,turn=excluded.turn,revision=excluded.revision,position=excluded.position,turn_state=excluded.turn_state`)
        .run(...scope,identity.id,identity.sessionId,identity.messageId,input.turn,revision,notice.position,previous?.turn_state??turnState);
      const source=this.get({...input,id:identity.id});this.db.exec('COMMIT');return {duplicate:false,notice,source};
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  proof(input){
    const scope=this.scope(input),current=this.db.prepare('SELECT revision,withdrawn FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND id=?').get(...scope,input.id);
    if(!current)return null;
    const revision=input.revision??current.revision,row=this.db.prepare('SELECT authorization_json FROM raw_message_versions WHERE namespace=? AND owner=? AND project=? AND id=? AND revision=?').get(...scope,input.id,revision);
    return row?{id:input.id,revision:Number(revision),isCurrent:Number(revision)===Number(current.revision),withdrawn:Boolean(current.withdrawn),authorization:JSON.parse(row.authorization_json)}:null;
  }
  get(input){
    const scope=this.scope(input);
    const current=this.db.prepare('SELECT * FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND id=?').get(...scope,input.id);
    if(!current||current.withdrawn&&!input.includeWithdrawn)return null;
    const revision=input.revision??current.revision;
    const version=this.db.prepare('SELECT * FROM raw_message_versions WHERE namespace=? AND owner=? AND project=? AND id=? AND revision=?').get(...scope,input.id,revision);
    if(!version)return null;
    const processing=this.db.prepare('SELECT context_json FROM raw_message_processing_context WHERE namespace=? AND owner=? AND project=? AND id=? AND revision=?').get(...scope,input.id,revision);
    return {...JSON.parse(version.core_json),...processing?{processingContext:JSON.parse(processing.context_json)}:{},id:input.id,ownerSubject:input.ownerSubject,project:input.project,
      revision:Number(revision),currentRevision:Number(current.revision),isCurrent:Number(revision)===Number(current.revision),
      position:Number(current.position),turnState:current.turn_state,withdrawn:Boolean(current.withdrawn),
      recordedAt:version.recorded_at,authorization:JSON.parse(version.authorization_json)};
  }
  list(input){
    const scope=this.scope(input),limit=input.limit??50,before=input.beforePosition??Number.MAX_SAFE_INTEGER;
    if(!Number.isSafeInteger(limit)||limit<1||!Number.isSafeInteger(before)||before<0)throw Error('Invalid message page');
    const session=input.sessionId;
    const rows=this.db.prepare(`SELECT id,position FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND withdrawn=0 AND position<?
      ${session?'AND session_id=?':''} ORDER BY position DESC LIMIT ?`).all(...scope,before,...session?[session]:[],limit);
    return {sources:rows.map(row=>this.get({...input,id:row.id})),nextBefore:rows.length===limit?Number(rows.at(-1).position):null};
  }
  search(input){
    const scope=this.scope(input),parsed=textQuery(input?.query),limit=input?.limit??20;
    if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw Error('Invalid message search limit');
    if(!parsed)return {sources:[],partial:false};
    const terms=JSON.stringify(parsed.terms.map(term=>term.slice(2)));
    const rows=this.db.prepare(`SELECT m.id FROM raw_messages m
      JOIN raw_message_versions v ON m.namespace=v.namespace AND m.owner=v.owner AND m.project=v.project AND m.id=v.id AND m.revision=v.revision
      WHERE m.namespace=? AND m.owner=? AND m.project=? AND m.withdrawn=0
        AND EXISTS(SELECT 1 FROM json_each(?) term WHERE instr(memory_nfkc(json_extract(v.core_json,'$.text')),term.value)>0)
      ORDER BY COALESCE(json_extract(v.core_json,'$.time'),v.recorded_at) DESC,m.position DESC LIMIT ?`)
      .all(...scope,terms,limit*8);
    const sources=rows.map(row=>this.get({...input,id:row.id}))
      .map(source=>({...source,lexicalScore:lexicalMatch(input.query,source.text)}))
      .filter(source=>source.lexicalScore>0);
    return {sources:sources.slice(0,limit),partial:rows.length===limit*8};
  }
  recentSources(input){
    const scope=this.scope(input),limit=input.limit??40;
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid recent source limit');
    const rows=this.db.prepare(`SELECT m.id FROM raw_messages m
      JOIN raw_message_versions v ON m.namespace=v.namespace AND m.owner=v.owner AND m.project=v.project AND m.id=v.id AND m.revision=v.revision
      WHERE m.namespace=? AND m.owner=? AND m.project=? AND m.withdrawn=0
        AND COALESCE(json_extract(v.core_json,'$.time'),v.recorded_at)>=? AND COALESCE(json_extract(v.core_json,'$.time'),v.recorded_at)<=?
      ORDER BY COALESCE(json_extract(v.core_json,'$.time'),v.recorded_at) DESC,json_extract(v.core_json,'$.sequence') DESC,m.id LIMIT ?`)
      .all(...scope,input.since??0,input.until??Number.MAX_SAFE_INTEGER,limit);
    return rows.map(row=>this.get({...input,id:row.id}));
  }
  searchPending(input){
    const scope=this.scope(input),parsed=textQuery(input.query),limit=Math.min(40,Math.max(1,input.limit??40));
    if(!parsed)return {sources:[],partial:false};
    const since=input.since??0,until=input.until??Number.MAX_SAFE_INTEGER;
    const rows=this.db.prepare(`SELECT m.id FROM raw_messages m
      JOIN raw_message_versions v ON m.namespace=v.namespace AND m.owner=v.owner AND m.project=v.project AND m.id=v.id AND m.revision=v.revision
      LEFT JOIN raw_message_projection_receipts p ON m.namespace=p.namespace AND m.owner=p.owner AND m.project=p.project AND m.id=p.id AND p.consumer='raw-text-v1'
      WHERE m.namespace=? AND m.owner=? AND m.project=? AND m.withdrawn=0 AND m.position>COALESCE(p.position,0)
        AND COALESCE(json_extract(v.core_json,'$.time'),v.recorded_at)>=? AND COALESCE(json_extract(v.core_json,'$.time'),v.recorded_at)<=?
        AND EXISTS(SELECT 1 FROM json_each(?) term WHERE instr(memory_nfkc(json_extract(v.core_json,'$.text')),term.value)>0)
      ORDER BY m.position DESC LIMIT ?`).all(...scope,since,until,JSON.stringify(parsed.terms.map(term=>term.slice(2))),limit*8);
    const sources=rows.map(row=>this.get({...input,id:row.id})).map(source=>({...source,lexicalScore:lexicalMatch(input.query,source.text)}))
      .filter(source=>source.lexicalScore>0).sort((a,b)=>b.lexicalScore-a.lexicalScore||b.position-a.position).slice(0,limit);
    return {sources,partial:rows.length===limit*8};
  }
  forTurn(input){
    const scope=this.scope(input);
    return this.db.prepare('SELECT id FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND session_id=? AND turn=? AND withdrawn=0')
      .all(...scope,input.sessionId,input.turn).map(row=>this.get({...input,id:row.id})).sort((a,b)=>a.sequence-b.sequence);
  }
  embeddingSlots(input){
    // Keep withdrawn slots in the sequence. Only the query reader opens bodies.
    return this.db.prepare(`SELECT m.id,m.revision,json_extract(v.core_json,'$.sequence') sequence,
      json_extract(v.authorization_json,'$.intervalId') intervalId
      FROM raw_messages m LEFT JOIN raw_message_versions v ON v.namespace=m.namespace AND v.owner=m.owner
        AND v.project=m.project AND v.id=m.id AND v.revision=m.revision
      WHERE m.namespace=? AND m.owner=? AND m.project=? AND m.session_id=? AND m.turn=?`)
      .all(...this.scope(input),input.sessionId,input.turn)
      .map(({id,revision,sequence,intervalId})=>({sequence,intervalId,ref:{storage:'message',id,revision}}));
  }
  changes(input){
    const scope=this.scope(input),after=input.after??0,limit=input.limit??100;
    if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid message cursor');
    return this.db.prepare('SELECT position,notice_json FROM raw_message_events WHERE namespace=? AND owner=? AND project=? AND position>? ORDER BY position LIMIT ?')
      .all(...scope,after,limit).map(row=>({...JSON.parse(row.notice_json),position:Number(row.position)}));
  }
  projectionWork(input){
    const scope=this.scope(input),after=input.after??0,limit=input.limit??24;
    if(!['raw-text-v1','recent-v1','pipeline-v1'].includes(input.consumer)||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid projection work page');
    // Recovery discovers identities and saved proofs only. The body is read
    // separately after validation of that exact original credential.
    return this.db.prepare(`SELECT m.id,m.revision,m.position,v.authorization_json,r.error,r.failed_position FROM raw_messages m
      JOIN raw_message_versions v ON m.namespace=v.namespace AND m.owner=v.owner AND m.project=v.project AND m.id=v.id AND m.revision=v.revision
      LEFT JOIN raw_message_projection_receipts r ON m.namespace=r.namespace AND m.owner=r.owner AND m.project=r.project AND m.id=r.id AND r.consumer=?
      LEFT JOIN raw_message_processing_context c ON m.namespace=c.namespace AND m.owner=c.owner AND m.project=c.project AND m.id=c.id AND m.revision=c.revision
      WHERE m.namespace=? AND m.owner=? AND m.project=? AND m.withdrawn=0 AND m.position>? AND m.position>COALESCE(r.position,0)
      ${input.consumer==='pipeline-v1'?"AND json_extract(c.context_json,'$.owner')='pipeline-v1'":''}
      ${input.sessionId?'AND m.session_id=?':''}
      ORDER BY m.position LIMIT ?`).all(input.consumer,...scope,after,...input.sessionId?[input.sessionId]:[],limit).map(row=>({ownerSubject:input.ownerSubject,project:input.project,
        id:row.id,revision:Number(row.revision),position:Number(row.position),authorization:JSON.parse(row.authorization_json),
        error:row.failed_position===row.position?row.error:null}));
  }
  projectionReceipt(input,{authorize}={}){
    const scope=this.scope(input);
    if(!['raw-text-v1','recent-v1','pipeline-v1'].includes(input.consumer))throw Error('Unknown message projection');
    this.admit(authorize);
    const current=this.db.prepare('SELECT revision,position,withdrawn FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND id=?').get(...scope,input.id);
    if(!current||current.withdrawn||current.revision!==input.revision||current.position!==input.position)return false;
    if(input.error){
      this.db.prepare(`INSERT INTO raw_message_projection_receipts(namespace,owner,project,consumer,id,failed_position,error) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(namespace,owner,project,consumer,id) DO UPDATE SET failed_position=excluded.failed_position,error=excluded.error`)
        .run(...scope,input.consumer,input.id,input.position,String(input.error));
    }else{
      this.db.prepare(`INSERT INTO raw_message_projection_receipts(namespace,owner,project,consumer,id,position) VALUES(?,?,?,?,?,?)
        ON CONFLICT(namespace,owner,project,consumer,id) DO UPDATE SET position=excluded.position,failed_position=NULL,error=NULL`)
        .run(...scope,input.consumer,input.id,input.position);
    }
    return true;
  }
  completeTurn(input,{authorize}={}){
    const scope=this.scope(input);
    if(!['completed','interrupted'].includes(input.state)||!Number.isSafeInteger(input.turn)||input.turn<0)throw Error('Invalid turn completion');
    this.admit(authorize);this.db.exec('BEGIN IMMEDIATE');
    try{
      const rows=this.db.prepare('SELECT id FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND session_id=? AND turn=? AND withdrawn=0 AND turn_state<>?')
        .all(...scope,input.sessionId,input.turn,input.state);
      const sources=rows.map(row=>this.get({...input,id:row.id}));
      // A priority hint travels with the completed source even if the
      // process stops before the semantic projection consumes its notice.
      const changeKind=input.state==='completed'&&MEMORY_CHANGE_KINDS.includes(input.changeKind)&&
        ['user','assistant'].every(role=>sources.some(source=>source.role===role&&source.messageState==='committed'&&source.text.trim()))
        ?input.changeKind:null;
      const notices=sources.map(current=>{
        if(changeKind&&current.processingContext?.owner==='pipeline-v1'){
          this.db.prepare('UPDATE raw_message_processing_context SET context_json=? WHERE namespace=? AND owner=? AND project=? AND id=? AND revision=?')
            .run(JSON.stringify({...current.processingContext,changeKind}),...scope,current.id,current.revision);
        }
        const notice=this.event(current,'updated');
        this.db.prepare('UPDATE raw_messages SET turn_state=?,position=? WHERE namespace=? AND owner=? AND project=? AND id=?')
          .run(input.state,notice.position,...scope,current.id);return notice;
      });
      this.db.exec('COMMIT');return notices;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  withdrawnIds(input){
    return this.db.prepare('SELECT id FROM raw_messages WHERE namespace=? AND owner=? AND project=? AND withdrawn=1').all(...this.scope(input)).map(row=>row.id);
  }
  withdraw(input,{authorize}={}){
    const scope=this.scope(input);this.admit(authorize);this.db.exec('BEGIN IMMEDIATE');
    try{
      const source=this.get({...input,includeWithdrawn:true});
      if(!source||source.withdrawn){this.db.exec('COMMIT');return null;}
      const notice=this.event(source,'withdrawn');
      this.db.prepare('UPDATE raw_messages SET withdrawn=1,position=? WHERE namespace=? AND owner=? AND project=? AND id=?').run(notice.position,...scope,input.id);
      this.db.exec('COMMIT');return notice;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
}

import {indexText,textQuery,lexicalOverlap} from './raw-rag/lexical.js';

/** Structured entries, their searchable text and write receipts in the library SQLite connection.
 * The projection carries the body so retrieval never needs a Basic Memory round trip; Markdown
 * stays the edit surface and every read/commit/vault change re-projects it. */
export class MemoryEntryIndex{
  constructor(db,namespace=()=> 'default'){
    this.db=db;this.namespace=namespace;
    db.exec(`CREATE TABLE IF NOT EXISTS structured_entries (
      namespace TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
      permalink TEXT NOT NULL, revision TEXT NOT NULL, metadata_json TEXT NOT NULL,
      PRIMARY KEY(namespace,owner,project,id));
      CREATE TABLE IF NOT EXISTS structured_entry_operations (
      namespace TEXT NOT NULL, owner TEXT NOT NULL, project TEXT NOT NULL, id TEXT NOT NULL,
      state TEXT NOT NULL, payload_json TEXT NOT NULL, result_json TEXT,
      PRIMARY KEY(namespace,owner,project,id));`);
    if(!db.prepare('PRAGMA table_info(structured_entries)').all().some(column=>column.name==='content'))
      db.exec("ALTER TABLE structured_entries ADD COLUMN content TEXT NOT NULL DEFAULT ''");
    try{db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS structured_entry_text USING fts5(terms,entry_key UNINDEXED)');this.textSearch=true;}
    catch(error){if(!/no such module: fts5/i.test(error.message))throw error;this.textSearch=false;}
  }
  key(input){return JSON.stringify([...this.scope(input),input.id]);}
  reindex(input,text){
    if(!this.textSearch)return;const key=this.key(input);
    this.db.prepare('DELETE FROM structured_entry_text WHERE entry_key=?').run(key);
    if(text!==undefined)this.db.prepare('INSERT INTO structured_entry_text(terms,entry_key) VALUES(?,?)').run(indexText(text),key);
  }
  scope(input){
    if(!input?.ownerSubject||!input.project)throw Error('Explicit entry owner and project required');
    return [this.namespace(),input.ownerSubject,input.project];
  }
  get(input){const row=this.db.prepare('SELECT * FROM structured_entries WHERE namespace=? AND owner=? AND project=? AND id=?').get(...this.scope(input),input.id);
    return row?{id:row.id,permalink:row.permalink,revision:row.revision,...JSON.parse(row.metadata_json),...row.content?{content:row.content}:{}}:null;}
  project(input){
    const {content,id,permalink,revision,...metadata}=input.entry;
    this.db.prepare(`INSERT INTO structured_entries(namespace,owner,project,id,permalink,revision,metadata_json,content) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(namespace,owner,project,id) DO UPDATE SET permalink=excluded.permalink,revision=excluded.revision,metadata_json=excluded.metadata_json,content=excluded.content`)
      .run(...this.scope(input),input.id,input.permalink,String(input.revision),JSON.stringify(metadata),String(content??''));
    this.reindex(input,`${metadata.title??''}
${content??''}`);
    return this.get(input);
  }
  remove(input){this.db.prepare('DELETE FROM structured_entries WHERE namespace=? AND owner=? AND project=? AND id=?').run(...this.scope(input),input.id);this.reindex(input);}
  /** Local full-text candidates (same tokenizer as originals), best first. Entries projected
   * before the content column existed have no text yet and are found once re-projected. */
  search(input){
    const limit=input.limit??20,parsed=textQuery(input.query??'');
    if(!parsed||!this.textSearch)return [];
    const [namespace,owner,project]=this.scope(input),prefix=JSON.stringify([namespace,owner,project]).slice(0,-1)+',';
    const rows=this.db.prepare(`SELECT entry_key,rank FROM structured_entry_text WHERE structured_entry_text MATCH ? AND substr(entry_key,1,?)=? ORDER BY rank LIMIT ?`)
      .all(parsed.match,prefix.length,prefix,limit*2);
    return rows.map(row=>this.get({...input,id:JSON.parse(row.entry_key)[3]})).filter(Boolean)
      .map(entry=>({...entry,lexicalScore:lexicalOverlap(input.query,`${entry.title??''}
${entry.content??''}`)}))
      .filter(entry=>entry.lexicalScore>0).slice(0,limit);
  }
  list(input){
    const limit=input.limit??50,after=input.afterId??'';
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('Invalid entry page');
    const conditions=[],values=[];
    for(const [field,jsonPath] of [['type','$.type'],['validity','$.state.validity'],['progress','$.state.progress'],['subject','$.subject_ref']])if(input[field]){conditions.push('json_extract(metadata_json,?)=?');values.push(jsonPath,input[field]);}
    if(input.tag){conditions.push("EXISTS(SELECT 1 FROM json_each(json_extract(metadata_json,'$.tags')) WHERE value=?)");values.push(input.tag);}
    const rows=this.db.prepare(`SELECT id FROM structured_entries WHERE namespace=? AND owner=? AND project=? AND id>?
      ${conditions.length?'AND '+conditions.join(' AND '):''} ORDER BY id LIMIT ?`).all(...this.scope(input),after,...values,limit);
    return {entries:rows.map(row=>this.get({...input,id:row.id})),nextAfter:rows.length===limit?rows.at(-1).id:null};
  }
  operation(input){const row=this.db.prepare('SELECT state,payload_json,result_json FROM structured_entry_operations WHERE namespace=? AND owner=? AND project=? AND id=?')
    .get(...this.scope(input),input.operationId);
    return row?{state:row.state,payload:JSON.parse(row.payload_json),result:row.result_json?JSON.parse(row.result_json):null}:null;}
  prepare(input){
    this.db.prepare('INSERT OR IGNORE INTO structured_entry_operations(namespace,owner,project,id,state,payload_json) VALUES(?,?,?,?,?,?)')
      .run(...this.scope(input),input.operationId,'prepared',JSON.stringify(input.payload));
    return this.operation(input);
  }
  checkpoint(input){
    if(!['prepared','writing','review','committed','rejected'].includes(input.state))throw Error('Invalid entry write state');
    this.db.prepare('UPDATE structured_entry_operations SET state=?,result_json=?,payload_json=COALESCE(?,payload_json) WHERE namespace=? AND owner=? AND project=? AND id=?')
      .run(input.state,input.result?JSON.stringify(input.result):null,input.payload?JSON.stringify(input.payload):null,...this.scope(input),input.operationId);
    return this.operation(input);
  }
  approveReview(input){
    this.db.prepare("UPDATE structured_entry_operations SET state='prepared',payload_json=? WHERE namespace=? AND owner=? AND project=? AND id=? AND state='review'")
      .run(JSON.stringify(input.payload),...this.scope(input),input.operationId);
  }
  reviews(input){
    const limit=input.limit??-1;
    return this.db.prepare(`SELECT id FROM structured_entry_operations WHERE namespace=? AND owner=? AND project=? AND id>?
      AND (state='review' OR (state IN ('prepared','writing') AND json_extract(payload_json,'$.approved')=1)) ORDER BY id LIMIT ?`)
      .all(...this.scope(input),input.afterId??'',limit).map(row=>({operationId:row.id,...this.operation({...input,operationId:row.id})}));
  }
}

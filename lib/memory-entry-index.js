/** Rebuildable structured-note metadata and write receipts in the existing
 * library SQLite connection. Markdown is always the body authority. */
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
  }
  scope(input){
    if(!input?.ownerSubject||!input.project)throw Error('Explicit entry owner and project required');
    return [this.namespace(),input.ownerSubject,input.project];
  }
  get(input){const row=this.db.prepare('SELECT * FROM structured_entries WHERE namespace=? AND owner=? AND project=? AND id=?').get(...this.scope(input),input.id);
    return row?{id:row.id,permalink:row.permalink,revision:row.revision,...JSON.parse(row.metadata_json)}:null;}
  project(input){
    const {content,id,permalink,revision,...metadata}=input.entry;
    this.db.prepare(`INSERT INTO structured_entries(namespace,owner,project,id,permalink,revision,metadata_json) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(namespace,owner,project,id) DO UPDATE SET permalink=excluded.permalink,revision=excluded.revision,metadata_json=excluded.metadata_json`)
      .run(...this.scope(input),input.id,input.permalink,String(input.revision),JSON.stringify(metadata));
    return this.get(input);
  }
  remove(input){this.db.prepare('DELETE FROM structured_entries WHERE namespace=? AND owner=? AND project=? AND id=?').run(...this.scope(input),input.id);}
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

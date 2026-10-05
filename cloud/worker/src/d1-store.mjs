import { automationSummary } from './submission-journal.mjs';
const encode = value => JSON.stringify(value);
export const sha256 = async bytes => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2,'0')).join('');
const fail = (message,status=409) => { throw Object.assign(new Error(message),{status}); };
const chunkBytes=4*1024*1024;

// R2 objects are immutable, content addressed and committed before D1 pointers.
// A failed CAS leaves a recoverable object, never a pointer to missing content.
export class D1Store {
  constructor(db,bucket,workspace){this.db=db;this.bucket=bucket;this.workspace=workspace;}
  async object(value){
    const text=encode(value), bytes=new TextEncoder().encode(text);
    const checksum=await sha256(bytes);
    if(bytes.length>8*1024*1024){
      const parts=[];
      for(let offset=0;offset<bytes.length;offset+=chunkBytes){
        const part=bytes.subarray(offset,Math.min(offset+chunkBytes,bytes.length)),digest=await sha256(part),key=`${this.workspace}/d1/chunks/${digest}.bin`;
        if(!await this.bucket.head(key))await this.bucket.put(key,part,{httpMetadata:{contentType:'application/octet-stream'},customMetadata:{sha256:digest}});
        parts.push({checksum:digest,bytes:part.length});
      }
      const manifest=new TextEncoder().encode(encode({format:'externallink-chunked-json',version:1,checksum,bytes:bytes.length,parts})),digest=await sha256(manifest),key=`${this.workspace}/d1/manifests/${digest}.json`;
      if(!await this.bucket.head(key))await this.bucket.put(key,manifest,{httpMetadata:{contentType:'application/json'},customMetadata:{sha256:digest}});
      return{key,checksum,bytes:bytes.length};
    }
    const key=`${this.workspace}/d1/objects/${checksum}.json`;
    // Repeated retries do not create more objects or read the full old value.
    if(!await this.bucket.head(key))await this.bucket.put(key,bytes,{httpMetadata:{contentType:'application/json'},customMetadata:{sha256:checksum}});
    return{key,checksum,bytes:bytes.length};
  }
  async readObjectBytes(key,checksum){
    const prefix=`${this.workspace}/d1/`,manifestPrefix=prefix+'manifests/';
    if(typeof key!=='string'||!key.startsWith(prefix)||!/^([a-f0-9]{64})\.json$/.test(key.slice(key.startsWith(manifestPrefix)?manifestPrefix.length:(prefix+'objects/').length))||(!key.startsWith(manifestPrefix)&&!key.startsWith(prefix+'objects/')))fail('数据对象工作区或校验地址无效',503);
    const object=await this.bucket.get(key);
    if(!object)fail('迁移数据对象缺失',503);
    const bytes=await object.arrayBuffer();
    if(key.startsWith(manifestPrefix)){
      if(await sha256(bytes)!==key.slice(manifestPrefix.length,-5))fail('分段清单校验失败',503);
      let manifest;try{manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail('分段清单校验失败',503);}
      if(manifest.format!=='externallink-chunked-json'||manifest.version!==1||manifest.checksum!==checksum||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<=0||!Array.isArray(manifest.parts)||!manifest.parts.length||manifest.parts.length>10000||manifest.parts.some(p=>!p||!/^[a-f0-9]{64}$/.test(p.checksum)||!Number.isInteger(p.bytes)||p.bytes<=0||p.bytes>chunkBytes)||manifest.parts.reduce((n,p)=>n+p.bytes,0)!==manifest.bytes)fail('分段清单校验失败',503);
      const assembled=new Uint8Array(manifest.bytes);let offset=0;
      for(const part of manifest.parts){
        const value=await this.bucket.get(`${this.workspace}/d1/chunks/${part.checksum}.bin`);if(!value)fail('迁移数据分段对象缺失',503);
        const content=await value.arrayBuffer();if(content.byteLength!==part.bytes||await sha256(content)!==part.checksum)fail('数据分段校验失败',503);
        assembled.set(new Uint8Array(content),offset);offset+=part.bytes;
      }
      if(await sha256(assembled)!==checksum)fail('完整数据校验失败',503);
      return assembled;
    }
    if(await sha256(bytes)!==checksum)fail('数据校验失败',503);
    return new Uint8Array(bytes);
  }
  async readObject(key,checksum){
    return JSON.parse(new TextDecoder().decode(await this.readObjectBytes(key,checksum)));
  }
  async revisions(){
    const rows=await this.db.prepare('SELECT key,revision FROM documents WHERE workspace=? ORDER BY key').bind(this.workspace).all();
    return Object.fromEntries(rows.results.map(r=>[r.key,r.revision]));
  }
  async document(key){
    const row=await this.db.prepare('SELECT * FROM documents WHERE workspace=? AND key=?').bind(this.workspace,key).first();
    return row?{data:await this.readObject(row.object_key,row.checksum),revision:row.revision,updatedAt:row.updated_at}:null;
  }
  async putDocument(key,data,expectedRevision){
    if(!Number.isInteger(expectedRevision)||expectedRevision<0)fail('缺少有效版本号',400);
    const previous=await this.db.prepare('SELECT revision,checksum FROM documents WHERE workspace=? AND key=?').bind(this.workspace,key).first();
    if((previous?.revision||0)!==expectedRevision)fail('其他客户端已更新资料，请先回读');
    const object=await this.object(data);
    if(previous?.checksum===object.checksum)return{revision:previous.revision,unchanged:true};
    const at=new Date().toISOString(),revision=expectedRevision+1;
    const sql=`INSERT INTO documents(workspace,key,revision,object_key,checksum,bytes,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(workspace,key) DO UPDATE SET revision=excluded.revision,object_key=excluded.object_key,
      checksum=excluded.checksum,bytes=excluded.bytes,updated_at=excluded.updated_at WHERE documents.revision=?`;
    const result=await this.db.batch([
      this.db.prepare(sql).bind(this.workspace,key,revision,object.key,object.checksum,object.bytes,at,expectedRevision),
      this.db.prepare(`INSERT OR IGNORE INTO document_history SELECT workspace,key,revision,object_key,checksum,updated_at
        FROM documents WHERE workspace=? AND key=? AND revision=? AND checksum=?`).bind(this.workspace,key,revision,object.checksum),
    ]);
    if(result[0].meta.changes!==1)fail('资料发生并发变更，请先回读');
    return{revision,updatedAt:at};
  }
  async importTask(task){
    if(!task?.id||!task.profileId||!task.url)fail('任务身份不完整',400);
    const object=await this.object(task);
    const summary={...automationSummary(task),reason:String(task.reason||'').slice(0,2000),
      receipt:task.receipt?{publicationStatus:task.receipt.publicationStatus,publicUrl:task.receipt.publicUrl}:undefined,reviewStatus:task.reviewStatus,
      source:'recovered_local',syncStatus:'recovery_verified',updatedAt:task.updatedAt||null};
    // Recovery imports never overwrite later edits or silently reconcile conflicts.
    const existing=await this.db.prepare('SELECT checksum FROM journal_tasks WHERE workspace=? AND id=?').bind(this.workspace,task.id).first();
    if(existing){if(existing.checksum!==object.checksum)fail('恢复任务已有不同版本');return{duplicate:true,checksum:object.checksum};}
    const result=await this.db.prepare(`INSERT OR IGNORE INTO journal_tasks(workspace,id,profile_id,destination,summary,object_key,checksum,updated_at) VALUES(?,?,?,?,?,?,?,?)`)
      .bind(this.workspace,task.id,task.profileId,task.destinationKey||new URL(task.url).hostname,encode(summary),object.key,object.checksum,new Date().toISOString()).run();
    if(!result.meta.changes){const row=await this.db.prepare('SELECT checksum FROM journal_tasks WHERE workspace=? AND id=?').bind(this.workspace,task.id).first();if(row.checksum!==object.checksum)fail('恢复任务发生并发冲突');}
    return{checksum:object.checksum};
  }
  async journal(query){
    if(query.get('taskId')){
      const row=await this.db.prepare('SELECT object_key,checksum,item_index FROM journal_tasks WHERE workspace=? AND id=?').bind(this.workspace,query.get('taskId')).first();
      const object=row?await this.readObject(row.object_key,row.checksum):null;
      return{ok:true,task:row&&row.item_index!==null?object[row.item_index]:object};
    }
    const limit=Math.max(1,Math.min(200,Math.floor(Number(query.get('limit'))||100))),after=query.get('after')||'';
    const profile=query.get('profileId');
    const statement=profile?this.db.prepare('SELECT id,summary FROM journal_tasks WHERE workspace=? AND profile_id=? AND id>? ORDER BY id LIMIT ?').bind(this.workspace,profile,after,limit+1)
      :this.db.prepare('SELECT id,summary FROM journal_tasks WHERE workspace=? AND id>? ORDER BY id LIMIT ?').bind(this.workspace,after,limit+1);
    const {results}=await statement.all();
    return{ok:true,tasks:results.slice(0,limit).map(r=>JSON.parse(r.summary)),next:results.length>limit?results[limit-1].id:null};
  }
  async archive(id,kind,data){
    const object=await this.object(data);
    await this.db.prepare('INSERT OR IGNORE INTO recovery_objects VALUES(?,?,?,?,?,?,?)')
      .bind(this.workspace,id,kind,object.key,object.checksum,object.bytes,new Date().toISOString()).run();
    const row=await this.db.prepare('SELECT checksum FROM recovery_objects WHERE workspace=? AND id=?').bind(this.workspace,id).first();
    if(row.checksum!==object.checksum)fail('恢复档案 ID 已存在但内容不同');
    return object;
  }
}

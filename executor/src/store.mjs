import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export class Store {
  constructor(file, options = {}) {
    this.db = new DatabaseSync(file, { readOnly: options.readOnly === true });
    this.db.exec('PRAGMA busy_timeout=5000');
    if (options.readOnly) return;
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS state (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL, scope TEXT NOT NULL, run_id TEXT, task_id TEXT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_profiles (id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, workspace_id TEXT NOT NULL, device_id TEXT NOT NULL, saved_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_state (connection_id TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(connection_id,id));
      CREATE TABLE IF NOT EXISTS connection_outbox (connection_id TEXT NOT NULL, seq INTEGER NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(connection_id,id));
      CREATE TABLE IF NOT EXISTS connection_audit (connection_id TEXT NOT NULL, seq INTEGER NOT NULL, event_id TEXT NOT NULL, scope TEXT NOT NULL, run_id TEXT, task_id TEXT, value TEXT NOT NULL, PRIMARY KEY(connection_id,event_id));
      CREATE TABLE IF NOT EXISTS connection_commits (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, pair_sha256 TEXT NOT NULL, result TEXT NOT NULL);`);
  }
  get(id) { const row = this.db.prepare('SELECT value FROM state WHERE id=?').get(id); return row ? JSON.parse(row.value) : null; }
  acquireOwner() {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const owner = this.db.prepare('SELECT pid FROM owner WHERE id=1').get();
      if (owner && owner.pid !== process.pid) {
        let alive = true; try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error(`本机执行器已运行，PID ${owner.pid}`);
      }
      this.db.prepare('INSERT INTO owner VALUES (1,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid').run(process.pid);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  set(id, value) { this.db.prepare('INSERT INTO state VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value').run(id, JSON.stringify(value)); return value; }
  values(prefix) { return this.db.prepare('SELECT value FROM state WHERE id LIKE ? ORDER BY id').all(prefix + '%').map(x => JSON.parse(x.value)); }
  valuesByInsertion(prefix) { return this.db.prepare('SELECT value FROM state WHERE id LIKE ? ORDER BY rowid').all(prefix + '%').map(x => JSON.parse(x.value)); }
  transition(task, type, stateChanges={}) {
    const event = { id: randomUUID(), taskId: task.id, version: task.version, at: new Date().toISOString(), type, state: structuredClone(task) };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const [key,value]of Object.entries(stateChanges))this.set(key,value);
      this.set(`task:${task.id}`, task);
      this.db.prepare('INSERT INTO outbox(id,value) VALUES (?,?)').run(event.id, JSON.stringify(event));
      this.appendLog({id:event.id,at:event.at,type,runId:task.runId,taskId:task.id,profileId:task.profileId,url:task.url,status:task.status,reason:task.reason||''});
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return event;
  }
  pending() { return this.db.prepare('SELECT id,value FROM outbox ORDER BY seq').all().map(x => JSON.parse(x.value)); }
  transitionMany(changes,stateChanges={}) {
    const events=changes.map(({task,type})=>({id:randomUUID(),taskId:task.id,version:task.version,at:new Date().toISOString(),type,state:structuredClone(task)}));
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for(const [key,value]of Object.entries(stateChanges))this.set(key,value);
      for(const event of events){this.set('task:'+event.taskId,event.state);this.db.prepare('INSERT INTO outbox(id,value) VALUES (?,?)').run(event.id,JSON.stringify(event));this.appendLog({id:event.id,at:event.at,type:event.type,runId:event.state.runId,taskId:event.taskId,profileId:event.state.profileId,url:event.state.url,status:event.state.status,reason:event.state.reason||''});}
      this.db.exec('COMMIT');return events;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  appendLog(entry){const pair=this.get('pair'),scope=String(pair?.endpoint||'')+'|'+String(pair?.workspaceId||'default');this.db.prepare('INSERT OR IGNORE INTO audit_log(event_id,scope,run_id,task_id,value) VALUES (?,?,?,?,?)').run(entry.id||randomUUID(),scope,entry.runId||null,entry.taskId||null,JSON.stringify(entry));}
  logs({scope,runId,taskId,after=0}={}){if(!Number.isSafeInteger(after)||after<0)throw Error('日志游标无效');const conditions=['scope=?','seq>?'],values=[scope,after];for(const [column,value]of [['run_id',runId],['task_id',taskId]])if(value){conditions.push(column+'=?');values.push(value);}const rows=this.db.prepare('SELECT seq,value FROM audit_log WHERE '+conditions.join(' AND ')+' ORDER BY seq LIMIT 501').all(...values);return{entries:rows.slice(0,500).map(row=>({seq:row.seq,...JSON.parse(row.value)})),next:rows.length>500?rows[499].seq:null};}
  pendingCount() { return this.db.prepare('SELECT count(*) AS total FROM outbox').get().total; }
  exportLogs({scope,taskIds=[],runIds=[]}) {
    const highWater=this.db.prepare('SELECT max(seq) AS n FROM audit_log WHERE scope=?').get(scope).n||0;
    const rows=this.db.prepare(`SELECT seq,value FROM audit_log WHERE scope=? AND seq<=?
      AND (task_id IN (SELECT value FROM json_each(?)) OR
        (task_id IS NULL AND run_id IN (SELECT value FROM json_each(?)))) ORDER BY seq`)
      .all(scope,highWater,JSON.stringify(taskIds),JSON.stringify(runIds));
    return {highWater,entries:rows.map(row=>({...JSON.parse(row.value),seq:row.seq}))};
  }
  pendingBatch(limit=100) { return this.db.prepare('SELECT value FROM outbox ORDER BY seq LIMIT ?').all(limit).map(x=>JSON.parse(x.value)); }
  pendingSummary() { return this.db.prepare("SELECT id,json_extract(value,'$.taskId') AS taskId FROM outbox ORDER BY seq").all(); }
  ack(id) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  recover({taskIds}={}) {
    const selected=taskIds&&new Set(taskIds);
    for (const task of this.values('task:')) {
      if(selected&&!selected.has(task.id))continue;
      if(task.controller==='ai'&&!task.attemptBoundary&&!task.receipt){
        this.transition({...task,controller:'executor',aiTakeover:{...task.aiTakeover,interruptedAt:new Date().toISOString(),reason:'后台重启，原 AI 动作预算保留；重新观察原页后恢复'}},'recovered_ai_control');
        task.controller='executor';task.aiTakeover=this.get('task:'+task.id).aiTakeover;
      }
      const resolvedAttempt = task.attemptBoundary && task.status === 'needs_manual' && ['rejected','not_submitted'].includes(task.siteStatus);
      if (task.status === 'submitting' || (task.attemptBoundary && !resolvedAttempt && !['submitted_unconfirmed','finished'].includes(task.status))) {
        if (!task.receipt) this.transition({ ...task, status: 'submitted_unconfirmed', siteStatus: 'sent_unconfirmed', reason: task.reason || '执行中断，必须先核验原页面；禁止自动重投' }, 'recovered_unknown');
      } else if (['opening','filling'].includes(task.status)) this.transition({ ...task, status: 'pending', reason: '提交前中断，可重新观察填写' }, 'recovered_before_submit');
    }
  }
  close() { this.db.close(); }
}

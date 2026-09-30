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
      CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);`);
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
  transition(task, type) {
    const event = { id: randomUUID(), taskId: task.id, version: task.version, at: new Date().toISOString(), type, state: structuredClone(task) };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.set(`task:${task.id}`, task);
      this.db.prepare('INSERT INTO outbox(id,value) VALUES (?,?)').run(event.id, JSON.stringify(event));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return event;
  }
  pending() { return this.db.prepare('SELECT id,value FROM outbox ORDER BY seq').all().map(x => JSON.parse(x.value)); }
  pendingCount() { return this.db.prepare('SELECT count(*) AS total FROM outbox').get().total; }
  pendingBatch(limit=100) { return this.db.prepare('SELECT value FROM outbox ORDER BY seq LIMIT ?').all(limit).map(x=>JSON.parse(x.value)); }
  pendingSummary() { return this.db.prepare("SELECT id,json_extract(value,'$.taskId') AS taskId FROM outbox ORDER BY seq").all(); }
  ack(id) { this.db.prepare('DELETE FROM outbox WHERE id=?').run(id); }
  recover() {
    for (const task of this.values('task:')) {
      const resolvedAttempt = task.attemptBoundary && task.status === 'needs_manual' && ['rejected','not_submitted'].includes(task.siteStatus);
      if (task.status === 'submitting' || (task.attemptBoundary && !resolvedAttempt && !['submitted_unconfirmed','finished'].includes(task.status))) {
        if (!task.receipt) this.transition({ ...task, status: 'submitted_unconfirmed', siteStatus: 'sent_unconfirmed', reason: task.reason || '执行中断，必须先核验原页面；禁止自动重投' }, 'recovered_unknown');
      } else if (['opening','filling'].includes(task.status)) this.transition({ ...task, status: 'pending', reason: '提交前中断，可重新观察填写' }, 'recovered_before_submit');
    }
  }
  close() { this.db.close(); }
}

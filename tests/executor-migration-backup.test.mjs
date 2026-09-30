import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { backupWorkspace } from '../executor/src/migration-backup.mjs';

test('online backup includes uncheckpointed WAL and preserves every queue record without exposing credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'el-backup-'));
  const db = new DatabaseSync(join(root, 'outbox.sqlite'));
  try {
    db.exec('PRAGMA journal_mode=WAL; CREATE TABLE state(id TEXT PRIMARY KEY,value TEXT); CREATE TABLE outbox(seq INTEGER PRIMARY KEY,id TEXT,value TEXT)');
    const insert = db.prepare('INSERT INTO state VALUES (?,?)');
    insert.run('pair', JSON.stringify({deviceToken:'NEVER_PRINT',localToken:'PRIVATE'}));
    insert.run('task:t', JSON.stringify({id:'t',status:'submitted_unconfirmed',attemptBoundary:'boundary'}));
    insert.run('preview', JSON.stringify({profile:{id:'P',fields:{Name:'Product',Url:'https://product.example'}}}));
    db.prepare('INSERT INTO outbox VALUES (1,?,?)').run('event', JSON.stringify({taskId:'t'}));
    const output = join(root, 'backup');
    const manifest = await backupWorkspace({home:root, output});
    assert.equal(manifest.integrity, 'ok');
    assert.equal(manifest.tasks, 1);
    assert.equal(manifest.outbox, 1);
    assert.equal(manifest.sha256, createHash('sha256').update(await readFile(join(output,'outbox.sqlite'))).digest('hex'));
    assert.doesNotMatch(JSON.stringify(manifest), /NEVER_PRINT|PRIVATE/);
    const check = new DatabaseSync(join(output,'outbox.sqlite'),{readOnly:true});
    assert.equal(JSON.parse(check.prepare("SELECT value FROM state WHERE id='task:t'").get().value).attemptBoundary,'boundary');
    check.close();
    await assert.rejects(backupWorkspace({home:root,output}), /已存在/);
  } finally {db.close(); await rm(root,{recursive:true,force:true});}
});

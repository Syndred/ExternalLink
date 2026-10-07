import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, writeFile, stat, readdir, readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

async function checksum(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// SQLite's online backup includes WAL commits even while the executor is live.
// This is a private local backup, including pairing data; never publish its file.
export async function backupWorkspace({ home, output }) {
  await mkdir(output, {recursive:true});
  const file = join(output, 'outbox.sqlite');
  if (await stat(file).then(()=>true, error=>{if(error.code==='ENOENT')return false;throw error;})) throw Error('备份已存在，禁止覆盖');
  const source = new DatabaseSync(join(home, 'outbox.sqlite'), {readOnly:true});
  try { await backup(source,file); } finally {source.close();}
  const check = new DatabaseSync(file,{readOnly:true});
  let manifest;
  try {
    const integrity = check.prepare('PRAGMA integrity_check').get().integrity_check;
    if(integrity!=='ok')throw Error('备份完整性失败：'+integrity);
    const inventory = check.prepare('SELECT id,length(value) AS bytes FROM state ORDER BY id').all();
    const evidence = [];
    for(const name of (await readdir(home)).filter(name=>/\.(png|jpg|jpeg|webp|jsonl)$/i.test(name))) {
      const info=await stat(join(home,name));
      if(info.isFile())evidence.push({name,bytes:info.size,sha256:await checksum(join(home,name))});
    }
    manifest={at:new Date().toISOString(),file,bytes:(await stat(file)).size,sha256:await checksum(file),integrity,
      tasks:check.prepare("SELECT count(*) AS total FROM state WHERE id LIKE 'task:%'").get().total,
      outbox:check.prepare('SELECT count(*) AS total FROM outbox').get().total,
      inventory,evidence,credentialsIncluded:true,privateLocalBackup:true};
    if(check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='connection_profiles'").get())manifest.savedConnections={
      profiles:check.prepare('SELECT count(*) AS n FROM connection_profiles').get().n,
      tasks:check.prepare("SELECT count(*) AS n FROM connection_state WHERE id LIKE 'task:%'").get().n,
      pendingEvents:check.prepare('SELECT count(*) AS n FROM connection_outbox').get().n,
      logs:check.prepare('SELECT count(*) AS n FROM connection_audit').get().n};
    await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2),{flag:'wx'});
  } finally {check.close();}
  return manifest;
}

import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const root = join(process.env.USERPROFILE, '.externallink-backups', '2026-09-29-before-d1');
mkdirSync(root, { recursive: true });
const source = new DatabaseSync(join(process.env.USERPROFILE, '.externallink-executor', 'outbox.sqlite'), { readOnly: true });
const file = join(root, 'outbox.sqlite');
if (!existsSync(file)) await backup(source, file);
const check = new DatabaseSync(file, { readOnly: true });
const summary = {
  file, bytes: statSync(file).size,
  integrity: check.prepare('pragma integrity_check').get(),
  tasks: check.prepare("select count(*) as n from state where id like 'task:%'").get(),
  outbox: check.prepare('select count(*) as n from outbox').get(),
};
writeFileSync(join(root, 'manifest.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
check.close(); source.close();

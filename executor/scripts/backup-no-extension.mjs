import { homedir } from 'node:os';
import { join } from 'node:path';
import { backupWorkspace } from '../src/migration-backup.mjs';
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor');
const output=join(homedir(),'.externallink-backups','no-extension-'+new Date().toISOString().replace(/[:.]/g,'-'));
const result=await backupWorkspace({home,output});
console.log(JSON.stringify({output,integrity:result.integrity,sha256:result.sha256,tasks:result.tasks,outbox:result.outbox,evidenceFiles:result.evidence.length}));

// Index already-verified R2 archives; no submission, state replay or outbox deletion.
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const root=join(process.env.USERPROFILE,'.externallink-backups','2026-09-29-before-d1');
const db=new DatabaseSync(join(root,'outbox.sqlite'),{readOnly:true});
const pair=JSON.parse(db.prepare('SELECT value FROM state WHERE id=?').get('pair').value);
const hash=v=>createHash('sha256').update(v).digest('hex'),quote=v=>v==null?'NULL':"'"+String(v).replaceAll("'","''")+"'";
const workspace=pair.workspaceId,device=pair.deviceId,sql=[];
sql.push(`INSERT OR IGNORE INTO executor_devices(workspace,id,token_hash,name) VALUES(${[workspace,device,hash(pair.deviceToken),'Recovered Windows executor'].map(quote).join(',')});`);
const tasks=db.prepare("SELECT value FROM state WHERE id LIKE 'task:%' ORDER BY id").all().map(r=>JSON.parse(r.value));
for(const t of tasks){const identity=t.identity||t.destinationKey+'::'+t.profileId,host=t.profileId+'::'+new URL(t.url).hostname.toLowerCase().replace(/^www\./,'');
 sql.push(`INSERT OR IGNORE INTO executor_controls(workspace,id,run_id,device_id,identity,host_identity,version,controller_id,lease_until,review_status) VALUES(${[workspace,t.id,t.runId,device,identity,host,t.version||1,t.controllerId||null,0,t.reviewStatus||'pending_review'].map(quote).join(',')});`);
}
const manifest=JSON.parse(readFileSync(join(root,'d1-readback.json'))).manifest;
const archives=[];let batch=[],bytes=0,index=0,total=0;
function flush(){if(!batch.length)return;const objectChecksum=hash(JSON.stringify(batch)),id=(total>=4503?'outbox-small-':'outbox-')+String(index++).padStart(4,'0'),objectKey=`${workspace}/d1/objects/${objectChecksum}.json`;
 for(const [position,event]of batch.entries())sql.push(`INSERT OR IGNORE INTO executor_events VALUES(${[workspace,event.id,device,event.taskId,hash(JSON.stringify(event)),objectKey,objectChecksum,position,event.at].map(quote).join(',')});`);
 archives.push({id,checksum:objectChecksum,events:batch.length});total+=batch.length;batch=[];bytes=0;
}
for(const row of db.prepare('SELECT value FROM outbox ORDER BY seq').iterate()){
 const length=Buffer.byteLength(row.value);if(bytes+length>(total>=4503?1:4)*1024*1024&&batch.length)flush();batch.push(JSON.parse(row.value));bytes+=length;
}flush();
if(total!==manifest.outboxEvents||index!==manifest.outboxBatches||tasks.length!==manifest.taskCount)throw new Error('恢复分片数量与已验证清单不一致');
const sqlFile=join(root,'executor-index.sql');writeFileSync(sqlFile,sql.join('\n'));writeFileSync(join(root,'executor-index-manifest.json'),JSON.stringify({workspace,device,tasks:tasks.length,events:total,archives},null,2));
console.log(JSON.stringify({prepared:true,tasks:tasks.length,events:total,archives:index}));db.close();
if(process.argv.includes('--apply')){
 const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','d1','execute','externallink-ledger','--remote','--file',sqlFile],{cwd:resolve('cloud/worker'),encoding:'utf8'});
 process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status||0);
}

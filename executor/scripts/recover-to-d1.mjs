// Recovery copies only. Never clears the executor outbox or resumes submissions.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { createHash,randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { STATE_DOCUMENT_KEYS } from '../../cloud/worker/src/worker-core.mjs';
const root=join(process.env.USERPROFILE,'.externallink-backups','2026-09-29-before-d1');
const secretFile=join(root,'d1-recovery-token.txt');
if(!existsSync(secretFile))writeFileSync(secretFile,randomBytes(32).toString('hex'),{mode:0o600});
const token=readFileSync(secretFile,'utf8').trim();
if(process.argv.includes('--provision-secret')){
  const result=spawnSync(process.execPath,['node_modules/wrangler/bin/wrangler.js','secret','put','D1_RECOVERY_TOKEN'],{cwd:resolve('cloud/worker'),input:token,encoding:'utf8'});
  process.stdout.write(result.stdout||'');process.stderr.write(result.stderr||'');process.exit(result.status||0);
}
const db=new DatabaseSync(join(root,'outbox.sqlite'),{readOnly:true});
const pair=JSON.parse(db.prepare('SELECT value FROM state WHERE id=?').get('pair').value);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function request(route,body){
  const url=new URL('/v2/recovery/'+route,pair.endpoint);url.searchParams.set('workspace',pair.workspaceId);
  for(let attempt=0;attempt<3;attempt++){
    const response=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(60000)});
    const text=await response.text();let result;try{result=JSON.parse(text);}catch{result={ok:false,error:'非 JSON 响应 '+(text.match(/(?:Error |error code[: ]+)(\d{3,5})/i)?.[0]||'')};}
    if(response.ok&&result.ok)return result;
    // All recovery writes use immutable IDs/content hashes; retries cannot overwrite.
    if([502,503,504].includes(response.status)&&attempt<2){await new Promise(r=>setTimeout(r,1000*(attempt+1)));continue;}
    throw new Error(`${route}: ${response.status} ${result.error}`);
  }
}
const progressFile=join(root,'d1-progress.json');
const progress=existsSync(progressFile)?JSON.parse(readFileSync(progressFile)):{};
const save=()=>writeFileSync(progressFile,JSON.stringify(progress,null,2));
async function archive(id,kind,data){
  const checksum=hash(data);if(progress[id]===checksum)return;
  const result=await request('archive',{id,kind,data});
  const proof=await request('proof?id='+encodeURIComponent(id));
  if(result.checksum!==checksum||proof.checksum!==checksum)throw new Error('归档回读不一致 '+id);
  progress[id]=checksum;save();
}
if(process.argv.includes('--archive-older')){
  const older=JSON.parse(readFileSync(join(process.env.USERPROFILE,'Downloads','externallink-backup-2026-09-25.json')));
  await archive('plugin-backup-2026-09-25','source_backup',older);
  console.log(JSON.stringify({archived:true,records:Object.keys(older.submissionRecords||{}).length,restoredAsCurrent:false}));
  db.close();process.exit(0);
}
const backupPath=join(process.env.USERPROFILE,'Downloads','externallink-backup-2026-09-27.json');
const backup=JSON.parse(readFileSync(backupPath));
await archive('plugin-backup-2026-09-27','source_backup',backup);
const docs=Object.fromEntries(STATE_DOCUMENT_KEYS.filter(k=>Object.hasOwn(backup,k)).map(k=>[k,structuredClone(backup[k])]));
const newer=JSON.parse(readFileSync('docs/evidence/jev-tools-profile-readback-2026-09-28.json'));
if(newer.profile?.id)docs.siteProfiles[newer.profile.id]=newer.profile;
const recovery=JSON.parse(readFileSync('docs/evidence/recovery-2026-09-28/current-results.json'));
for(const row of recovery.rows||[]){
  if(!row.record||!row.recordMatches)continue;
  const record=row.record,key=record.destinationKey+'::'+record.profileId;
  if(!record.destinationKey||!record.profileId)continue;
  const prior=docs.submissionRecords[key];
  if(!prior||String(record.submittedAt||'')>=String(prior.submittedAt||''))docs.submissionRecords[key]=record;
}
writeFileSync(join(root,'recovered-documents.json'),JSON.stringify(docs));
for(const [key,data] of Object.entries(docs))await request('document',{key,data});
console.log(JSON.stringify({stage:'documents',profiles:Object.keys(docs.siteProfiles).length,records:Object.keys(docs.submissionRecords).length,keys:Object.keys(docs)}));
const tasks=db.prepare("SELECT value FROM state WHERE id LIKE 'task:%' ORDER BY id").all().map(r=>JSON.parse(r.value));
let done=0;
// Bounded concurrency keeps this one-time recovery below provider request limits.
for(let offset=0;offset<tasks.length;offset+=4){
  await Promise.all(tasks.slice(offset,offset+4).map(async task=>{
    const checksum=hash(task),key='task:'+task.id;
    if(progress[key]!==checksum){
      const result=await request('task',{task}),proof=await request('proof?taskId='+encodeURIComponent(task.id));
      if(result.checksum!==checksum||proof.checksum!==checksum)throw new Error('任务回读不一致 '+task.id);
      progress[key]=checksum;
    }
    done++;
  }));save();if(offset%100===0)console.log(JSON.stringify({stage:'tasks',done,total:tasks.length}));
}
for(const row of db.prepare("SELECT id,value FROM state WHERE id LIKE 'run:%' OR id='libraryPlan'").all())await archive(row.id.replace(':','-'),row.id==='libraryPlan'?'libraryPlan':'run',JSON.parse(row.value));
let batch=[],bytes=0,index=0,total=0;
for(const row of db.prepare('SELECT value FROM outbox ORDER BY seq').iterate()){
  const size=Buffer.byteLength(row.value),limit=(total>=4503?1:4)*1024*1024;
  if(bytes+size>limit&&batch.length){await archive((total>=4503?'outbox-small-':'outbox-')+String(index++).padStart(4,'0'),'outbox',batch);total+=batch.length;console.log(JSON.stringify({stage:'outbox',done:total}));batch=[];bytes=0;}
  batch.push(JSON.parse(row.value));bytes+=size;
}
if(batch.length){await archive((total>=4503?'outbox-small-':'outbox-')+String(index++).padStart(4,'0'),'outbox',batch);total+=batch.length;}
const manifest={at:new Date().toISOString(),sourceBackup:backup.exportedAt,taskCount:tasks.length,outboxEvents:total,outboxBatches:index,
  profiles:Object.keys(docs.siteProfiles),records:Object.keys(docs.submissionRecords).length,
  coverage:'2026-09-27 plugin export plus locally retained subsequent JevPlay profile and verified receipts. Not claimed identical to last Neon snapshot.',
  originalOutboxPreserved:true,submissionsResumed:false};
await archive('manifest-2026-09-29','manifest',manifest);
const status=await request('status');writeFileSync(join(root,'d1-readback.json'),JSON.stringify({manifest,status},null,2));
console.log(JSON.stringify({manifest,status}));db.close();

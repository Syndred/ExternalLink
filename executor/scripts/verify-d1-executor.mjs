import {DatabaseSync} from 'node:sqlite';import {readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {Cloud} from '../src/cloud.mjs';
const root=join(process.env.USERPROFILE,'.externallink-backups','2026-09-29-before-d1');
const db=new DatabaseSync(join(root,'outbox.sqlite'),{readOnly:true});
const pair=JSON.parse(db.prepare('SELECT value FROM state WHERE id=?').get('pair').value),cloud=new Cloud({...pair,storageBackend:'d1'});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const manifest=JSON.parse(readFileSync(join(root,'executor-index-manifest.json')));
const runs=db.prepare("SELECT value FROM state WHERE id LIKE 'run:%'").all().map(r=>JSON.parse(r.value));
for(const run of runs)await cloud.request('recover-run',{runId:run.id});
const inventory=await cloud.request('runs?view=inventory');
const localTasks=db.prepare("SELECT value FROM state WHERE id LIKE 'task:%'").all().map(r=>JSON.parse(r.value));
for(const task of localTasks){const remote=inventory.tasks.find(t=>t.id===task.id);if(!remote||remote.profileId!==task.profileId||remote.url!==task.url||remote.status!==task.status||remote.version!==(task.version||1))throw new Error('任务索引不匹配 '+task.id);}
console.log(JSON.stringify({stage:'inventory',tasks:inventory.tasks.length,runs:inventory.runs.length}));
let after='',proofs=new Map();do{const page=await cloud.request('events/proofs?after='+encodeURIComponent(after));for(const proof of page.events)proofs.set(proof.id,proof);after=page.next;}while(after);
let verified=0;const samples=[];
for(const row of db.prepare('SELECT value FROM outbox ORDER BY seq').iterate()){
 const event=JSON.parse(row.value),proof=proofs.get(event.id);if(!proof||proof.checksum!==hash(event)||!manifest.archives.some(a=>a.checksum===proof.object_checksum))throw new Error('事件索引不匹配 '+event.id);
 if(verified%1000===0)samples.push(event);verified++;
}
if(verified!==manifest.events)throw new Error('事件数不一致');
console.log(JSON.stringify({stage:'event-index',verified}));
for(let offset=0;offset<manifest.archives.length;offset+=4){
 await Promise.all(manifest.archives.slice(offset,offset+4).map(async archive=>{const proof=await cloud.request('recovery-archives?head=1&id='+encodeURIComponent(archive.id));if(proof.checksum!==archive.checksum||!proof.present)throw new Error('原始档案缺失 '+archive.id);}));
 if(offset%20===0)console.log(JSON.stringify({stage:'archive-presence',verified:Math.min(offset+4,manifest.archives.length),total:manifest.archives.length}));
}
for(const event of samples){const read=await cloud.request('events/'+event.id);if(hash(read.event)!==hash(event))throw new Error('事件正文不一致 '+event.id);}
const snapshot=await cloud.request('snapshot');
const report={at:new Date().toISOString(),tasks:inventory.tasks.length,runs:inventory.runs.length,events:verified,archives:manifest.archives.length,fullEventSamples:samples.length,profiles:Object.keys(snapshot.documents.siteProfiles||{}),revisions:snapshot.revisions,eventChecksums:Object.fromEntries([...proofs].map(([id,p])=>[id,p.checksum])),submissionsPerformed:0};
writeFileSync(join(root,'executor-live-readback.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,eventChecksums:'stored in private recovery report'}));db.close();

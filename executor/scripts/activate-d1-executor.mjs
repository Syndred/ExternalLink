import {Store} from '../src/store.mjs';import {Cloud} from '../src/cloud.mjs';
import {join} from 'node:path';import {readFileSync,writeFileSync,existsSync} from 'node:fs';import {backup} from 'node:sqlite';import {createHash} from 'node:crypto';
const root=join(process.env.USERPROFILE,'.externallink-backups','2026-09-29-before-d1'),home=join(process.env.USERPROFILE,'.externallink-executor');
const verified=JSON.parse(readFileSync(join(root,'executor-live-readback.json')));
const store=new Store(join(home,'outbox.sqlite'));store.acquireOwner();
if(store.get('paused')!==true)throw new Error('仅允许迁移暂停的执行器');
const safety=join(root,'before-executor-activation.sqlite');if(!existsSync(safety))await backup(store.db,safety);
const pair=store.get('pair'),cloud=new Cloud({...pair,storageBackend:'d1'});
const snapshot=await cloud.request('snapshot');if(snapshot.deviceId!==pair.deviceId)throw new Error('设备身份不一致');
const matched=[];for(const row of store.db.prepare('SELECT id,value FROM outbox ORDER BY seq').iterate()){
 const checksum=createHash('sha256').update(JSON.stringify(JSON.parse(row.value))).digest('hex');if(verified.eventChecksums[row.id]!==checksum)throw new Error('存在尚未核验的新事件 '+row.id);matched.push(row.id);
}
store.db.exec('BEGIN IMMEDIATE');
try{
 store.set('pair',{...pair,storageBackend:'d1'});
 store.set('offlineMode',{...store.get('offlineMode'),enabled:false,syncStartedAt:null,migratedToD1At:new Date().toISOString()});
 const plan=store.get('libraryPlan');if(plan)store.set('libraryPlan',{...plan,priorGlobalPause:plan.globalPause,globalPause:{at:new Date().toISOString(),attentionType:'migration_verification',reason:'D1 已迁移，自动投稿保持暂停，待核对完整资料与站点结果',resumeEligible:false}});
 for(const id of matched)store.ack(id);
 store.set('d1Migration',{at:new Date().toISOString(),acknowledgedEvents:matched.length,readbackReport:join(root,'executor-live-readback.json'),submissionsPerformed:0});
 store.db.exec('COMMIT');
}catch(e){store.db.exec('ROLLBACK');throw e;}
const report={at:new Date().toISOString(),storageBackend:'d1',acknowledgedEvents:matched.length,pendingEvents:store.pendingCount(),tasks:store.values('task:').length,paused:store.get('paused'),originalDatabaseBackup:safety};
writeFileSync(join(root,'executor-activation.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));store.close();

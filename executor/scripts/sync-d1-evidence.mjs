// Transfers existing images and records their immutable cloud references. No browser actions.
import {Store} from '../src/store.mjs';import {Cloud} from '../src/cloud.mjs';
import {join} from 'node:path';import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';
const root=join(process.env.USERPROFILE,'.externallink-backups','2026-09-29-before-d1'),home=join(process.env.USERPROFILE,'.externallink-executor');
const store=new Store(join(home,'outbox.sqlite'));store.acquireOwner();if(store.get('paused')!==true||store.get('pair')?.storageBackend!=='d1')throw new Error('需要暂停并已切换 D1');
const cloud=new Cloud(store.get('pair')),digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const tasks=store.values('task:').filter(t=>t.screenshot&&!t.artifactRef);let done=0;
while(store.pendingCount())await cloud.flush(store);
let cursor=0,failed;async function transfer(){while(!failed&&cursor<tasks.length){const task=tasks[cursor++];try{
 const bytes=readFileSync(task.screenshot),hash=digest(bytes);
 const artifact=await cloud.request('artifact',{taskId:task.id,dataUrl:'data:image/png;base64,'+bytes.toString('base64')});
 if(artifact.sha256!==hash)throw new Error('图片上传摘要不一致 '+task.id);
 const read=await cloud.request('artifact-read',{taskId:task.id,ref:artifact.ref});if(digest(Buffer.from(read.dataUrl.split(',')[1],'base64'))!==hash)throw new Error('图片独立回读不一致 '+task.id);
 const event=store.transition({...task,artifactRef:artifact.ref,artifactSha256:hash},'artifact_readback');
 await cloud.request('event',event);const proof=await cloud.request('events/'+event.id+'?proof=1');
 if(proof.eventId!==event.id||proof.checksum!==digest(JSON.stringify(event)))throw new Error('图片登记事件校验失败 '+task.id);
 store.ack(event.id);done++;if(done%10===0)console.log(JSON.stringify({images:done,total:tasks.length,pendingEvents:store.pendingCount()}));
 }catch(error){failed=error;}}}
await Promise.all(Array.from({length:4},transfer));if(failed){store.close();throw failed;}
const report={at:new Date().toISOString(),uploaded:done,remaining:store.values('task:').filter(t=>t.screenshot&&!t.artifactRef).length,pendingEvents:store.pendingCount(),paused:store.get('paused'),submissionsPerformed:0};
writeFileSync(join(root,'evidence-sync.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));store.close();

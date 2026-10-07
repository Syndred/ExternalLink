import {randomBytes} from 'node:crypto';
import {readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {Cloud} from './cloud.mjs';
import {workbenchScope} from './workbench-sync.mjs';
export async function setupInfo(runtime){
 if(runtime.store.get('pair'))throw Error('本机已连接云端');
 let nonce=runtime.store.get('workbenchSetupNonce');if(!nonce||nonce.expiresAt<Date.now()){nonce={value:randomBytes(32).toString('base64url'),expiresAt:Date.now()+600000};runtime.store.set('workbenchSetupNonce',nonce);}
 const enrollmentAvailable=await stat(join(runtime.home,'enrollment.json')).then(s=>s.isFile(),()=>false);return{ok:true,setupRequired:true,nonce:nonce.value,expiresAt:nonce.expiresAt,enrollmentAvailable};
}
export async function connectWorkbench(runtime,input){
 if(runtime.store.get('pair'))throw Error('本机已有连接，请在设置的“云端连接与保存的记录”中核验更新，原记录会保留');
 const nonce=runtime.store.get('workbenchSetupNonce');if(!nonce||nonce.expiresAt<Date.now()||nonce.value!==input.nonce)throw Error('连接页面已过期，请刷新');
 if(runtime.store.pendingCount()||runtime.store.values('task:').length)throw Error('本机存在未连接的历史任务，请先备份恢复，不能覆盖');
 const config=input.enrollment||JSON.parse(await readFile(join(runtime.home,'enrollment.json'),'utf8'));
 if(config.storageBackend!=='d1'||!config.deviceId||!config.workspaceId||typeof config.deviceToken!=='string'||!config.deviceToken.startsWith('eld_'))throw Error('请选择有效的设备登记文件');
 const snapshot=await new (runtime.CloudClass||Cloud)(config).request('snapshot');if(snapshot.deviceId!==config.deviceId||snapshot.workspaceId!==config.workspaceId)throw Error('云端设备或工作区不一致');
 const pair={endpoint:config.endpoint,workspaceId:config.workspaceId,deviceId:config.deviceId,deviceToken:config.deviceToken,storageBackend:'d1',localToken:randomBytes(32).toString('base64url')};
 runtime.store.db.exec('BEGIN IMMEDIATE');try{if(runtime.store.get('pair'))throw Error('另一连接已完成，请刷新');runtime.store.set('pair',pair);runtime.store.set('paused',true);runtime.store.set('applicationSnapshot',{scope:workbenchScope(pair),at:new Date().toISOString(),snapshot});runtime.store.db.prepare('DELETE FROM state WHERE id=?').run('workbenchSetupNonce');runtime.store.db.exec('COMMIT');}catch(error){runtime.store.db.exec('ROLLBACK');throw error;}
 return{ok:true,localToken:pair.localToken,deviceId:pair.deviceId,workspaceId:pair.workspaceId};
}

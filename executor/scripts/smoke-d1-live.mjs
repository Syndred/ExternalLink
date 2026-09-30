// Authenticated storage diagnostic only; never starts or submits a task.
import{DatabaseSync}from'node:sqlite';import{join}from'node:path';import{writeFileSync}from'node:fs';import{Cloud}from'../src/cloud.mjs';
const db=new DatabaseSync(join(process.env.USERPROFILE,'.externallink-executor','outbox.sqlite'),{readOnly:true});
const pair=JSON.parse(db.prepare('SELECT value FROM state WHERE id=?').get('pair').value),cloud=new Cloud(pair);
const diagnostic=await cloud.request('diagnostics',{});if(!diagnostic.r2Readback||!diagnostic.businessDocumentsUnchanged)throw Error('存储诊断失败');
const inventory=await cloud.request('runs?view=inventory'),snapshot=await cloud.request('snapshot');
const oldState=await fetch(new URL('/v1/snapshot?workspace='+encodeURIComponent(pair.workspaceId),pair.endpoint));
if(oldState.status!==428)throw Error('旧状态接口未阻断');
const oldRuntime=await fetch(new URL('/v1/executor/runs?workspace='+encodeURIComponent(pair.workspaceId),pair.endpoint),{headers:{Authorization:'Bearer '+pair.deviceToken}});
if(oldRuntime.status!==426)throw Error('旧执行器未阻断');
const unknown=await fetch(new URL('/v2/snapshot?workspace='+encodeURIComponent(pair.workspaceId),pair.endpoint));if(unknown.status!==401)throw Error('未授权访问未拒绝');
const report={at:new Date().toISOString(),storageBackend:pair.storageBackend,tasks:inventory.tasks.length,runs:inventory.runs.length,profiles:Object.keys(snapshot.documents.siteProfiles||{}).length,records:Object.keys(snapshot.documents.submissionRecords||{}).length,r2Readback:diagnostic.r2Readback,businessDocumentsUnchanged:diagnostic.businessDocumentsUnchanged,legacyStateHttp:oldState.status,legacyExecutorHttp:oldRuntime.status,anonymousHttp:unknown.status,submissionsPerformed:0};
writeFileSync('docs/evidence/d1-live-smoke-2026-09-29.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));db.close();

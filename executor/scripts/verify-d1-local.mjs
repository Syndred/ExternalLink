import{DatabaseSync}from'node:sqlite';import{join}from'node:path';import{writeFileSync,readFileSync}from'node:fs';
const home=join(process.env.USERPROFILE,'.externallink-executor'),db=new DatabaseSync(join(home,'outbox.sqlite'),{readOnly:true});
const pair=JSON.parse(db.prepare('SELECT value FROM state WHERE id=?').get('pair').value),server=JSON.parse(readFileSync(join(home,'server.json')));
const response=await fetch(server.endpoint+'/status',{headers:{Authorization:'Bearer '+pair.localToken}}),status=await response.json();
if(!response.ok||status.paused!==true||status.pendingEvents||status.cloudError||status.busy)throw Error('本机状态尚未收敛：'+JSON.stringify({http:response.status,paused:status.paused,pending:status.pendingEvents,cloudError:status.cloudError,busy:status.busy}));
const images=status.tasks.filter(t=>t.screenshot),missing=images.filter(t=>!t.artifactRef||!t.artifactSha256);if(missing.length)throw Error('还有截图未同步');
const report={at:new Date().toISOString(),endpoint:server.endpoint,storageBackend:pair.storageBackend,paused:status.paused,busy:status.busy,tasks:status.tasks.length,runs:status.runs.length,pendingEvents:status.pendingEvents,cloudError:status.cloudError,evidenceImages:images.length,evidenceImagesWithVerifiedCloudReferences:images.length-missing.length,frozenDenominator:status.libraryPlan?.frozenDenominator,submissionsPerformed:0};
writeFileSync('docs/evidence/d1-local-service-2026-09-29.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));db.close();

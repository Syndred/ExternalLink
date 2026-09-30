import {DatabaseSync} from 'node:sqlite';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {Cloud} from '../executor/src/cloud.mjs';
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor');
const db=new DatabaseSync(join(home,'outbox.sqlite'),{readOnly:true});
const pair=JSON.parse(db.prepare('SELECT value FROM state WHERE id=?').get('pair').value);
const server=JSON.parse(readFileSync(join(home,'server.json'),'utf8'));
const cloud=new Cloud(pair);
const report={at:new Date().toISOString(),endpoint:pair.endpoint,workspace:pair.workspaceId,backend:pair.storageBackend};
for(const route of ['workspace/journal-documents','runs?view=inventory']){
 const started=Date.now();
 try{const result=await cloud.request(route);report[route]={ok:true,elapsedMs:Date.now()-started,profiles:Object.keys(result.documents?.siteProfiles||{}).length,tasks:result.tasks?.length,runs:result.runs?.length,revisions:result.revisions};}
 catch(error){report[route]={ok:false,elapsedMs:Date.now()-started,error:error.message,code:error.code,status:error.status};}
}
try{const response=await fetch(new URL('/status',server.endpoint),{headers:{Authorization:'Bearer '+pair.localToken},signal:AbortSignal.timeout(5000)}),state=await response.json();report.local={http:response.status,paused:state.paused,busy:state.busy,tasks:state.tasks?.length,pendingEvents:state.pendingEvents,workbenchPendingEvents:state.workbenchPendingEvents,cloudError:state.cloudError};}catch(error){report.local={error:error.message};}
db.close();
mkdirSync('docs/evidence/cloud-recovery-2026-09-30',{recursive:true});
writeFileSync('docs/evidence/cloud-recovery-2026-09-30/read-only-check.json',JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));

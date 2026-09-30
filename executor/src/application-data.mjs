import { applicationModel,taskSummary } from '../../core/application-model.mjs';
import { workbenchScope } from './workbench-sync.mjs';
import {pendingApplication,overlayApplication} from './application-mutations.mjs';
import {pendingMediaUploads} from './media-uploads.mjs';
import {currentMailAssociations} from './mail-associations.mjs';
const keys=['siteProfiles','sheetTableData','urlList','submissionRecords','submissionTimeline','siteAnnotations','domainBlacklist','deletedSubmissionKeys'];
export async function applicationData(runtime,{refresh=false}={}){
 const scope=workbenchScope(runtime.store.get('pair'));
 let saved=runtime.store.get('applicationSnapshot'),error='',refreshed=false;
 if(saved?.scope!==scope)saved=null;
 if(refresh||!saved){
  try{const snapshot=await runtime.cloud.request('snapshot');const documents=Object.fromEntries(keys.filter(key=>Object.hasOwn(snapshot.documents,key)).map(key=>[key,snapshot.documents[key]]));
   saved={scope,at:new Date().toISOString(),snapshot:{documents,revisions:snapshot.revisions}};runtime.store.set('applicationSnapshot',saved);refreshed=true;
  }catch(failure){error=failure.message;if(!saved)throw failure;}
 }
 const status=runtime.status(),tasks=status.tasks.map(taskSummary),model=applicationModel(overlayApplication(runtime,saved.snapshot),tasks);
 const associations=currentMailAssociations(runtime.store);
 for(const cell of model.combinations){const mail=associations.filter(a=>a.identity===cell.identity);if(mail.length){cell.reply='reply_received';cell.replyEvidence=mail.map(({messageId,sha256,at,source})=>({messageId,sha256,at,source}));}}
 return{ok:true,at:saved.at,cached:!refreshed,error,model,revisions:saved.snapshot.revisions,gmail:runtime.store.get('gmail'),
  runtime:{paused:status.paused,busy:status.busy,activeTaskId:status.activeTaskId,pendingEvents:status.pendingEvents,cloudError:status.cloudError},tasks,
  pendingMedia:pendingMediaUploads(runtime).map(({assetId,profileId,kind,status,error})=>({assetId,profileId,kind,status,error})),
  pendingEdits:pendingApplication(runtime).map(item=>({id:item.id,type:item.operation.type,status:item.status,error:item.error,key:item.key,...(item.status==='conflict'?{operation:item.operation,baseData:item.baseData,remoteData:saved.snapshot.documents[item.key],remoteRevision:saved.snapshot.revisions[item.key]}:{})})),batch:runtime.store.get('acceptanceBatch'),
  acceptances:runtime.store.values('acceptance:').map(frozen=>({id:frozen.id,count:frozen.count,sha256:frozen.sha256,startedAt:frozen.startedAt,productIds:frozen.productIds,
    combinations:frozen.combinations.map(c=>({identity:c.identity,profileId:c.profileId,siteId:c.siteId,url:c.url,existingTaskId:c.existingTaskId})),execution:runtime.store.get('acceptanceExecution:'+frozen.id)}))};
}

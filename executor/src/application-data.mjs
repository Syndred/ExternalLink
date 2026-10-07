import {summary as linkMonitorSummary} from './link-monitor.mjs';
import {quickOpenSummary} from './quick-open.mjs';
import {assistantState} from './browser-assistant.mjs';
import { applicationModel,taskSummary } from '../../core/application-model.mjs';
import {backupKeys} from '../../core/application-backup.mjs';
import { workbenchScope,pendingWorkbench as pendingWorkbenchEvents } from './workbench-sync.mjs';
import {pendingApplication,overlayApplication} from './application-mutations.mjs';
import {pendingFillLearning} from './fill-learning.mjs';
import {pendingMediaUploads} from './media-uploads.mjs';
import {currentMailAssociations} from './mail-associations.mjs';
import {applicationSettingKeys,normalizeLegacyPreferences} from '../../core/application-preferences.mjs';
const keys=[...backupKeys,'deletedSubmissionKeys','linkMonitorEnabled','linkMonitorMinutes'];
export async function applicationData(runtime,{refresh=false}={}){
 const scope=workbenchScope(runtime.store.get('pair'));
 let saved=runtime.store.get('applicationSnapshot'),error='',refreshed=false;
 if(saved?.scope!==scope)saved=null;
 if(refresh||!saved){
  try{const snapshot=await runtime.cloud.request('snapshot');const documents=Object.fromEntries(keys.filter(key=>Object.hasOwn(snapshot.documents,key)).map(key=>[key,snapshot.documents[key]]));
   saved={scope,at:new Date().toISOString(),snapshot:{documents,revisions:snapshot.revisions}};runtime.store.set('applicationSnapshot',saved);refreshed=true;
  }catch(failure){error=failure.message;if(!saved)throw failure;}
 }
 const overlaid=overlayApplication(runtime,saved.snapshot);for(const item of pendingWorkbenchEvents(runtime))overlaid.documents.submissionTimeline=globalThis.ExtLinkSubmissionTimeline.append(overlaid.documents.submissionTimeline,item.event);
 const status=runtime.status(),tasks=status.tasks.map(taskSummary),model=applicationModel(overlaid,tasks),stopped=runtime.store.get('executionStopped');
 const associations=currentMailAssociations(runtime.store);
 for(const cell of model.combinations){const mail=associations.filter(a=>a.identity===cell.identity);if(mail.length){cell.reply='reply_received';cell.replyEvidence=mail.map(({messageId,sha256,at,source})=>({messageId,sha256,at,source}));}}
 return{ok:true,quickOpenJobs:runtime.store.values('quickOpenJob:').filter(j=>j.scope===scope).map(quickOpenSummary),linkMonitorJobs:runtime.store.values('linkMonitorJob:').filter(j=>j.scope===scope).map(j=>({...linkMonitorSummary(j),live:runtime.linkMonitorJobId===j.id&&!!runtime.linkMonitorJob})),monitorAlerts:runtime.store.values('monitorNotification:').filter(j=>j.scope===scope&&!j.dismissed),publicLibraryJobs:runtime.store.values('publicLibraryJob:').filter(j=>j.scope===scope).map(({id,status,at,completedAt,stats,error})=>({id,status,at,completedAt,stats,error,live:runtime.publicLibraryJobId===id&&!!runtime.publicLibraryJob})),linkMonitorResults:overlaid.documents.linkMonitorResults||{},at:saved.at,cached:!refreshed,error,model,revisions:saved.snapshot.revisions,gmail:runtime.store.get('gmail'),domainAgeJobs:runtime.store.values('domainAgeJob:').filter(j=>j.scope===scope).map(({id,cursor,domains,status,error,refresh,cachedCount,lookedUp,knownCount,excludedDomains,pruneExcluded})=>({id,cursor,count:domains.length,status,error,refresh,cachedCount,lookedUp,knownCount,excludedDomains:excludedDomains||[],pruneExcluded:pruneExcluded||false,live:runtime.domainAgeJobId===id&&!!runtime.domainAgeJob})),backupImports:runtime.store.values('backupImport:').filter(j=>j.scope===scope).map(({id,status,changes,items,excludedKeys})=>({id,status,excludedKeys:excludedKeys||[],count:changes.length,remaining:(items||[]).filter(id=>!['confirmed','discarded'].includes(runtime.store.get('appMutation:'+id)?.status)).length})),
  backupUploads:runtime.store.values('backupUpload:').filter(item=>item.scope===scope&&item.status==='uploading').map(({id,name,bytes,count})=>({id,name,bytes,count,received:runtime.store.db.prepare('SELECT count(*) AS n FROM state WHERE id LIKE ?').get('backupUploadPart:'+id+':%').n})),
  executionStopped:stopped,executionPaused:runtime.store.get('executionPaused'),activeWorkbenchBatchId:runtime.store.get('activeWorkbenchBatch'),manualSkipRequests:runtime.store.values('manualSkipPending:').filter(item=>item?.scope===scope),settings:Object.fromEntries(applicationSettingKeys.map(k=>[k,k==='targetFilters'?globalThis.ExtLinkTargetFilters.normalize(overlaid.documents[k]):normalizeLegacyPreferences(overlaid.documents)[k]])),workbenchBatches:runtime.store.values('workbenchBatch:'),
  manualWatchJobs:runtime.store.values('manualWatch:').filter(w=>w.scope===scope).map(({taskId,status,checks,error,clickedAt,confirmedAt})=>({taskId,status,checks,error,clickedAt,confirmedAt})),assistant:assistantState(runtime),runtime:{paused:status.paused,busy:status.busy||!!runtime.manualWatchJob||!!runtime.backupImportOperations?.size,activeTaskId:status.activeTaskId,pendingEvents:status.pendingEvents,cloudError:status.cloudError},tasks,
  pendingLearning:pendingFillLearning(runtime).map(({id,profileId,url,status,error})=>({id,profileId,url,status,error})),
  learningExclusions:runtime.store.values('fillLearning:').filter(item=>item.scope===scope&&item.status==='completed_with_exclusions').slice(-20).map(({id,profileId,url,excludedProfile})=>({id,profileId,url,excludedProfile})),
  pendingMedia:pendingMediaUploads(runtime).map(({assetId,profileId,kind,status,error})=>({assetId,profileId,kind,status,error})),
  pendingEdits:pendingApplication(runtime).map(item=>({id:item.id,type:item.operation.type,status:item.status,error:item.error,key:item.key,...(item.status==='conflict'?{operation:item.operation,baseData:item.baseData,remoteData:saved.snapshot.documents[item.key],remoteRevision:saved.snapshot.revisions[item.key]}:{})})),batch:runtime.store.get('acceptanceBatch'),
  acceptances:runtime.store.values('acceptance:').map(frozen=>({id:frozen.id,count:frozen.count,sha256:frozen.sha256,startedAt:frozen.startedAt,productIds:frozen.productIds,
    combinations:frozen.combinations.map(c=>({identity:c.identity,profileId:c.profileId,siteId:c.siteId,url:c.url,existingTaskId:c.existingTaskId})),execution:runtime.store.get('acceptanceExecution:'+frozen.id)}))};
}

import {workbenchScope} from './workbench-sync.mjs';
import {createHash} from 'node:crypto';
import {batchScopeRows,batchJson} from '../../core/workbench-batch-recovery.mjs';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function hasManualSubmissionConsent(runtime,task){
 const current=runtime.store.get('task:'+task.id),consent=current?.manualSubmissionConsent,identity=['runId','profileId','targetId','browserInstance','profileRevision'];
 const queued=current?.originalResume,scope=workbenchScope(runtime.store.get('pair')),batch=current?.workbenchBatchId&&runtime.store.get('workbenchBatch:'+current.workbenchBatchId),parallel=queued?.kind==='manual'&&queued.status==='dispatched'&&queued.execution.kind==='workbench'&&queued.execution.scope===scope&&queued.execution.id===current.workbenchBatchId&&runtime.store.get('activeWorkbenchBatch')===batch?.id&&batch?.status==='running'&&queued.pauseAt===(runtime.store.get('executionPaused')?.at||'')&&queued.profileSha256===createHash('sha256').update(batchJson(current.profileSnapshot)).digest('hex')&&queued.execution.scopeSha256===(batch.scopeSha256||digest(batchScopeRows(batch)))&&queued.execution.configSha256===(batch.configSha256||digest(batch.config))&&identity.every(key=>queued[key]===current[key]);
 return (runtime.store.get('singleTaskId')===task.id||parallel)&&consent?.scope===scope&&identity.every(key=>task[key]!==undefined&&current[key]===task[key]&&consent[key]===task[key])&&!task.attemptBoundary&&!task.receipt&&!current.attemptBoundary&&!current.receipt;
}
export function applySubmissionPreferences(runtime,task,documents,config){
 const manual=hasManualSubmissionConsent(runtime,task);
 const fillOnly=task.fillOnlyRun===true;
 return{...config,fillOnly,autoSubmitDirectory:!fillOnly&&(manual||documents.autoSubmitDirectoryListings!==false),autoSubmitStandardWpComments:!fillOnly&&(manual||documents.autoSubmitStandardWpComments===true),aiComments:documents.targetFilters?.aiComments!==false,aiCommentAllowLink:documents.targetFilters?.aiCommentAllowLink!==false};
}

import {workbenchScope} from './workbench-sync.mjs';
export function applySubmissionPreferences(runtime,task,documents,config){
 const current=runtime.store.get('task:'+task.id),consent=current?.manualSubmissionConsent,identity=['runId','profileId','targetId','browserInstance','profileRevision'];
 const manual=runtime.store.get('singleTaskId')===task.id&&consent?.scope===workbenchScope(runtime.store.get('pair'))&&identity.every(key=>task[key]!==undefined&&current[key]===task[key]&&consent[key]===task[key])&&!task.attemptBoundary&&!task.receipt&&!current.attemptBoundary&&!current.receipt;
 const fillOnly=task.fillOnlyRun===true;
 return{...config,fillOnly,autoSubmitDirectory:!fillOnly&&(manual||documents.autoSubmitDirectoryListings!==false),autoSubmitStandardWpComments:!fillOnly&&(manual||documents.autoSubmitStandardWpComments===true),aiComments:documents.targetFilters?.aiComments!==false,aiCommentAllowLink:documents.targetFilters?.aiCommentAllowLink!==false};
}

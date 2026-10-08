import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {originalLibraryBatchQueue,originalLibraryGlobals,originalBuiltinUrls} from './original-library-catalog.mjs';
import {createAutoVisitMatcher} from '../../executor/src/browser-assistant.mjs';
import {selectScope,priorProductSuccess} from '../../executor/src/shared.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';

const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
const identity=task=>task?Object.fromEntries(['url','key','destinationKey','profileId'].map(key=>[key,task[key]])):null;
export async function compareOriginalAutoVisitScope(snapshot,onProfile=()=>{}){
 const before=hash(snapshot),docs=snapshot.documents,queue=originalLibraryGlobals.ExtLinkQueue,reports=[];
 const profiles=Object.entries(docs.siteProfiles||{}).filter(([,profile])=>!profile.archived&&originalLibraryGlobals.ExtLinkProfiles.profileConfigured(profile)),defaultQueue=await originalLibraryBatchQueue(snapshot);
 for(const [profileId] of profiles){
  const explicitSnapshot={...snapshot,documents:{...docs,selectedSiteIds:[profileId],activeSiteId:profileId}};
  // The previous audit explicitly selected one product only in the frozen
  // loader. Align that choice on both sides and add a distinct untouched,
  // stored-selection case; do not hide selection differences as exclusions.
  for(const selection of [{kind:'explicit_product',snapshot:explicitSnapshot,queue:await originalLibraryBatchQueue(explicitSnapshot)},{kind:'original_stored_selection',snapshot,queue:defaultQueue}]){
  const original=selection.queue,matchVisit=createAutoVisitMatcher(selection.snapshot,profileId),mismatches=[],currentGateReasons={};let cases=0,originalMatched=0,nativeMatched=0,originalExcluded=0,currentGateExclusions=0;
  // Every frozen compiled route and a later form path, including routes excluded
  // by the original queue. Current stricter executor gates are reported separately.
  for(const compiledUrl of originalBuiltinUrls){
   for(const url of [compiledUrl,new URL('/actual-form',compiledUrl).href]){
    let expected=queue.matchSubmissionTarget(url,original.tasks,profileId),reason='';
    const annotation=docs.siteAnnotations?.[queue.normalizeDestinationKey(url)]||docs.siteAnnotations?.[queue.extractDomain(url)];
    if(annotation&&queue.hasAnnotationStatusInSet(annotation,queue.DEAD_END_STATUSES))expected=null;
    if(expected){
     originalMatched++;const current=selectScope(snapshot,null,profileId,[expected.url]);
     if(priorProductSuccess(docs.submissionRecords,profileId,url))reason='该产品在此站已有成功提交记录';
     else if(!current.tasks.length)reason=current.exclusions[0]?.reason||'current_executor_exclusion';
     if(reason){currentGateExclusions++;currentGateReasons[reason]=(currentGateReasons[reason]||0)+1;expected=null;}
    }else originalExcluded++;
    const actual=matchVisit(url);if(actual)nativeMatched++;cases++;
    if(!isDeepStrictEqual(identity(actual),identity(expected)))mismatches.push({identitySha256:hash([profileId,url]),expectedSha256:hash(identity(expected)),actualSha256:hash(identity(actual)),currentGateReason:reason});
   }
  }
  const report={selection:selection.kind,profileSha256:hash(profileId),cases,originalMatched,originalExcluded,currentGateExclusions,currentGateReasons,nativeMatched,mismatchCount:mismatches.length,mismatches};reports.push(report);await onProfile(report);
  }
 }
 return{sourceUnchanged:hash(snapshot)===before,profiles:profiles.length,selectionCases:reports.length,compiledRoutes:originalBuiltinUrls.length,cases:reports.reduce((n,row)=>n+row.cases,0),mismatchCount:reports.reduce((n,row)=>n+row.mismatchCount,0),currentGateExclusions:reports.reduce((n,row)=>n+row.currentGateExclusions,0),reports};
}

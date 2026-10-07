import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {originalLibraryBatchQueue,originalLibraryGlobals} from './original-library-catalog.mjs';
import {originalLibraryBatchScope} from '../../core/library-batch-scope.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';

const fields=['id','key','url','domain','profileId','profileName','source','platformType','category','quality','destinationGroupKey','groupJobIndex'];
const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
const shape=task=>Object.fromEntries(fields.map(key=>[key,task[key]]));
export async function compareOriginalQueueScope(snapshot){
 const before=hash(snapshot),docs=snapshot.documents,all=Object.entries(docs.siteProfiles||{}).filter(([,profile])=>!profile.archived&&originalLibraryGlobals.ExtLinkProfiles.profileConfigured(profile)).map(([id])=>id),selected=(docs.selectedSiteIds||[]).filter(id=>all.includes(id)),profiles=selected.length?selected:[docs.activeSiteId].filter(id=>all.includes(id)),selections=[{kind:'all_configured_products',profileIds:all},{kind:'original_selected_products',profileIds:profiles}],scopes=[{},...originalLibraryGlobals.ExtLinkLibraryClassifier.CATEGORY_ORDER.map(category=>({category})),...originalLibraryGlobals.ExtLinkLibraryGroups.GROUPS.map(([group])=>({group}))],reports=[];
 for(const selection of selections)for(const scope of scopes){
  if(!selection.profileIds.length)continue;
  const input={profileIds:selection.profileIds,...scope},reference=await originalLibraryBatchQueue(snapshot,input),actual=originalLibraryBatchScope(snapshot,input),expected=reference.tasks.map(shape),current=actual.tasks.map(shape),mismatches=[];
  for(let i=0;i<Math.max(expected.length,current.length);i++){const changed=fields.filter(key=>!isDeepStrictEqual(expected[i]?.[key],current[i]?.[key]));if(changed.length)mismatches.push({index:i,identitySha256:hash([expected[i]?.id,current[i]?.id]),fields:changed});}
  const metadataDifferences=['beforeFilter','total','excluded','destinationTotal','category','group','selectedProfileTotal'].filter(key=>!isDeepStrictEqual(reference.meta[key],actual.meta[key]));if(!isDeepStrictEqual(reference.selectedProfileIds,actual.selectedProfileIds))metadataDifferences.push('selectedProfileIds');
  reports.push({selection:selection.kind,profileCount:selection.profileIds.length,...scope,originalTasks:expected.length,nativeTasks:current.length,comparisons:Math.max(expected.length,current.length)*fields.length,originalProjectionSha256:hash(expected),nativeProjectionSha256:hash(current),mismatches,metadataDifferences});
 }
 return{rows:docs.sheetTableData?.entries?.length||0,configuredProducts:all.length,selectedProducts:profiles.length,fieldsCompared:fields,sourceUnchanged:before===hash(snapshot),scopeCases:reports.length,comparisons:reports.reduce((n,row)=>n+row.comparisons,0),mismatchCount:reports.reduce((n,row)=>n+row.mismatches.length+row.metadataDifferences.length,0),reports};
}

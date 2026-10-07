import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {originalLibraryBatchQueue,originalLibraryGlobals} from './original-library-catalog.mjs';
import {originalNavigationQueue} from '../../core/submission-queue.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';

const groupFields=['id','key','destinationKey','url','domain','platformType','source','note','quality','status','index'];
const metaFields=['gatedByBlacklist','gatedByDomainAge','gatedByQuality','fromTable','fromPlugin','beforeFilter','excluded','total','destinationTotal','category','group','selectedProfileTotal','successfulSkipped'];
const hash=value=>createHash('sha256').update(batchJson(value)).digest('hex');
export async function compareOriginalNavigationScope(snapshot){
 const before=hash(snapshot),docs=snapshot.documents,all=Object.entries(docs.siteProfiles||{}).filter(([,profile])=>!profile.archived&&originalLibraryGlobals.ExtLinkProfiles.profileConfigured(profile)).map(([id])=>id),selected=(docs.selectedSiteIds||[]).filter(id=>all.includes(id)),active=selected.length?selected:[docs.activeSiteId||all[0]].filter(id=>all.includes(id)),reports=[];
 for(const selection of [{kind:'all_configured_products',profileIds:all},{kind:'original_selected_products',profileIds:active}]){
  if(!selection.profileIds.length)continue;
  const original=await originalLibraryBatchQueue(snapshot,{profileIds:selection.profileIds}),actual=originalNavigationQueue(snapshot,{selectedSiteIds:selection.profileIds}),mismatches=[];let comparisons=0,additionalMediaDisabledConfigurations=0;
  for(let n=0;n<Math.max(original.groups.length,actual.groups.length);n++){
   const expected=original.groups[n],current=actual.groups[n],changed=groupFields.filter(key=>!isDeepStrictEqual(expected?.[key],current?.[key]));comparisons+=groupFields.length;
   if(changed.length)mismatches.push({index:n,identitySha256:hash([expected?.key,current?.key]),fields:changed});
   for(let j=0;j<Math.max(expected?.jobs.length||0,current?.jobs.length||0);j++){
    const old=expected?.jobs[j],job=current?.jobs[j],keys=Object.keys(old||{}),fields=keys.filter(key=>key!=='config'&&!isDeepStrictEqual(old[key],job?.[key]));comparisons+=keys.length;
    const configFields=Object.keys(old?.config||{}).filter(key=>!isDeepStrictEqual(old.config[key],job?.config?.[key]));comparisons+=Object.keys(old?.config||{}).length;
    const extraConfigKeys=Object.keys(job?.config||{}).filter(key=>!Object.hasOwn(old?.config||{},key)&&key!=='mediaDisabled');if(Object.hasOwn(job?.config||{},'mediaDisabled')&&!Object.hasOwn(old?.config||{},'mediaDisabled'))additionalMediaDisabledConfigurations++;
    if(fields.length||configFields.length||extraConfigKeys.length||!old||!job)mismatches.push({index:n,jobIndex:j,identitySha256:hash([old?.id,job?.id]),fields,configFields,extraConfigKeys});
   }
  }
  const metadataDifferences=metaFields.filter(key=>!isDeepStrictEqual(original.meta[key],actual.meta[key]));comparisons+=metaFields.length;
  reports.push({selection:selection.kind,profiles:selection.profileIds.length,originalGroups:original.groups.length,nativeGroups:actual.groups.length,originalJobs:original.groups.reduce((n,group)=>n+group.jobs.length,0),currentEligible:actual.meta.currentEligible,comparisons,mismatches,metadataDifferences,additionalMediaDisabledConfigurations});
 }
 return{sourceUnchanged:hash(snapshot)===before,scopeCases:reports.length,comparisons:reports.reduce((n,report)=>n+report.comparisons,0),mismatchCount:reports.reduce((n,report)=>n+report.mismatches.length+report.metadataDifferences.length,0),groupFields,metaFields,allOriginalJobAndConfigKeysCompared:true,additionalConfigFieldAllowance:['mediaDisabled'],reports};
}

import {applicationModel} from './application-model.mjs';
import {canonicalLibraryDestination} from './library-records.mjs';
import './scheduler.js';
import './profiles.js';
import {originalLibraryBatchScope} from './library-batch-scope.mjs';
import {libraryRecords} from './library-records.mjs';
const {selectScope}=globalThis.ExtLinkExecutorContract,queue=globalThis.ExtLinkQueue,profiles=globalThis.ExtLinkProfiles,opportunity=globalThis.ExtLinkOpportunityScore;

export function pendingSubmissionQueue(snapshot,input={}){
 const docs=snapshot.documents,configured=Object.keys(docs.siteProfiles||{}).filter(id=>!docs.siteProfiles[id].archived&&profiles.profileConfigured(docs.siteProfiles[id]));
 const selectedProfileIds=[...new Set(input.selectedSiteIds??(docs.selectedSiteIds?.length?docs.selectedSiteIds:[docs.activeSiteId||configured[0]]))].filter(Boolean);
 if(selectedProfileIds.some(id=>!configured.includes(id)))throw Error('请选择已配置资料的在用产品');
 const library=new Map(applicationModel(snapshot).library.flatMap(row=>(row.aliases||[{destinationKey:row.destinationKey}]).map(alias=>[alias.destinationKey,row]))),grouped=new Map(),exclusions=[];
 for(const profileId of selectedProfileIds){const selected=selectScope(snapshot,null,profileId);exclusions.push(...selected.exclusions.map(item=>({...item,profileId})));
  for(const item of selected.tasks){const row=library.get(item.destinationKey);if(input.category&&row?.category!==input.category||input.group&&!row?.groups?.includes(input.group))continue;
   const displayKey=canonicalLibraryDestination(item.url);let group=grouped.get(displayKey);if(!group){group={key:displayKey,destinationKey:displayKey,url:item.url,domain:queue.extractDomain(item.url),quality:row?.quality,category:row?.category||'',groups:row?.groups||[],jobs:[],status:'pending'};grouped.set(group.key,group);}
   if(group.jobs.some(job=>job.profileId===profileId))continue;
   group.jobs.push({id:item.destinationKey+'::'+profileId,profileId,profileName:docs.siteProfiles[profileId].name||profileId,url:item.url,destinationKey:item.destinationKey,status:'pending'});
  }
 }
 const groups=[...grouped.values()].sort(opportunity.compareOpportunities);return structuredClone({groups,selectedProfileIds,meta:{total:groups.reduce((n,g)=>n+g.jobs.length,0),destinationTotal:groups.length,selectedProfileTotal:selectedProfileIds.length,excluded:exclusions.length,category:input.category||'',group:input.group||''},exclusions});
}

// Browsing uses the original complete group queue, including compiled routes
// and destinations gated after grouping. Registration continues to use the
// executor's stricter current submission checks; browsing grants no authority.
export function originalNavigationQueue(snapshot,input={}){
 const docs=snapshot.documents,configured=Object.keys(docs.siteProfiles||{}).filter(id=>!docs.siteProfiles[id].archived&&profiles.profileConfigured(docs.siteProfiles[id]));
 const requested=input.selectedSiteIds??docs.selectedSiteIds??[],selectedProfileIds=[...new Set(requested.length?requested:[docs.activeSiteId||configured[0]])].filter(Boolean);
 if(selectedProfileIds.some(id=>!configured.includes(id)))throw Error('请选择已配置资料的在用产品');
 if(!selectedProfileIds.length)return{groups:[],tasks:[],selectedProfileIds:[],meta:{total:0,destinationTotal:0,selectedProfileTotal:0,currentEligible:0,excluded:0,category:input.category||'',group:input.group||''},exclusions:[]};
 const original=originalLibraryBatchScope(snapshot,{profileIds:selectedProfileIds,category:input.category,group:input.group}),urls=[...new Set(original.groups.map(group=>group.url))],allowed=new Map(),blocked=new Map();
 for(const profileId of selectedProfileIds){const current=urls.length?selectScope(snapshot,null,profileId,urls):{tasks:[],exclusions:[]};for(const task of current.tasks)allowed.set(profileId+'::'+canonicalLibraryDestination(task.url),true);for(const item of current.exclusions)blocked.set(profileId+'::'+canonicalLibraryDestination(item.url),item.reason);}
 const groups=original.groups.map(group=>({...group,jobs:group.jobs.map(job=>{const key=job.profileId+'::'+canonicalLibraryDestination(group.url);return{...job,eligible:allowed.has(key),exclusionReason:blocked.get(key)||''};})})),records=libraryRecords(docs);
 const meta={...original.meta,gatedByBlacklist:original.exclusions.filter(item=>item.reason==='blacklist').length,gatedByDomainAge:original.exclusions.filter(item=>['domain_age','domain_age_unknown'].includes(item.reason)).length,gatedByQuality:original.exclusions.filter(item=>item.reason==='low_opportunity_score').length,fromTable:groups.filter(group=>group.source==='table').length,fromPlugin:groups.filter(group=>group.source!=='table').length,successfulSkipped:Object.values(records).filter(record=>record?.status==='success'&&selectedProfileIds.includes(record.profileId)).length,currentEligible:groups.reduce((n,group)=>n+group.jobs.filter(job=>job.eligible).length,0)};
 return structuredClone({...original,groups,meta});
}

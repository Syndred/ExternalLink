import {applicationModel} from './application-model.mjs';
import './scheduler.js';
import './profiles.js';
const {selectScope}=globalThis.ExtLinkExecutorContract,queue=globalThis.ExtLinkQueue,profiles=globalThis.ExtLinkProfiles,opportunity=globalThis.ExtLinkOpportunityScore;

export function pendingSubmissionQueue(snapshot,input={}){
 const docs=snapshot.documents,configured=Object.keys(docs.siteProfiles||{}).filter(id=>!docs.siteProfiles[id].archived&&profiles.profileConfigured(docs.siteProfiles[id]));
 const selectedProfileIds=[...new Set(input.selectedSiteIds??(docs.selectedSiteIds?.length?docs.selectedSiteIds:[docs.activeSiteId||configured[0]]))].filter(Boolean);
 if(selectedProfileIds.some(id=>!configured.includes(id)))throw Error('请选择已配置资料的在用产品');
 const library=new Map(applicationModel(snapshot).library.map(row=>[row.destinationKey,row])),grouped=new Map(),exclusions=[];
 for(const profileId of selectedProfileIds){const selected=selectScope(snapshot,null,profileId);exclusions.push(...selected.exclusions.map(item=>({...item,profileId})));
  for(const item of selected.tasks){const row=library.get(item.destinationKey);if(input.category&&row?.category!==input.category||input.group&&!row?.groups?.includes(input.group))continue;
   let group=grouped.get(item.destinationKey);if(!group){group={key:item.destinationKey,destinationKey:item.destinationKey,url:item.url,domain:queue.extractDomain(item.url),quality:row?.quality,category:row?.category||'',groups:row?.groups||[],jobs:[],status:'pending'};grouped.set(group.key,group);}
   group.jobs.push({id:item.destinationKey+'::'+profileId,profileId,profileName:docs.siteProfiles[profileId].name||profileId,url:item.url,destinationKey:item.destinationKey,status:'pending'});
  }
 }
 const groups=[...grouped.values()].sort(opportunity.compareOpportunities);return structuredClone({groups,selectedProfileIds,meta:{total:groups.reduce((n,g)=>n+g.jobs.length,0),destinationTotal:groups.length,selectedProfileTotal:selectedProfileIds.length,excluded:exclusions.length,category:input.category||'',group:input.group||''},exclusions});
}

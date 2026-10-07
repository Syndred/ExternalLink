import './queue.js';
import './profiles.js';
import './target-filters.js';
import './library-classifier.js';
import './library-groups.js';
import './opportunity-score.js';
import './url-library.js';
import {canonicalLibraryDestination,libraryRecords} from './library-records.mjs';
const self=globalThis,queue=self.ExtLinkQueue,profiles=self.ExtLinkProfiles;
const canonicalDestinationKey=canonicalLibraryDestination;
const recordsForDestination=(records,key)=>Object.entries(records||{}).filter(([,r])=>canonicalDestinationKey(r?.destinationKey||r?.destinationUrl||'')===canonicalDestinationKey(key));

function scopeDestinationGroupsByLibraryCategory(groups = [], category = "") {
  const requestedCategory = String(category || "").trim();
  if (!requestedCategory) return groups;
  if (!self.ExtLinkLibraryClassifier.CATEGORY_ORDER.includes(requestedCategory)) {
    throw new Error("外链分类无效，请重新选择");
  }
  return groups
    .filter((group) => group.source !== "library")
    .map((group) => {
      const classification = self.ExtLinkLibraryClassifier.describe({
        entry: group.entry || {},
        url: group.url,
        domain: group.domain,
        note: group.note || group.entry?.note || "",
        detail: group.entry?.detail || "",
        metrics: group.quality?.metrics || group.entry?.metrics || {},
      });
      return { ...group, category: classification.category, classification };
    })
    .filter((group) => group.category === requestedCategory);
}

function scopeDestinationGroupsByLibraryGroup(groups = [], groupId = "", annotations = {}, records = {}, monitorResults = {}) {
  const requestedGroup = String(groupId || "").trim();
  if (!requestedGroup) return groups;
  if (!self.ExtLinkLibraryGroups.GROUPS.some(([id]) => id === requestedGroup)) {
    throw new Error("外链分组无效，请重新选择");
  }
  return groups.filter((group) => {
    const annotation = annotations[group.destinationKey] || annotations[group.domain] || null;
    const classification = group.classification || self.ExtLinkLibraryClassifier.describe({
      entry: group.entry || {},
      url: group.url,
      domain: group.domain,
      note: group.note || group.entry?.note || "",
      detail: group.entry?.detail || "",
      metrics: group.quality?.metrics || group.entry?.metrics || {},
    });
    const profileStatuses = recordsForDestination(records, group.destinationKey)
      .map(([, record]) => ({ success: record?.status === "success" }));
    const monitorStatuses = recordsForDestination(records, group.destinationKey)
      .map(([recordKey]) => monitorResults[recordKey]?.status)
      .filter(Boolean);
    return self.ExtLinkLibraryGroups.matches({
      url: group.url,
      annotation,
      quality: group.quality,
      metrics: group.quality?.metrics || group.entry?.metrics || {},
      category: classification.category,
      accessModel: classification.accessModel,
      profileStatuses,
      monitorStatus: monitorStatuses.includes("missing") ? "missing" : "",
    }, requestedGroup);
  });
}

function expandSubmissionRecordsForQueue(records, candidateUrls = []) {
  const expanded = { ...(records || {}) };
  const candidateKeys = [...new Set((candidateUrls || [])
    .map((value) => self.ExtLinkQueue.normalizeDestinationKey(value))
    .filter(Boolean))];
  for (const [, record] of Object.entries(records || {})) {
    const profileId = String(record?.profileId || "").trim();
    const canonical = canonicalDestinationKey(record?.destinationKey || record?.destinationUrl || "");
    if (!profileId || !canonical || record?.status !== "success") continue;
    for (const candidateKey of candidateKeys) {
      if (canonicalDestinationKey(candidateKey) !== canonical) continue;
      const aliasKey = self.ExtLinkQueue.submissionRecordKey(candidateKey, profileId);
      if (!expanded[aliasKey]) expanded[aliasKey] = record;
    }
  }
  return expanded;
}

export function originalLibraryBatchScope(snapshot,input={}){
 const docs=snapshot.documents||{},siteProfiles=docs.siteProfiles||{},selectedProfileIds=[...new Set(input.profileIds||docs.selectedSiteIds||[])];
 if(!selectedProfileIds.length||selectedProfileIds.some(id=>!siteProfiles[id]||siteProfiles[id].archived))throw Error('请选择在用产品');
 const category=String(input.category||'').trim(),group=String(input.group||'').trim();
 if(category&&!self.ExtLinkLibraryClassifier.CATEGORY_ORDER.includes(category))throw Error('外链分类无效，请重新选择');
 if(group&&!self.ExtLinkLibraryGroups.GROUPS.some(([id])=>id===group))throw Error('外链分组无效，请重新选择');
 const tableData=docs.sheetTableData||{},annotations=docs.siteAnnotations||{},records=libraryRecords(docs),pluginUrls=queue.resolvePluginUrls(docs.urlList||'',self.ExtLinkUrlLibrary||[]);
 const candidates=[...(tableData.entries||[]).map(entry=>entry.indexPage||entry.link),...pluginUrls.map(entry=>entry.url)].filter(Boolean);
 const queueRecords=expandSubmissionRecordsForQueue(records,candidates);
 const allGroups=queue.buildDestinationGroups({tableData,pluginUrls,siteProfiles,selectedProfileIds,submissionRecords:queueRecords,annotations,findMatchingProfile:profiles.findMatchingProfile,buildAgentConfigFromProfile:profile=>profiles.buildAgentConfigFromProfile(profile,{email:docs.cfgEmail,username:docs.cfgName})}).map(group=>({...group,quality:self.ExtLinkOpportunityScore.scoreOpportunity({metrics:{...(group.entry?.metrics||{}),...(docs.domainMetricsCache||{})[group.domain]},annotation:annotations[group.destinationKey]||annotations[group.domain]||null})})).sort(self.ExtLinkOpportunityScore.compareOpportunities);
 const groups=scopeDestinationGroupsByLibraryGroup(scopeDestinationGroupsByLibraryCategory(allGroups,category),group,annotations,records,docs.linkMonitorResults||{}),flattened=queue.flattenDestinationGroups(groups),exclusions=[];
 const eligible=flattened.filter(task=>{const mark=self.ExtLinkLibraryClassifier.libraryEligibility(annotations[task.key]||annotations[task.domain]||null,task.profileId);if(mark.allowed)return true;exclusions.push({key:task.key,url:task.url,profileId:task.profileId,reason:mark.reason});return false;});
 const filters=self.ExtLinkTargetFilters.normalize(docs.targetFilters),gated=queue.filterSubmissionTasks(eligible,{deletedKeys:docs.deletedSubmissionKeys||[],annotations,blacklist:filters.blacklistEnabled?docs.domainBlacklist||[]:[],minDomainAgeMonths:filters.minDomainAgeMonths,requireKnownDomainAge:filters.requireKnownDomainAge,domainMetrics:docs.domainMetricsCache||{},collectExclusions:true});
 exclusions.push(...(gated.gateExclusions||[]));
 const tasks=gated.filter(task=>{if(!(filters.minOpportunityScore>0)||Number(task.quality?.score||0)>=filters.minOpportunityScore)return true;exclusions.push({key:task.key,url:task.url,profileId:task.profileId,reason:'low_opportunity_score'});return false;});
 return structuredClone({tasks,groups,selectedProfileIds,exclusions,meta:{category,group,beforeFilter:flattened.length,total:tasks.length,destinationTotal:groups.length,excluded:flattened.length-tasks.length,selectedProfileTotal:selectedProfileIds.length}});
}

(function (global) {
  'use strict';
  const queue = global.ExtLinkQueue, classifier = global.ExtLinkLibraryClassifier;
  function inventory(snapshot, bundled) {
    const docs = snapshot.documents, cloudTable = docs.sheetTableData;
    const table = cloudTable?.entries ? cloudTable : bundled;
    const urlRows = queue.parseUrlLines(docs.urlList || '');
    const candidates = [...(table?.entries || []).map(row => ({ url: row.indexPage || row.link, source: cloudTable?.entries ? 'cloud.sheetTableData' : 'bundled.table-library', row })), ...urlRows.map(row => ({ ...row, source: 'cloud.urlList' }))];
    const unique = new Map();
    for (const item of candidates) {
      try { const url = new URL(item.url); if (!['http:', 'https:'].includes(url.protocol)) continue;
        const key = queue.normalizeDestinationKey(item.url); if (!unique.has(key)) unique.set(key, { ...item, destinationKey: key });
      } catch {}
    }
    return { sources: { cloudTableRows: cloudTable?.entries?.length || 0, bundledTableRows: bundled?.entries?.length || 0, cloudUrlListRows: urlRows.length }, total: unique.size, candidates: [...unique.values()] };
  }
  function priorProductSuccess(records, profileId, url) {
    const host = queue.extractDomain(url).toLowerCase();
    return Object.entries(records || {}).some(([key, record]) => {
      if (record?.status !== 'success') return false;
      const separator = key.lastIndexOf('::');
      const recordedProfile = record.profileId || (separator < 0 ? '' : key.slice(separator + 2));
      if (recordedProfile !== profileId) return false;
      const destination = record.destinationUrl || record.destinationKey || (separator < 0 ? key : key.slice(0, separator));
      const destinationKey = queue.normalizeDestinationKey(destination);
      if (!queue.isSubmissionSuccessful({ [queue.submissionRecordKey(destinationKey, recordedProfile)]: record }, destinationKey, recordedProfile)) return false;
      return queue.extractDomain(destination).toLowerCase() === host;
    });
  }
  function selectScope(snapshot, bundled, profileId, requestedUrls) {
    if(snapshot.documents?.siteProfiles?.[profileId]?.archived)throw new Error('产品已归档，请恢复后安排新任务');
    const library = inventory(snapshot, bundled), docs = snapshot.documents, exclusions = [], tasks = [];
    const requested = new Set((requestedUrls || []).map(url => queue.normalizeLibraryDestinationKey(url))), seen = new Set();
    // The original group queue also contains compiled library routes. Add only
    // explicitly requested, known routes; this never admits arbitrary URLs.
    if(requested.size){const present=new Set(library.candidates.map(item=>queue.normalizeLibraryDestinationKey(item.url)));for(const url of global.ExtLinkUrlLibrary||[]){const key=queue.normalizeLibraryDestinationKey(url);if(requested.has(key)&&!present.has(key)){library.candidates.push({url,destinationKey:queue.normalizeDestinationKey(url),source:'builtin.url-library'});present.add(key);}}}
    const records = queue.migrateSubmissionRecords({ records: docs.submissionRecords || {}, annotations: docs.siteAnnotations || {}, tableData: docs.sheetTableData || bundled || {} }).records;
    const filters=global.ExtLinkTargetFilters.normalize(docs.targetFilters);
    const blacklist = filters.blacklistEnabled===false?null:queue.buildBlacklistMatcher(Array.isArray(docs.domainBlacklist) ? docs.domainBlacklist : String(docs.domainBlacklist || '').split(/[\n,]/));
    const blockedStatuses = new Set([...queue.DEAD_END_STATUSES, ...queue.GATE_STATUSES, 'paid', 'do_not_submit', 'not_suitable']);
    for (const item of library.candidates) {
      const catalogKey = queue.normalizeLibraryDestinationKey(item.url);
      if (requested.size && !requested.has(catalogKey) || seen.has(catalogKey)) continue;
      seen.add(catalogKey);
      const domain = queue.extractDomain(item.url);
      const annotation = queue.findDestinationAnnotation(docs.siteAnnotations || {}, catalogKey, domain) || {};
      const mark = classifier.libraryEligibility(annotation, profileId);
      const deleted = (docs.deletedSubmissionKeys || []).some(key => queue.normalizeLibraryDestinationKey(key) === catalogKey);
      const metrics={...item.row,...item.row?.metrics,...docs.domainMetricsCache?.[domain]},quality=global.ExtLinkOpportunityScore?.scoreOpportunity({metrics,annotation});
      const ageReason=queue.domainAgeGate(domain,{...filters,domainMetrics:docs.domainMetricsCache||{}});
      const qualityReason=filters.minOpportunityScore>0&&quality&&quality.score<filters.minOpportunityScore?'低于最低质量分':filters.minDr>0&&!(Number(metrics.dr)>=filters.minDr)?'低于最低 DR':filters.minDa>0&&!(Number(metrics.da)>=filters.minDa)?'低于最低 DA':ageReason==='domain_age_unknown'?'域名年龄未知':ageReason==='domain_too_young'?'低于最低域名年龄':'';
      const reason = priorProductSuccess(records, profileId, item.url) ? '该产品在此站已有成功提交记录' : deleted ? '人工删除的目标' : blacklist?.(domain) ? '域名黑名单' : !mark.allowed ? mark.reason : queue.normalizeAnnotationStatuses(annotation).some(s => blockedStatuses.has(s)) ? '人工标记排除' : qualityReason;
      if (reason) exclusions.push({ url: item.url, reason }); else tasks.push({ url: item.url, destinationKey: item.destinationKey, source: item.source });
    }
    if (requested.size && tasks.length + exclusions.length < requested.size) throw new Error('部分选定站点不在现有外链库中，请先在原外链库导入');
    return { ...library, candidates: undefined, tasks, exclusions };
  }
  function validateSinglePagePreparation(snapshot,run){
    const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
    if(run.mode!=='single_page_preparation'||run.authorization!=='fill_only'||run.tasks?.length!==1||run.feeLimit!==0)fail('单页填写范围必须为一个网站且不得授权投稿');
    const profile=snapshot.documents.siteProfiles?.[run.profileId];if(!profile||profile.archived||run.profileRevision!==snapshot.revisions.siteProfiles)fail('产品资料已变化或已归档',409);
    let url;try{url=new URL(run.tasks[0].url);}catch{fail('填写目标必须为普通网页');}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('填写目标必须为普通网页');
    if(priorProductSuccess(snapshot.documents.submissionRecords,run.profileId,url.href))fail('该产品同站已有收件，请先核验原记录',409);
  }
  global.ExtLinkExecutorContract = { inventory, selectScope, priorProductSuccess, validateSinglePagePreparation };
})(typeof self !== 'undefined' ? self : globalThis);

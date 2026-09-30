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
      return queue.extractDomain(destination).toLowerCase() === host;
    });
  }
  function selectScope(snapshot, bundled, profileId, requestedUrls) {
    if(snapshot.documents?.siteProfiles?.[profileId]?.archived)throw new Error('产品已归档，请恢复后安排新任务');
    const library = inventory(snapshot, bundled), docs = snapshot.documents, exclusions = [], tasks = [];
    const requested = new Set((requestedUrls || []).map(url => queue.normalizeDestinationKey(url)));
    const records = queue.migrateSubmissionRecords({ records: docs.submissionRecords || {}, annotations: docs.siteAnnotations || {}, tableData: docs.sheetTableData || bundled || {} }).records;
    const blacklist = queue.buildBlacklistMatcher(Array.isArray(docs.domainBlacklist) ? docs.domainBlacklist : String(docs.domainBlacklist || '').split(/[\n,]/));
    const blockedStatuses = new Set([...queue.DEAD_END_STATUSES, ...queue.GATE_STATUSES, 'paid', 'do_not_submit', 'not_suitable']);
    for (const item of library.candidates) {
      if (requested.size && !requested.has(item.destinationKey)) continue;
      const domain = queue.extractDomain(item.url);
      const annotation = queue.findDestinationAnnotation(docs.siteAnnotations || {}, item.destinationKey, domain) || {};
      const mark = classifier.libraryEligibility(annotation, profileId);
      const deleted = queue.hasStoredDestinationKey(docs.deletedSubmissionKeys || [], item.destinationKey);
      const reason = priorProductSuccess(records, profileId, item.url) ? '该产品在此站已有成功提交记录' : deleted ? '人工删除的目标' : blacklist?.(domain) ? '域名黑名单' : !mark.allowed ? mark.reason : queue.normalizeAnnotationStatuses(annotation).some(s => blockedStatuses.has(s)) ? '人工标记排除' : '';
      if (reason) exclusions.push({ url: item.url, reason }); else tasks.push({ url: item.url, destinationKey: item.destinationKey, source: item.source });
    }
    if (requested.size && tasks.length + exclusions.length < requested.size) throw new Error('部分选定站点不在现有外链库中，请先在原外链库导入');
    return { ...library, candidates: undefined, tasks, exclusions };
  }
  global.ExtLinkExecutorContract = { inventory, selectScope, priorProductSuccess };
})(typeof self !== 'undefined' ? self : globalThis);

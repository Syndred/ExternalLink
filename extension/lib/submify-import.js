(function (global) {
  "use strict";

  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function finiteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function normalizeTags(value) {
    const tags = global.ExtLinkLibraryClassifier?.normalizeTags(value) || [];
    return [...new Set(tags.map(compact).filter(Boolean))];
  }

  function sourceEntry(item = {}, importedAt = new Date().toISOString()) {
    const link = compact(item.link || item.url);
    return {
      link,
      indexPage: link,
      name: compact(item.name),
      note: compact(item.tips),
      tags: normalizeTags(item.tags),
      detail: compact(item.details),
      source: "submify-public",
      sourceId: compact(item.id),
      sourceRefs: [compact(item.id)].filter(Boolean),
      metrics: {
        dr: finiteNumber(item.dr),
        traffic: finiteNumber(item.organic_traffic),
      },
      pricing: compact(item.access_model || (item.is_paid ? "paid" : "unknown")),
      category: compact(item.link_category),
      language: compact(item.language),
      linkType: compact(item.link_type),
      opportunityType: compact(item.opportunity_type),
      placementType: compact(item.placement_type),
      eligibility: compact(item.eligibility),
      siteStatus: compact(item.site_status),
      confidence: compact(item.confidence),
      sourceStatus: compact(item.status),
      sourceCheckedAt: compact(item.checked_at || item.update_date),
      importedAt,
      rawFields: {
        SubmifyEvidence: compact(item.evidence),
        SubmifyExclusiveOffer: compact(item.exclusive_offer_text),
      },
    };
  }

  function mergeSourceOwned(existing, incoming) {
    const preserved = {
      projects: existing.projects,
      record: existing.record,
      time: existing.time,
      submitted: existing.submitted,
      submissionRecords: existing.submissionRecords,
      rowNumber: existing.rowNumber,
      rawFields: { ...(existing.rawFields || {}), ...(incoming.rawFields || {}) },
    };
    const next = { ...existing, ...incoming, ...preserved };
    for (const [key, value] of Object.entries(preserved)) {
      if (value === undefined) delete next[key];
    }
    return next;
  }

  function mergeShared(existing, incoming) {
    const next = { ...existing };
    for (const [key, value] of Object.entries(incoming)) {
      const empty = next[key] === undefined || next[key] === null || next[key] === "";
      if (empty) next[key] = value;
    }
    next.sourceRefs = [...new Set([
      ...(Array.isArray(existing.sourceRefs) ? existing.sourceRefs : []),
      ...(incoming.sourceRefs || []),
    ].filter(Boolean))];
    next.rawFields = { ...(incoming.rawFields || {}), ...(existing.rawFields || {}) };
    return next;
  }

  function recommendedGate(item = {}) {
    const access = compact(item.access_model).toLowerCase();
    if (item.is_paid === true || access === "paid") return "paid";
    const opportunity = compact(item.opportunity_type).toLowerCase();
    const sourceStatus = compact(item.status).toLowerCase();
    const siteStatus = compact(item.site_status).toLowerCase();
    const eligibility = compact(item.eligibility).toLowerCase();
    if (sourceStatus && sourceStatus !== "approved") return "skip";
    if (siteStatus && siteStatus !== "active") return "skip";
    if (eligibility && eligibility !== "eligible") return "skip";
    if (["blog_comment", "community_post", "guest_post", "forum_post", "content_submission"].includes(opportunity)) {
      return "skip";
    }
    return "";
  }

  function mergeLibrary(tableData = {}, sourceItems = [], options = {}) {
    const normalizeKey = options.normalizeKey;
    if (typeof normalizeKey !== "function") throw new Error("normalizeKey is required");
    const importedAt = compact(options.importedAt) || new Date().toISOString();
    const entries = Array.isArray(tableData.entries) ? tableData.entries.map((entry) => ({ ...entry })) : [];
    const byKey = new Map();
    entries.forEach((entry, index) => {
      const key = normalizeKey(entry.indexPage || entry.link || "");
      if (key && !byKey.has(key)) byKey.set(key, index);
    });
    const addedItems = [];
    let updated = 0;
    let existing = 0;
    for (const item of sourceItems) {
      const incoming = sourceEntry(item, importedAt);
      const key = normalizeKey(incoming.indexPage || incoming.link);
      if (!key) continue;
      const index = byKey.get(key);
      if (index === undefined) {
        entries.push(incoming);
        byKey.set(key, entries.length - 1);
        addedItems.push({ key, item, entry: incoming, gate: recommendedGate(item) });
        continue;
      }
      const current = entries[index];
      const next = current.source === "submify-public"
        ? mergeSourceOwned(current, incoming)
        : mergeShared(current, incoming);
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        entries[index] = next;
        updated += 1;
      } else {
        existing += 1;
      }
    }
    return {
      tableData: {
        ...tableData,
        entries,
        snapshotMeta: {
          ...(tableData.snapshotMeta || {}),
          lastExternalImport: {
            source: "submify-public",
            importedAt,
            sourceTotal: sourceItems.length,
            added: addedItems.length,
            updated,
          },
        },
      },
      addedItems,
      stats: { sourceTotal: sourceItems.length, added: addedItems.length, updated, existing, total: entries.length },
    };
  }

  global.ExtLinkSubmifyImport = {
    mergeLibrary,
    recommendedGate,
    sourceEntry,
  };
})(typeof self !== "undefined" ? self : globalThis);

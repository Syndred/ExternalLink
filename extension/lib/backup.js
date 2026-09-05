// Pure helpers for validating and merging submission-ledger backups.
(function (global) {
  "use strict";

  const FORMAT = "externallink-submission-backup";

  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function validateTimelineValue(value) {
    if (global.ExtLinkSubmissionTimeline && typeof global.ExtLinkSubmissionTimeline.validateTimeline === "function") {
      return global.ExtLinkSubmissionTimeline.validateTimeline(value);
    }
    // backup.js is also used by a few isolated tests/tools.  The background
    // worker loads submission-timeline.js first, but fail clearly if a caller
    // tries to import a timeline without that module instead of accepting an
    // unvalidated payload.
    throw new Error("时间线模块未加载，无法校验外链提交时间线");
  }

  function mergeTimelineValues(currentValue, incomingValue) {
    if (global.ExtLinkSubmissionTimeline && typeof global.ExtLinkSubmissionTimeline.mergeTimelines === "function") {
      return global.ExtLinkSubmissionTimeline.mergeTimelines(currentValue, incomingValue);
    }
    throw new Error("时间线模块未加载，无法合并外链提交时间线");
  }

  function nonempty(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function recordStrength(record) {
    if (!record || record.status !== "success") return 0;
    const sourceScore = { agent: 40, manual: 40, migration: 10 }[record.confirmedBy] || 20;
    const evidenceScore = Math.min(String(record.evidence || "").trim().length, 100) / 10;
    return sourceScore + evidenceScore;
  }

  function mergeRecords(currentRecords, importedRecords) {
    const merged = { ...(currentRecords || {}) };
    for (const [key, incoming] of Object.entries(importedRecords || {})) {
      const existing = merged[key];
      if (existing?.status === "success" && incoming?.status !== "success") continue;
      if (
        existing?.status === "success" &&
        incoming?.status === "success" &&
        recordStrength(existing) >= recordStrength(incoming)
      ) {
        if (global.ExtLinkQueue && typeof global.ExtLinkQueue.mergePublicationFields === "function") {
          merged[key] = global.ExtLinkQueue.mergePublicationFields(existing, incoming);
        }
        continue;
      }
      merged[key] = incoming;
    }
    return merged;
  }

  function mergeProfile(existing = {}, incoming = {}) {
    const incomingFields = Object.fromEntries(
      Object.entries(incoming.fields || {}).filter(([, value]) => nonempty(value)),
    );
    const incomingFieldNotes = Object.fromEntries(
      Object.entries(incoming.fieldNotes || {}).filter(([, value]) => nonempty(value)),
    );
    const merged = {
      ...existing,
      ...Object.fromEntries(Object.entries(incoming).filter(([, value]) => nonempty(value))),
      fields: { ...(existing.fields || {}), ...incomingFields },
      fieldNotes: { ...(existing.fieldNotes || {}), ...incomingFieldNotes },
    };
    if (existing.logoDataUrl && !incoming.logoDataUrl) merged.logoDataUrl = existing.logoDataUrl;
    if (existing.learnedFieldMappings && !incoming.learnedFieldMappings) {
      merged.learnedFieldMappings = existing.learnedFieldMappings;
    }
    return merged;
  }

  function mergeUrlList(currentValue, incomingValue) {
    const values = `${currentValue || ""}\n${incomingValue || ""}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return [...new Set(values)].join("\n");
  }

  function validateBackup(data) {
    if (!data || data.format !== FORMAT) {
      throw new Error("不是有效的 ExternalLink 备份文件");
    }
    if (!data.submissionRecords || typeof data.submissionRecords !== "object") {
      throw new Error("备份缺少提交账本");
    }
    const profiles =
      data.siteProfiles && typeof data.siteProfiles === "object" ? data.siteProfiles : {};
    for (const [id, profile] of Object.entries(profiles)) {
      if (!id || profile?.id !== id) throw new Error(`Profile ID 不稳定: ${id || "unknown"}`);
    }
    const normalized = { ...data, siteProfiles: profiles };
    if (hasOwn(data, "submissionTimeline")) {
      normalized.submissionTimeline = validateTimelineValue(data.submissionTimeline);
    }
    return normalized;
  }

  function mergeBackup(current, rawBackup, schemaVersion) {
    const backup = validateBackup(rawBackup);
    const profiles = { ...(current.siteProfiles || {}) };
    for (const [id, incoming] of Object.entries(backup.siteProfiles)) {
      profiles[id] = mergeProfile(profiles[id], incoming);
    }
    const selectedSiteIds = (Array.isArray(backup.selectedSiteIds)
      ? backup.selectedSiteIds
      : []
    ).filter((id) => profiles[id]);
    const merged = {
      submissionRecords: mergeRecords(current.submissionRecords, backup.submissionRecords),
      submissionSchemaVersion: schemaVersion,
      siteAnnotations: {
        ...(current.siteAnnotations || {}),
        ...(backup.siteAnnotations || {}),
      },
      siteProfiles: profiles,
      activeSiteId:
        backup.activeSiteId && profiles[backup.activeSiteId]
          ? backup.activeSiteId
          : Object.keys(profiles)[0] || "",
      selectedSiteIds,
      urlList: mergeUrlList(current.urlList, backup.urlList),
    };
    if (hasOwn(current, "submissionTimeline") || hasOwn(backup, "submissionTimeline")) {
      merged.submissionTimeline = mergeTimelineValues(
        current.submissionTimeline,
        backup.submissionTimeline,
      );
      merged.timelineSchemaVersion = Math.max(
        Number(current.timelineSchemaVersion || 0),
        Number(backup.timelineSchemaVersion || 0),
        1,
      );
    }
    return merged;
  }

  global.ExtLinkBackup = {
    FORMAT,
    validateBackup,
    mergeBackup,
    mergeRecords,
    mergeProfile,
    mergeUrlList,
  };
})(typeof self !== "undefined" ? self : window);

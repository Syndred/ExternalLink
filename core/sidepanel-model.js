(function (global) {
  "use strict";

  // Keep the data shaping independent from the DOM so the side panel and its
  // focused tests use the same Profile-aware timeline contract.
  function parseTimelineTimestamp(value) {
    const raw = String(value || "").trim();
    // Legacy spreadsheet rows sometimes contain an Excel date serial. Date.parse
    // interprets e.g. 46261 as year 46261, so convert it before sorting.
    if (/^\d{5}$/.test(raw)) {
      const serial = Number(raw);
      if (serial >= 20000 && serial <= 60000) return Date.UTC(1899, 11, 30) + serial * 86400000;
    }
    return Date.parse(raw);
  }

  function buildTimelineModel(item = {}, siteProfiles = {}) {
    const profileNames = new Map();
    for (const profile of Array.isArray(item.profileStatuses) ? item.profileStatuses : []) {
      const id = String(profile?.profileId || "").trim();
      if (!id) continue;
      profileNames.set(id, String(profile.profileName || siteProfiles[id]?.name || id).trim() || id);
    }
    for (const [id, profile] of Object.entries(siteProfiles || {})) {
      if (!profileNames.has(id)) profileNames.set(id, String(profile?.name || id).trim() || id);
    }

    const events = [];
    const seenIds = new Set();
    const seenReceipts = new Set();
    const append = (raw, fallback = {}) => {
      if (!raw || typeof raw !== "object") return;
      const profileId = String(raw.profileId || raw.projectId || fallback.profileId || "__destination__").trim() || "__destination__";
      const profileName =
        String(raw.profileName || profileNames.get(profileId) || (profileId === "__destination__" ? "外链站" : profileId)).trim() || profileId;
      const occurredAt = String(raw.occurredAt || raw.submittedAt || raw.time || fallback.occurredAt || "").trim();
      const type = String(raw.publicationStatus || raw.type || raw.status || fallback.type || "note").trim() || "note";
      const id = String(raw.id || "").trim();
      if (id && seenIds.has(id)) return;
      if (id) seenIds.add(id);
      const receiptKey = JSON.stringify([profileId, type, occurredAt, String(raw.note || "").trim(), String(raw.evidenceUrl || "").trim(), String(raw.publicUrl || "").trim()]);
      if (seenReceipts.has(receiptKey)) return;
      seenReceipts.add(receiptKey);
      events.push({ ...raw, profileId, profileName, occurredAt, type, timestamp: parseTimelineTimestamp(occurredAt) });
    };

    for (const event of Array.isArray(item.events) ? item.events : []) append(event);
    // A profile status can carry the latest record even when the flattened
    // event list is unavailable during a background refresh.
    for (const profile of Array.isArray(item.profileStatuses) ? item.profileStatuses : []) {
      const latest = profile?.latestEvent;
      if (latest && typeof latest === "object") append(latest, { profileId: profile.profileId });
      else if (profile?.success || profile?.submittedAt || profile?.publicationStatus) {
        append(
          {
            profileId: profile.profileId,
            profileName: profile.profileName,
            type: profile.publicationStatus || (profile.success ? "submitted" : "note"),
            occurredAt: profile.submittedAt || "",
            note: profile.success ? "已记录成功提交" : "",
          },
          { profileId: profile.profileId },
        );
      }
    }

    events.sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : -Infinity;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : -Infinity;
      return rightTime - leftTime;
    });
    const latestWithTime = events.find((event) => Number.isFinite(event.timestamp));
    const fallbackTime = String(item.time || "").trim();
    return {
      events,
      profileCount: new Set(events.map((event) => event.profileId)).size,
      latestAt: latestWithTime?.occurredAt || fallbackTime,
    };
  }

  function canEditTimeline(item, pageUrl) {
    return /^https?:\/\//i.test(String(pageUrl || ""));
  }

  function normalizeBatchConcurrency(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
  }

  function clampBatchLimit(value, fallback, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
  }

  function buildBatchConfig(options = {}) {
    return {
      autoSkipCaptcha: false,
      concurrency: normalizeBatchConcurrency(options.concurrency),
      pingIndex: options.pingIndex !== false,
      fillOnly: options.fillOnly === true,
      unattended: options.unattended === true,
      unattendedMaxHours: clampBatchLimit(options.unattendedMaxHours, 8, 12),
      unattendedMaxTasks: clampBatchLimit(options.unattendedMaxTasks, 100, 500),
      unattendedMaxManualTabs: clampBatchLimit(options.unattendedMaxManualTabs, 20, 100),
    };
  }

  global.ExtLinkSidepanel = global.ExtLinkSidepanel || {};
  global.ExtLinkSidepanel.buildTimelineModel = buildTimelineModel;
  global.ExtLinkSidepanel.parseTimelineTimestamp = parseTimelineTimestamp;
  global.ExtLinkSidepanel.canEditTimeline = canEditTimeline;
  global.ExtLinkSidepanel.normalizeBatchConcurrency = normalizeBatchConcurrency;
  global.ExtLinkSidepanel.buildBatchConfig = buildBatchConfig;
})(typeof self !== "undefined" ? self : globalThis);


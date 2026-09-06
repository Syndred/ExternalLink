// ExternalLink cloud data contract. The Worker owns the canonical copy; this
// module only defines which persistent extension values are mirrored and how.
(function () {
  "use strict";

  const CONFIG_KEY = "cloudSyncConfig";
  const DEFAULT_WORKSPACE_ID = "default";
  const STATE_DOCUMENT_KEYS = Object.freeze([
    "siteProfiles",
    "activeSiteId",
    "selectedSiteIds",
    "submissionRecords",
    "submissionTimeline",
    "timelineSchemaVersion",
    "submissionSchemaVersion",
    "siteAnnotations",
    "deletedSubmissionKeys",
    "urlList",
    "sheetTableData",
    "domainBlacklist",
    "targetFilters",
    "domainMetricsCache",
    "linkMonitorResults",
    "linkMonitorSchedule",
    "activeBatchRun",
    "autoSubmitStandardWpComments",
    "cfgEmail",
    "cfgName",
    "cfgCommentTemplate",
  ]);
  const STATE_DOCUMENT_KEY_SET = new Set(STATE_DOCUMENT_KEYS);

  function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
  }

  function normalizeEndpoint(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    let url;
    try {
      url = new URL(raw);
    } catch {
      return "";
    }
    if (url.protocol !== "https:" || url.username || url.password) return "";
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.endsWith(".local")
    ) {
      return "";
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/$/, "");
  }

  function normalizeWorkspaceId(value) {
    const normalized = String(value || DEFAULT_WORKSPACE_ID)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return normalized.slice(0, 80) || DEFAULT_WORKSPACE_ID;
  }

  function normalizeConfig(raw = {}) {
    const endpoint = normalizeEndpoint(raw.endpoint);
    const accessToken = String(raw.accessToken || "").trim();
    const workspaceId = normalizeWorkspaceId(raw.workspaceId);
    return {
      version: 1,
      endpoint,
      accessToken,
      workspaceId,
      connectedAt: raw.connectedAt || "",
      migratedAt: raw.migratedAt || "",
      lastPullAt: raw.lastPullAt || "",
      lastPushAt: raw.lastPushAt || "",
      lastError: raw.lastError || "",
      configured: Boolean(endpoint && accessToken),
    };
  }

  function stateToDocuments(state = {}) {
    const documents = {};
    for (const key of STATE_DOCUMENT_KEYS) {
      if (state[key] !== undefined) documents[key] = clone(state[key]);
    }
    return documents;
  }

  function documentsToState(documents = {}) {
    const result = {};
    for (const key of STATE_DOCUMENT_KEYS) {
      if (documents[key] !== undefined) result[key] = clone(documents[key]);
    }
    return result;
  }

  function stateKeysFromChanges(changes = {}) {
    return Object.keys(changes).filter((key) => STATE_DOCUMENT_KEY_SET.has(key));
  }

  function eventMap(timeline = {}) {
    const map = new Map();
    for (const events of Object.values(timeline || {})) {
      for (const event of Array.isArray(events) ? events : []) {
        if (event?.id) map.set(String(event.id), event);
      }
    }
    return map;
  }

  function serialise(value) {
    return JSON.stringify(value);
  }

  function diffTimelineEvents(previous = {}, next = {}) {
    const oldEvents = eventMap(previous);
    const newEvents = eventMap(next);
    const changes = [];
    for (const [eventId, event] of newEvents) {
      const before = oldEvents.get(eventId);
      if (!before) changes.push({ eventId, operation: "created" });
      else if (serialise(before) !== serialise(event)) changes.push({ eventId, operation: "updated" });
    }
    for (const eventId of oldEvents.keys()) {
      if (!newEvents.has(eventId)) changes.push({ eventId, operation: "deleted" });
    }
    return changes;
  }

  function isCloudMediaRef(value) {
    return /^cloud-media:\/\/[a-z0-9][a-z0-9._\/-]{0,255}$/i.test(String(value || "").trim());
  }

  function cloudMediaAssetId(value) {
    if (!isCloudMediaRef(value)) return "";
    return String(value).trim().slice("cloud-media://".length);
  }

  self.ExtLinkCloudSync = {
    CONFIG_KEY,
    DEFAULT_WORKSPACE_ID,
    STATE_DOCUMENT_KEYS,
    normalizeConfig,
    normalizeEndpoint,
    normalizeWorkspaceId,
    stateToDocuments,
    documentsToState,
    stateKeysFromChanges,
    diffTimelineEvents,
    isCloudMediaRef,
    cloudMediaAssetId,
  };
})();

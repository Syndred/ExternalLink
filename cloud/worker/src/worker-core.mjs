export const STATE_DOCUMENT_KEYS = Object.freeze([
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
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function jsonEquivalent(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => jsonEquivalent(value, right[index]));
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!jsonEquivalent(leftKeys, rightKeys)) return false;
    return leftKeys.every((key) => jsonEquivalent(left[key], right[key]));
  }
  return false;
}

export function migrationConflictKeys(existingRows, incomingDocuments) {
  const incoming = isPlainObject(incomingDocuments) ? incomingDocuments : {};
  return (Array.isArray(existingRows) ? existingRows : [])
    .filter((row) => !Object.hasOwn(incoming, row.document_key)
      || !jsonEquivalent(row.data, incoming[row.document_key]))
    .map((row) => row.document_key);
}

export function normalizeWorkspaceId(value) {
  const normalized = String(value || "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized.slice(0, 80) || "default";
}

export function normalizeDocuments(raw) {
  if (!isPlainObject(raw)) throw new Error("documents must be an object");
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!STATE_DOCUMENT_KEY_SET.has(key)) {
      throw new Error(`unsupported state document: ${key}`);
    }
    if (value === undefined) continue;
    const serialised = JSON.stringify(value);
    if (serialised === undefined) throw new Error(`state document ${key} is not serialisable`);
    if (new TextEncoder().encode(serialised).byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error(`state document ${key} is too large`);
    }
    result[key] = clone(value);
  }
  return result;
}

function eventMap(timeline) {
  const map = new Map();
  for (const events of Object.values(timeline || {})) {
    for (const event of Array.isArray(events) ? events : []) {
      if (event?.id) map.set(String(event.id), event);
    }
  }
  return map;
}

export function timelineAuditRows(previous, next) {
  const before = eventMap(previous);
  const after = eventMap(next);
  const rows = [];
  for (const [eventId, event] of after) {
    const oldEvent = before.get(eventId);
    if (!oldEvent) rows.push({ eventId, operation: "created", event: clone(event) });
    else if (JSON.stringify(oldEvent) !== JSON.stringify(event)) {
      rows.push({ eventId, operation: "updated", event: clone(event) });
    }
  }
  for (const [eventId, event] of before) {
    if (!after.has(eventId)) rows.push({ eventId, operation: "deleted", event: clone(event) });
  }
  return rows;
}

export function mediaObjectKey(workspaceId, assetId) {
  const workspace = normalizeWorkspaceId(workspaceId);
  const asset = String(assetId || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,180}$/i.test(asset)) {
    throw new Error("invalid media asset id");
  }
  return `workspaces/${workspace}/media/${asset}`;
}

export function parseBearerToken(header) {
  const match = String(header || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

// Do not use a normal string comparison for the Worker access token: a
// timing-safe comparison keeps the credential check independent of the first
// mismatching byte. Cloudflare Workers exposes timingSafeEqual in production;
// the small fallback keeps the module testable in Node versions that do not.
export async function secureEqual(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(String(left || ""));
  const b = encoder.encode(String(right || ""));
  if (!a.byteLength || a.byteLength !== b.byteLength) return false;
  if (typeof crypto?.subtle?.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(a, b);
  }
  let difference = 0;
  for (let index = 0; index < a.byteLength; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

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
  "autoSubmitDirectoryListings",
  "cfgEmail",
  "cfgName",
  "cfgCommentTemplate",
]);

export function classifyAiProviderFailure(message, status = 0) {
  const detail = String(message || "AI 服务商请求失败").trim().slice(0, 500);
  const insufficientBalance = Number(status) === 402 ||
    /insufficient balance|no balance|balance.{0,20}(low|empty|insufficient)|quota.{0,30}(exceeded|exhausted)|(?:exceeded|exhausted).{0,30}quota|billing.{0,30}(limit|exhausted)|credits?.{0,30}(insufficient|exhausted)/i.test(detail);
  return insufficientBalance
    ? {
      code: "AI_PROVIDER_BALANCE_EXHAUSTED",
      message: "AI 服务商账户余额或可用额度不足，云端表单规划暂不可用。",
      retryable: false,
    }
    : {
      code: "AI_PROVIDER_UNAVAILABLE",
      message: `AI 服务商暂不可用：${detail}`,
      retryable: true,
    };
}

const STATE_DOCUMENT_KEY_SET = new Set(STATE_DOCUMENT_KEYS);
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const MAX_PATCH_OPERATIONS = 5000;
const MAX_PATCH_PATH_DEPTH = 24;
const FORBIDDEN_PATCH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePatchPath(raw) {
  if (!Array.isArray(raw) || raw.length > MAX_PATCH_PATH_DEPTH) {
    throw new Error("invalid patch path");
  }
  return raw.map((segment) => {
    const value = String(segment || "");
    if (!value || value.length > 200 || FORBIDDEN_PATCH_SEGMENTS.has(value)) {
      throw new Error("invalid patch path segment");
    }
    return value;
  });
}

export function normalizePatchOperations(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_PATCH_OPERATIONS) {
    throw new Error("patch operations must be a non-empty bounded array");
  }
  return raw.map((entry) => {
    if (!isPlainObject(entry) || !["set", "delete"].includes(entry.op)) {
      throw new Error("unsupported patch operation");
    }
    const path = normalizePatchPath(entry.path);
    if (!path.length && entry.op === "delete") throw new Error("cannot delete the document root");
    if (entry.op === "delete") return { op: "delete", path };
    if (!Object.hasOwn(entry, "value") || entry.value === undefined) {
      throw new Error("set patch operation requires a value");
    }
    return { op: "set", path, value: clone(entry.value) };
  });
}

export function applyPatchOperations(document, rawOperations) {
  const operations = normalizePatchOperations(rawOperations);
  let result = document === undefined ? {} : clone(document);
  for (const operation of operations) {
    if (!operation.path.length) {
      result = clone(operation.value);
      continue;
    }
    if (!isPlainObject(result)) result = {};
    let target = result;
    for (const segment of operation.path.slice(0, -1)) {
      if (!isPlainObject(target[segment])) target[segment] = {};
      target = target[segment];
    }
    const leaf = operation.path.at(-1);
    if (operation.op === "delete") delete target[leaf];
    else target[leaf] = clone(operation.value);
  }
  return result;
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

export function artifactObjectKey(workspaceId, artifactId) {
  const workspace = normalizeWorkspaceId(workspaceId);
  const artifact = String(artifactId || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,180}$/i.test(artifact)) {
    throw new Error("invalid automation artifact id");
  }
  return `workspaces/${workspace}/automation-artifacts/${artifact}`;
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

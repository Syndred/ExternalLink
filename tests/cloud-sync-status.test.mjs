import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync("extension/background.js", "utf8");
const start = background.indexOf("async function getCloudSyncStatus()");
const end = background.indexOf("\nasync function connectCloudSync(", start);
assert.ok(start >= 0 && end > start);
const source = background.slice(start, end);

async function check({
  configured = true,
  remote = { siteProfiles: 4, submissionRecords: 2 },
  local = { siteProfiles: 4, submissionRecords: 2 },
  state = { siteProfiles: {}, submissionRecords: {} },
  pending = [],
  conflict = [],
  requestError = null,
} = {}) {
  const calls = [];
  const config = {
    configured,
    endpoint: "https://cloud.example",
    workspaceId: "default",
    accessToken: "test-token",
  };
  const context = {
    chrome: {
      storage: {
        local: {
          get: async () => ({
            ...state,
            cloudSyncMetadata: { configIdentity: "https://cloud.example\0default", revisions: local },
          }),
        },
      },
    },
    self: { ExtLinkCloudSync: { STATE_DOCUMENT_KEYS: ["siteProfiles", "submissionRecords"] } },
    cloudSyncPendingKeys: new Set(pending),
    cloudSyncConflictKeys: new Set(conflict),
    getCloudConfig: async () => config,
    cloudRequest: async (path) => {
      calls.push(path);
      if (requestError) throw requestError;
      return { revisions: remote };
    },
    normalizeCloudRevisions: (revisions) => revisions || {},
    cloudSyncConfigIdentity: ({ endpoint, workspaceId }) => `${endpoint}\0${workspaceId}`,
    updateCloudMetadata: async () => {},
    Date,
    Object,
    Number,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { result: await context.getCloudSyncStatus(), calls };
}

{
  const { result, calls } = await check();
  assert.equal(result.sync.status, "current");
  assert.equal(result.sync.pendingCount, 0);
  assert.deepEqual(calls, ["/v1/revisions"], "status checks must never download a cloud snapshot or document body");
}
assert.equal((await check({ remote: { siteProfiles: 5, submissionRecords: 2 } })).result.sync.outOfDateCount, 1);
assert.equal((await check({ state: { siteProfiles: {} } })).result.sync.status, "out_of_date", "missing local data is not current");
assert.equal((await check({ pending: ["siteProfiles"] })).result.sync.status, "pending");
assert.equal((await check({ pending: ["siteProfiles"], conflict: ["siteProfiles"] })).result.sync.status, "conflict");
assert.equal((await check({ remote: { siteProfiles: 4 } })).result.sync.localOnlyCount, 1);
assert.equal((await check({ remote: {}, local: {}, state: {} })).result.sync.status, "empty");
assert.deepEqual((await check({ configured: false })).calls, []);
assert.equal((await check({ requestError: new Error("quota exceeded") })).result.connected, false);
assert.equal((await check({ remote: null })).result.connected, false, "an incomplete response must not be labeled current");

console.log("cloud sync status tests passed");

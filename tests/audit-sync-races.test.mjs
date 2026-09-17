import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync("extension/background.js", "utf8");

function extractFunction(source, name) {
  const start = [`async function ${name}(`, `function ${name}(`]
    .map((marker) => source.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];
  assert.notEqual(start, undefined, `background.js must define ${name}()`);
  const open = source.indexOf("{", source.indexOf(")", start) + 1);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`could not extract ${name}()`);
}

const source = [
  "const CLOUD_SYNC_PENDING_STORAGE_KEY = 'cloudSyncPendingKeys';",
  "const CLOUD_SYNC_CONFLICT_STORAGE_KEY = 'cloudSyncConflictKeys';",
  "const CLOUD_SYNC_RETRY_DELAYS_MS = [1];",
  "const CLOUD_SYNC_DEBOUNCE_MS = 1;",
  extractFunction(background, "cloudSyncQueueSnapshot"),
  extractFunction(background, "persistCloudSyncQueue"),
  extractFunction(background, "restoreCloudSyncQueue"),
  extractFunction(background, "markCloudSyncConflict"),
  extractFunction(background, "clearCloudSyncConflict"),
  "function scheduleCloudSync() {}",
  "function scheduleCloudSyncRetry() {}",
  extractFunction(background, "cloudSyncConfigChangedError"),
  extractFunction(background, "submissionLedgerCloudConfigFingerprint"),
  extractFunction(background, "cloudSyncConfigIdentity"),
  extractFunction(background, "applyCloudSnapshot"),
  extractFunction(background, "pullCloudState"),
  extractFunction(background, "flushCloudState"),
  extractFunction(background, "pushCloudState"),
].join("\n\n");

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

async function waitForCall(calls) {
  for (let attempt = 0; attempt < 100 && !calls.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(calls.length, "cloud request did not start");
}

function createHarness({ initial = {}, cloudRequest, config } = {}) {
  const storageData = clone(initial) || {};
  const writes = [];
  const context = {
    chrome: {
      storage: {
        local: {
          async get(keys) {
            const names = typeof keys === "string" ? [keys] : keys || [];
            return Object.fromEntries(names.map((key) => [key, clone(storageData[key])]));
          },
          async set(values) {
            writes.push(clone(values));
            for (const [key, value] of Object.entries(values || {})) storageData[key] = clone(value);
          },
        },
      },
    },
    self: {
      ExtLinkCloudSync: {
        STATE_DOCUMENT_KEYS: ["submissionRecords", "submissionTimeline"],
        documentsToState: (documents) => clone(documents || {}),
      },
    },
    cloudSyncPendingKeys: new Set(initial.cloudSyncPendingKeys || []),
    cloudSyncConflictKeys: new Set(initial.cloudSyncConflictKeys || []),
    cloudSyncMutationVersions: new Map(),
    cloudSyncIgnoredValues: new Map(),
    cloudSyncFlushPromise: null,
    cloudSyncPendingPersistence: Promise.resolve(),
    cloudSyncRetryAttempt: 0,
    cloudSyncTimer: null,
    cloudPullPromise: null,
    getCloudConfig: async () => clone(config || {
      configured: true,
      endpoint: "https://cloud.example",
      workspaceId: "default",
      accessToken: "token",
    }),
    ensureCloudRevisions: async () => ({ submissionTimeline: 1 }),
    updateCloudMetadata: async () => {},
    log: () => {},
    scheduleCloudSync: () => {},
    cloudRequest,
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Number,
    String,
    Promise,
    console,
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { context, storageData, writes };
}

// A local edit during an in-flight PUT must leave a durable pending marker.
{
  const gate = deferred();
  const calls = [];
  const harness = createHarness({
    initial: {
      submissionTimeline: { local: "old" },
      cloudSyncPendingKeys: ["submissionTimeline"],
    },
    cloudRequest: async (path, options) => {
      calls.push({ path, options: clone(options) });
      await gate.promise;
      return { revision: 2 };
    },
  });
  const flush = harness.context.flushCloudState();
  await waitForCall(calls);
  harness.storageData.submissionTimeline = { local: "new" };
  harness.context.cloudSyncMutationVersions.set("submissionTimeline", 1);
  harness.context.cloudSyncPendingKeys.add("submissionTimeline");
  gate.resolve();
  await flush;
  assert.deepEqual(calls[0].options.body.data, { local: "old" });
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), true);
  assert.deepEqual(harness.storageData.cloudSyncPendingKeys, ["submissionTimeline"]);
}

// Switching workspaces during a PUT must stop the run before another key is
// uploaded and must leave the queue durable for the newly selected workspace.
{
  const config = {
    configured: true,
    endpoint: "https://cloud.example",
    workspaceId: "old-workspace",
    accessToken: "token",
  };
  const calls = [];
  const harness = createHarness({
    config,
    initial: {
      submissionRecords: { local: "record" },
      submissionTimeline: { local: "value" },
      cloudSyncPendingKeys: ["submissionRecords", "submissionTimeline"],
    },
    cloudRequest: async (path, options, boundConfig) => {
      calls.push({ path, options: clone(options), config: clone(boundConfig) });
      config.workspaceId = "new-workspace";
      return { revision: 2 };
    },
  });
  await assert.rejects(
    harness.context.flushCloudState(),
    (error) => error?.code === "CLOUD_CONFIG_CHANGED",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/state/submissionRecords");
  assert.equal(calls[0].config.workspaceId, "old-workspace");
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), true);
  assert.deepEqual(harness.storageData.cloudSyncPendingKeys, ["submissionRecords", "submissionTimeline"]);
  assert.equal(harness.storageData.cloudSyncMetadata, undefined);
}

// A full pull must keep a local edit made while the network request was open.
{
  const gate = deferred();
  const calls = [];
  const harness = createHarness({
    initial: { submissionTimeline: { local: "before" } },
    cloudRequest: async (path) => {
      calls.push(path);
      await gate.promise;
      return {
        documents: { submissionTimeline: { remote: "value" } },
        revisions: { submissionTimeline: 3 },
      };
    },
  });
  const pull = harness.context.pullCloudState();
  await waitForCall(calls);
  harness.storageData.submissionTimeline = { local: "edited-during-pull" };
  harness.context.cloudSyncMutationVersions.set("submissionTimeline", 1);
  gate.resolve();
  const result = await pull;
  assert.equal(result.status, "changed");
  assert.equal(result.applied, false);
  assert.deepEqual(harness.storageData.submissionTimeline, { local: "edited-during-pull" });
}

// A later 409 must not discard the revision confirmed for an earlier key.
{
  const calls = [];
  const harness = createHarness({
    initial: {
      submissionRecords: { local: "record" },
      submissionTimeline: { local: "timeline" },
      cloudSyncPendingKeys: ["submissionRecords", "submissionTimeline"],
    },
    cloudRequest: async (path, options) => {
      calls.push({ path, options: clone(options) });
      if (path.endsWith("submissionRecords")) return { revision: 7 };
      throw Object.assign(new Error("revision conflict"), { status: 409 });
    },
  });
  await assert.rejects(harness.context.flushCloudState(), (error) => error?.status === 409);
  assert.deepEqual(calls.map(({ path }) => path), [
    "/v1/state/submissionRecords",
    "/v1/state/submissionTimeline",
  ]);
  assert.equal(harness.storageData.cloudSyncMetadata.revisions.submissionRecords, 7);
  assert.equal(harness.storageData.cloudSyncMetadata.configIdentity, "https://cloud.example\u0000default");
  assert.doesNotMatch(JSON.stringify(harness.storageData.cloudSyncMetadata), /token/);
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionRecords"), false);
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), true);
  assert.equal(harness.context.cloudSyncConflictKeys.has("submissionTimeline"), true);
  assert.deepEqual(harness.storageData.cloudSyncPendingKeys, ["submissionTimeline"]);
  assert.deepEqual(harness.storageData.cloudSyncConflictKeys, ["submissionTimeline"]);
}

// A 409 remains a durable conflict marker and keeps its status for callers.
{
  const conflict = Object.assign(new Error("revision conflict"), { status: 409 });
  const harness = createHarness({
    initial: {
      submissionTimeline: { local: "value" },
      cloudSyncPendingKeys: ["submissionTimeline"],
    },
    cloudRequest: async () => { throw conflict; },
  });
  await assert.rejects(
    harness.context.flushCloudState(),
    (error) => error?.status === 409 && /submissionTimeline/.test(error.message),
  );
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), true);
  assert.equal(harness.context.cloudSyncConflictKeys.has("submissionTimeline"), true);
  assert.deepEqual(harness.storageData.cloudSyncPendingKeys, ["submissionTimeline"]);
  assert.deepEqual(harness.storageData.cloudSyncConflictKeys, ["submissionTimeline"]);
  const pull = await harness.context.pullCloudState();
  assert.equal(pull.status, "conflict");
  assert.equal(pull.applied, false);
  assert.deepEqual(harness.storageData.submissionTimeline, { local: "value" });
}

// Manual save uploads only locally pending, non-conflicted documents. A copied
// browser profile must not replay every stale document merely because the user
// clicked "save now".
{
  const calls = [];
  const harness = createHarness({
    initial: {
      submissionRecords: { local: "pending" },
      submissionTimeline: { local: "conflicted" },
      cloudSyncPendingKeys: ["submissionRecords", "submissionTimeline"],
      cloudSyncConflictKeys: ["submissionTimeline"],
    },
    cloudRequest: async (path) => {
      calls.push(path);
      return { revision: 2 };
    },
  });
  await harness.context.pushCloudState();
  assert.deepEqual(calls, ["/v1/state/submissionRecords"]);
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionRecords"), false);
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), true);
  assert.equal(harness.context.cloudSyncConflictKeys.has("submissionTimeline"), true);
}

// An explicit resolution may apply the remote snapshot and clear only the
// resolved conflict markers; the persisted metadata contains no access token.
{
  const harness = createHarness({
    initial: {
      submissionTimeline: { local: "value" },
      cloudSyncPendingKeys: ["submissionTimeline"],
      cloudSyncConflictKeys: ["submissionTimeline"],
    },
    cloudRequest: async () => ({
      documents: { submissionTimeline: { remote: "value" } },
      revisions: { submissionTimeline: 3 },
    }),
  });
  const result = await harness.context.pullCloudState({ resolveConflicts: true });
  assert.equal(result.status, "applied");
  assert.deepEqual(result.resolvedConflicts, ["submissionTimeline"]);
  assert.deepEqual(harness.storageData.submissionTimeline, { remote: "value" });
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), false);
  assert.equal(harness.context.cloudSyncConflictKeys.has("submissionTimeline"), false);
  assert.deepEqual(harness.storageData.cloudSyncPendingKeys, []);
  assert.deepEqual(harness.storageData.cloudSyncConflictKeys, []);
  assert.doesNotMatch(JSON.stringify(harness.storageData.cloudSyncMetadata), /token/);
}

// Explicit resolution applies only the conflicted remote document while
// preserving unrelated pending writes and their older revisions.
{
  const harness = createHarness({
    initial: {
      submissionRecords: { local: "pending" },
      submissionTimeline: { local: "conflicted" },
      cloudSyncPendingKeys: ["submissionRecords", "submissionTimeline"],
      cloudSyncConflictKeys: ["submissionTimeline"],
      cloudSyncMetadata: {
        revisions: { submissionRecords: 4, submissionTimeline: 2 },
      },
    },
    cloudRequest: async () => ({
      documents: {
        submissionRecords: { remote: "must-not-overwrite-pending" },
        submissionTimeline: { remote: "value" },
      },
      revisions: { submissionRecords: 9, submissionTimeline: 3 },
    }),
  });
  const resolved = await harness.context.pullCloudState({ resolveConflicts: true });
  assert.equal(resolved.status, "applied");
  assert.deepEqual(resolved.resolvedConflicts, ["submissionTimeline"]);
  assert.deepEqual(harness.storageData.submissionRecords, { local: "pending" });
  assert.deepEqual(harness.storageData.submissionTimeline, { remote: "value" });
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionRecords"), true);
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), false);
  assert.equal(harness.context.cloudSyncConflictKeys.has("submissionTimeline"), false);
  assert.deepEqual(harness.storageData.cloudSyncPendingKeys, ["submissionRecords"]);
  assert.deepEqual(harness.storageData.cloudSyncConflictKeys, []);
  assert.deepEqual(harness.storageData.cloudSyncMetadata.revisions, {
    submissionRecords: 4,
    submissionTimeline: 3,
  });
}

{
  const gate = deferred();
  const calls = [];
  const harness = createHarness({
    initial: {
      submissionTimeline: { local: "before" },
      cloudSyncPendingKeys: ["submissionTimeline"],
      cloudSyncConflictKeys: ["submissionTimeline"],
    },
    cloudRequest: async () => {
      calls.push(true);
      await gate.promise;
      return { documents: { submissionTimeline: { remote: "value" } }, revisions: {} };
    },
  });
  const pull = harness.context.pullCloudState({ resolveConflicts: true });
  await waitForCall(calls);
  harness.storageData.submissionTimeline = { local: "edited-during-resolve" };
  harness.context.cloudSyncMutationVersions.set("submissionTimeline", 1);
  gate.resolve();
  const result = await pull;
  assert.equal(result.status, "changed");
  assert.equal(result.applied, false);
  assert.deepEqual(harness.storageData.submissionTimeline, { local: "edited-during-resolve" });
  assert.equal(harness.context.cloudSyncConflictKeys.has("submissionTimeline"), true);
}

// A service-worker restart restores both the pending write and its conflict
// marker before any automatic pull can run.
{
  const harness = createHarness({
    initial: {
      cloudSyncPendingKeys: ["submissionTimeline"],
      cloudSyncConflictKeys: ["submissionTimeline"],
    },
  });
  harness.context.cloudSyncPendingKeys.clear();
  harness.context.cloudSyncConflictKeys.clear();
  await harness.context.restoreCloudSyncQueue();
  assert.equal(harness.context.cloudSyncPendingKeys.has("submissionTimeline"), true);
  assert.equal(harness.context.cloudSyncConflictKeys.has("submissionTimeline"), true);
}

assert.doesNotMatch(background, /cloudSyncMute/, "pulls must not suppress other storage writers globally");
console.log("cloud sync race audit tests passed");

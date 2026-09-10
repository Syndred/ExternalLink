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

const functionNames = [
  "submissionLedgerValuesEqual",
  "submissionLedgerHasPendingWrites",
  "submissionLedgerSyncResult",
  "submissionLedgerPullMetadata",
  "submissionLedgerCloudConfigFingerprint",
  "prepareSubmissionLedgerCloudPull",
  "applySubmissionLedgerCloudPull",
  "refreshSubmissionLedgerFromCloud",
];
const functionSource = functionNames.map((name) => extractFunction(background, name)).join("\n\n");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function createHarness({ initial = {}, cloudSnapshot, cloudConfig, cloudRequest } = {}) {
  const storageData = clone(initial) || {};
  const calls = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: clone(storageData[keys]) };
          return Object.fromEntries((keys || []).map((key) => [key, clone(storageData[key])]));
        },
        async set(values) {
          for (const [key, value] of Object.entries(values || {})) storageData[key] = clone(value);
        },
      },
    },
  };
  const context = {
    chrome,
    cloudSyncPendingKeys: new Set(),
    cloudSyncIgnoredValues: new Map(),
    getCloudConfig: async () => clone(cloudConfig || {
      configured: true,
      endpoint: "https://cloud.example",
      workspaceId: "default",
      accessToken: "token",
    }),
    cloudRequest: async (path) => {
      calls.push(path);
      if (cloudRequest) return cloudRequest(path);
      return clone(cloudSnapshot || { documents: {}, revisions: {} });
    },
    setTimeout,
    clearTimeout,
    Date,
    JSON,
    Object,
    Number,
    String,
    Promise,
  };
  context.self = context;
  vm.createContext(context);
  vm.runInContext(readFileSync("extension/lib/batch-controls.js", "utf8"), context);
  vm.runInContext(
    `const SUBMISSION_LEDGER_CLOUD_KEYS = Object.freeze(["submissionRecords", "submissionTimeline"]);
     const SUBMISSION_LEDGER_PULL_COOLDOWN_MS = 5000;
     let submissionLedgerPullPromise = null;
     let submissionLedgerPullStartedAt = 0;
     const submissionLedgerWrite = self.ExtLinkBatchControls.createSerialExecutor();
     ${functionSource}`,
    context,
  );
  return { context, storageData, calls };
}

// A sidebar refresh may read the whole Worker snapshot, but only the two
// ledger documents are allowed to reach local storage.
{
  const remoteRecords = { "devpages.io/submit-a-tool::RspAi": { status: "success" } };
  const remoteTimeline = {
    "devpages.io/submit-a-tool::RspAi": [{ id: "rspai-event", type: "submitted" }],
  };
  const harness = createHarness({
    initial: {
      activeSiteId: "LocalProfile",
      submissionRecords: {},
      submissionTimeline: {},
      cloudSyncMetadata: { revisions: { submissionRecords: 1, submissionTimeline: 1 } },
    },
    cloudSnapshot: {
      documents: {
        activeSiteId: "RemoteProfile",
        siteProfiles: { RemoteProfile: { id: "RemoteProfile" } },
        submissionRecords: remoteRecords,
        submissionTimeline: remoteTimeline,
      },
      revisions: { activeSiteId: 8, submissionRecords: 2, submissionTimeline: 2 },
    },
  });
  const result = await harness.context.refreshSubmissionLedgerFromCloud({ force: true });
  assert.equal(result.ok, true);
  assert.equal(result.sync.status, "applied");
  assert.deepEqual(harness.storageData.submissionRecords, remoteRecords);
  assert.deepEqual(harness.storageData.submissionTimeline, remoteTimeline);
  assert.equal(harness.storageData.activeSiteId, "LocalProfile");
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0], "/v1/snapshot");
}

// A local write during the network read must remain visible and must block the
// remote snapshot from replacing either ledger document.
{
  const gate = deferred();
  const harness = createHarness({
    initial: {
      submissionRecords: {},
      submissionTimeline: {},
      cloudSyncMetadata: { revisions: {} },
    },
    cloudRequest: async () => gate.promise,
  });
  const refresh = harness.context.refreshSubmissionLedgerFromCloud({ force: true });
  while (harness.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  harness.storageData.submissionTimeline = { "local.example::RspAi": [{ id: "local-event" }] };
  gate.resolve({
    documents: {
      submissionRecords: { "remote.example::RspAi": { status: "success" } },
      submissionTimeline: { "remote.example::RspAi": [{ id: "remote-event" }] },
    },
    revisions: { submissionRecords: 1, submissionTimeline: 1 },
  });
  const result = await refresh;
  assert.equal(result.sync.status, "changed");
  assert.deepEqual(harness.storageData.submissionTimeline, {
    "local.example::RspAi": [{ id: "local-event" }],
  });
  assert.deepEqual(harness.storageData.submissionRecords, {});
}

// Pending local writes short-circuit before any cloud request.
{
  const harness = createHarness({ initial: { submissionRecords: {}, submissionTimeline: {} } });
  harness.context.cloudSyncPendingKeys.add("submissionTimeline");
  const result = await harness.context.refreshSubmissionLedgerFromCloud({ force: true });
  assert.equal(result.sync.status, "pending");
  assert.equal(harness.calls.length, 0);
}

// Two sidebar refreshes share one in-flight request; a storage change cannot
// create a request storm while the first snapshot is still pending.
{
  const gate = deferred();
  const harness = createHarness({
    initial: { submissionRecords: {}, submissionTimeline: {} },
    cloudRequest: async () => gate.promise,
  });
  const first = harness.context.prepareSubmissionLedgerCloudPull({ force: true });
  const second = harness.context.prepareSubmissionLedgerCloudPull();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.calls.length, 1);
  gate.resolve({ documents: {}, revisions: {} });
  await Promise.all([first, second]);
}

// A newer local revision must not be moved backwards by an older snapshot,
// even when the local JSON value happens to equal the initial baseline.
{
  const harness = createHarness({
    initial: {
      submissionRecords: { local: true },
      submissionTimeline: { local: true },
      cloudSyncMetadata: { revisions: { submissionRecords: 4, submissionTimeline: 5 } },
    },
    cloudSnapshot: {
      documents: {
        submissionRecords: { remote: true },
        submissionTimeline: { remote: true },
      },
      revisions: { submissionRecords: 4, submissionTimeline: 4 },
    },
  });
  const result = await harness.context.refreshSubmissionLedgerFromCloud({ force: true });
  assert.equal(result.sync.status, "stale");
  assert.deepEqual(harness.storageData.submissionRecords, { remote: true });
  assert.deepEqual(harness.storageData.submissionTimeline, { local: true });
  assert.deepEqual(harness.storageData.cloudSyncMetadata.revisions, {
    submissionRecords: 4,
    submissionTimeline: 5,
  });
}

console.log("submission ledger cloud refresh tests passed");

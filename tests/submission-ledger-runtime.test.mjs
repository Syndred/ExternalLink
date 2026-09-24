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
  "siteKeyForUrl",
  "buildSubmissionTimelineEventForRecord",
  "submissionTimelineContainsRecord",
  "isPersistedSuccessRecord",
  "recordSubmittedProject",
  "recordSubmittedProjectUnlocked",
  "applyTimelinePublicationUpgrade",
  "normalizeSubmissionTimelineEventMessage",
  "writeSubmissionTimelineEventUnlocked",
  "addSubmissionTimelineEvent",
  "updateSubmissionTimelineEvent",
  "removeSubmissionTimelineEvent",
  "confirmSubmissionSuccess",
];
const functionSource = functionNames.map((name) => extractFunction(background, name)).join("\n\n");
const destinationHelperSource = `${background.slice(
  background.indexOf("const DISPLAY_HOST_DESTINATIONS"),
  background.indexOf("function siteKeyForUrl"),
)}\n`;
const libraryStateWrapperSource = extractFunction(background, "getLibraryManagerState");
const completionSource = extractFunction(background, "completeTaskFromJudge");
const manualConfirmationSource = extractFunction(background, "confirmSubmissionSuccess");

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createHarness(initial = {}) {
  const storageData = clone(initial) || {};
  const setCalls = [];
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          if (typeof keys === "string") return { [keys]: clone(storageData[keys]) };
          return Object.fromEntries((keys || []).map((key) => [key, clone(storageData[key])]));
        },
        async set(values) {
          setCalls.push(clone(values));
          await new Promise((resolve) => setTimeout(resolve, 1));
          for (const [key, value] of Object.entries(values || {})) storageData[key] = clone(value);
        },
      },
    },
  };
  const context = {
    chrome,
    console: { log() {}, warn() {}, error() {} },
    URL,
    crypto: { randomUUID: () => `timeline-${setCalls.length}-${Math.random()}` },
    state: { runId: "ledger-test-run" },
    setTimeout,
    clearTimeout,
  };
  context.self = context;
  vm.createContext(context);
  for (const file of ["extension/lib/batch-controls.js", "extension/lib/queue.js", "extension/lib/submission-timeline.js", "extension/lib/automation-ledger.js"]) {
    vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
  }
  vm.runInContext(
    `const SUBMISSION_SCHEMA_VERSION = 2;
     const submissionLedgerWrite = self.ExtLinkBatchControls.createSerialExecutor();
     ${destinationHelperSource}
     ${functionSource}
     ${libraryStateWrapperSource}`,
    context,
    { filename: "extension/background-ledger-runtime.js" },
  );
  return { context, storageData, setCalls };
}

// A success record without a target URL or project identity must fail closed;
// silently resolving here lets callers advance a task without an exact ledger
// pair to prove what was submitted.
{
  const harness = createHarness();
  await assert.rejects(
    harness.context.recordSubmittedProject({
      profileId: "JevPlay",
      confirmedBy: "manual",
      successEvidence: "Submission received",
    }),
    /缺少目标 URL/,
  );
  await assert.rejects(
    harness.context.recordSubmittedProject({
      url: "https://example.test/submit",
      confirmedBy: "manual",
      successEvidence: "Submission received",
    }),
    /缺少项目 profileId/,
  );
  assert.equal(harness.storageData.submissionRecords, undefined);
}

// The recorder must verify the exact destinationKey::profileId record after
// storage.set resolves, otherwise a dropped or stale write can be reported as
// a successful submission.
{
  const harness = createHarness();
  harness.context.chrome.storage.local.set = async () => {};
  await assert.rejects(
    harness.context.recordSubmittedProject({
      url: "https://example.test/submit",
      profileId: "JevPlay",
      confirmedBy: "manual",
      successEvidence: "Submission received",
    }),
    /账本未持久化精确记录/,
  );
  assert.equal(harness.storageData.submissionRecords, undefined);
}

// A pre-existing success row is only reusable when the row itself carries the
// same destination and profile as the derived key.
{
  const key = "example.test/submit::JevPlay";
  const harness = createHarness({
    submissionRecords: {
      [key]: {
        status: "success",
        destinationKey: "other.example/submit",
        profileId: "OtherProject",
        evidence: "Submission received",
        publicationStatus: "submitted",
      },
    },
  });
  await assert.rejects(
    harness.context.recordSubmittedProject({
      url: "https://example.test/submit",
      profileId: "JevPlay",
      confirmedBy: "manual",
      successEvidence: "Submission received",
      publicationStatus: "submitted",
    }),
    /已有账本记录身份不匹配/,
  );
}

assert.ok(
  completionSource.indexOf("recordSubmittedProject(task)") < completionSource.indexOf('task.status = "ok"'),
  "judge success must persist the ledger record before marking the task ok",
);
assert.ok(
  manualConfirmationSource.indexOf("recordSubmittedProject(task)") < manualConfirmationSource.indexOf('task.status = "ok"'),
  "manual confirmation must persist the ledger record before marking the task ok",
);

// A manual timeline status without a receipt/evidence link is only a note;
// it must not fabricate a trusted success row. Supplying the original receipt
// promotes the exact destination/profile pair into the submission ledger.
{
  const harness = createHarness();
  const emptyEvidence = await harness.context.writeSubmissionTimelineEventUnlocked({
    destinationKey: "phygital.example/submit",
    destinationUrl: "https://phygital.example/submit",
    profileId: "GraffitiName",
    type: "submitted",
    note: "",
    occurredAt: "2026-09-24T11:00:00.000Z",
    source: "manual",
  });
  assert.equal(emptyEvidence.record, null);
  assert.equal(harness.storageData.submissionRecords, undefined);
  const withReceipt = await harness.context.writeSubmissionTimelineEventUnlocked({
    destinationKey: "phygital.example/submit",
    destinationUrl: "https://phygital.example/submit",
    profileId: "GraffitiName",
    type: "submitted",
    note: "Thank you for your submission!",
    occurredAt: "2026-09-24T11:01:00.000Z",
    source: "manual",
  });
  assert.equal(withReceipt.record.status, "success");
  assert.equal(withReceipt.record.destinationKey, "phygital.example/submit");
  assert.equal(withReceipt.record.profileId, "GraffitiName");
}

// A failed manual confirmation write must leave the task retryable. In
// particular, the confirmation nonce and page identity are the recovery
// handle and must not be cleared until the exact ledger row is persisted.
{
  const harness = createHarness();
  const task = {
    id: "manual-failure-task",
    index: 7,
    url: "https://example.test/submit",
    profileId: "JevPlay",
    status: "submitted_unconfirmed",
    skipReason: "等待人工确认",
    confirmedBy: "agent",
    successEvidence: "旧回执",
    confirmationNonce: "retry-nonce",
    manualTabId: 42,
    manualTabUrl: "https://example.test/submit",
  };
  harness.context.state.tasks = [task];
  harness.context.state.parkedTaskIds = new Set([task.id]);
  harness.context.state.activeTabs = new Map();
  harness.context.recordSubmittedProject = async () => {
    throw new Error("storage unavailable");
  };
  harness.context.recordUnattendedSuccess = async () => {};
  harness.context.broadcastTaskUpdate = () => {};
  harness.context.unattendedEnabled = () => false;
  harness.context.persistParkedTaskIds = async () => {};
  harness.context.syncUnattendedManualCapacity = async () => {};
  await assert.rejects(
    harness.context.confirmSubmissionSuccess({
      taskId: task.id,
      runId: harness.context.state.runId,
      confirmationNonce: task.confirmationNonce,
      evidence: "新的回执",
    }),
    /storage unavailable/,
  );
  assert.equal(task.status, "submitted_unconfirmed");
  assert.equal(task.skipReason, "等待人工确认");
  assert.equal(task.confirmedBy, "agent");
  assert.equal(task.successEvidence, "旧回执");
  assert.equal(task.confirmationNonce, "retry-nonce");
  assert.equal(task.manualTabId, 42);
  assert.equal(task.manualTabUrl, "https://example.test/submit");
}

// Two simultaneous ledger writes must serialize their reads as well as their
// final sets. Without the shared executor, the second stale whole-value write
// drops the first event.
{
  const harness = createHarness();
  await Promise.all([
    harness.context.recordSubmittedProject({
      url: "https://one.example/submit",
      profileId: "RspAi",
      profileName: "RspAi",
      confirmedBy: "manual",
      successEvidence: "Submission received for One",
      publicationStatus: "submitted",
    }),
    harness.context.recordSubmittedProject({
      url: "https://two.example/submit",
      profileId: "ComparisonText",
      profileName: "Comparison Text",
      confirmedBy: "manual",
      successEvidence: "Submission received for Two",
      publicationStatus: "submitted",
    }),
  ]);
  assert.equal(Object.keys(harness.storageData.submissionRecords).length, 2);
  assert.equal(Object.keys(harness.storageData.submissionTimeline).length, 2);
}

// The sidebar refresh path migrates the timeline after an awaited table read.
// It must wait behind a concurrent add so its stale snapshot cannot overwrite
// the newly registered dynamic.
{
  const harness = createHarness({ submissionTimeline: {} });
  harness.context.getLibraryManagerStateUnlocked = async function () {
    const storage = await harness.context.chrome.storage.local.get(["submissionTimeline"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const migrated = { ...(storage.submissionTimeline || {}) };
    migrated["migration.example::RspAi"] = [{
      id: "migration-event",
      destinationKey: "migration.example",
      profileId: "RspAi",
      occurredAt: "2026-09-10T06:00:00.000Z",
      type: "note",
      note: "历史迁移",
    }];
    await harness.context.chrome.storage.local.set({ submissionTimeline: migrated });
    return { ok: true };
  };
  await Promise.all([
    harness.context.getLibraryManagerState(),
    harness.context.addSubmissionTimelineEvent({
      destinationKey: "new.example/submit",
      destinationUrl: "https://new.example/submit",
      profileId: "RspAi",
      type: "submitted",
      note: "刚登记",
    }),
  ]);
  const events = Object.values(harness.storageData.submissionTimeline).flat();
  assert.ok(events.some((event) => event.id === "migration-event"));
  assert.ok(events.some((event) => event.note === "刚登记"), "刷新迁移不得覆盖刚登记的动态");
}

// A success record can survive a worker suspension before its timeline write.
// Replaying the same success repairs exactly the missing event and remains
// idempotent on later retries.
{
  const key = "devpages.io/submit-a-tool::RspAi";
  const harness = createHarness({
    submissionRecords: {
      [key]: {
        status: "success",
        destinationKey: "devpages.io/submit-a-tool",
        destinationUrl: "https://devpages.io/submit-a-tool",
        profileId: "RspAi",
        profileName: "RspAi",
        submittedAt: "2026-09-10T06:00:00.000Z",
        confirmedBy: "manual",
        evidence: "Submission received",
        publicUrl: "",
        evidenceUrl: "https://devpages.io/submit-a-tool",
        publicationStatus: "submitted",
      },
    },
    submissionTimeline: {},
  });
  const task = {
    url: "https://devpages.io/submit-a-tool",
    profileId: "RspAi",
    confirmedBy: "manual",
    successEvidence: "Submission received",
    publicationStatus: "submitted",
  };
  await harness.context.recordSubmittedProject(task);
  await harness.context.recordSubmittedProject(task);
  const events = Object.values(harness.storageData.submissionTimeline).flat();
  assert.equal(events.length, 1);
  assert.equal(events[0].recordKey, key);
}

// The same record pair may have an older submitted event and a newer published
// state. A keyed old event must not suppress repair of the current stage.
{
  const key = "devpages.io/submit-a-tool::RspAi";
  const harness = createHarness({
    submissionRecords: {
      [key]: {
        status: "success",
        destinationKey: "devpages.io/submit-a-tool",
        destinationUrl: "https://devpages.io/submit-a-tool",
        profileId: "RspAi",
        profileName: "RspAi",
        submittedAt: "2026-09-10T06:00:00.000Z",
        confirmedBy: "manual",
        evidence: "Published listing",
        publicUrl: "https://devpages.io/tools/rspai",
        evidenceUrl: "https://devpages.io/tools/rspai",
        publicationStatus: "published",
      },
    },
    submissionTimeline: {
      [key]: [{
        id: "old-submitted",
        destinationKey: "devpages.io/submit-a-tool",
        profileId: "RspAi",
        occurredAt: "2026-09-10T05:00:00.000Z",
        type: "submitted",
        status: "submitted",
        note: "Submission received",
        recordKey: key,
      }],
    },
  });
  await harness.context.recordSubmittedProject({
    url: "https://devpages.io/submit-a-tool",
    profileId: "RspAi",
    confirmedBy: "manual",
    successEvidence: "Published listing",
    publicUrl: "https://devpages.io/tools/rspai",
    evidenceUrl: "https://devpages.io/tools/rspai",
    publicationStatus: "published",
  });
  const events = Object.values(harness.storageData.submissionTimeline).flat();
  assert.equal(events.length, 2);
  assert.ok(events.some((event) => event.type === "published"));
}

// Add, update, and remove are all serialized against one another, so a
// concurrent edit cannot restore a stale timeline snapshot.
{
  const harness = createHarness();
  const [createdA, createdB] = await Promise.all([
    harness.context.addSubmissionTimelineEvent({
      destinationKey: "same.example/submit",
      destinationUrl: "https://same.example/submit",
      profileId: "RspAi",
      type: "submitted",
      note: "A",
    }),
    harness.context.addSubmissionTimelineEvent({
      destinationKey: "same.example/submit",
      destinationUrl: "https://same.example/submit",
      profileId: "ComparisonText",
      type: "submitted",
      note: "B",
    }),
  ]);
  await Promise.all([
    harness.context.updateSubmissionTimelineEvent({
      eventId: createdA.event.id,
      destinationKey: "same.example/submit",
      destinationUrl: "https://same.example/submit",
      profileId: "RspAi",
      type: "published",
      note: "A published",
      publicUrl: "https://same.example/tools/a",
    }),
    harness.context.removeSubmissionTimelineEvent({ eventId: createdB.event.id }),
  ]);
  const events = Object.values(harness.storageData.submissionTimeline).flat();
  assert.equal(events.length, 1);
  assert.equal(events[0].id, createdA.event.id);
  assert.equal(events[0].type, "published");
  assert.equal(events[0].note, "A published");
}

console.log("submission ledger runtime tests passed");

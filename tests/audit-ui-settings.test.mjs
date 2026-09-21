import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const sidepanelSource = readFileSync("extension/sidepanel.js", "utf8");
const settingsSource = readFileSync("extension/settings.js", "utf8");

// Exercise the UI-facing contracts without opening Chrome. These helpers are
// the same functions used by the live side panel.
{
  const helperEnd = sidepanelSource.indexOf("// ExternalLink Side Panel");
  const context = { self: {} };
  vm.runInNewContext(sidepanelSource.slice(0, helperEnd), context);
  const api = context.self.ExtLinkSidepanel;
  assert.equal(api.canEditTimeline(null, "https://directory.example/submit"), true);
  assert.equal(api.canEditTimeline(null, "chrome://settings"), false);
  assert.deepEqual(
    JSON.parse(JSON.stringify(api.buildBatchConfig({
      concurrency: "4",
      pingIndex: false,
      unattended: true,
      unattendedMaxHours: "99",
      unattendedMaxTasks: "0",
      unattendedMaxManualTabs: "7",
    }))),
    {
      autoSkipCaptcha: false,
      concurrency: 4,
      pingIndex: false,
      fillOnly: false,
      unattended: true,
      unattendedMaxHours: 12,
      unattendedMaxTasks: 1,
      unattendedMaxManualTabs: 7,
    },
    "side panel batch config should carry saved concurrency/IndexNow values and clamp unattended limits",
  );
}

// Changing the batch Profile selection must query the queue for that exact
// selection, rather than relying on a storage write racing the background.
{
  const start = sidepanelSource.indexOf("  async function loadSubmissionQueue");
  const end = sidepanelSource.indexOf("  function renderQueueQuality", start);
  assert.ok(start >= 0 && end > start, "loadSubmissionQueue should remain extractable for its UI contract");
  const messages = [];
  const context = {
    Promise,
    String,
    Number,
    Array,
    Object,
    submissionQueueLoadToken: 0,
    selectedSiteIds: ["ProfileA"],
    submissionTasks: [],
    submissionIndex: 0,
    submissionMeta: { fromTable: 0, fromPlugin: 0, excluded: 0, total: 0 },
    chrome: {
      tabs: { query: async () => [{ url: "https://directory.example/submit" }] },
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          return {
            ok: true,
            tasks: [{ key: "directory.example", url: "https://directory.example/submit" }],
            index: 0,
            meta: { fromTable: 1, fromPlugin: 0, excluded: 0, total: 1 },
          };
        },
      },
    },
    renderSubmissionNav() {},
  };
  vm.createContext(context);
  vm.runInContext(sidepanelSource.slice(start, end), context);
  await vm.runInContext(
    'loadSubmissionQueue("https://directory.example/submit", ["ProfileB"])',
    context,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(messages[0].selectedSiteIds)),
    ["ProfileB"],
    "queue refresh should be bound to the Profile list that triggered it",
  );
  await vm.runInContext(
    'loadSubmissionQueue("https://directory.example/submit", [])',
    context,
  );
  assert.equal(context.submissionTasks.length, 0, "an empty Profile selection must not fall back to the active Profile queue");
}

// A timeline can be started on a current HTTP page before it is already in
// the saved library. Saving first materializes the destination, then writes
// the event under the same normalized key so it remains discoverable.
{
  const start = sidepanelSource.indexOf("  function toDateTimeLocal");
  const end = sidepanelSource.indexOf("  function renderSubmissionNav", start);
  const fields = {
    timelineProfileSelect: { value: "ProfileA" },
    timelineEventType: { value: "submitted" },
    timelineOccurredAt: { value: "2026-09-10T10:00" },
    timelineNote: { value: "已提交，等待审核" },
    timelinePublicUrl: { value: "" },
    timelineEvidenceUrl: { value: "https://directory.example/evidence" },
    btnSaveTimelineEvent: { disabled: false, textContent: "保存人工动态" },
    btnCancelTimelineEvent: { disabled: false },
  };
  const messages = [];
  const context = {
    console,
    Promise,
    URL,
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Array,
    Object,
    Error,
    detection: { platform: "directory" },
    siteProfiles: { ProfileA: { name: "Profile A" } },
    activeSiteId: "ProfileA",
    currentPageUrl: "https://directory.example/submit",
    currentTimelineItem: null,
    timelineSaveInProgress: false,
    timelineEditorUrl: "",
    Q: {
      normalizeDestinationKey: (url) => new URL(url).host + new URL(url).pathname,
      normalizeUrlKey: (url) => new URL(url).host + new URL(url).pathname,
      extractDomain: (url) => new URL(url).host,
    },
    $: (id) => fields[id] || null,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          if (message.action === "addToUrlList") {
            return { ok: true, url: "https://directory.example/submit" };
          }
          return { ok: true };
        },
      },
    },
    closeTimelineEditor() {},
    loadSidepanelTimeline: async () => {},
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(sidepanelSource.slice(start, end), context);
  await vm.runInContext("saveTimelineEvent({ preventDefault() {} })", context);
  assert.deepEqual(
    JSON.parse(JSON.stringify(messages.map((message) => message.action))),
    ["addToUrlList", "addSubmissionTimelineEvent"],
    "an unlisted current page should be materialized before its timeline event is saved",
  );
  assert.equal(messages[1].destinationKey, "directory.example/submit");
}

// The first materialization request is asynchronous. The save lock must be
// installed before it starts so a second click cannot enqueue a duplicate;
// switching pages while it is suspended must also leave the new page's item
// untouched while the captured destination still receives the event.
{
  const start = sidepanelSource.indexOf("  function toDateTimeLocal");
  const end = sidepanelSource.indexOf("  function renderSubmissionNav", start);
  let resolveMaterialize;
  const materializePending = new Promise((resolve) => {
    resolveMaterialize = resolve;
  });
  const fields = {
    timelineProfileSelect: { value: "ProfileA" },
    timelineEventType: { value: "submitted" },
    timelineOccurredAt: { value: "2026-09-10T10:00" },
    timelineNote: { value: "等待审核" },
    timelinePublicUrl: { value: "" },
    timelineEvidenceUrl: { value: "https://old.example/evidence" },
    btnSaveTimelineEvent: { disabled: false, textContent: "保存人工动态" },
    btnCancelTimelineEvent: { disabled: false },
  };
  const messages = [];
  const context = {
    console,
    Promise,
    URL,
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Array,
    Object,
    Error,
    detection: { platform: "directory" },
    siteProfiles: { ProfileA: { name: "Profile A" } },
    activeSiteId: "ProfileA",
    currentPageUrl: "https://old.example/submit",
    currentTimelineItem: null,
    timelineSaveInProgress: false,
    timelineEditorUrl: "https://old.example/submit",
    Q: {
      normalizeDestinationKey: (url) => new URL(url).host + new URL(url).pathname,
      normalizeUrlKey: (url) => new URL(url).host + new URL(url).pathname,
      extractDomain: (url) => new URL(url).host,
    },
    $: (id) => fields[id] || null,
    chrome: {
      runtime: {
        sendMessage: async (message) => {
          messages.push(message);
          if (message.action === "addToUrlList") return materializePending;
          return { ok: true };
        },
      },
    },
    closeTimelineEditor() {},
    loadSidepanelTimeline: async () => {},
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(sidepanelSource.slice(start, end), context);
  const firstSave = vm.runInContext("saveTimelineEvent({ preventDefault() {} })", context);
  await Promise.resolve();
  await vm.runInContext("saveTimelineEvent({ preventDefault() {} })", context);
  assert.deepEqual(
    JSON.parse(JSON.stringify(messages.map((message) => message.action))),
    ["addToUrlList"],
    "a second click while materializing a destination must not issue another request",
  );

  context.currentPageUrl = "https://new.example/submit";
  context.timelineEditorUrl = "";
  context.currentTimelineItem = {
    key: "new.example/submit",
    url: "https://new.example/submit",
    events: [],
  };
  resolveMaterialize({ ok: true, url: "https://old.example/submit" });
  await firstSave;
  assert.deepEqual(
    JSON.parse(JSON.stringify(messages.map((message) => message.action))),
    ["addToUrlList", "addSubmissionTimelineEvent"],
    "the captured page should still receive one timeline event after a page switch",
  );
  assert.equal(messages[1].destinationUrl, "https://old.example/submit");
  assert.equal(messages[1].destinationKey, "old.example/submit");
  assert.equal(context.currentTimelineItem.key, "new.example/submit");
  assert.equal(context.timelineSaveInProgress, false);
  assert.equal(fields.btnSaveTimelineEvent.disabled, false);
  assert.equal(fields.btnCancelTimelineEvent.disabled, false);
}

// The settings page protects both sides of the asynchronous cloud pull. The
// pure comparison ignores updatedAt, while the handler rechecks dirty state
// after the response and before location.reload().
{
  const start = settingsSource.indexOf("  function canonicalProfileSnapshot");
  const end = settingsSource.indexOf("  function updateLogoPreview", start);
  assert.ok(start >= 0 && end > start, "settings profile comparison helper should remain available");
  const context = { self: {} };
  vm.createContext(context);
  vm.runInContext(settingsSource.slice(start, end), context);
  assert.equal(
    context.profileHasUnsavedChanges(
      { id: "A", name: "A", updatedAt: "new" },
      { name: "A", id: "A", updatedAt: "old" },
    ),
    false,
  );
  assert.equal(
    context.profileHasUnsavedChanges(
      { id: "A", name: "edited", updatedAt: "new" },
      { id: "A", name: "A", updatedAt: "old" },
    ),
    true,
  );

  const pullStart = settingsSource.indexOf('$("btnCloudPull")?.addEventListener');
  const reload = settingsSource.indexOf("location.reload()", pullStart);
  assert.ok(pullStart >= 0 && reload > pullStart, "settings should keep the cloud pull handler");
  const pullBody = settingsSource.slice(pullStart, reload);
  assert.ok(
    (pullBody.match(/hasUnsavedSettingsEdits\(\)/g) || []).length >= 3,
    "cloud pull must check every editor before the request, before conflict resolution, and before reload",
  );
  assert.match(pullBody, /\["conflict", "pending"\]\.includes\(result\.status\)/);
  assert.match(pullBody, /downloadSubmissionBackup\(\)/);
  assert.match(pullBody, /resolveConflicts: true/);
  assert.match(pullBody, /discardLocalChanges: result\.status === "pending"/);
  assert.ok(
    pullBody.indexOf("downloadSubmissionBackup()") < pullBody.indexOf("resolveConflicts: true"),
    "conflict recovery must trigger the local backup before forcing the cloud pull",
  );
  assert.match(pullBody, /请确认文件已保存/);
  assert.match(pullBody, /adoptPulledSiteProfiles\(result\.state, hasSiteDraftAfterPull\)/);
  assert.match(pullBody, /result\.applied === false/);
}

// Conflict recovery must never silently overwrite local state. It starts the
// existing JSON backup download first, asks the user to confirm the file was
// saved, and only then sends the explicit resolveConflicts request.
{
  const pullStart = settingsSource.indexOf('$("btnCloudPull")?.addEventListener');
  const pullEnd = settingsSource.indexOf('\n\n  document.addEventListener("input"', pullStart);
  assert.ok(pullStart >= 0 && pullEnd > pullStart, "cloud pull handler should remain extractable");

  function createPullHarness({ backup, confirmResult }) {
    const events = [];
    const statuses = [];
    const messages = [];
    let reloads = 0;
    const button = {
      disabled: false,
      addEventListener(_type, listener) {
        this.listener = listener;
      },
    };
    const context = {
      Promise,
      Error,
      Object,
      String,
      Number,
      JSON,
      $: (id) => id === "btnCloudPull" ? button : null,
      hasUnsavedSettingsEdits: () => false,
      hasUnsavedSiteEdits: () => false,
      downloadSubmissionBackup: async () => {
        events.push("backup");
        return backup();
      },
      adoptPulledSiteProfiles() {},
      setCloudStatus: (message, tone) => statuses.push({ message, tone }),
      queueReloadNotice: (message, tone, panel) => events.push(`notice:${tone}:${panel}:${message}`),
      confirm: () => {
        events.push("confirm");
        return confirmResult;
      },
      location: { reload: () => { reloads += 1; } },
      chrome: {
        runtime: {
          sendMessage: async (message) => {
            messages.push(message);
            events.push(message.resolveConflicts ? "force" : "pull");
            if (message.resolveConflicts) {
              return {
                ok: true,
                applied: true,
                state: { siteProfiles: { Remote: { id: "Remote" } } },
                documentCount: 1,
              };
            }
            return {
              ok: true,
              status: "conflict",
              message: "存在冲突",
            };
          },
        },
      },
    };
    vm.createContext(context);
    vm.runInContext(settingsSource.slice(pullStart, pullEnd), context);
    return { button, context, events, statuses, messages, get reloads() { return reloads; } };
  }

  const backupFailure = createPullHarness({
    backup: async () => { throw new Error("磁盘不可用"); },
    confirmResult: true,
  });
  await backupFailure.button.listener();
  assert.deepEqual(backupFailure.events, ["pull", "backup"]);
  assert.equal(backupFailure.messages.length, 1, "backup failure must not send a forced pull");
  assert.match(backupFailure.statuses.at(-1).message, /备份失败/);

  const canceled = createPullHarness({
    backup: async () => {},
    confirmResult: false,
  });
  await canceled.button.listener();
  assert.deepEqual(canceled.events, ["pull", "backup", "confirm"]);
  assert.equal(canceled.messages.length, 1, "canceling after backup must preserve local data");
  assert.equal(canceled.reloads, 0);

  const resolved = createPullHarness({
    backup: async () => {},
    confirmResult: true,
  });
  await resolved.button.listener();
  assert.deepEqual(resolved.events.slice(0, 4), ["pull", "backup", "confirm", "force"]);
  assert.match(resolved.events[4], /^notice:success:library:云端回读成功/);
  assert.equal(resolved.messages.length, 2);
  assert.equal(resolved.messages[1].resolveConflicts, true);
  assert.equal(resolved.reloads, 1);
}

console.log("UI settings/sidepanel audit tests passed");

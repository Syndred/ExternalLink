import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(root, "extension");
const backgroundSource = readFileSync(resolve(extensionRoot, "background.js"), "utf8");
const moduleSources = new Map(
  [
    "lib/profiles.js",
    "lib/queue.js",
    "lib/playbooks.js",
    "lib/batch-controls.js",
    "lib/unattended.js",
    "lib/scheduler.js",
    "lib/submission-timeline.js",
    "lib/backup.js",
    "lib/cloud-sync.js",
    "lib/url-library.js",
    "lib/library-classifier.js",
    "lib/submify-import.js",
    "lib/opportunity-score.js",
    "lib/context-menu.js",
    "lib/automation-ledger.js",
  ].map((file) => [file, readFileSync(resolve(extensionRoot, file), "utf8")]),
);

const realDate = Date;

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(...args) {
      return [...listeners].map((listener) => listener(...args));
    },
    get listeners() {
      return [...listeners];
    },
  };
}

function makeClock(now = realDate.now()) {
  let current = now;
  class TestDate extends realDate {
    constructor(...args) {
      super(args.length ? args[0] : current);
    }

    static now() {
      return current;
    }
  }
  return {
    Date: TestDate,
    get now() {
      return current;
    },
    setNow(next) {
      current = Number(next);
    },
  };
}

function createChrome({ storage = {}, tabs = [], tabMessage, clock }) {
  const storageData = clone(storage) || {};
  const tabMap = new Map(
    tabs.map((tab) => [
      tab.id,
      {
        active: false,
        windowId: 1,
        status: "complete",
        ...clone(tab),
      },
    ]),
  );
  const calls = {
    tabsCreate: [],
    tabsRemove: [],
    tabsUpdate: [],
    tabsReload: [],
    sendMessage: [],
    alarmsCreate: [],
    runtimeMessages: [],
  };
  const events = {
    runtimeMessage: createEvent(),
    tabsUpdated: createEvent(),
    tabsRemoved: createEvent(),
    storageChanged: createEvent(),
    alarms: createEvent(),
    installed: createEvent(),
    startup: createEvent(),
    contextClicked: createEvent(),
  };
  const alarms = new Map();
  let nextTabId = Math.max(100, ...tabMap.keys()) + 1;
  let responseForTabMessage = tabMessage || (() => undefined);
  let storageSetGate = null;

  const local = {
    async get(keys) {
      if (keys === undefined || keys === null) return clone(storageData);
      if (typeof keys === "string") return { [keys]: clone(storageData[keys]) };
      if (Array.isArray(keys)) {
        return Object.fromEntries(keys.map((key) => [key, clone(storageData[key])]));
      }
      if (typeof keys === "object") {
        return Object.fromEntries(
          Object.entries(keys).map(([key, fallback]) => [
            key,
            Object.prototype.hasOwnProperty.call(storageData, key)
              ? clone(storageData[key])
              : clone(fallback),
          ]),
        );
      }
      return {};
    },
    async set(values) {
      if (storageSetGate) await storageSetGate(values || {});
      for (const [key, value] of Object.entries(values || {})) storageData[key] = clone(value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete storageData[key];
    },
    async clear() {
      for (const key of Object.keys(storageData)) delete storageData[key];
    },
  };

  const tabApi = {
    onUpdated: events.tabsUpdated,
    onRemoved: events.tabsRemoved,
    async query() {
      return [...tabMap.values()].map((tab) => clone(tab));
    },
    async get(tabId) {
      const tab = tabMap.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      return clone(tab);
    },
    async create(options = {}) {
      const tab = {
        id: nextTabId++,
        active: options.active === true,
        windowId: 1,
        status: "complete",
        url: options.url || "about:blank",
        title: "",
      };
      calls.tabsCreate.push(clone(options));
      tabMap.set(tab.id, tab);
      return clone(tab);
    },
    async update(tabId, changes = {}) {
      const tab = tabMap.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      Object.assign(tab, changes);
      calls.tabsUpdate.push({ tabId, changes: clone(changes) });
      return clone(tab);
    },
    async reload(tabId) {
      const tab = tabMap.get(tabId);
      if (!tab) throw new Error(`No tab with id: ${tabId}`);
      tab.status = "complete";
      calls.tabsReload.push(tabId);
      return clone(tab);
    },
    async remove(tabId) {
      calls.tabsRemove.push(tabId);
      const existed = tabMap.delete(tabId);
      if (existed) events.tabsRemoved.emit(tabId, { windowId: 1, isWindowClosing: false });
    },
    async sendMessage(tabId, message) {
      calls.sendMessage.push({ tabId, message: clone(message) });
      const result = await responseForTabMessage(tabId, message);
      if (result !== undefined) return result;
      switch (message?.action) {
        case "ping":
          return { ok: true };
        case "detectPage":
          return { ok: true, platform: "directory", operable: false, formFieldCount: 0 };
        case "getPageSnapshot":
          return { title: "", text: "", fields: [], forms: [], buttons: [] };
        case "getFilledFieldsReport":
          return { fields: [], allValid: true, invalidCount: 0 };
        case "collectFormValidation":
          return { validationFailed: false };
        case "countEmptyFields":
          return { emptyCount: 0, totalCount: 0, invalidCount: 0 };
        case "removeManualWaitBanner":
        case "showManualWaitBanner":
        case "broadcast":
          return { ok: true };
        default:
          return { ok: true };
      }
    },
    async captureVisibleTab() {
      return "data:image/png;base64,";
    },
  };

  const runtime = {
    onInstalled: events.installed,
    onStartup: events.startup,
    onMessage: events.runtimeMessage,
    async sendMessage(message) {
      calls.runtimeMessages.push(clone(message));
      return { ok: true };
    },
    getURL(path) {
      return `chrome-extension://test/${path}`;
    },
  };

  const chrome = {
    runtime,
    tabs: tabApi,
    storage: { local, onChanged: events.storageChanged },
    alarms: {
      onAlarm: events.alarms,
      async create(name, info = {}) {
        calls.alarmsCreate.push({ name, info: clone(info) });
        alarms.set(name, { name, ...clone(info) });
      },
      async clear(name) {
        alarms.delete(name);
        return true;
      },
      async get(name) {
        return clone(alarms.get(name) || null);
      },
      async getAll() {
        return [...alarms.values()].map((alarm) => clone(alarm));
      },
    },
    contextMenus: { onClicked: events.contextClicked },
    sidePanel: {
      async setPanelBehavior() {},
      async open() {},
    },
    scripting: {
      async executeScript() {},
    },
    debugger: {
      async attach() {},
      async detach() {},
      async sendCommand() {},
    },
    windows: {
      async getLastFocused() {
        return { id: 1 };
      },
    },
    notifications: {
      async create() {},
    },
  };

  return {
    chrome,
    calls,
    events,
    alarms,
    storageData,
    tabMap,
    setTabMessageHandler(handler) {
      responseForTabMessage = handler;
    },
    setStorageSetGate(gate) {
      storageSetGate = gate;
    },
    async fireAlarm(name) {
      const result = events.alarms.emit({ name });
      await Promise.all(result.filter((value) => value && typeof value.then === "function"));
    },
    clock,
  };
}

function makeTestDate(clock) {
  return clock.Date;
}

function makeContext(mock) {
  const context = {
    console: { log() {}, warn() {}, error() {} },
    chrome: mock.chrome,
    URL,
    URLSearchParams,
    Headers,
    Blob,
    ArrayBuffer,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    AbortController,
    Promise,
    Set,
    Map,
    WeakMap,
    Date: makeTestDate(mock.clock),
    Math,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Array,
    Object,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isFinite,
    structuredClone: globalThis.structuredClone,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    crypto: { randomUUID },
    fetch: async () => ({ ok: false, status: 503, headers: new Headers(), json: async () => ({}), text: async () => "" }),
    btoa: globalThis.btoa,
    atob: globalThis.atob,
  };
  context.self = context;
  context.window = context;
  context.importScripts = (...files) => {
    for (const file of files) {
      const source = moduleSources.get(file);
      if (!source) throw new Error(`test harness cannot load ${file}`);
      vm.runInContext(source, context, { filename: `extension/${file}` });
    }
  };
  vm.createContext(context);
  vm.runInContext(backgroundSource, context, { filename: "extension/background.js" });
  return context;
}

async function loadRuntime(options = {}) {
  const clock = makeClock(options.now);
  const mock = createChrome({
    storage: options.storage || {},
    tabs: options.tabs || [],
    tabMessage: options.tabMessage,
    clock,
  });
  const context = makeContext(mock);
  const hooks = vm.runInContext(
    `({
      state,
      initializationPromise,
      startBatchRunOnce,
      restoreActiveBatchRun,
      processQueue,
      processOne,
      scheduleQueueProcessing,
      refreshBatchRunStatus,
      getRuntimeState,
      pauseBatchRun,
      resumeBatchRun,
      stopBatchRun,
      replaceActiveBatchRun,
      updateActiveBatchRun,
      tryAutoSubmitFilledForm,
      markTaskUnconfirmed,
      parkTaskEntry,
      persistParkedTaskIds,
      handleTimeout,
      resetEntryTimeout,
      closeAutomatedTabs,
      trimUnattendedManualTabs,
      pauseUnattendedBatch,
      watchdogUnattendedBatch,
      reserveUnattendedModelCall,
      claimUnattendedTask,
      ensureUnattendedWatchdog: typeof ensureUnattendedWatchdog === "function" ? ensureUnattendedWatchdog : null,
      scheduleUnattendedWatchdog: typeof scheduleUnattendedWatchdog === "function" ? scheduleUnattendedWatchdog : null,
      armUnattendedWatchdog: typeof armUnattendedWatchdog === "function" ? armUnattendedWatchdog : null,
      watchdog: typeof unattendedWatchdog === "function" ? unattendedWatchdog : null,
    })`,
    context,
  );
  await hooks.initializationPromise;
  return { context, hooks, mock, clock };
}

function task({ index, profileId, destinationKey = "example.com/submit", status = "pending" }) {
  return {
    id: `${destinationKey}::${profileId}`,
    key: destinationKey,
    destinationKey,
    destinationGroupKey: destinationKey,
    destinationGroupIndex: 1,
    destinationUrl: `https://${destinationKey}`,
    url: `https://${destinationKey}`,
    domain: destinationKey.split("/")[0],
    platformType: "directory",
    source: "test",
    profileId,
    profileName: profileId,
    projectKey: profileId,
    status,
    index,
    groupJobIndex: index,
    groupJobCount: 2,
    _attempt: 0,
  };
}

function destinationRow(destinationKey = "example.com/submit") {
  return [1, destinationKey, `https://${destinationKey}`, destinationKey.split("/")[0], "directory", "test", ""];
}

function serializedTask(item) {
  return [
    item.index,
    item.destinationGroupIndex,
    item.profileId,
    item.profileName,
    item.status,
    item.groupJobIndex,
    item.groupJobCount,
    item.skipReason || "",
    item.successEvidence || "",
    item.publicationStatus || "",
    item.publicUrl || "",
    item.evidenceUrl || "",
    item.isDofollow ? 1 : 0,
    item.relResult || "",
    item._attempt || 0,
    item.confirmationNonce || "",
    item.productHuntStage || "",
    item.productHuntStageAttempt || 0,
    item.productHuntExpectedNext || "",
    item.productHuntLastTransitionAt || "",
    item.submissionAttempted === true ? 1 : 0,
    item.executionPhase || "",
    Math.max(0, Number(item.taskDeadlineAt) || 0),
    item.manualTodoAt || "",
    item.unattendedClaimed === true ? 1 : 0,
    Number(item.manualTabId) > 0 ? Number(item.manualTabId) : 0,
    item.manualTabUrl || "",
  ];
}

function unattendedConfig(extra = {}) {
  return {
    unattended: true,
    unattendedMaxHours: 8,
    unattendedMaxTasks: 100,
    unattendedMaxAgentCalls: 200,
    unattendedMaxConsecutiveFailures: 5,
    unattendedMaxManualTabs: 20,
    unattendedWatchdogMinutes: 1,
    ...extra,
  };
}

function batchStorage({ status = "running", tasks, parkedTaskIds = [], config = unattendedConfig(), runDeadlineAt } = {}) {
  const list = tasks || [task({ index: 1, profileId: "P1", status: "pending" })];
  const deadline = runDeadlineAt || new realDate(realDate.now() + 8 * 60 * 60 * 1000).toISOString();
  const unattendedState = {
    enabled: config.unattended === true,
    startedAt: new realDate(realDate.now()).toISOString(),
    runDeadlineAt: deadline,
    maxHours: config.unattendedMaxHours || 8,
    maxTasks: config.unattendedMaxTasks || 100,
    maxAgentCalls: config.unattendedMaxAgentCalls || 200,
    maxConsecutiveFailures: config.unattendedMaxConsecutiveFailures || 5,
    maxManualTabs: config.unattendedMaxManualTabs ?? 20,
    watchdogMinutes: config.unattendedWatchdogMinutes || 1,
    taskMaxMinutes: config.unattendedTaskMaxMinutes || 5,
    taskBudgetUsed: config.taskBudgetUsed || 0,
    modelCallsUsed: config.modelCallsUsed || 0,
    consecutiveFailures: config.consecutiveFailures || 0,
    manualTodoIds: config.manualTodoIds || [],
  };
  return {
    activeBatchRun: {
      version: 4,
      runId: "run-test",
      status,
      selectedSiteIds: [...new Set(list.map((item) => item.profileId))],
      config: { ...config, ...(runDeadlineAt ? { runDeadlineAt } : {}) },
      unattendedState,
      profileConfigs: Object.fromEntries(list.map((item) => [item.profileId, { projectKey: item.profileId, brandName: item.profileId }])),
      destinations: [destinationRow(list[0]?.destinationKey)],
      parkedTaskIds,
      startedAt: new realDate(0).toISOString(),
      ...(status === "finished" ? { finishedAt: new realDate(1).toISOString() } : {}),
      tasks: list.map(serializedTask),
    },
  };
}

async function settle(ms = 10) {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function stopIfNeeded(runtime) {
  const { hooks } = runtime;
  if (hooks.state.running || hooks.state.paused || hooks.state.activeTabs.size) {
    await hooks.stopBatchRun().catch(() => {});
  }
  for (const entry of hooks.state.activeTabs.values()) {
    if (entry.timeoutId) clearTimeout(entry.timeoutId);
    if (entry.manualWaitTimeoutId) clearTimeout(entry.manualWaitTimeoutId);
  }
}

async function setupManualCapacityRuntime({ maxManualTabs = 2 } = {}) {
  const manualTasks = [
    task({ index: 1, profileId: "P1", status: "filled" }),
    task({ index: 2, profileId: "P2", status: "needs_captcha" }),
  ];
  const pending = task({
    index: 3,
    profileId: "P3",
    status: "needs_manual",
    destinationKey: "next.example/submit",
  });
  const config = unattendedConfig({ unattendedMaxManualTabs: maxManualTabs });
  const runtime = await loadRuntime({
    storage: batchStorage({
      tasks: [...manualTasks, pending],
      parkedTaskIds: manualTasks.map((item) => item.id),
      config,
    }),
    tabs: [
      { id: 101, url: manualTasks[0].url, status: "complete" },
      { id: 102, url: manualTasks[1].url, status: "complete" },
    ],
  });
  pending.status = "pending";
  runtime.hooks.state.config = config;
  runtime.hooks.state.unattended = runtime.context.ExtLinkUnattended.createCheckpoint(
    config,
    runtime.clock.now,
    runtime.mock.storageData.activeBatchRun.unattendedState,
  );
  runtime.hooks.state.unattended.manualTodoIds = manualTasks.map((item) => item.id);
  runtime.hooks.state.running = true;
  runtime.hooks.state.paused = false;
  runtime.hooks.state.stopped = false;
  runtime.hooks.state.tasks = [...manualTasks, pending];
  const manualGroups = manualTasks.map((item) => ({
    key: item.destinationKey,
    url: item.url,
    domain: item.domain,
    tasks: [item],
  }));
  const pendingGroup = {
    key: pending.destinationKey,
    url: pending.url,
    domain: pending.domain,
    tasks: [pending],
  };
  runtime.hooks.state.groups = [...manualGroups, pendingGroup];
  runtime.hooks.state.queue = [pendingGroup];
  runtime.hooks.state.parkedTaskIds = new Set(manualTasks.map((item) => item.id));
  runtime.hooks.state.activeTabs = new Map([
    [101, { taskIndex: 1, taskId: manualTasks[0].id, runId: 0, slotActive: false, agentDone: true, agentPaused: true, parkedAt: 1 }],
    [102, { taskIndex: 2, taskId: manualTasks[1].id, runId: 0, slotActive: false, agentDone: true, agentPaused: true, parkedAt: 2 }],
  ]);
  return { runtime, manualTasks, pending, pendingGroup };
}

// The unattended manual-page capacity defaults to 20 and remains configurable
// within the documented 1..100 range.
{
  // The helper is loaded in a VM below; keep the assertions in the first
  // runtime so this test exercises the shipped normalizer rather than a copy.
  const runtime = await loadRuntime();
  const normalizeConfig = runtime.context.ExtLinkUnattended.normalizeConfig;
  assert.equal(normalizeConfig({ unattended: true }).unattendedMaxManualTabs, 20);
  assert.equal(normalizeConfig({ unattendedMaxManualTabs: 1 }).unattendedMaxManualTabs, 1);
  assert.equal(normalizeConfig({ unattendedMaxManualTabs: 100 }).unattendedMaxManualTabs, 100);
  assert.equal(normalizeConfig({ unattendedMaxManualTabs: 0 }).unattendedMaxManualTabs, 1);
  assert.equal(normalizeConfig({ unattendedMaxManualTabs: 101 }).unattendedMaxManualTabs, 100);
  await stopIfNeeded(runtime);
}

// Restoring a finished batch must keep its result visible after a worker restart.
{
  const finished = task({ index: 1, profileId: "P1", status: "ok" });
  const runtime = await loadRuntime({
    storage: batchStorage({ status: "finished", tasks: [finished] }),
  });
  const state = await runtime.hooks.getRuntimeState();
  assert.equal(state.status, "finished", "a finished run must remain visible after restore");
  assert.equal(state.tasks[0]?.status, "ok");
  assert.equal(runtime.mock.calls.tabsCreate.length, 0, "restoring a finished run must not open a tab");
  await stopIfNeeded(runtime);
}

// A permanent success record wins over a stale running task and prevents a duplicate tab.
{
  const completed = task({ index: 1, profileId: "P1", status: "running" });
  const runtime = await loadRuntime({
    storage: {
      ...batchStorage({ tasks: [completed] }),
      submissionRecords: {
        "example.com/submit::P1": {
          status: "success",
          destinationKey: "example.com/submit",
          profileId: "P1",
          confirmedBy: "agent",
          evidence: "Submission received",
        },
      },
    },
  });
  assert.equal(runtime.hooks.state.tasks[0]?.status, "ok", "success ledger must recover a stale running task as done");
  await settle();
  assert.equal(runtime.mock.calls.tabsCreate.length, 0, "a recovered success must never be submitted again");
  await stopIfNeeded(runtime);
}

// An unknown receipt is a durable manual todo and must not be retried as a fresh submission.
{
  const runtime = await loadRuntime();
  const current = task({ index: 1, profileId: "P1", status: "running" });
  const entry = { taskIndex: current.index, taskId: current.id, slotActive: true, runId: 0 };
  runtime.hooks.state.runId = "run-unknown-receipt";
  runtime.hooks.state.running = true;
  runtime.hooks.state.config = unattendedConfig();
  runtime.hooks.state.tasks = [current];
  runtime.hooks.state.groups = [{ key: current.destinationKey, url: current.url, domain: current.domain, tasks: [current] }];
  runtime.hooks.state.queue = [...runtime.hooks.state.groups];
  runtime.hooks.state.activeTabs = new Map([[17, entry]]);
  await runtime.hooks.replaceActiveBatchRun({
    ...batchStorage({ tasks: [current] }).activeBatchRun,
    runId: runtime.hooks.state.runId,
  });
  runtime.hooks.markTaskUnconfirmed(17, current, entry, "点击后未出现新的可核验回执");
  await settle();
  assert.equal(current.status, "submitted_unconfirmed");
  assert.ok(runtime.hooks.state.parkedTaskIds.has(current.id), "unknown receipt must remain a parked todo");
  await runtime.hooks.processQueue();
  assert.equal(runtime.mock.calls.tabsCreate.length, 0, "unknown receipt must not trigger a blind resubmission");
  await stopIfNeeded(runtime);
}

// Restoring a parked task must still enqueue a pending sibling in the same destination group.
{
  const parked = task({ index: 1, profileId: "P1", status: "needs_manual" });
  const pending = task({ index: 2, profileId: "P2", status: "pending" });
  const runtime = await loadRuntime({
    storage: batchStorage({
      tasks: [parked, pending],
      parkedTaskIds: [parked.id],
    }),
    tabs: [{ id: 5, url: parked.url, status: "complete" }],
  });
  await settle(25);
  assert.equal(runtime.mock.calls.tabsCreate.length, 1, "a parked Profile must not block a pending sibling");
  assert.equal(runtime.mock.calls.tabsCreate[0].url, pending.url);
  await stopIfNeeded(runtime);
}

// Manual pages are bounded for admission, while existing pages are never
// closed or navigated away when the configured capacity is full.
{
  const todoTasks = [
    task({ index: 1, profileId: "P1", status: "needs_manual" }),
    task({ index: 2, profileId: "P2", status: "needs_manual" }),
    task({ index: 3, profileId: "P3", status: "needs_manual" }),
  ];
  const runtime = await loadRuntime({
    storage: batchStorage({ tasks: todoTasks, config: unattendedConfig({ unattendedMaxManualTabs: 2 }) }),
    tabs: todoTasks.map((item, index) => ({ id: 11 + index, url: item.url, status: "complete" })),
  });
  runtime.hooks.state.config = unattendedConfig({ unattendedMaxManualTabs: 2 });
  runtime.hooks.state.unattended = runtime.context.ExtLinkUnattended.createCheckpoint(
    runtime.hooks.state.config,
    runtime.clock.now,
    runtime.mock.storageData.activeBatchRun.unattendedState,
  );
  runtime.hooks.state.running = true;
  runtime.hooks.state.stopped = false;
  runtime.hooks.state.tasks = todoTasks;
  runtime.hooks.state.parkedTaskIds = new Set(todoTasks.map((item) => item.id));
  runtime.hooks.state.activeTabs = new Map(
    todoTasks.map((item, index) => [
      11 + index,
      {
        taskIndex: item.index,
        taskId: item.id,
        slotActive: false,
        parkedAt: index + 1,
        timeoutId: null,
      },
    ]),
  );
  await runtime.hooks.trimUnattendedManualTabs();
  const openManualTabs = [...runtime.hooks.state.activeTabs.values()].filter((entry) => entry.slotActive === false);
  assert.equal(openManualTabs.length, 3, "unattended mode must retain every already-open manual tab");
  assert.equal(runtime.mock.calls.tabsRemove.length, 0, "capacity enforcement must never close an existing manual tab");
  assert.equal(runtime.mock.calls.tabsUpdate.length, 0, "capacity enforcement must never navigate an existing manual tab");
  for (const tabId of [11, 12, 13]) {
    assert.equal(runtime.mock.tabMap.has(tabId), true, `manual tab ${tabId} must remain open`);
  }
  assert.deepEqual(
    [...runtime.hooks.state.parkedTaskIds].sort(),
    todoTasks.map((item) => item.id).sort(),
    "all retained manual pages must remain durable TODOs",
  );
  await stopIfNeeded(runtime);
}

// When manual capacity is full, the pending automatic site stays queued. The
// existing filled/CAPTCHA pages remain untouched, and releasing one slot
// resumes the queue automatically.
{
  const { runtime, manualTasks, pending, pendingGroup } = await setupManualCapacityRuntime();

  await runtime.hooks.trimUnattendedManualTabs();
  await runtime.hooks.processOne(pendingGroup);
  await settle(25);
  assert.equal(runtime.mock.calls.tabsCreate.length, 0, "a full manual capacity must block a new automatic tab");
  assert.equal(runtime.mock.calls.tabsRemove.length, 0, "capacity blocking must not close a manual tab");
  assert.equal(runtime.mock.calls.tabsUpdate.length, 0, "capacity blocking must not navigate a manual tab");
  assert.equal(pending.status, "pending");
  assert.ok(runtime.hooks.state.queue.includes(pendingGroup), "the blocked task must remain queued");
  assert.equal(runtime.hooks.state.unattended.waitReason, "manual_capacity");
  assert.equal(runtime.hooks.state.unattended.manualTabCount, 2);
  assert.equal(runtime.mock.storageData.activeBatchRun.status, "running");
  assert.equal(runtime.mock.storageData.activeBatchRun.unattendedState.waitReason, "manual_capacity");
  assert.equal(runtime.mock.storageData.activeBatchRun.unattendedState.manualTabCount, 2);
  assert.equal((await runtime.hooks.getRuntimeState()).status, "running", "capacity wait must stay visible as running");
  assert.equal(runtime.mock.tabMap.has(101), true);
  assert.equal(runtime.mock.tabMap.has(102), true);

  await runtime.mock.chrome.tabs.remove(101);
  await settle(60);
  assert.equal(runtime.mock.calls.tabsCreate.length, 1, "releasing a manual slot must resume the queued task");
  assert.equal(runtime.mock.calls.tabsCreate[0].url, pending.url);
  assert.equal(runtime.mock.tabMap.has(102), true, "the other manual page must remain open");
  assert.equal(runtime.hooks.state.unattended.waitReason || "", "");
  assert.equal(runtime.hooks.state.unattended.manualTabCount, 1);
  assert.equal(runtime.mock.storageData.activeBatchRun.unattendedState.waitReason || "", "");
  assert.equal((await runtime.hooks.getRuntimeState()).status, "running");
  await stopIfNeeded(runtime);
}

// Releasing capacity must still respect an explicit user pause or stop.
for (const action of ["pause", "stop"]) {
  const { runtime, pending, pendingGroup } = await setupManualCapacityRuntime();
  await runtime.hooks.processOne(pendingGroup);
  assert.equal(runtime.mock.calls.tabsCreate.length, 0);
  if (action === "pause") {
    await runtime.hooks.pauseBatchRun();
    assert.equal(runtime.hooks.state.paused, true);
  } else {
    await runtime.hooks.stopBatchRun();
    assert.equal(runtime.hooks.state.stopped, true);
  }
  await runtime.mock.chrome.tabs.remove(101);
  await settle(60);
  assert.equal(
    runtime.mock.calls.tabsCreate.length,
    0,
    `${action} must prevent a released manual slot from resuming automation`,
  );
  assert.equal(pending.status, "pending");
  await stopIfNeeded(runtime);
}

// A deadline pause has the same boundary: releasing a manual page cannot
// restart an automatic task after the watchdog has expired the run.
{
  const { runtime, pending } = await setupManualCapacityRuntime();
  runtime.hooks.state.unattended.runDeadlineAt = runtime.clock.now - 1;
  await runtime.hooks.watchdogUnattendedBatch();
  assert.equal(runtime.hooks.state.paused, true);
  await runtime.mock.chrome.tabs.remove(101);
  await settle(60);
  assert.equal(runtime.mock.calls.tabsCreate.length, 0, "an expired run must not resume after manual capacity is released");
  assert.equal(pending.status, "pending");
  await stopIfNeeded(runtime);
}

// The watchdog uses the persisted absolute deadline; an expired run pauses and keeps its TODOs.
{
  const now = 10_000_000;
  const runtime = await loadRuntime({
    now,
    storage: batchStorage({
      status: "paused",
      runDeadlineAt: new realDate(now - 1_000).toISOString(),
    }),
  });
  const watchdogNames = [...runtime.mock.alarms.keys()];
  for (const name of watchdogNames) await runtime.mock.fireAlarm(name);
  await runtime.hooks.watchdogUnattendedBatch();
  await settle();
  assert.equal(runtime.hooks.state.paused, true, "an expired unattended deadline must pause the run");
  assert.equal(runtime.hooks.state.stopped, false, "deadline pause must retain the batch for manual review");
  assert.equal(runtime.mock.storageData.activeBatchRun?.status, "paused");
  assert.match(
    runtime.mock.storageData.activeBatchRun?.unattendedState?.stopReason || "",
    /截止时间/,
  );
  await stopIfNeeded(runtime);
}

// The max-task budget permits the final allowed task to start and complete.
{
  const current = task({ index: 1, profileId: "P1", status: "pending" });
  const runtime = await loadRuntime();
  runtime.hooks.state.runId = "run-budget";
  runtime.hooks.state.running = true;
  runtime.hooks.state.config = unattendedConfig({ unattendedMaxTasks: 1, taskBudgetUsed: 0 });
  runtime.hooks.state.tasks = [current];
  runtime.hooks.state.groups = [{ key: current.destinationKey, url: current.url, domain: current.domain, tasks: [current] }];
  runtime.hooks.state.queue = [...runtime.hooks.state.groups];
  const active = batchStorage({ tasks: [current], config: runtime.hooks.state.config }).activeBatchRun;
  await runtime.hooks.replaceActiveBatchRun({
    ...active,
    runId: runtime.hooks.state.runId,
  });
  runtime.hooks.state.unattended = runtime.context.ExtLinkUnattended.createCheckpoint(
    runtime.hooks.state.config,
    runtime.clock.now,
    active.unattendedState,
  );
  await runtime.hooks.processOne(runtime.hooks.state.groups[0]);
  assert.equal(runtime.mock.calls.tabsCreate.length, 1, "the final task within the unattended budget must be allowed to run");
  await stopIfNeeded(runtime);
}

// A lifecycle change during an awaited ledger write must gate the final tab create.
for (const action of ["pause", "stop"]) {
  const current = task({ index: 1, profileId: "P1", status: "pending" });
  const runtime = await loadRuntime();
  runtime.hooks.state.runId = `run-race-${action}`;
  runtime.hooks.state.running = true;
  runtime.hooks.state.paused = false;
  runtime.hooks.state.stopped = false;
  runtime.hooks.state.config = unattendedConfig({ unattendedMaxTasks: 1 });
  runtime.hooks.state.tasks = [current];
  runtime.hooks.state.groups = [{ key: current.destinationKey, url: current.url, domain: current.domain, tasks: [current] }];
  runtime.hooks.state.queue = [...runtime.hooks.state.groups];
  const active = batchStorage({ tasks: [current], config: runtime.hooks.state.config }).activeBatchRun;
  await runtime.hooks.replaceActiveBatchRun({ ...active, runId: runtime.hooks.state.runId });
  runtime.hooks.state.unattended = runtime.context.ExtLinkUnattended.createCheckpoint(
    runtime.hooks.state.config,
    runtime.clock.now,
    active.unattendedState,
  );

  let releaseLedger;
  const ledgerHeld = new Promise((resolvePromise) => {
    releaseLedger = resolvePromise;
  });
  let enteredLedger;
  const ledgerEntered = new Promise((resolvePromise) => {
    enteredLedger = resolvePromise;
  });
  let holdNextLedgerWrite = true;
  runtime.mock.setStorageSetGate(async (values) => {
    if (
      holdNextLedgerWrite &&
      Object.prototype.hasOwnProperty.call(values, "automationRunLedger")
    ) {
      holdNextLedgerWrite = false;
      enteredLedger();
      await ledgerHeld;
    }
  });

  const processPromise = runtime.hooks.processOne(runtime.hooks.state.groups[0]);
  await ledgerEntered;
  const lifecyclePromise = action === "pause"
    ? runtime.hooks.pauseBatchRun()
    : runtime.hooks.stopBatchRun();
  await settle(0);
  releaseLedger();
  await Promise.all([processPromise, lifecyclePromise]);
  assert.equal(
    runtime.mock.calls.tabsCreate.length,
    0,
    `${action} during a ledger write must prevent the later tab create`,
  );
  await stopIfNeeded(runtime);
}

// Model-call reservations are serialized and survive a worker restart without restoring quota.
{
  const config = unattendedConfig({ unattendedMaxAgentCalls: 1 });
  const parked = task({ index: 1, profileId: "P1", status: "needs_manual" });
  const storage = batchStorage({
    status: "running",
    tasks: [parked],
    parkedTaskIds: [parked.id],
    config,
  });
  const firstRuntime = await loadRuntime({ storage });
  await firstRuntime.hooks.reserveUnattendedModelCall("/judge");
  assert.equal(
    firstRuntime.hooks.state.unattended.modelCallsUsed,
    1,
    "a model call must be reserved before the cloud request starts",
  );
  assert.equal(
    firstRuntime.mock.storageData.activeBatchRun.unattendedState.modelCallsUsed,
    1,
  );

  const restarted = await loadRuntime({ storage: firstRuntime.mock.storageData });
  assert.equal(
    restarted.hooks.state.unattended.modelCallsUsed,
    1,
    "a worker restart must restore consumed model budget",
  );
  await assert.rejects(
    () => restarted.hooks.reserveUnattendedModelCall("/judge"),
    /预算不足/,
    "a restart must not restore an already consumed model-call slot",
  );
  assert.equal(restarted.mock.storageData.activeBatchRun.unattendedState.modelCallsUsed, 1);
  await stopIfNeeded(firstRuntime);
  await stopIfNeeded(restarted);
}

{
  const config = unattendedConfig({ unattendedMaxAgentCalls: 1 });
  const parked = task({ index: 1, profileId: "P1", status: "needs_manual" });
  const runtime = await loadRuntime({
    storage: batchStorage({
      status: "running",
      tasks: [parked],
      parkedTaskIds: [parked.id],
      config,
    }),
  });
  const results = await Promise.allSettled([
    runtime.hooks.reserveUnattendedModelCall("/judge"),
    runtime.hooks.reserveUnattendedModelCall("/judge"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
    "concurrent reservations must grant exactly one slot when the limit is one",
  );
  assert.equal(
    results.filter((result) => result.status === "rejected").length,
    1,
    "the second concurrent reservation must be denied",
  );
  assert.equal(runtime.hooks.state.unattended.modelCallsUsed, 1);
  assert.equal(runtime.mock.storageData.activeBatchRun.unattendedState.modelCallsUsed, 1);
  await stopIfNeeded(runtime);
}

// A single-task deadline invalidates the old entry and lets another queued task continue.
{
  const expired = task({ index: 1, profileId: "P1", status: "needs_manual" });
  const pending = task({ index: 2, profileId: "P2", status: "needs_manual", destinationKey: "other.example/submit" });
  const runtime = await loadRuntime({
    storage: batchStorage({
      status: "running",
      tasks: [expired, pending],
      parkedTaskIds: [expired.id],
      config: unattendedConfig(),
    }),
    tabs: [{ id: 21, url: expired.url, status: "complete" }],
  });
  expired.status = "running";
  pending.status = "pending";
  runtime.hooks.state.parkedTaskIds = new Set([expired.id]);
  const expiredEntry = {
    taskIndex: expired.index,
    taskId: expired.id,
    runId: 7,
    slotActive: true,
    taskDeadlineAt: runtime.clock.now - 1,
    timeoutId: null,
  };
  runtime.hooks.state.running = true;
  runtime.hooks.state.paused = false;
  runtime.hooks.state.stopped = false;
  runtime.hooks.state.tasks = [expired, pending];
  runtime.hooks.state.groups = [
    { key: expired.destinationKey, url: expired.url, domain: expired.domain, tasks: [expired] },
    { key: pending.destinationKey, url: pending.url, domain: pending.domain, tasks: [pending] },
  ];
  runtime.hooks.state.queue = [runtime.hooks.state.groups[1]];
  runtime.hooks.state.activeTabs = new Map([[21, expiredEntry]]);
  const previousRunId = expiredEntry.runId;
  await runtime.hooks.watchdogUnattendedBatch();
  await settle(25);
  assert.ok(expiredEntry.runId > previousRunId, "task deadline must invalidate the old entry run id");
  assert.equal(expiredEntry.slotActive, false, "expired task must release its processing slot");
  assert.ok(runtime.hooks.state.parkedTaskIds.has(expired.id));
  assert.equal(runtime.mock.calls.tabsCreate.length, 1, "the next queued task must continue after one task expires");
  assert.equal(runtime.mock.calls.tabsCreate[0].url, pending.url);
  await stopIfNeeded(runtime);
}

// A new run carries an unresolved prior Profile as manual-only work, while the
// newly selected Profile is the only pending task opened automatically. The
// rebuilt indexes and destinations must remain unambiguous across reload.
{
  const previous = task({
    index: 1,
    profileId: "P1",
    status: "submitted_unconfirmed",
    destinationKey: "previous.example/submit",
  });
  previous.confirmationNonce = "nonce-p1";
  const candidate = task({
    index: 1,
    profileId: "P2",
    status: "pending",
    destinationKey: "next.example/submit",
  });
  const runtime = await loadRuntime({
    storage: batchStorage({
      status: "finished",
      tasks: [previous],
      parkedTaskIds: [previous.id],
      config: unattendedConfig(),
    }),
  });
  runtime.context.__fixedPending = clone({
    tasks: [candidate],
    groups: [],
    selectedProfileIds: ["P2"],
    meta: { total: 1, destinationTotal: 1, selectedProfileTotal: 1 },
  });
  vm.runInContext(
    "loadPendingSubmissionTasks = async () => self.__fixedPending",
    runtime.context,
  );

  const result = await runtime.hooks.startBatchRunOnce({
    selectedSiteIds: ["P2"],
    config: unattendedConfig({ unattendedMaxTasks: 2 }),
  });
  assert.equal(result.ok, true);
  await settle(40);

  const byProfile = new Map(runtime.hooks.state.tasks.map((item) => [item.profileId, item]));
  assert.deepEqual([...byProfile.keys()].sort(), ["P1", "P2"]);
  assert.equal(byProfile.get("P1")?.status, "submitted_unconfirmed");
  assert.equal(byProfile.get("P1")?.executionPhase, "manual_review");
  assert.ok(runtime.hooks.state.parkedTaskIds.has(previous.id));
  assert.equal(
    runtime.mock.calls.tabsCreate.length,
    1,
    "the inherited uncertain Profile must remain manual while the selected Profile runs",
  );
  assert.equal(runtime.mock.calls.tabsCreate[0].url, candidate.url);
  assert.equal(byProfile.get("P2")?.status, "running");

  const indexes = runtime.hooks.state.tasks.map((item) => item.index);
  const groupIndexes = runtime.hooks.state.tasks.map((item) => item.destinationGroupIndex);
  assert.equal(new Set(indexes).size, 2, "new task indexes must not collide with inherited indexes");
  assert.equal(new Set(groupIndexes).size, 2, "destination group indexes must not collide");
  const persisted = runtime.mock.storageData.activeBatchRun;
  const persistedDestinations = new Map(
    persisted.destinations.map((row) => [Number(row[0]), row[1]]),
  );
  for (const row of persisted.tasks) {
    const expectedDestination = row[2] === "P1" ? previous.destinationKey : candidate.destinationKey;
    assert.equal(persistedDestinations.get(Number(row[1])), expectedDestination);
  }

  const openTabs = await runtime.mock.chrome.tabs.query({});
  const restarted = await loadRuntime({
    storage: runtime.mock.storageData,
    tabs: openTabs,
  });
  const restoredByProfile = new Map(
    restarted.hooks.state.tasks.map((item) => [item.profileId, item]),
  );
  assert.equal(restoredByProfile.get("P1")?.destinationKey, previous.destinationKey);
  assert.equal(restoredByProfile.get("P2")?.destinationKey, candidate.destinationKey);
  assert.equal(
    restarted.mock.calls.tabsCreate.length,
    0,
    "reloading the persisted run must not submit either Profile again or cross-wire destinations",
  );
  await stopIfNeeded(runtime);
  await stopIfNeeded(restarted);
}

// Starting a later batch keeps the previous manual tab and rebinds it by
// taskId after the task indexes are rebuilt. The old lifecycle is invalidated,
// while the newly selected Profile is the only automatic tab opened.
{
  const previous = task({
    index: 1,
    profileId: "P1",
    status: "needs_manual",
    destinationKey: "previous.example/submit",
  });
  previous.confirmationNonce = "nonce-p1-cross-batch";
  previous.manualTabId = 71;
  previous.manualTabUrl = previous.url;
  const candidate = task({
    index: 1,
    profileId: "P2",
    status: "pending",
    destinationKey: "next.example/submit",
  });
  const runtime = await loadRuntime({
    storage: batchStorage({
      status: "waiting_manual",
      tasks: [previous],
      parkedTaskIds: [previous.id],
      config: unattendedConfig({ unattendedMaxManualTabs: 2 }),
    }),
    tabs: [{ id: 71, url: previous.url, status: "complete" }],
  });
  const oldEntry = runtime.hooks.state.activeTabs.get(71);
  assert.ok(oldEntry, "the prior manual tab must be restored before the next batch starts");
  oldEntry.runId = 4;
  const oldRunId = oldEntry.runId;
  const oldLifecycleVersion = runtime.hooks.state.lifecycleVersion;
  const oldBatchRunId = runtime.hooks.state.runId;
  let releaseOldEvidence;
  const oldEvidenceHeld = new Promise((resolvePromise) => {
    releaseOldEvidence = resolvePromise;
  });
  let oldClassifyStarted;
  const oldClassifyEntered = new Promise((resolvePromise) => {
    oldClassifyStarted = resolvePromise;
  });
  runtime.mock.setTabMessageHandler(async (_tabId, message) => {
    if (message.action === "classifySubmitEvidence") {
      oldClassifyStarted();
      await oldEvidenceHeld;
      return { matched: false, evidence: "" };
    }
    if (message.action === "submitFilledForm") {
      throw new Error("the old batch must not submit after rebinding");
    }
    return { ok: true };
  });
  oldEntry.slotActive = true;
  previous.status = "running";
  const oldSubmitPromise = runtime.hooks.tryAutoSubmitFilledForm(
    71,
    { projectKey: "P1", brandName: "P1", targetDomain: "" },
    { id: "P1", name: "P1" },
    "directory",
  );
  await oldClassifyEntered;
  oldEntry.slotActive = false;
  previous.status = "needs_manual";
  runtime.context.__fixedPending = clone({
    tasks: [candidate],
    groups: [],
    selectedProfileIds: ["P2"],
    meta: { total: 1, destinationTotal: 1, selectedProfileTotal: 1 },
  });
  vm.runInContext(
    "loadPendingSubmissionTasks = async () => self.__fixedPending",
    runtime.context,
  );

  const result = await runtime.hooks.startBatchRunOnce({
    selectedSiteIds: ["P2"],
    config: unattendedConfig({ unattendedMaxManualTabs: 2 }),
  });
  assert.equal(result.ok, true);
  await settle(40);
  const inherited = runtime.hooks.state.tasks.find((item) => item.id === previous.id);
  const rebound = runtime.hooks.state.activeTabs.get(71);
  assert.ok(inherited);
  assert.ok(rebound, "the old manual tab must remain owned by the new batch");
  assert.equal(rebound.taskId, previous.id, "the old tab must be rebound by taskId");
  assert.equal(rebound.taskIndex, inherited.index, "the old tab must follow the rebuilt task index");
  assert.equal(inherited.manualTabId, 71, "the rebinding tab id must survive in the task object");
  assert.ok(
    runtime.hooks.state.runId !== oldBatchRunId ||
      runtime.hooks.state.lifecycleVersion > oldLifecycleVersion ||
      rebound.runId > oldRunId,
    "the previous batch lifecycle must be invalidated before the new batch runs",
  );
  assert.equal(runtime.mock.calls.tabsRemove.length, 0, "starting a new batch must not close the old manual tab");
  assert.equal(runtime.mock.calls.tabsUpdate.length, 0, "rebinding must not navigate the old manual tab");
  assert.equal(runtime.mock.tabMap.has(71), true);
  const persistedInherited = runtime.mock.storageData.activeBatchRun.tasks.find((row) => row[2] === "P1");
  assert.equal(persistedInherited?.[25], 71, "manualTabId must persist in tuple field 25");
  const reboundRuntimeState = await runtime.hooks.getRuntimeState();
  assert.ok(reboundRuntimeState.parkedTasks.length >= 1);
  for (const parked of reboundRuntimeState.parkedTasks) {
    assert.equal(parked.runId, runtime.hooks.state.runId, "sidebar parked tasks must carry the current batch runId");
    assert.equal(parked.taskId, parked.id, "sidebar parked tasks must carry their canonical taskId");
    assert.ok(parked.confirmationNonce, "sidebar parked tasks must carry a confirmation nonce");
  }
  const reboundParked = reboundRuntimeState.parkedTasks.find((item) => item.taskId === previous.id);
  assert.equal(reboundParked?.confirmationNonce, inherited.confirmationNonce);
  assert.equal(runtime.mock.calls.tabsCreate.length, 1);
  assert.equal(runtime.mock.calls.tabsCreate[0].url, candidate.url);
  releaseOldEvidence();
  await assert.rejects(oldSubmitPromise, /stale agent run/);
  assert.equal(
    runtime.mock.calls.sendMessage.filter((item) => item.message?.action === "submitFilledForm").length,
    0,
    "an async action from the previous batch must not submit after tab rebinding",
  );
  await stopIfNeeded(runtime);
}

// Worker restart rebinds a persisted manual task to its existing tab without
// closing or navigating that tab.
{
  const manual = task({
    index: 1,
    profileId: "P1",
    status: "filled",
    destinationKey: "manual.example/submit",
  });
  manual.confirmationNonce = "nonce-restart-manual";
  manual.manualTabId = 91;
  manual.manualTabUrl = manual.url;
  const runtime = await loadRuntime({
    storage: batchStorage({
      status: "waiting_manual",
      tasks: [manual],
      parkedTaskIds: [manual.id],
      config: unattendedConfig({ unattendedMaxManualTabs: 2 }),
    }),
    tabs: [{ id: 91, url: manual.url, status: "complete" }],
  });
  assert.equal(runtime.mock.calls.tabsRemove.length, 0);
  const entry = runtime.hooks.state.activeTabs.get(91);
  assert.equal(entry?.taskId, manual.id);
  assert.equal(entry?.slotActive, false);
  assert.equal(runtime.mock.tabMap.has(91), true);
  assert.equal(runtime.hooks.state.tasks[0]?.manualTabId, 91);
  await stopIfNeeded(runtime);
}

// When two Profiles share one host, persisted manualTabId is the only safe
// binding; destination-only fallback must not swap their tabs.
{
  const first = task({ index: 1, profileId: "P1", status: "needs_captcha", destinationKey: "same.example/submit" });
  const second = task({ index: 2, profileId: "P2", status: "filled", destinationKey: "same.example/submit" });
  first.manualTabId = 91;
  second.manualTabId = 92;
  first.manualTabUrl = first.url;
  second.manualTabUrl = second.url;
  const runtime = await loadRuntime({
    storage: batchStorage({
      status: "waiting_manual",
      tasks: [first, second],
      parkedTaskIds: [first.id, second.id],
      config: unattendedConfig({ unattendedMaxManualTabs: 2 }),
    }),
    tabs: [
      { id: 92, url: second.url, status: "complete" },
      { id: 91, url: first.url, status: "complete" },
    ],
  });
  assert.equal(runtime.mock.calls.tabsRemove.length, 0);
  assert.equal(runtime.mock.calls.tabsUpdate.length, 0);
  assert.equal(runtime.hooks.state.activeTabs.get(91)?.taskId, first.id);
  assert.equal(runtime.hooks.state.activeTabs.get(92)?.taskId, second.id);
  assert.equal(runtime.hooks.state.tasks.find((item) => item.id === first.id)?.manualTabId, 91);
  assert.equal(runtime.hooks.state.tasks.find((item) => item.id === second.id)?.manualTabId, 92);
  await stopIfNeeded(runtime);
}

// A stale slot marker on a completed task must not turn the successful task
// back into a manual review item during recovery.
{
  const completed = task({ index: 1, profileId: "P1", status: "ok", destinationKey: "done.example/submit" });
  completed.manualTabId = 93;
  completed.manualTabUrl = completed.url;
  const runtime = await loadRuntime({
    storage: batchStorage({
      status: "waiting_manual",
      tasks: [completed],
      parkedTaskIds: [completed.id],
      config: unattendedConfig({ unattendedMaxManualTabs: 2 }),
    }),
    tabs: [{ id: 93, url: completed.url, status: "complete" }],
  });
  assert.equal(runtime.hooks.state.tasks[0]?.status, "ok");
  assert.equal(runtime.hooks.state.activeTabs.get(93)?.taskId, completed.id);
  assert.equal(runtime.hooks.state.activeTabs.get(93)?.slotActive, false);
  assert.equal(runtime.mock.calls.tabsRemove.length, 0);
  await stopIfNeeded(runtime);
}

// A stale submission-evidence response must not cross the lifecycle boundary
// and send a submit action after the entry has been parked or invalidated.
{
  const runtime = await loadRuntime({
    tabs: [{ id: 41, url: "https://example.com/submit", status: "complete" }],
  });
  const current = task({ index: 1, profileId: "P1", status: "running" });
  const entry = {
    taskIndex: current.index,
    taskId: current.id,
    runId: 0,
    slotActive: true,
    timeoutId: null,
  };
  runtime.hooks.state.running = true;
  runtime.hooks.state.stopped = false;
  runtime.hooks.state.paused = false;
  runtime.hooks.state.tasks = [current];
  runtime.hooks.state.activeTabs = new Map([[41, entry]]);

  let releaseEvidence;
  const evidenceHeld = new Promise((resolvePromise) => {
    releaseEvidence = resolvePromise;
  });
  let classifyStarted;
  const classifyEntered = new Promise((resolvePromise) => {
    classifyStarted = resolvePromise;
  });
  runtime.mock.setTabMessageHandler(async (_tabId, message) => {
    if (message.action === "classifySubmitEvidence") {
      classifyStarted();
      await evidenceHeld;
      return { matched: false, evidence: "" };
    }
    if (message.action === "submitFilledForm") {
      throw new Error("stale run must not send submitFilledForm");
    }
    return { ok: true };
  });

  const submitPromise = runtime.hooks.tryAutoSubmitFilledForm(
    41,
    { projectKey: "P1", brandName: "P1", targetDomain: "" },
    { id: "P1", name: "P1" },
    "directory",
  );
  await classifyEntered;
  entry.runId += 1;
  entry.slotActive = false;
  releaseEvidence();
  await assert.rejects(submitPromise, /stale agent run/);
  assert.equal(
    runtime.mock.calls.sendMessage.filter((item) => item.message?.action === "submitFilledForm").length,
    0,
    "an invalidated entry must never send submitFilledForm after awaiting evidence",
  );
  await stopIfNeeded(runtime);
}

// Pausing or stopping a run must gate the queue before any new tab is created.
for (const action of ["pauseBatchRun", "stopBatchRun"]) {
  const current = task({ index: 1, profileId: "P1", status: "pending" });
  const runtime = await loadRuntime();
  runtime.hooks.state.runId = `run-${action}`;
  runtime.hooks.state.running = true;
  runtime.hooks.state.paused = false;
  runtime.hooks.state.stopped = false;
  runtime.hooks.state.config = unattendedConfig();
  runtime.hooks.state.tasks = [current];
  runtime.hooks.state.groups = [{ key: current.destinationKey, url: current.url, domain: current.domain, tasks: [current] }];
  runtime.hooks.state.queue = [...runtime.hooks.state.groups];
  await runtime.hooks.replaceActiveBatchRun({
    ...batchStorage({ tasks: [current], config: runtime.hooks.state.config }).activeBatchRun,
    runId: runtime.hooks.state.runId,
  });
  await runtime.hooks[action]();
  await runtime.hooks.processQueue();
  assert.equal(runtime.mock.calls.tabsCreate.length, 0, `${action} must prevent later queue work from opening tabs`);
  await stopIfNeeded(runtime);
}

// Re-arming a watchdog must preserve the original absolute deadline instead of pushing it out.
{
  const now = 20_000_000;
  const deadline = new realDate(now + 60 * 60 * 1000).toISOString();
  const runtime = await loadRuntime({
    now,
    storage: batchStorage({
      status: "running",
      tasks: [task({ index: 1, profileId: "P1", status: "needs_manual" })],
      parkedTaskIds: ["example.com/submit::P1"],
      runDeadlineAt: deadline,
    }),
  });
  runtime.hooks.state.running = true;
  runtime.hooks.state.paused = false;
  runtime.hooks.state.stopped = false;
  const watchdog = runtime.hooks.ensureUnattendedWatchdog || runtime.hooks.scheduleUnattendedWatchdog || runtime.hooks.armUnattendedWatchdog || runtime.hooks.watchdog;
  assert.equal(typeof watchdog, "function", "background must expose a persistent unattended watchdog scheduler");
  const before = runtime.mock.storageData.activeBatchRun?.unattendedState?.runDeadlineAt;
  await watchdog();
  await watchdog();
  const after = runtime.mock.storageData.activeBatchRun?.unattendedState?.runDeadlineAt;
  assert.equal(after, before, "repeated watchdog setup must not postpone the persisted deadline");
  const creates = runtime.mock.calls.alarmsCreate.filter((item) => item.name === "externallink-unattended-watchdog");
  if (creates.length > 1) {
    const firstSchedule = JSON.stringify(creates[0].info);
    assert.ok(
      creates.every((item) => JSON.stringify(item.info) === firstSchedule),
      "duplicate watchdog alarm calls must target the same schedule",
    );
  }
  await stopIfNeeded(runtime);
}

console.log("unattended runtime tests passed");

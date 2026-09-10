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
  ];
}

function unattendedConfig(extra = {}) {
  return {
    unattended: true,
    unattendedMaxHours: 8,
    unattendedMaxTasks: 100,
    unattendedMaxAgentCalls: 200,
    unattendedMaxConsecutiveFailures: 5,
    unattendedMaxManualTabs: 2,
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
    maxManualTabs: config.unattendedMaxManualTabs ?? 2,
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

// Manual pages are bounded, while every overflow remains in the durable TODO list.
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
  assert.equal(openManualTabs.length, 2, "unattended mode must keep at most two manual tabs open");
  assert.deepEqual(
    [...runtime.hooks.state.parkedTaskIds].sort(),
    todoTasks.map((item) => item.id).sort(),
    "closing an overflow manual tab must preserve its task as a TODO",
  );
  assert.deepEqual(
    [...runtime.hooks.state.unattended.manualTodoIds],
    [todoTasks[0].id],
    "the overflow page must be retained in the unattended manual TODO list",
  );
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

// ExternalLink Extension - Background Orchestrator
"use strict";

importScripts(
  "lib/profiles.js",
  "lib/queue.js",
  "lib/playbooks.js",
  "lib/batch-controls.js",
  "lib/scheduler.js",
  "lib/submission-timeline.js",
  "lib/backup.js",
  "lib/cloud-sync.js",
  "lib/url-library.js",
  "lib/opportunity-score.js",
  "lib/context-menu.js",
  "lib/automation-ledger.js",
);

let state = {
  running: false,
  tasks: [],
  config: null,
  queue: [],
  groups: [],
  activeTabs: new Map(), // tabId -> { taskIndex, redirectCount }
  parkedTaskIds: new Set(),
  profileConfigs: {},
  runId: "",
  concurrency: 1,
  paused: false,
  stopped: false,
  lifecycleVersion: 0,
  automationFinalStatus: "",
};

const PAGE_LOAD_TIMEOUT_MS = 45000;
const CONTENT_READY_TIMEOUT_MS = 30000;
const CONTENT_READY_POLL_MS = 500;
const CONTENT_READY_STABLE_CHECKS = self.ExtLinkBatchControls.REQUIRED_STABLE_CHECKS || 2;
const EXECUTION_TIMEOUT_MS = 180000;
const POST_SUCCESS_CLOSE_DELAY_MS = 2000;
const DEFAULT_MANUAL_WAIT_SEC = 120;
const MAX_AGENT_LOOPS = 8;
const AGENT_ACTION_SETTLE_MS = 600;
const SNAPSHOT_RETRY_ATTEMPTS = 5;
const SNAPSHOT_RETRY_MS = 700;
const MAX_FILL_ROUNDS = 1;
const MAX_VALIDATION_RETRIES = 2;
const AUTO_FILL_DEBOUNCE_MS = 900;
const MAX_SUBMISSION_MEDIA_BYTES = 6 * 1024 * 1024;
const SUBMISSION_SCHEMA_VERSION = self.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION || 2;
const DOMAIN_METRICS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DOMAIN_METRICS_BATCH = 20;
const DOMAIN_METRICS_CACHE_LIMIT = 5000;
const COMMENT_CACHE_TTL_MS = 30 * 60 * 1000;
const COMMENT_CACHE_LIMIT = 60;
const LINK_MONITOR_ALARM = "externallink-link-monitor";
const DEFAULT_LINK_MONITOR_MINUTES = 24 * 60;
const CLOUD_SYNC_DEBOUNCE_MS = 800;
const CLOUD_SYNC_RETRY_DELAYS_MS = [1000, 5000, 15000, 60000];
const BATCH_LOG_STORAGE_KEY = "batchRunLog";
const BATCH_LOG_LIMIT = 400;
const BATCH_TASK_WINDOW_SIZE = 180;
const AUTOMATION_LEDGER_KEY = "automationRunLedger";
const AUTOMATION_OUTBOX_KEY = "automationEventOutbox";
const AUTOMATION_OUTBOX_ALARM = "externallink-automation-outbox";
const AUTOMATION_OUTBOX_LIMIT = 3000;
const VISION_FALLBACK_AFTER_FAILURES = 1;

const commentDraftCache = new Map();

const autoFillTimers = new Map();
const autoFillInProgress = new Set();
let sidePanelOpen = false;
let cloudSyncTimer = null;
let cloudSyncFlushPromise = null;
let cloudSyncMute = false;
const cloudSyncPendingKeys = new Set();
const runActiveBatchWrite = self.ExtLinkBatchControls.createSerialExecutor();
const cloudSyncIgnoredValues = new Map();
let cloudSyncRetryAttempt = 0;
let batchLogWritePromise = Promise.resolve();
let pendingBatchLogEntries = [];
let batchLogFlushTimer = null;
let processQueuePromise = null;
let startBatchPromise = null;
let automationCloudWritePromise = Promise.resolve();
let automationLedgerWritePromise = Promise.resolve();
let initializationPromise = restoreActiveBatchRun()
  .catch((err) => {
    log(`恢复上次批次失败: ${err.message}`, "warn");
  })
  .then(() => flushAutomationOutbox().catch((err) => {
    log(`自动化记录补传失败: ${err.message}`, "warn");
  }));

self.addEventListener?.("unhandledrejection", (event) => {
  const reason = event?.reason;
  log(`未处理异步异常: ${reason?.message || String(reason || "unknown")}`, "err", {
    event: "unhandled_rejection",
    stack: reason?.stack,
  });
});
self.addEventListener?.("error", (event) => {
  log(`后台脚本异常: ${event?.message || "unknown"}`, "err", {
    event: "worker_error",
    stack: event?.error?.stack,
  });
});

chrome.runtime.onInstalled.addListener(() => {
  self.ExtLinkContextMenu.installActionSettingsMenu(chrome);
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  configureScheduledChecks().catch(() => {});
  chrome.alarms.create(AUTOMATION_OUTBOX_ALARM, { periodInMinutes: 5 });
});

chrome.contextMenus?.onClicked.addListener((info) => {
  self.ExtLinkContextMenu.handleActionMenuClick(chrome, info);
});

chrome.runtime.onStartup.addListener(() => {
  configureScheduledChecks().catch(() => {});
  chrome.alarms.create(AUTOMATION_OUTBOX_ALARM, { periodInMinutes: 5 });
  flushAutomationOutbox().catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || cloudSyncMute) return;
  const keys = self.ExtLinkCloudSync.stateKeysFromChanges(changes).filter((key) => {
    if (!cloudSyncIgnoredValues.has(key)) return true;
    const pulledValue = cloudSyncIgnoredValues.get(key);
    cloudSyncIgnoredValues.delete(key);
    return JSON.stringify(changes[key]?.newValue) !== pulledValue;
  });
  if (!keys.length) return;
  for (const key of keys) cloudSyncPendingKeys.add(key);
  scheduleCloudSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === LINK_MONITOR_ALARM) {
    runLinkMonitor({ notify: true }).catch(() => {});
  }
  if (alarm.name === AUTOMATION_OUTBOX_ALARM) {
    flushAutomationOutbox().catch(() => {});
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  if (changeInfo.status === "loading") {
    entry.tabLoadComplete = false;
    entry.lastContentReady = null;
    entry.readyProbe = null;
    return;
  }
  if (changeInfo.status !== "complete") return;
  entry.tabLoadComplete = true;
  if (entry.lastContentReady) {
    handleContentReady(tab || { id: tabId }, entry.lastContentReady).catch((err) =>
      log(`页面就绪处理失败: ${err.message}`, "err", {
        event: "content_ready_failed",
        stack: err.stack,
      }),
    );
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case "sidepanelDetect":
      handleSidepanelDetect(msg.tabId)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "prescanPage":
      handlePrescanPage(msg.tabId)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "generateCommentPreview":
      handleGenerateCommentPreview(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "sidepanelFill":
      handleSidepanelFill(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "fetchSubmissionMedia":
      fetchSubmissionMedia(msg.url)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "fetchCloudSubmissionMedia":
      fetchCloudSubmissionMedia(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "listCloudSubmissionMedia":
      listCloudSubmissionMedia()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message, assets: [] }));
      return true;
    case "generateCommentDrafts":
      generateCommentDrafts(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, drafts: [], error: err.message }));
      return true;
    case "getActiveFillConfig":
      getActiveFillConfig()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "getTargetGateState":
      getTargetGateState()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "saveTargetFilters":
      saveTargetFilters(msg.filters)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "updateDomainBlacklist":
      updateDomainBlacklist(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "getDomainMetrics":
      getDomainMetrics(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message, results: {} }));
      return true;
    case "sidepanelOpened":
      sidePanelOpen = true;
      break;
    case "sidepanelClosed":
      sidePanelOpen = false;
      for (const timer of autoFillTimers.values()) clearTimeout(timer);
      autoFillTimers.clear();
      break;
    case "requestAutoFill":
      handleRequestAutoFill(msg, sender)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "getSubmissionQueue":
      getSubmissionQueueState(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message, tasks: [], index: 0 }));
      return true;
    case "getSiteAnnotation":
      getSiteAnnotation(msg.url)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "markSubmissionSite":
      markSubmissionSite(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "addToUrlList":
      addToUrlList(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "removeFromSubmissionQueue":
      removeFromSubmissionQueue(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "listSiteAnnotations":
      listSiteAnnotations()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message, items: [] }));
      return true;
    case "clearSiteAnnotation":
      clearSiteAnnotation(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "getLibraryManagerState":
      getLibraryManagerState(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message, items: [] }));
      return true;
    case "addSubmissionTimelineEvent":
      addSubmissionTimelineEvent(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "updateSubmissionTimelineEvent":
      updateSubmissionTimelineEvent(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "removeSubmissionTimelineEvent":
      removeSubmissionTimelineEvent(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "pinLibraryUrl":
      pinLibraryUrl(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "exportSubmissionData":
      exportSubmissionData()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "importSubmissionData":
      importSubmissionData(msg.data)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "cloudSyncStatus":
      getCloudSyncStatus()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "cloudSyncConnect":
      connectCloudSync(msg.config)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "cloudSyncMigrate":
      migrateLocalStateToCloud()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "cloudSyncPull":
      pullCloudState()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "cloudSyncPush":
      pushCloudState()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "cloudAiExtractSite":
      callCloudAgent("/extract-site", msg.payload || {})
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "cloudAiGenerateSite":
      callCloudAgent("/generate-site", msg.payload || {})
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "getLinkMonitorState":
      getLinkMonitorState()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "runLinkMonitor":
      runLinkMonitor({ notify: false, force: true })
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "saveLinkMonitorSchedule":
      saveLinkMonitorSchedule(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "advanceSubmission":
      advanceSubmissionQueue(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "start":
      startBatchRunOnce(msg)
        .then(sendResponse)
        .catch((err) => {
          log(`批次启动失败: ${err.message}`, "err", { event: "run_start_failed", stack: err.stack });
          sendResponse({ ok: false, error: err.message });
        });
      return true;
    case "getBatchLog":
      chrome.storage.local
        .get(BATCH_LOG_STORAGE_KEY)
        .then((stored) => sendResponse({ ok: true, log: stored[BATCH_LOG_STORAGE_KEY] || null }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "stop":
      stopBatchRun()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "pause":
      pauseBatchRun()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "resume":
      resumeBatchRun()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "contentReady":
      if (sender.tab) {
        handleContentReady(sender.tab, msg).catch((err) =>
          log(`页面就绪处理失败: ${err.message}`, "err", {
            event: "content_ready_failed",
            domain: sender.tab?.url ? self.ExtLinkQueue.extractDomain(sender.tab.url) : "",
            stack: err.stack,
          }),
        );
      }
      break;
    case "captchaResolved":
      if (sender.tab?.id) {
        resumeAfterCaptcha(sender.tab.id, msg).catch((err) =>
          log(`验证码后恢复失败: ${err.message}`, "err", { event: "captcha_resume_failed", stack: err.stack }),
        );
      }
      break;
    case "manualSubmit":
      handleManualSubmit(msg).catch((err) =>
        log(`人工继续失败: ${err.message}`, "err", { event: "manual_resume_failed", stack: err.stack }),
      );
      break;
    case "manualSkip":
      Promise.resolve(handleManualSkip(msg)).catch((err) =>
        log(`人工跳过失败: ${err.message}`, "err", { event: "manual_skip_failed", stack: err.stack }),
      );
      break;
    case "manualContinue":
      handleManualSubmit(msg).catch((err) =>
        log(`人工继续失败: ${err.message}`, "err", { event: "manual_continue_failed", stack: err.stack }),
      );
      break;
    case "log":
      if (sender.tab?.id) {
        const entry = state.activeTabs.get(sender.tab.id);
        const task = entry ? state.tasks.find((item) => item.index === entry.taskIndex) : null;
        log(msg.msg, msg.cls, {
          event: msg.event || "content_step",
          taskIndex: task?.index,
          taskId: task?.id,
          domain: task?.domain || (sender.tab.url ? self.ExtLinkQueue.extractDomain(sender.tab.url) : ""),
          profileId: task?.profileId,
        });
      }
      break;
    case "confirmSubmissionSuccess":
      if (sender.tab?.id) {
        sendResponse({ ok: false, error: "人工成功确认只能从扩展侧栏发起" });
        return true;
      }
      confirmSubmissionSuccess(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "getState":
      getRuntimeState()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
  }
});

async function fetchSubmissionMedia(rawUrl) {
  const url = new URL(String(rawUrl || ""));
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("只允许下载 HTTP(S) 图片");
  }

  const response = await fetch(url.href, {
    cache: "force-cache",
    credentials: "omit",
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`图片下载失败: HTTP ${response.status}`);

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_SUBMISSION_MEDIA_BYTES) {
    throw new Error("图片超过 6MB，无法自动上传");
  }

  const blob = await response.blob();
  if (blob.size > MAX_SUBMISSION_MEDIA_BYTES) {
    throw new Error("图片超过 6MB，无法自动上传");
  }
  const contentType = String(blob.type || response.headers.get("content-type") || "");
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("目标地址返回的不是图片");
  }

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return {
    ok: true,
    dataUrl: `data:${contentType};base64,${btoa(binary)}`,
    contentType,
    byteLength: bytes.length,
  };
}

// ─── Cloud data source (Neon + Worker + R2) ───
async function getCloudConfig() {
  const stored = await chrome.storage.local.get([self.ExtLinkCloudSync.CONFIG_KEY]);
  return self.ExtLinkCloudSync.normalizeConfig(stored[self.ExtLinkCloudSync.CONFIG_KEY] || {});
}

async function saveCloudConfig(config) {
  await chrome.storage.local.set({ [self.ExtLinkCloudSync.CONFIG_KEY]: config });
  return config;
}

function cloudUrl(config, pathname) {
  const url = new URL(`${config.endpoint}${pathname}`);
  url.searchParams.set("workspace", config.workspaceId);
  return url.href;
}

async function cloudRequest(pathname, options = {}, configOverride = null) {
  const config = configOverride || (await getCloudConfig());
  if (!config.configured) throw new Error("云端数据中心尚未连接，请先在设置中填写 Worker 地址和设备密钥");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${config.accessToken}`);
  if (options.body !== undefined && !headers.has("Content-Type") && !(options.body instanceof ArrayBuffer)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(cloudUrl(config, pathname), {
    ...options,
    headers,
    body:
      options.body !== undefined && typeof options.body !== "string" && !(options.body instanceof ArrayBuffer)
        ? JSON.stringify(options.body)
        : options.body,
  });
  if (options.raw === true) {
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `云端请求失败: HTTP ${response.status}`);
    }
    return response;
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || `云端请求失败: HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function automationRunSummary(status = "running") {
  return {
    runId: state.runId,
    status,
    selectedProfileIds: state.tasks.length
      ? [...new Set(state.tasks.map((task) => task.profileId).filter(Boolean))]
      : [],
    config: {
      fillOnly: state.config?.fillOnly === true,
      concurrency: state.concurrency,
      multimodalFallback: true,
    },
    taskTotal: state.tasks.length,
    destinationTotal: state.groups.length,
    startedAt: state.startedAt || new Date().toISOString(),
    finishedAt: ["finished", "stopped", "failed"].includes(status) ? new Date().toISOString() : null,
  };
}

function automationEventForTask(task, event = {}) {
  const at = event.at || new Date().toISOString();
  const taskId = String(task?.id || event.taskId || "run-event");
  const attempt = Math.max(1, Number(event.attempt || task?._attempt || 1));
  return {
    id: event.id || `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
    at,
    runId: state.runId,
    taskId,
    attempt,
    attemptId: `${state.runId}:${taskId}:a${attempt}`,
    destinationKey: task?.destinationKey || task?.destinationGroupKey || event.destinationKey || "",
    profileId: task?.profileId || event.profileId || "",
    ...event,
  };
}

function queueAutomationOutboxRemoval(eventId) {
  const removal = automationLedgerWritePromise.catch(() => null).then(async () => {
    const stored = await chrome.storage.local.get(AUTOMATION_OUTBOX_KEY);
    const current = Array.isArray(stored[AUTOMATION_OUTBOX_KEY]) ? stored[AUTOMATION_OUTBOX_KEY] : [];
    const next = current.filter((item) => item?.event?.id !== eventId);
    if (next.length !== current.length) {
      await chrome.storage.local.set({ [AUTOMATION_OUTBOX_KEY]: next });
    }
    return next;
  });
  automationLedgerWritePromise = removal;
  return removal;
}

async function flushAutomationOutbox() {
  const stored = await chrome.storage.local.get(AUTOMATION_OUTBOX_KEY);
  const pending = Array.isArray(stored[AUTOMATION_OUTBOX_KEY])
    ? stored[AUTOMATION_OUTBOX_KEY].slice(0, AUTOMATION_OUTBOX_LIMIT)
    : [];
  for (const item of pending) {
    if (!item?.event?.id || !item?.run) continue;
    try {
      await cloudRequest("/v1/automation/events", {
        method: "POST",
        body: { run: item.run, event: item.event },
      });
      await queueAutomationOutboxRemoval(item.event.id);
    } catch (err) {
      console.warn("ExternalLink automation outbox replay paused", err?.message || err);
      break;
    }
  }
}

function recordAutomationEvent(task, event = {}, options = {}) {
  if (!state.runId) return Promise.resolve(null);
  const normalized = automationEventForTask(task, event);
  const runId = normalized.runId;
  const runStatus = options.runStatus || (state.stopped ? "stopped" : state.paused ? "paused" : "running");
  const runSummary = { ...automationRunSummary(runStatus), runId };
  const localWrite = automationLedgerWritePromise.catch((err) => {
    console.error("ExternalLink automation ledger recovered after write failure", err?.message || err);
    return null;
  }).then(async () => {
    const stored = await chrome.storage.local.get([AUTOMATION_LEDGER_KEY, AUTOMATION_OUTBOX_KEY]);
    const current = self.ExtLinkAutomationLedger.normalizeLedger(stored[AUTOMATION_LEDGER_KEY]);
    let next = self.ExtLinkAutomationLedger.appendEvent(current, runId, normalized);
    if (options.runStatus) {
      next = self.ExtLinkAutomationLedger.finishRun(next, runId, runStatus, normalized.at);
    }
    const outbox = (Array.isArray(stored[AUTOMATION_OUTBOX_KEY]) ? stored[AUTOMATION_OUTBOX_KEY] : [])
      .filter((item) => item?.event?.id !== normalized.id);
    outbox.push({ run: runSummary, event: normalized });
    await chrome.storage.local.set({
      [AUTOMATION_LEDGER_KEY]: next,
      [AUTOMATION_OUTBOX_KEY]: outbox.slice(-AUTOMATION_OUTBOX_LIMIT),
    });
    return next;
  });
  automationLedgerWritePromise = localWrite;
  const cloudWrite = automationCloudWritePromise
    .then(async () => {
      await localWrite;
      await cloudRequest("/v1/automation/events", {
        method: "POST",
        body: { run: runSummary, event: normalized },
      });
      await queueAutomationOutboxRemoval(normalized.id);
    })
    .catch((err) => {
      console.warn("ExternalLink automation event cloud write failed", err?.message || err);
      return null;
    });
  automationCloudWritePromise = cloudWrite;
  return localWrite.then(async (ledger) => {
    await cloudWrite;
    return ledger;
  });
}

async function startAutomationRunLedger(selectedProfileIds) {
  const stored = await chrome.storage.local.get(AUTOMATION_LEDGER_KEY);
  const startedAt = new Date().toISOString();
  state.startedAt = startedAt;
  const next = self.ExtLinkAutomationLedger.startRun(stored[AUTOMATION_LEDGER_KEY], {
    runId: state.runId,
    selectedProfileIds,
    taskTotal: state.tasks.length,
    destinationTotal: state.groups.length,
    fillOnly: state.config?.fillOnly === true,
    startedAt,
  });
  await chrome.storage.local.set({ [AUTOMATION_LEDGER_KEY]: next });
  await recordAutomationEvent(null, {
    taskId: "run-event",
    type: "run_started",
    status: "running",
    result: `${state.groups.length} destinations / ${state.tasks.length} tasks`,
  });
}

async function finishAutomationRunLedger(status) {
  if (!state.runId) return;
  const runId = state.runId;
  if (state.automationFinalStatus === status) return;
  if (state.automationFinalStatus && ["finished", "stopped", "failed"].includes(state.automationFinalStatus)) return;
  await recordAutomationEvent(null, {
    taskId: "run-event",
    type: `run_${status}`,
    status,
    finishedAt: new Date().toISOString(),
  }, { runStatus: status });
  automationLedgerWritePromise = automationLedgerWritePromise.then(async () => {
    const stored = await chrome.storage.local.get(AUTOMATION_LEDGER_KEY);
    const next = self.ExtLinkAutomationLedger.finishRun(stored[AUTOMATION_LEDGER_KEY], runId, status);
    await chrome.storage.local.set({ [AUTOMATION_LEDGER_KEY]: next });
  });
  await automationLedgerWritePromise;
  await automationCloudWritePromise;
  if (["finished", "stopped", "failed"].includes(status)) state.automationFinalStatus = status;
}

async function updateCloudMetadata(patch) {
  const current = await getCloudConfig();
  const next = { ...current, ...patch };
  delete next.configured;
  return saveCloudConfig(next);
}

async function getCloudSyncStatus() {
  const config = await getCloudConfig();
  if (!config.configured) return { ok: true, connected: false, config };
  try {
    const health = await cloudRequest("/v1/health");
    return { ok: true, connected: true, config: await getCloudConfig(), health };
  } catch (err) {
    await updateCloudMetadata({ lastError: err.message });
    return { ok: true, connected: false, config: await getCloudConfig(), error: err.message };
  }
}

async function connectCloudSync(rawConfig) {
  const config = self.ExtLinkCloudSync.normalizeConfig(rawConfig || {});
  if (!config.configured) throw new Error("请填写有效的 HTTPS Worker 地址和设备密钥");
  await cloudRequest("/v1/health", {}, config);
  const saved = await saveCloudConfig({
    ...config,
    connectedAt: new Date().toISOString(),
    lastError: "",
  });
  return { ok: true, config: saved };
}

async function applyCloudSnapshot(snapshot) {
  const nextState = self.ExtLinkCloudSync.documentsToState(snapshot.documents || {});
  Object.entries(nextState).forEach(([key, value]) => {
    cloudSyncIgnoredValues.set(key, JSON.stringify(value));
  });
  cloudSyncMute = true;
  try {
    await chrome.storage.local.set({
      ...nextState,
      cloudSyncMetadata: {
        revisions: snapshot.revisions || {},
        pulledAt: new Date().toISOString(),
      },
    });
  } finally {
    cloudSyncMute = false;
  }
  return nextState;
}

async function pullCloudState() {
  const snapshot = await cloudRequest("/v1/snapshot");
  const state = await applyCloudSnapshot(snapshot);
  await updateCloudMetadata({ lastPullAt: new Date().toISOString(), lastError: "" });
  return {
    ok: true,
    documentCount: Object.keys(snapshot.documents || {}).length,
    state,
    revisions: snapshot.revisions || {},
  };
}

async function migrateLocalStateToCloud() {
  const storage = await chrome.storage.local.get(self.ExtLinkCloudSync.STATE_DOCUMENT_KEYS);
  const documents = self.ExtLinkCloudSync.stateToDocuments(storage);
  const result = await cloudRequest("/v1/migrate", { method: "POST", body: { documents } });
  const pulled = await pullCloudState();
  await updateCloudMetadata({ migratedAt: new Date().toISOString(), lastError: "" });
  return { ...result, pulledDocuments: pulled.documentCount };
}

async function ensureCloudRevisions() {
  const stored = await chrome.storage.local.get("cloudSyncMetadata");
  const known = stored.cloudSyncMetadata?.revisions;
  if (known && typeof known === "object" && Object.keys(known).length) return { ...known };
  const snapshot = await cloudRequest("/v1/snapshot");
  await chrome.storage.local.set({
    cloudSyncMetadata: { revisions: snapshot.revisions || {}, pulledAt: new Date().toISOString() },
  });
  return { ...(snapshot.revisions || {}) };
}

function scheduleCloudSync(delayMs = CLOUD_SYNC_DEBOUNCE_MS, resetRetry = true) {
  if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
  if (resetRetry) cloudSyncRetryAttempt = 0;
  cloudSyncTimer = setTimeout(() => {
    cloudSyncTimer = null;
    flushCloudState().catch((err) => log(`云端保存失败: ${err.message}`, "warn"));
  }, delayMs);
}

function scheduleCloudSyncRetry() {
  if (!cloudSyncPendingKeys.size) return;
  const index = Math.min(cloudSyncRetryAttempt, CLOUD_SYNC_RETRY_DELAYS_MS.length - 1);
  cloudSyncRetryAttempt += 1;
  scheduleCloudSync(CLOUD_SYNC_RETRY_DELAYS_MS[index], false);
}

async function flushCloudState(keys = null) {
  if (cloudSyncFlushPromise) return cloudSyncFlushPromise;
  cloudSyncFlushPromise = (async () => {
    const config = await getCloudConfig();
    if (!config.configured) return { ok: true, skipped: true };
    const requested = keys || [...cloudSyncPendingKeys];
    const documentKeys = requested.filter((key) => self.ExtLinkCloudSync.STATE_DOCUMENT_KEYS.includes(key));
    if (!documentKeys.length) return { ok: true, skipped: true };
    const revisions = await ensureCloudRevisions();
    const storage = await chrome.storage.local.get(documentKeys);
    const saved = [];
    for (const key of documentKeys) {
      if (!Object.prototype.hasOwnProperty.call(storage, key)) {
        cloudSyncPendingKeys.delete(key);
        continue;
      }
      try {
        const result = await cloudRequest(`/v1/state/${key}`, {
          method: "PUT",
          body: { data: storage[key], revision: revisions[key] || 0 },
        });
        revisions[key] = result.revision;
        cloudSyncPendingKeys.delete(key);
        saved.push(key);
      } catch (err) {
        if (err.status === 409) {
          cloudSyncPendingKeys.delete(key);
          throw new Error(`“${key}”已在其他设备更新，请先从云端回读再继续编辑`);
        }
        throw err;
      }
    }
    await chrome.storage.local.set({
      cloudSyncMetadata: { revisions, pushedAt: new Date().toISOString() },
    });
    await updateCloudMetadata({ lastPushAt: new Date().toISOString(), lastError: "" });
    cloudSyncRetryAttempt = 0;
    return { ok: true, saved };
  })();
  try {
    return await cloudSyncFlushPromise;
  } catch (err) {
    await updateCloudMetadata({ lastError: err.message });
    if (err.status !== 409) scheduleCloudSyncRetry();
    throw err;
  } finally {
    cloudSyncFlushPromise = null;
  }
}

async function pushCloudState() {
  return flushCloudState(self.ExtLinkCloudSync.STATE_DOCUMENT_KEYS);
}

// ─── Target gating: domain blacklist + registration age ───
function normalizeTargetFilters(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const minMonths = Number(source.minDomainAgeMonths);
  const minScore = Number(source.minOpportunityScore);
  return {
    blacklistEnabled: source.blacklistEnabled !== false,
    minDomainAgeMonths: Number.isFinite(minMonths) ? Math.max(0, Math.min(minMonths, 600)) : 0,
    requireKnownDomainAge: source.requireKnownDomainAge === true,
    minOpportunityScore: Number.isFinite(minScore) ? Math.max(0, Math.min(minScore, 100)) : 0,
    showManualFillIcons: source.showManualFillIcons !== false,
    aiComments: source.aiComments !== false,
    aiCommentAllowLink: source.aiCommentAllowLink !== false,
  };
}

async function getTargetFilters() {
  const { targetFilters } = await chrome.storage.local.get("targetFilters");
  return normalizeTargetFilters(targetFilters);
}

async function saveTargetFilters(patch) {
  const current = await getTargetFilters();
  const next = normalizeTargetFilters({ ...current, ...(patch || {}) });
  await chrome.storage.local.set({ targetFilters: next });
  return { ok: true, filters: next };
}

async function updateDomainBlacklist(msg = {}) {
  const stored = await chrome.storage.local.get("domainBlacklist");
  const current = new Set(
    (stored.domainBlacklist || []).map((item) =>
      self.ExtLinkQueue.normalizeBlacklistEntry(item),
    ),
  );

  if (msg.replace) current.clear();
  for (const item of msg.add || []) {
    const entry = String(item || "").trim();
    if (!entry) continue;
    // Preserve the leading dot/wildcard so subdomain rules survive a round trip.
    current.add(
      /^[*.]/.test(entry)
        ? `.${self.ExtLinkQueue.normalizeBlacklistEntry(entry)}`
        : self.ExtLinkQueue.normalizeBlacklistEntry(entry),
    );
  }
  for (const item of msg.remove || []) {
    const normalized = self.ExtLinkQueue.normalizeBlacklistEntry(item);
    current.delete(normalized);
    current.delete(`.${normalized}`);
  }

  const domainBlacklist = [...current].filter(Boolean).sort();
  await chrome.storage.local.set({ domainBlacklist });
  return { ok: true, domainBlacklist };
}

async function getDomainMetrics(msg = {}) {
  const requested = (Array.isArray(msg.domains) ? msg.domains : [msg.domain])
    .map((value) => self.ExtLinkQueue.normalizeBlacklistEntry(value))
    .filter(Boolean);
  const unique = [...new Set(requested)];
  if (!unique.length) return { ok: false, error: "没有可查询的域名", results: {} };

  const { domainMetricsCache } = await chrome.storage.local.get("domainMetricsCache");
  const cache = domainMetricsCache && typeof domainMetricsCache === "object" ? domainMetricsCache : {};
  const now = Date.now();
  const results = {};
  const missing = [];

  for (const domain of unique) {
    const hit = cache[domain];
    if (!msg.refresh && hit && now - (hit.fetchedAt || 0) < DOMAIN_METRICS_TTL_MS) {
      results[domain] = hit;
    } else {
      missing.push(domain);
    }
  }

  let agentError = "";
  for (let offset = 0; offset < missing.length; offset += DOMAIN_METRICS_BATCH) {
    const batch = missing.slice(offset, offset + DOMAIN_METRICS_BATCH);
    try {
      const data = await callCloudAgent("/domain/metrics", { domains: batch });
      for (const entry of data.results || []) {
        const domain = self.ExtLinkQueue.normalizeBlacklistEntry(entry.domain);
        if (!domain) continue;
        const record = {
          domain,
          status: entry.status || "unknown",
          createdAt: entry.createdAt || "",
          expiresAt: entry.expiresAt || "",
          ageMonths: Number.isFinite(Number(entry.ageMonths)) ? Number(entry.ageMonths) : null,
          ageDays: Number.isFinite(Number(entry.ageDays)) ? Number(entry.ageDays) : null,
          message: entry.message || "",
          fetchedAt: now,
        };
        cache[domain] = record;
        results[domain] = record;
      }
    } catch (err) {
      agentError = err.message;
      break;
    }
  }

  await chrome.storage.local.set({ domainMetricsCache: pruneDomainMetricsCache(cache) });
  return {
    ok: !agentError,
    error: agentError,
    results,
    cachedCount: unique.length - missing.length,
    lookedUp: Object.keys(results).length - (unique.length - missing.length),
  };
}

function pruneDomainMetricsCache(cache) {
  const entries = Object.entries(cache || {});
  if (entries.length <= DOMAIN_METRICS_CACHE_LIMIT) return cache;
  entries.sort((a, b) => (b[1]?.fetchedAt || 0) - (a[1]?.fetchedAt || 0));
  return Object.fromEntries(entries.slice(0, DOMAIN_METRICS_CACHE_LIMIT));
}

async function getTargetGateState() {
  const storage = await chrome.storage.local.get([
    "domainBlacklist",
    "targetFilters",
    "domainMetricsCache",
  ]);
  return {
    ok: true,
    filters: normalizeTargetFilters(storage.targetFilters),
    domainBlacklist: storage.domainBlacklist || [],
    metricsCached: Object.keys(storage.domainMetricsCache || {}).length,
  };
}

// ─── Cloud media (R2 → DataTransfer upload injection source) ───
async function binaryResponseToDataUrl(response) {
  const blob = await response.blob();
  if (blob.size > MAX_SUBMISSION_MEDIA_BYTES) throw new Error("云端图片超过 6MB，无法自动上传");
  const contentType = String(blob.type || response.headers.get("content-type") || "");
  if (!contentType.toLowerCase().startsWith("image/")) throw new Error("云端媒体不是图片");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return { dataUrl: `data:${contentType};base64,${btoa(binary)}`, contentType, byteLength: bytes.length };
}

async function fetchCloudSubmissionMedia(msg = {}) {
  const assetId = self.ExtLinkCloudSync.cloudMediaAssetId(msg.ref || msg.assetId);
  if (!assetId) throw new Error("无效的云端媒体引用");
  const response = await cloudRequest(`/v1/media/${encodeURIComponent(assetId)}`, { raw: true });
  const media = await binaryResponseToDataUrl(response);
  return { ok: true, ...media, name: msg.name || assetId, source: "cloud" };
}

async function listCloudSubmissionMedia() {
  const response = await cloudRequest("/v1/media");
  return { ok: true, assets: response.assets || [] };
}

// ─── AI comment drafts ───
async function generateCommentDrafts(msg = {}) {
  const filters = await getTargetFilters();
  if (filters.aiComments === false) {
    return { ok: false, status: "disabled", drafts: [], error: "AI 评论生成已在设置中关闭" };
  }

  const pageUrl = String(msg.pageUrl || "");
  const config = msg.config && typeof msg.config === "object" ? msg.config : {};
  const cacheKey = `${config.projectKey || ""}|${pageUrl}|${msg.count || 1}`;
  const cached = commentDraftCache.get(cacheKey);
  if (cached && !msg.refresh && Date.now() - cached.at < COMMENT_CACHE_TTL_MS) {
    return { ...cached.value, cached: true };
  }

  let data;
  try {
    data = await callCloudAgent("/comment", {
      pageUrl,
      pageTitle: String(msg.pageTitle || ""),
      pageText: String(msg.pageText || ""),
      language: msg.language || config.language || "auto",
      count: Math.max(1, Math.min(Number(msg.count) || 1, 5)),
      maxChars: Number(msg.maxChars) || 700,
      allowLink: msg.allowLink !== false && filters.aiCommentAllowLink !== false,
      config: {
        brandName: config.brandName || "",
        targetDomain: config.targetDomain || "",
        anchorRules: config.anchorRules || {},
        blogRules: config.blogRules || {},
        targetAudience: config.targetAudience || "",
        valueProposition: config.valueProposition || "",
        useCases: config.useCases || [],
        sellablePoints: config.sellablePoints || [],
        avoidContent: config.avoidContent || [],
      },
    });
  } catch (err) {
    return { ok: false, status: "error", drafts: [], error: err.message };
  }

  const value = {
    ok: data.status === "ok" && (data.drafts || []).length > 0,
    status: data.status || "error",
    drafts: data.drafts || [],
    reason: data.reason || "",
    rejected: data.rejected || [],
  };
  if (value.ok) commentDraftCache.set(cacheKey, { at: Date.now(), value });
  if (commentDraftCache.size > COMMENT_CACHE_LIMIT) {
    commentDraftCache.delete(commentDraftCache.keys().next().value);
  }
  return value;
}

// ─── Config for in-page manual fill icons ───
async function getActiveFillConfig() {
  const storage = await chrome.storage.local.get([
    "siteProfiles",
    "activeSiteId",
    "cfgEmail",
    "cfgName",
    "targetFilters",
  ]);
  const profile = self.ExtLinkProfiles.getActiveProfile(storage);
  const filters = normalizeTargetFilters(storage.targetFilters);
  if (!self.ExtLinkProfiles.profileConfigured(profile)) {
    return { ok: false, error: "未配置网站资料", filters };
  }
  const config = self.ExtLinkProfiles.buildAgentConfigFromProfile(profile, {
    email: storage.cfgEmail,
    username: storage.cfgName,
    fillOnly: true,
  });
  config.learnedFieldMappings = profile.learnedFieldMappings || {};
  return { ok: true, config, profileId: profile.id, profileName: profile.name || profile.id, filters };
}

function startBatchRunOnce(msg) {
  if (startBatchPromise) {
    return Promise.resolve({ ok: false, error: "批次正在启动，请勿重复点击" });
  }
  startBatchPromise = startBatchRun(msg).finally(() => {
    startBatchPromise = null;
  });
  return startBatchPromise;
}

async function pauseBatchRun() {
  await initializationPromise;
  if (!state.running || state.stopped) {
    return { ok: false, error: "当前没有可暂停的批量任务" };
  }
  if (state.paused) return { ok: true, status: "paused" };
  state.paused = true;
  for (const entry of state.activeTabs.values()) {
    if (entry.slotActive !== false) entry.pauseRequested = true;
  }
  await persistActiveBatchStatus("paused", { pausedAt: new Date().toISOString() });
  await recordAutomationEvent(null, { taskId: "run-event", type: "run_paused", status: "paused" }, { runStatus: "paused" });
  broadcastStatus();
  log("批量已暂停；队列和人工页签均保留", "warn", { event: "run_paused" });
  return { ok: true, status: "paused" };
}

async function stopBatchRun() {
  await initializationPromise;
  state.lifecycleVersion += 1;
  state.stopped = true;
  state.paused = false;
  state.running = false;
  closeAutomatedTabs();
  await markActiveBatchStopped();
  await finishAutomationRunLedger("stopped");
  broadcastStatus();
  log("已请求停止，正在保留人工页签并关闭自动页签", "warn", { event: "run_stop_requested" });
  return { ok: true, status: "stopped" };
}

async function resumeBatchRun() {
  await initializationPromise;
  if (!state.paused || state.stopped) {
    return { ok: false, error: "当前没有已暂停的批量任务" };
  }
  state.paused = false;
  state.running = true;
  for (const [tabId, entry] of state.activeTabs) {
    if (!entry.batchPaused) continue;
    entry.batchPaused = false;
    entry.pauseRequested = false;
    entry.agentPaused = false;
    const task = state.tasks.find((item) => item.index === entry.taskIndex);
    if (task) {
      handleContentReady({ id: tabId, url: task.url }, entry.lastContentReady || { mode: "unknown" }).catch((err) =>
        log(`${task.domain}: 暂停后恢复失败 - ${err.message}`, "err", {
          event: "run_resume_failed",
          taskIndex: task.index,
          domain: task.domain,
          profileId: task.profileId,
          stack: err.stack,
        }),
      );
    }
  }
  for (const [tabId, entry] of state.activeTabs) {
    if (!entry.closeAfterResume) continue;
    entry.closeAfterResume = false;
    closeTab(tabId);
  }
  await persistActiveBatchStatus("running", { resumedAt: new Date().toISOString() });
  await recordAutomationEvent(null, { taskId: "run-event", type: "run_resumed", status: "running" }, { runStatus: "running" });
  broadcastStatus();
  log("批量已继续", "ok", { event: "run_resumed" });
  scheduleQueueProcessing();
  return { ok: true, status: "running" };
}

async function persistActiveBatchStatus(status, extra = {}) {
  return updateActiveBatchRun((activeBatchRun) => ({
    ...activeBatchRun,
    ...extra,
    status,
    tasks: serializeBatchTasks(state.tasks),
    parkedTaskIds: [...state.parkedTaskIds],
  }));
}

function updateActiveBatchRun(updater) {
  return runActiveBatchWrite(async () => {
    const stored = await chrome.storage.local.get(["activeBatchRun"]);
    if (!stored.activeBatchRun) return null;
    const current = stored.activeBatchRun;
    const next = updater(current);
    if (!next) return null;
    if (current.status === "stopped" && next.status !== "stopped") {
      next.status = "stopped";
      next.stoppedAt = current.stoppedAt || next.stoppedAt || new Date().toISOString();
    }
    await chrome.storage.local.set({ activeBatchRun: next });
    return next;
  });
}

function replaceActiveBatchRun(activeBatchRun) {
  return runActiveBatchWrite(async () => {
    await chrome.storage.local.set({ activeBatchRun });
    return activeBatchRun;
  });
}

async function startBatchRun(msg) {
  await initializationPromise;
  const lifecycleVersion = state.lifecycleVersion + 1;
  state.lifecycleVersion = lifecycleVersion;
  state.stopped = false;
  state.automationFinalStatus = "";
  closeAllTabs();
  const selectedSiteIds = Array.isArray(msg.selectedSiteIds)
    ? [...new Set(msg.selectedSiteIds.filter(Boolean))]
    : [];
  if (!selectedSiteIds.length) {
    throw new Error("请至少选择一个要提交的自家网站");
  }

  state.runId = `run-${Date.now().toString(36)}`;
  await resetBatchLog(state.runId, selectedSiteIds);
  log(`正在为 ${selectedSiteIds.length} 个 Profile 构建批量队列`, "", {
    event: "queue_build_started",
    selectedSiteIds,
  });
  await chrome.storage.local.set({ selectedSiteIds });
  const pending = await loadPendingSubmissionTasks({ selectedProfileIds: selectedSiteIds });
  assertBatchStartCurrent(lifecycleVersion);
  if (!pending.tasks.length) {
    state.running = false;
    state.tasks = [];
    state.groups = [];
    state.queue = [];
    state.profileConfigs = {};
    broadcastStatus();
    log("所选网站没有待提交组合", "warn", { event: "queue_empty" });
    return {
      ok: true,
      empty: true,
      tasks: [],
      groups: [],
      meta: pending.meta,
      message: "所选网站没有待提交组合",
    };
  }

  const storedFlags = await chrome.storage.local.get([
    "autoSubmitStandardWpComments",
    "autoSubmitDirectoryListings",
  ]);
  assertBatchStartCurrent(lifecycleVersion);
  state.config = {
    ...(msg.config || {}),
    fillOnly: msg.config?.fillOnly === true,
    autoSubmitDirectory:
      storedFlags.autoSubmitDirectoryListings !== false && msg.config?.fillOnly !== true,
    autoSubmitStandardWpComments: storedFlags.autoSubmitStandardWpComments === true,
  };
  state.profileConfigs = collectProfileConfigs(pending.tasks);
  state.tasks = pending.tasks.map((task) => stripTaskConfig({ ...task, status: "pending" }));
  state.groups = self.ExtLinkScheduler.groupTasksByDestination(state.tasks);
  state.queue = [...state.groups];
  state.parkedTaskIds.clear();
  state.concurrency = Math.max(1, parseInt(state.config.concurrency, 10) || 1);
  state.running = true;
  state.paused = false;
  state.stopped = false;

  await startAutomationRunLedger(selectedSiteIds);

  await replaceActiveBatchRun({
      version: 3,
      runId: state.runId,
      status: "running",
      selectedSiteIds,
      config: state.config,
      profileConfigs: state.profileConfigs,
      destinations: serializeBatchDestinations(state.groups),
      parkedTaskIds: [],
      startedAt: new Date().toISOString(),
      tasks: serializeBatchTasks(state.tasks),
  });
  assertBatchStartCurrent(lifecycleVersion);
  broadcastStatus();
  log(
    `开始处理 ${state.groups.length} 个外链站、${state.tasks.length} 个项目组合`,
    "ok",
    {
      event: "run_started",
      destinationTotal: state.groups.length,
      taskTotal: state.tasks.length,
    },
  );
  scheduleQueueProcessing();
  const taskWindow = buildTaskWindow(state.tasks);
  return {
    ok: true,
    tasks: taskWindow.tasks,
    taskWindow: taskWindow.meta,
    stats: summarizeTaskStats(state.tasks),
    groupTotal: state.groups.length,
    meta: pending.meta,
  };
}

function assertBatchStartCurrent(lifecycleVersion) {
  if (state.lifecycleVersion === lifecycleVersion && !state.stopped) return;
  const err = new Error("批次启动期间已停止，已取消本次启动");
  err.staleRun = true;
  throw err;
}

function markActiveBatchStopped() {
  return updateActiveBatchRun((activeBatchRun) => ({
    ...activeBatchRun,
    status: "stopped",
    stoppedAt: new Date().toISOString(),
    tasks: serializeBatchTasks(state.tasks),
    parkedTaskIds: [...state.parkedTaskIds],
  }));
}

async function getRuntimeState() {
  await initializationPromise;
  const activeByTaskId = new Map();
  for (const [tabId, entry] of state.activeTabs) {
    const task = state.tasks.find((item) => item.index === entry.taskIndex);
    if (task && entry.slotActive === false) {
      activeByTaskId.set(task.id, { tabId, parkedReason: entry.parkedReason || "" });
    }
  }
  const hasParkedTasks =
    state.parkedTaskIds.size > 0 ||
    [...state.activeTabs.values()].some((entry) => entry.slotActive === false);
  const status = getBatchStatus(hasParkedTasks);
  const taskWindow = buildTaskWindow(state.tasks);
  return {
    ok: true,
    running: state.running,
    paused: state.paused,
    stopped: state.stopped,
    status,
    tasks: taskWindow.tasks,
    taskWindow: taskWindow.meta,
    groupTotal: state.groups.length,
    parkedTasks: [...state.parkedTaskIds]
      .map((taskId) => {
        const task = state.tasks.find((item) => item.id === taskId);
        const active = activeByTaskId.get(taskId);
        return task
          ? {
              ...task,
              ...(active || {}),
              parkedReason:
                active?.parkedReason ||
                task.skipReason ||
                "页签已关闭；可确认成功，或在新一轮中重试",
            }
          : null;
      })
      .filter(Boolean),
    stats: summarizeTaskStats(state.tasks),
  };
}

function getBatchStatus(hasParkedTasks = null) {
  const parked =
    hasParkedTasks === null
      ? state.parkedTaskIds.size > 0 ||
        [...state.activeTabs.values()].some((entry) => entry.slotActive === false)
      : hasParkedTasks;
  if (state.stopped) return "stopped";
  if (state.paused) return "paused";
  if (state.running) return "running";
  return parked ? "waiting_manual" : "finished";
}

async function restoreActiveBatchRun() {
  const storage = await chrome.storage.local.get([
    "activeBatchRun",
    "submissionRecords",
    "siteAnnotations",
    "deletedSubmissionKeys",
  ]);
  const batch = storage.activeBatchRun;
  if (!batch || !["running", "waiting_manual", "paused", "stopped"].includes(batch.status)) return;
  if (!Array.isArray(batch.tasks) || !batch.tasks.length) return;

  state.config = batch.config || {};
  state.runId = batch.runId || `restored-${Date.now().toString(36)}`;
  state.profileConfigs = {
    ...(batch.profileConfigs || {}),
    ...collectProfileConfigs(batch.tasks),
  };
  const persistedDestinations = hydrateBatchDestinations(batch.destinations || []);
  const submissionRecords = storage.submissionRecords || {};
  const annotations = storage.siteAnnotations || {};
  const deletedKeys = new Set(storage.deletedSubmissionKeys || []);
  state.tasks = batch.tasks.map((rawTask) => {
    const task = hydratePersistedTask(rawTask, persistedDestinations);
    const successful = self.ExtLinkQueue.isSubmissionSuccessful(
      submissionRecords,
      task.destinationKey,
      task.profileId,
    );
    const annotation = self.ExtLinkQueue.findDestinationAnnotation(
      annotations,
      task.destinationKey,
      task.domain,
    );
    const deleted = self.ExtLinkQueue.hasStoredDestinationKey(deletedKeys, task.destinationKey);
    const restoredStatus = successful
      ? "ok"
      : deleted || self.ExtLinkQueue.isDeadEndStatus(annotation?.status)
        ? "skip"
        : task.status === "running"
          ? "pending"
          : task.status;
    return {
      ...stripTaskConfig(task),
      status: restoredStatus,
    };
  });
  state.groups = self.ExtLinkScheduler.groupTasksByDestination(state.tasks);
  state.concurrency = Math.max(1, parseInt(state.config.concurrency, 10) || 1);
  state.paused = batch.status === "paused";
  state.stopped = batch.status === "stopped";
  state.parkedTaskIds = new Set(batch.parkedTaskIds || []);

  const tabs = await chrome.tabs.query({});
  const claimedTabIds = new Set();
  for (const taskId of state.parkedTaskIds) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) continue;
    // Batches saved before confirmation nonces were introduced still need a
    // side-panel-only confirmation path after the extension upgrades.
    task.confirmationNonce = task.confirmationNonce || crypto.randomUUID();
    const tab = tabs.find((item) => {
      if (!item?.id || claimedTabIds.has(item.id)) return false;
      try {
        return self.ExtLinkQueue.normalizeDestinationKey(item.url || "") === task.destinationKey;
      } catch {
        return false;
      }
    });
    if (!tab?.id) continue;
    claimedTabIds.add(tab.id);
    state.activeTabs.set(tab.id, {
      taskIndex: task.index,
      groupKey: task.destinationGroupKey,
      timeoutId: null,
      runId: 0,
      slotActive: false,
      taskId: task.id,
      agentPaused: true,
      parkedReason: task.skipReason || "恢复的待人工任务",
    });
  }

  state.queue = self.ExtLinkScheduler.buildRestoredQueue(
    state.groups,
    state.parkedTaskIds,
  );
  state.running = !state.stopped && (state.paused || state.queue.length > 0);
  if (state.running && !state.paused) {
    log("已恢复上次未完成批次", "warn", { event: "run_restored" });
    scheduleQueueProcessing();
  }
}

function collectProfileConfigs(tasks = []) {
  const configs = {};
  for (const task of tasks) {
    const profileId = task?.profileId || task?.projectKey || task?.config?.projectKey;
    if (!profileId || configs[profileId] || !task?.config) continue;
    configs[profileId] = task.config;
  }
  return configs;
}

function stripTaskConfig(task = {}) {
  const { config: _config, ...lightTask } = task;
  return lightTask;
}

function serializeBatchTasks(tasks = []) {
  return tasks.map((task) => [
    task.index,
    task.destinationGroupIndex,
    task.profileId,
    task.profileName,
    task.status,
    task.groupJobIndex,
    task.groupJobCount,
    task.skipReason || "",
    task.successEvidence || "",
    task.publicationStatus || "",
    task.publicUrl || "",
    task.evidenceUrl || "",
    task.isDofollow === true ? 1 : 0,
    task.relResult || "",
    Math.max(0, Number(task._attempt) || 0),
    task.confirmationNonce || "",
    task.productHuntStage || "",
    Math.max(0, Number(task.productHuntStageAttempt) || 0),
    task.productHuntExpectedNext || "",
    task.productHuntLastTransitionAt || "",
  ]);
}

function serializeBatchDestinations(groups = []) {
  return groups.map((group, arrayIndex) => [
    group.tasks?.[0]?.destinationGroupIndex || group.index || arrayIndex + 1,
    group.key,
    group.url,
    group.domain,
    group.tasks?.[0]?.platformType || group.platformType || "directory",
    group.tasks?.[0]?.source || group.source || "table",
    group.tasks?.[0]?.note || group.note || "",
  ]);
}

function hydrateBatchDestinations(rows = []) {
  const result = new Map();
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    result.set(Number(row[0]), {
      index: Number(row[0]),
      key: row[1] || "",
      url: row[2] || "",
      domain: row[3] || "",
      platformType: row[4] || "directory",
      source: row[5] || "table",
      note: row[6] || "",
    });
  }
  return result;
}

function hydratePersistedTask(rawTask, destinations) {
  if (!Array.isArray(rawTask)) return rawTask || {};
  const destination = destinations.get(Number(rawTask[1])) || {};
  const profileId = rawTask[2] || "";
  const key = destination.key || "";
  return {
    id: self.ExtLinkQueue.submissionRecordKey(key, profileId),
    key,
    destinationKey: key,
    destinationUrl: destination.url || "",
    destinationGroupKey: key,
    destinationGroupIndex: Number(rawTask[1]),
    url: destination.url || "",
    domain: destination.domain || "",
    platformType: destination.platformType || "directory",
    source: destination.source || "table",
    note: destination.note || "",
    profileId,
    profileName: rawTask[3] || profileId,
    projectKey: profileId,
    status: rawTask[4] || "pending",
    index: Number(rawTask[0]),
    groupJobIndex: Number(rawTask[5]) || 1,
    groupJobCount: Number(rawTask[6]) || 1,
    skipReason: rawTask[7] || "",
    successEvidence: rawTask[8] || "",
    publicationStatus: rawTask[9] || "",
    publicUrl: rawTask[10] || "",
    evidenceUrl: rawTask[11] || "",
    isDofollow: rawTask[12] === 1,
    relResult: rawTask[13] || "",
    _attempt: Math.max(0, Number(rawTask[14]) || 0),
    confirmationNonce: rawTask[15] || "",
    productHuntStage: rawTask[16] || "",
    productHuntStageAttempt: Math.max(0, Number(rawTask[17]) || 0),
    productHuntExpectedNext: rawTask[18] || "",
    productHuntLastTransitionAt: rawTask[19] || "",
  };
}

function summarizeTaskForUi(task = {}) {
  return {
    id: task.id,
    index: task.index,
    domain: task.domain,
    url: task.url,
    profileId: task.profileId,
    profileName: task.profileName,
    status: task.status,
    skipReason: task.skipReason || "",
    groupJobIndex: task.groupJobIndex,
    groupJobCount: task.groupJobCount,
    runId: state.runId,
    confirmationNonce: task.confirmationNonce || "",
  };
}

function buildTaskWindow(tasks = [], limit = BATCH_TASK_WINDOW_SIZE) {
  if (tasks.length <= limit) {
    return {
      tasks: tasks.map(summarizeTaskForUi),
      meta: { start: 0, end: tasks.length, total: tasks.length, truncated: false },
    };
  }
  const runningIndex = tasks.findIndex((task) => task.status === "running");
  let focus = runningIndex;
  if (focus < 0) {
    for (let index = tasks.length - 1; index >= 0; index -= 1) {
      if (tasks[index].status !== "pending") {
        focus = index;
        break;
      }
    }
  }
  if (focus < 0) focus = 0;
  const start = Math.max(0, Math.min(tasks.length - limit, focus - Math.floor(limit / 3)));
  const end = Math.min(tasks.length, start + limit);
  return {
    tasks: tasks.slice(start, end).map(summarizeTaskForUi),
    meta: { start, end, total: tasks.length, truncated: true },
  };
}

function summarizeTaskStats(taskList) {
  const stats = { done: 0, skip: 0, err: 0, total: taskList.length, dofollow: 0, nofollow: 0 };
  for (const task of taskList) {
    if (task.status === "ok") stats.done++;
    else if (task.status === "skip") stats.skip++;
    else if (task.status === "err") stats.err++;
    if (task.isDofollow) stats.dofollow++;
    else if (task.status === "ok") stats.nofollow++;
  }
  return stats;
}

async function resolveTargetTabId(preferredTabId) {
  if (preferredTabId) {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab.url && /^https?:\/\//i.test(tab.url)) return preferredTabId;
    } catch {
      /* tab gone */
    }
  }
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const tab = tabs[0];
  if (tab?.id && tab.url && /^https?:\/\//i.test(tab.url)) return tab.id;
  return null;
}

async function pingContentScript(tabId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { action: "ping" });
    return resp?.ok === true;
  } catch {
    return false;
  }
}

async function ensureContentScript(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !/^https?:\/\//i.test(tab.url)) {
    throw new Error("当前页面不支持，请在普通 http/https 网页上使用");
  }

  if (await pingContentScript(tabId)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["lib/playbooks.js", "content.js"],
    });
  } catch (err) {
    throw new Error(`无法注入页面脚本，请刷新页面后重试（${err.message}）`);
  }

  await sleep(250);
  if (!(await pingContentScript(tabId))) {
    throw new Error("页面脚本未响应，请刷新当前页后重试");
  }
}

async function sendTabMessage(tabId, message) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, message);
}

async function handleSidepanelDetect(tabId) {
  const targetTabId = await resolveTargetTabId(tabId);
  if (!targetTabId) return { ok: false, error: "没有可检测的网页标签，请先打开目标站点" };
  try {
    const result = await sendTabMessage(targetTabId, { action: "detectPage" });
    if (result?.error) return { ok: false, error: result.error };
    return { ok: true, tabId: targetTabId, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handlePrescanPage(tabId) {
  const targetTabId = await resolveTargetTabId(tabId);
  if (!targetTabId) return { ok: false, error: "没有可检测的网页标签" };
  try {
    const result = await sendTabMessage(targetTabId, { action: "prescanPage" });
    if (result?.error) return { ok: false, error: result.error };
    return { ok: true, tabId: targetTabId, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function handleGenerateCommentPreview(msg) {
  const tabId = await resolveTargetTabId(msg.tabId);
  if (!tabId) return { ok: false, error: "没有可生成评论的网页标签" };
  try {
    return await sendTabMessage(tabId, {
      action: "generateCommentPreview",
      config: msg.config || {},
      count: msg.count || 1,
      refresh: msg.refresh === true,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function mergeLearnedMappings(activeSiteId, hostname, mappings) {
  if (!activeSiteId || !hostname || !mappings || !Object.keys(mappings).length) return;
  const data = await chrome.storage.local.get("siteProfiles");
  const profiles = data.siteProfiles || {};
  const profile = profiles[activeSiteId];
  if (!profile) return;
  profile.learnedFieldMappings = profile.learnedFieldMappings || {};
  profile.learnedFieldMappings[hostname] = {
    ...(profile.learnedFieldMappings[hostname] || {}),
    ...mappings,
  };
  profiles[activeSiteId] = profile;
  await chrome.storage.local.set({ siteProfiles: profiles });
}

async function handleSidepanelFill(msg) {
  const tabId = await resolveTargetTabId(msg.tabId);
  if (!tabId) return { error: "没有可填表的网页标签" };

  const storage = await chrome.storage.local.get([
    "siteProfiles",
    "activeSiteId",
    "cfgEmail",
    "cfgName",
    "autoSubmitStandardWpComments",
    "autoSubmitDirectoryListings",
  ]);
  const profiles = storage.siteProfiles || {};
  const requestedId = msg.profileId || storage.activeSiteId;
  const profile =
    (requestedId && profiles[requestedId]) || self.ExtLinkProfiles.getActiveProfile(storage);
  if (!self.ExtLinkProfiles.profileConfigured(profile)) {
    return { error: "未配置网站资料，请打开设置页" };
  }

  let config = self.ExtLinkProfiles.buildAgentConfigFromProfile(profile, {
    email: storage.cfgEmail,
    username: storage.cfgName,
    fillOnly: msg.mode === "comment",
  });
  config.autoSubmitStandardWpComments = storage.autoSubmitStandardWpComments === true;
  config.autoSubmitDirectory =
    storage.autoSubmitDirectoryListings !== false && msg.mode !== "comment";
  config.learnedFieldMappings = profile.learnedFieldMappings || {};

  if (msg.mode === "comment" && msg.commentText) {
    config.commentTemplate = msg.commentText;
  }

  let platformType = "auto";
  if (msg.mode === "comment") {
    platformType = "wp_comment";
  } else {
    try {
      const detection = await sendTabMessage(tabId, { action: "detectPage" });
      if (detection.platform && detection.platform !== "unknown") {
        platformType = detection.platform;
      }
    } catch {
      /* use auto */
    }
  }

  broadcastAutoFillUpdate({ tabId, status: "filling", message: "正在填写表单…" });

  const pageUrl = await getTabUrlSafe(tabId);
  if (msg.mode !== "comment" && isCustomLaunchUrl(pageUrl)) {
    const mismatch = self.ExtLinkProfiles.fillIdentityMismatch(config, profile);
    if (mismatch) {
      broadcastAutoFillUpdate({
        tabId,
        status: "error",
        message: `资料与当前网站不一致（${mismatch}），已阻止提交`,
      });
      return { error: `资料与当前网站不一致（${mismatch}），已阻止提交`, fillOnly: true };
    }

    broadcastAutoFillUpdate({
      tabId,
      status: "filling",
      message: "Product Hunt 专用状态机正在逐步填写并校验…",
    });
    const result = await runProductHuntSidepanelLoop(tabId, config, {
      confirmCreate: msg.confirmProductHuntCreate === true,
    });
    if (!result) {
      broadcastAutoFillUpdate({
        tabId,
        status: "manual",
        message: "Product Hunt 当前步骤未推进，页签已保留",
      });
      return { ok: false, platform: "product_hunt", keepTab: true, fillOnly: true };
    }
    if (result.submittedAttempt && result.matched && result.evidence) {
      await recordSubmittedProject({
        url: pageUrl,
        profileId: profile.id,
        profileName: profile.name || profile.id,
        confirmedBy: "agent",
        successEvidence: result.evidence,
        publicationStatus: result.publicationStatus || "submitted",
        publicUrl: result.publicUrl || "",
        evidenceUrl: result.evidenceUrl || "",
        successProof: {
          source: "deterministic_submit",
          actionObserved: true,
          evidenceSignals: result.evidenceSignals || [{
            type: result.publicationStatus === "published" ? "public_listing" : "visible_confirmation",
            text: result.evidence,
            url: pageUrl,
            matched: true,
          }],
        },
      });
      broadcastAutoFillUpdate({
        tabId,
        status: "done",
        message: result.publicationStatus === "published"
          ? "Product Hunt 草稿已创建并看到公开回执"
          : "Product Hunt 草稿已创建并记入账本",
      });
      return { ...result, ok: true, platform: "product_hunt", submitted: true, advance: true };
    }
    if (result.ready_to_create) {
      broadcastAutoFillUpdate({
        tabId,
        status: "manual",
        message: "Product Hunt 必填项已完成，等待确认 Create draft（不会排期或购买推广）",
      });
      return { ...result, ok: true, platform: "product_hunt", keepTab: true, fillOnly: true };
    }
    const gateStatus = productHuntGateStatus(result);
    broadcastAutoFillUpdate({
      tabId,
      status: gateStatus === "needs_captcha" ? "captcha" : "manual",
      message: result.reason || "Product Hunt 当前步骤需要人工处理",
      keepTab: true,
    });
    return { ...result, platform: "product_hunt", keepTab: true, fillOnly: true };
  }

  let smartTotal = 0;
  let skippedFiles = [];
  let inferredFields = [];
  let learnedFields = [];
  let agentResult = {};
  let lastEmpty = { emptyCount: 0, totalCount: 0 };
  let validation = { submitReady: true, issues: [] };

  if (msg.mode === "comment") {
    try {
      agentResult = await sendTabMessage(tabId, {
        action: "executeSubmit",
        config,
        platformType,
        taskIndex: 0,
      });
    } catch (err) {
      agentResult = { error: err.message };
    }
  } else {
    const filled = await fillFormUntilReady(tabId, config, platformType, {
      allowAgent: msg.useAgent !== false,
    });
    smartTotal = filled.smartTotal;
    skippedFiles = filled.skippedFiles;
    inferredFields = filled.inferredFields;
    agentResult = filled.agentResult;
    lastEmpty = filled.lastEmpty;
    validation = filled.validation;
  }

  try {
    learnedFields = await persistFillLearnings(tabId, profile.id, config);
  } catch {
    /* non-fatal */
  }

  if (agentResult?.needs_manual) {
    const pageUrl = await getTabUrlSafe(tabId);
    const classified = pageUrl
      ? await autoClassifySite(pageUrl, agentResult.reason || "需要人工处理", "needs_login")
      : null;
    broadcastAutoFillUpdate({
      tabId,
      status: classified?.status || "manual",
      message: agentResult.reason || "需要人工处理",
      classifyStatus: classified?.status,
      advance: true,
      keepTab: true,
    });
    return {
      ...agentResult,
      classified: classified?.status,
      advance: true,
      keepTab: true,
      deadEnd: classified ? self.ExtLinkQueue.isDeadEndStatus(classified.status) : false,
    };
  }
  if (agentResult?.captcha) {
    const pageUrl = await getTabUrlSafe(tabId);
    if (pageUrl) await autoClassifySite(pageUrl, "请完成验证码", "needs_captcha");
    broadcastAutoFillUpdate({
      tabId,
      status: "captcha",
      message: "请完成验证码",
      classifyStatus: "needs_captcha",
      advance: true,
      keepTab: true,
    });
    return { captcha: true, classified: "needs_captcha", advance: true, keepTab: true };
  }
  if (agentResult?.blocked) {
    const pageUrl = await getTabUrlSafe(tabId);
    const classified = pageUrl
      ? await autoClassifySite(pageUrl, agentResult.reason || "无法提交", "broken")
      : null;
    broadcastAutoFillUpdate({
      tabId,
      status: "blocked",
      message: agentResult.reason || "无法提交",
      classifyStatus: classified?.status,
      advance: true,
      keepTab: true,
    });
    return {
      blocked: true,
      reason: agentResult.reason,
      classified: classified?.status,
      advance: true,
      keepTab: true,
      deadEnd: true,
    };
  }

  if (agentResult?.error && smartTotal === 0 && msg.mode !== "comment") {
    broadcastAutoFillUpdate({ tabId, status: "error", message: agentResult.error });
    return { error: agentResult.error };
  }

  if (msg.mode === "comment") {
    const submitted = !!(agentResult?.clickedSubmit || agentResult?.submitted);
    const publicationStatus = agentResult?.publicationStatus || "";
    const evidence = agentResult?.evidence || "";
    if (submitted && agentResult?.ok && agentResult?.matched === true && evidence) {
      const pageUrl = await getTabUrlSafe(tabId);
      if (pageUrl) {
        await recordSubmittedProject({
          url: pageUrl,
          profileId: profile.id,
          profileName: profile.name || profile.id,
          confirmedBy: "agent",
          successEvidence: evidence,
          publicationStatus,
          publicUrl: agentResult.publicUrl || "",
          evidenceUrl: agentResult.evidenceUrl || "",
          successProof: {
            source: "deterministic_submit",
            actionObserved: true,
            evidenceSignals: agentResult.evidenceSignals || [{
              type: publicationStatus === "published" ? "public_listing" : "visible_confirmation",
              text: evidence,
              url: pageUrl,
              matched: true,
            }],
          },
        });
      }
    }
    const doneMsg = submitted
      ? publicationStatus === "pending_moderation"
        ? "评论已提交，站点显示待审核"
        : evidence
          ? "评论已代点提交"
          : "已代点提交，未见回执，请人工确认"
      : agentResult?.error
        ? agentResult.error
        : "评论内容已填入";
    broadcastAutoFillUpdate({
      tabId,
      status: submitted && !evidence ? "manual" : "done",
      message: doneMsg,
    });
    return {
      ok: !agentResult?.error,
      fillOnly: !submitted,
      submitted,
      publicationStatus,
      evidence,
      standardWp: !!agentResult?.standardWp,
      platform: "wp_comment",
      error: agentResult?.error || "",
    };
  }

  const submitReady =
    validation?.submitReady !== false && lastEmpty.emptyCount === 0 && !lastEmpty.invalidCount;
  const baseFill = {
    ok: true,
    filledCount: smartTotal,
    emptyCount: lastEmpty.emptyCount,
    invalidCount: lastEmpty.invalidCount || 0,
    totalCount: lastEmpty.totalCount,
    skippedFiles,
    inferredFields,
    learnedFields,
    platform: platformType,
    submitReady,
    validationIssues: validation?.issues || [],
  };

  if (submitReady || lastEmpty.emptyCount === 0) {
    const mismatch = self.ExtLinkProfiles.fillIdentityMismatch(config, profile);
    if (mismatch) {
      broadcastAutoFillUpdate({
        tabId,
        status: "error",
        message: `资料与当前网站不一致（${mismatch}），已阻止提交`,
      });
      return { error: `资料与当前网站不一致（${mismatch}），已阻止提交`, fillOnly: true };
    }
    const submitted = await submitUntilAccepted(tabId, config, profile, platformType, {
      allowAgent: msg.useAgent !== false,
    });
    if (submitted) {
      lastEmpty = submitted.lastEmpty || lastEmpty;
      return {
        ...baseFill,
        ...submitted,
        emptyCount: lastEmpty.emptyCount,
        invalidCount: lastEmpty.invalidCount || 0,
        validationIssues: submitted.issues || validation?.issues || [],
      };
    }
  }

  const doneMsg =
    lastEmpty.invalidCount > 0
      ? `${lastEmpty.invalidCount} 个字段超出字数限制，请检查后提交`
      : lastEmpty.emptyCount > 0
        ? `还有 ${lastEmpty.emptyCount} 个字段未填写`
        : validation?.submitReady === false
          ? `已填写，AI 校验有 ${validation.issues?.length || 0} 项待检查`
          : `当前表单 ${lastEmpty.totalCount} 个字段已填写，可提交`;

  broadcastAutoFillUpdate({
    tabId,
    status: "done",
    message: doneMsg,
    ...baseFill,
  });

  return { ...baseFill, fillOnly: true };
}

async function persistFillLearnings(tabId, profileId, config) {
  if (!profileId) return [];
  const tab = await chrome.tabs.get(tabId);
  const hostname = new URL(tab.url).hostname;
  const learned = await sendTabMessage(tabId, { action: "collectFillLearnings", config: config || {} });
  if (!learned?.mappings) return [];
  await mergeLearnedMappings(profileId, hostname, learned.mappings);
  const latest = await chrome.storage.local.get("siteProfiles");
  const profiles = latest.siteProfiles || {};
  const current = profiles[profileId];
  if (!current) return [];
  const expanded = self.ExtLinkProfiles.learnProfileFieldsFromFill(current, learned.mappings);
  if (!expanded.added.length) return [];
  profiles[profileId] = expanded.profile;
  await chrome.storage.local.set({ siteProfiles: profiles });
  log(`资料库已补齐 ${expanded.added.join("、")}`, "ok");
  return expanded.added;
}

async function tryAutoSubmitFilledForm(tabId, config, profile, platformType, options = {}) {
  const currentUrl = await getTabUrlSafe(tabId);
  if (isCustomLaunchUrl(currentUrl)) {
    return sendTabMessage(tabId, {
      action: "runProductHuntStep",
      config,
      confirmCreate: options.confirmProductHuntCreate === true,
    });
  }
  const mismatch = self.ExtLinkProfiles.fillIdentityMismatch(config, profile);
  if (mismatch) {
    broadcastAutoFillUpdate({
      tabId,
      status: "error",
      message: `资料与当前网站不一致（${mismatch}），已阻止提交`,
    });
    return { error: `资料与当前网站不一致（${mismatch}），已阻止提交`, fillOnly: true };
  }
  broadcastAutoFillUpdate({ tabId, status: "filling", message: "无验证码，正在提交…" });
  const beforeEvidence = await sendTabMessage(tabId, { action: "classifySubmitEvidence" }).catch(() => ({}));
  let submitResult = {};
  try {
    submitResult = await sendTabMessage(tabId, {
      action: "submitFilledForm",
      config,
      platform: platformType || "directory",
    });
  } catch (err) {
    await sleep(2000);
    submitResult = await sendTabMessage(tabId, { action: "classifySubmitEvidence" }).catch(() => ({
      submitted: true,
      matched: false,
      reason: err.message,
    }));
    const beforeText = String(beforeEvidence?.evidence || "").replace(/\s+/g, " ").trim();
    const afterText = String(submitResult?.evidence || "").replace(/\s+/g, " ").trim();
    submitResult = {
      ...submitResult,
      submitted: true,
      clickedSubmit: true,
      matched: Boolean(submitResult?.matched && afterText && afterText !== beforeText),
      evidence: afterText && afterText !== beforeText ? submitResult.evidence : "",
      evidenceSignals: afterText && afterText !== beforeText ? submitResult.evidenceSignals || [] : [],
    };
  }

  if (submitResult?.captcha) {
    const pageUrl = await getTabUrlSafe(tabId);
    if (pageUrl) await autoClassifySite(pageUrl, "请完成验证码", "needs_captcha");
    broadcastAutoFillUpdate({
      tabId,
      status: "captcha",
      message: "请完成验证码；页签已留下",
      classifyStatus: "needs_captcha",
      advance: true,
      keepTab: true,
    });
    return { captcha: true, classified: "needs_captcha", advance: true, keepTab: true };
  }
  if (submitResult?.needs_manual) {
    const pageUrl = await getTabUrlSafe(tabId);
    const classified = pageUrl
      ? await autoClassifySite(pageUrl, submitResult.reason || "需要人工处理", "needs_login")
      : null;
    broadcastAutoFillUpdate({
      tabId,
      status: classified?.status || "manual",
      message: submitResult.reason || "需要人工处理",
      classifyStatus: classified?.status,
      advance: true,
      keepTab: true,
    });
    return {
      needs_manual: true,
      reason: submitResult.reason,
      classified: classified?.status,
      advance: true,
      keepTab: true,
      deadEnd: classified ? self.ExtLinkQueue.isDeadEndStatus(classified.status) : false,
    };
  }
  if (submitResult?.blocked) {
    const pageUrl = await getTabUrlSafe(tabId);
    const classified = pageUrl
      ? await autoClassifySite(pageUrl, submitResult.reason || "无法提交", "broken")
      : null;
    broadcastAutoFillUpdate({
      tabId,
      status: "blocked",
      message: submitResult.reason || "无法提交",
      classifyStatus: classified?.status,
      advance: true,
      keepTab: true,
    });
    return {
      blocked: true,
      reason: submitResult.reason,
      classified: classified?.status,
      advance: true,
      keepTab: true,
      deadEnd: true,
    };
  }

  if (submitResult?.validationFailed) {
    return {
      validationFailed: true,
      submitted: false,
      issues: submitResult.issues || [],
      emptyCount: submitResult.emptyCount || 0,
      invalidCount: submitResult.invalidCount || 0,
    };
  }

  if (submitResult?.stageAdvanced) {
    broadcastAutoFillUpdate({ tabId, status: "filling", message: "已进入下一步，继续识别并填写表单…" });
    return { stageAdvanced: true, submitted: false, matched: false };
  }

  if (submitResult?.submitted && submitResult?.matched && submitResult?.evidence) {
    const pageUrl = await getTabUrlSafe(tabId);
    if (pageUrl && options.recordLedger !== false) {
      await recordSubmittedProject({
        url: pageUrl,
        profileId: profile.id,
        profileName: profile.name || profile.id,
        confirmedBy: "agent",
        successEvidence: submitResult.evidence,
        publicationStatus: submitResult.publicationStatus || "submitted",
        successProof: {
          source: "deterministic_submit",
          actionObserved: true,
          evidenceSignals: submitResult.evidenceSignals || [{
            type: submitResult.publicationStatus === "published" ? "public_listing" : "visible_confirmation",
            text: submitResult.evidence,
            url: pageUrl,
            matched: true,
          }],
        },
      });
    }
    const doneMsg =
      submitResult.publicationStatus === "pending_moderation"
        ? "已提交，站点显示待审核"
        : submitResult.publicationStatus === "published"
          ? "已提交并看到上线回执"
          : "已提交并记入账本";
    broadcastAutoFillUpdate({ tabId, status: "done", message: doneMsg });
    return {
      ok: true,
      submitted: true,
      matched: true,
      evidence: submitResult.evidence,
      publicationStatus: submitResult.publicationStatus || "submitted",
      advance: true,
    };
  }

  if (submitResult?.submitted) {
    broadcastAutoFillUpdate({
      tabId,
      status: "manual",
      message: "已代点提交，未见回执，请人工确认；页签已保留",
    });
    return {
      ok: true,
      submitted: true,
      matched: false,
      fillOnly: false,
      keepTab: true,
      advance: false,
    };
  }

  return null;
}

async function fillFormUntilReady(tabId, config, platformType, options = {}) {
  const allowAgent = options.allowAgent !== false;
  let smartTotal = 0;
  let skippedFiles = [];
  let inferredFields = [];
  let agentResult = {};
  let lastEmpty = { emptyCount: 0, invalidCount: 0, totalCount: 0 };
  let validation = { submitReady: true, issues: [] };
  let formState = { validationFailed: false, issues: [] };

  for (let round = 0; round < MAX_FILL_ROUNDS; round++) {
    try {
      const smartResult = await sendTabMessage(tabId, { action: "smartFill", config });
      smartTotal += smartResult.filledCount || 0;
      if (smartResult.skippedFiles?.length) skippedFiles = smartResult.skippedFiles;
      if (smartResult.inferredFields?.length) {
        inferredFields = [...new Set([...inferredFields, ...smartResult.inferredFields])];
      }
    } catch (err) {
      log(`智能填表: ${err.message}`, "warn");
    }

    lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => ({
      emptyCount: 1,
      invalidCount: 0,
      totalCount: 0,
    }));
    formState = await sendTabMessage(tabId, { action: "collectFormValidation" }).catch(
      () => lastEmpty,
    );
    if (
      lastEmpty.emptyCount === 0 &&
      !lastEmpty.invalidCount &&
      formState?.validationFailed !== true
    ) {
      break;
    }
    if (!allowAgent) break;

    broadcastAutoFillUpdate({
      tabId,
      status: "filling",
      message: `AI 补全剩余 ${lastEmpty.emptyCount || formState?.issues?.length || 0} 个字段…`,
    });

    try {
      agentResult = await runSidepanelAgentFill(tabId, config, platformType, 2);
      if (agentResult?.needs_manual || agentResult?.captcha || agentResult?.blocked) break;
    } catch (err) {
      agentResult = { error: err.message };
      if (round === 0) log(`AI 填表: ${err.message}`, "warn");
    }

    lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => ({
      emptyCount: 1,
      invalidCount: 0,
      totalCount: 0,
    }));
    formState = await sendTabMessage(tabId, { action: "collectFormValidation" }).catch(
      () => lastEmpty,
    );
    if (
      lastEmpty.emptyCount === 0 &&
      !lastEmpty.invalidCount &&
      formState?.validationFailed !== true
    ) {
      break;
    }
  }

  try {
    await sendTabMessage(tabId, { action: "smartFill", config });
    lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => ({
      emptyCount: 1,
      invalidCount: 0,
      totalCount: 0,
    }));
    validation = await runValidateAndFixFill(tabId, config);
    lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => lastEmpty);
    formState = await sendTabMessage(tabId, { action: "collectFormValidation" }).catch(
      () => formState,
    );
  } catch (err) {
    log(`填表校验: ${err.message}`, "warn");
  }

  return {
    smartTotal,
    skippedFiles,
    inferredFields,
    agentResult,
    lastEmpty,
    validation,
    formState,
  };
}

async function submitUntilAccepted(tabId, config, profile, platformType, options = {}) {
  let lastEmpty = options.lastEmpty || { emptyCount: 0, invalidCount: 0 };
  let lastIssues = [];
  let validationAttempt = 0;
  let stageCount = 0;
  while (validationAttempt < MAX_VALIDATION_RETRIES && stageCount < 6) {
    const submitted = await tryAutoSubmitFilledForm(
      tabId,
      config,
      profile,
      platformType,
      options,
    );
    if (!submitted) return null;
    if (submitted.stageAdvanced) {
      stageCount += 1;
      await sleep(900);
      const filled = await fillFormUntilReady(tabId, config, platformType, options);
      lastEmpty = filled.lastEmpty;
      if (filled.agentResult?.needs_manual || filled.agentResult?.captcha || filled.agentResult?.blocked) {
        return filled.agentResult;
      }
      continue;
    }
    if (!submitted.validationFailed) return { ...submitted, lastEmpty, issues: lastIssues };
    validationAttempt += 1;
    lastIssues = submitted.issues || [];
    lastEmpty = {
      emptyCount: submitted.emptyCount || 0,
      invalidCount: submitted.invalidCount || 0,
    };
    if (validationAttempt >= MAX_VALIDATION_RETRIES) {
      broadcastAutoFillUpdate({
        tabId,
        status: "manual",
        message: `表单校验未通过，补完一轮仍缺：${
          lastIssues[0] || "仍有必填或无效栏"
        }`,
      });
      return {
        validationFailed: true,
        fillOnly: true,
        keepTab: true,
        issues: lastIssues,
        lastEmpty,
      };
    }
    log(`表单校验未通过，AI 再补一轮: ${lastIssues[0] || "漏填"}`, "warn");
    const filled = await fillFormUntilReady(tabId, config, platformType, options);
    lastEmpty = filled.lastEmpty;
    if (filled.agentResult?.needs_manual || filled.agentResult?.captcha || filled.agentResult?.blocked) {
      return filled.agentResult;
    }
  }
  return null;
}

async function runProductHuntSidepanelLoop(tabId, config, options = {}) {
  let step = 0;
  let waitingRetries = 0;
  let lastWaitingSignature = "";
  let stableWaitingRetries = 0;
  while (step < PRODUCT_HUNT_MAX_STEPS && waitingRetries < PRODUCT_HUNT_MAX_WAIT_RETRIES) {
    const result = await sendTabMessage(tabId, {
      action: "runProductHuntStep",
      config,
      confirmCreate: options.confirmCreate === true,
    });
    if (!result || typeof result !== "object") {
      throw new Error("Product Hunt 步骤返回无效");
    }
    if (result.status === "gate" || result.needs_manual || result.captcha || /^needs_/.test(result.status || "")) {
      return result;
    }
    if (result.submittedAttempt || result.ready_to_create === true || result.status === "ready_to_create") {
      return result;
    }
    if (result.status === "error" || result.error) {
      throw new Error(result.error || result.reason || "Product Hunt 步骤失败");
    }
    if (result.waiting) {
      const waitingSignature = [
        result.stage || "unknown",
        JSON.stringify(result.missing || result.requiredUnchecked || []),
        result.reason || "",
      ].join("|");
      if (waitingSignature === lastWaitingSignature) stableWaitingRetries += 1;
      else {
        lastWaitingSignature = waitingSignature;
        stableWaitingRetries = 0;
      }
      // A loaded pane with the same missing prerequisite is not a loading
      // screen. Stop after a short bounded retry window and preserve the tab,
      // instead of spinning for the full 60-retry load budget.
      if (result.stage && result.stage !== "unknown" && result.missing?.length && stableWaitingRetries >= 5) {
        return {
          ...result,
          platform: "product_hunt",
          needs_manual: true,
          keepTab: true,
          reason: `Product Hunt ${result.stage} 仍缺少：${result.missing.join("、")}`,
        };
      }
      waitingRetries += 1;
      const retryAfterMs = Number(result.retryAfterMs);
      const delayMs = Number.isFinite(retryAfterMs)
        ? Math.max(150, Math.min(retryAfterMs, 5000))
        : 800;
      await sleep(delayMs);
      continue;
    }
    if (!(result.advanced || result.stageAdvanced || result.stageCompleted || result.entryOpened)) {
      return { ...result, waiting: true, retryAfterMs: 800 };
    }
    step += 1;
    waitingRetries = 0;
    await sleep(900);
  }
  return {
    ok: false,
    waiting: true,
    keepTab: true,
    reason: "Product Hunt 步骤超过安全上限，页签已保留",
  };
}

async function runValidateAndFixFill(tabId, config) {
  broadcastAutoFillUpdate({ tabId, status: "filling", message: "AI 检查填写内容…" });

  let report = await sendTabMessage(tabId, { action: "getFilledFieldsReport" });
  if (!report?.fields?.length) return { submitReady: true, issues: [] };

  if (report.invalidCount > 0) {
    const localFixes = report.fields
      .filter((f) => f.invalid && f.constraints?.maxLength && f.length > f.constraints.maxLength)
      .map((f) => ({
        selector: f.selector,
        value: f.value.slice(0, f.constraints.maxLength),
      }));
    if (localFixes.length) {
      await sendTabMessage(tabId, { action: "applyFieldCorrections", corrections: localFixes });
      report = await sendTabMessage(tabId, { action: "getFilledFieldsReport" });
    }
  }

  if (report.allValid) return { submitReady: true, issues: [] };

  const snapshot = await getTabSnapshot(tabId);
  const validation = await callCloudAgent("/validate-fill", {
    snapshot,
    filledFields: report.fields,
    config: {
      brandName: config.brandName,
      targetDomain: config.targetDomain,
      projectFields: config.projectFields,
      email: config.email,
      tags: config.tags,
      username: config.username,
    },
  });

  if (validation.fields?.length) {
    await sendTabMessage(tabId, {
      action: "applyFieldCorrections",
      corrections: validation.fields,
    });
    report = await sendTabMessage(tabId, { action: "getFilledFieldsReport" });
  }

  const issues = [...(validation.issues || []), ...(report.issues || [])];
  return {
    submitReady: validation.submitReady !== false && report.allValid,
    issues,
    validationStatus: validation.status,
    invalidCount: report.invalidCount || 0,
    emptyCount: report.fields.filter((f) => !f.value).length,
  };
}

function siteKeyForUrl(url) {
  return self.ExtLinkQueue.normalizeUrlKey(url);
}

async function getSiteAnnotation(url) {
  if (!url) return { ok: true, annotation: null, inQueue: false };
  const storage = await chrome.storage.local.get([
    "siteAnnotations",
    "deletedSubmissionKeys",
    "urlList",
  ]);
  const key = siteKeyForUrl(url);
  const domain = self.ExtLinkQueue.extractDomain(url);
  const annotations = storage.siteAnnotations || {};
  const annotation = annotations[key] || annotations[domain] || null;
  const deleted = (storage.deletedSubmissionKeys || []).includes(key);
  const { tasks } = await loadPendingSubmissionTasks();
  const inQueue = tasks.some((t) => t.key === key || t.domain === domain);
  const pluginUrls = self.ExtLinkQueue.resolvePluginUrls(
    storage.urlList || "",
    self.ExtLinkUrlLibrary || [],
  );
  const inUrlList = pluginUrls.some((u) => u.key === key || u.domain === domain);
  return { ok: true, annotation, inQueue, inUrlList, deleted, key, domain };
}

async function markSubmissionSite(msg) {
  const url = msg.url;
  if (!url) throw new Error("缺少 URL");
  const status = msg.status || "can_submit";
  const key = siteKeyForUrl(url);
  const domain = self.ExtLinkQueue.extractDomain(url);
  const storage = await chrome.storage.local.get(["siteAnnotations", "deletedSubmissionKeys"]);
  const annotations = storage.siteAnnotations || {};
  let deletedKeys = storage.deletedSubmissionKeys || [];
  const prev = annotations[key] || annotations[domain] || {};
  let submittedProjects = Array.isArray(prev.submittedProjects) ? [...prev.submittedProjects] : [];
  if (msg.submittedProject) {
    const proj = String(msg.submittedProject);
    if (proj && !submittedProjects.includes(proj)) submittedProjects.push(proj);
  }
  if (Array.isArray(msg.submittedProjects)) {
    submittedProjects = [...new Set([...submittedProjects, ...msg.submittedProjects])];
  }

  annotations[key] = {
    url,
    domain,
    status,
    note: msg.note || prev.note || "",
    submittedProjects,
    updatedAt: new Date().toISOString(),
    auto: !!msg.auto,
  };
  annotations[domain] = annotations[key];

  if (status === "deleted") {
    if (!deletedKeys.includes(key)) deletedKeys.push(key);
  } else {
    deletedKeys = deletedKeys.filter((k) => k !== key);
  }

  await chrome.storage.local.set({
    siteAnnotations: annotations,
    deletedSubmissionKeys: deletedKeys,
  });
  return { ok: true, annotation: annotations[key] };
}

async function listSiteAnnotations() {
  const storage = await chrome.storage.local.get(["siteAnnotations"]);
  const annotations = storage.siteAnnotations || {};
  const byKey = new Map();
  for (const [key, ann] of Object.entries(annotations)) {
    if (!ann || typeof ann !== "object") continue;
    const id = ann.url ? siteKeyForUrl(ann.url) : key;
    const existing = byKey.get(id);
    if (!existing || (ann.url && !existing.url)) byKey.set(id, { key: id, ...ann });
  }
  const items = [...byKey.values()].sort((a, b) =>
    String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
  );
  return { ok: true, items };
}

async function clearSiteAnnotation(msg) {
  const url = msg.url || "";
  if (!url) throw new Error("缺少 URL");
  const key = siteKeyForUrl(url);
  const domain = self.ExtLinkQueue.extractDomain(url);
  const storage = await chrome.storage.local.get(["siteAnnotations", "deletedSubmissionKeys"]);
  const annotations = storage.siteAnnotations || {};
  delete annotations[key];
  delete annotations[domain];
  const deletedKeys = (storage.deletedSubmissionKeys || []).filter((k) => k !== key);
  await chrome.storage.local.set({
    siteAnnotations: annotations,
    deletedSubmissionKeys: deletedKeys,
  });
  return { ok: true, cleared: true, key, domain };
}

async function advanceSubmissionQueue(msg = {}) {
  const delta = Number.isFinite(msg.delta) ? msg.delta : 1;
  const { groups, tasks: jobs, meta } = await loadPendingSubmissionTasks();
  if (!groups.length) {
    return {
      ok: true,
      tasks: [],
      jobs: [],
      index: 0,
      total: 0,
      meta,
      advanced: false,
    };
  }

  const storage = await chrome.storage.local.get(["submissionQueueIndex", "submissionQueueKey"]);
  let index = Number.isFinite(storage.submissionQueueIndex) ? storage.submissionQueueIndex : 0;
  const currentKey = msg.currentKey || storage.submissionQueueKey || "";
  index = self.ExtLinkScheduler.resolveCursorIndex(groups, currentKey, index, delta);

  const task = groups[index];
  await chrome.storage.local.set({
    submissionQueueIndex: index,
    submissionQueueKey: task.key,
  });
  const url = task.url.startsWith("http") ? task.url : `https://${task.url}`;
  let tabId = msg.tabId || null;
  if (!tabId && msg.open !== false) {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tabId = tab?.id || null;
  }
  if (tabId && msg.open !== false) {
    await chrome.tabs.update(tabId, { url });
  }
  return {
    ok: true,
    tasks: groups,
    jobs,
    index,
    total: groups.length,
    meta,
    advanced: true,
    task,
    tabId,
  };
}

/**
 * Persist site classification from agent/rule outcome. Dead-ends leave the pending queue.
 */
async function autoClassifySite(url, reason, fallbackStatus = "broken") {
  if (!url) return null;
  const status = self.ExtLinkQueue.classifyStatusFromReason(reason, fallbackStatus);
  const result = await markSubmissionSite({
    url,
    status,
    note: reason || "",
    auto: true,
  });
  broadcastAutoFillUpdate({
    status: "classified",
    classifyStatus: status,
    url,
    reason: reason || "",
    domain: result.annotation?.domain || self.ExtLinkQueue.extractDomain(url),
    deadEnd: self.ExtLinkQueue.isDeadEndStatus(status),
    gate: self.ExtLinkQueue.isGateStatus(status),
  });
  return { status, annotation: result.annotation };
}

async function recordSubmittedProject(task) {
  if (!task?.url) return;
  const url = task.url.startsWith("http") ? task.url : `https://${task.url}`;
  const profileId = task.profileId || task.projectKey || task.config?.projectKey || "";
  if (!profileId) return;
  const proof = self.ExtLinkAutomationLedger.validateSuccessProof({
    confirmedBy: task.confirmedBy || "agent",
    evidence: task.successEvidence || "",
    source: task.successProof?.source || "",
    actionObserved: task.successProof?.actionObserved === true,
    evidenceSignals: task.successProof?.evidenceSignals || [],
    networkEvidence: task.successProof?.networkEvidence || null,
    publicationStatus: task.publicationStatus,
    publicUrl: task.publicUrl || "",
    destinationUrl: url,
    evidenceUrl: task.evidenceUrl || "",
  });
  if (!proof.ok) throw new Error(`成功证据未通过硬闸门: ${proof.reason}`);
  const destinationKey = siteKeyForUrl(url);
  const storage = await chrome.storage.local.get(["submissionRecords"]);
  const records = storage.submissionRecords || {};
  const key = self.ExtLinkQueue.submissionRecordKey(destinationKey, profileId);
  const record = self.ExtLinkQueue.buildSuccessRecord({
    destinationKey,
    destinationUrl: url,
    profileId,
    profileName: task.profileName || task.config?.brandName || profileId,
    confirmedBy: task.confirmedBy || "agent",
    evidence: proof.evidence,
    publicUrl: task.publicUrl || "",
    evidenceUrl: proof.evidenceUrl || task.evidenceUrl || "",
    publicationStatus: task.publicationStatus,
  });
  record.evidenceType = proof.evidenceType;
  record.runId = state.runId || "";
  record.taskId = task.id || "";
  records[key] = record;
  await chrome.storage.local.set({
    submissionRecords: records,
    submissionSchemaVersion: SUBMISSION_SCHEMA_VERSION,
  });
  await addSubmissionTimelineEvent({
    destinationKey,
    destinationUrl: url,
    profileId,
    profileName: record.profileName,
    occurredAt: record.submittedAt,
    type: record.publicationStatus || "submitted",
    note: record.evidence,
    evidenceUrl: record.evidenceUrl,
    publicUrl: record.publicUrl,
    source: record.confirmedBy === "manual" ? "manual" : "agent",
    syncRecord: false,
  });
}

async function addToUrlList(msg) {
  const url = (msg.url || "").trim();
  if (!url) throw new Error("缺少 URL");
  const normalized = url.startsWith("http") ? url : `https://${url}`;
  const key = siteKeyForUrl(normalized);
  const storage = await chrome.storage.local.get([
    "urlList",
    "deletedSubmissionKeys",
    "siteAnnotations",
  ]);
  const lines = String(storage.urlList || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const exists = lines.some((line) => siteKeyForUrl(line.split("|")[0].trim()) === key);
  if (!exists) {
    // Prepend so newly found links sit at the front of the library.
    lines.unshift(`${normalized}|${msg.platformType || "directory"}`);
  }
  let deletedKeys = (storage.deletedSubmissionKeys || []).filter((k) => k !== key);
  const annotations = storage.siteAnnotations || {};
  delete annotations[key];
  const domain = self.ExtLinkQueue.extractDomain(normalized);
  delete annotations[domain];

  await chrome.storage.local.set({
    urlList: lines.join("\n"),
    deletedSubmissionKeys: deletedKeys,
    siteAnnotations: annotations,
  });
  return { ok: true, url: normalized, added: !exists, prepended: !exists };
}

async function removeFromSubmissionQueue(msg) {
  return markSubmissionSite({ url: msg.url, status: "deleted", note: msg.note || "" });
}

async function getLibraryManagerState(options = {}) {
  const storage = await chrome.storage.local.get([
    "urlList",
    "siteAnnotations",
    "submissionRecords",
    "siteProfiles",
    "activeSiteId",
    "selectedSiteIds",
    "submissionSchemaVersion",
    "domainMetricsCache",
    "linkMonitorResults",
    "submissionTimeline",
  ]);
  const tableData = await loadTableLibrary();
  const seeded = await ensureProfilesFromTable(
    tableData,
    storage.siteProfiles || {},
    storage.activeSiteId || "",
    storage.selectedSiteIds || [],
  );
  const records = await ensureSubmissionSchema(
    tableData,
    storage.siteAnnotations || {},
    storage.submissionRecords || {},
    storage.submissionSchemaVersion,
    seeded.idRemap,
  );
  const migratedTimeline = self.ExtLinkSubmissionTimeline.migrateLegacy({
    timeline: storage.submissionTimeline || {},
    submissionRecords: records,
    tableData,
    profileIdMap: seeded.idRemap,
  }).timeline;
  if (JSON.stringify(migratedTimeline) !== JSON.stringify(storage.submissionTimeline || {})) {
    await chrome.storage.local.set({
      submissionTimeline: migratedTimeline,
      timelineSchemaVersion: self.ExtLinkSubmissionTimeline.SCHEMA_VERSION,
    });
  }
  const timelineByDestination =
    self.ExtLinkSubmissionTimeline.groupByDestination(migratedTimeline);
  const pluginUrls = self.ExtLinkQueue.resolvePluginUrls(
    storage.urlList || "",
    self.ExtLinkUrlLibrary || [],
  );
  const candidates = [
    ...pluginUrls.filter((entry) => entry.source === "saved"),
    ...(tableData.entries || []).map((entry) => ({
      url: entry.indexPage || entry.link,
      domain: self.ExtLinkQueue.extractDomain(entry.indexPage || entry.link),
      source: "table",
      platformType: "directory",
      entry,
    })),
    ...pluginUrls.filter((entry) => entry.source !== "saved"),
  ];
  const seen = new Set();
  const urls = candidates.filter((entry) => {
    const key = siteKeyForUrl(entry.url || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const requestedKey = siteKeyForUrl(options.url || "");
  const requestedDomain = requestedKey
    ? self.ExtLinkQueue.extractDomain(options.url)
    : "";
  const exactUrls = requestedKey
    ? urls.filter((entry) => siteKeyForUrl(entry.url) === requestedKey)
    : [];
  const scopedUrls = requestedKey
    ? exactUrls.length
      ? exactUrls
      : urls.filter((entry) => {
          const domain = entry.domain || self.ExtLinkQueue.extractDomain(entry.url);
          return domain === requestedDomain;
        })
    : urls;
  const annotations = storage.siteAnnotations || {};
  const items = scopedUrls.map((entry) => {
    const key = siteKeyForUrl(entry.url);
    const annotation = annotations[key] || annotations[entry.domain] || null;
    const domain = entry.domain || self.ExtLinkQueue.extractDomain(entry.url);
    const monitorStatuses = Object.entries(records)
      .filter(([, record]) => record?.destinationKey === key)
      .map(([recordKey]) => storage.linkMonitorResults?.[recordKey]?.status)
      .filter(Boolean);
    const monitorStatus = monitorStatuses.includes("missing")
      ? "missing"
      : monitorStatuses.includes("unreachable")
        ? "unreachable"
        : monitorStatuses.includes("live")
          ? "live"
          : "";
    const quality = self.ExtLinkOpportunityScore.scoreOpportunity({
      metrics: {
        ...(entry.entry?.metrics || {}),
        ...((storage.domainMetricsCache || {})[domain] || {}),
      },
      annotation,
      monitorStatus,
    });
    const destinationTimeline = timelineByDestination[key] || null;
    const events = (destinationTimeline?.profiles || [])
      .flatMap((profile) => profile.events || [])
      .sort((left, right) => {
        const leftTime = Date.parse(left.occurredAt || "") || 0;
        const rightTime = Date.parse(right.occurredAt || "") || 0;
        return rightTime - leftTime;
      });
    const profileStatuses = Object.values(seeded.profiles).map((profile) => {
      const recordKey = self.ExtLinkQueue.submissionRecordKey(key, profile.id);
      const record = records[recordKey] || null;
      const timelineProfile = destinationTimeline?.groups?.[recordKey] || null;
      return {
        profileId: profile.id,
        profileName: profile.name || profile.id,
        success: self.ExtLinkQueue.isSubmissionSuccessful(records, key, profile.id),
        submittedAt: record?.submittedAt || "",
        publicationStatus: record?.publicationStatus || "",
        latestEvent: timelineProfile?.current || null,
        eventCount: timelineProfile?.events?.length || 0,
      };
    });
    const playbook =
      self.ExtLinkPlaybooks && typeof self.ExtLinkPlaybooks.lookup === "function"
        ? self.ExtLinkPlaybooks.lookup(domain)
        : null;
    return {
      key,
      url: entry.url,
      domain,
      source: entry.source || "library",
      platformType: entry.platformType || "directory",
      position: urls.indexOf(entry),
      annotation,
      quality,
      monitorStatus,
      metrics: quality.metrics,
      profileStatuses,
      playbook: playbook
        ? { id: playbook.id, title: playbook.title, notes: playbook.notes }
        : null,
      note: entry.entry?.note || annotation?.note || "",
      record: entry.entry?.record || "",
      detail: entry.entry?.detail || "",
      rawFields: entry.entry?.rawFields || {},
      rowNumber: entry.entry?.rowNumber || null,
      projects: entry.entry?.projects || [],
      time: entry.entry?.time || "",
      events,
      latestEvent: events[0] || null,
    };
  });
  items.sort(self.ExtLinkOpportunityScore.compareOpportunities);
  return { ok: true, items, profiles: seeded.profiles };
}

function applyTimelinePublicationUpgrade(records, event) {
  const profileId = String(event.profileId || "").trim();
  if (
    !profileId ||
    profileId === "__destination__" ||
    !["submitted", "pending_moderation", "published"].includes(event.type)
  ) {
    return { records, updatedRecord: null };
  }
  const next = { ...records };
  const recordKey = self.ExtLinkQueue.submissionRecordKey(event.destinationKey, profileId);
  const existing = next[recordKey] || null;
  const updatedRecord = existing
    ? self.ExtLinkQueue.applyPublicationUpgrade(existing, event.type, {
        updatedAt: event.occurredAt,
        evidence: event.note || existing.evidence || "人工记录状态变化",
        evidenceUrl: event.evidenceUrl || existing.evidenceUrl || "",
        publicUrl: event.publicUrl || existing.publicUrl || "",
      })
    : self.ExtLinkQueue.buildSuccessRecord({
        destinationKey: event.destinationKey,
        destinationUrl: event.destinationUrl,
        profileId,
        profileName: event.profileName || profileId,
        submittedAt: event.occurredAt,
        confirmedBy: "manual",
        evidence: event.note || `人工记录：${event.type}`,
        evidenceUrl: event.evidenceUrl || "",
        publicUrl: event.publicUrl || "",
        publicationStatus: event.type,
      });
  next[recordKey] = updatedRecord;
  return { records: next, updatedRecord };
}

async function addSubmissionTimelineEvent(msg = {}) {
  const storage = await chrome.storage.local.get([
    "submissionTimeline",
    "submissionRecords",
  ]);
  const profileId = String(msg.profileId || "").trim();
  if (!profileId) throw new Error("请选择要记录的网站项目");
  const event = self.ExtLinkSubmissionTimeline.normalizeEvent({
    destinationKey: msg.destinationKey,
    destinationUrl: msg.destinationUrl,
    profileId,
    profileName: msg.profileName,
    occurredAt: msg.occurredAt,
    type: msg.type,
    status: msg.type,
    note: msg.note,
    evidenceUrl: msg.evidenceUrl,
    publicUrl: msg.publicUrl,
    source: msg.source || "manual",
    confirmedBy: msg.source === "agent" ? "agent" : "manual",
  });
  const submissionTimeline = self.ExtLinkSubmissionTimeline.append(
    storage.submissionTimeline || {},
    event,
  );
  const update = {
    submissionTimeline,
    timelineSchemaVersion: self.ExtLinkSubmissionTimeline.SCHEMA_VERSION,
  };
  const upgraded = applyTimelinePublicationUpgrade(storage.submissionRecords || {}, event);
  if (upgraded.updatedRecord) {
    update.submissionRecords = upgraded.records;
    update.submissionSchemaVersion = SUBMISSION_SCHEMA_VERSION;
  }
  await chrome.storage.local.set(update);
  return { ok: true, event, record: upgraded.updatedRecord };
}

async function updateSubmissionTimelineEvent(msg = {}) {
  const storage = await chrome.storage.local.get([
    "submissionTimeline",
    "submissionRecords",
  ]);
  const eventId = String(msg.eventId || "").trim();
  if (!eventId) throw new Error("缺少动态编号");
  const profileId = String(msg.profileId || "").trim();
  if (!profileId) throw new Error("请选择要记录的网站项目");
  const result = self.ExtLinkSubmissionTimeline.updateEvent(storage.submissionTimeline || {}, eventId, {
    destinationKey: msg.destinationKey,
    destinationUrl: msg.destinationUrl,
    profileId,
    profileName: msg.profileName,
    occurredAt: msg.occurredAt,
    type: msg.type,
    status: msg.type,
    note: msg.note,
    evidenceUrl: msg.evidenceUrl,
    publicUrl: msg.publicUrl,
    source: msg.source || "manual",
    confirmedBy: "manual",
  });
  const update = {
    submissionTimeline: result.timeline,
    timelineSchemaVersion: self.ExtLinkSubmissionTimeline.SCHEMA_VERSION,
  };
  const upgraded = applyTimelinePublicationUpgrade(storage.submissionRecords || {}, result.event);
  if (upgraded.updatedRecord) {
    update.submissionRecords = upgraded.records;
    update.submissionSchemaVersion = SUBMISSION_SCHEMA_VERSION;
  }
  await chrome.storage.local.set(update);
  return { ok: true, event: result.event, record: upgraded.updatedRecord };
}

async function removeSubmissionTimelineEvent(msg = {}) {
  const storage = await chrome.storage.local.get(["submissionTimeline"]);
  const eventId = String(msg.eventId || "").trim();
  if (!eventId) throw new Error("缺少动态编号");
  const result = self.ExtLinkSubmissionTimeline.removeEvent(storage.submissionTimeline || {}, eventId);
  await chrome.storage.local.set({
    submissionTimeline: result.timeline,
    timelineSchemaVersion: self.ExtLinkSubmissionTimeline.SCHEMA_VERSION,
  });
  return { ok: true, event: result.event };
}

async function pinLibraryUrl(msg) {
  const url = String(msg.url || "").trim();
  if (!url) throw new Error("缺少 URL");
  const storage = await chrome.storage.local.get(["urlList"]);
  const lines = String(storage.urlList || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const key = siteKeyForUrl(url);
  const existing = lines.find((line) => siteKeyForUrl(line.split("|")[0].trim()) === key);
  const next = lines.filter((line) => siteKeyForUrl(line.split("|")[0].trim()) !== key);
  next.unshift(existing || `${url}|directory`);
  await chrome.storage.local.set({ urlList: next.join("\n") });
  return { ok: true };
}

async function exportSubmissionData() {
  const storage = await chrome.storage.local.get([
    "submissionRecords",
    "submissionSchemaVersion",
    "siteAnnotations",
    "siteProfiles",
    "activeSiteId",
    "selectedSiteIds",
    "urlList",
    "submissionTimeline",
    "timelineSchemaVersion",
    "sheetTableData",
  ]);
  return {
    ok: true,
    data: {
      format: self.ExtLinkBackup.FORMAT,
      version: SUBMISSION_SCHEMA_VERSION,
      exportedAt: new Date().toISOString(),
      submissionRecords: storage.submissionRecords || {},
      siteAnnotations: storage.siteAnnotations || {},
      siteProfiles: storage.siteProfiles || {},
      activeSiteId: storage.activeSiteId || "",
      selectedSiteIds: storage.selectedSiteIds || [],
      urlList: storage.urlList || "",
      submissionTimeline: storage.submissionTimeline || {},
      timelineSchemaVersion:
        storage.timelineSchemaVersion || self.ExtLinkSubmissionTimeline.SCHEMA_VERSION,
      sheetTableData: storage.sheetTableData || null,
    },
  };
}

async function importSubmissionData(data) {
  const storage = await chrome.storage.local.get([
    "submissionRecords",
    "siteAnnotations",
    "siteProfiles",
    "urlList",
    "submissionTimeline",
    "timelineSchemaVersion",
    "sheetTableData",
  ]);
  const importedProfiles =
    data?.siteProfiles && typeof data.siteProfiles === "object" ? data.siteProfiles : {};
  const merged = self.ExtLinkBackup.mergeBackup(storage, data, SUBMISSION_SCHEMA_VERSION);
  if (data?.sheetTableData && typeof data.sheetTableData === "object") {
    merged.sheetTableData = data.sheetTableData;
  }
  await chrome.storage.local.set(merged);
  return {
    ok: true,
    recordsImported: Object.keys(data.submissionRecords).length,
    profilesImported: Object.keys(importedProfiles).length,
  };
}

function clampScheduleMinutes(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(7 * 24 * 60, Math.max(15, Math.round(parsed))) : fallback;
}

async function configureScheduledChecks() {
  const storage = await chrome.storage.local.get([
    "linkMonitorEnabled",
    "linkMonitorMinutes",
  ]);
  const defaults = {};
  if (storage.linkMonitorEnabled === undefined) defaults.linkMonitorEnabled = true;
  if (storage.linkMonitorMinutes === undefined) {
    defaults.linkMonitorMinutes = DEFAULT_LINK_MONITOR_MINUTES;
  }
  if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);

  const monitorEnabled = storage.linkMonitorEnabled !== false;
  const monitorMinutes = clampScheduleMinutes(
    storage.linkMonitorMinutes,
    DEFAULT_LINK_MONITOR_MINUTES,
  );
  await chrome.alarms.clear(LINK_MONITOR_ALARM);
  if (monitorEnabled) {
    chrome.alarms.create(LINK_MONITOR_ALARM, {
      delayInMinutes: 5,
      periodInMinutes: monitorMinutes,
    });
  }
}

function checkablePublicUrl(record) {
  for (const value of [record?.publicUrl, record?.evidenceUrl]) {
    const url = String(value || "").trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  return "";
}

function targetHostForProfile(profile) {
  const value = profile?.url || profile?.promoUrl || profile?.fields?.Url || "";
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

function detectLinkRel(html, targetHost) {
  if (!targetHost) return { found: false, rel: "" };
  const escaped = targetHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anchorPattern = new RegExp(`<a\\b[^>]*href=["'][^"']*${escaped}[^"']*["'][^>]*>`, "i");
  const anchor = String(html || "").match(anchorPattern)?.[0] || "";
  if (!anchor) return { found: false, rel: "" };
  const rel = anchor.match(/\brel=["']([^"']*)["']/i)?.[1]?.toLowerCase() || "";
  if (/\bnofollow\b/.test(rel)) return { found: true, rel: "nofollow" };
  if (/\bsponsored\b/.test(rel)) return { found: true, rel: "sponsored" };
  if (/\bugc\b/.test(rel)) return { found: true, rel: "ugc" };
  return { found: true, rel: "dofollow" };
}

async function inspectPublishedLink(record, profile) {
  const url = checkablePublicUrl(record);
  const targetHost = targetHostForProfile(profile);
  const checkedAt = new Date().toISOString();
  if (!url || !targetHost) {
    return { status: "uncheckable", checkedAt, url, targetHost, targetFound: false, rel: "" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { status: "unreachable", checkedAt, url, targetHost, httpStatus: response.status, targetFound: false, rel: "" };
    }
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    if (!contentType.includes("text/html")) {
      return { status: "uncheckable", checkedAt, url, targetHost, httpStatus: response.status, targetFound: false, rel: "" };
    }
    const html = (await response.text()).slice(0, 2_000_000);
    const link = detectLinkRel(html, targetHost);
    return {
      status: link.found ? "live" : "missing",
      checkedAt,
      url: response.url || url,
      targetHost,
      httpStatus: response.status,
      targetFound: link.found,
      rel: link.rel,
    };
  } catch (err) {
    return { status: "unreachable", checkedAt, url, targetHost, error: err.name === "AbortError" ? "timeout" : err.message, targetFound: false, rel: "" };
  } finally {
    clearTimeout(timer);
  }
}

async function getLinkMonitorState() {
  const storage = await chrome.storage.local.get([
    "linkMonitorEnabled",
    "linkMonitorMinutes",
    "linkMonitorResults",
    "linkMonitorLastRunAt",
    "submissionRecords",
  ]);
  const records = Object.values(storage.submissionRecords || {}).filter((record) => record?.status === "success");
  return {
    ok: true,
    enabled: storage.linkMonitorEnabled !== false,
    minutes: Number(storage.linkMonitorMinutes || DEFAULT_LINK_MONITOR_MINUTES),
    lastRunAt: storage.linkMonitorLastRunAt || "",
    totalSuccesses: records.length,
    checkable: records.filter(checkablePublicUrl).length,
    results: storage.linkMonitorResults || {},
  };
}

async function saveLinkMonitorSchedule(msg = {}) {
  const enabled = msg.enabled !== false;
  const minutes = clampScheduleMinutes(msg.minutes, DEFAULT_LINK_MONITOR_MINUTES);
  await chrome.storage.local.set({ linkMonitorEnabled: enabled, linkMonitorMinutes: minutes });
  await configureScheduledChecks();
  return { ok: true, enabled, minutes };
}

async function runLinkMonitor({ notify = false, force = false } = {}) {
  const storage = await chrome.storage.local.get([
    "linkMonitorEnabled",
    "submissionRecords",
    "siteProfiles",
    "linkMonitorResults",
  ]);
  if (storage.linkMonitorEnabled === false && !force) return { ok: true, disabled: true, checked: 0, results: storage.linkMonitorResults || {} };
  const previous = storage.linkMonitorResults || {};
  const candidates = Object.entries(storage.submissionRecords || {}).filter(
    ([, record]) => record?.status === "success" && checkablePublicUrl(record),
  );
  const candidateKeys = new Set(candidates.map(([key]) => key));
  const results = Object.fromEntries(
    Object.entries(previous).filter(([key]) => candidateKeys.has(key)),
  );
  const changedToProblem = [];
  for (const [key, record] of candidates) {
    const result = await inspectPublishedLink(record, (storage.siteProfiles || {})[record.profileId]);
    if (previous[key]?.status === "live" && ["missing", "unreachable"].includes(result.status)) {
      changedToProblem.push({ key, record, result });
    }
    results[key] = result;
  }
  const lastRunAt = new Date().toISOString();
  const nextRecords = { ...(storage.submissionRecords || {}) };
  let publicationUpgrades = 0;
  for (const [key, record] of candidates) {
    const result = results[key];
    if (result?.status !== "live" || !record) continue;
    const upgraded = self.ExtLinkQueue.applyPublicationUpgrade(record, "published", {
      publicUrl: record.publicUrl || result.url || "",
    });
    if (upgraded.publicationStatus !== record.publicationStatus || upgraded.publicUrl !== record.publicUrl) {
      nextRecords[key] = upgraded;
      publicationUpgrades += 1;
    }
  }
  const storageUpdate = { linkMonitorResults: results, linkMonitorLastRunAt: lastRunAt };
  if (publicationUpgrades) storageUpdate.submissionRecords = nextRecords;
  await chrome.storage.local.set(storageUpdate);
  for (const [key, record] of candidates) {
    const result = results[key];
    if (result?.status !== "live" || record?.publicationStatus === "published") continue;
    await addSubmissionTimelineEvent({
      destinationKey: record.destinationKey,
      destinationUrl: record.destinationUrl,
      profileId: record.profileId,
      profileName: record.profileName,
      occurredAt: lastRunAt,
      type: "published",
      note: "发布链接监控确认外链已上线",
      publicUrl: record.publicUrl || result.url || "",
      source: "agent",
      syncRecord: false,
    });
  }
  for (const { record, result } of changedToProblem) {
    await addSubmissionTimelineEvent({
      destinationKey: record.destinationKey,
      destinationUrl: record.destinationUrl,
      profileId: record.profileId,
      profileName: record.profileName,
      occurredAt: lastRunAt,
      type: "link_missing",
      note: result.status === "unreachable" ? "发布链接当前无法访问，请人工复查" : "发布页面未发现目标外链，请人工复查",
      evidenceUrl: result.url || record.publicUrl || record.evidenceUrl || "",
      source: "agent",
    });
  }
  if (notify && changedToProblem.length) {
    chrome.notifications.create("externallink-links-changed", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "ExternalLink 检测到链接变化",
      message: `${changedToProblem.length} 条曾经存活的外链当前缺失或无法访问，请人工复查。`,
    });
  }
  const counts = Object.values(results).reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: true,
    checked: candidates.length,
    changedToProblem: changedToProblem.length,
    publicationUpgrades,
    counts,
    results,
    lastRunAt,
  };
}

function broadcastAutoFillUpdate(payload) {
  chrome.runtime.sendMessage({ action: "autoFillUpdate", ...payload }).catch(() => {});
}

async function loadTableLibrary() {
  let tableData = { entries: [], projects: {} };
  try {
    const res = await fetch(chrome.runtime.getURL("table-library.json"));
    if (res.ok) tableData = await res.json();
  } catch {
    /* The first-run snapshot is optional once the cloud cache exists. */
  }
  const { sheetTableData } = await chrome.storage.local.get("sheetTableData");
  if (
    sheetTableData &&
    typeof sheetTableData === "object" &&
    Array.isArray(sheetTableData.entries) &&
    sheetTableData.projects &&
    typeof sheetTableData.projects === "object"
  ) {
    return { source: "cloud-cache", ...sheetTableData };
  }
  if (Array.isArray(tableData.entries) && tableData.projects && typeof tableData.projects === "object") {
    await chrome.storage.local.set({ sheetTableData: tableData });
  }
  return { source: "bundled-first-run", ...tableData };
}

async function ensureProfilesFromTable(
  tableData,
  storedProfiles,
  activeSiteId,
  selectedSiteIds = [],
) {
  const stabilized = self.ExtLinkProfiles.stabilizeTableProfiles(
    tableData?.projects || {},
    storedProfiles || {},
  );
  const { profiles, idRemap } = stabilized;
  const remapId = (id) => idRemap[id] || id;
  const remappedActiveSiteId = remapId(activeSiteId);
  const nextActiveSiteId =
    remappedActiveSiteId && profiles[remappedActiveSiteId]
      ? remappedActiveSiteId
      : Object.keys(profiles)[0] || "";
  const nextSelectedSiteIds = [
    ...new Set(
      (selectedSiteIds || [])
        .map(remapId)
        .filter((id) => profiles[id]),
    ),
  ];
  const selectionChanged =
    JSON.stringify(nextSelectedSiteIds) !== JSON.stringify(selectedSiteIds || []);
  if (
    stabilized.changed ||
    nextActiveSiteId !== activeSiteId ||
    selectionChanged
  ) {
    await chrome.storage.local.set({
      siteProfiles: profiles,
      activeSiteId: nextActiveSiteId,
      selectedSiteIds: nextSelectedSiteIds,
    });
  }
  return {
    profiles,
    activeSiteId: nextActiveSiteId,
    selectedSiteIds: nextSelectedSiteIds,
    idRemap,
  };
}

async function ensureSubmissionSchema(
  tableData,
  annotations,
  existingRecords,
  schemaVersion,
  idRemap = {},
) {
  const seededRecords = { ...(existingRecords || {}) };
  for (const [key, seedRecord] of Object.entries(tableData?.submissionRecords || {})) {
    seededRecords[key] = seededRecords[key]
      ? self.ExtLinkQueue.mergePublicationFields(seededRecords[key], seedRecord)
      : seedRecord;
  }
  const remappedRecords = self.ExtLinkQueue.remapSubmissionRecords(
    seededRecords,
    idRemap,
  );
  const migration = self.ExtLinkQueue.migrateSubmissionRecords({
    records: remappedRecords,
    annotations: annotations || {},
    tableData,
  });
  const recordsChanged =
    JSON.stringify(remappedRecords) !== JSON.stringify(existingRecords || {});
  if (
    schemaVersion !== SUBMISSION_SCHEMA_VERSION ||
    migration.migratedCount > 0 ||
    recordsChanged
  ) {
    await chrome.storage.local.set({
      submissionRecords: migration.records,
      submissionSchemaVersion: SUBMISSION_SCHEMA_VERSION,
    });
  }
  return migration.records;
}

async function loadPendingSubmissionTasks(options = {}) {
  const storage = await chrome.storage.local.get([
    "siteProfiles",
    "activeSiteId",
    "selectedSiteIds",
    "urlList",
    "cfgEmail",
    "cfgName",
    "deletedSubmissionKeys",
    "siteAnnotations",
    "submissionRecords",
    "submissionSchemaVersion",
    "domainBlacklist",
    "targetFilters",
    "domainMetricsCache",
  ]);
  const tableData = await loadTableLibrary();
  const seeded = await ensureProfilesFromTable(
    tableData,
    storage.siteProfiles || {},
    storage.activeSiteId || "",
    storage.selectedSiteIds || [],
  );
  const annotations = storage.siteAnnotations || {};
  const submissionRecords = await ensureSubmissionSchema(
    tableData,
    annotations,
    storage.submissionRecords || {},
    storage.submissionSchemaVersion,
    seeded.idRemap,
  );

  const pluginUrls = self.ExtLinkQueue.resolvePluginUrls(
    storage.urlList || "",
    self.ExtLinkUrlLibrary || [],
  );
  const buildFromProfile = (profile) =>
    self.ExtLinkProfiles.buildAgentConfigFromProfile(profile, {
      email: storage.cfgEmail,
      username: storage.cfgName,
    });

  const requestedProfileIds = Array.isArray(options.selectedProfileIds)
    ? options.selectedProfileIds
    : Array.isArray(storage.selectedSiteIds)
      ? storage.selectedSiteIds
      : [];
  const selectedProfileIds = [
    ...new Set(
      requestedProfileIds
        .map((id) => seeded.idRemap[id] || id)
        .filter((id) => seeded.profiles[id]),
    ),
  ];
  if (!selectedProfileIds.length && seeded.activeSiteId) {
    selectedProfileIds.push(seeded.activeSiteId);
  }

  const groups = self.ExtLinkQueue.buildDestinationGroups({
    tableData,
    pluginUrls,
    siteProfiles: seeded.profiles,
    selectedProfileIds,
    submissionRecords,
    annotations,
    findMatchingProfile: self.ExtLinkProfiles.findMatchingProfile,
    buildAgentConfigFromProfile: buildFromProfile,
  }).map((group) => {
    const ageMetric = (storage.domainMetricsCache || {})[group.domain] || {};
    const quality = self.ExtLinkOpportunityScore.scoreOpportunity({
      metrics: { ...(group.entry?.metrics || {}), ...ageMetric },
      annotation: annotations[group.destinationKey] || annotations[group.domain] || null,
    });
    return { ...group, quality };
  }).sort(self.ExtLinkOpportunityScore.compareOpportunities);

  const deletedKeys = storage.deletedSubmissionKeys || [];
  const filters = normalizeTargetFilters(storage.targetFilters);
  const flattened = self.ExtLinkQueue.flattenDestinationGroups(groups);
  const gated = self.ExtLinkQueue.filterSubmissionTasks(flattened, {
    deletedKeys,
    annotations,
    blacklist: filters.blacklistEnabled ? storage.domainBlacklist || [] : [],
    minDomainAgeMonths: filters.minDomainAgeMonths,
    requireKnownDomainAge: filters.requireKnownDomainAge,
    domainMetrics: storage.domainMetricsCache || {},
    collectExclusions: true,
  });
  const gateExclusions = gated.gateExclusions || [];
  const filtered = gated.filter((task) => {
    if (!(filters.minOpportunityScore > 0)) return true;
    if (Number(task.quality?.score || 0) >= filters.minOpportunityScore) return true;
    gateExclusions.push({ key: task.key, domain: task.domain, reason: "low_opportunity_score" });
    return false;
  });

  return {
    tasks: filtered,
    groups,
    selectedProfileIds,
    gateExclusions,
    meta: {
      gatedByBlacklist: gateExclusions.filter((item) => item.reason === "blacklist").length,
      gatedByDomainAge: gateExclusions.filter((item) =>
        ["domain_age", "domain_age_unknown"].includes(item.reason),
      ).length,
      gatedByQuality: gateExclusions.filter((item) => item.reason === "low_opportunity_score").length,
      fromTable: groups.filter((group) => group.source === "table").length,
      fromPlugin: groups.filter((group) => group.source !== "table").length,
      beforeFilter: flattened.length,
      excluded: flattened.length - filtered.length,
      total: filtered.length,
      destinationTotal: groups.length,
      selectedProfileTotal: selectedProfileIds.length,
      successfulSkipped: Object.values(submissionRecords).filter(
        (record) =>
          record?.status === "success" && selectedProfileIds.includes(record.profileId),
      ).length,
    },
  };
}

async function getSubmissionQueueState(msg = {}) {
  const { groups, tasks: jobs, meta, selectedProfileIds } = await loadPendingSubmissionTasks({
    selectedProfileIds: msg.selectedSiteIds,
  });
  const storage = await chrome.storage.local.get(["submissionQueueIndex", "submissionQueueKey"]);
  let index = Number.isFinite(storage.submissionQueueIndex) ? storage.submissionQueueIndex : 0;

  if (msg.url) {
    const matched = self.ExtLinkQueue.findSubmissionIndex(msg.url, groups);
    if (matched >= 0) {
      index = matched;
    }
  } else if (storage.submissionQueueKey) {
    const matched = groups.findIndex((group) => group.key === storage.submissionQueueKey);
    if (matched >= 0) index = matched;
  }

  if (index < 0 || index >= groups.length) index = 0;
  const currentKey = groups[index]?.key || "";
  await chrome.storage.local.set({
    submissionQueueIndex: index,
    submissionQueueKey: currentKey,
  });
  return {
    ok: true,
    tasks: groups.map(toSubmissionGroupSummary),
    index,
    total: groups.length,
    meta,
    selectedProfileIds,
  };
}

function toSubmissionGroupSummary(group) {
  return {
    id: group.id,
    key: group.key,
    destinationKey: group.destinationKey,
    url: group.url,
    domain: group.domain,
    platformType: group.platformType,
    source: group.source,
    note: group.note,
    quality: group.quality || null,
    status: group.status,
    index: group.index,
    profileIds: (group.jobs || []).map((job) => job.profileId),
    profileTotal: (group.jobs || []).length,
    profiles: (group.jobs || []).map((job) => ({
      profileId: job.profileId,
      profileName: job.profileName,
      status: job.status || "pending",
    })),
  };
}

function isSidepanelSender(sender, msg) {
  if (msg?.fromSidepanel === true) return true;
  return String(sender?.url || "").includes("sidepanel.html");
}

async function handleRequestAutoFill(msg, sender) {
  const tabId = msg.tabId || sender?.tab?.id;
  if (!tabId) return;

  if (!isSidepanelSender(sender, msg) && !sidePanelOpen) return;

  if (state.activeTabs.has(tabId)) return;
  if (autoFillInProgress.has(tabId)) return;

  const storage = await chrome.storage.local.get([
    "autoFillOnVisit",
    "siteProfiles",
    "activeSiteId",
    "siteAnnotations",
  ]);
  if (storage.autoFillOnVisit === false) return;

  const profile = self.ExtLinkProfiles.getActiveProfile(storage);
  if (!self.ExtLinkProfiles.profileConfigured(profile)) return;

  let tabUrl = msg.url || "";
  if (!tabUrl) {
    try {
      const tab = await chrome.tabs.get(tabId);
      tabUrl = tab.url || "";
    } catch {
      return;
    }
  }
  if (!/^https?:\/\//i.test(tabUrl)) return;

  const { tasks: pendingTasks } = await loadPendingSubmissionTasks();
  const matched = self.ExtLinkQueue.matchSubmissionTarget(tabUrl, pendingTasks, profile.id);
  if (!matched) return;

  const key = siteKeyForUrl(tabUrl);
  const domain = self.ExtLinkQueue.extractDomain(tabUrl);
  const ann = (storage.siteAnnotations || {})[key] || (storage.siteAnnotations || {})[domain];
  if (ann && self.ExtLinkQueue.isDeadEndStatus(ann.status)) return;

  const matchedIndex = pendingTasks.findIndex(
    (t) => t.id === matched.id || (t.key === matched.key && (t.profileId || t.projectKey) === profile.id),
  );
  if (matchedIndex >= 0) {
    await chrome.storage.local.set({ submissionQueueIndex: matchedIndex });
    broadcastAutoFillUpdate({
      tabId,
      status: "queue",
      index: matchedIndex,
      total: pendingTasks.length,
      domain: matched.domain,
      profileId: profile.id,
    });
  }

  const existing = autoFillTimers.get(tabId);
  if (existing) clearTimeout(existing);

  autoFillTimers.set(
    tabId,
    setTimeout(async () => {
      autoFillTimers.delete(tabId);
      if (autoFillInProgress.has(tabId)) return;
      try {
        const latest = await chrome.storage.local.get(["siteProfiles", "activeSiteId"]);
        const latestProfile = self.ExtLinkProfiles.getActiveProfile(latest);
        if (!latestProfile || latestProfile.id !== profile.id) return;

        const detection = await sendTabMessage(tabId, { action: "detectPage" });
        if (!detection?.operable && !(detection?.formFieldCount > 0)) return;

        autoFillInProgress.add(tabId);
        const result = await handleSidepanelFill({
          tabId,
          mode: "form",
          useAgent: true,
          auto: true,
          profileId: latestProfile.id,
        });
        if (result?.error && !result?.ok && !result?.advance) {
          log(`自动填表: ${result.error}`, "warn");
        } else if (result?.ok) {
          log(`自动填表完成: ${result.filledCount || 0} 个字段`, "ok");
        }
        if (result?.advance) {
          // Keep current tab for captcha/login/paid review; open next pending site in a new tab.
          try {
            const next = await advanceSubmissionQueue({ delta: 1, open: false });
            if (next?.task?.url) {
              const nextUrl = next.task.url.startsWith("http")
                ? next.task.url
                : `https://${next.task.url}`;
              await chrome.tabs.create({ url: nextUrl, active: true });
              log(
                `遇闸/分类（${result.classified || "manual"}），已开下一站: ${next.task.domain}`,
                "warn",
              );
            }
          } catch (err) {
            log(`自动下一站失败: ${err.message}`, "warn");
          }
        }
      } catch (err) {
        log(`自动填表: ${err.message}`, "warn");
      } finally {
        autoFillInProgress.delete(tabId);
      }
    }, AUTO_FILL_DEBOUNCE_MS),
  );
}

async function runSidepanelAgentFill(tabId, config, platformType, maxLoops) {
  const fakeTask = {
    index: 0,
    domain: "sidepanel",
    url: "",
    platformType: platformType || "auto",
    projectKey: config.projectKey || "",
    config,
  };

  let snapshot = await getTabSnapshot(tabId);
  const loops = Math.max(1, Math.min(maxLoops || MAX_AGENT_LOOPS, MAX_AGENT_LOOPS));
  for (let loop = 0; loop < loops; loop++) {
    const plan = await callCloudAgent(
      "/plan",
      agentPayload(fakeTask, snapshot, { config, fillOnly: true }),
    );

    if (plan.status === "needs_manual") {
      return { needs_manual: true, reason: plan.reason || plan.message || "需要人工处理" };
    }
    if (plan.status === "blocked" || plan.status === "error") {
      return {
        blocked: true,
        needs_manual: false,
        reason: plan.reason || plan.message || "无法提交",
        error: plan.reason || plan.message || "AI 无法处理此页面",
      };
    }
    if (plan.status !== "act" || !plan.actions?.length) {
      return { error: plan.reason || "无可用填表动作" };
    }

    try {
      await executeTabActions(tabId, plan.actions);
    } catch (actionError) {
      await executeVisualFallback(tabId, fakeTask, snapshot, actionError.message);
    }
    await sleep(AGENT_ACTION_SETTLE_MS);
    snapshot = await getTabSnapshot(tabId);
  }

  return { ok: true, fillOnly: true };
}

// ─── Queue Processing ───
async function processQueue() {
  while (self.ExtLinkBatchControls.shouldProcessQueue(state) && state.queue.length > 0) {
    while (
      self.ExtLinkBatchControls.shouldProcessQueue(state) &&
      countProcessingTabs() < state.concurrency &&
      state.queue.length > 0
    ) {
      const group = state.queue.shift();
      await processOne(group);
    }
    await sleep(500);
  }
  await refreshBatchRunStatus();
}

function scheduleQueueProcessing() {
  if (processQueuePromise) return processQueuePromise;
  processQueuePromise = processQueue()
    .catch((err) => {
      state.running = false;
      log(`批量调度异常: ${err.message}`, "err", {
        event: "queue_failed",
        stack: err.stack,
      });
      broadcastStatus();
    })
    .finally(() => {
      processQueuePromise = null;
      if (
        self.ExtLinkBatchControls.shouldProcessQueue(state) &&
        state.queue.length > 0
      ) {
        scheduleQueueProcessing();
      }
    });
  return processQueuePromise;
}

async function refreshBatchRunStatus() {
  const hasProcessing = countProcessingTabs() > 0;
  const hasQueuedGroups = state.queue.some((group) =>
    (group.tasks || []).some((task) => task.status === "pending"),
  );
  const hasParkedTasks =
    state.parkedTaskIds.size > 0 ||
    [...state.activeTabs.values()].some((entry) => entry.slotActive === false);
  if (state.paused && !state.stopped) {
    state.running = true;
    await persistActiveBatchStatus("paused", { pausedAt: new Date().toISOString() });
    broadcastStatus();
    await flushBatchLogEntries();
    return;
  }
  if (!state.stopped && (hasProcessing || hasQueuedGroups)) {
    state.running = true;
    return;
  }

  state.running = false;
  const finalStatus = state.stopped ? "stopped" : hasParkedTasks ? "waiting_manual" : "finished";
  await updateActiveBatchRun((activeBatchRun) => ({
    ...activeBatchRun,
    status: finalStatus,
    ...(finalStatus === "finished" ? { finishedAt: new Date().toISOString() } : {}),
    ...(finalStatus === "stopped" ? { stoppedAt: new Date().toISOString() } : {}),
    tasks: serializeBatchTasks(state.tasks),
    parkedTaskIds: [...state.parkedTaskIds],
  }));
  broadcastStatus();
  if (finalStatus === "stopped") log("任务已停止", "warn", { event: "run_stopped" });
  else if (hasParkedTasks) log("自动队列已跑完，仍有停放任务等待人工处理", "warn");
  else log("✅ 所有任务处理完毕", "ok", { event: "run_finished" });
  if (["finished", "stopped"].includes(finalStatus)) await finishAutomationRunLedger(finalStatus);
  else if (finalStatus === "waiting_manual") {
    await recordAutomationEvent(null, {
      taskId: "run-event",
      type: "run_waiting_manual",
      status: "waiting_manual",
    }, { runStatus: "waiting_manual" });
  }
  await flushBatchLogEntries();
}

async function processOne(group) {
  let task = null;
  const batchRunId = state.runId;
  try {
    if (!self.ExtLinkBatchControls.shouldProcessQueue(state)) {
      state.queue.unshift(group);
      return;
    }
    task = (group?.tasks || []).find((item) => item.status === "pending");
    if (!task) return;
    task._attempt = Math.max(0, Number(task._attempt) || 0) + 1;
    const configuredUrl = task.url.startsWith("http") ? task.url : "https://" + task.url;
    const url = isCustomLaunchTask(task)
      ? "https://www.producthunt.com/posts/new"
      : configuredUrl;
    log(`[${task.index}/${state.tasks.length}] 打开 ${task.domain} · ${task.profileName}`, "", {
      event: "task_opening",
      taskIndex: task.index,
      taskId: task.id,
      domain: task.domain,
      profileId: task.profileId,
    });
    task.status = "running";
    broadcastTaskUpdate(task);
    await recordAutomationEvent(task, {
      type: "task_opened",
      status: "running",
      result: url,
    });

    const tab = await chrome.tabs.create({ url, active: false });
    if (state.runId !== batchRunId || state.stopped || !state.running) {
      if (state.runId === batchRunId && state.stopped && task) {
        task.status = "pending";
        task.skipReason = "停止后自动任务未开始执行";
        broadcastTaskUpdate(task);
      }
      await chrome.tabs.remove(tab.id).catch(() => {});
      log(`已关闭过期批次创建的页签: ${task.domain}`, "warn", {
        event: "stale_tab_closed",
        taskIndex: task.index,
        domain: task.domain,
        profileId: task.profileId,
      });
      return;
    }
    const entry = {
      taskIndex: task.index,
      groupKey: group.key,
      timeoutId: null,
      runId: 0,
      slotActive: true,
      taskId: task.id,
      tabLoadComplete: tab.status === "complete",
      lastContentReady: null,
      readyProbe: null,
    };
    state.activeTabs.set(tab.id, entry);
    resetEntryTimeout(entry, tab.id, PAGE_LOAD_TIMEOUT_MS);
  } catch (err) {
    log(`创建标签页失败: ${group?.domain || group?.key || "unknown"} - ${err.message}`, "err");
    for (const task of group?.tasks || []) {
      if (!["pending", "running"].includes(task.status)) continue;
      task.status = "err";
      task.skipReason = err.message;
      broadcastTaskUpdate(task);
    }
  }
}

// ─── Content Script Callbacks ───
async function handleContentReady(tab, data = {}) {
  const entry = state.activeTabs.get(tab.id);
  if (!entry) return;
  if (state.stopped) return;
  if (entry.agentDone) return;
  entry.lastContentReady = data;
  if (entry.agentRunning) {
    entry.pendingRejudge = true;
    entry.contentReadyWhileRunning = true;
    return;
  }
  if (entry.readyCheckPromise) return;

  entry.readyCheckPromise = waitForTabContentReady(tab.id, entry, data)
    .then((readyData) => handleStableContentReady(tab, readyData))
    .catch((err) => {
      if (err?.batchPaused || err?.staleRun) return;
      const task = state.tasks.find((item) => item.index === entry.taskIndex);
      if (!task || !state.activeTabs.has(tab.id)) return;
      if (err?.readinessTimeout) {
        const reason = `页面加载/内容脚本未稳定，已等待 ${Math.round(
          CONTENT_READY_TIMEOUT_MS / 1000,
        )} 秒：${err.message}`;
        log(`${task.domain}: ${reason}`, "warn", {
          event: "content_ready_timeout",
          taskIndex: task.index,
          domain: task.domain,
          profileId: task.profileId,
        });
        markTaskNeedsManual(tab.id, task, entry, reason, "needs_manual");
        return;
      }
      log(`${task.domain}: 页面就绪探测失败 - ${err.message}`, "warn", {
        event: "content_ready_failed",
        taskIndex: task.index,
        domain: task.domain,
        profileId: task.profileId,
      });
    })
    .finally(() => {
      entry.readyCheckPromise = null;
    });
}

async function waitForTabContentReady(tabId, entry, initialData = {}) {
  const deadline = Date.now() + CONTENT_READY_TIMEOUT_MS;
  let stableChecks = 0;
  let previousSignature = "";
  let lastStatus = "unknown";
  let lastProbeError = "";
  while (Date.now() < deadline) {
    if (state.stopped || !state.activeTabs.has(tabId)) {
      const err = new Error("tracked task tab is no longer available");
      err.staleRun = true;
      throw err;
    }
    if (state.paused && !state.stopped) {
      entry.batchPaused = true;
      entry.agentPaused = true;
      return { ...initialData, paused: true };
    }
    const tab = await chrome.tabs.get(tabId).catch((err) => {
      lastProbeError = err.message || String(err);
      return null;
    });
    lastStatus = tab?.status || "unknown";
    if (!tab || tab.status !== "complete") {
      entry.tabLoadComplete = false;
      await sleep(CONTENT_READY_POLL_MS);
      continue;
    }
    entry.tabLoadComplete = true;

    let detection;
    let snapshot;
    try {
      detection = await sendTabMessage(tabId, { action: "detectPage" });
      snapshot = await chrome.tabs.sendMessage(tabId, { action: "getPageSnapshot" });
      lastProbeError = "";
    } catch (err) {
      lastProbeError = err.message || String(err);
      await sleep(CONTENT_READY_POLL_MS);
      continue;
    }

    const title = String(snapshot?.title || "").trim();
    const text = String(snapshot?.text || "").replace(/\s+/g, " ").trim();
    const contentReady = self.ExtLinkBatchControls.hasContentReadySignal({ snapshot, detection });
    const signature = JSON.stringify({
      url: tab.url || "",
      title,
      textLength: text.length,
      textHead: text.slice(0, 160),
      textTail: text.slice(-160),
      contentShape: self.ExtLinkBatchControls.contentFingerprint({
        forms: snapshot?.forms || [],
        fields: snapshot?.fields || [],
        buttons: snapshot?.buttons || [],
      }),
      platform: detection?.platform || initialData.mode || "unknown",
      fieldCount: Number(detection?.formFieldCount || snapshot?.meta?.fieldCount || 0),
      buttonCount: Number(snapshot?.meta?.buttonCount || 0),
      operable: detection?.operable === true,
    });
    if (contentReady && signature === previousSignature) stableChecks += 1;
    else if (contentReady) stableChecks = 1;
    else stableChecks = 0;
    previousSignature = signature;
    entry.readyProbe = {
      tabStatus: tab.status,
      contentReady,
      stableChecks,
      title,
      textLength: text.length,
      platform: detection?.platform || initialData.mode || "unknown",
      probedAt: new Date().toISOString(),
    };

    if (
      self.ExtLinkBatchControls.isStableContentReady({
        tabStatus: tab.status,
        contentReady,
        stableChecks,
        requiredStableChecks: CONTENT_READY_STABLE_CHECKS,
      })
    ) {
      return {
        ...initialData,
        mode: detection?.platform || initialData.mode || "unknown",
        detection,
        snapshot,
        tabStatus: tab.status,
        contentReady: true,
        stableChecks,
      };
    }
    await sleep(CONTENT_READY_POLL_MS);
  }

  const detail = [
    `tabStatus=${lastStatus}`,
    `stableChecks=${entry.readyProbe?.stableChecks || 0}/${CONTENT_READY_STABLE_CHECKS}`,
    lastProbeError ? `probe=${lastProbeError}` : "probe=未完成",
  ].join(", ");
  const err = new Error(detail);
  err.readinessTimeout = true;
  throw err;
}

async function handleStableContentReady(tab, data) {
  const entry = state.activeTabs.get(tab.id);
  if (!entry || state.stopped || entry.agentDone) return;
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (!task) return;

  if (isCustomLaunchTask(task)) {
    if (state.paused) {
      entry.batchPaused = true;
      entry.agentPaused = true;
      entry.pauseRequested = false;
      return;
    }
    await runProductHuntLaunchLoop(tab.id, task, entry);
    return;
  }
  if (state.paused) {
    entry.batchPaused = true;
    entry.agentPaused = true;
    entry.pauseRequested = false;
    return;
  }

  const shouldResumeRejudge = entry.pendingRejudge;
  if (entry.agentPaused && !shouldResumeRejudge) {
    if (!looksReadyForManualResume(data)) return;
    log(`页面就绪: ${task.domain} ${data.mode}，自动继续半自动填表`, "");
    resetEntryTimeout(entry, tab.id, EXECUTION_TIMEOUT_MS);
    if (state.config && state.config.useAgent === true) {
      await runAgentLoop(tab.id, task, entry, { manual: true, resumedFromContentReady: true });
      return;
    }
    await runRuleBasedFill(tab.id, task, entry, { manual: true, resumedFromContentReady: true });
    return;
  }

  log(`页面就绪: ${task.domain} ${data.mode}`, "");
  resetEntryTimeout(entry, tab.id, EXECUTION_TIMEOUT_MS);
  if (state.config && state.config.useAgent === true) {
    if (shouldResumeRejudge) {
      await runAgentLoop(tab.id, task, entry, { pendingRejudge: true });
      return;
    }
    await runAgentLoop(tab.id, task, entry);
    return;
  }
  await runRuleBasedFill(tab.id, task, entry);
}

function isCustomLaunchTask(task) {
  const url = task?.url || task?.destinationUrl || "";
  const playbook = self.ExtLinkPlaybooks?.lookup?.(url);
  return self.ExtLinkBatchControls.isCustomLaunchPlaybook(playbook);
}

function isCustomLaunchUrl(url) {
  return isCustomLaunchTask({ url });
}

const PRODUCT_HUNT_MAX_STEPS = 12;
const PRODUCT_HUNT_MAX_WAIT_RETRIES = 60;

async function persistProductHuntCheckpoint(task, result = {}) {
  task.productHuntStage = result.stage || task.productHuntStage || "unknown";
  task.productHuntStageAttempt = Math.max(0, Number(task.productHuntStageAttempt) || 0) + 1;
  task.productHuntExpectedNext = result.expectedNext || result.nextStage || "";
  task.productHuntLastTransitionAt = new Date().toISOString();
  await persistActiveBatchStatus(state.paused ? "paused" : "running");
  await recordAutomationEvent(task, {
    type: "producthunt_stage",
    status: result.status || "running",
    action: task.productHuntStage,
    result: result.reason || result.expectedNext || result.nextStage || "",
    artifactRef: result.artifactRef || "",
  });
}

function productHuntGateStatus(result = {}) {
  if (
    result.captcha ||
    result.gate === "captcha" ||
    result.status === "captcha" ||
    result.status === "needs_captcha"
  ) {
    return "needs_captcha";
  }
  if (result.status === "needs_otp") return "needs_otp";
  if (result.status === "needs_login") return "needs_login";
  return "needs_manual";
}

function parkProductHuntTask(tabId, task, entry, reason, status = "needs_manual") {
  task.status = status === "needs_captcha" ? "captcha" : status;
  task.skipReason = reason;
  parkTaskEntry(tabId, entry, reason);
  log(`${task.domain} [${task.projectKey || task.profileId}]: ${reason}`, "warn", {
    event: "producthunt_gate",
    taskIndex: task.index,
    taskId: task.id,
    status,
  });
  broadcastTaskUpdate(task);
  chrome.tabs.sendMessage(tabId, {
    action: "showManualWaitBanner",
    taskIndex: task.index,
    reason,
    timeoutSec: 0,
    config: getTaskConfig(task),
    platformType: task.platformType,
  }).catch(() => {});
}

async function runProductHuntLaunchLoop(tabId, task, entry, options = {}) {
  if (entry.agentRunning || entry.agentDone || state.stopped) return;
  const runId = nextEntryRunId(entry);
  entry.agentRunning = true;
  entry.agentPaused = false;
  entry.pendingRejudge = false;
  task.status = "running";
  task.skipReason = "";
  broadcastTaskUpdate(task);
  try {
    const config = getTaskConfig(task);
    const mismatch = self.ExtLinkProfiles.taskConfigIdentityMismatch(task, config);
    if (mismatch) {
      parkProductHuntTask(tabId, task, entry, `资料与当前任务不一致（${mismatch}），已阻止发布`);
      return;
    }
    let step = 0;
    let waitingRetries = 0;
    let lastWaitingSignature = "";
    let stableWaitingRetries = 0;
    while (step < PRODUCT_HUNT_MAX_STEPS && waitingRetries < PRODUCT_HUNT_MAX_WAIT_RETRIES) {
      assertRunCurrent(tabId, entry, runId);
      const result = await sendTabMessage(tabId, {
        action: "runProductHuntStep",
        config,
        confirmCreate: options.confirmCreate === true,
      });
      if (!result || typeof result !== "object") throw new Error("Product Hunt 步骤返回无效");
      await persistProductHuntCheckpoint(task, result);
      if (result.status === "gate" || result.needs_manual || result.captcha || /^needs_/.test(result.status || "")) {
        parkProductHuntTask(tabId, task, entry, result.reason || "Product Hunt 需要人工处理", productHuntGateStatus(result));
        return;
      }
      if (result.submittedAttempt && result.matched && result.evidence) {
        entry.submissionAttempted = true;
        completeTaskFromSubmit(tabId, task, {
          ...result,
          submitted: true,
          clickedSubmit: true,
          publicationStatus: result.publicationStatus || "submitted",
        });
        return;
      }
      if (result.status === "ready_to_create" || result.ready_to_create === true) {
        const reason = "Product Hunt 必填 100%，等待确认 Create draft（不会排期或购买推广）";
        entry.productHuntReadyToCreate = true;
        parkProductHuntTask(tabId, task, entry, reason);
        return;
      }
      if (result.status === "error" || result.error) {
        throw new Error(result.error || result.reason || "Product Hunt 步骤失败");
      }
      if (result.waiting) {
        const waitingSignature = [
          result.stage || "unknown",
          JSON.stringify(result.missing || result.requiredUnchecked || []),
          result.reason || "",
        ].join("|");
        if (waitingSignature === lastWaitingSignature) stableWaitingRetries += 1;
        else {
          lastWaitingSignature = waitingSignature;
          stableWaitingRetries = 0;
        }
        if (result.stage && result.stage !== "unknown" && result.missing?.length && stableWaitingRetries >= 5) {
          parkProductHuntTask(
            tabId,
            task,
            entry,
            `Product Hunt ${result.stage} 仍缺少：${result.missing.join("、")}`,
          );
          return;
        }
        waitingRetries += 1;
        const retryAfterMs = Number(result.retryAfterMs);
        const delayMs = Number.isFinite(retryAfterMs)
          ? Math.max(150, Math.min(retryAfterMs, 5000))
          : 800;
        await sleep(delayMs);
        continue;
      }
      if (!(result.advanced || result.stageAdvanced || result.stageCompleted || result.entryOpened)) {
        throw new Error(result.reason || `Product Hunt ${result.stage || "unknown"} 未推进`);
      }
      step += 1;
      waitingRetries = 0;
      await sleep(900);
    }
    throw new Error("Product Hunt 步骤超过安全上限");
  } catch (err) {
    if (err?.staleRun) return;
    if (err?.batchPaused) {
      pauseEntryForBatch(tabId, task, entry);
      return;
    }
    parkProductHuntTask(tabId, task, entry, `Product Hunt 自动化暂停：${err.message}`);
  } finally {
    entry.agentRunning = false;
  }
}

function looksReadyForManualResume(data) {
  const mode = data && typeof data.mode === "string" ? data.mode : "";
  return !!mode && mode !== "unknown";
}

function handleTimeout(tabId) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  if (state.paused && !state.stopped) {
    entry.batchPaused = true;
    entry.agentPaused = true;
    clearEntryTimeout(entry);
    log("批量已暂停，暂不判定当前页签超时", "warn", { event: "task_timeout_deferred" });
    return;
  }
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (task) {
    bumpEntryRunId(entry);
    task.status = "err";
    task.skipReason = "timeout";
    parkTaskEntry(tabId, entry, "云端 AI 循环超时");
    log(`${task.domain}: 云端 AI 循环超时，请手动检查`, "warn");
    broadcastTaskUpdate(task);
  }
}

// ─── Manual continue: user clicked "继续填表" from banner ───
async function handleManualSubmit(msg) {
  if (state.stopped) return;
  const { taskIndex, platformType } = msg;
  const task = state.tasks.find((t) => t.index === taskIndex);
  if (!task) return;

  // Find the tab for this task
  let tabId = null;
  for (const [id, entry] of state.activeTabs) {
    if (entry.taskIndex === taskIndex) {
      tabId = id;
      break;
    }
  }
  if (!tabId) {
    task.status = "needs_manual";
    task.skipReason = "页签已关闭，请在新一轮中重试该组合";
    broadcastTaskUpdate(task);
    return;
  }

  log(`${task.domain}: 用户确认继续，AI 接管后续步骤`, "");
  const entry = state.activeTabs.get(tabId);
  if (isCustomLaunchTask(task)) {
    clearManualWaitTimer(entry);
    entry.slotActive = true;
    entry.agentDone = false;
    state.parkedTaskIds.delete(task.id);
    await persistParkedTaskIds();
    await chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
    await runProductHuntLaunchLoop(tabId, task, entry, {
      confirmCreate: msg.confirmProductHuntCreate === true,
    });
    return;
  }
  clearManualWaitTimer(entry);
  entry.slotActive = true;
  entry.agentDone = false;
  state.parkedTaskIds.delete(task.id);
  persistParkedTaskIds();
  chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  const activeConfig = getTaskConfig(task);
  if (activeConfig && activeConfig.useAgent === true) {
    await runAgentLoop(tabId, task, entry, {
      config: activeConfig,
      platformType: platformType || task.platformType,
      manual: true,
    });
    return;
  }
  await runRuleBasedFill(tabId, task, entry, {
    config: activeConfig,
    platformType: platformType || task.platformType,
    manual: true,
  });
}

// ─── Manual skip: user clicked "跳过" from banner ───
function handleManualSkip(msg) {
  if (state.stopped) return;
  const { taskIndex } = msg;
  const task = state.tasks.find((t) => t.index === taskIndex);
  if (!task) return;

  let tabId = null;
  for (const [id, entry] of state.activeTabs) {
    if (entry.taskIndex === taskIndex) {
      tabId = id;
      break;
    }
  }

  const entry = tabId ? state.activeTabs.get(tabId) : null;
  if (entry) clearManualWaitTimer(entry);
  task.status = "skip";
  task.skipReason = "manual_skip_current_run";
  if (entry) entry.agentDone = true;
  log(`${task.domain}: 用户手动跳过`, "warn");
  broadcastTaskUpdate(task);
  if (tabId && entry) {
    chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
    advanceDestinationGroup(tabId, task).catch(() => closeTab(tabId));
  }
}

async function confirmSubmissionSuccess(msg) {
  const task =
    state.tasks.find((item) => item.index === msg.taskIndex || item.id === msg.taskId) || null;
  if (!task) throw new Error("待确认任务不存在或已过期");
  if (msg.runId !== state.runId) throw new Error("批次已变化，请刷新待人工列表后重试");
  if (!task.confirmationNonce || msg.confirmationNonce !== task.confirmationNonce) {
    throw new Error("人工确认凭证无效，请刷新待人工列表后重试");
  }
  if (!state.parkedTaskIds.has(task.id) || !["needs_manual", "needs_captcha", "needs_login", "captcha", "filled", "submitted_unconfirmed"].includes(task.status)) {
    throw new Error("该任务当前不在待人工确认状态");
  }

  task.status = "ok";
  task.skipReason = "";
  task.confirmedBy = "manual";
  task.successEvidence = msg.evidence || "user confirmed submission success";
  task.confirmationNonce = "";
  await recordSubmittedProject(task);
  broadcastTaskUpdate(task);
  if (task.id && state.parkedTaskIds.delete(task.id)) await persistParkedTaskIds();

  for (const [tabId, entry] of state.activeTabs) {
    if (entry.taskIndex !== task.index) continue;
    entry.agentDone = true;
    await advanceDestinationGroup(tabId, task);
    break;
  }
  return { ok: true, task };
}

async function resumeAfterCaptcha(tabId, data) {
  if (state.stopped) return;
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (!task) return;

  log(`${task.domain}: 验证码已处理，重新运行云端 AI 判断`, "");
  clearManualWaitTimer(entry);
  entry.slotActive = true;
  entry.agentDone = false;
  state.parkedTaskIds.delete(task.id);
  await persistParkedTaskIds();
  chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  if (isCustomLaunchTask(task)) {
    await runProductHuntLaunchLoop(tabId, task, entry, { captchaResolved: true });
    return;
  }
  await runAgentLoop(tabId, task, entry, { captchaResolved: true, data });
}

// ─── Rule-based fill (no DeepSeek required) ───
async function runRuleBasedFill(tabId, task, entry, extra = {}) {
  if (entry.agentRunning || entry.agentDone) return;
  const fillConfig = getTaskConfig(task, extra.config || {});
  const identityMismatch = self.ExtLinkProfiles.taskConfigIdentityMismatch(task, fillConfig);
  if (identityMismatch) {
    markTaskNeedsManual(
      tabId,
      task,
      entry,
      `资料与当前任务不一致（${identityMismatch}），已阻止提交以免串站`,
    );
    return;
  }

  const runId = nextEntryRunId(entry);
  entry.agentRunning = true;
  entry.agentPaused = false;
  entry.pendingRejudge = false;

  try {
    task.status = "running";
    broadcastTaskUpdate(task);

    const prepareConfig = { ...fillConfig, deferSubmit: true };
    let result = await sendExecuteSubmit(
      tabId,
      task,
      prepareConfig,
      extra.platformType || task.platformType,
    );
    assertRunCurrent(tabId, entry, runId);

    let navCount = 0;
    while (result && result.navigating && navCount < 4 && !state.stopped) {
      navCount += 1;
      log(`${task.domain}: 打开提交入口 ${result.label || result.url}`, "");
      await navigateTaskTab(tabId, entry, result.url);
      await waitForTabContentReady(tabId, entry, { mode: "unknown" });
      assertRunCurrent(tabId, entry, runId);
      result = await sendExecuteSubmit(
        tabId,
        task,
        prepareConfig,
        extra.platformType || task.platformType,
      );
      assertRunCurrent(tabId, entry, runId);
    }

    if (result && result.captcha) {
      markTaskNeedsManual(tabId, task, entry, "验证码已出现 — 页签留下，请完成后继续");
      return;
    }
    if (result && result.needs_manual) {
      markTaskNeedsManual(tabId, task, entry, result.reason || "需要人工处理");
      return;
    }
    if (result && result.blocked) {
      markTaskBlocked(tabId, task, entry, result.reason || "无法提交");
      return;
    }
    if (result && result.waiting) {
      markTaskFilled(
        tabId,
        task,
        entry,
        result.skipReason || "请导航到提交页面后点击「继续填表」",
      );
      return;
    }
    if (result && result.error) {
      markTaskFilled(tabId, task, entry, result.skipReason || result.error);
      return;
    }

    const platformType = extra.platformType || task.platformType || result?.platform || "directory";
    const filled = await fillFormUntilReady(tabId, fillConfig, platformType, {
      allowAgent: fillConfig.useAgent !== false,
    });
    assertRunCurrent(tabId, entry, runId);

    try {
      const profileId = task.profileId || task.projectKey || fillConfig.projectKey;
      await persistFillLearnings(tabId, profileId, fillConfig);
    } catch {
      /* non-fatal */
    }

    if (filled.agentResult?.captcha) {
      markTaskNeedsManual(tabId, task, entry, "验证码已出现 — 页签留下，请完成后继续");
      return;
    }
    if (filled.agentResult?.needs_manual) {
      markTaskNeedsManual(tabId, task, entry, filled.agentResult.reason || "需要人工处理");
      return;
    }
    if (filled.agentResult?.blocked) {
      markTaskBlocked(tabId, task, entry, filled.agentResult.reason || "无法提交");
      return;
    }

    if (fillConfig.fillOnly) {
      markTaskFilled(tabId, task, entry, "表单已填写，请检查内容后手动点击提交");
      return;
    }

    const taskProfile = {
      id: task.profileId || task.projectKey || fillConfig.projectKey,
      name: task.profileName || fillConfig.brandName,
      promoUrl: fillConfig.targetDomain,
      url: fillConfig.targetDomain,
      fields: fillConfig.projectFields || {},
    };
    const submitted = await submitUntilAccepted(tabId, fillConfig, taskProfile, platformType, {
      allowAgent: fillConfig.useAgent !== false,
      recordLedger: false,
      lastEmpty: filled.lastEmpty,
    });
    assertRunCurrent(tabId, entry, runId);

    if (submitted?.captcha) {
      markTaskNeedsManual(tabId, task, entry, "验证码已出现 — 页签留下，请完成后继续");
      return;
    }
    if (submitted?.needs_manual) {
      markTaskNeedsManual(tabId, task, entry, submitted.reason || "需要人工处理");
      return;
    }
    if (submitted?.blocked) {
      markTaskBlocked(tabId, task, entry, submitted.reason || "无法提交");
      return;
    }
    if (submitted?.submitted && submitted?.matched && submitted?.evidence) {
      completeTaskFromSubmit(tabId, task, submitted);
      return;
    }
    if (submitted?.validationFailed) {
      markTaskFilled(
        tabId,
        task,
        entry,
        `表单校验未通过，补完一轮仍缺：${
          (submitted.issues && submitted.issues[0]) || "仍有必填或无效栏"
        }`,
      );
      return;
    }
    if (submitted?.submitted && !submitted?.matched) {
      markTaskFilled(tabId, task, entry, "已代点提交，未见回执，请人工确认");
      return;
    }

    markTaskFilled(tabId, task, entry, "表单已填写，请检查后提交");
  } catch (err) {
    if (err && err.staleRun) return;
    if (err && err.batchPaused) {
      pauseEntryForBatch(tabId, task, entry);
      return;
    }
    task.status = "err";
    task.skipReason = err.message;
    parkTaskEntry(tabId, entry, err.message);
    log(`${task.domain}: ${err.message}`, "err");
    broadcastTaskUpdate(task);
  } finally {
    entry.agentRunning = false;
  }
}

async function sendExecuteSubmit(tabId, task, config, platformType) {
  const result = await chrome.tabs.sendMessage(tabId, {
    action: "executeSubmit",
    config,
    platformType: platformType || task.platformType || "directory",
    taskIndex: task.index,
  });
  if (!result || typeof result !== "object") {
    throw new Error("content script returned an invalid fill result");
  }
  return result;
}

function markTaskFilled(tabId, task, entry, reason) {
  entry.agentDone = true;
  parkTaskEntry(tabId, entry, reason);
  task.status = "filled";
  task.skipReason = reason;
  log(`${task.domain}: ${reason}`, "ok");
  broadcastTaskUpdate(task);
  chrome.tabs
    .sendMessage(tabId, {
      action: "showManualWaitBanner",
      taskIndex: task.index,
      reason,
      timeoutSec: 0,
      config: getTaskConfig(task),
      platformType: task.platformType,
    })
    .catch(() => {});
}

// ─── Cloud AI loop ───
async function callCloudAgent(endpoint, payload) {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const mapped = {
    "/comment": "/v1/ai/comment",
    "/plan": "/v1/ai/plan",
    "/vision-plan": "/v1/ai/vision-plan",
    "/judge": "/v1/ai/judge",
    "/validate-fill": "/v1/ai/validate-fill",
    "/extract-site": "/v1/ai/extract-site",
    "/generate-site": "/v1/ai/generate-site",
    "/domain/metrics": "/v1/domain/metrics",
  }[path];
  if (!mapped) throw new Error(`不支持的云端助手能力: ${path}`);
  return cloudRequest(mapped, { method: "POST", body: payload });
}

async function getTabSnapshot(tabId) {
  let snapshot;
  let lastError;
  for (let attempt = 0; attempt < SNAPSHOT_RETRY_ATTEMPTS; attempt++) {
    try {
      if (attempt === 0) await ensureContentScript(tabId);
      snapshot = await chrome.tabs.sendMessage(tabId, { action: "getPageSnapshot" });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      if (attempt === 0) {
        try {
          await ensureContentScript(tabId);
        } catch {
          /* fall through to retry */
        }
      }
      await sleep(SNAPSHOT_RETRY_MS);
    }
  }
  if (lastError) {
    throw new Error(`content script snapshot unavailable: ${lastError.message}`);
  }
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("content script returned an invalid page snapshot");
  }
  if (snapshot.error) {
    throw new Error(`content script snapshot failed: ${snapshot.error}`);
  }
  return snapshot;
}

async function executeTabActions(tabId, actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("云端 AI 未返回可执行动作");
  }

  const result = await chrome.tabs.sendMessage(tabId, {
    action: "executeActionPlan",
    actions,
  });
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("content script returned an invalid action result");
  }
  if (!result.ok) {
    const failed = Array.isArray(result.results)
      ? result.results.find((item) => item && !item.ok)
      : null;
    throw new Error(
      result.error || (failed && failed.error) || "content script could not execute action plan",
    );
  }
  return result;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function uploadAutomationArtifact(dataUrl, task, kind = "screenshot") {
  const response = await fetch(dataUrl);
  const bytes = await response.arrayBuffer();
  const contentType = response.headers.get("content-type") || "image/jpeg";
  const safeTask = String(task?.id || "task").replace(/[^a-z0-9._-]+/gi, "-").slice(0, 80);
  const sha256 = await sha256Hex(bytes);
  const artifactId = `${String(state.runId).replace(/[^a-z0-9._-]+/gi, "-")}-${safeTask}-${sha256.slice(0, 24)}.jpg`;
  const result = await cloudRequest(`/v1/automation/artifacts/${artifactId}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "X-Asset-Sha256": sha256,
      "X-Run-Id": state.runId,
      "X-Task-Id": task?.id || "",
      "X-Artifact-Kind": kind,
    },
    body: bytes,
  });
  return result.ref || `cloud-artifact://${artifactId}`;
}

async function captureTaskVisualContext(tabId, task) {
  const prepared = await chrome.tabs.sendMessage(tabId, { action: "prepareVisualSnapshot" });
  if (!prepared?.ok || !prepared.elements?.length) throw new Error("页面没有可供视觉兜底识别的控件");
  const tab = await chrome.tabs.get(tabId);
  const [previous] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
  try {
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(180);
    }
    const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 65 });
    let artifactRef = "";
    try {
      artifactRef = await uploadAutomationArtifact(screenshot, task, "visual_fallback");
    } catch (err) {
      console.warn("ExternalLink visual artifact upload failed", err?.message || err);
    }
    return { screenshot, elements: prepared.elements, viewport: prepared.viewport, artifactRef };
  } finally {
    await chrome.tabs.sendMessage(tabId, { action: "clearVisualSnapshot" }).catch(() => {});
    if (previous?.id && previous.id !== tabId) await chrome.tabs.update(previous.id, { active: true }).catch(() => {});
  }
}

function safeVisualActions(actions, elements) {
  const bySelector = new Map((elements || []).map((element) => [element.selector, element]));
  return (actions || []).filter((action) => {
    if (action.type === "wait") return true;
    if (action.type === "click") return false;
    const element = bySelector.get(action.selector);
    if (!element) return false;
    const label = `${element.label || ""} ${element.type || ""} ${element.role || ""}`.toLowerCase();
    if (action.type === "click" && /submit|publish|launch|pay|checkout|sign in|log in|agree|提交|发布|付款|登录|同意/.test(label)) return false;
    return true;
  });
}

async function executeVisualFallback(tabId, task, snapshot, failure) {
  const visual = await captureTaskVisualContext(tabId, task);
  const plan = await callCloudAgent("/vision-plan", {
    ...agentPayload(task, snapshot, { visualFallback: true }),
    screenshot: visual.screenshot,
    elements: visual.elements,
    viewport: visual.viewport,
    failure,
  });
  const actions = safeVisualActions(plan.actions, visual.elements);
  await recordAutomationEvent(task, {
    type: "vision_plan",
    status: plan.status,
    action: summarizePlanActions(actions),
    result: plan.reason || failure || "",
    artifactRef: visual.artifactRef,
  });
  task.artifactRef = visual.artifactRef || task.artifactRef || "";
  if (plan.status !== "act" || !actions.length) {
    throw new Error(plan.reason || "视觉兜底未返回安全可执行动作");
  }
  return executeTabActions(tabId, actions);
}

function getTaskConfig(task, extraConfig = {}) {
  const globals = state.config || {};
  const profileId = task?.profileId || task?.projectKey || task?.config?.projectKey || "";
  const perTask = task?.config || state.profileConfigs?.[profileId] || {};
  const merged = self.ExtLinkProfiles.mergeFillConfig(globals, perTask, extraConfig);
  return {
    ...merged,
    autoSkipCaptcha: globals.autoSkipCaptcha,
    fillOnly: globals.fillOnly === true,
    autoSubmitDirectory: globals.autoSubmitDirectory !== false && globals.fillOnly !== true,
    productHuntAutomation: isCustomLaunchTask(task),
    autoSubmitStandardWpComments: globals.autoSubmitStandardWpComments === true,
    manualWaitSec: globals.manualWaitSec,
    pingIndex: globals.pingIndex,
    note: task?.note || perTask.note || "",
  };
}

function agentPayload(task, snapshot, extra = {}) {
  const config = getTaskConfig(task, extra.config || {});
  const payload = {
    task: {
      index: task.index,
      domain: task.domain,
      url: task.url,
      platformType: extra.platformType || task.platformType || "auto",
      projectKey: task.projectKey || config.projectKey || "",
      note: task.note || "",
    },
    config,
    snapshot,
  };

  const extraEntries = Object.entries(extra).filter(
    ([key, value]) => !["config", "platformType"].includes(key) && value !== undefined,
  );
  if (extraEntries.length > 0) {
    payload.extra = Object.fromEntries(extraEntries);
  }
  return payload;
}

async function runAgentLoop(tabId, task, entry, extra = {}) {
  if (entry.agentRunning || entry.agentDone) return;
  if (entry.agentPaused && !extra.manual && !extra.captchaResolved && !extra.pendingRejudge) return;
  const identityMismatch = self.ExtLinkProfiles.taskConfigIdentityMismatch(
    task,
    getTaskConfig(task, extra.config || {}),
  );
  if (identityMismatch) {
    markTaskNeedsManual(
      tabId,
      task,
      entry,
      `资料与当前任务不一致（${identityMismatch}），已阻止提交以免串站`,
    );
    return;
  }
  const runId = nextEntryRunId(entry);
  entry.agentRunning = true;
  entry.agentPaused = false;
  entry.pendingRejudge = false;

  try {
    task.status = "running";
    task._attempt = Math.max(1, Number(task._attempt) || 1);
    broadcastTaskUpdate(task);

    let snapshot = await getTabSnapshot(tabId);
    await recordAutomationEvent(task, {
      type: "snapshot",
      status: "running",
      before: snapshot,
      result: "initial stable snapshot",
    });
    assertRunCurrent(tabId, entry, runId);
    let judge = await callCloudAgent("/judge", agentPayload(task, snapshot, extra));
    await recordAutomationEvent(task, {
      type: "judge",
      status: judge.status,
      before: snapshot,
      result: judge.reason || judge.message || "",
      evidenceType: snapshot.evidenceSignals?.[0]?.type || "",
    });
    assertRunCurrent(tabId, entry, runId);
    if (judge.status === "success") {
      const completed = completeTaskFromJudge(tabId, task, {
        ...judge,
        phase: "initial",
        evidenceSignals: snapshot.evidenceSignals || [],
        evidenceUrl: judge.evidenceUrl || snapshot.url || "",
      });
      if (completed) return;
      judge = { ...judge, status: "incomplete", reason: "模型成功判断未通过硬证据闸门，继续执行" };
    }
    if (handleTerminalJudge(tabId, task, entry, judge)) return;

    for (let loop = 0; loop < MAX_AGENT_LOOPS && !state.stopped; loop++) {
      const plan = await callCloudAgent(
        "/plan",
        agentPayload(task, snapshot, { ...extra, judge, loop }),
      );
      assertRunCurrent(tabId, entry, runId);

      if (plan.status === "needs_manual") {
        markTaskNeedsManual(
          tabId,
          task,
          entry,
          plan.reason || plan.message || "云端 AI 需要人工处理",
        );
        return;
      }
      if (plan.status === "blocked" || plan.status === "error") {
        markTaskBlocked(
          tabId,
          task,
          entry,
          plan.reason || plan.message || "云端 AI 暂时无法处理该页面",
        );
        return;
      }
      if (plan.status !== "act") {
        markTaskNeedsManual(
          tabId,
          task,
          entry,
          plan.reason || plan.message || `unsupported plan status: ${plan.status}`,
        );
        return;
      }

      log(
        `${task.domain}: 云端 AI 执行第 ${loop + 1} 轮动作 - ${summarizePlanActions(plan.actions)}`,
        "",
      );
      await recordAutomationEvent(task, {
        type: "plan",
        status: plan.status,
        before: snapshot,
        action: summarizePlanActions(plan.actions),
        result: plan.reason || "",
      });
      const previousSnapshotHash = snapshot.domHash || "";
      let actionResult;
      try {
        actionResult = await executeTabActions(tabId, plan.actions);
      } catch (actionError) {
        entry.actionFailures = Math.max(0, Number(entry.actionFailures) || 0) + 1;
        if (entry.visualFallbackUsed || entry.actionFailures < VISION_FALLBACK_AFTER_FAILURES) throw actionError;
        entry.visualFallbackUsed = true;
        log(`${task.domain}: DOM 动作失败，启用截图标注 + 多模态兜底`, "warn");
        actionResult = await executeVisualFallback(tabId, task, snapshot, actionError.message);
      }
      if (actionResult.results?.some((item) => item?.submitted)) entry.submissionAttempted = true;
      log(`${task.domain}: 第 ${loop + 1} 轮结果 - ${summarizeActionResults(actionResult)}`, "");
      await recordAutomationEvent(task, {
        type: "action_result",
        status: actionResult.ok ? "ok" : "failed",
        action: summarizePlanActions(plan.actions),
        result: summarizeActionResults(actionResult),
      });
      assertRunCurrent(tabId, entry, runId);
      await sleep(AGENT_ACTION_SETTLE_MS);
      assertRunCurrent(tabId, entry, runId);
      await waitForTabContentReady(tabId, entry, entry.lastContentReady || { mode: "unknown" });
      assertRunCurrent(tabId, entry, runId);

      try {
        snapshot = await getTabSnapshot(tabId);
      } catch (err) {
        if (isNavigationSnapshotError(err)) {
          markPendingRejudge(task, entry, tabId, err.message);
          return;
        }
        throw err;
      }
      assertRunCurrent(tabId, entry, runId);

      const expectedMutation = plan.actions?.some((action) => ["fill", "select", "check"].includes(action?.type));
      if (expectedMutation && snapshot.domHash && snapshot.domHash === previousSnapshotHash && !entry.visualFallbackUsed) {
        entry.visualFallbackUsed = true;
        log(`${task.domain}: DOM 动作无可见状态变化，启用截图标注 + 多模态兜底`, "warn");
        const visualResult = await executeVisualFallback(
          tabId,
          task,
          snapshot,
          "DOM action reported success but snapshot state did not change",
        );
        await recordAutomationEvent(task, {
          type: "vision_action_result",
          status: visualResult.ok ? "ok" : "failed",
          result: summarizeActionResults(visualResult),
        });
        await sleep(AGENT_ACTION_SETTLE_MS);
        snapshot = await getTabSnapshot(tabId);
      }

      const terminalSubmit = await tryAgentDeterministicSubmit(tabId, task, entry, snapshot);
      if (terminalSubmit) return;
      assertRunCurrent(tabId, entry, runId);

      judge = await callCloudAgent(
        "/judge",
        agentPayload(task, snapshot, { ...extra, plan, loop }),
      );
      await recordAutomationEvent(task, {
        type: "judge",
        status: judge.status,
        after: snapshot,
        result: judge.reason || judge.message || "",
        evidenceType: snapshot.evidenceSignals?.[0]?.type || "",
      });
      assertRunCurrent(tabId, entry, runId);
      log(
        `${task.domain}: 第 ${loop + 1} 轮判断 - ${judge.status}: ${judge.reason || judge.message || ""}`,
        "",
      );
      if (judge.status === "success") {
        const completed = completeTaskFromJudge(tabId, task, {
          ...judge,
          phase: "after_action",
          evidenceSignals: snapshot.evidenceSignals || [],
          evidenceUrl: judge.evidenceUrl || snapshot.url || "",
        });
        if (completed) return;
        judge = { ...judge, status: "incomplete", reason: "模型成功判断未通过硬证据闸门" };
      }
      if (handleTerminalJudge(tabId, task, entry, judge)) return;
    }

    markTaskNeedsManual(
      tabId,
      task,
      entry,
      `AI 未能自动完成，请手动检查（已尝试 ${MAX_AGENT_LOOPS} 轮）`,
    );
  } catch (err) {
    if (err && err.staleRun) return;
    if (err && err.batchPaused) {
      pauseEntryForBatch(tabId, task, entry);
      return;
    }
    if (isAgentUnavailableError(err)) {
      skipTaskWithReason(
        tabId,
        task,
        entry,
        "云端 AI 服务暂不可用，请稍后重试",
      );
      return;
    }
    markTaskNeedsManual(tabId, task, entry, err.message || "AI 执行异常，请手动处理后继续");
  } finally {
    entry.agentRunning = false;
    resumePendingRejudgeAfterRun(tabId, task, entry);
  }
}

async function tryAgentDeterministicSubmit(tabId, task, entry, snapshot) {
  const config = getTaskConfig(task);
  const formState = await sendTabMessage(tabId, { action: "collectFormValidation" }).catch(() => null);
  const empty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => null);
  const ready = formState?.validationFailed === false
    && Number(empty?.emptyCount || 0) === 0
    && Number(empty?.invalidCount || 0) === 0;
  if (!ready) return false;

  if (config.fillOnly || config.autoSubmitDirectory === false) {
    markTaskFilled(tabId, task, entry, "AI 已完成表单填写，请检查内容后手动点击提交");
    return true;
  }

  await recordAutomationEvent(task, {
    type: "submit_preflight",
    status: "ready",
    before: snapshot,
    result: "required fields complete; deterministic submit authorized",
  });
  const result = await sendTabMessage(tabId, {
    action: "submitFilledForm",
    config,
    platform: task.platformType || "directory",
  });
  if (result?.captcha) {
    markTaskNeedsManual(tabId, task, entry, "验证码已出现 — 页签留下，请完成后继续", "needs_captcha");
    return true;
  }
  if (result?.needs_manual) {
    markTaskNeedsManual(tabId, task, entry, result.reason || "需要人工处理");
    return true;
  }
  if (result?.blocked) {
    markTaskBlocked(tabId, task, entry, result.reason || "无法提交");
    return true;
  }
  if (result?.validationFailed) return false;
  if (result?.submitted) entry.submissionAttempted = true;
  if (result?.submitted && result?.matched && result?.evidence) {
    completeTaskFromSubmit(tabId, task, result);
    return true;
  }
  if (result?.submitted) {
    markTaskUnconfirmed(tabId, task, entry, "已代点提交，但站点未返回可核验回执");
    return true;
  }
  return false;
}

function summarizePlanActions(actions) {
  if (!Array.isArray(actions) || actions.length === 0) return "no actions";
  return actions
    .map((action, index) => {
      const type = action && action.type ? action.type : "unknown";
      const selector = action && action.selector ? shortText(action.selector, 80) : "";
      return selector ? `${index + 1}.${type} ${selector}` : `${index + 1}.${type}`;
    })
    .join("; ");
}

function summarizeActionResults(result) {
  const results = result && Array.isArray(result.results) ? result.results : [];
  if (results.length === 0) return result && result.ok ? "ok" : "no result details";
  return results
    .map((item) => {
      const status = item.ok ? "ok" : `fail:${item.error || "unknown"}`;
      const selector = item.selector ? ` ${shortText(item.selector, 80)}` : "";
      return `${item.index + 1}.${item.type || "unknown"} ${status}${selector}`;
    })
    .join("; ");
}

function shortText(value, limit) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function handleTerminalJudge(tabId, task, entry, judge) {
  if (!judge || typeof judge !== "object") {
    markTaskNeedsManual(tabId, task, entry, "judge returned an invalid response");
    return true;
  }
  if (judge.status === "blocked") {
    markTaskBlocked(
      tabId,
      task,
      entry,
      judge.reason || judge.message || "judge blocked this page",
    );
    return true;
  }
  if (judge.status === "needs_manual") {
    markTaskNeedsManual(
      tabId,
      task,
      entry,
      judge.reason || judge.message || "judge needs manual input",
    );
    return true;
  }
  if (judge.status === "error") {
    markTaskNeedsManual(
      tabId,
      task,
      entry,
      judge.reason || judge.message || "judge returned an error",
    );
    return true;
  }
  return false;
}

function completeTaskFromSubmit(tabId, task, result) {
  completeTaskFromJudge(tabId, task, {
    evidence: result.evidence || "",
    reason: result.evidence || "directory auto-submit evidence",
    publicationStatus: result.publicationStatus || "submitted",
    publicUrl: result.publicUrl || "",
    evidenceUrl: result.evidenceUrl || "",
    source: "deterministic_submit",
    actionObserved: result.clickedSubmit === true || result.submitted === true,
    evidenceSignals: result.evidenceSignals || [{
      type: result.publicationStatus === "published" ? "public_listing" : "visible_confirmation",
      text: result.evidence || "",
      url: result.evidenceUrl || result.publicUrl || task.url || "",
      matched: Boolean(result.evidence),
    }],
  });
}

function completeTaskFromJudge(tabId, task, judge) {
  const entry = state.activeTabs.get(tabId);
  const proof = self.ExtLinkAutomationLedger.validateSuccessProof({
    confirmedBy: "agent",
    evidence: judge.evidence || "",
    source: judge.source || "judge",
    actionObserved: judge.actionObserved === true || entry?.submissionAttempted === true,
    evidenceSignals: judge.evidenceSignals || [],
    networkEvidence: judge.networkEvidence || null,
    publicationStatus: judge.publicationStatus,
    publicUrl: judge.publicUrl || "",
    destinationUrl: task.url || "",
    evidenceUrl: judge.evidenceUrl || "",
  });
  if (!proof.ok) {
    if (entry?.submissionAttempted !== true && judge.source !== "deterministic_submit") {
      log(`${task.domain}: 模型成功判断未通过硬证据闸门，继续执行 - ${proof.reason}`, "warn");
      recordAutomationEvent(task, {
        type: "success_rejected",
        status: "incomplete",
        result: proof.reason || "模型成功判断缺少证据",
        errorCode: "success_without_proof",
      });
      return false;
    }
    markTaskUnconfirmed(tabId, task, entry, proof.reason || "未取得可信提交证据");
    return true;
  }
  if (entry) {
    entry.agentDone = true;
    entry.pendingRejudge = false;
  }
  task.status = "verifying";
  task.skipReason = "";
  task.successEvidence = proof.evidence;
  task.evidenceType = proof.evidenceType;
  task.confirmedBy = "agent";
  task.publicationStatus = self.ExtLinkQueue.inferPublicationStatus({
    evidence: task.successEvidence,
    publicUrl: judge.publicUrl || task.publicUrl || "",
    evidenceUrl: judge.evidenceUrl || "",
    publicationStatus: judge.publicationStatus,
  });
  task.publicUrl = judge.publicUrl || task.publicUrl || "";
  task.evidenceUrl = proof.evidenceUrl || judge.evidenceUrl || "";
  task.successProof = {
    source: judge.source || "judge",
    actionObserved: judge.actionObserved === true || entry?.submissionAttempted === true,
    evidenceSignals: judge.evidenceSignals || [],
    networkEvidence: judge.networkEvidence || null,
  };
  log(`${task.domain}: 已取得证据，正在写入成功账本 - ${proof.evidence}`, "ok");
  recordSubmittedProject(task)
    .then(() => {
      task.status = "ok";
      recordAutomationEvent(task, {
        type: "success_recorded",
        status: "ok",
        result: proof.evidence,
        evidenceType: proof.evidenceType,
        artifactRef: task.artifactRef || "",
      });
      broadcastTaskUpdate(task);
      return advanceDestinationGroup(tabId, task);
    })
    .catch((err) => {
      task.status = "err";
      task.skipReason = `成功记录写入失败: ${err.message}`;
      broadcastTaskUpdate(task);
      parkTaskEntry(tabId, entry, task.skipReason);
    });
  if (state.config && state.config.pingIndex) {
    pingIndexNow(task.url);
  }
  broadcastTaskUpdate(task);
  return true;
}

function markTaskUnconfirmed(tabId, task, entry, reason) {
  if (entry) {
    entry.agentPaused = true;
    entry.pendingRejudge = false;
    entry.slotActive = false;
    clearEntryTimeout(entry);
  }
  task.status = "submitted_unconfirmed";
  task.skipReason = reason;
  parkTaskEntry(tabId, entry, reason);
  log(`${task.domain}: 已执行但未取得可信回执，未写成功账本 - ${reason}`, "warn");
  broadcastTaskUpdate(task);
  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      action: "showManualWaitBanner",
      taskIndex: task.index,
      reason: `已执行但未取得可信回执：${reason}`,
      timeoutSec: 0,
      config: getTaskConfig(task),
      platformType: task.platformType,
    }).catch(() => {});
  }
}

function findGroupForTask(task) {
  const groupKey = task?.destinationGroupKey || task?.key;
  return state.groups.find((group) => group.key === groupKey) || null;
}

function parkTaskEntry(tabId, entry, reason) {
  if (!entry) return;
  entry.agentPaused = true;
  entry.pendingRejudge = false;
  entry.slotActive = false;
  clearEntryTimeout(entry);
  clearManualWaitTimer(entry);
  if (reason) entry.parkedReason = reason;
  const task = state.tasks.find((item) => item.index === entry.taskIndex);
  if (task?.id) {
    task.confirmationNonce = task.confirmationNonce || crypto.randomUUID();
    state.parkedTaskIds.add(task.id);
  }
  if (tabId) {
    updateActiveBatchRun((activeBatchRun) => ({
      ...activeBatchRun,
      status: state.paused && !state.stopped ? "paused" : "waiting_manual",
      tasks: serializeBatchTasks(state.tasks),
      parkedTaskIds: [...state.parkedTaskIds],
    })).catch(() => {});
  }
}

function persistParkedTaskIds() {
  return updateActiveBatchRun((activeBatchRun) => ({
    ...activeBatchRun,
    parkedTaskIds: [...state.parkedTaskIds],
    tasks: serializeBatchTasks(state.tasks),
  })).catch(() => null);
}

async function advanceDestinationGroup(tabId, completedTask) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  const group = findGroupForTask(completedTask);
  const removedParkedTask = completedTask?.id
    ? state.parkedTaskIds.delete(completedTask.id)
    : false;
  if (removedParkedTask) persistParkedTaskIds();
  const nextTask = self.ExtLinkScheduler.nextPendingTask(group, completedTask.index);
  if (!nextTask) {
    entry.agentDone = true;
    entry.slotActive = true;
    delayCloseTab(tabId, POST_SUCCESS_CLOSE_DELAY_MS);
    return;
  }

  entry.taskIndex = nextTask.index;
  entry.taskId = nextTask.id;
  entry.agentDone = false;
  entry.agentPaused = false;
  entry.pendingRejudge = false;
  entry.contentReadyWhileRunning = false;
  entry.rejudgeAfterRun = false;
  entry.batchPaused = false;
  entry.pauseRequested = false;
  entry.lastContentReady = null;
  entry.readyProbe = null;
  entry.customLaunchGateRequested = false;
  entry.slotActive = true;
  nextTask.status = "pending";
  nextTask.skipReason = "";
  log(
    `${nextTask.domain} [${nextTask.profileName || nextTask.profileId}]: 准备本站下一项目 ${nextTask.groupJobIndex}/${nextTask.groupJobCount}`,
    "",
  );
  broadcastTaskUpdate(nextTask);

  try {
    const tab = await chrome.tabs.get(tabId);
    const targetUrl = nextTask.url.startsWith("http") ? nextTask.url : `https://${nextTask.url}`;
    resetEntryTimeout(entry, tabId, PAGE_LOAD_TIMEOUT_MS);
    if (tab.url === targetUrl) await chrome.tabs.reload(tabId);
    else await chrome.tabs.update(tabId, { url: targetUrl });
  } catch (err) {
    nextTask.status = "needs_manual";
    nextTask.skipReason = `无法重新进入提交入口: ${err.message}`;
    broadcastTaskUpdate(nextTask);
    parkTaskEntry(tabId, entry, nextTask.skipReason);
  }
}

function getManualWaitTimeoutSec() {
  const configured = parseInt(state.config && state.config.manualWaitSec, 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_MANUAL_WAIT_SEC;
}

function clearManualWaitTimer(entry) {
  if (!entry) return;
  if (entry.manualWaitTimeoutId) {
    clearTimeout(entry.manualWaitTimeoutId);
    entry.manualWaitTimeoutId = null;
  }
}

function startManualWaitTimer(tabId, task, entry) {
  clearManualWaitTimer(entry);
  entry.manualWaitTimeoutId = null;
}

function skipTaskDueToManualTimeout(tabId, task, entry) {
  bumpEntryRunId(entry);
  entry.agentDone = true;
  entry.agentPaused = false;
  clearManualWaitTimer(entry);
  task.status = "skip";
  task.skipReason = `等待 ${getManualWaitTimeoutSec()} 秒未继续，自动跳过`;
  log(`${task.domain}: ${task.skipReason}`, "warn");
  broadcastTaskUpdate(task);
  chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
  closeTab(tabId);
}

function skipTaskWithReason(tabId, task, entry, reason) {
  bumpEntryRunId(entry);
  entry.agentDone = true;
  entry.agentPaused = false;
  clearManualWaitTimer(entry);
  clearEntryTimeout(entry);
  task.status = "skip";
  task.skipReason = reason;
  log(`${task.domain}: ${reason}`, "warn");
  broadcastTaskUpdate(task);
  if (tabId && entry) {
    chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
    advanceDestinationGroup(tabId, task).catch(() => closeTab(tabId));
  }
}

function isAgentUnavailableError(err) {
  const message = err && err.message ? err.message : "";
  return /云端|cloud|worker|fetch/i.test(message);
}

function cancelRemainingDestinationTasks(task, status, reason) {
  const group = findGroupForTask(task);
  for (const sibling of group?.tasks || []) {
    if (sibling.index === task.index || sibling.status !== "pending") continue;
    sibling.status = "skip";
    sibling.skipReason = `blocked_by_destination:${status}:${reason || ""}`;
    broadcastTaskUpdate(sibling);
  }
}

function markTaskNeedsManual(tabId, task, entry, reason, preferredStatus = "") {
  const url = task.url?.startsWith("http") ? task.url : `https://${task.url}`;
  const fallback =
    preferredStatus ||
    (/captcha|验证码/i.test(String(reason || ""))
      ? "needs_captcha"
      : /product hunt|多步骤发布需人工|custom launch/i.test(String(reason || ""))
        ? "needs_manual"
        : "needs_login");
  if (self.ExtLinkBatchControls.shouldAutoSkipGate(state.config?.autoSkipCaptcha, fallback)) {
    skipTaskWithReason(tabId, task, entry, reason || "验证码任务已配置为自动跳过");
    return;
  }

  autoClassifySite(url, reason || "需要人工处理", fallback)
    .then((classified) => {
      const status = classified?.status || fallback;
      if (self.ExtLinkQueue.isDeadEndStatus(status)) {
        bumpEntryRunId(entry);
        entry.agentDone = true;
        entry.agentPaused = true;
        entry.slotActive = false;
        entry.pendingRejudge = false;
        clearManualWaitTimer(entry);
        clearEntryTimeout(entry);
        task.status = "skip";
        task.skipReason = reason || status;
        cancelRemainingDestinationTasks(task, status, reason);
        log(`${task.domain}: 已自动分类为 ${status}，保留页签并继续下一站`, "warn");
        broadcastTaskUpdate(task);
        if (tabId) closeTab(tabId);
        return;
      }

      task.status = self.ExtLinkBatchControls.parkedTaskStatus(status);
      task.skipReason = reason;
      parkTaskEntry(tabId, entry, reason);
      const projectLabel = task.projectKey ? ` [${task.projectKey}]` : "";
      log(
        `${task.domain}${projectLabel}: 等待人工（${status}）- ${reason}；保留页签继续下一站`,
        "warn",
      );
      broadcastTaskUpdate(task);

      if (!tabId) return;

      // Keep tab open but do not steal focus — queue continues next site.
      chrome.tabs
        .sendMessage(tabId, {
          action: "showManualWaitBanner",
          taskIndex: task.index,
          reason,
          timeoutSec: 0,
          config: getTaskConfig(task),
          platformType: task.platformType,
        })
        .catch(() => {});

      startManualWaitTimer(tabId, task, entry);
    })
    .catch(() => {
      task.status = self.ExtLinkBatchControls.parkedTaskStatus(fallback);
      task.skipReason = reason;
      parkTaskEntry(tabId, entry, reason);
      broadcastTaskUpdate(task);
      if (tabId) {
        chrome.tabs
          .sendMessage(tabId, {
            action: "showManualWaitBanner",
            taskIndex: task.index,
            reason,
            timeoutSec: 0,
            config: getTaskConfig(task),
            platformType: task.platformType,
          })
          .catch(() => {});
        startManualWaitTimer(tabId, task, entry);
      }
    });
}

function markTaskBlocked(tabId, task, entry, reason) {
  const url = task.url?.startsWith("http") ? task.url : `https://${task.url}`;
  entry.agentPaused = true;
  entry.pendingRejudge = false;
  clearEntryTimeout(entry);
  clearManualWaitTimer(entry);

  autoClassifySite(url, reason || "无法提交", "broken")
    .then((classified) => {
      const status = classified?.status || "broken";
      const isDeadEnd = self.ExtLinkQueue.isDeadEndStatus(status);
      task.status = status === "paid" ? "skip" : isDeadEnd ? "err" : "needs_manual";
      task.skipReason = reason;
      if (isDeadEnd) {
        cancelRemainingDestinationTasks(task, status, reason);
        entry.agentDone = true;
        entry.slotActive = false;
        if (tabId) closeTab(tabId);
      } else {
        parkTaskEntry(tabId, entry, reason);
      }
      log(`${task.domain}: 已自动分类为 ${status} - ${reason}`, "err");
      broadcastTaskUpdate(task);
    })
    .catch(() => {
      task.status = "err";
      task.skipReason = reason;
      parkTaskEntry(tabId, entry, reason);
      log(`${task.domain}: 云端 AI 停止 - ${reason}`, "err");
      broadcastTaskUpdate(task);
    });
}

async function getTabUrlSafe(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url?.startsWith("http") ? tab.url : "";
  } catch {
    return "";
  }
}

function markPendingRejudge(task, entry, tabId, reason) {
  entry.pendingRejudge = true;
  entry.agentPaused = false;
  entry.rejudgeAfterRun = entry.contentReadyWhileRunning === true;
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  log(`${task.domain}: 等待导航完成后重新判断 - ${reason}`, "");
}

function pauseEntryForBatch(tabId, task, entry) {
  if (!entry || !state.paused || state.stopped) return;
  entry.batchPaused = true;
  entry.pauseRequested = false;
  entry.agentPaused = true;
  entry.pendingRejudge = false;
  clearEntryTimeout(entry);
  log(`${task.domain}: 已暂停，保留当前页签与已填写内容`, "warn", {
    event: "task_paused",
    taskIndex: task.index,
    taskId: task.id,
    domain: task.domain,
    profileId: task.profileId,
  });
}

function resumePendingRejudgeAfterRun(tabId, task, entry) {
  if (state.stopped) return;
  if (!entry.rejudgeAfterRun || !entry.pendingRejudge || entry.agentDone || entry.agentPaused)
    return;
  if (!state.activeTabs.has(tabId)) return;
  entry.rejudgeAfterRun = false;
  entry.contentReadyWhileRunning = false;
  handleContentReady(
    { id: tabId, url: task.url },
    entry.lastContentReady || { mode: "unknown" },
  ).catch((err) =>
    log(`${task.domain}: 重新判断失败 - ${err.message}`, "err", {
      event: "rejudge_failed",
      taskIndex: task.index,
      domain: task.domain,
      profileId: task.profileId,
      stack: err.stack,
    }),
  );
}

function isNavigationSnapshotError(err) {
  const message = err && err.message ? err.message : "";
  return /snapshot unavailable|receiving end does not exist|could not establish connection|no tab with id|frame was removed|extension context invalidated/i.test(
    message,
  );
}

function nextEntryRunId(entry) {
  entry.runId = (entry.runId || 0) + 1;
  return entry.runId;
}

function bumpEntryRunId(entry) {
  entry.runId = (entry.runId || 0) + 1;
  return entry.runId;
}

function assertRunCurrent(tabId, entry, runId) {
  if (state.stopped || !state.activeTabs.has(tabId) || entry.runId !== runId) {
    const err = new Error("stale agent run");
    err.staleRun = true;
    throw err;
  }
  if (state.paused && !state.stopped) {
    const err = new Error("batch run paused");
    err.batchPaused = true;
    throw err;
  }
}

// ─── Tab Management ───
function clearEntryTimeout(entry) {
  if (entry && entry.timeoutId) {
    clearTimeout(entry.timeoutId);
    entry.timeoutId = null;
  }
}

function resetEntryTimeout(entry, tabId, timeoutMs = PAGE_LOAD_TIMEOUT_MS) {
  if (!entry) return;
  clearEntryTimeout(entry);
  entry.timeoutId = setTimeout(() => {
    if (state.activeTabs.has(tabId)) {
      handleTimeout(tabId);
    }
  }, timeoutMs);
}

async function navigateTaskTab(tabId, entry, url) {
  resetEntryTimeout(entry, tabId);
  await chrome.tabs.update(tabId, { url, active: true });
}

function closeTab(tabId) {
  const entry = state.activeTabs.get(tabId);
  if (entry && state.paused && !state.stopped && entry.slotActive !== false) {
    clearEntryTimeout(entry);
    entry.closeAfterResume = true;
    return;
  }
  if (entry) {
    bumpEntryRunId(entry);
    clearEntryTimeout(entry);
  }
  state.activeTabs.delete(tabId);
  chrome.tabs
    .remove(tabId)
    .catch(() => {})
    .finally(() => {
      if (self.ExtLinkBatchControls.shouldProcessQueue(state) && state.queue.length > 0) {
        scheduleQueueProcessing();
      }
      refreshBatchRunStatus().catch((err) =>
        log(`刷新批次状态失败: ${err.message}`, "err", { event: "run_status_failed" }),
      );
    });
}

function delayCloseTab(tabId, delayMs) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  clearEntryTimeout(entry);
  if (state.paused && !state.stopped) {
    entry.closeAfterResume = true;
    return;
  }
  entry.timeoutId = setTimeout(() => closeTab(tabId), delayMs);
}

function closeAllTabs() {
  for (const [tabId, entry] of state.activeTabs) {
    bumpEntryRunId(entry);
    clearEntryTimeout(entry);
    chrome.tabs.remove(tabId).catch(() => {});
  }
  state.activeTabs.clear();
}

function closeAutomatedTabs() {
  for (const [tabId, entry] of [...state.activeTabs.entries()]) {
    const task = state.tasks.find((item) => item.index === entry.taskIndex);
    const customLaunch = isCustomLaunchTask(task);
    const disposition = self.ExtLinkBatchControls.stopTabDisposition({
      entry,
      parkedTaskIds: state.parkedTaskIds,
      taskStatus: task?.status,
      customLaunch: false,
    });
    if (disposition === "preserve_manual") {
      bumpEntryRunId(entry);
      clearEntryTimeout(entry);
      clearManualWaitTimer(entry);
      entry.agentDone = true;
      entry.agentPaused = true;
      entry.pendingRejudge = false;
      entry.slotActive = false;
      if (task) {
        const reason = task.skipReason || "任务已停止，保留页签等待人工处理";
        if (!["captcha", "needs_manual"].includes(task.status)) {
          task.status = self.ExtLinkBatchControls.parkedTaskStatus(task.status);
        }
        task.skipReason = reason;
        entry.parkedReason = reason;
        if (task.id) state.parkedTaskIds.add(task.id);
        broadcastTaskUpdate(task);
      }
      continue;
    }
    if (task && ["pending", "running", "filled"].includes(task.status)) {
      task.status = "pending";
      task.skipReason = "";
      broadcastTaskUpdate(task);
    }
    bumpEntryRunId(entry);
    clearEntryTimeout(entry);
    clearManualWaitTimer(entry);
    state.activeTabs.delete(tabId);
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = state.activeTabs.get(tabId);
  if (entry) {
    bumpEntryRunId(entry);
    const task = state.tasks.find((t) => t.index === entry.taskIndex);
    if (task && entry.slotActive === false) {
      // A parked page is owned by the human-review queue. Closing it must not
      // turn the task into a skip or silently start another task.
      task.skipReason = task.skipReason || "待人工页签已关闭，请重新打开后继续";
      broadcastTaskUpdate(task);
    } else if (task && !["ok", "skip", "err"].includes(task.status)) {
      if (state.stopped) {
        task.status = "pending";
        task.skipReason = "停止后自动任务页签已关闭，可重新开始批次";
        broadcastTaskUpdate(task);
      } else {
        task.status = "skip";
        task.skipReason = "tab_closed_current_run";
        broadcastTaskUpdate(task);
        const group = findGroupForTask(task);
        const nextTask = self.ExtLinkScheduler.nextPendingTask(group, task.index);
        if (nextTask) {
          state.queue.unshift(group);
          state.running = true;
          state.stopped = false;
          if (!state.paused) scheduleQueueProcessing();
        }
      }
    }
    state.activeTabs.delete(tabId);
    persistParkedTaskIds();
    refreshBatchRunStatus().catch(() => {});
  }
});

function countProcessingTabs() {
  return self.ExtLinkScheduler.countProcessingSlots(state.activeTabs);
}

// ─── Messaging ───
function broadcastTaskUpdate(task) {
  const logSignature = `${task.status}|${task.skipReason || ""}`;
  if (task._lastLogSignature !== logSignature) {
    task._lastLogSignature = logSignature;
    log(
      `[${task.index}/${state.tasks.length}] ${task.domain} · ${task.profileName}: ${task.status}${task.skipReason ? ` - ${task.skipReason}` : ""}`,
      task.status === "err" ? "err" : ["skip", "captcha", "needs_manual", "filled"].includes(task.status) ? "warn" : "",
      {
        event: "task_status",
        taskIndex: task.index,
        taskId: task.id,
        domain: task.domain,
        profileId: task.profileId,
      },
    );
    const terminalAttempt = ["ok", "err", "skip"].includes(task.status);
    recordAutomationEvent(task, {
      type: "task_status",
      status: task.status,
      ...(terminalAttempt ? { finishedAt: new Date().toISOString() } : {}),
      result: task.skipReason || task.successEvidence || "",
      errorCode: task.status === "err" ? "task_failed" : "",
      evidenceType: task.evidenceType || "",
      artifactRef: task.artifactRef || "",
    });
  }
  chrome.runtime
    .sendMessage({
      action: "taskUpdate",
      index: task.index,
      taskId: task.id,
      status: task.status,
      profileId: task.profileId,
      profileName: task.profileName,
      destinationGroupKey: task.destinationGroupKey,
      domain: task.domain,
      groupJobIndex: task.groupJobIndex,
      groupJobCount: task.groupJobCount,
      skipReason: task.skipReason,
      isDofollow: task.isDofollow,
      rel: task.relResult,
    })
    .catch(() => {}); // popup may not be open
}

function broadcastStatus() {
  const status = getBatchStatus();
  chrome.runtime
    .sendMessage({
      action: "status",
      running: state.running,
      paused: state.paused,
      stopped: state.stopped,
      status,
    })
    .catch(() => {});
}

async function resetBatchLog(runId, selectedSiteIds = []) {
  if (batchLogFlushTimer) {
    clearTimeout(batchLogFlushTimer);
    batchLogFlushTimer = null;
  }
  await flushBatchLogEntries();
  const startedAt = new Date().toISOString();
  await chrome.storage.local.set({
    [BATCH_LOG_STORAGE_KEY]: {
      schemaVersion: 1,
      runId,
      startedAt,
      updatedAt: startedAt,
      selectedSiteIds,
      entries: [],
    },
  });
  chrome.runtime.sendMessage({ action: "batchLogReset", runId, startedAt }).catch(() => {});
}

function persistBatchLogEntry(entry) {
  pendingBatchLogEntries.push(entry);
  if (!batchLogFlushTimer) {
    batchLogFlushTimer = setTimeout(() => {
      batchLogFlushTimer = null;
      flushBatchLogEntries();
    }, 350);
  }
}

function flushBatchLogEntries() {
  const pending = pendingBatchLogEntries.splice(0);
  if (!pending.length) return batchLogWritePromise;
  batchLogWritePromise = batchLogWritePromise
    .then(async () => {
      const stored = await chrome.storage.local.get(BATCH_LOG_STORAGE_KEY);
      const current = stored[BATCH_LOG_STORAGE_KEY] || {
        schemaVersion: 1,
        runId: pending[0]?.runId || "diagnostic",
        startedAt: pending[0]?.at,
        selectedSiteIds: [],
        entries: [],
      };
      const entries = [...(Array.isArray(current.entries) ? current.entries : []), ...pending].slice(
        -BATCH_LOG_LIMIT,
      );
      const latest = pending[pending.length - 1];
      await chrome.storage.local.set({
        [BATCH_LOG_STORAGE_KEY]: {
          ...current,
          runId: current.runId || latest.runId || "diagnostic",
          updatedAt: latest.at,
          entries,
        },
      });
    })
    .catch((err) => {
      console.warn("ExternalLink batch log persistence failed", err);
      chrome.runtime
        .sendMessage({
          action: "logPersistenceError",
          error: err.message || String(err),
        })
        .catch(() => {});
    });
  return batchLogWritePromise;
}

function log(msg, cls, context = {}) {
  const at = new Date().toISOString();
  const message = String(msg || "").slice(0, 2000);
  const entry = {
    id: `${at}-${Math.random().toString(36).slice(2, 9)}`,
    at,
    time: new Date(at).toLocaleTimeString(),
    level: cls === "err" ? "error" : cls === "warn" ? "warn" : cls === "ok" ? "success" : "info",
    cls: cls || "",
    event: String(context.event || "runtime").slice(0, 80),
    runId: state.runId || "",
    message,
    ...(context.taskIndex ? { taskIndex: context.taskIndex } : {}),
    ...(context.taskId ? { taskId: context.taskId } : {}),
    ...(context.domain ? { domain: String(context.domain).slice(0, 255) } : {}),
    ...(context.profileId ? { profileId: String(context.profileId).slice(0, 160) } : {}),
    ...(context.destinationTotal !== undefined
      ? { destinationTotal: Number(context.destinationTotal) || 0 }
      : {}),
    ...(context.taskTotal !== undefined ? { taskTotal: Number(context.taskTotal) || 0 } : {}),
    ...(context.selectedSiteIds ? { selectedSiteIds: context.selectedSiteIds } : {}),
    ...(context.stack ? { stack: String(context.stack).slice(0, 3000) } : {}),
  };
  const consoleMethod = entry.level === "error" ? "error" : entry.level === "warn" ? "warn" : "log";
  console[consoleMethod](`[ExternalLink][${entry.event}] ${message}`, context.stack || "");
  persistBatchLogEntry(entry);
  chrome.runtime.sendMessage({ action: "log", msg: message, cls, entry }).catch(() => {});
}

// ─── IndexNow Ping ───
async function pingIndexNow(url) {
  try {
    await fetch(
      "https://www.bing.com/indexnow?url=" +
        encodeURIComponent(url) +
        "&key=ea4b5c1e2f3a4b5c6d7e8f9a0b1c2d3e",
      {
        mode: "no-cors",
      },
    );
  } catch (e) {
    /* ignore */
  }
}

// ─── Helpers ───
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ExternalLink Extension - Background Orchestrator
"use strict";

let state = {
  running: false,
  tasks: [],
  config: null,
  queue: [],
  activeTabs: new Map(), // tabId -> { taskIndex, redirectCount }
  concurrency: 5,
  stopped: false,
};

const PAGE_LOAD_TIMEOUT_MS = 45000;
const EXECUTION_TIMEOUT_MS = 180000;
const POST_SUCCESS_CLOSE_DELAY_MS = 15000;
const LOCAL_AGENT_URL = "http://127.0.0.1:8787";
const MAX_AGENT_LOOPS = 6;
const AGENT_ACTION_SETTLE_MS = 1500;
const SNAPSHOT_RETRY_ATTEMPTS = 5;
const SNAPSHOT_RETRY_MS = 700;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case "start":
      closeAllTabs();
      state.config = msg.config;
      state.tasks = msg.tasks;
      state.queue = [...msg.tasks];
      state.concurrency = msg.config.concurrency;
      state.running = true;
      state.stopped = false;
      broadcastStatus();
      log("开始处理 " + state.tasks.length + " 个任务", "ok");
      processQueue();
      break;
    case "stop":
      state.stopped = true;
      state.running = false;
      closeAllTabs();
      broadcastStatus();
      log("任务已停止", "warn");
      break;
    case "contentReady":
      handleContentReady(sender.tab, msg);
      break;
    case "captchaResolved":
      resumeAfterCaptcha(sender.tab.id, msg);
      break;
    case "manualSubmit":
      handleManualSubmit(msg);
      break;
    case "manualSkip":
      handleManualSkip(msg);
      break;
  }
});

// ─── Queue Processing ───
async function processQueue() {
  while (state.running && state.queue.length > 0 && !state.stopped) {
    while (countProcessingTabs() < state.concurrency && state.queue.length > 0) {
      const task = state.queue.shift();
      await processOne(task);
    }
    await sleep(500);
  }
  if (state.queue.length === 0 && countProcessingTabs() === 0) {
    state.running = false;
    broadcastStatus();
    log("✅ 所有任务处理完毕", "ok");
  }
}

async function processOne(task) {
  try {
    const url = task.url.startsWith("http") ? task.url : "https://" + task.url;
    task.status = "running";
    broadcastTaskUpdate(task);

    const tab = await chrome.tabs.create({ url, active: false });
    const entry = { taskIndex: task.index, timeoutId: null, runId: 0 };
    state.activeTabs.set(tab.id, entry);
    resetEntryTimeout(entry, tab.id, PAGE_LOAD_TIMEOUT_MS);
  } catch (err) {
    log(`创建标签页失败: ${task.domain} - ${err.message}`, "err");
    task.status = "err";
    broadcastTaskUpdate(task);
  }
}

// ─── Content Script Callbacks ───
async function handleContentReady(tab, data) {
  const entry = state.activeTabs.get(tab.id);
  if (!entry) return;
  if (entry.agentDone) return;
  if (entry.agentRunning) {
    entry.pendingRejudge = true;
    entry.contentReadyWhileRunning = true;
    return;
  }
  const shouldResumeRejudge = entry.pendingRejudge;
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (!task) return;
  if (entry.agentPaused && !shouldResumeRejudge) {
    if (!looksReadyForManualResume(data)) return;
    log(`页面就绪: ${task.domain} ${data.mode}，自动继续半自动填表`, "");
    resetEntryTimeout(entry, tab.id, EXECUTION_TIMEOUT_MS);
    await runAgentLoop(tab.id, task, entry, { manual: true, resumedFromContentReady: true });
    return;
  }

  log(`页面就绪: ${task.domain} ${data.mode}`, "");
  resetEntryTimeout(entry, tab.id, EXECUTION_TIMEOUT_MS);
  if (shouldResumeRejudge) {
    await runAgentLoop(tab.id, task, entry, { pendingRejudge: true });
    return;
  }
  await runAgentLoop(tab.id, task, entry);
  return;
}

function looksReadyForManualResume(data) {
  const mode = data && typeof data.mode === "string" ? data.mode : "";
  return !!mode && mode !== "unknown";
}

function handleTimeout(tabId) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (task) {
    bumpEntryRunId(entry);
    task.status = "err";
    task.skipReason = "timeout";
    entry.agentPaused = true;
    entry.pendingRejudge = false;
    clearEntryTimeout(entry);
    log(`${task.domain}: 本地代理循环超时，请手动检查`, "warn");
    broadcastTaskUpdate(task);
  }
}

// ─── Manual continue: user clicked "继续填表" from banner ───
async function handleManualSubmit(msg) {
  const { taskIndex, config, platformType } = msg;
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
    task.status = "skip";
    task.skipReason = "tab_closed";
    broadcastTaskUpdate(task);
    return;
  }

  log(`${task.domain}: 用户手动触发填表`, "");
  const entry = state.activeTabs.get(tabId);
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  await runAgentLoop(tabId, task, entry, {
    config: config || state.config,
    platformType: platformType || task.platformType,
    manual: true,
  });
  return;
}

// ─── Manual skip: user clicked "跳过" from banner ───
function handleManualSkip(msg) {
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

  task.status = "skip";
  task.skipReason = "manual_skip";
  log(`${task.domain}: 用户手动跳过`, "warn");
  broadcastTaskUpdate(task);
  if (tabId) {
    closeTab(tabId);
  }
}

async function resumeAfterCaptcha(tabId, data) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (!task) return;

  log(`${task.domain}: 验证码已处理，重新运行本地代理判断`, "");
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  await runAgentLoop(tabId, task, entry, { captchaResolved: true, data });
}

// ─── Local Agent Loop ───
async function callLocalAgent(endpoint, payload) {
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  let response;
  try {
    response = await fetch(`${LOCAL_AGENT_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new Error(`DeepSeek local agent unavailable at ${LOCAL_AGENT_URL}: ${err.message}`);
  }

  const text = await response.text();
  let data = null;
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch (err) {
      if (response.ok) {
        throw new Error(`DeepSeek local agent ${path} returned invalid JSON`);
      }
    }
  }

  if (!response.ok) {
    const detail =
      (data && (data.message || data.reason)) ||
      text.trim().slice(0, 300) ||
      response.statusText ||
      "request failed";
    throw new Error(`DeepSeek local agent ${path} HTTP ${response.status}: ${detail}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(`DeepSeek local agent ${path} returned an invalid response shape`);
  }
  return data;
}

async function getTabSnapshot(tabId) {
  let snapshot;
  let lastError;
  for (let attempt = 0; attempt < SNAPSHOT_RETRY_ATTEMPTS; attempt++) {
    try {
      snapshot = await chrome.tabs.sendMessage(tabId, { action: "getPageSnapshot" });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
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
    throw new Error("local agent returned no actions to execute");
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
    throw new Error(result.error || (failed && failed.error) || "content script could not execute action plan");
  }
  return result;
}

function agentPayload(task, snapshot, extra = {}) {
  const payload = {
    task: {
      index: task.index,
      domain: task.domain,
      url: task.url,
      platformType: extra.platformType || task.platformType || "auto",
    },
    config: extra.config || state.config || {},
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
  const runId = nextEntryRunId(entry);
  entry.agentRunning = true;
  entry.agentPaused = false;
  entry.pendingRejudge = false;

  try {
    task.status = "running";
    broadcastTaskUpdate(task);

    let snapshot = await getTabSnapshot(tabId);
    assertRunCurrent(tabId, entry, runId);
    let judge = await callLocalAgent("/judge", agentPayload(task, snapshot, extra));
    assertRunCurrent(tabId, entry, runId);
    if (judge.status === "success") {
      completeTaskFromJudge(tabId, task, judge);
      return;
    }
    if (handleTerminalJudge(task, entry, judge)) return;

    for (let loop = 0; loop < MAX_AGENT_LOOPS && !state.stopped; loop++) {
      const plan = await callLocalAgent("/plan", agentPayload(task, snapshot, { ...extra, judge, loop }));
      assertRunCurrent(tabId, entry, runId);

      if (plan.status === "needs_manual") {
        markTaskNeedsManual(task, entry, plan.reason || plan.message || "local agent needs manual input");
        return;
      }
      if (plan.status === "blocked" || plan.status === "error") {
        markTaskBlocked(task, entry, plan.reason || plan.message || "local agent blocked this page");
        return;
      }
      if (plan.status !== "act") {
        markTaskNeedsManual(task, entry, plan.reason || plan.message || `unsupported plan status: ${plan.status}`);
        return;
      }

      log(`${task.domain}: 本地代理执行第 ${loop + 1} 轮动作 - ${summarizePlanActions(plan.actions)}`, "");
      const actionResult = await executeTabActions(tabId, plan.actions);
      log(`${task.domain}: 第 ${loop + 1} 轮结果 - ${summarizeActionResults(actionResult)}`, "");
      assertRunCurrent(tabId, entry, runId);
      await sleep(AGENT_ACTION_SETTLE_MS);
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
      judge = await callLocalAgent("/judge", agentPayload(task, snapshot, { ...extra, plan, loop }));
      assertRunCurrent(tabId, entry, runId);
      log(`${task.domain}: 第 ${loop + 1} 轮判断 - ${judge.status}: ${judge.reason || judge.message || ""}`, "");
      if (judge.status === "success") {
        completeTaskFromJudge(tabId, task, judge);
        return;
      }
      if (handleTerminalJudge(task, entry, judge)) return;
    }

    markTaskNeedsManual(task, entry, `local agent did not reach success after ${MAX_AGENT_LOOPS} loops`);
  } catch (err) {
    if (err && err.staleRun) return;
    task.status = "err";
    task.skipReason = err.message;
    entry.agentPaused = true;
    clearEntryTimeout(entry);
    log(`${task.domain}: ${err.message}`, "err");
    broadcastTaskUpdate(task);
  } finally {
    entry.agentRunning = false;
    resumePendingRejudgeAfterRun(tabId, task, entry);
  }
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
    .map(item => {
      const status = item.ok ? "ok" : `fail:${item.error || "unknown"}`;
      const selector = item.selector ? ` ${shortText(item.selector, 80)}` : "";
      return `${item.index + 1}.${item.type || "unknown"} ${status}${selector}`;
    })
    .join("; ");
}

function shortText(value, limit) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

function handleTerminalJudge(task, entry, judge) {
  if (!judge || typeof judge !== "object") {
    markTaskNeedsManual(task, entry, "judge returned an invalid response");
    return true;
  }
  if (judge.status === "blocked") {
    markTaskBlocked(task, entry, judge.reason || judge.message || "judge blocked this page");
    return true;
  }
  if (judge.status === "needs_manual") {
    markTaskNeedsManual(task, entry, judge.reason || judge.message || "judge needs manual input");
    return true;
  }
  if (judge.status === "error") {
    markTaskNeedsManual(task, entry, judge.reason || judge.message || "judge returned an error");
    return true;
  }
  return false;
}

function completeTaskFromJudge(tabId, task, judge) {
  const entry = state.activeTabs.get(tabId);
  if (entry) {
    entry.agentDone = true;
    entry.pendingRejudge = false;
  }
  task.status = "ok";
  task.skipReason = "";
  log(`${task.domain}: 提交成功 - ${judge.reason || judge.message || "judge success"}`, "ok");
  if (state.config && state.config.pingIndex) {
    pingIndexNow(task.url);
  }
  broadcastTaskUpdate(task);
  delayCloseTab(tabId, POST_SUCCESS_CLOSE_DELAY_MS);
}

function markTaskNeedsManual(task, entry, reason) {
  task.status = "captcha";
  task.skipReason = reason;
  entry.agentPaused = true;
  entry.pendingRejudge = false;
  clearEntryTimeout(entry);
  log(`${task.domain}: 需要人工处理 - ${reason}`, "warn");
  broadcastTaskUpdate(task);
}

function markTaskBlocked(task, entry, reason) {
  task.status = "err";
  task.skipReason = reason;
  entry.agentPaused = true;
  entry.pendingRejudge = false;
  clearEntryTimeout(entry);
  log(`${task.domain}: 本地代理停止 - ${reason}`, "err");
  broadcastTaskUpdate(task);
}

function markPendingRejudge(task, entry, tabId, reason) {
  entry.pendingRejudge = true;
  entry.agentPaused = false;
  entry.rejudgeAfterRun = entry.contentReadyWhileRunning === true;
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  log(`${task.domain}: 等待导航完成后重新判断 - ${reason}`, "");
}

function resumePendingRejudgeAfterRun(tabId, task, entry) {
  if (!entry.rejudgeAfterRun || !entry.pendingRejudge || entry.agentDone || entry.agentPaused) return;
  if (!state.activeTabs.has(tabId)) return;
  entry.rejudgeAfterRun = false;
  entry.contentReadyWhileRunning = false;
  runAgentLoop(tabId, task, entry, { pendingRejudge: true });
}

function isNavigationSnapshotError(err) {
  const message = err && err.message ? err.message : "";
  return /snapshot unavailable|receiving end does not exist|could not establish connection|no tab with id|frame was removed|extension context invalidated/i.test(message);
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
  if (!state.activeTabs.has(tabId) || entry.runId !== runId) {
    const err = new Error("stale agent run");
    err.staleRun = true;
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
  if (entry) {
    bumpEntryRunId(entry);
    clearEntryTimeout(entry);
  }
  state.activeTabs.delete(tabId);
  chrome.tabs.remove(tabId).catch(() => {});
}

function delayCloseTab(tabId, delayMs) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  clearEntryTimeout(entry);
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

chrome.tabs.onRemoved.addListener((tabId) => {
  const entry = state.activeTabs.get(tabId);
  if (entry) {
    bumpEntryRunId(entry);
    const task = state.tasks.find((t) => t.index === entry.taskIndex);
    if (task && task.status === "running") {
      task.status = "skip";
      broadcastTaskUpdate(task);
    }
    state.activeTabs.delete(tabId);
  }
});

function countProcessingTabs() {
  let count = 0;
  for (const entry of state.activeTabs.values()) {
    if (!entry.agentPaused && !entry.agentDone) count++;
  }
  return count;
}

// ─── Messaging ───
function broadcastTaskUpdate(task) {
  chrome.runtime
    .sendMessage({
      action: "taskUpdate",
      index: task.index,
      status: task.status,
      isDofollow: task.isDofollow,
      rel: task.relResult,
    })
    .catch(() => {}); // popup may not be open
}

function broadcastStatus() {
  chrome.runtime
    .sendMessage({
      action: "status",
      running: state.running,
    })
    .catch(() => {});
}

function log(msg, cls) {
  chrome.runtime.sendMessage({ action: "log", msg, cls }).catch(() => {});
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

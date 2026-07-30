// ExternalLink Extension - Background Orchestrator
"use strict";

importScripts(
  "lib/profiles.js",
  "lib/queue.js",
  "lib/scheduler.js",
  "lib/backup.js",
  "lib/url-library.js",
);

let state = {
  running: false,
  tasks: [],
  config: null,
  queue: [],
  groups: [],
  activeTabs: new Map(), // tabId -> { taskIndex, redirectCount }
  parkedTaskIds: new Set(),
  concurrency: 1,
  stopped: false,
};

const PAGE_LOAD_TIMEOUT_MS = 45000;
const EXECUTION_TIMEOUT_MS = 180000;
const POST_SUCCESS_CLOSE_DELAY_MS = 2000;
const DEFAULT_MANUAL_WAIT_SEC = 120;
const LOCAL_AGENT_URL = "http://127.0.0.1:8787";
const MAX_AGENT_LOOPS = 8;
const AGENT_ACTION_SETTLE_MS = 600;
const SNAPSHOT_RETRY_ATTEMPTS = 5;
const SNAPSHOT_RETRY_MS = 700;
const MAX_FILL_ROUNDS = 6;
const AUTO_FILL_DEBOUNCE_MS = 900;
const SUBMISSION_SCHEMA_VERSION = self.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION || 2;

const autoFillTimers = new Map();
const autoFillInProgress = new Set();
let sidePanelOpen = false;
let initializationPromise = restoreActiveBatchRun().catch((err) => {
  log(`恢复上次批次失败: ${err.message}`, "warn");
});

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
  chrome.storage.local.get(["autoOpenSidePanel"], (items) => {
    if (items.autoOpenSidePanel === undefined) {
      chrome.storage.local.set({ autoOpenSidePanel: false });
    }
  });
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url?.startsWith("http")) return;
  const { autoOpenSidePanel } = await chrome.storage.local.get("autoOpenSidePanel");
  if (autoOpenSidePanel !== true) return;
  try {
    await chrome.sidePanel.setOptions({ tabId, path: "sidepanel.html", enabled: true });
    await chrome.sidePanel.open({ tabId });
  } catch {
    /* side panel may be unavailable */
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.action) {
    case "sidepanelDetect":
      handleSidepanelDetect(msg.tabId)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "sidepanelFill":
      handleSidepanelFill(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
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
      getLibraryManagerState()
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message, items: [] }));
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
    case "advanceSubmission":
      advanceSubmissionQueue(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "start":
      startBatchRun(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "stop":
      state.stopped = true;
      state.running = false;
      closeAllTabs();
      state.parkedTaskIds.clear();
      markActiveBatchStopped();
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
    case "manualContinue":
      handleManualSubmit(msg);
      break;
    case "confirmSubmissionSuccess":
      confirmSubmissionSuccess(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "getState":
      getRuntimeState().then(sendResponse);
      return true;
  }
});

async function startBatchRun(msg) {
  await initializationPromise;
  closeAllTabs();
  const selectedSiteIds = Array.isArray(msg.selectedSiteIds)
    ? [...new Set(msg.selectedSiteIds.filter(Boolean))]
    : [];
  if (!selectedSiteIds.length) {
    throw new Error("请至少选择一个要提交的自家网站");
  }

  await chrome.storage.local.set({ selectedSiteIds });
  const pending = await loadPendingSubmissionTasks({ selectedProfileIds: selectedSiteIds });
  if (!pending.tasks.length) {
    state.running = false;
    state.tasks = [];
    state.groups = [];
    state.queue = [];
    broadcastStatus();
    return {
      ok: true,
      empty: true,
      tasks: [],
      groups: [],
      meta: pending.meta,
      message: "所选网站没有待提交组合",
    };
  }

  state.config = msg.config || {};
  state.tasks = pending.tasks.map((task) => ({ ...task, status: "pending" }));
  state.groups = self.ExtLinkScheduler.groupTasksByDestination(state.tasks);
  state.queue = [...state.groups];
  state.parkedTaskIds.clear();
  state.concurrency = Math.max(1, parseInt(state.config.concurrency, 10) || 1);
  state.running = true;
  state.stopped = false;

  await chrome.storage.local.set({
    activeBatchRun: {
      version: 2,
      runId: `run-${Date.now().toString(36)}`,
      status: "running",
      selectedSiteIds,
      config: state.config,
      parkedTaskIds: [],
      startedAt: new Date().toISOString(),
      tasks: state.tasks,
    },
  });
  broadcastStatus();
  log(
    `开始处理 ${state.groups.length} 个外链站、${state.tasks.length} 个项目组合`,
    "ok",
  );
  processQueue();
  return {
    ok: true,
    tasks: state.tasks,
    groups: state.groups,
    meta: pending.meta,
  };
}

function markActiveBatchStopped() {
  chrome.storage.local
    .get(["activeBatchRun"])
    .then((stored) => {
      if (!stored.activeBatchRun) return;
      return chrome.storage.local.set({
        activeBatchRun: {
          ...stored.activeBatchRun,
          status: "stopped",
          stoppedAt: new Date().toISOString(),
          tasks: state.tasks,
          parkedTaskIds: [],
        },
      });
    })
    .catch(() => {});
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
  return {
    running: state.running,
    tasks: state.tasks,
    groups: state.groups,
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

async function restoreActiveBatchRun() {
  const storage = await chrome.storage.local.get(["activeBatchRun"]);
  const batch = storage.activeBatchRun;
  if (!batch || !["running", "waiting_manual", "paused"].includes(batch.status)) return;
  if (!Array.isArray(batch.tasks) || !batch.tasks.length) return;

  state.config = batch.config || {};
  state.tasks = batch.tasks.map((task) => ({
    ...task,
    status: task.status === "running" ? "pending" : task.status,
  }));
  state.groups = self.ExtLinkScheduler.groupTasksByDestination(state.tasks);
  state.concurrency = Math.max(1, parseInt(state.config.concurrency, 10) || 1);
  state.stopped = false;
  state.parkedTaskIds = new Set(batch.parkedTaskIds || []);

  const tabs = await chrome.tabs.query({});
  for (const taskId of state.parkedTaskIds) {
    const task = state.tasks.find((item) => item.id === taskId);
    if (!task) continue;
    const tab = tabs.find((item) => {
      try {
        return self.ExtLinkQueue.extractDomain(item.url || "") === task.domain;
      } catch {
        return false;
      }
    });
    if (!tab?.id) continue;
    state.activeTabs.set(tab.id, {
      taskIndex: task.index,
      groupKey: task.destinationGroupKey,
      timeoutId: null,
      runId: 0,
      slotActive: false,
      agentPaused: true,
      parkedReason: task.skipReason || "恢复的待人工任务",
    });
  }

  state.queue = self.ExtLinkScheduler.buildRestoredQueue(
    state.groups,
    state.parkedTaskIds,
  );
  state.running = state.queue.length > 0;
  if (state.running) processQueue();
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
      files: ["content.js"],
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
    "cfgCommentTemplate",
  ]);
  const profile = self.ExtLinkProfiles.getActiveProfile(storage);
  if (!self.ExtLinkProfiles.profileConfigured(profile)) {
    return { error: "未配置网站资料，请打开设置页" };
  }

  let config = self.ExtLinkProfiles.buildAgentConfigFromProfile(profile, {
    email: storage.cfgEmail,
    username: storage.cfgName,
    commentTemplate: storage.cfgCommentTemplate,
    fillOnly: true,
  });
  config.learnedFieldMappings = profile.learnedFieldMappings || {};

  if (msg.commentText) {
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

  let smartTotal = 0;
  let skippedFiles = [];
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
    for (let round = 0; round < MAX_FILL_ROUNDS; round++) {
      try {
        const smartResult = await sendTabMessage(tabId, { action: "smartFill", config });
        smartTotal += smartResult.filledCount || 0;
        if (smartResult.skippedFiles?.length) skippedFiles = smartResult.skippedFiles;
      } catch (err) {
        log(`智能填表: ${err.message}`, "warn");
      }

      lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => ({
        emptyCount: 1,
        invalidCount: 0,
        totalCount: 0,
      }));
      if (lastEmpty.emptyCount === 0 && !lastEmpty.invalidCount) break;
      if (msg.useAgent === false) break;

      broadcastAutoFillUpdate({
        tabId,
        status: "filling",
        message: `AI 补全剩余 ${lastEmpty.emptyCount} 个字段…`,
      });

      try {
        agentResult = await runSidepanelAgentFill(tabId, config, platformType, 2);
        if (agentResult?.needs_manual || agentResult?.captcha) break;
      } catch (err) {
        agentResult = { error: err.message };
        if (round === 0) log(`AI 填表: ${err.message}`, "warn");
      }

      lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => ({
        emptyCount: 1,
        invalidCount: 0,
        totalCount: 0,
      }));
      if (lastEmpty.emptyCount === 0 && !lastEmpty.invalidCount) break;
    }

    try {
      await sendTabMessage(tabId, { action: "smartFill", config });
      lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(() => ({
        emptyCount: 1,
        invalidCount: 0,
        totalCount: 0,
      }));
      validation = await runValidateAndFixFill(tabId, config);
      lastEmpty = await sendTabMessage(tabId, { action: "countEmptyFields" }).catch(
        () => lastEmpty,
      );
    } catch (err) {
      log(`填表校验: ${err.message}`, "warn");
    }
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    const hostname = new URL(tab.url).hostname;
    const learned = await sendTabMessage(tabId, { action: "collectFillLearnings", config });
    if (learned?.mappings) {
      await mergeLearnedMappings(storage.activeSiteId, hostname, learned.mappings);
    }
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
    filledCount: smartTotal,
    emptyCount: lastEmpty.emptyCount,
    invalidCount: lastEmpty.invalidCount || 0,
    totalCount: lastEmpty.totalCount,
    submitReady:
      validation?.submitReady !== false && lastEmpty.emptyCount === 0 && !lastEmpty.invalidCount,
    validationIssues: validation?.issues || [],
  });

  return {
    ok: true,
    fillOnly: true,
    filledCount: smartTotal,
    emptyCount: lastEmpty.emptyCount,
    invalidCount: lastEmpty.invalidCount || 0,
    totalCount: lastEmpty.totalCount,
    skippedFiles,
    platform: platformType,
    submitReady:
      validation?.submitReady !== false && lastEmpty.emptyCount === 0 && !lastEmpty.invalidCount,
    validationIssues: validation?.issues || [],
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
  const validation = await callLocalAgent("/validate-fill", {
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
  const destinationKey = siteKeyForUrl(url);
  const storage = await chrome.storage.local.get(["submissionRecords"]);
  const records = storage.submissionRecords || {};
  const key = self.ExtLinkQueue.submissionRecordKey(destinationKey, profileId);
  records[key] = self.ExtLinkQueue.buildSuccessRecord({
    destinationKey,
    destinationUrl: url,
    profileId,
    profileName: task.profileName || task.config?.brandName || profileId,
    confirmedBy: task.confirmedBy || "agent",
    evidence: task.successEvidence || "judge confirmed submission success",
  });
  await chrome.storage.local.set({
    submissionRecords: records,
    submissionSchemaVersion: SUBMISSION_SCHEMA_VERSION,
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

async function getLibraryManagerState() {
  const storage = await chrome.storage.local.get([
    "urlList",
    "siteAnnotations",
    "submissionRecords",
    "siteProfiles",
    "activeSiteId",
    "selectedSiteIds",
    "submissionSchemaVersion",
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
  const urls = self.ExtLinkQueue.resolvePluginUrls(
    storage.urlList || "",
    self.ExtLinkUrlLibrary || [],
  );
  const annotations = storage.siteAnnotations || {};
  const items = urls.map((entry, index) => {
    const key = siteKeyForUrl(entry.url);
    const annotation = annotations[key] || annotations[entry.domain] || null;
    const profileStatuses = Object.values(seeded.profiles).map((profile) => {
      const recordKey = self.ExtLinkQueue.submissionRecordKey(key, profile.id);
      const record = records[recordKey] || null;
      return {
        profileId: profile.id,
        profileName: profile.name || profile.id,
        success: self.ExtLinkQueue.isSubmissionSuccessful(record),
        submittedAt: record?.submittedAt || "",
      };
    });
    return {
      key,
      url: entry.url,
      domain: entry.domain || self.ExtLinkQueue.extractDomain(entry.url),
      source: entry.source || "library",
      platformType: entry.platformType || "directory",
      position: index,
      annotation,
      profileStatuses,
    };
  });
  return { ok: true, items, profiles: seeded.profiles };
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
    },
  };
}

async function importSubmissionData(data) {
  const storage = await chrome.storage.local.get([
    "submissionRecords",
    "siteAnnotations",
    "siteProfiles",
    "urlList",
  ]);
  const importedProfiles =
    data?.siteProfiles && typeof data.siteProfiles === "object" ? data.siteProfiles : {};
  const merged = self.ExtLinkBackup.mergeBackup(storage, data, SUBMISSION_SCHEMA_VERSION);
  await chrome.storage.local.set(merged);
  return {
    ok: true,
    recordsImported: Object.keys(data.submissionRecords).length,
    profilesImported: Object.keys(importedProfiles).length,
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
    /* table library optional */
  }
  return tableData;
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
  const remappedRecords = self.ExtLinkQueue.remapSubmissionRecords(
    existingRecords || {},
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
  });

  const deletedKeys = storage.deletedSubmissionKeys || [];
  const flattened = self.ExtLinkQueue.flattenDestinationGroups(groups);
  const filtered = self.ExtLinkQueue.filterSubmissionTasks(flattened, {
    deletedKeys,
    annotations,
  });

  return {
    tasks: filtered,
    groups,
    selectedProfileIds,
    meta: {
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
    tasks: groups,
    jobs,
    index,
    total: groups.length,
    meta,
    selectedProfileIds,
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
  const matched = self.ExtLinkQueue.matchSubmissionTarget(tabUrl, pendingTasks);
  if (!matched) return;

  const key = siteKeyForUrl(tabUrl);
  const domain = self.ExtLinkQueue.extractDomain(tabUrl);
  const ann = (storage.siteAnnotations || {})[key] || (storage.siteAnnotations || {})[domain];
  if (ann && self.ExtLinkQueue.isDeadEndStatus(ann.status)) return;

  const matchedIndex = pendingTasks.findIndex((t) => t.key === matched.key);
  if (matchedIndex >= 0) {
    await chrome.storage.local.set({ submissionQueueIndex: matchedIndex });
    broadcastAutoFillUpdate({
      tabId,
      status: "queue",
      index: matchedIndex,
      total: pendingTasks.length,
      domain: matched.domain,
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
        const detection = await sendTabMessage(tabId, { action: "detectPage" });
        if (!detection?.operable && !(detection?.formFieldCount > 0)) return;

        autoFillInProgress.add(tabId);
        const result = await handleSidepanelFill({
          tabId,
          mode: "form",
          useAgent: true,
          auto: true,
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
    const plan = await callLocalAgent(
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

    await executeTabActions(tabId, plan.actions);
    await sleep(AGENT_ACTION_SETTLE_MS);
    snapshot = await getTabSnapshot(tabId);
  }

  return { ok: true, fillOnly: true };
}

// ─── Queue Processing ───
async function processQueue() {
  while (state.running && state.queue.length > 0 && !state.stopped) {
    while (countProcessingTabs() < state.concurrency && state.queue.length > 0) {
      const group = state.queue.shift();
      await processOne(group);
    }
    await sleep(500);
  }
  await refreshBatchRunStatus();
}

async function refreshBatchRunStatus() {
  const hasProcessing = countProcessingTabs() > 0;
  const hasQueuedGroups = state.queue.some((group) =>
    (group.tasks || []).some((task) => task.status === "pending"),
  );
  const hasParkedTasks =
    state.parkedTaskIds.size > 0 ||
    [...state.activeTabs.values()].some((entry) => entry.slotActive === false);
  if (hasProcessing || hasQueuedGroups) {
    state.running = true;
    return;
  }

  state.running = false;
  const stored = await chrome.storage.local.get(["activeBatchRun"]);
  if (stored.activeBatchRun) {
    await chrome.storage.local.set({
      activeBatchRun: {
        ...stored.activeBatchRun,
        status: hasParkedTasks ? "waiting_manual" : "finished",
        ...(hasParkedTasks ? {} : { finishedAt: new Date().toISOString() }),
        tasks: state.tasks,
        parkedTaskIds: [...state.parkedTaskIds],
      },
    });
  }
  broadcastStatus();
  if (hasParkedTasks) log("自动队列已跑完，仍有停放任务等待人工处理", "warn");
  else log("✅ 所有任务处理完毕", "ok");
}

async function processOne(group) {
  try {
    const task = (group?.tasks || []).find((item) => item.status === "pending");
    if (!task) return;
    const url = task.url.startsWith("http") ? task.url : "https://" + task.url;
    task.status = "running";
    broadcastTaskUpdate(task);

    const tab = await chrome.tabs.create({ url, active: false });
    const entry = {
      taskIndex: task.index,
      groupKey: group.key,
      timeoutId: null,
      runId: 0,
      slotActive: true,
    };
    state.activeTabs.set(tab.id, entry);
    resetEntryTimeout(entry, tab.id, PAGE_LOAD_TIMEOUT_MS);
  } catch (err) {
    log(`创建标签页失败: ${group?.domain || group?.key || "unknown"} - ${err.message}`, "err");
    for (const task of group?.tasks || []) {
      if (task.status !== "pending") continue;
      task.status = "err";
      task.skipReason = err.message;
      broadcastTaskUpdate(task);
    }
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
    if (state.config && state.config.fillOnly) {
      await runRuleBasedFill(tab.id, task, entry, { manual: true, resumedFromContentReady: true });
      return;
    }
    await runAgentLoop(tab.id, task, entry, { manual: true, resumedFromContentReady: true });
    return;
  }

  log(`页面就绪: ${task.domain} ${data.mode}`, "");
  resetEntryTimeout(entry, tab.id, EXECUTION_TIMEOUT_MS);
  if (state.config && state.config.fillOnly) {
    await runRuleBasedFill(tab.id, task, entry);
    return;
  }
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
    parkTaskEntry(tabId, entry, "本地代理循环超时");
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
    task.status = "needs_manual";
    task.skipReason = "页签已关闭，请在新一轮中重试该组合";
    broadcastTaskUpdate(task);
    return;
  }

  log(`${task.domain}: 用户确认继续，AI 接管后续步骤`, "");
  const entry = state.activeTabs.get(tabId);
  clearManualWaitTimer(entry);
  entry.slotActive = true;
  entry.agentDone = false;
  state.parkedTaskIds.delete(task.id);
  persistParkedTaskIds();
  chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  const activeConfig = getTaskConfig(task, config || {});
  if (activeConfig && activeConfig.fillOnly) {
    await runRuleBasedFill(tabId, task, entry, {
      config: activeConfig,
      platformType: platformType || task.platformType,
      manual: true,
    });
    return;
  }
  await runAgentLoop(tabId, task, entry, {
    config: activeConfig,
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
  let task =
    state.tasks.find((item) => item.index === msg.taskIndex || item.id === msg.taskId) || null;
  if (!task) {
    if (!msg.url || !msg.profileId) throw new Error("缺少待确认的外链站或项目");
    task = {
      id: self.ExtLinkQueue.submissionRecordKey(siteKeyForUrl(msg.url), msg.profileId),
      url: msg.url,
      domain: self.ExtLinkQueue.extractDomain(msg.url),
      destinationGroupKey: siteKeyForUrl(msg.url),
      profileId: msg.profileId,
      profileName: msg.profileName || msg.profileId,
      projectKey: msg.profileId,
      config: { projectKey: msg.profileId, brandName: msg.profileName || msg.profileId },
    };
  }

  task.status = "ok";
  task.skipReason = "";
  task.confirmedBy = "manual";
  task.successEvidence = msg.evidence || "user confirmed submission success";
  await recordSubmittedProject(task);
  broadcastTaskUpdate(task);

  for (const [tabId, entry] of state.activeTabs) {
    if (entry.taskIndex !== task.index) continue;
    entry.agentDone = true;
    await advanceDestinationGroup(tabId, task);
    break;
  }
  return { ok: true, task };
}

async function resumeAfterCaptcha(tabId, data) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (!task) return;

  log(`${task.domain}: 验证码已处理，重新运行本地代理判断`, "");
  clearManualWaitTimer(entry);
  entry.slotActive = true;
  entry.agentDone = false;
  state.parkedTaskIds.delete(task.id);
  persistParkedTaskIds();
  chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
  resetEntryTimeout(entry, tabId, EXECUTION_TIMEOUT_MS);
  await runAgentLoop(tabId, task, entry, { captchaResolved: true, data });
}

// ─── Rule-based fill (no DeepSeek required) ───
async function runRuleBasedFill(tabId, task, entry, extra = {}) {
  if (entry.agentRunning || entry.agentDone) return;
  const runId = nextEntryRunId(entry);
  entry.agentRunning = true;
  entry.agentPaused = false;
  entry.pendingRejudge = false;

  const fillConfig = getTaskConfig(task, { ...(extra.config || {}), fillOnly: true });

  try {
    task.status = "running";
    broadcastTaskUpdate(task);

    let result = await sendExecuteSubmit(
      tabId,
      task,
      fillConfig,
      extra.platformType || task.platformType,
    );
    assertRunCurrent(tabId, entry, runId);

    let navCount = 0;
    while (result && result.navigating && navCount < 4 && !state.stopped) {
      navCount += 1;
      log(`${task.domain}: 打开提交入口 ${result.label || result.url}`, "");
      await navigateTaskTab(tabId, entry, result.url);
      await sleep(4500);
      assertRunCurrent(tabId, entry, runId);
      result = await sendExecuteSubmit(
        tabId,
        task,
        fillConfig,
        extra.platformType || task.platformType,
      );
      assertRunCurrent(tabId, entry, runId);
    }

    if (result && result.captcha) {
      markTaskFilled(tabId, task, entry, "验证码已出现 — 请手动完成并提交");
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
    if (result && (result.fillOnly || result.manual || result.ok)) {
      markTaskFilled(tabId, task, entry, "表单已填写，请检查内容后手动点击提交");
      return;
    }

    markTaskFilled(tabId, task, entry, "未能识别可填写表单，请手动处理");
  } catch (err) {
    if (err && err.staleRun) return;
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
    throw new Error(
      result.error || (failed && failed.error) || "content script could not execute action plan",
    );
  }
  return result;
}

function getTaskConfig(task, extraConfig = {}) {
  const globals = state.config || {};
  const perTask = task && task.config ? task.config : {};
  return {
    ...globals,
    ...perTask,
    ...extraConfig,
    autoSkipCaptcha: globals.autoSkipCaptcha,
    fillOnly: globals.fillOnly,
    manualWaitSec: globals.manualWaitSec,
    pingIndex: globals.pingIndex,
    note: task?.note || perTask.note || globals.note || "",
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
    if (handleTerminalJudge(tabId, task, entry, judge)) return;

    for (let loop = 0; loop < MAX_AGENT_LOOPS && !state.stopped; loop++) {
      const plan = await callLocalAgent(
        "/plan",
        agentPayload(task, snapshot, { ...extra, judge, loop }),
      );
      assertRunCurrent(tabId, entry, runId);

      if (plan.status === "needs_manual") {
        markTaskNeedsManual(
          tabId,
          task,
          entry,
          plan.reason || plan.message || "local agent needs manual input",
        );
        return;
      }
      if (plan.status === "blocked" || plan.status === "error") {
        markTaskBlocked(
          tabId,
          task,
          entry,
          plan.reason || plan.message || "local agent blocked this page",
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
        `${task.domain}: 本地代理执行第 ${loop + 1} 轮动作 - ${summarizePlanActions(plan.actions)}`,
        "",
      );
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
      judge = await callLocalAgent(
        "/judge",
        agentPayload(task, snapshot, { ...extra, plan, loop }),
      );
      assertRunCurrent(tabId, entry, runId);
      log(
        `${task.domain}: 第 ${loop + 1} 轮判断 - ${judge.status}: ${judge.reason || judge.message || ""}`,
        "",
      );
      if (judge.status === "success") {
        completeTaskFromJudge(tabId, task, judge);
        return;
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
    if (isAgentUnavailableError(err)) {
      skipTaskWithReason(
        tabId,
        task,
        entry,
        "本地 AI 代理未运行，请先执行: python3 -m local_agent.server",
      );
      return;
    }
    markTaskNeedsManual(tabId, task, entry, err.message || "AI 执行异常，请手动处理后继续");
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

function completeTaskFromJudge(tabId, task, judge) {
  const entry = state.activeTabs.get(tabId);
  if (entry) {
    entry.agentDone = true;
    entry.pendingRejudge = false;
  }
  task.status = "ok";
  task.skipReason = "";
  task.successEvidence = judge.reason || judge.message || "judge success";
  task.confirmedBy = "agent";
  log(`${task.domain}: 提交成功 - ${judge.reason || judge.message || "judge success"}`, "ok");
  recordSubmittedProject(task)
    .then(() => advanceDestinationGroup(tabId, task))
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
  if (task?.id) state.parkedTaskIds.add(task.id);
  if (tabId) {
    chrome.storage.local
      .get(["activeBatchRun"])
      .then((stored) => {
        if (!stored.activeBatchRun) return;
        return chrome.storage.local.set({
          activeBatchRun: {
            ...stored.activeBatchRun,
            status: "waiting_manual",
            tasks: state.tasks,
            parkedTaskIds: [...state.parkedTaskIds],
          },
        });
      })
      .catch(() => {});
  }
}

function persistParkedTaskIds() {
  chrome.storage.local
    .get(["activeBatchRun"])
    .then((stored) => {
      if (!stored.activeBatchRun) return;
      return chrome.storage.local.set({
        activeBatchRun: {
          ...stored.activeBatchRun,
          parkedTaskIds: [...state.parkedTaskIds],
          tasks: state.tasks,
        },
      });
    })
    .catch(() => {});
}

async function advanceDestinationGroup(tabId, completedTask) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  const group = findGroupForTask(completedTask);
  if (completedTask?.id) state.parkedTaskIds.delete(completedTask.id);
  persistParkedTaskIds();
  const nextTask = self.ExtLinkScheduler.nextPendingTask(group, completedTask.index);
  if (!nextTask) {
    entry.agentDone = true;
    entry.slotActive = true;
    delayCloseTab(tabId, POST_SUCCESS_CLOSE_DELAY_MS);
    return;
  }

  entry.taskIndex = nextTask.index;
  entry.agentDone = false;
  entry.agentPaused = false;
  entry.pendingRejudge = false;
  entry.contentReadyWhileRunning = false;
  entry.rejudgeAfterRun = false;
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
  return /local agent unavailable|127\.0\.0\.1:8787|ECONNREFUSED|Failed to fetch/i.test(message);
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

function markTaskNeedsManual(tabId, task, entry, reason) {
  if (state.config && state.config.autoSkipCaptcha) {
    skipTaskWithReason(tabId, task, entry, reason || "需要人工处理，已配置为自动跳过");
    return;
  }

  const url = task.url?.startsWith("http") ? task.url : `https://${task.url}`;
  const fallback = /captcha|验证码/i.test(String(reason || "")) ? "needs_captcha" : "needs_login";

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

      task.status = status === "needs_login" ? "needs_manual" : "captcha";
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
      task.status = "captcha";
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
      log(`${task.domain}: 本地代理停止 - ${reason}`, "err");
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

function resumePendingRejudgeAfterRun(tabId, task, entry) {
  if (!entry.rejudgeAfterRun || !entry.pendingRejudge || entry.agentDone || entry.agentPaused)
    return;
  if (!state.activeTabs.has(tabId)) return;
  entry.rejudgeAfterRun = false;
  entry.contentReadyWhileRunning = false;
  runAgentLoop(tabId, task, entry, { pendingRejudge: true });
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
    if (task && !["ok", "skip", "err"].includes(task.status)) {
      task.status = "skip";
      task.skipReason = "tab_closed_current_run";
      broadcastTaskUpdate(task);
      const group = findGroupForTask(task);
      const nextTask = self.ExtLinkScheduler.nextPendingTask(group, task.index);
      if (nextTask) {
        state.queue.unshift(group);
        state.running = true;
        state.stopped = false;
        processQueue();
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
  chrome.storage.local
    .get(["activeBatchRun"])
    .then((stored) => {
      if (!stored.activeBatchRun) return;
      return chrome.storage.local.set({
        activeBatchRun: {
          ...stored.activeBatchRun,
          tasks: state.tasks,
        },
      });
    })
    .catch(() => {});
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

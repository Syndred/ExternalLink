// ExternalLink Extension - Background Orchestrator
"use strict";

importScripts("lib/profiles.js", "lib/queue.js", "lib/url-library.js");

let state = {
  running: false,
  tasks: [],
  config: null,
  queue: [],
  activeTabs: new Map(), // tabId -> { taskIndex, redirectCount }
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
    case "advanceSubmission":
      advanceSubmissionQueue(msg)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    case "start":
      closeAllTabs();
      state.config = msg.config;
      state.tasks = msg.tasks;
      state.queue = [...msg.tasks];
      state.concurrency = Math.max(1, parseInt(msg.config.concurrency, 10) || 1);
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
    case "manualContinue":
      handleManualSubmit(msg);
      break;
    case "getState":
      sendResponse({
        running: state.running,
        tasks: state.tasks,
        stats: summarizeTaskStats(state.tasks),
      });
      return false;
  }
});

function summarizeTaskStats(taskList) {
  const stats = { done: 0, skip: 0, err: 0, total: taskList.length, dofollow: 0, nofollow: 0 };
  for (const task of taskList) {
    if (task.status === "ok" || task.status === "filled") stats.done++;
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
  const { tasks, meta } = await loadPendingSubmissionTasks();
  if (!tasks.length) return { ok: true, tasks: [], index: 0, total: 0, meta, advanced: false };

  const storage = await chrome.storage.local.get(["submissionQueueIndex"]);
  let index = Number.isFinite(storage.submissionQueueIndex) ? storage.submissionQueueIndex : 0;
  index = (index + delta + tasks.length) % tasks.length;
  await chrome.storage.local.set({ submissionQueueIndex: index });

  const task = tasks[index];
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
    tasks,
    index,
    total: tasks.length,
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

async function ensureProfilesFromTable(tableData, storedProfiles, activeSiteId) {
  const profiles = { ...(storedProfiles || {}) };
  let changed = false;
  for (const [projectKey, fields] of Object.entries(tableData?.projects || {})) {
    if (self.ExtLinkProfiles.findMatchingProfile(projectKey, profiles)) continue;
    profiles[projectKey] = {
      ...self.ExtLinkProfiles.emptySiteProfile(projectKey, fields.Name || projectKey),
      id: projectKey,
      name: fields.Name || projectKey,
      url: fields.Url || "",
      promoUrl: fields.Url || "",
      fields: { ...fields },
      source: "table",
    };
    changed = true;
  }
  const nextActiveSiteId =
    activeSiteId && profiles[activeSiteId] ? activeSiteId : Object.keys(profiles)[0] || "";
  if (changed || nextActiveSiteId !== activeSiteId) {
    await chrome.storage.local.set({
      siteProfiles: profiles,
      activeSiteId: nextActiveSiteId,
    });
  }
  return { profiles, activeSiteId: nextActiveSiteId };
}

async function ensureSubmissionSchema(tableData, annotations, existingRecords, schemaVersion) {
  const migration = self.ExtLinkQueue.migrateSubmissionRecords({
    records: existingRecords || {},
    annotations: annotations || {},
    tableData,
  });
  if (
    schemaVersion !== SUBMISSION_SCHEMA_VERSION ||
    migration.migratedCount > 0
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
  );
  const annotations = storage.siteAnnotations || {};
  const submissionRecords = await ensureSubmissionSchema(
    tableData,
    annotations,
    storage.submissionRecords || {},
    storage.submissionSchemaVersion,
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
  const selectedProfileIds = requestedProfileIds.filter((id) => seeded.profiles[id]);
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
    },
  };
}

async function getSubmissionQueueState(msg = {}) {
  const { tasks, meta } = await loadPendingSubmissionTasks();
  const storage = await chrome.storage.local.get(["submissionQueueIndex"]);
  let index = Number.isFinite(storage.submissionQueueIndex) ? storage.submissionQueueIndex : 0;

  if (msg.url) {
    const matched = self.ExtLinkQueue.findSubmissionIndex(msg.url, tasks);
    if (matched >= 0) {
      index = matched;
      await chrome.storage.local.set({ submissionQueueIndex: index });
    }
  }

  if (index < 0 || index >= tasks.length) index = 0;
  return { ok: true, tasks, index, total: tasks.length, meta };
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

  log(`${task.domain}: 用户确认继续，AI 接管后续步骤`, "");
  const entry = state.activeTabs.get(tabId);
  clearManualWaitTimer(entry);
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
  task.skipReason = "manual_skip";
  if (entry) entry.agentDone = true;
  log(`${task.domain}: 用户手动跳过`, "warn");
  broadcastTaskUpdate(task);
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
    closeTab(tabId);
  }
}

async function resumeAfterCaptcha(tabId, data) {
  const entry = state.activeTabs.get(tabId);
  if (!entry) return;
  const task = state.tasks.find((t) => t.index === entry.taskIndex);
  if (!task) return;

  log(`${task.domain}: 验证码已处理，重新运行本地代理判断`, "");
  clearManualWaitTimer(entry);
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
      markTaskFilled(task, entry, "验证码已出现 — 请手动完成并提交");
      return;
    }
    if (result && result.waiting) {
      markTaskFilled(task, entry, result.skipReason || "请导航到提交页面后点击「继续填表」");
      return;
    }
    if (result && result.error) {
      markTaskFilled(task, entry, result.skipReason || result.error);
      return;
    }
    if (result && (result.fillOnly || result.manual || result.ok)) {
      markTaskFilled(task, entry, "表单已填写，请检查内容后手动点击提交");
      return;
    }

    markTaskFilled(task, entry, "未能识别可填写表单，请手动处理");
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

function markTaskFilled(task, entry, reason) {
  entry.agentDone = true;
  entry.agentPaused = true;
  entry.pendingRejudge = false;
  clearEntryTimeout(entry);
  task.status = "filled";
  task.skipReason = reason;
  log(`${task.domain}: ${reason}`, "ok");
  broadcastTaskUpdate(task);
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
    markTaskBlocked(task, entry, judge.reason || judge.message || "judge blocked this page");
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
  log(`${task.domain}: 提交成功 - ${judge.reason || judge.message || "judge success"}`, "ok");
  recordSubmittedProject(task).catch(() => {});
  if (state.config && state.config.pingIndex) {
    pingIndexNow(task.url);
  }
  broadcastTaskUpdate(task);
  delayCloseTab(tabId, POST_SUCCESS_CLOSE_DELAY_MS);
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
  const timeoutMs = getManualWaitTimeoutSec() * 1000;
  entry.manualWaitTimeoutId = setTimeout(() => {
    if (!state.activeTabs.has(tabId)) return;
    if (entry.agentDone || !entry.agentPaused) return;
    skipTaskDueToManualTimeout(tabId, task, entry);
  }, timeoutMs);
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
  if (tabId) {
    chrome.tabs.sendMessage(tabId, { action: "removeManualWaitBanner" }).catch(() => {});
    closeTab(tabId);
  }
}

function isAgentUnavailableError(err) {
  const message = err && err.message ? err.message : "";
  return /local agent unavailable|127\.0\.0\.1:8787|ECONNREFUSED|Failed to fetch/i.test(message);
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
        entry.pendingRejudge = false;
        clearManualWaitTimer(entry);
        clearEntryTimeout(entry);
        task.status = "skip";
        task.skipReason = reason || status;
        log(`${task.domain}: 已自动分类为 ${status}，保留页签并继续下一站`, "warn");
        broadcastTaskUpdate(task);
        return;
      }

      task.status = status === "needs_login" ? "needs_manual" : "captcha";
      task.skipReason = reason;
      entry.agentPaused = true;
      entry.pendingRejudge = false;
      clearEntryTimeout(entry);
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
          timeoutSec: getManualWaitTimeoutSec(),
          config: getTaskConfig(task),
          platformType: task.platformType,
        })
        .catch(() => {});

      startManualWaitTimer(tabId, task, entry);
    })
    .catch(() => {
      task.status = "captcha";
      task.skipReason = reason;
      entry.agentPaused = true;
      entry.pendingRejudge = false;
      clearEntryTimeout(entry);
      broadcastTaskUpdate(task);
      if (tabId) {
        chrome.tabs
          .sendMessage(tabId, {
            action: "showManualWaitBanner",
            taskIndex: task.index,
            reason,
            timeoutSec: getManualWaitTimeoutSec(),
            config: getTaskConfig(task),
            platformType: task.platformType,
          })
          .catch(() => {});
        startManualWaitTimer(tabId, task, entry);
      }
    });
}

function markTaskBlocked(task, entry, reason) {
  const url = task.url?.startsWith("http") ? task.url : `https://${task.url}`;
  entry.agentPaused = true;
  entry.pendingRejudge = false;
  clearEntryTimeout(entry);
  clearManualWaitTimer(entry);

  autoClassifySite(url, reason || "无法提交", "broken")
    .then((classified) => {
      const status = classified?.status || "broken";
      task.status = status === "paid" ? "skip" : "err";
      task.skipReason = reason;
      log(`${task.domain}: 已自动分类为 ${status} - ${reason}`, "err");
      broadcastTaskUpdate(task);
    })
    .catch(() => {
      task.status = "err";
      task.skipReason = reason;
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
    if (task && task.status === "running") {
      task.status = "skip";
      broadcastTaskUpdate(task);
    }
    state.activeTabs.delete(tabId);
  }
});

function countProcessingTabs() {
  // Count every open task tab until it is closed — includes paused/manual-wait and post-success close delay.
  return state.activeTabs.size;
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

// ExternalLink Side Panel — persistent UI for detect & fill
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const P = self.ExtLinkProfiles;
  const Q = self.ExtLinkQueue;

  let activeTabId = null;
  let siteProfiles = {};
  let activeSiteId = "";
  let detection = null;
  let tasks = [];
  let running = false;
  let stats = { done: 0, skip: 0, err: 0, total: 0 };
  const logLines = [];
  let submissionTasks = [];
  let submissionIndex = 0;
  let submissionMeta = { fromTable: 0, fromPlugin: 0, excluded: 0, total: 0 };
  let currentPageUrl = "";
  let selectedSiteIds = [];
  let parkedTasks = [];

  const SITE_STATUS_MAP = {
    can_submit: { label: "✅ 可提交外链", cls: "ok" },
    needs_login: { label: "🔐 需登录提交", cls: "warn" },
    needs_captcha: { label: "🤖 需验证码", cls: "warn" },
    paid: { label: "💳 付费提交", cls: "warn" },
    broken: { label: "❌ 无法提交", cls: "err" },
    skip: { label: "⏭ 已跳过", cls: "warn" },
    deleted: { label: "🗑 已删除", cls: "err" },
  };

  // ─── Tabs ───
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = $("panel-" + tab.dataset.panel);
      panel?.classList.add("active");
    });
  });

  $("btnOpenSettings")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // ─── Storage ───
  function loadAll(cb) {
    chrome.storage.local.get(
      [
        "siteProfiles",
        "activeSiteId",
        "cfgEmail",
        "cfgName",
        "cfgCommentTemplate",
        "cfgFillOnly",
        "activeBatchRun",
        "selectedSiteIds",
        "urlList",
      ],
      (items) => {
        siteProfiles = items.siteProfiles || {};
        activeSiteId = items.activeSiteId || Object.keys(siteProfiles)[0] || "";
        selectedSiteIds = (items.selectedSiteIds || []).filter((id) => siteProfiles[id]);
        if (!selectedSiteIds.length && activeSiteId) selectedSiteIds = [activeSiteId];
        const activeRun = items.activeBatchRun;
        if (
          activeRun?.tasks?.length &&
          ["running", "waiting_manual", "paused"].includes(activeRun.status)
        ) {
          tasks = activeRun.tasks;
          renderTasks();
        }
        if (activeRun?.status === "running") {
          setRunning(true, false);
          syncTasksFromBackground();
        }
        renderSiteSelect();
        renderBatchSiteChoices();
        updateProfileStatus();
        cb?.(items);
      },
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.siteProfiles || changes.activeSiteId) {
      chrome.storage.local.get(["siteProfiles", "activeSiteId"], (items) => {
        siteProfiles = items.siteProfiles || {};
        activeSiteId = items.activeSiteId || Object.keys(siteProfiles)[0] || "";
        selectedSiteIds = selectedSiteIds.filter((id) => siteProfiles[id]);
        if (!selectedSiteIds.length && activeSiteId) selectedSiteIds = [activeSiteId];
        renderSiteSelect();
        renderBatchSiteChoices();
        updateProfileStatus();
      });
    }
    if (changes.deletedSubmissionKeys || changes.siteAnnotations || changes.urlList) {
      loadSubmissionQueue(currentPageUrl);
      loadClassifiedList();
    }
  });

  function renderSiteSelect() {
    const sel = $("spSiteSelect");
    if (!sel) return;
    const ids = Object.keys(siteProfiles);
    sel.replaceChildren();
    if (!ids.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "未配置 — 请打开设置";
      sel.append(option);
      return;
    }
    for (const id of ids) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = siteProfiles[id]?.name || id;
      option.selected = id === activeSiteId;
      sel.append(option);
    }
    if (activeSiteId) sel.value = activeSiteId;
  }

  function renderBatchSiteChoices() {
    const el = $("batchSiteChoices");
    if (!el) return;
    el.replaceChildren();
    const ids = Object.keys(siteProfiles);
    if (!ids.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "还没有自家网站资料。请先打开设置页添加。";
      el.append(empty);
      updateBatchPreview();
      return;
    }
    for (const id of ids) {
      const label = document.createElement("label");
      label.className = "batch-site-choice";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = id;
      input.checked = selectedSiteIds.includes(id);
      input.addEventListener("change", () => {
        selectedSiteIds = [...el.querySelectorAll("input:checked")].map((node) => node.value);
        chrome.storage.local.set({ selectedSiteIds });
        updateBatchPreview();
      });
      const text = document.createElement("span");
      text.textContent = siteProfiles[id]?.name || id;
      label.append(input, text);
      el.append(label);
    }
    updateBatchPreview();
  }

  async function updateBatchPreview() {
    const summary = $("batchSelectionSummary");
    if (!summary) return;
    if (!selectedSiteIds.length) {
      summary.textContent = "请至少选择一个自家网站";
      return;
    }
    summary.textContent = "正在计算待提交组合…";
    try {
      const result = await chrome.runtime.sendMessage({
        action: "getSubmissionQueue",
        selectedSiteIds,
      });
      const destinationTotal = result?.meta?.destinationTotal || 0;
      const total = result?.meta?.total || 0;
      const skipped = result?.meta?.successfulSkipped || 0;
      summary.textContent = `${destinationTotal} 个外链站 · ${total} 个待提交组合 · 历史成功跳过 ${skipped} 个`;
    } catch (err) {
      summary.textContent = `无法计算：${err.message}`;
    }
  }

  $("spSiteSelect")?.addEventListener("change", () => {
    activeSiteId = $("spSiteSelect").value;
    chrome.storage.local.set({ activeSiteId });
    updateProfileStatus();
    loadCommentTemplate();
  });

  async function loadSubmissionQueue(syncUrl) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const url = syncUrl || tab?.url || "";
      const result = await chrome.runtime.sendMessage({
        action: "getSubmissionQueue",
        url: url.startsWith("http") ? url : undefined,
      });
      submissionTasks = result?.tasks || [];
      submissionIndex = result?.index ?? 0;
      submissionMeta = result?.meta || submissionMeta;
      renderSubmissionNav();
    } catch {
      submissionTasks = [];
      renderSubmissionNav();
    }
  }

  function renderSubmissionNav() {
    const el = $("submissionNavInfo");
    const metaEl = $("submissionNavMeta");
    if (metaEl) {
      const {
        fromTable = 0,
        fromPlugin = 0,
        excluded = 0,
        total = submissionTasks.length,
      } = submissionMeta;
      metaEl.textContent =
        total > 0
          ? `（表${fromTable}+库${fromPlugin}${excluded ? `−${excluded}` : ""}=${total}）`
          : "";
    }
    if (!el) return;
    if (!submissionTasks.length) {
      el.textContent = "无待提交站点";
      return;
    }
    const task = submissionTasks[submissionIndex];
    if (!task) {
      el.textContent = `${submissionIndex + 1} / ${submissionTasks.length}`;
      return;
    }
    const src = task.source === "table" ? "表" : task.source === "library" ? "库" : "";
    el.textContent = `${submissionIndex + 1} / ${submissionTasks.length} · ${task.domain || task.url}${src ? ` · ${src}` : ""}`;
    el.title = task.url || "";
  }

  async function cycleSubmission(delta, options = {}) {
    if (!submissionTasks.length) await loadSubmissionQueue();
    if (!submissionTasks.length) {
      showToast("没有待提交站点，请更新 Table.xlsx 或外链库", true);
      return;
    }
    submissionIndex = (submissionIndex + delta + submissionTasks.length) % submissionTasks.length;
    await chrome.storage.local.set({ submissionQueueIndex: submissionIndex });
    renderSubmissionNav();
    const task = submissionTasks[submissionIndex];
    const url = task.url.startsWith("http") ? task.url : "https://" + task.url;
    const keepCurrent = options.keepCurrent === true;
    if (keepCurrent) {
      // Gate/dead-end: leave the current tab for login/captcha review; open next in a new tab.
      setAutoFillStatus(`保留当前页，打开下一站 ${task.domain || task.url}…`);
      await chrome.tabs.create({ url, active: true });
      return;
    }
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id) {
      activeTabId = tab.id;
      setAutoFillStatus(`正在打开 ${task.domain || task.url}…`);
      await chrome.tabs.update(tab.id, { url });
    }
  }

  $("btnPrevSite")?.addEventListener("click", () => cycleSubmission(-1));
  $("btnNextSite")?.addEventListener("click", () => cycleSubmission(1));

  function setAutoFillStatus(text, cls) {
    const el = $("autoFillStatus");
    if (!el) return;
    if (!text) {
      el.setAttribute("hidden", "");
      return;
    }
    el.textContent = text;
    el.className = "auto-fill-status" + (cls ? " " + cls : "");
    el.removeAttribute("hidden");
  }

  async function triggerAutoFillForCurrentTab() {
    if (!activeTabId) return;
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (!P.profileConfigured(profile)) return;
    setAutoFillStatus("正在填写…");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "sidepanelFill",
        tabId: activeTabId,
        mode: "form",
        useAgent: true,
      });
      handleFillResult(result, "form");
    } catch (err) {
      setAutoFillStatus(err.message, "err");
    }
  }

  async function handleFillResult(result, mode) {
    if (result?.needs_manual || result?.captcha || result?.blocked || result?.advance) {
      const label =
        SITE_STATUS_MAP[result.classified]?.label ||
        result.reason ||
        (result.captcha ? "请手动完成验证码" : "需要人工处理");
      setAutoFillStatus(label, result.deadEnd ? "err" : "warn");
      await loadClassifiedList();
      await loadSubmissionQueue(currentPageUrl);
      if (result.advance !== false) {
        showToast(`${label} — 保留页签，打开下一站`);
        cycleSubmission(1, { keepCurrent: true }).catch(() => {});
      }
      return;
    }
    if (result?.error) {
      setAutoFillStatus(result.error, "err");
      return;
    }
    if (result?.skippedFiles?.length) {
      setAutoFillStatus(`已填写；图片需手动上传: ${result.skippedFiles.join(", ")}`, "warn");
      return;
    }
    if (result?.inferredFields?.length && result.emptyCount === 0) {
      setAutoFillStatus(
        `已填完；${result.inferredFields.join(", ")} 使用今天日期，请提交前核对`,
        "warn",
      );
      return;
    }
    if (result?.ok || result?.fillOnly) {
      let msg;
      if (mode === "comment") {
        msg = "评论内容已填入";
      } else if (result.invalidCount > 0) {
        msg = `${result.invalidCount} 个字段超出字数限制，请修正`;
      } else if (result.emptyCount > 0) {
        msg = `还有 ${result.emptyCount} 个字段未填写`;
      } else if (result.submitReady === false && result.validationIssues?.length) {
        msg = `已填写，校验待修正: ${result.validationIssues.slice(0, 2).join("；")}`;
      } else if (result.emptyCount === 0 && result.submitReady !== false) {
        msg = `当前表单 ${result.totalCount || result.filledCount || "全部"} 个字段已填写，可提交`;
      } else if (result.emptyCount === 0) {
        msg = `已填完 ${result.totalCount || result.filledCount || "全部"} 个字段，请检查字数`;
      } else {
        msg = `已填写 ${result.filledCount || 0} 个，还剩 ${result.emptyCount} 个空字段`;
      }
      const cls =
        result.submitReady !== false && !result.invalidCount && result.emptyCount === 0
          ? "ok"
          : "warn";
      setAutoFillStatus(msg, cls);
    }
  }

  async function refreshSiteAnnotation(url) {
    const pageUrl = url || currentPageUrl;
    if (!pageUrl?.startsWith("http")) {
      $("siteStatusBadge")?.setAttribute("hidden", "");
      $("btnAddToUrlList")?.setAttribute("hidden", "");
      document.querySelectorAll(".mark-btn").forEach((b) => b.classList.remove("active"));
      return;
    }

    try {
      const info = await chrome.runtime.sendMessage({ action: "getSiteAnnotation", url: pageUrl });
      const badge = $("siteStatusBadge");
      const addBtn = $("btnAddToUrlList");

      document.querySelectorAll(".mark-btn").forEach((b) => b.classList.remove("active"));

      if (info?.annotation?.status) {
        const meta = SITE_STATUS_MAP[info.annotation.status] || {
          label: info.annotation.status,
          cls: "",
        };
        if (badge) {
          badge.textContent = meta.label;
          badge.className = "site-status-badge " + (meta.cls || "");
          badge.removeAttribute("hidden");
        }
        const activeBtn = document.querySelector(
          `.mark-btn[data-status="${info.annotation.status}"]`,
        );
        activeBtn?.classList.add("active");
      } else if (badge) {
        badge.textContent = info?.inQueue ? "📋 在外链队列中" : "未标记";
        badge.className = "site-status-badge";
        badge.removeAttribute("hidden");
      }

      if (addBtn) {
        const showAdd = !info?.inQueue && !info?.deleted;
        if (showAdd) addBtn.removeAttribute("hidden");
        else addBtn.setAttribute("hidden", "");
      }
    } catch {
      /* ignore */
    }
  }

  async function markCurrentSite(status) {
    if (!currentPageUrl?.startsWith("http")) {
      showToast("当前页不是有效网址", true);
      return;
    }
    if (status === "deleted") {
      if (!confirm("确认从外链列表删除此站点？删除后不会再自动填表。")) return;
    }
    try {
      const result = await chrome.runtime.sendMessage({
        action: "markSubmissionSite",
        url: currentPageUrl,
        status,
      });
      if (!result?.ok) throw new Error(result?.error || "标记失败");
      await refreshSiteAnnotation(currentPageUrl);
      await loadSubmissionQueue(currentPageUrl);
      await loadClassifiedList();
      showToast(SITE_STATUS_MAP[status]?.label || "已标记");
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function addCurrentToUrlList() {
    if (!currentPageUrl?.startsWith("http")) return;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "addToUrlList",
        url: currentPageUrl,
        platformType: detection?.platform || "directory",
      });
      if (!result?.ok) throw new Error(result?.error || "添加失败");
      await refreshSiteAnnotation(currentPageUrl);
      await loadSubmissionQueue(currentPageUrl);
      showToast(result.added ? "已加入外链列表（置顶）" : "此外链已在列表中");
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function loadClassifiedList() {
    // 全量分类已经移到 Settings 的外链库；执行页只刷新当前站注解。
  }

  function setStatusItem(id, text, cls) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    el.className = cls || "";
    const dot = el.closest("li")?.querySelector(".dot");
    if (dot) {
      dot.classList.remove("ok", "warn", "pending");
      if (cls === "ok") dot.classList.add("ok");
      else if (cls === "warn") dot.classList.add("warn");
    }
  }

  function updateProfileStatus() {
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (P.profileConfigured(profile)) {
      setStatusItem("stProfile", "已配置", "ok");
    } else {
      setStatusItem("stProfile", "未配置 — 打开设置", "warn");
    }
  }

  function loadCommentTemplate() {
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (!profile) return;
    chrome.storage.local.get(["cfgCommentTemplate"], (items) => {
      const cfg = P.buildAgentConfigFromProfile(profile, {
        commentTemplate: items.cfgCommentTemplate,
      });
      if ($("spCommentText") && !$("spCommentText").value.trim()) {
        $("spCommentText").value = cfg.commentTemplate || "";
      }
    });
  }

  // ─── Active tab tracking ───
  async function refreshActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    activeTabId = tab?.id || null;
    currentPageUrl = tab?.url?.startsWith("http") ? tab.url : "";
    if (tab?.url?.startsWith("http")) {
      try {
        const u = new URL(tab.url);
        $("spHostname") && ($("spHostname").textContent = u.hostname);
        $("spPageUrl") && ($("spPageUrl").textContent = tab.url);
      } catch {
        $("spHostname") && ($("spHostname").textContent = tab.url);
        $("spPageUrl") && ($("spPageUrl").textContent = "");
      }
      await refreshSiteAnnotation(tab.url);
    } else {
      $("spHostname") && ($("spHostname").textContent = "—");
      $("spPageUrl") && ($("spPageUrl").textContent = "请在普通网页上使用");
      await refreshSiteAnnotation("");
    }
  }

  chrome.tabs.onActivated.addListener(async () => {
    await refreshActiveTab();
    if (!currentPageUrl?.startsWith("http")) return;
    await loadSubmissionQueue(currentPageUrl);
    detectCurrentPage().catch(() => {});
    requestAutoFillForTab(activeTabId, currentPageUrl);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === activeTabId && info.url) refreshActiveTab();
    if (info.status === "complete" && tabId === activeTabId) {
      detection = null;
      setStatusPending();
      if (info.url?.startsWith("http")) {
        loadSubmissionQueue(info.url);
        refreshSiteAnnotation(info.url);
        detectCurrentPage().catch(() => {});
        requestAutoFillForTab(activeTabId, info.url);
      }
    }
  });

  function setStatusPending() {
    ["stPage", "stComment", "stForm"].forEach((id) => {
      const el = $(id);
      if (el) {
        el.textContent = "未检测";
        el.className = "";
      }
    });
    $("detectResult")?.setAttribute("hidden", "");
  }

  function showToast(msg, isErr) {
    const t = $("spToast");
    if (!t) return;
    t.textContent = msg;
    t.style.background = isErr ? "#dc2626" : "#0f172a";
    t.removeAttribute("hidden");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => t.setAttribute("hidden", ""), 3500);
  }

  // ─── Detect ───
  async function detectCurrentPage() {
    await refreshActiveTab();
    if (!activeTabId) {
      showToast("没有活动标签页，请先打开目标网页", true);
      return;
    }
    const btn = $("btnDetect");
    if (btn) {
      btn.disabled = true;
      btn.textContent = "检测中…";
    }
    try {
      const result = await chrome.runtime.sendMessage({
        action: "sidepanelDetect",
        tabId: activeTabId,
      });
      if (!result?.ok) throw new Error(result?.error || "检测失败");
      if (result.tabId) activeTabId = result.tabId;
      detection = result;
      renderDetection(result);
      await refreshSiteAnnotation(currentPageUrl);
      showToast("检测完成");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "✨ 检测当前页";
      }
    }
  }

  function renderDetection(d) {
    setStatusItem("stPage", d.operable ? "可操作" : "无表单", d.operable ? "ok" : "warn");
    setStatusItem("stComment", d.commentFound ? "找到了" : "未找到", d.commentFound ? "ok" : "");
    setStatusItem(
      "stForm",
      d.formFieldCount > 0 ? `${d.formFieldCount} 个字段${d.inModal ? "（弹窗）" : ""}` : "未找到",
      d.formFieldCount > 0 ? "ok" : "",
    );

    $("detectResult")?.removeAttribute("hidden");
    const summary = $("detectSummary");
    if (summary) {
      summary.textContent = d.operable
        ? `检测到 ${d.platform || "表单"}${d.inModal ? " 弹窗" : ""}，当前区域 ${d.formFieldCount} 个可填字段。`
        : "当前区域未发现可填字段，请打开提交弹窗或导航到提交页。";
    }

    const preview = $("fieldPreview");
    if (preview) {
      preview.replaceChildren();
      for (const field of (d.fields || []).slice(0, 8)) {
        const item = document.createElement("li");
        item.textContent = field.label || field.name || field.type || "字段";
        preview.append(item);
      }
    }
  }

  $("btnDetect")?.addEventListener("click", detectCurrentPage);
  $("btnDetect2")?.addEventListener("click", detectCurrentPage);

  // ─── Fill ───
  async function fillPage(mode) {
    if (!activeTabId) {
      showToast("没有活动标签页", true);
      return;
    }
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (!P.profileConfigured(profile)) {
      showToast("请先在设置页配置网站资料", true);
      chrome.runtime.openOptionsPage();
      return;
    }

    const btn = mode === "comment" ? $("btnFillComment") : $("btnFillForm");
    if (!btn) return;
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "填写中…";
    setAutoFillStatus("正在填写…");

    try {
      const commentOverride = ($("spCommentText")?.value || "").trim();
      const result = await chrome.runtime.sendMessage({
        action: "sidepanelFill",
        tabId: activeTabId,
        mode,
        commentText: commentOverride,
        useAgent: true,
      });

      handleFillResult(result, mode);
    } catch (err) {
      setAutoFillStatus(err.message, "err");
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  $("btnFillForm")?.addEventListener("click", () => fillPage("form"));
  $("btnFillComment")?.addEventListener("click", () => fillPage("comment"));

  // ─── Batch (from popup) ───
  function log(msg, cls) {
    const time = new Date().toLocaleTimeString();
    logLines.push({ time, msg, cls });
    if (logLines.length > 80) logLines.shift();
    const el = $("log");
    if (el) {
      el.replaceChildren();
      for (const line of logLines) {
        const row = document.createElement("div");
        row.className = line.cls || "";
        row.textContent = `[${line.time}] ${line.msg}`;
        el.append(row);
      }
      el.scrollTop = el.scrollHeight;
    }
  }

  function updateStats() {
    const remaining = Math.max(0, stats.total - stats.done - stats.skip - stats.err);
    $("statQueue") && ($("statQueue").textContent = remaining);
    $("statDone") && ($("statDone").textContent = stats.done);
    $("statSkip") && ($("statSkip").textContent = stats.skip);
    $("statErr") && ($("statErr").textContent = stats.err);
    const pct = stats.total ? ((stats.done + stats.skip + stats.err) / stats.total) * 100 : 0;
    if ($("progressFill")) $("progressFill").style.width = pct + "%";
    chrome.storage.local.set({ stats });
  }

  function statusLabel(s) {
    const map = {
      pending: "⏳等",
      running: "▶中",
      ok: "✅证",
      skip: "⏭跳",
      err: "❌错",
      captcha: "🤖人工",
      needs_manual: "🤖人工",
      filled: "✏️已填",
    };
    return map[s] || s;
  }

  function renderTasks() {
    const el = $("taskList");
    if (!el) return;
    el.replaceChildren();
    for (const task of tasks) {
      const row = document.createElement("div");
      row.className = task.status === "running" ? "task current" : "task";
      const index = document.createElement("span");
      index.textContent = `#${task.index}`;
      const label = document.createElement("span");
      label.className = "task-label";
      label.textContent = `${task.domain || task.url} · ${task.profileName || task.profileId || "未命名项目"}`;
      const status = document.createElement("span");
      status.textContent = statusLabel(task.status);
      row.append(index, label, status);
      el.append(row);
    }
    const waiting = tasks.some((t) => t.status === "captcha" || t.status === "needs_manual");
    if ($("btnContinue")) $("btnContinue").hidden = !waiting;
    renderRunContext();
  }

  function renderRunContext() {
    const current = tasks.find((task) => task.status === "running");
    const status = $("autoFillStatus");
    if (!current || !status) return;
    const finished = tasks.filter((task) => ["ok", "skip", "err"].includes(task.status)).length;
    setAutoFillStatus(
      `外链站 ${current.domain || current.url} · 正在提交 ${current.profileName || current.profileId} · 本站 ${current.groupJobIndex || 1}/${current.groupJobCount || 1} · 总进度 ${finished + 1}/${tasks.length}`,
    );
  }

  function setRunning(r, save = true) {
    running = r;
    if ($("btnStart")) $("btnStart").hidden = r;
    if ($("btnStop")) $("btnStop").hidden = !r;
    if (save) chrome.storage.local.set({ running: r });
  }

  function buildAgentConfigFromProfile(profile) {
    const fields = profile.fields || {};
    const name = fields.Name || profile.name || "";
    const url = profile.promoUrl || profile.url || fields.Url || "";
    const email = fields["Business mail"] || "";
    const title = fields.Title || name;
    const shortDesc =
      fields["Short description(20-30 words)"] || fields.Note || profile.valueProposition || "";
    const longDesc =
      fields["Long description (250-500 words)"] ||
      fields["Short Discription(100-150 words)"] ||
      shortDesc;
    const natural = profile.anchorRules?.naturalExpressions || [];
    return {
      projectKey: profile.id,
      targetDomain: url,
      brandName: name,
      anchorText: natural[0] || title || name,
      email,
      username: name,
      commentTemplate: longDesc || shortDesc,
      tags: fields["Tags Keywords/Hashtags"] || "",
      pricing: fields.Pricing || "",
      projectFields: fields,
    };
  }

  async function syncTasksFromBackground() {
    try {
      const state = await chrome.runtime.sendMessage({ action: "getState" });
      tasks = state?.tasks || [];
      parkedTasks = state?.parkedTasks || [];
      if (state.stats) stats = state.stats;
      updateStats();
      renderTasks();
      renderManualTasks();
    } catch {
      /* ignore */
    }
  }

  $("btnStart")?.addEventListener("click", async () => {
    if (running) return;
    if (!selectedSiteIds.length) {
      showToast("请至少勾选一个自家网站", true);
      return;
    }
    try {
      const result = await chrome.runtime.sendMessage({
        action: "start",
        selectedSiteIds,
        config: {
          autoSkipCaptcha: false,
          concurrency: 1,
          pingIndex: true,
          fillOnly: $("cfgFillOnly")?.checked || false,
        },
      });
      if (!result?.ok) throw new Error(result?.error || "启动失败");
      tasks = result.tasks || [];
      stats = { done: 0, skip: 0, err: 0, total: tasks.length };
      updateStats();
      renderTasks();
      setRunning(tasks.length > 0);
      log(
        tasks.length
          ? `开始处理 ${result.groups?.length || 0} 个外链站、${tasks.length} 个项目组合`
          : result.message || "没有待提交组合",
        tasks.length ? "ok" : "warn",
      );
      updateBatchPreview();
    } catch (err) {
      setRunning(false);
      showToast(err.message, true);
    }
  });

  $("btnStop")?.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ action: "stop" });
    setRunning(false);
    log("已停止", "warn");
  });

  $("btnContinue")?.addEventListener("click", async () => {
    const waiting = parkedTasks;
    if (!waiting.length) return;
    const task = waiting[waiting.length - 1];
    await chrome.runtime.sendMessage({
      action: "manualContinue",
      taskIndex: task.index,
      platformType: task.platformType,
    });
  });

  function renderManualTasks() {
    const el = $("manualTaskList");
    if (!el) return;
    el.replaceChildren();
    if (!parkedTasks.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "暂无待人工任务。你可以返回“批量”开始新一轮。";
      el.append(empty);
    }
    for (const task of parkedTasks) {
      const card = document.createElement("div");
      card.className = "manual-task";
      const title = document.createElement("strong");
      title.textContent = `${task.domain || task.url} · ${task.profileName || task.profileId}`;
      const reason = document.createElement("p");
      reason.textContent = task.parkedReason || task.skipReason || "需要人工处理";
      const actions = document.createElement("div");
      actions.className = "manual-actions";
      const resume = document.createElement("button");
      resume.type = "button";
      resume.className = "btn btn-ghost";
      resume.textContent = task.tabId ? "继续处理" : "页签已关闭";
      resume.disabled = !task.tabId;
      resume.addEventListener("click", async () => {
        if (task.tabId) await chrome.tabs.update(task.tabId, { active: true }).catch(() => {});
        await chrome.runtime.sendMessage({
          action: "manualContinue",
          taskIndex: task.index,
          platformType: task.platformType,
        });
        syncTasksFromBackground();
      });
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "btn btn-primary";
      confirm.textContent = "确认成功";
      confirm.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          action: "confirmSubmissionSuccess",
          taskIndex: task.index,
          evidence: "user confirmed from side panel",
        });
        syncTasksFromBackground();
      });
      actions.append(resume, confirm);
      card.append(title, reason, actions);
      el.append(card);
    }
    if ($("manualTabCount")) {
      $("manualTabCount").textContent = parkedTasks.length ? `(${parkedTasks.length})` : "";
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "autoFillUpdate") {
      if (msg.status === "classified") {
        const label = SITE_STATUS_MAP[msg.classifyStatus]?.label || msg.classifyStatus;
        setAutoFillStatus(
          `${label}${msg.reason ? ": " + msg.reason : ""}`,
          msg.deadEnd ? "err" : "warn",
        );
        loadClassifiedList();
        loadSubmissionQueue(currentPageUrl);
        return;
      }
      if (msg.tabId && activeTabId && msg.tabId !== activeTabId) return;
      if (msg.status === "queue") {
        submissionIndex = msg.index ?? submissionIndex;
        const el = $("submissionNavInfo");
        if (el && msg.total) {
          el.textContent = `${submissionIndex + 1} / ${msg.total} · ${msg.domain || ""}`;
          renderSubmissionNav();
        }
      }
      if (msg.status === "filling") setAutoFillStatus(msg.message || "正在自动填写…");
      else if (msg.status === "done") {
        const cls =
          msg.submitReady === false || msg.invalidCount > 0 || msg.emptyCount > 0 ? "warn" : "ok";
        setAutoFillStatus(msg.message || "填写完成", cls);
      } else if (
        msg.status === "manual" ||
        msg.status === "captcha" ||
        msg.status === "blocked" ||
        msg.advance
      ) {
        setAutoFillStatus(msg.message || "需要人工处理", msg.status === "blocked" ? "err" : "warn");
        loadClassifiedList();
        // Sidepanel fill path advances via handleFillResult; batch/auto opens next tab in background.
      } else if (msg.status === "error") {
        setAutoFillStatus(msg.message || "填写失败", "err");
      }
      return;
    }
    if (msg.action === "taskUpdate") {
      const t = tasks.find((x) => x.index === msg.index);
      if (t) {
        t.status = msg.status;
        renderTasks();
      }
      syncTasksFromBackground();
    }
    if (msg.action === "log") log(msg.msg, msg.cls);
    if (msg.action === "status") setRunning(msg.running);
    if (msg.action === "progress") {
      stats = msg.stats;
      updateStats();
    }
  });

  document.querySelectorAll(".mark-btn").forEach((btn) => {
    btn.addEventListener("click", () => markCurrentSite(btn.dataset.status));
  });
  $("btnAddToUrlList")?.addEventListener("click", addCurrentToUrlList);

  function notifySidepanelOpen() {
    chrome.runtime.sendMessage({ action: "sidepanelOpened" }).catch(() => {});
  }

  function notifySidepanelClosed() {
    chrome.runtime.sendMessage({ action: "sidepanelClosed" }).catch(() => {});
  }

  window.addEventListener("pagehide", notifySidepanelClosed);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") notifySidepanelClosed();
    else notifySidepanelOpen();
  });

  // ─── Init ───
  notifySidepanelOpen();
  loadAll(() => {
    refreshActiveTab().then(() => {
      loadSubmissionQueue();
      syncTasksFromBackground();
      if (currentPageUrl) {
        detectCurrentPage().catch(() => {});
        requestAutoFillForTab(activeTabId, currentPageUrl);
      }
    });
    loadCommentTemplate();
  });

  function requestAutoFillForTab(tabId, url) {
    if (!tabId || !url?.startsWith("http")) return;
    chrome.runtime
      .sendMessage({
        action: "requestAutoFill",
        fromSidepanel: true,
        tabId,
        url,
      })
      .catch(() => {});
  }
})();

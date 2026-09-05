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
  let pagePrescan = null;
  let workflowStep = "detect";
  let commentDrafts = [];
  let selectedCommentDraft = -1;
  let commentHistory = [];
  let commentFieldInfo = {
    maxLength: null,
    minLength: null,
    label: "",
    source: "unknown",
  };
  let localMediaLibrary = null;
  let mediaUploadState = {
    status: "idle",
    uploaded: [],
    skipped: [],
    fields: [],
  };
  let mediaLoadToken = 0;

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
      const previousActiveSiteId = activeSiteId;
      chrome.storage.local.get(["siteProfiles", "activeSiteId"], (items) => {
        siteProfiles = items.siteProfiles || {};
        activeSiteId = items.activeSiteId || Object.keys(siteProfiles)[0] || "";
        selectedSiteIds = selectedSiteIds.filter((id) => siteProfiles[id]);
        if (!selectedSiteIds.length && activeSiteId) selectedSiteIds = [activeSiteId];
        renderSiteSelect();
        renderBatchSiteChoices();
        updateProfileStatus();
        if (previousActiveSiteId !== activeSiteId) {
          resetCommentStudio({ clearHistory: true });
          resetMediaUploadState();
        }
        loadMediaPreflight().catch(() => {});
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
    resetCommentStudio({ clearHistory: true });
    resetMediaUploadState();
    updateProfileStatus();
    loadCommentTemplate();
    loadMediaPreflight().catch(() => {});
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

  function renderQueueQuality(task) {
    const wrap = $("queueQuality");
    const scoreEl = $("queueQualityScore");
    const tierEl = $("queueQualityTier");
    const statusEl = $("queueProjectStatus");
    if (!wrap || !scoreEl || !tierEl || !statusEl) return;
    if (!task) {
      wrap.setAttribute("hidden", "");
      return;
    }

    const quality = task.quality || {};
    const score = Number(quality.score);
    const hasScore = Number.isFinite(score) && score >= 0;
    scoreEl.textContent = hasScore ? `质量 ${score}/100` : "质量待检测";
    tierEl.textContent = quality.tier ? `· ${quality.tier}` : "· 未分级";
    const tierClass =
      quality.tier === "优先"
        ? "priority"
        : quality.tier === "可做"
          ? "workable"
          : quality.tier === "低质"
            ? "low"
            : quality.tier === "观察"
              ? "watch"
              : "";
    tierEl.className = "queue-quality-tier" + (tierClass ? ` ${tierClass}` : "");
    tierEl.title = (quality.reasons || []).join(" · ") || "当前队列质量评分";

    const statuses = Array.isArray(task.profiles) ? task.profiles : [];
    const statusText = {
      pending: "待提交",
      running: "进行中",
      ok: "已验证",
      success: "已成功",
      filled: "已填表",
      needs_manual: "待人工",
      captcha: "验证码",
      skip: "已跳过",
      err: "失败",
    };
    const profileSummary = statuses
      .map((profile) => {
        const name = profile.profileName || profile.profileId || "项目";
        return `${name}·${statusText[profile.status] || profile.status || "待提交"}`;
      })
      .join("  ");
    statusEl.textContent = profileSummary || `项目 ${task.profileTotal || task.profileIds?.length || 0} 个`;
    statusEl.title = profileSummary;
    wrap.removeAttribute("hidden");
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
      renderQueueQuality(null);
      return;
    }
    const task = submissionTasks[submissionIndex];
    if (!task) {
      el.textContent = `${submissionIndex + 1} / ${submissionTasks.length}`;
      renderQueueQuality(null);
      return;
    }
    const src = task.source === "table" ? "表" : task.source === "library" ? "库" : "";
    el.textContent = `${submissionIndex + 1} / ${submissionTasks.length} · ${task.domain || task.url}${src ? ` · ${src}` : ""}`;
    el.title = task.url || "";
    renderQueueQuality(task);
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
  $("btnLaunchNext")?.addEventListener("click", () => cycleSubmission(1));

  function setWorkflowStep(step) {
    workflowStep = step;
    const map = { detect: "stepDetect", fill: "stepFill", submit: "stepSubmit" };
    const order = ["detect", "fill", "submit"];
    const idx = order.indexOf(step);
    for (const [key, id] of Object.entries(map)) {
      const el = $(id);
      if (!el) continue;
      el.classList.remove("active", "done");
      const i = order.indexOf(key);
      if (i < idx) el.classList.add("done");
      else if (i === idx) el.classList.add("active");
    }
  }

  function formatCommentHistoryTime(timestamp) {
    try {
      return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "刚才";
    }
  }

  function copyCommentDraft(draft) {
    if (!draft || typeof draft !== "object") return null;
    return {
      text: String(draft.text || ""),
      angle: String(draft.angle || ""),
      anchorText: String(draft.anchorText || ""),
      placement: String(draft.placement || ""),
      chars: Number.isFinite(Number(draft.chars)) ? Number(draft.chars) : undefined,
    };
  }

  function makeCommentSnapshot(label) {
    const text = $("spCommentText")?.value || "";
    const drafts = commentDrafts.map(copyCommentDraft).filter(Boolean);
    if (!text.trim() && !drafts.length) return null;
    return {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: label || "上一版",
      at: Date.now(),
      tone: $("commentTone")?.value || "helpful",
      selected: selectedCommentDraft,
      text,
      drafts,
    };
  }

  function commentSnapshotKey(snapshot) {
    if (!snapshot) return "";
    return [
      snapshot.text || "",
      snapshot.tone || "",
      ...(snapshot.drafts || []).map((draft) => draft?.text || ""),
    ].join("\u0001");
  }

  function captureCommentState(label) {
    const snapshot = makeCommentSnapshot(label);
    if (!snapshot) return;
    if (commentSnapshotKey(commentHistory[0]) === commentSnapshotKey(snapshot)) return;
    commentHistory = [snapshot, ...commentHistory].slice(0, 8);
    renderCommentHistory();
  }

  function renderCommentDrafts() {
    const list = $("commentDraftList");
    if (!list) return;
    list.replaceChildren();
    if (!commentDrafts.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";
      empty.textContent = "点击「生成 3 条」获取候选评论";
      list.append(empty);
      return;
    }

    commentDrafts.forEach((draft, index) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className =
        "comment-draft-option" + (index === selectedCommentDraft ? " selected" : "");
      option.dataset.commentDraftIndex = String(index);
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", index === selectedCommentDraft ? "true" : "false");

      const label = document.createElement("span");
      label.className = "comment-draft-label";
      const labelText = document.createElement("span");
      labelText.textContent = `候选 ${index + 1}${draft.angle ? ` · ${draft.angle}` : ""}`;
      const meta = document.createElement("span");
      meta.className = "comment-draft-meta";
      meta.textContent = `${String(draft.text || "").length} 字`;
      label.append(labelText, meta);

      const preview = document.createElement("span");
      preview.className = "comment-draft-preview";
      preview.textContent = draft.text || "（空候选）";
      option.append(label, preview);
      list.append(option);
    });
  }

  function renderCommentHistory() {
    const list = $("commentHistory");
    const restore = $("btnRestoreComment");
    if (restore) restore.disabled = !commentHistory.length;
    if (!list) return;
    list.replaceChildren();
    if (!commentHistory.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";
      empty.textContent = "生成或编辑后，这里会保留上一版";
      list.append(empty);
      return;
    }

    commentHistory.forEach((snapshot, index) => {
      const row = document.createElement("div");
      row.className = "comment-history-item";
      const summary = document.createElement("span");
      summary.className = "comment-history-summary";
      const preview = String(snapshot.text || snapshot.drafts?.[snapshot.selected]?.text || "");
      summary.textContent = `${snapshot.label || "上一版"} · ${formatCommentHistoryTime(snapshot.at)} · ${preview || "候选集"}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "comment-history-restore";
      button.dataset.commentHistoryIndex = String(index);
      button.textContent = "恢复";
      button.title = `恢复 ${snapshot.label || "上一版"}`;
      row.append(summary, button);
      list.append(row);
    });
  }

  function selectCommentDraft(index, options = {}) {
    const draft = commentDrafts[index];
    const ta = $("spCommentText");
    if (!draft || !ta) return;
    if (options.capture !== false && selectedCommentDraft !== index && ta.value.trim()) {
      captureCommentState("切换候选前");
    }
    selectedCommentDraft = index;
    ta.value = String(draft.text || "");
    updateCommentCharCount();
    renderCommentDrafts();
    showToast(`已选择候选 ${index + 1}，可编辑后填入`);
  }

  function restoreCommentHistory(index = 0) {
    const snapshot = commentHistory[index];
    if (!snapshot) return;
    const current = makeCommentSnapshot("恢复前");
    if (current && commentSnapshotKey(current) !== commentSnapshotKey(snapshot)) {
      commentHistory = [current, ...commentHistory.filter((item) => item.id !== snapshot.id)].slice(0, 8);
    }
    commentDrafts = (snapshot.drafts || []).map(copyCommentDraft).filter(Boolean);
    selectedCommentDraft = Number.isInteger(snapshot.selected) ? snapshot.selected : -1;
    const ta = $("spCommentText");
    if (ta) {
      const selected = commentDrafts[selectedCommentDraft];
      ta.value = snapshot.text || selected?.text || "";
    }
    if ($("commentTone") && snapshot.tone) $("commentTone").value = snapshot.tone;
    updateCommentCharCount();
    renderCommentDrafts();
    renderCommentHistory();
    showToast("已恢复历史版本，可继续编辑");
  }

  function resetCommentFieldInfo() {
    commentFieldInfo = { maxLength: null, minLength: null, label: "", source: "unknown" };
    updateCommentCharCount();
  }

  function resetCommentStudio(options = {}) {
    commentDrafts = [];
    selectedCommentDraft = -1;
    if (options.clearHistory !== false) commentHistory = [];
    const ta = $("spCommentText");
    if (ta) ta.value = "";
    resetCommentFieldInfo();
    renderCommentDrafts();
    renderCommentHistory();
  }

  function updateCommentCharCount() {
    const ta = $("spCommentText");
    const counter = $("commentCharCount");
    const limit = $("commentCharLimit");
    const remaining = $("commentRemaining");
    const hint = $("commentLengthHint");
    if (!ta || !counter) return;
    const len = String(ta.value || "").length;
    const max = Number(commentFieldInfo.maxLength);
    const hasMax = Number.isFinite(max) && max > 0;
    const meta = counter.closest(".comment-meta");
    const over = hasMax && len > max;

    counter.textContent = `${len} 字`;
    if (limit) limit.textContent = hasMax ? `上限 ${max} 字` : "上限未检测";
    if (remaining) remaining.textContent = hasMax ? `剩余 ${Math.max(0, max - len)} 字` : "剩余 —";
    if (meta) meta.classList.toggle("over-limit", over);

    if (hint) {
      hint.className = "comment-length-hint";
      if (over) {
        hint.classList.add("err");
        hint.textContent = `已超出 ${len - max} 字，请编辑后再填入。`;
      } else if (hasMax && commentFieldInfo.minLength && len > 0 && len < commentFieldInfo.minLength) {
        hint.classList.add("warn");
        hint.textContent = `当前页面要求至少 ${commentFieldInfo.minLength} 字。`;
      } else if (hasMax) {
        hint.textContent = `${commentFieldInfo.label ? `${commentFieldInfo.label} · ` : ""}已读取当前页面评论字段限制。`;
      } else {
        hint.textContent = "未读取到评论字段 maxlength；可继续编辑，提交前请以页面提示为准。";
      }
    }
  }

  function chooseCommentField(snapshot) {
    const fields = Array.isArray(snapshot?.fields) ? snapshot.fields : [];
    const candidates = fields.filter((field) => {
      const hint = [field?.label, field?.name, field?.id, field?.placeholder, field?.aria]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const type = String(field?.type || field?.tag || "").toLowerCase();
      return type === "textarea" || /comment|reply|message|feedback|body|评论|回复/.test(hint);
    });
    candidates.sort((a, b) => {
      const score = (field) => {
        const hint = [field?.label, field?.name, field?.id, field?.placeholder, field?.aria]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return (/(comment|reply|评论|回复)/.test(hint) ? 100 : 0) +
          (String(field?.type || field?.tag || "").toLowerCase() === "textarea" ? 20 : 0) +
          (field?.required ? 5 : 0);
      };
      return score(b) - score(a);
    });
    return candidates[0] || null;
  }

  async function getActivePageSnapshot() {
    if (!activeTabId || !currentPageUrl?.startsWith("http")) return null;
    try {
      const snapshot = await chrome.tabs.sendMessage(activeTabId, { action: "getPageSnapshot" });
      return snapshot?.error ? null : snapshot;
    } catch {
      return null;
    }
  }

  async function refreshCommentFieldInfo() {
    const requestedTabId = activeTabId;
    const requestedUrl = currentPageUrl;
    const prescanMax = Number(pagePrescan?.commentMaxLength);
    if (Number.isFinite(prescanMax) && prescanMax > 0) {
      commentFieldInfo = {
        maxLength: prescanMax,
        minLength: null,
        label: String(pagePrescan?.commentFieldLabel || "").trim(),
        source: "page prescan",
      };
      updateCommentCharCount();
    }
    const snapshot = await getActivePageSnapshot();
    if (requestedTabId !== activeTabId || requestedUrl !== currentPageUrl) return snapshot;
    const field = chooseCommentField(snapshot);
    const constraints = field?.constraints || {};
    const maxLength = Number(constraints.maxLength);
    const minLength = Number(constraints.minLength);
    const effectiveMax =
      Number.isFinite(maxLength) && maxLength > 0
        ? maxLength
        : Number.isFinite(prescanMax) && prescanMax > 0
          ? prescanMax
          : null;
    if (!field && effectiveMax != null) return snapshot;
    commentFieldInfo = {
      maxLength: effectiveMax,
      minLength: Number.isFinite(minLength) && minLength > 0 ? minLength : null,
      label: String(field?.label || field?.name || pagePrescan?.commentFieldLabel || "").trim(),
      source: field ? "page snapshot" : "unknown",
    };
    updateCommentCharCount();
    return snapshot;
  }

  function handleCommentTextInput() {
    const ta = $("spCommentText");
    if (ta && commentDrafts[selectedCommentDraft]) {
      commentDrafts[selectedCommentDraft].text = ta.value;
      commentDrafts[selectedCommentDraft].chars = ta.value.length;
    }
    updateCommentCharCount();
  }

  function formatMediaBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return "大小未知";
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  function mediaKindLabel(kind) {
    return { logo: "Logo", screenshot: "截图", other: "其他" }[kind] || "图片";
  }

  function setMediaLibraryStatus(text, cls = "") {
    const status = $("mediaLibraryStatus");
    if (!status) return;
    status.textContent = text;
    status.className = "media-library-status" + (cls ? ` ${cls}` : "");
  }

  function renderMediaUploadResult() {
    const result = $("mediaUploadResult");
    if (!result) return;
    result.replaceChildren();
    result.className = "media-upload-result";

    const { uploaded = [], skipped = [], fields = [], status = "idle" } = mediaUploadState;
    if (status === "idle" && !uploaded.length && !skipped.length) {
      result.textContent = "填写表单后，这里会显示文件字段的实际上传结果。";
      return;
    }

    const title = document.createElement("div");
    title.className = "media-upload-result-title";
    if (uploaded.length && skipped.length) {
      title.textContent = `已上传 ${uploaded.length} 个，${skipped.length} 个需要处理`;
      result.classList.add("warn");
    } else if (uploaded.length) {
      title.textContent = `实际上传成功 ${uploaded.length} 个`;
      result.classList.add("ok");
    } else if (skipped.length) {
      title.textContent = "媒体上传未完成";
      result.classList.add("warn");
    } else if (fields.length) {
      title.textContent = "已检测到文件字段，尚未确认上传结果";
      result.classList.add("warn");
    } else {
      title.textContent = "当前页面没有可回显的文件字段";
      result.classList.add("err");
    }
    result.append(title);

    const rows = document.createElement("div");
    rows.className = "media-upload-result-list";
    for (const item of uploaded) {
      const row = document.createElement("div");
      row.className = "media-upload-result-row";
      const source = item.source ? ` · ${item.source}` : "";
      const label = item.label || "文件字段";
      const fileName = item.name && item.name !== label ? ` → ${item.name}` : "";
      row.textContent = `✅ ${label}${fileName}${source}`;
      rows.append(row);
    }
    for (const item of skipped) {
      const row = document.createElement("div");
      row.className = "media-upload-result-row";
      row.textContent = `⚠️ ${item.label || item.name || "文件字段"}${item.reason ? `：${item.reason}` : "：未能自动上传"}`;
      rows.append(row);
    }
    if (!uploaded.length && !skipped.length && fields.length) {
      for (const field of fields.slice(0, 5)) {
        const row = document.createElement("div");
        row.className = "media-upload-result-row";
        row.textContent = `⏳ ${field.label || field.name || "文件字段"}`;
        rows.append(row);
      }
    }
    result.append(rows);
  }

  function resetMediaUploadState() {
    mediaUploadState = { status: "idle", uploaded: [], skipped: [], fields: [] };
    renderMediaUploadResult();
  }

  function resolveLocalMediaProfile(profiles) {
    const entries = Array.isArray(profiles) ? profiles : [];
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    const candidates = [activeSiteId, profile?.id, profile?.name]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    return (
      candidates.map((value) => entries.find((entry) => String(entry?.profile || "") === value)).find(Boolean) ||
      candidates
        .map((value) => value.toLowerCase())
        .map((value) => entries.find((entry) => String(entry?.profile || "").toLowerCase() === value))
        .find(Boolean) ||
      null
    );
  }

  function createMediaFileRow(profileName, file) {
    const row = document.createElement("div");
    row.className = "media-file-item";
    row.dataset.mediaName = String(file?.name || "");

    const preview = document.createElement("div");
    preview.className = "media-file-placeholder";
    preview.textContent = file?.kind === "logo" ? "◉" : "▧";
    if (String(file?.mime || "").startsWith("image/")) {
      const image = document.createElement("img");
      image.className = "media-file-thumb";
      image.alt = `${file.name || "媒体"} 缩略图`;
      image.setAttribute("aria-hidden", "true");
      preview.replaceChildren(image);
    }

    const info = document.createElement("div");
    info.className = "media-file-info";
    const head = document.createElement("div");
    head.className = "media-file-head";
    const name = document.createElement("span");
    name.className = "media-file-name";
    name.textContent = file?.name || "未命名文件";
    name.title = file?.name || "";
    const availability = document.createElement("span");
    availability.className = "media-file-availability warn";
    availability.textContent = "读取中…";
    head.append(name, availability);

    const meta = document.createElement("div");
    meta.className = "media-file-meta";
    const kind = document.createElement("span");
    kind.className = "media-file-tag";
    kind.textContent = mediaKindLabel(file?.kind);
    const mime = document.createElement("span");
    mime.textContent = file?.mime || "类型未知";
    const size = document.createElement("span");
    size.textContent = formatMediaBytes(file?.bytes);
    meta.append(kind, mime, size);
    info.append(head, meta);
    row.append(preview, info);
    row.__mediaProfile = profileName;
    row.__mediaFile = file;
    return row;
  }

  async function enrichMediaFilePreview(row, token) {
    const profile = row?.__mediaProfile;
    const file = row?.__mediaFile;
    if (!profile || !file || token !== mediaLoadToken) return;
    const availability = row.querySelector(".media-file-availability");
    const image = row.querySelector(".media-file-thumb");
    try {
      const response = await chrome.runtime.sendMessage({
        action: "fetchLocalSubmissionMedia",
        profile,
        name: file.name,
      });
      if (!response?.ok || !response.dataUrl) throw new Error(response?.error || "无法读取");
      if (image) image.src = response.dataUrl;
      if (availability) {
        availability.className = "media-file-availability";
        availability.textContent = "可用";
      }
    } catch (err) {
      if (availability) {
        availability.className = "media-file-availability err";
        availability.textContent = "不可用";
        availability.title = err.message || "读取失败";
      }
    }
  }

  async function loadMediaPreflight() {
    const token = ++mediaLoadToken;
    const list = $("mediaPreflightList");
    if (list) {
      list.replaceChildren();
      const loading = document.createElement("div");
      loading.className = "empty-state compact-empty";
      loading.textContent = "正在读取本地媒体清单…";
      list.append(loading);
    }
    setMediaLibraryStatus("正在读取本地图库…");
    try {
      const response = await chrome.runtime.sendMessage({ action: "listLocalSubmissionMedia" });
      if (token !== mediaLoadToken) return;
      localMediaLibrary = response || null;
      if (!response?.ok) throw new Error(response?.error || "读取本地图库失败");
      if (!response.mediaRootExists) {
        setMediaLibraryStatus("本地图库目录不存在，请启动媒体代理或检查配置。", "warn");
        if (list) {
          list.replaceChildren();
          const empty = document.createElement("div");
          empty.className = "empty-state compact-empty";
          empty.textContent = "图库目录不可用";
          list.append(empty);
        }
        return;
      }

      const entry = resolveLocalMediaProfile(response.profiles);
      if (!entry || !entry.files?.length) {
        setMediaLibraryStatus(`${siteProfiles[activeSiteId]?.name || activeSiteId || "当前 Profile"} 暂无本地媒体`, "warn");
        if (list) {
          list.replaceChildren();
          const empty = document.createElement("div");
          empty.className = "empty-state compact-empty";
          empty.textContent = "当前 Profile 没有可用的 Logo 或截图";
          list.append(empty);
        }
        return;
      }

      setMediaLibraryStatus(`已找到 ${entry.files.length} 个媒体文件 · ${entry.profile}`, "ok");
      if (!list) return;
      list.replaceChildren();
      const rows = entry.files.map((file) => createMediaFileRow(entry.profile, file));
      rows.forEach((row) => list.append(row));
      await Promise.all(rows.map((row) => enrichMediaFilePreview(row, token)));
    } catch (err) {
      if (token !== mediaLoadToken) return;
      localMediaLibrary = null;
      setMediaLibraryStatus(err.message || "读取本地图库失败", "err");
      if (list) {
        list.replaceChildren();
        const empty = document.createElement("div");
        empty.className = "empty-state compact-empty";
        empty.textContent = "暂时无法读取媒体清单";
        list.append(empty);
      }
    }
  }

  async function refreshMediaUploadResult(fillResult = {}) {
    const eventUploaded = mediaUploadState.uploaded || [];
    const eventSkipped = mediaUploadState.skipped || [];
    let report = null;
    let snapshot = null;
    if (activeTabId) {
      try {
        report = await chrome.tabs.sendMessage(activeTabId, { action: "getFilledFieldsReport" });
      } catch {
        /* A page may navigate immediately after the upload. Runtime events still remain useful. */
      }
      if (!report) snapshot = await getActivePageSnapshot();
    }
    const uploadedFromReport = (report?.fields || [])
      .filter((field) => String(field?.type || "").toLowerCase() === "file" && field.value)
      .map((field) => ({
        label: field.label || field.name || "文件字段",
        name: String(field.value || ""),
        source: "页面已确认",
      }));
    const fileFields = (report?.fields || snapshot?.fields || [])
      .filter((field) => String(field?.type || field?.tag || "").toLowerCase() === "file")
      .map((field) => ({ label: field.label || field.name || "文件字段", name: field.name || "" }));
    const skippedFromResult = (fillResult.skippedFiles || []).map((item) =>
      typeof item === "string" ? { label: item } : item,
    );
    const mergeByKey = (items) => {
      const seen = new Set();
      return items.filter((item) => {
        const key = `${item.label || ""}|${item.name || ""}|${item.source || ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    const uploaded = mergeByKey([...eventUploaded, ...uploadedFromReport]);
    const skipped = mergeByKey([...eventSkipped, ...skippedFromResult]);
    mediaUploadState = {
      status: uploaded.length && !skipped.length ? "ok" : skipped.length ? "warn" : "idle",
      uploaded,
      skipped,
      fields: fileFields,
    };
    renderMediaUploadResult();
  }

  function handleMediaUploadStatus(message) {
    if (message?.pageUrl && currentPageUrl && message.pageUrl !== currentPageUrl) return;
    const item = {
      label: message?.fieldLabel || message?.label || message?.name || "文件字段",
      name: message?.name || "",
      source: { local: "本地图库", remote: "远程图片", embedded: "Profile 内置" }[message?.source] || message?.source || "页面",
      reason: message?.reason || "",
    };
    if (message?.status === "success") {
      const exists = (mediaUploadState.uploaded || []).some(
        (entry) => entry.label === item.label && entry.name === item.name && entry.source === item.source,
      );
      if (!exists) mediaUploadState.uploaded = [...(mediaUploadState.uploaded || []), item];
      mediaUploadState.status = "ok";
    } else if (message?.status === "failed") {
      const exists = (mediaUploadState.skipped || []).some(
        (entry) => entry.label === item.label && entry.name === item.name && entry.reason === item.reason,
      );
      if (!exists) mediaUploadState.skipped = [...(mediaUploadState.skipped || []), item];
      mediaUploadState.status = "warn";
    }
    renderMediaUploadResult();
  }

  $("btnRefreshMedia")?.addEventListener("click", () => loadMediaPreflight());

  $("spCommentText")?.addEventListener("input", handleCommentTextInput);
  $("commentDraftList")?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-comment-draft-index]");
    if (!target) return;
    selectCommentDraft(Number(target.dataset.commentDraftIndex));
  });
  $("commentHistory")?.addEventListener("click", (event) => {
    const target = event.target.closest("[data-comment-history-index]");
    if (!target) return;
    restoreCommentHistory(Number(target.dataset.commentHistoryIndex));
  });
  $("btnRestoreComment")?.addEventListener("click", () => restoreCommentHistory(0));

  function renderMetricChip(label, cls) {
    const chip = document.createElement("span");
    chip.className = "metric-chip" + (cls ? " " + cls : "");
    chip.textContent = label;
    return chip;
  }

  function renderPageMetrics(prescan, metrics) {
    const row = $("pageMetrics");
    if (!row) return;
    row.replaceChildren();

    if (prescan?.dofollowLikely === true) {
      row.append(renderMetricChip("Dofollow 倾向", "good"));
    } else if (prescan?.dofollowLikely === false) {
      row.append(renderMetricChip("Nofollow 倾向", "bad"));
    } else if (prescan) {
      row.append(renderMetricChip("链接属性未知", "neutral"));
    }

    if (prescan?.hasCommentForm) row.append(renderMetricChip("有评论表单", "good"));
    if (detection?.standardWpComment) row.append(renderMetricChip("标准 WP 评论", "good"));
    const playbook = detection?.playbook || lookupPlaybookForUrl(currentPageUrl);
    if (playbook?.title) row.append(renderMetricChip(`熟站 ${playbook.title}`, "good"));
    if (prescan?.hasCaptcha) row.append(renderMetricChip("含验证码", "bad"));
    if (prescan?.indexable === true) row.append(renderMetricChip("可索引", "good"));
    if (prescan?.indexable === false) row.append(renderMetricChip("Noindex", "bad"));
    if (prescan?.formFieldCount > 0) {
      row.append(renderMetricChip(`${prescan.formFieldCount} 个字段`, "good"));
    }
    if (prescan?.commentExternalLinks >= 3) {
      const ratio = prescan.commentNofollow / prescan.commentExternalLinks;
      row.append(
        renderMetricChip(
          `评论外链 ${prescan.commentExternalLinks}（nofollow ${Math.round(ratio * 100)}%）`,
          ratio < 0.5 ? "good" : "bad",
        ),
      );
    }

    const host = prescan?.hostname?.replace(/^www\./, "") || "";
    const domainMetric = host && metrics?.[host];
    if (domainMetric?.ageMonths != null) {
      const cls = domainMetric.ageMonths >= 12 ? "good" : domainMetric.ageMonths >= 6 ? "neutral" : "bad";
      row.append(renderMetricChip(`域名 ${domainMetric.ageMonths} 月`, cls));
    } else if (domainMetric?.status === "unknown") {
      row.append(renderMetricChip("域名年龄未知", "neutral"));
    }

    if (!row.childElementCount) {
      row.append(renderMetricChip("点击「检测」获取页面信号", ""));
    }
    renderPlaybookNote(playbook);
  }

  function lookupPlaybookForUrl(url) {
    if (self.ExtLinkPlaybooks && typeof self.ExtLinkPlaybooks.lookup === "function") {
      const playbook = self.ExtLinkPlaybooks.lookup(url);
      return playbook
        ? { id: playbook.id, title: playbook.title, notes: playbook.notes, hints: playbook.hints || [] }
        : null;
    }
    return null;
  }

  function renderPlaybookNote(playbook) {
    const el = $("playbookNote");
    if (!el) return;
    if (!playbook?.notes) {
      el.textContent = "";
      el.setAttribute("hidden", "");
      return;
    }
    const hints = Array.isArray(playbook.hints) && playbook.hints.length ? ` ${playbook.hints.join("；")}` : "";
    el.textContent = `熟站 ${playbook.title}：${playbook.notes}${hints}`;
    el.removeAttribute("hidden");
  }

  function renderPageTdk(prescan) {
    const wrap = $("pageTdk");
    const titleEl = $("pageTitle");
    const descEl = $("pageDescription");
    const keywordsEl = $("pageKeywords");
    if (!wrap || !titleEl || !descEl || !keywordsEl) return;
    const title = prescan?.title || prescan?.h1 || "";
    const desc = prescan?.description || "";
    const keywords = prescan?.keywords || "";
    if (!title && !desc && !keywords) {
      wrap.setAttribute("hidden", "");
      return;
    }
    titleEl.textContent = title || "—";
    descEl.textContent = desc || "无 meta description";
    keywordsEl.textContent = keywords ? `关键词：${keywords}` : "";
    wrap.removeAttribute("hidden");
  }

  async function fetchDomainMetricsForHost(hostname) {
    const host = String(hostname || "")
      .replace(/^www\./, "")
      .trim();
    if (!host) return {};
    try {
      const result = await chrome.runtime.sendMessage({
        action: "getDomainMetrics",
        domains: [host],
      });
      return result?.results || {};
    } catch {
      return {};
    }
  }

  function getCommentGenerationMaxChars() {
    const max = Number(commentFieldInfo.maxLength);
    return Number.isFinite(max) && max > 0 ? Math.max(40, Math.min(max, 2000)) : 700;
  }

  async function generateCommentCandidates() {
    if (!activeTabId || !currentPageUrl?.startsWith("http")) {
      showToast("请先打开目标文章页", true);
      return;
    }
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (!P.profileConfigured(profile)) {
      showToast("请先在设置页配置网站资料", true);
      return;
    }
    const btn = $("btnRegenComment");
    const tone = $("commentTone")?.value || "helpful";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "生成中…";
    }
    try {
      const snapshot = await refreshCommentFieldInfo();
      const cfg = P.buildAgentConfigFromProfile(profile, {});
      cfg.blogRules = { ...(cfg.blogRules || {}), tone };

      const pageText = String(snapshot?.text || "").trim();
      let result;
      if (pageText.length >= 120) {
        result = await chrome.runtime.sendMessage({
          action: "generateCommentDrafts",
          pageUrl: currentPageUrl,
          pageTitle: [snapshot?.title, pagePrescan?.title, pagePrescan?.description]
            .filter(Boolean)
            .join(" — "),
          pageText,
          config: cfg,
          refresh: true,
          count: 3,
          maxChars: getCommentGenerationMaxChars(),
          allowLink: true,
        });
      } else {
        // The existing content-script preview is a graceful fallback when a page
        // blocks the snapshot request; it can still extract article text in-page.
        const fallback = await chrome.runtime.sendMessage({
          action: "generateCommentPreview",
          tabId: activeTabId,
          config: cfg,
          refresh: true,
          count: 1,
        });
        result = fallback?.ok && fallback.text
          ? { ok: true, drafts: [{ text: fallback.text, angle: "页面兜底" }] }
          : fallback;
      }

      const drafts = (result?.drafts || [])
        .map(copyCommentDraft)
        .filter((draft) => draft?.text?.trim())
        .slice(0, 3);
      if (!result?.ok || !drafts.length) {
        throw new Error(result?.error || "AI 评论生成失败，请确认文章正文足够长");
      }

      captureCommentState("重新生成前");
      commentDrafts = drafts;
      selectedCommentDraft = 0;
      if ($("spCommentText")) $("spCommentText").value = drafts[0].text;
      renderCommentDrafts();
      updateCommentCharCount();
      setWorkflowStep("fill");
      showToast(
        drafts.length === 3
          ? "已生成 3 条评论候选，选择并编辑后再填入"
          : `已生成 ${drafts.length} 条评论候选，选择并编辑后再填入`,
      );
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "生成 3 条";
      }
    }
  }

  function commentIsOverLimit() {
    const max = Number(commentFieldInfo.maxLength);
    return Number.isFinite(max) && max > 0 && String($("spCommentText")?.value || "").length > max;
  }

  $("btnRegenComment")?.addEventListener("click", generateCommentCandidates);
  $("btnFillComment")?.addEventListener("click", () => {
    const ta = $("spCommentText");
    if (ta && !ta.value.trim()) {
      showToast("请先生成或编辑评论，再点击填入评论", true);
      return;
    }
    if (commentIsOverLimit()) {
      showToast("评论超过当前页面字数上限，请先编辑", true);
      return;
    }
    fillPage("comment");
  });

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
    resetMediaUploadState();
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
    if (mode === "form") refreshMediaUploadResult(result).catch(() => {});
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
        msg = result.submitted
          ? result.publicationStatus === "pending_moderation"
            ? "评论已提交，站点显示待审核"
            : result.evidence
              ? "评论已代点提交"
              : "已代点提交，未见回执，请人工确认"
          : "评论内容已填入";
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
          badge.className = "status-pill " + (meta.cls || "");
          badge.removeAttribute("hidden");
        }
        const activeBtn = document.querySelector(
          `.mark-btn[data-status="${info.annotation.status}"]`,
        );
        activeBtn?.classList.add("active");
      } else if (badge) {
        badge.textContent = info?.inQueue ? "📋 在外链队列中" : "未标记";
        badge.className = "status-pill";
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
        updateCommentCharCount();
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
    renderPageMetrics(pagePrescan, {});
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
    pagePrescan = null;
    renderPageMetrics(null, {});
    $("pageTdk")?.setAttribute("hidden", "");
    resetCommentStudio({ clearHistory: true });
    resetMediaUploadState();
    setWorkflowStep("detect");
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
    setWorkflowStep("detect");
    try {
      let hostname = "";
      try {
        hostname = new URL(currentPageUrl).hostname;
      } catch {
        /* ignore */
      }

      const [detectResult, prescanResult, metrics] = await Promise.all([
        chrome.runtime.sendMessage({ action: "sidepanelDetect", tabId: activeTabId }),
        chrome.runtime.sendMessage({ action: "prescanPage", tabId: activeTabId }).catch(() => null),
        fetchDomainMetricsForHost(hostname),
      ]);

      if (!detectResult?.ok) throw new Error(detectResult?.error || "检测失败");
      if (detectResult.tabId) activeTabId = detectResult.tabId;

      if (prescanResult?.ok) {
        pagePrescan = prescanResult;
        renderPageTdk(prescanResult);
        setStatusItem(
          "stComment",
          prescanResult.hasCommentForm ? "找到了" : "未找到",
          prescanResult.hasCommentForm ? "ok" : "",
        );
      }

      detection = detectResult;
      renderDetection(detectResult);
      renderPageMetrics(pagePrescan, metrics);
      await refreshCommentFieldInfo();
      await refreshSiteAnnotation(currentPageUrl);
      setWorkflowStep(detectResult.operable ? "fill" : "detect");
      showToast("检测完成");
    } catch (err) {
      showToast(err.message, true);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = "检测";
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
        ? `检测到 ${d.platform || "表单"}${d.inModal ? " 弹窗" : ""}，当前区域 ${d.formFieldCount} 个可填字段。${
            d.standardWpComment ? " 标准 WordPress 评论表单。" : ""
          }${d.playbook?.title ? ` 熟站 ${d.playbook.title}。` : ""}`
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
    if (mode === "form") resetMediaUploadState();
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
      if (mode === "form" && (result?.ok || result?.fillOnly)) setWorkflowStep("submit");
      else if (mode === "comment" && (result?.ok || result?.fillOnly)) setWorkflowStep("submit");
    } catch (err) {
      setAutoFillStatus(err.message, "err");
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = origText;
    }
  }

  $("btnFillForm")?.addEventListener("click", () => fillPage("form"));

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
    if (msg.action === "mediaUploadStatus") {
      handleMediaUploadStatus(msg);
      return;
    }
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
      renderPageMetrics(pagePrescan, {});
      if (currentPageUrl) {
        detectCurrentPage().catch(() => {});
        requestAutoFillForTab(activeTabId, currentPageUrl);
      }
    });
    loadCommentTemplate();
    updateCommentCharCount();
    loadMediaPreflight().catch(() => {});
    setWorkflowStep("detect");
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

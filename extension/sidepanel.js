(function (global) {
  "use strict";

  // Keep the data shaping independent from the DOM so the side panel and its
  // focused tests use the same Profile-aware timeline contract.
  function parseTimelineTimestamp(value) {
    const raw = String(value || "").trim();
    // Legacy spreadsheet rows sometimes contain an Excel date serial. Date.parse
    // interprets e.g. 46261 as year 46261, so convert it before sorting.
    if (/^\d{5}$/.test(raw)) {
      const serial = Number(raw);
      if (serial >= 20000 && serial <= 60000) return Date.UTC(1899, 11, 30) + serial * 86400000;
    }
    return Date.parse(raw);
  }

  function buildTimelineModel(item = {}, siteProfiles = {}) {
    const profileNames = new Map();
    for (const profile of Array.isArray(item.profileStatuses) ? item.profileStatuses : []) {
      const id = String(profile?.profileId || "").trim();
      if (!id) continue;
      profileNames.set(id, String(profile.profileName || siteProfiles[id]?.name || id).trim() || id);
    }
    for (const [id, profile] of Object.entries(siteProfiles || {})) {
      if (!profileNames.has(id)) profileNames.set(id, String(profile?.name || id).trim() || id);
    }

    const events = [];
    const seenIds = new Set();
    const seenReceipts = new Set();
    const append = (raw, fallback = {}) => {
      if (!raw || typeof raw !== "object") return;
      const profileId = String(raw.profileId || raw.projectId || fallback.profileId || "__destination__").trim() || "__destination__";
      const profileName =
        String(raw.profileName || profileNames.get(profileId) || (profileId === "__destination__" ? "外链站" : profileId)).trim() || profileId;
      const occurredAt = String(raw.occurredAt || raw.submittedAt || raw.time || fallback.occurredAt || "").trim();
      const type = String(raw.publicationStatus || raw.type || raw.status || fallback.type || "note").trim() || "note";
      const id = String(raw.id || "").trim();
      if (id && seenIds.has(id)) return;
      if (id) seenIds.add(id);
      const receiptKey = JSON.stringify([profileId, type, occurredAt, String(raw.note || "").trim(), String(raw.evidenceUrl || "").trim(), String(raw.publicUrl || "").trim()]);
      if (seenReceipts.has(receiptKey)) return;
      seenReceipts.add(receiptKey);
      events.push({ ...raw, profileId, profileName, occurredAt, type, timestamp: parseTimelineTimestamp(occurredAt) });
    };

    for (const event of Array.isArray(item.events) ? item.events : []) append(event);
    // A profile status can carry the latest record even when the flattened
    // event list is unavailable during a background refresh.
    for (const profile of Array.isArray(item.profileStatuses) ? item.profileStatuses : []) {
      const latest = profile?.latestEvent;
      if (latest && typeof latest === "object") append(latest, { profileId: profile.profileId });
      else if (profile?.success || profile?.submittedAt || profile?.publicationStatus) {
        append(
          {
            profileId: profile.profileId,
            profileName: profile.profileName,
            type: profile.publicationStatus || (profile.success ? "submitted" : "note"),
            occurredAt: profile.submittedAt || "",
            note: profile.success ? "已记录成功提交" : "",
          },
          { profileId: profile.profileId },
        );
      }
    }

    events.sort((left, right) => {
      const leftTime = Number.isFinite(left.timestamp) ? left.timestamp : -Infinity;
      const rightTime = Number.isFinite(right.timestamp) ? right.timestamp : -Infinity;
      return rightTime - leftTime;
    });
    const latestWithTime = events.find((event) => Number.isFinite(event.timestamp));
    const fallbackTime = String(item.time || "").trim();
    return {
      events,
      profileCount: new Set(events.map((event) => event.profileId)).size,
      latestAt: latestWithTime?.occurredAt || fallbackTime,
    };
  }

  function canEditTimeline(item, pageUrl) {
    return /^https?:\/\//i.test(String(pageUrl || ""));
  }

  function normalizeBatchConcurrency(value) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
  }

  function clampBatchLimit(value, fallback, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(1, Math.min(max, parsed)) : fallback;
  }

  function buildBatchConfig(options = {}) {
    return {
      autoSkipCaptcha: false,
      concurrency: normalizeBatchConcurrency(options.concurrency),
      pingIndex: options.pingIndex !== false,
      fillOnly: options.fillOnly === true,
      unattended: options.unattended === true,
      unattendedMaxHours: clampBatchLimit(options.unattendedMaxHours, 8, 12),
      unattendedMaxTasks: clampBatchLimit(options.unattendedMaxTasks, 100, 500),
      unattendedMaxManualTabs: clampBatchLimit(options.unattendedMaxManualTabs, 20, 100),
    };
  }

  global.ExtLinkSidepanel = global.ExtLinkSidepanel || {};
  global.ExtLinkSidepanel.buildTimelineModel = buildTimelineModel;
  global.ExtLinkSidepanel.parseTimelineTimestamp = parseTimelineTimestamp;
  global.ExtLinkSidepanel.canEditTimeline = canEditTimeline;
  global.ExtLinkSidepanel.normalizeBatchConcurrency = normalizeBatchConcurrency;
  global.ExtLinkSidepanel.buildBatchConfig = buildBatchConfig;
})(typeof self !== "undefined" ? self : globalThis);

// ExternalLink Side Panel — persistent UI for detect & fill
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const P = self.ExtLinkProfiles;
  const Q = self.ExtLinkQueue;
  const Controls = self.ExtLinkBatchControls;
  const Sidepanel = self.ExtLinkSidepanel;
  const LibraryClassifier = self.ExtLinkLibraryClassifier;
  const LibraryGroups = self.ExtLinkLibraryGroups;

  let activeTabId = null;
  let siteProfiles = {};
  let activeSiteId = "";
  let detection = null;
  let tasks = [];
  let taskWindow = { start: 0, end: 0, total: 0, truncated: false };
  let running = false;
  let batchStatus = "idle";
  let stats = { done: 0, skip: 0, err: 0, total: 0 };
  const logLines = [];
  let batchLogStatus = "idle";
  let submissionTasks = [];
  let submissionIndex = 0;
  let submissionMeta = { fromTable: 0, fromPlugin: 0, excluded: 0, total: 0 };
  let submissionQueueLoadToken = 0;
  let currentTimelineItem = null;
  let currentPageUrl = "";
  let selectedSiteIds = [];
  let batchConcurrency = 1;
  let batchPingIndex = true;
  let batchPreviewToken = 0;
  let parkedTasks = [];
  let pagePrescan = null;
  let workflowStep = "detect";
  let commentDrafts = [];
  let selectedCommentDraft = -1;
  let commentAvailability = {
    available: false,
    reason: "先点击「检测」确认当前页面是否有真实博客评论表单。",
  };
  let commentHistory = [];
  let commentFieldInfo = {
    maxLength: null,
    minLength: null,
    label: "",
    source: "unknown",
  };
  let cloudMediaLibrary = null;
  let mediaUploadState = {
    status: "idle",
    uploaded: [],
    skipped: [],
    fields: [],
  };
  let mediaLoadToken = 0;
  let timelineLoadToken = 0;
  let timelineSaveInProgress = false;
  let timelineEditorUrl = "";
  let detectionRequestId = 0;
  let sidepanelFillRequestId = 0;
  const sidepanelFillRequests = new Map();
  // Only tabs opened by this panel's queue navigation may be closed automatically.
  // User-opened tabs, manual gates and tabs restored after the panel closes stay untouched.
  const ownedSubmissionTabs = new Map();
  const cloudReceiptCompletionTabs = new Set();
  let skipActivationFromVerifiedClose = false;
  // A side panel belongs to one browser window. The last focused window can
  // change while another Space is active, so pin every tab action to this one.
  const ownerWindowIdPromise = chrome.windows.getCurrent().then((win) => win.id);
  async function getOwnerActiveTab() {
    const windowId = await ownerWindowIdPromise;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    return tab;
  }
  const SIDEPANEL_FILL_TIMEOUT_MS = 30_000;
  const SIDEPANEL_FILL_STALE_MS = 90_000;
  let productHuntReadyToCreateTabId = null;
  let sidepanelLibraryItems = [];
  let sidepanelLibraryStats = {};
  let sidepanelLibraryLoaded = false;
  let sidepanelLibraryVisibleLimit = 60;
  const sidepanelQuickOpenSelection = new Map();
  let quickOpenBusy = false;

  const SITE_STATUS_MAP = {
    can_submit: { label: "✅ 可提交外链", cls: "ok" },
    needs_login: { label: "🔐 需登录提交", cls: "warn" },
    needs_captcha: { label: "🤖 需验证码", cls: "warn" },
    needs_manual: { label: "🧑‍💻 需人工处理", cls: "warn" },
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
      tab.setAttribute("aria-selected", "true");
      document.querySelectorAll(".tab").forEach((item) => {
        if (item !== tab) item.setAttribute("aria-selected", "false");
      });
      const panel = $("panel-" + tab.dataset.panel);
      panel?.classList.add("active");
      if (tab.dataset.panel === "library" && !sidepanelLibraryLoaded) {
        loadSidepanelLibrary().catch((error) => renderSidepanelLibraryError(error));
      }
    });
  });

  $("btnOpenSettings")?.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  $("btnOpenLibrarySettings")?.addEventListener("click", () => {
    chrome.storage.local.set({ settingsActivePanel: "library" }).finally(() => chrome.runtime.openOptionsPage());
  });

  function libraryAccessLabel(value) {
    return {
      free: "免费",
      freemium: "免费增值",
      paid: "付费",
      unknown: "待核验",
    }[value] || "待核验";
  }

  function formatLibraryMetric(value) {
    const count = Number(value);
    if (!Number.isFinite(count)) return "";
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
    if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`;
    return String(count);
  }

  function renderSidepanelLibraryError(error) {
    const list = $("sidepanelLibraryList");
    if (list) {
      list.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = `外链库加载失败：${error?.message || error || "未知错误"}`;
      list.append(empty);
    }
    if ($("sidepanelLibrarySummary")) $("sidepanelLibrarySummary").textContent = "加载失败，请稍后重试";
  }

  function populateSidepanelLibraryCategories(items) {
    const select = $("sidepanelLibraryCategory");
    if (!select || select.options.length > 1) return;
    const counts = new Map();
    for (const item of items) counts.set(item.category, (counts.get(item.category) || 0) + 1);
    for (const category of LibraryClassifier.CATEGORY_ORDER) {
      if (!counts.has(category)) continue;
      const option = document.createElement("option");
      option.value = category;
      option.textContent = `${category}（${counts.get(category)}）`;
      select.append(option);
    }
  }

  function populateSidepanelLibraryGroups(items) {
    const select = $("sidepanelLibraryGroup");
    if (!select) return;
    const selected = select.value;
    select.replaceChildren(new Option("全部分组", ""));
    for (const [groupId, label] of LibraryGroups.GROUPS) {
      const count = items.filter((item) => LibraryGroups.matches(item, groupId)).length;
      select.append(new Option(`${label}（${count}）`, groupId));
    }
    select.value = selected;
  }

  function sidepanelLibraryFilteredItems() {
    const query = String($("sidepanelLibrarySearch")?.value || "").trim().toLowerCase();
    const category = $("sidepanelLibraryCategory")?.value || "";
    const group = $("sidepanelLibraryGroup")?.value || "";
    const access = $("sidepanelLibraryAccess")?.value || "";
    const favorite = $("sidepanelLibraryFavorite")?.value || "";
    const enabled = $("sidepanelLibraryEnabled")?.value || "";
    return sidepanelLibraryItems.filter((item) => {
      const haystack = [item.name, item.domain, item.url, item.category, item.language, ...(item.tags || [])]
        .filter(Boolean).join(" ").toLowerCase();
      const preferences = LibraryClassifier.libraryPreferences(item.annotation);
      return (
        (!query || haystack.includes(query)) &&
        (!category || item.category === category) &&
        (!group || LibraryGroups.matches(item, group)) &&
        (!access || item.accessModel === access) &&
        (!favorite || (favorite === "favorite" ? preferences.favorite : !preferences.favorite)) &&
        (!enabled || (enabled === "enabled" ? preferences.enabled : !preferences.enabled))
      );
    });
  }

  function updateQuickOpenControls() {
    const count = sidepanelQuickOpenSelection.size;
    const countLabel = $("quickOpenSelectedCount");
    if (countLabel) countLabel.textContent = `已选 ${count} 条`;
    const button = $("btnQuickOpenBatch");
    if (button) {
      const batchSize = Math.min(20, Math.max(1, Number($("quickOpenBatchSize")?.value) || 5));
      button.disabled = !count || quickOpenBusy;
      button.textContent = quickOpenBusy ? "正在打开…" : `打开下一批（最多 ${Math.min(batchSize, count)} 条）`;
    }
    const selectButton = $("btnQuickOpenSelectFiltered");
    if (selectButton) {
      const filtered = sidepanelLibraryFilteredItems();
      const allSelected = filtered.length > 0 && filtered.every((item) => sidepanelQuickOpenSelection.has(item.key));
      selectButton.textContent = allSelected ? "取消当前筛选" : "选择当前筛选";
    }
  }

  async function updateLibraryItemPreferences(item, changes) {
    const result = await chrome.runtime.sendMessage({
      action: "updateLibraryPreferences",
      url: item.url,
      ...changes,
    });
    if (!result?.ok) throw new Error(result?.error || "保存个人外链设置失败");
    item.annotation = result.annotation || item.annotation;
    item.library = result.library || LibraryClassifier.libraryPreferences(item.annotation);
    populateSidepanelLibraryGroups(sidepanelLibraryItems);
    renderSidepanelLibrary();
  }

  function updateLibraryCategoryStartButton() {
    const button = $("btnStartLibraryCategory");
    if (!button) return;
    const category = $("sidepanelLibraryCategory")?.value || "";
    button.disabled = !category || running || batchStatus === "paused";
    button.textContent = category ? `提交「${category}」` : "从此分类开始提交";
  }

  function updateLibraryGroupStartButton() {
    const button = $("btnStartLibraryGroup");
    if (!button) return;
    const groupId = $("sidepanelLibraryGroup")?.value || "";
    const group = LibraryGroups.GROUPS.find(([id]) => id === groupId);
    const count = group ? sidepanelLibraryItems.filter((item) => LibraryGroups.matches(item, groupId)).length : 0;
    button.disabled = !count || running || batchStatus === "paused";
    button.textContent = group ? `提交「${group[1]}」组（${count} 站）` : "从此分组开始提交";
  }

  function renderSidepanelLibrary() {
    const list = $("sidepanelLibraryList");
    if (!list) return;
    const filtered = sidepanelLibraryFilteredItems();
    const shown = filtered.slice(0, sidepanelLibraryVisibleLimit);
    list.replaceChildren();
    if ($("sidepanelLibrarySummary")) {
      const cloudRows = Number(sidepanelLibraryStats.cloudRows) || 0;
      const customOnly = Number(sidepanelLibraryStats.customOnly) || 0;
      $("sidepanelLibrarySummary").textContent = cloudRows
        ? `云端 ${cloudRows} 行 · ${sidepanelLibraryItems.length} 个目标${customOnly ? `（含 ${customOnly} 条自定义补充）` : ""} · 筛选后 ${filtered.length} 条 · 已展示 ${shown.length} 条`
        : `共 ${sidepanelLibraryItems.length} 条 · 筛选后 ${filtered.length} 条 · 已展示 ${shown.length} 条`;
    }
    if (!shown.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "没有符合条件的外链，换个分类或关键词试试。";
      list.append(empty);
    }
    for (const item of shown) {
      const preferences = LibraryClassifier.libraryPreferences(item.annotation);
      const card = document.createElement("article");
      card.className = `sidepanel-library-item${sidepanelQuickOpenSelection.has(item.key) ? " selected" : ""}`;
      const head = document.createElement("div");
      head.className = "sidepanel-library-head";
      const select = document.createElement("input");
      select.type = "checkbox";
      select.checked = sidepanelQuickOpenSelection.has(item.key);
      select.setAttribute("aria-label", `选择 ${item.name || item.domain || item.url} 用于 Quick Open`);
      select.addEventListener("change", () => {
        if (select.checked) sidepanelQuickOpenSelection.set(item.key, item.url);
        else sidepanelQuickOpenSelection.delete(item.key);
        card.classList.toggle("selected", select.checked);
        updateQuickOpenControls();
      });
      const titleWrap = document.createElement("div");
      titleWrap.className = "sidepanel-library-title";
      const title = document.createElement("strong");
      title.textContent = item.name || item.domain || item.url;
      const domain = document.createElement("span");
      domain.textContent = item.domain || item.url;
      titleWrap.append(title, domain);
      const open = document.createElement("a");
      open.href = item.url;
      open.target = "_blank";
      open.rel = "noreferrer";
      open.className = "sidepanel-library-open";
      open.textContent = "打开";
      head.append(select, titleWrap, open);
      const chips = document.createElement("div");
      chips.className = "sidepanel-library-chips";
      const values = [item.category, libraryAccessLabel(item.accessModel), item.language];
      for (const [groupId, label] of LibraryGroups.GROUPS) {
        if (LibraryGroups.matches(item, groupId)) values.push(label);
      }
      if (Number.isFinite(item.classification?.dr)) values.push(`DR ${item.classification.dr}`);
      if (Number.isFinite(item.classification?.organicTraffic)) values.push(`流量 ${formatLibraryMetric(item.classification.organicTraffic)}`);
      for (const value of values.filter(Boolean)) {
        const chip = document.createElement("span");
        chip.textContent = value;
        chips.append(chip);
      }
      const status = document.createElement("div");
      status.className = "sidepanel-library-status";
      const markers = Q.normalizeAnnotationStatuses(item.annotation);
      const progress = (item.profileStatuses || []).filter((profile) => profile.success || profile.latestEvent).length;
      status.textContent = markers.length ? markers.map((value) => SITE_STATUS_MAP[value]?.label || value).join(" · ") : progress ? `${progress} 个 Profile 已有记录` : "尚未提交";
      const actions = document.createElement("div");
      actions.className = "sidepanel-library-actions";
      const favoriteButton = document.createElement("button");
      favoriteButton.type = "button";
      favoriteButton.className = `sidepanel-library-action${preferences.favorite ? " active" : ""}`;
      favoriteButton.textContent = preferences.favorite ? "★ 已收藏" : "☆ 收藏";
      favoriteButton.setAttribute("aria-pressed", String(preferences.favorite));
      favoriteButton.addEventListener("click", () => {
        updateLibraryItemPreferences(item, { favorite: !preferences.favorite })
          .catch((error) => showToast(error.message, true));
      });
      const enabledButton = document.createElement("button");
      enabledButton.type = "button";
      enabledButton.className = `sidepanel-library-action${preferences.enabled ? "" : " disabled"}`;
      enabledButton.textContent = preferences.enabled ? "已启用" : "已停用";
      enabledButton.setAttribute("aria-pressed", String(preferences.enabled));
      enabledButton.addEventListener("click", () => {
        updateLibraryItemPreferences(item, { enabled: !preferences.enabled })
          .catch((error) => showToast(error.message, true));
      });
      actions.append(favoriteButton, enabledButton);

      const groupActions = document.createElement("div");
      groupActions.className = "sidepanel-library-group-actions";
      for (const [groupId, label] of LibraryGroups.GROUPS) {
        const active = LibraryGroups.matches(item, groupId);
        const groupBlockedReason = !preferences.enabled
          ? "站点已停用，启用后才能加入分组"
          : markers.some((status) => ["broken", "skip", "deleted"].includes(status))
            ? "该站点当前标记为无法提交、跳过或已删除"
            : groupId === "free_submit" && markers.includes("paid")
              ? "已标记为付费，不能加入免费可提交分组"
              : "";
        const groupButton = document.createElement("button");
        groupButton.type = "button";
        groupButton.className = `sidepanel-library-action${active ? " in-group" : ""}`;
        groupButton.textContent = `${active ? "✓" : "+"} ${label}`;
        groupButton.setAttribute("aria-pressed", String(active));
        groupButton.setAttribute("aria-label", `${active ? "从" : "加入"}${label}${active ? "分组移出" : "分组"}：${item.name || item.domain || item.url}`);
        groupButton.disabled = Boolean(groupBlockedReason);
        if (groupBlockedReason) groupButton.title = groupBlockedReason;
        groupButton.addEventListener("click", () => {
          const next = new Set(LibraryGroups.GROUPS
            .filter(([id]) => LibraryGroups.matches(item, id))
            .map(([id]) => id));
          if (active) next.delete(groupId);
          else next.add(groupId);
          groupButton.disabled = true;
          updateLibraryItemPreferences(item, { groups: [...next] })
            .catch((error) => {
              groupButton.disabled = false;
              showToast(error.message, true);
            });
        });
        groupActions.append(groupButton);
      }

      const profileAssignment = document.createElement("details");
      profileAssignment.className = "library-profile-assignment";
      const profileSummary = document.createElement("summary");
      profileSummary.textContent = preferences.profileIds.length
        ? `指定 ${preferences.profileIds.length} 个 Profile`
        : "全部 Profile 可用";
      const profileOptions = document.createElement("div");
      profileOptions.className = "library-profile-options";
      for (const [profileId, profile] of Object.entries(siteProfiles)) {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = preferences.profileIds.includes(profileId);
        checkbox.addEventListener("change", () => {
          const next = new Set(preferences.profileIds);
          if (checkbox.checked) next.add(profileId);
          else next.delete(profileId);
          updateLibraryItemPreferences(item, { profileIds: [...next] })
            .catch((error) => showToast(error.message, true));
        });
        label.append(checkbox, document.createTextNode(profile?.name || profileId));
        profileOptions.append(label);
      }
      const profileHint = document.createElement("p");
      profileHint.className = "library-profile-hint";
      profileHint.textContent = "未勾选时全部 Profile 可用；勾选后只进入指定 Profile 的队列。";
      profileAssignment.append(profileSummary, profileOptions, profileHint);
      card.append(head, chips, status, actions, groupActions, profileAssignment);
      list.append(card);
    }
    const more = $("btnSidepanelLibraryMore");
    if (more) {
      more.hidden = shown.length >= filtered.length;
      more.textContent = `加载更多（剩余 ${Math.max(0, filtered.length - shown.length)} 条）`;
    }
    updateQuickOpenControls();
    updateLibraryGroupStartButton();
  }

  async function loadSidepanelLibrary() {
    if ($("sidepanelLibrarySummary")) $("sidepanelLibrarySummary").textContent = "正在加载外链库…";
    const result = await chrome.runtime.sendMessage({ action: "getLibraryManagerState" });
    if (!result?.ok) throw new Error(result?.error || "加载外链库失败");
    sidepanelLibraryStats = result.libraryStats || {};
    sidepanelLibraryItems = (Array.isArray(result.items) ? result.items : []).map((item) => ({
      ...item,
      classification: item.classification || LibraryClassifier.describe(item),
      name: item.name || item.classification?.name || item.domain,
      category: item.category || item.classification?.category || "其他目录",
      language: item.language || item.classification?.language || "未知",
      accessModel: item.accessModel || item.classification?.accessModel || "unknown",
      tags: item.tags || item.classification?.tags || [],
    }));
    sidepanelLibraryLoaded = true;
    populateSidepanelLibraryCategories(sidepanelLibraryItems);
    populateSidepanelLibraryGroups(sidepanelLibraryItems);
    updateLibraryCategoryStartButton();
    updateLibraryGroupStartButton();
    renderSidepanelLibrary();
  }

  for (const id of [
    "sidepanelLibrarySearch",
    "sidepanelLibraryCategory",
    "sidepanelLibraryGroup",
    "sidepanelLibraryAccess",
    "sidepanelLibraryFavorite",
    "sidepanelLibraryEnabled",
  ]) {
    $(id)?.addEventListener(id === "sidepanelLibrarySearch" ? "input" : "change", () => {
      sidepanelLibraryVisibleLimit = 60;
      updateLibraryCategoryStartButton();
      updateLibraryGroupStartButton();
      renderSidepanelLibrary();
    });
  }
  $("btnSidepanelLibraryMore")?.addEventListener("click", () => {
    sidepanelLibraryVisibleLimit += 60;
    renderSidepanelLibrary();
  });
  $("quickOpenBatchSize")?.addEventListener("input", updateQuickOpenControls);
  $("btnQuickOpenSelectFiltered")?.addEventListener("click", () => {
    const filtered = sidepanelLibraryFilteredItems();
    const allSelected = filtered.length > 0 && filtered.every((item) => sidepanelQuickOpenSelection.has(item.key));
    for (const item of filtered) {
      if (allSelected) sidepanelQuickOpenSelection.delete(item.key);
      else sidepanelQuickOpenSelection.set(item.key, item.url);
    }
    renderSidepanelLibrary();
  });
  $("btnQuickOpenBatch")?.addEventListener("click", async () => {
    if (quickOpenBusy || !sidepanelQuickOpenSelection.size) return;
    quickOpenBusy = true;
    updateQuickOpenControls();
    const status = $("quickOpenStatus");
    if (status) status.textContent = "正在按间隔打开下一批…";
    try {
      const batchSize = Math.min(20, Math.max(1, Number($("quickOpenBatchSize")?.value) || 5));
      const intervalMs = Math.min(5000, Math.max(100, Number($("quickOpenInterval")?.value) || 800));
      const result = await chrome.runtime.sendMessage({
        action: "quickOpenLibraryUrls",
        urls: [...sidepanelQuickOpenSelection.values()],
        batchSize,
        intervalMs,
      });
      if (!result?.ok) throw new Error(result?.error || "批量打开失败");
      const openedUrls = (result.opened || []).map((entry) => entry.url);
      if ($("quickOpenRemoveOpened")?.checked) {
        const openedKeys = new Set(openedUrls.map((url) => Q.normalizeDestinationKey(url)));
        for (const [key, url] of sidepanelQuickOpenSelection.entries()) {
          if (openedKeys.has(Q.normalizeDestinationKey(url))) sidepanelQuickOpenSelection.delete(key);
        }
      }
      if (status) {
        status.textContent = `已打开 ${openedUrls.length} 条${result.failed?.length ? `，失败 ${result.failed.length} 条` : ""}；未填写、未提交。`;
      }
      renderSidepanelLibrary();
    } catch (error) {
      if (status) status.textContent = `Quick Open 失败：${error.message}`;
      showToast(error.message, true);
    } finally {
      quickOpenBusy = false;
      updateQuickOpenControls();
    }
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
        "cfgConcurrency",
        "cfgPingIndex",
        "unattendedPreferences",
        "activeBatchRun",
        "selectedSiteIds",
        "urlList",
        "batchRunLog",
      ],
      (items) => {
        siteProfiles = items.siteProfiles || {};
        activeSiteId = items.activeSiteId || Object.keys(siteProfiles)[0] || "";
        selectedSiteIds = (items.selectedSiteIds || []).filter((id) => siteProfiles[id]);
        if (!selectedSiteIds.length && activeSiteId) selectedSiteIds = [activeSiteId];
        batchConcurrency = Sidepanel.normalizeBatchConcurrency(items.cfgConcurrency);
        batchPingIndex = items.cfgPingIndex !== false;
        const activeRun = items.activeBatchRun;
        const unattendedPrefs = items.unattendedPreferences || {};
        if ($("cfgUnattended")) $("cfgUnattended").checked = unattendedPrefs.enabled === true;
        if ($("cfgUnattendedHours")) $("cfgUnattendedHours").value = unattendedPrefs.hours || 8;
        if ($("cfgUnattendedTasks")) $("cfgUnattendedTasks").value = unattendedPrefs.tasks || 100;
        if ($("cfgUnattendedManualTabs")) $("cfgUnattendedManualTabs").value = unattendedPrefs.manualTabs || 20;
        if ($("unattendedOptions")) $("unattendedOptions").hidden = unattendedPrefs.enabled !== true;
        if (
          activeRun?.tasks?.length &&
          ["running", "waiting_manual", "paused", "stopped", "finished"].includes(activeRun.status)
        ) {
          // Persisted v3 rows are compact tuples. Ask the background for the
          // current UI window instead of expanding the entire batch here.
          tasks = [];
          taskWindow = { start: 0, end: 0, total: activeRun.tasks.length, truncated: true };
          syncTasksFromBackground();
        }
        setBatchStatus(activeRun?.status || "idle", false);
        hydrateBatchLog(items.batchRunLog, batchRunStatusForLog(activeRun?.status));
        renderSiteSelect();
        renderBatchSiteChoices();
        renderTimelineProfileOptions();
        updateProfileStatus();
        cb?.(items);
      },
    );
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.activeBatchRun) {
      const batch = changes.activeBatchRun.newValue;
      if (batch?.status) setBatchStatus(batch.status, false);
      refreshUnattendedSummary(batch || null).catch(() => {});
    }
    if (changes.siteProfiles || changes.activeSiteId) {
      const previousActiveSiteId = activeSiteId;
      chrome.storage.local.get(["siteProfiles", "activeSiteId"], (items) => {
        siteProfiles = items.siteProfiles || {};
        activeSiteId = items.activeSiteId || Object.keys(siteProfiles)[0] || "";
        selectedSiteIds = selectedSiteIds.filter((id) => siteProfiles[id]);
        if (!selectedSiteIds.length && activeSiteId) selectedSiteIds = [activeSiteId];
        renderSiteSelect();
        renderBatchSiteChoices();
        renderTimelineProfileOptions();
        updateProfileStatus();
        if (previousActiveSiteId !== activeSiteId) {
          resetCommentStudio({ clearHistory: true });
          resetMediaUploadState();
          loadCommentTemplate({ force: true });
          // The marker belongs to the destination site, not the selected Profile.
          refreshSiteAnnotation(currentPageUrl).catch(() => {});
        }
        loadMediaPreflight().catch(() => {});
      });
    }
    if (changes.cfgConcurrency || changes.cfgPingIndex) {
      if (changes.cfgConcurrency) batchConcurrency = Sidepanel.normalizeBatchConcurrency(changes.cfgConcurrency.newValue);
      if (changes.cfgPingIndex) {
        batchPingIndex = changes.cfgPingIndex.newValue !== false;
      }
    }
    if (changes.deletedSubmissionKeys || changes.siteAnnotations || changes.urlList) {
      loadSubmissionQueue(currentPageUrl);
      loadClassifiedList();
      refreshSiteAnnotation(currentPageUrl).catch(() => {});
    }
    if (
      typeof sidepanelLibraryLoaded !== "undefined" && sidepanelLibraryLoaded &&
      (changes.sheetTableData || changes.urlList || changes.siteAnnotations || changes.submissionRecords || changes.submissionTimeline || changes.domainMetricsCache)
    ) {
      loadSidepanelLibrary().catch((error) => renderSidepanelLibraryError(error));
    }
    if (changes.submissionRecords || changes.submissionTimeline) {
      loadSidepanelTimeline(currentPageUrl).catch(() => {});
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
        const nextSelectedSiteIds = [...selectedSiteIds];
        chrome.storage.local.set({ selectedSiteIds });
        // Clear the old nav before the request completes so a quick click
        // cannot operate on a task excluded by the new Profile selection.
        submissionTasks = [];
        submissionIndex = 0;
        submissionMeta = { fromTable: 0, fromPlugin: 0, excluded: 0, total: 0 };
        renderSubmissionNav();
        updateBatchPreview();
        loadSubmissionQueue(currentPageUrl, nextSelectedSiteIds).catch(() => {});
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
    const requestToken = ++batchPreviewToken;
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
      if (requestToken !== batchPreviewToken) return;
      summary.textContent = `${destinationTotal} 个外链站 · ${total} 个待提交组合 · 历史成功跳过 ${skipped} 个`;
    } catch (err) {
      if (requestToken !== batchPreviewToken) return;
      summary.textContent = `无法计算：${err.message}`;
    }
  }

  $("spSiteSelect")?.addEventListener("change", () => {
    activeSiteId = $("spSiteSelect").value;
    chrome.storage.local.set({ activeSiteId });
    setAutoFillStatus("");
    resetCommentStudio({ clearHistory: true });
    resetMediaUploadState();
    updateProfileStatus();
    renderCurrentQueueQuality();
    loadCommentTemplate({ force: true });
    loadMediaPreflight().catch(() => {});
    // Re-read the destination marker after switching between Profile A/B.
    refreshSiteAnnotation(currentPageUrl).catch(() => {});
  });

  async function loadSubmissionQueue(syncUrl, selectedIds = selectedSiteIds) {
    const requestToken = ++submissionQueueLoadToken;
    const profileIds = Array.isArray(selectedIds) ? [...selectedIds] : [];
    if (!profileIds.length) {
      submissionTasks = [];
      submissionIndex = 0;
      submissionMeta = { fromTable: 0, fromPlugin: 0, excluded: 0, total: 0 };
      renderSubmissionNav();
      return;
    }
    try {
      const tab = await getOwnerActiveTab();
      const url = syncUrl || tab?.url || "";
      const result = await chrome.runtime.sendMessage({
        action: "getSubmissionQueue",
        url: url.startsWith("http") ? url : undefined,
        selectedSiteIds: profileIds,
      });
      if (requestToken !== submissionQueueLoadToken) return;
      submissionTasks = result?.tasks || [];
      submissionIndex = result?.index ?? 0;
      submissionMeta = result?.meta || submissionMeta;
      renderSubmissionNav();
    } catch {
      if (requestToken !== submissionQueueLoadToken) return;
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
    const activeProfile = statuses.find((profile) => String(profile?.profileId || "") === activeSiteId);
    const profileName =
      activeProfile?.profileName || siteProfiles[activeSiteId]?.name || activeSiteId || "当前 Profile";
    const profileSummary = activeProfile
      ? `${profileName}·${statusText[activeProfile.status] || activeProfile.status || "待提交"}`
      : `${profileName}·未纳入该站队列`;
    statusEl.textContent = profileSummary;
    statusEl.title = profileSummary;
    wrap.removeAttribute("hidden");
  }

  function queueTaskMatchesCurrentPage(task, pageUrl = currentPageUrl) {
    if (!task || !pageUrl) return false;
    const normalizeDestination = typeof Q?.normalizeDestinationKey === "function"
      ? Q.normalizeDestinationKey
      : typeof Q?.normalizeUrlKey === "function"
        ? Q.normalizeUrlKey
        : (value) => String(value || "").trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
    const pageKey = normalizeDestination(pageUrl);
    const taskKey = String(task.key || task.destinationKey || "").trim();
    if (taskKey && (taskKey === pageKey || normalizeDestination(taskKey) === pageKey)) return true;
    const pageDomain = typeof Q?.extractDomain === "function" ? Q.extractDomain(pageUrl) : "";
    const taskDomain = String(task.domain || (typeof Q?.extractDomain === "function" ? Q.extractDomain(task.url) : "") || "").trim();
    return !!pageDomain && !!taskDomain && pageDomain.toLowerCase() === taskDomain.toLowerCase();
  }

  function renderCurrentQueueQuality() {
    const currentTask = submissionTasks.find((task) => queueTaskMatchesCurrentPage(task));
    renderQueueQuality(currentTask || null);
  }

  const SIDEPANEL_TIMELINE_LABELS = {
    submitted: "已提交",
    pending_moderation: "待审核",
    published: "已上线",
    rejected: "被拒绝",
    needs_follow_up: "待跟进",
    needs_manual: "待人工",
    link_missing: "疑似丢链",
    link_submit: "表格有提交动作 · 未核验",
    action_recorded: "表格有提交动作 · 未核验",
    awaiting_index: "待确认收录",
    note: "笔记",
    status: "状态更新",
  };

  function formatSidepanelTimelineTime(value) {
    const raw = String(value || "").trim();
    if (!raw || /^(?:unknown|null|undefined|n\/a|na|未(?:知|记录)|时间未知)$/i.test(raw)) return "时间未知";
    const timestamp = typeof Sidepanel !== "undefined" && Sidepanel?.parseTimelineTimestamp
      ? Sidepanel.parseTimelineTimestamp(raw) : Date.parse(raw);
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "时间未知";
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function sidepanelTimelineLabel(type) {
    return SIDEPANEL_TIMELINE_LABELS[String(type || "").trim()] || String(type || "动态");
  }

  function findSidepanelTimelineItem(items, pageUrl) {
    if (!Array.isArray(items) || !pageUrl) return null;
    const pageKey = typeof Q?.normalizeUrlKey === "function" ? Q.normalizeUrlKey(pageUrl) : "";
    const exact = items.find((item) => item?.key === pageKey);
    if (exact) return exact;
    const pageDomain = typeof Q?.extractDomain === "function" ? Q.extractDomain(pageUrl) : "";
    if (!pageDomain) return null;
    return items.find((item) => {
      const domain = item?.domain || (typeof Q?.extractDomain === "function" ? Q.extractDomain(item?.url) : "");
      return String(domain || "").toLowerCase() === String(pageDomain).toLowerCase();
    }) || null;
  }

  function renderSidepanelTimeline(item, options = {}) {
    const summary = $("sidepanelTimelineSummary");
    const list = $("sidepanelTimelineList");
    if (!summary || !list) return;
    currentTimelineItem = item || null;
    summary.dataset.syncStatus = options.sync?.status || "";
    const withSyncStatus = (text) => options.sync?.message
      ? `${text} · ${options.sync.message}`
      : text;
    const addButton = $("btnAddTimelineEvent");
    if (addButton) addButton.hidden = !Sidepanel.canEditTimeline(item, currentPageUrl);
    if (timelineEditorUrl && timelineEditorUrl !== currentPageUrl) closeTimelineEditor();
    list.replaceChildren();
    if (options.loading) {
      summary.textContent = "正在读取当前外链站动态…";
      const loading = document.createElement("div");
      loading.className = "empty-state compact-empty";
      loading.textContent = "正在读取时间线…";
      list.append(loading);
      return;
    }
    if (options.error) {
      summary.textContent = withSyncStatus("时间线暂时无法读取");
      const error = document.createElement("div");
      error.className = "empty-state compact-empty";
      error.textContent = options.error;
      list.append(error);
      return;
    }
    if (!item) {
      summary.textContent = withSyncStatus("当前页面尚未登记为外链站");
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";
      empty.textContent = "保存动态时会自动把当前页面加入外链库，然后显示提交和跟进记录。";
      list.append(empty);
      return;
    }

    const model = Sidepanel?.buildTimelineModel
      ? Sidepanel.buildTimelineModel(item, siteProfiles)
      : { events: [], profileCount: 0, latestAt: "" };
    if (!model.events.length) {
      summary.textContent = withSyncStatus(`${item.domain || "当前外链站"} · 暂无动态记录`);
      const empty = document.createElement("div");
      empty.className = "empty-state compact-empty";
      empty.textContent = "还没有提交、审核或跟进记录；可在设置页外链库添加动态。";
      list.append(empty);
      return;
    }

    summary.textContent = withSyncStatus(`${item.domain || "当前外链站"} · ${model.profileCount} 个 Profile · ${model.events.length} 条动态 · 最近 ${formatSidepanelTimelineTime(model.latestAt)}`);
    const visibleEvents = model.events.slice(0, 8);
    for (const event of visibleEvents) {
      const row = document.createElement("article");
      row.className = "sidepanel-timeline-event";
      const head = document.createElement("div");
      head.className = "sidepanel-timeline-event-head";
      const profile = document.createElement("span");
      profile.className = "sidepanel-timeline-profile";
      profile.textContent = event.profileName || event.profileId || "外链站";
      const type = document.createElement("span");
      type.className = `sidepanel-timeline-type ${String(event.type || "note").replace(/[^a-z0-9_-]/gi, "-")}`;
      type.textContent = sidepanelTimelineLabel(event.type);
      const time = document.createElement("time");
      time.className = "sidepanel-timeline-time";
      time.dateTime = event.occurredAt || "";
      time.textContent = formatSidepanelTimelineTime(event.occurredAt);
      head.append(profile, type, time);
      row.append(head);
      if (event.note) {
        const note = document.createElement("p");
        note.className = "sidepanel-timeline-note";
        note.textContent = event.note;
        row.append(note);
      }
      const linkValue = event.publicUrl || event.evidenceUrl || "";
      if (/^https?:\/\//i.test(linkValue)) {
        const link = document.createElement("a");
        link.className = "sidepanel-timeline-link";
        link.href = linkValue;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "查看公开页 / 证据";
        row.append(link);
      }
      list.append(row);
    }
    if (model.events.length > visibleEvents.length) {
      const more = document.createElement("div");
      more.className = "sidepanel-timeline-more";
      more.textContent = `还有 ${model.events.length - visibleEvents.length} 条动态，可在设置页外链库查看完整时间线`;
      list.append(more);
    }
  }

  async function loadSidepanelTimeline(pageUrl = currentPageUrl, { forceCloud = false } = {}) {
    const token = ++timelineLoadToken;
    if (!pageUrl?.startsWith("http")) {
      renderSidepanelTimeline(null);
      return;
    }

    // Keep an already-rendered local timeline visible while the background
    // performs its optional cloud read. A slow/offline Worker must never blank
    // the sidebar or delay the form detection/fill workflow.
    const currentSiteStillMatches = currentTimelineItem
      && findSidepanelTimelineItem([currentTimelineItem], pageUrl);
    if (!currentSiteStillMatches) {
      renderSidepanelTimeline(null, { loading: true });
    }

    let localResult;
    try {
      localResult = await chrome.runtime.sendMessage({
        action: "getLibraryManagerState",
        url: pageUrl,
        refreshCloud: false,
      });
      if (token !== timelineLoadToken) return;
      if (!localResult?.ok) throw new Error(localResult?.error || "无法读取外链库");
      renderSidepanelTimeline(findSidepanelTimelineItem(localResult.items, pageUrl));
    } catch (err) {
      if (token !== timelineLoadToken) return;
      renderSidepanelTimeline(null, { error: err.message || "请稍后重试" });
      return;
    }

    const refreshFromCloud = async () => {
      try {
        const cloudResult = await chrome.runtime.sendMessage({
          action: "refreshSubmissionLedger",
          force: forceCloud,
        });
        if (token !== timelineLoadToken) return;
        if (!cloudResult?.ok) throw new Error(cloudResult?.error || "云端动态读取失败");
        const refreshed = await chrome.runtime.sendMessage({
          action: "getLibraryManagerState",
          url: pageUrl,
          refreshCloud: false,
        });
        if (token !== timelineLoadToken) return;
        if (!refreshed?.ok) throw new Error(refreshed?.error || "刷新后的外链库读取失败");
        renderSidepanelTimeline(
          findSidepanelTimelineItem(refreshed.items, pageUrl),
          { sync: cloudResult.sync },
        );
      } catch (err) {
        if (token !== timelineLoadToken) return;
        // The local result is still authoritative for this render. Surface the
        // cloud problem in the summary without discarding visible local events.
        renderSidepanelTimeline(
          findSidepanelTimelineItem(localResult.items, pageUrl),
          {
            sync: {
              status: "error",
              message: `云端动态暂不可用，已保留本地记录：${err.message || "读取失败"}`,
            },
          },
        );
      }
    };
    refreshFromCloud().catch(() => {});
  }

  function toDateTimeLocal(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = (number) => String(number).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function timelineEditorTypeLabel(type) {
    return {
      submitted: "已提交",
      pending_moderation: "待审核",
      published: "已上线",
      note: "笔记",
    }[String(type || "").trim()] || "动态";
  }

  function renderTimelineProfileOptions() {
    const select = $("timelineProfileSelect");
    if (!select) return;
    const previous = select.value || activeSiteId;
    const ids = Object.keys(siteProfiles);
    select.replaceChildren();
    if (!ids.length) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = "未配置 Profile";
      empty.disabled = true;
      empty.selected = true;
      select.append(empty);
      return;
    }
    for (const id of ids) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = siteProfiles[id]?.name || id;
      select.append(option);
    }
    select.value = ids.includes(previous) ? previous : ids.includes(activeSiteId) ? activeSiteId : ids[0];
  }

  function closeTimelineEditor() {
    timelineEditorUrl = "";
    const editor = $("timelineEditor");
    if (editor) editor.hidden = true;
    const addButton = $("btnAddTimelineEvent");
    if (addButton) addButton.hidden = !Sidepanel.canEditTimeline(currentTimelineItem, currentPageUrl);
  }

  function openTimelineEditor() {
    if (!/^https?:\/\//i.test(currentPageUrl || "")) {
      showToast("当前页不是可登记的网页", true);
      return;
    }
    timelineEditorUrl = currentPageUrl;
    renderTimelineProfileOptions();
    const profileSelect = $("timelineProfileSelect");
    if (profileSelect && [...profileSelect.options].some((option) => option.value === activeSiteId)) {
      // A/B switching must affect a newly opened record immediately; do not
      // carry the Profile selected in the previous editor session.
      profileSelect.value = activeSiteId;
    }
    const destination = $("timelineDestinationLabel");
    if (destination) destination.textContent = currentTimelineItem?.domain || currentPageUrl;
    const occurredAt = $("timelineOccurredAt");
    if (occurredAt) occurredAt.value = toDateTimeLocal(new Date());
    const type = $("timelineEventType");
    if (type) type.value = "submitted";
    ["timelineNote", "timelinePublicUrl", "timelineEvidenceUrl"].forEach((id) => {
      const field = $(id);
      if (field) field.value = "";
    });
    const editor = $("timelineEditor");
    if (editor) editor.hidden = false;
    profileSelect?.focus();
  }

  function parseTimelineEditorTime(value) {
    const raw = String(value || "").trim();
    if (!raw) return new Date().toISOString();
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error("动态时间格式无效");
    return date.toISOString();
  }

  function validateTimelineLink(value, label) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (!/^https?:\/\//i.test(raw)) throw new Error(`${label}必须以 http:// 或 https:// 开头`);
    try {
      new URL(raw);
    } catch {
      throw new Error(`${label}格式无效`);
    }
    return raw;
  }

  async function saveTimelineEvent(event) {
    event?.preventDefault();
    if (timelineSaveInProgress) return;
    // Capture the page item before any awaited refresh can replace it. The
    // saved event must stay bound to the page/Profile the user reviewed.
    const capturedPageUrl = currentPageUrl;
    const capturedEditorUrl = timelineEditorUrl;
    let timelineItem = currentTimelineItem;
    const destinationUrl = capturedEditorUrl || timelineItem?.url || capturedPageUrl;
    if (!/^https?:\/\//i.test(destinationUrl || "")) {
      showToast("当前页不是可登记的网页", true);
      return;
    }
    const profileId = String($("timelineProfileSelect")?.value || "").trim();
    const profile = profileId ? siteProfiles[profileId] : null;
    if (!profileId || !profile) {
      showToast("请选择要记录的 Profile", true);
      return;
    }
    const type = String($("timelineEventType")?.value || "note").trim() || "note";
    const note = String($("timelineNote")?.value || "").trim();
    let occurredAt = "";
    let publicUrl = "";
    let evidenceUrl = "";
    try {
      occurredAt = parseTimelineEditorTime($("timelineOccurredAt")?.value);
      publicUrl = validateTimelineLink($("timelinePublicUrl")?.value, "公开链接");
      evidenceUrl = validateTimelineLink($("timelineEvidenceUrl")?.value, "证据链接");
    } catch (err) {
      showToast(err.message || "链接格式无效", true);
      return;
    }

    const saveButton = $("btnSaveTimelineEvent");
    const cancelButton = $("btnCancelTimelineEvent");
    timelineSaveInProgress = true;
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.textContent = "保存中…";
    }
    if (cancelButton) cancelButton.disabled = true;
    try {
      if (!timelineItem) {
        const added = await chrome.runtime.sendMessage({
          action: "addToUrlList",
          url: destinationUrl,
          platformType: detection?.platform || "directory",
        });
        if (!added?.ok) throw new Error(added?.error || "当前页面加入外链列表失败");
        const normalizedUrl = added.url || destinationUrl;
        const normalizedKey = typeof Q?.normalizeDestinationKey === "function"
          ? Q.normalizeDestinationKey(normalizedUrl)
          : typeof Q?.normalizeUrlKey === "function"
            ? Q.normalizeUrlKey(normalizedUrl)
            : normalizedUrl;
        timelineItem = {
          key: normalizedKey,
          url: normalizedUrl,
          domain: typeof Q?.extractDomain === "function" ? Q.extractDomain(normalizedUrl) : "",
          events: [],
        };
        // A tab/page switch can happen while the destination is materialized.
        // Keep the captured item for the event payload, but never replace a
        // newer page's item in the live panel.
        if (currentPageUrl === capturedPageUrl && timelineEditorUrl === capturedEditorUrl) {
          currentTimelineItem = timelineItem;
        }
      }

      const destinationKey = timelineItem?.key ||
        (typeof Q?.normalizeDestinationKey === "function"
          ? Q.normalizeDestinationKey(destinationUrl)
          : typeof Q?.normalizeUrlKey === "function"
            ? Q.normalizeUrlKey(destinationUrl)
            : destinationUrl);
      const result = await chrome.runtime.sendMessage({
        action: "addSubmissionTimelineEvent",
        destinationKey,
        destinationUrl: timelineItem?.url || destinationUrl,
        profileId,
        profileName: profile.name || profileId,
        occurredAt,
        type,
        note,
        publicUrl,
        evidenceUrl,
        source: "manual",
      });
      if (!result?.ok) throw new Error(result?.error || "保存外链动态失败");
      if (currentPageUrl === capturedPageUrl && timelineEditorUrl === capturedEditorUrl) {
        closeTimelineEditor();
      }
      await loadSidepanelTimeline(currentPageUrl);
      // A submitted timeline event can also create a success ledger record.
      // Refresh the pending queue before rendering its Profile status, or the
      // card keeps saying "待提交" until this tab is reopened.
      if (currentPageUrl === capturedPageUrl) {
        await loadSubmissionQueue(capturedPageUrl);
      }
      showToast(`已登记 ${timelineEditorTypeLabel(type)}（人工记录）`);
    } catch (err) {
      showToast(err.message || "保存外链动态失败", true);
    } finally {
      timelineSaveInProgress = false;
      if (saveButton) {
        saveButton.disabled = false;
        saveButton.textContent = "保存人工动态";
      }
      if (cancelButton) cancelButton.disabled = false;
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
    // The nav cursor may point at another queue item. The insight card must
    // describe the page currently open in this tab and the selected Profile.
    renderCurrentQueueQuality();
  }

  async function cycleSubmission(delta, options = {}) {
    if (!submissionTasks.length) await loadSubmissionQueue();
    if (!submissionTasks.length) {
      showToast("没有待提交站点，请更新 Table.xlsx 或外链库", true);
      return;
    }
    const anchoredIndex = options.targetKey
      ? submissionTasks.findIndex((task) => task.key === options.targetKey)
      : -1;
    submissionIndex = anchoredIndex >= 0
      ? anchoredIndex
      : (submissionIndex + delta + submissionTasks.length) % submissionTasks.length;
    await chrome.storage.local.set({ submissionQueueIndex: submissionIndex });
    renderSubmissionNav();
    const task = submissionTasks[submissionIndex];
    const url = task.url.startsWith("http") ? task.url : "https://" + task.url;
    const keepCurrent = options.keepCurrent === true;
    if (keepCurrent) {
      // Gates keep their tab; a verified, saved success may already have closed its owned tab.
      setAutoFillStatus(`${options.completedTabClosed ? "已关闭完成页" : "保留当前页"}，打开下一站 ${task.domain || task.url}…`);
      const opened = await chrome.tabs.create({ url, active: true, windowId: await ownerWindowIdPromise });
      if (opened?.id) ownedSubmissionTabs.set(opened.id, url);
      return;
    }
    const tab = await getOwnerActiveTab();
    if (tab?.id) {
      activeTabId = tab.id;
      setAutoFillStatus(`正在打开 ${task.domain || task.url}…`);
      await chrome.tabs.update(tab.id, { url });
      if (ownedSubmissionTabs.has(tab.id)) ownedSubmissionTabs.set(tab.id, url);
    }
  }

  function captureFillContext(tabId, expectedUrl, profileId) {
    const index = Q.findSubmissionIndex(expectedUrl, submissionTasks);
    return {
      tabId,
      expectedUrl,
      profileId,
      ownedUrl: ownedSubmissionTabs.get(tabId) || "",
      destinationKey: index >= 0 ? submissionTasks[index]?.key || "" : "",
    };
  }

  async function closeVerifiedOwnedTab(result, context) {
    if (!(result?.submitted && result?.matched && result?.evidence
      && result?.ledgerSaved === true && result?.cloudSynced === true)) return false;
    if (
      !context?.ownedUrl ||
      Q.normalizeUrlKey(context.ownedUrl) !== Q.normalizeUrlKey(context.expectedUrl)
    ) return false;
    if (activeTabId !== context.tabId || activeSiteId !== context.profileId) return false;
    if (ownedSubmissionTabs.get(context.tabId) !== context.ownedUrl) return false;
    const tab = await chrome.tabs.get(context.tabId).catch(() => null);
    if (!tab || !tab.active) return false;
    if (result.receiptTabUrl && Q.normalizeUrlKey(tab.url || "") !== Q.normalizeUrlKey(result.receiptTabUrl)) return false;
    try {
      // Closing an active tab briefly activates the previous page. Do not
      // auto-detect and refill that page while opening the next queue target.
      skipActivationFromVerifiedClose = true;
      await chrome.tabs.remove(context.tabId);
      ownedSubmissionTabs.delete(context.tabId);
      return true;
    } catch {
      skipActivationFromVerifiedClose = false;
      return false;
    }
  }

  chrome.tabs.onRemoved.addListener((tabId) => {
    ownedSubmissionTabs.delete(tabId);
    cloudReceiptCompletionTabs.delete(tabId);
  });

  $("btnPrevSite")?.addEventListener("click", () => cycleSubmission(-1));
  $("btnNextSite")?.addEventListener("click", () => cycleSubmission(1));
  $("btnLaunchNext")?.addEventListener("click", () => cycleSubmission(1));

  function setWorkflowStep(step) {
    workflowStep = step;
    const map = { detect: "stepDetect", fill: "stepFill", submit: "stepSubmit" };
    const order = ["detect", "fill", "submit"];
    const idx = step === "done" ? order.length : order.indexOf(step);
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
      const isTextControl = type === "textarea" || type === "text" || type === "div" || type === "contenteditable";
      return isTextControl && /comment|reply|review|message|feedback|body|thoughts|评论|回复|留言|正文/.test(hint);
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

  function updateCommentAvailability(snapshot = null) {
    const formSignal =
      detection?.standardWpComment === true ||
      detection?.commentFound === true ||
      pagePrescan?.hasCommentForm === true;
    const field = chooseCommentField(snapshot);
    const hasKnownField = !!field || !!String(pagePrescan?.commentFieldLabel || "").trim();
    let reason = "当前页面未识别为真实博客评论表单，已隐藏评论生成与填入。";
    if (!detection && !pagePrescan) {
      reason = "先点击「检测」确认当前页面是否有真实博客评论表单。";
    } else if (!formSignal) {
      reason = "当前页面没有真实博客评论表单，产品 Description 等目录字段不会当作评论。";
    } else if (!hasKnownField) {
      reason = "已发现评论区域，但没有找到可填写的评论字段；请手动检查页面。";
    }
    commentAvailability = { available: formSignal && hasKnownField, reason };
    const unavailable = $("commentAvailability");
    if (unavailable) {
      unavailable.textContent = commentAvailability.available
        ? "已确认当前页面有真实博客评论表单；评论只会填入评论字段。"
        : commentAvailability.reason;
      unavailable.className = "comment-availability" + (commentAvailability.available ? " ok" : "");
    }
    const body = $("commentStudioBody");
    if (body) body.hidden = !commentAvailability.available;
    const card = $("commentStudioCard");
    if (card) {
      card.dataset.commentAvailable = commentAvailability.available ? "true" : "false";
      // Directory and product pages should not reserve a large comment-draft
      // card. Keep the card only when detection found a blog comment area but
      // its field still needs human review, so that explanation remains visible.
      card.hidden = !!(detection || pagePrescan) && !commentAvailability.available && !formSignal;
    }
    const button = $("btnFillComment");
    if (button) {
      button.hidden = !commentAvailability.available;
      button.disabled = !commentAvailability.available;
      button.title = commentAvailability.available ? "填入当前页面评论字段" : commentAvailability.reason;
    }
    const regenerate = $("btnRegenComment");
    if (regenerate) {
      regenerate.hidden = !commentAvailability.available;
      regenerate.disabled = !commentAvailability.available;
      regenerate.title = commentAvailability.available ? "生成当前文章的评论候选" : commentAvailability.reason;
    }
    const tone = $("commentTone");
    if (tone) tone.disabled = !commentAvailability.available;
    return commentAvailability;
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
    if (!field && effectiveMax != null) {
      updateCommentAvailability(snapshot);
      return snapshot;
    }
    commentFieldInfo = {
      maxLength: effectiveMax,
      minLength: Number.isFinite(minLength) && minLength > 0 ? minLength : null,
      label: String(field?.label || field?.name || pagePrescan?.commentFieldLabel || "").trim(),
      source: field ? "page snapshot" : "unknown",
    };
    updateCommentCharCount();
    updateCommentAvailability(snapshot);
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

  function resolveCloudMediaFiles(assets) {
    const entries = Array.isArray(assets) ? assets : [];
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    const candidates = [activeSiteId, profile?.id, profile?.name]
      .map((value) => String(value || "").trim())
      .filter(Boolean);
    const candidateSet = new Set(candidates.map((value) => value.toLowerCase()));
    return entries
      .filter((entry) => candidateSet.has(String(entry?.profile_id || "").toLowerCase()))
      .map((entry) => ({
        assetId: entry.asset_id,
        name: entry.file_name,
        kind: entry.media_kind,
        mime: entry.content_type,
        bytes: entry.byte_length,
        index: entry.media_index,
        profile: entry.profile_id,
      }));
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
    const file = row?.__mediaFile;
    if (!file || token !== mediaLoadToken) return;
    const availability = row.querySelector(".media-file-availability");
    const image = row.querySelector(".media-file-thumb");
    try {
      const response = await chrome.runtime.sendMessage({
        action: "fetchCloudSubmissionMedia",
        ref: `cloud-media://${file.assetId}`,
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
      loading.textContent = "正在读取云端媒体清单…";
      list.append(loading);
    }
    setMediaLibraryStatus("正在读取云端媒体…");
    try {
      const response = await chrome.runtime.sendMessage({ action: "listCloudSubmissionMedia" });
      if (token !== mediaLoadToken) return;
      cloudMediaLibrary = response || null;
      if (!response?.ok) throw new Error(response?.error || "读取云端媒体失败");
      const files = resolveCloudMediaFiles(response.assets);
      if (!files.length) {
        setMediaLibraryStatus(`${siteProfiles[activeSiteId]?.name || activeSiteId || "当前 Profile"} 暂无云端媒体`, "warn");
        if (list) {
          list.replaceChildren();
          const empty = document.createElement("div");
          empty.className = "empty-state compact-empty";
          empty.textContent = "当前 Profile 没有可用的云端 Logo 或截图";
          list.append(empty);
        }
        return;
      }

      setMediaLibraryStatus(`云端媒体已就绪：${files.length} 个文件 · ${files[0].profile}`, "ok");
      if (!list) return;
      list.replaceChildren();
      const rows = files.map((file) => createMediaFileRow(file.profile, file));
      rows.forEach((row) => list.append(row));
      await Promise.all(rows.map((row) => enrichMediaFilePreview(row, token)));
    } catch (err) {
      if (token !== mediaLoadToken) return;
      cloudMediaLibrary = null;
      setMediaLibraryStatus(err.message || "读取云端媒体失败", "err");
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
      source: { cloud: "云端媒体", remote: "远程图片", embedded: "Profile 内置" }[message?.source] || message?.source || "页面",
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
  $("btnRefreshSidepanelTimeline")?.addEventListener("click", () => {
    loadSidepanelTimeline(currentPageUrl, { forceCloud: true }).catch(() => {});
  });
  $("btnAddTimelineEvent")?.addEventListener("click", openTimelineEditor);
  $("timelineEditor")?.addEventListener("submit", saveTimelineEvent);
  $("btnCancelTimelineEvent")?.addEventListener("click", closeTimelineEditor);

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
    if (!commentAvailability.available) {
      showToast(commentAvailability.reason, true);
      return;
    }
    if (!activeTabId || !currentPageUrl?.startsWith("http")) {
      showToast("请先打开目标文章页", true);
      return;
    }
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (!P.profileConfigured(profile)) {
      showToast("请先在设置页配置网站资料", true);
      return;
    }
    const requestedTabId = activeTabId;
    const requestedUrl = currentPageUrl;
    const requestedProfileId = activeSiteId;
    const isCurrentCommentContext = () =>
      isCurrentFillContext(requestedTabId, requestedUrl, requestedProfileId);
    const btn = $("btnRegenComment");
    const tone = $("commentTone")?.value || "helpful";
    if (btn) {
      btn.disabled = true;
      btn.textContent = "生成中…";
    }
    try {
      const snapshot = await refreshCommentFieldInfo();
      if (!isCurrentCommentContext()) {
        setAutoFillStatus("页面或 Profile 已切换，已放弃旧评论草稿", "warn");
        return;
      }
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

      if (!isCurrentCommentContext()) {
        setAutoFillStatus("页面或 Profile 已切换，已放弃旧评论草稿", "warn");
        return;
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
    if (!commentAvailability.available) {
      showToast(commentAvailability.reason, true);
      return;
    }
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

  function updateProductHuntFillButton() {
    const button = $("btnFillForm");
    if (!button || button.disabled) return;
    button.textContent = productHuntReadyToCreateTabId === activeTabId
      ? "确认创建 Product Hunt 草稿"
      : "填表";
  }

  function isCurrentFillContext(tabId, expectedUrl, profileId) {
    return activeTabId === tabId && currentPageUrl === expectedUrl && activeSiteId === profileId;
  }

  function getSidepanelFillRequest(tabId, expectedUrl, profileId) {
    return [...sidepanelFillRequests.values()].find(
      (request) =>
        !request.detached &&
        request.tabId === tabId &&
        request.expectedUrl === expectedUrl &&
        request.profileId === profileId,
    ) || null;
  }

  function releaseSidepanelFillRequest(request) {
    if (!request) return;
    clearTimeout(request.timeoutTimer);
    clearTimeout(request.staleTimer);
    if (sidepanelFillRequests.get(request.id) === request) sidepanelFillRequests.delete(request.id);
  }

  async function runSidepanelFill(options = {}) {
    const tabId = options.tabId;
    const expectedUrl = String(options.expectedUrl || "").trim();
    const profileId = String(options.profileId || "").trim();
    const mode = options.mode || "form";
    if (!tabId || !/^https?:\/\//i.test(expectedUrl) || !profileId) {
      return { error: "缺少当前网页或 Profile，已停止填表" };
    }
    const existing = getSidepanelFillRequest(tabId, expectedUrl, profileId);
    if (existing) {
      if (isCurrentFillContext(tabId, expectedUrl, profileId)) {
        setAutoFillStatus(
          existing.timedOut
            ? "当前填表仍在后台处理，请等待页面结果，不要重复点击"
            : "当前填表正在处理，请稍候，不要重复点击",
          "warn",
        );
      }
      return { busy: true, error: "当前网页的填表仍在处理，请等待结果" };
    }

    const request = {
      id: ++sidepanelFillRequestId,
      tabId,
      expectedUrl,
      profileId,
      mode,
      timedOut: false,
      detached: false,
      settled: false,
      timeoutTimer: null,
      staleTimer: null,
      fillContext: captureFillContext(tabId, expectedUrl, profileId),
    };
    sidepanelFillRequests.set(request.id, request);

    let responsePromise;
    try {
      responsePromise = chrome.runtime.sendMessage({
        action: "sidepanelFill",
        tabId,
        mode,
        useAgent: true,
        fillOnly: options.fillOnly !== false,
        profileId,
        expectedUrl,
        commentText: options.commentText || "",
        confirmProductHuntCreate: options.confirmProductHuntCreate === true,
      });
    } catch (err) {
      releaseSidepanelFillRequest(request);
      return { error: err.message || "填表请求发送失败" };
    }

    const observed = Promise.resolve(responsePromise).then(
      async (result) => {
        request.settled = true;
        clearTimeout(request.timeoutTimer);
        try {
          if (request.timedOut && !request.detached && isCurrentFillContext(tabId, expectedUrl, profileId)) {
            await handleFillResult(result, mode, request.fillContext);
          }
        } finally {
          releaseSidepanelFillRequest(request);
        }
        return result;
      },
      (err) => {
        request.settled = true;
        clearTimeout(request.timeoutTimer);
        releaseSidepanelFillRequest(request);
        if (request.timedOut && isCurrentFillContext(tabId, expectedUrl, profileId)) {
          setAutoFillStatus(err.message || "填表请求失败", "err");
        }
        throw err;
      },
    );
    request.staleTimer = setTimeout(() => {
      request.detached = true;
      releaseSidepanelFillRequest(request);
    }, SIDEPANEL_FILL_STALE_MS);
    const timeout = new Promise((resolve) => {
      request.timeoutTimer = setTimeout(() => {
        if (request.settled) return;
        request.timedOut = true;
        const timeoutResult = {
          timedOut: true,
          error: "填表响应超过 30 秒，后台可能仍在处理；请查看页面结果后再继续，不要重复点击",
        };
        if (isCurrentFillContext(tabId, expectedUrl, profileId)) {
          setAutoFillStatus(timeoutResult.error, "warn");
        }
        resolve(timeoutResult);
      }, SIDEPANEL_FILL_TIMEOUT_MS);
    });
    try {
      const result = await Promise.race([observed, timeout]);
      if (!isCurrentFillContext(tabId, expectedUrl, profileId)) {
        return {
          ...(result && typeof result === "object" ? result : {}),
          stale: true,
        };
      }
      return result;
    } catch (err) {
      return { error: err.message || "填表请求失败" };
    }
  }

  async function triggerAutoFillForCurrentTab(options = {}) {
    const tabId = options.tabId || activeTabId;
    const expectedUrl = String(options.expectedUrl || currentPageUrl || "").trim();
    const profileId = String(options.profileId || activeSiteId || "").trim();
    if (!tabId || !expectedUrl || !profileId) return;
    if (!isCurrentFillContext(tabId, expectedUrl, profileId)) return { stale: true };
    const profile = siteProfiles[profileId];
    if (!P.profileConfigured(profile)) return { error: "请先在设置页配置网站资料" };
    resetMediaUploadState();
    setAutoFillStatus("检测完成，正在自动填写…");
    const fillContext = captureFillContext(tabId, expectedUrl, profileId);
    const result = await runSidepanelFill({
      tabId,
      expectedUrl,
      profileId,
      mode: "form",
    });
    if (result?.timedOut || result?.busy || result?.stale) return result;
    await handleFillResult(result, "form", fillContext);
    return result;
  }

  async function handleFillResult(result, mode, context = null) {
    if (mode === "form") refreshMediaUploadResult(result).catch(() => {});
    if (result?.submitted && result?.matched && result?.evidence) {
      if (result?.platform === "product_hunt") {
        productHuntReadyToCreateTabId = null;
        updateProductHuntFillButton();
      }
      const successLabel =
        result.ledgerSaved !== true
          ? "已看到站方回执，账本保存仍待核验"
          : result.cloudSynced !== true
          ? `已提交并保存本地账本，保留页签等待云端回读${result.cloudReason ? `；${result.cloudReason}` : ""}`
          : result.publicationStatus === "pending_moderation"
          ? "已提交，站点显示待审核"
          : result.publicationStatus === "published"
            ? "已提交并看到上线回执"
            : "已提交并记入账本";
      setAutoFillStatus(successLabel, result.cloudSynced === true ? "ok" : "warn");
      await loadClassifiedList();
      await loadSubmissionQueue(currentPageUrl);
      const completedStillQueued = context?.destinationKey
        ? submissionTasks.some((task) => task.key === context.destinationKey)
        : !!context?.expectedUrl && Q.findSubmissionIndex(context.expectedUrl, submissionTasks) >= 0;
      const nextTask = submissionTasks.length
        ? submissionTasks[(submissionIndex + (completedStillQueued ? 1 : 0)) % submissionTasks.length]
        : null;
      const completedTabClosed = await closeVerifiedOwnedTab(result, context);
      if (result.receiptTabUrl && !completedTabClosed) {
        throw new Error("云端已确认，但当前页签未安全关闭；保留当前页等待重试");
      }
      if (result.advance && result.ledgerSaved === true && result.cloudSynced === true) {
        if (nextTask) {
          showToast(`${successLabel} — ${completedTabClosed ? "已关闭当前页，" : ""}打开下一站`);
          const nextOpen = cycleSubmission(0, {
            keepCurrent: true,
            completedTabClosed,
            targetKey: nextTask.key,
          });
          if (result.receiptTabUrl) await nextOpen;
          else nextOpen.catch(() => {});
        } else {
          showToast(`${successLabel} — 待提交队列已完成`);
        }
      }
      return;
    }
    if (result?.platform === "product_hunt") {
      if (result.submitted && !(result.matched && result.evidence)) {
        productHuntReadyToCreateTabId = null;
        updateProductHuntFillButton();
        setAutoFillStatus(
          result.reason || "Product Hunt 已点击 Create draft，但未出现新的可核验回执；页签已保留",
          "warn",
        );
      } else if (result.ready_to_create) {
        productHuntReadyToCreateTabId = activeTabId;
        updateProductHuntFillButton();
        setAutoFillStatus(
          "Product Hunt 必填项已完成，等待确认 Create draft（不会排期或购买推广）",
          "warn",
        );
      } else if (result.stage) {
        productHuntReadyToCreateTabId = null;
        updateProductHuntFillButton();
        setAutoFillStatus(`Product Hunt 已处理至 ${result.stage}，页签已保留`, "warn");
      } else {
        productHuntReadyToCreateTabId = null;
        updateProductHuntFillButton();
        setAutoFillStatus("Product Hunt 当前步骤未推进，页签已保留", "warn");
      }
      await loadClassifiedList();
      await loadSubmissionQueue(currentPageUrl);
      return;
    }
    if (result?.needs_manual || result?.captcha || result?.blocked) {
      const label =
        (result.semanticReview && result.reason) ||
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
      } else if (result.submitted && result.matched && result.evidence) {
        msg =
          result.publicationStatus === "pending_moderation"
            ? "已提交，站点显示待审核"
            : result.publicationStatus === "published"
              ? "已提交并看到上线回执"
              : "已提交并记入账本";
      } else if (result.submitted && !result.matched) {
        msg = "已代点提交，未见回执，请人工确认；页签已保留";
      } else if (result.validationFailed) {
        msg = `表单校验未通过，已让 AI 补填：${
          (result.issues || result.validationIssues || []).slice(0, 2).join("；") || "仍有必填栏"
        }`;
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
      if (result.learnedFields?.length) {
        msg += `；资料库已补齐 ${result.learnedFields.join("、")}`;
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
      document.querySelectorAll(".mark-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      return;
    }

    try {
      const info = await chrome.runtime.sendMessage({ action: "getSiteAnnotation", url: pageUrl });
      const badge = $("siteStatusBadge");
      const addBtn = $("btnAddToUrlList");
      const rememberedFields = Object.keys(info?.annotation?.formKnowledge?.mappings || {}).length;
      const memoryLabel = rememberedFields ? ` · 已记住 ${rememberedFields} 个字段` : "";
      const statuses = Q.normalizeAnnotationStatuses(info?.annotation);

      document.querySelectorAll(".mark-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });

      if (statuses.length) {
        const primary = Q.primaryAnnotationStatus(statuses);
        const meta = SITE_STATUS_MAP[primary] || {
          label: primary,
          cls: "",
        };
        if (badge) {
          badge.textContent = statuses
            .map((value) => SITE_STATUS_MAP[value]?.label || value)
            .join("、") + memoryLabel;
          badge.className = "status-pill " + (meta.cls || "");
          badge.removeAttribute("hidden");
        }
        for (const value of statuses) {
          const button = document.querySelector(`.mark-btn[data-status="${value}"]`);
          button?.classList.add("active");
          button?.setAttribute("aria-pressed", "true");
        }
      } else if (badge) {
        badge.textContent = (info?.inQueue ? "📋 在外链队列中" : "未标记") + memoryLabel;
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
    try {
      const currentInfo = await chrome.runtime.sendMessage({
        action: "getSiteAnnotation",
        url: currentPageUrl,
      });
      const currentStatuses = Q.normalizeAnnotationStatuses(currentInfo?.annotation);
      const selected = currentStatuses.includes(status);
      if (!selected && status === "deleted") {
        if (!confirm("确认从外链列表删除此站点？删除后不会再自动填表。")) return;
      }
      const result = await chrome.runtime.sendMessage({
        action: "markSubmissionSite",
        url: currentPageUrl,
        status,
        toggle: true,
        tabId: activeTabId,
        profileId: activeSiteId,
      });
      if (!result?.ok) throw new Error(result?.error || "标记失败");
      await refreshSiteAnnotation(currentPageUrl);
      await loadSubmissionQueue(currentPageUrl);
      await loadClassifiedList();
      showToast(selected ? "已取消标记" : SITE_STATUS_MAP[status]?.label || "已标记");
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

  function loadCommentTemplate({ force = false } = {}) {
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (!profile) return;
    const cfg = P.buildAgentConfigFromProfile(profile, {});
    const box = $("spCommentText");
    if (!box) return;
    if (force || !box.value.trim()) {
      box.value = cfg.commentTemplate || "";
      updateCommentCharCount();
    }
  }

  // ─── Active tab tracking ───
  async function refreshActiveTab() {
    const previousTabId = activeTabId;
    const previousPageUrl = currentPageUrl;
    const tab = await getOwnerActiveTab();
    activeTabId = tab?.id || null;
    currentPageUrl = tab?.url?.startsWith("http") ? tab.url : "";
    if (activeTabId !== previousTabId || currentPageUrl !== previousPageUrl) {
      setAutoFillStatus("");
      setStatusPending();
    }
    if (tab?.url?.startsWith("http")) {
      try {
        const u = new URL(tab.url);
        $("spHostname") && ($("spHostname").textContent = u.hostname);
        $("spPageUrl") && ($("spPageUrl").textContent = tab.url);
      } catch {
        $("spHostname") && ($("spHostname").textContent = tab.url);
        $("spPageUrl") && ($("spPageUrl").textContent = "");
      }
      // Site badges are supplemental. A slow storage/cloud response must not
      // block the active-tab refresh used by Detect and Fill.
      refreshSiteAnnotation(tab.url).catch(() => {});
      loadSidepanelTimeline(tab.url).catch(() => {});
    } else {
      $("spHostname") && ($("spHostname").textContent = "—");
      $("spPageUrl") && ($("spPageUrl").textContent = "请在普通网页上使用");
      refreshSiteAnnotation("").catch(() => {});
      renderSidepanelTimeline(null);
    }
    renderCurrentQueueQuality();
    renderPageMetrics(pagePrescan, {});
    updateProductHuntFillButton();
  }

  chrome.tabs.onActivated.addListener(async ({ windowId }) => {
    if (windowId !== await ownerWindowIdPromise) return;
    if (skipActivationFromVerifiedClose) {
      skipActivationFromVerifiedClose = false;
      await refreshActiveTab();
      await loadSubmissionQueue(currentPageUrl);
      return;
    }
    await refreshActiveTab();
    if (!currentPageUrl?.startsWith("http")) return;
    await loadSubmissionQueue(currentPageUrl);
    detectCurrentPage().catch(() => {});
    requestAutoFillForTab(activeTabId, currentPageUrl);
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId === productHuntReadyToCreateTabId && info.url) {
      productHuntReadyToCreateTabId = null;
      updateProductHuntFillButton();
    }
    if (tabId === activeTabId && info.url) refreshActiveTab();
    if (info.status === "complete" && tabId === activeTabId) {
      detection = null;
      setStatusPending();
      if (info.url?.startsWith("http")) {
        loadSubmissionQueue(info.url);
        refreshSiteAnnotation(info.url);
        loadSidepanelTimeline(info.url).catch(() => {});
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
    detection = null;
    updateCommentAvailability(null);
    renderPageMetrics(null, {});
    $("pageTdk")?.setAttribute("hidden", "");
    resetCommentStudio({ clearHistory: true });
    closeTimelineEditor();
    resetMediaUploadState();
    renderSidepanelTimeline(null, { loading: true });
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

  function shouldAutoFillAfterDetection(result = {}) {
    const platform = String(result.platform || "").trim().toLowerCase();
    if (!result.operable || Number(result.formFieldCount || 0) <= 0) return false;
    if (!["directory", "submission", "profile", "forum"].includes(platform)) return false;
    // A blog comment form is operable, but its Description-like textarea must
    // never receive the selected Profile's directory copy automatically.
    if (platform === "wp_comment" || platform === "article") return false;
    return true;
  }

  // ─── Detect ───
  async function detectCurrentPage() {
    await refreshActiveTab();
    if (!activeTabId) {
      showToast("没有活动标签页，请先打开目标网页", true);
      return;
    }
    const requestId = ++detectionRequestId;
    const requestedTabId = activeTabId;
    const requestedUrl = currentPageUrl;
    const requestedProfileId = activeSiteId;
    if (!requestedUrl?.startsWith("http")) {
      showToast("当前页不是可检测的网页", true);
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

      const prescanPromise = chrome.runtime
        .sendMessage({ action: "prescanPage", tabId: requestedTabId })
        .catch(() => null);
      const metricsPromise = fetchDomainMetricsForHost(hostname);
      const detectResult = await chrome.runtime.sendMessage({
        action: "sidepanelDetect",
        tabId: requestedTabId,
      });

      if (!detectResult?.ok) throw new Error(detectResult?.error || "检测失败");
      if (requestId !== detectionRequestId || activeTabId !== requestedTabId || currentPageUrl !== requestedUrl) return;
      if (detectResult.tabId) activeTabId = detectResult.tabId;

      detection = detectResult;
      renderDetection(detectResult);
      updateCommentAvailability(null);
      setWorkflowStep(detectResult.operable ? "fill" : "detect");

      // Detection should hand off to the deterministic fill path immediately.
      // Quality metrics and the richer page snapshot are background decoration
      // and must not make the user wait before fields start filling.
      if (shouldAutoFillAfterDetection(detectResult)) {
        setAutoFillStatus("检测成功，自动填写准备中…");
        triggerAutoFillForCurrentTab({
          tabId: requestedTabId,
          expectedUrl: requestedUrl,
          profileId: requestedProfileId,
        }).catch((err) => {
          if (requestId === detectionRequestId && currentPageUrl === requestedUrl) {
            setAutoFillStatus(err.message || "自动填表失败", "err");
          }
        });
      } else if (!detectResult.submissionRecovered) {
        showToast("检测完成");
      }

      Promise.allSettled([prescanPromise, metricsPromise]).then((results) => {
        if (requestId !== detectionRequestId || activeTabId !== requestedTabId || currentPageUrl !== requestedUrl) return;
        const prescanResult = results[0]?.status === "fulfilled" ? results[0].value : null;
        const metrics = results[1]?.status === "fulfilled" ? results[1].value : {};
        if (prescanResult?.ok) {
          pagePrescan = prescanResult;
          renderPageTdk(prescanResult);
          setStatusItem(
            "stComment",
            prescanResult.hasCommentForm ? "找到了" : "未找到",
            prescanResult.hasCommentForm ? "ok" : "",
          );
        }
        renderPageMetrics(pagePrescan, metrics);
        refreshCommentFieldInfo().catch(() => updateCommentAvailability(null));
        refreshSiteAnnotation(currentPageUrl).catch(() => {});
        if (detectResult.submissionRecovered) {
          loadSidepanelTimeline(currentPageUrl).catch(() => {});
          showToast("已从 Product Hunt 成功页恢复提交记录");
        }
      });
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
  async function fillPage(mode, options = {}) {
    // chrome.tabs.onActivated can lag behind rapid tab switches. Resolve the
    // real active tab again at action time so one Product Hunt draft never
    // drives another same-title tab in the background.
    await refreshActiveTab();
    if (!activeTabId) {
      showToast("没有活动标签页", true);
      return;
    }
    if (mode === "comment" && !commentAvailability.available) {
      showToast(commentAvailability.reason, true);
      return;
    }
    const requestedTabId = activeTabId;
    const requestedUrl = currentPageUrl;
    const requestedProfileId = activeSiteId;
    const fillContext = captureFillContext(requestedTabId, requestedUrl, requestedProfileId);
    const profile = activeSiteId ? siteProfiles[activeSiteId] : null;
    if (!P.profileConfigured(profile)) {
      showToast("请先在设置页配置网站资料", true);
      chrome.runtime.openOptionsPage();
      return;
    }

    const submitRequested = mode === "form" && options.submit === true;
    const btn = mode === "comment"
      ? $("btnFillComment")
      : $(submitRequested ? "btnSubmitPage" : "btnFillForm");
    if (!btn) return;
    const confirmProductHuntCreate =
      mode === "form" && productHuntReadyToCreateTabId === activeTabId;
    const origText = btn.textContent;
    btn.disabled = true;
    btn.textContent = submitRequested ? "提交中…" : "填写中…";
    if (mode === "form") resetMediaUploadState();
    setAutoFillStatus(submitRequested ? "正在核对并提交…" : "正在填写…");

    try {
      const commentOverride = ($("spCommentText")?.value || "").trim();
      const result = await runSidepanelFill({
        tabId: requestedTabId,
        expectedUrl: requestedUrl,
        profileId: requestedProfileId,
        mode,
        fillOnly: !submitRequested,
        commentText: commentOverride,
        confirmProductHuntCreate,
      });

      if (!result?.timedOut && !result?.busy && !result?.stale) {
        await handleFillResult(result, mode, fillContext);
        if (mode === "form" && result?.submitted && result?.matched) setWorkflowStep("done");
        else if (mode === "form" && (result?.ok || result?.fillOnly)) setWorkflowStep("submit");
        else if (mode === "comment" && (result?.ok || result?.fillOnly)) setWorkflowStep("submit");
      }
    } catch (err) {
      setAutoFillStatus(err.message, "err");
      showToast(err.message, true);
    } finally {
      btn.disabled = false;
      if (mode === "form" && !submitRequested) updateProductHuntFillButton();
      else btn.textContent = origText;
    }
  }

  $("btnFillForm")?.addEventListener("click", () => fillPage("form"));
  $("btnSubmitPage")?.addEventListener("click", () => fillPage("form", { submit: true }));

  // ─── Batch (from popup) ───
  function log(msg, cls) {
    appendLogEntry({ time: new Date().toLocaleTimeString(), msg, message: msg, cls });
  }

  function appendLogEntry(entry = {}) {
    const id = entry.id || "";
    if (id && logLines.some((line) => line.id === id)) return;
    logLines.push({
      id,
      time: entry.time || (entry.at ? new Date(entry.at).toLocaleTimeString() : new Date().toLocaleTimeString()),
      msg: entry.message || entry.msg || "",
      cls: entry.cls || (entry.level === "error" ? "err" : entry.level === "warn" ? "warn" : entry.level === "success" ? "ok" : ""),
    });
    if (logLines.length > 400) logLines.shift();
    if (["run_stopped", "run_stop_requested"].includes(entry.event)) batchLogStatus = "stopped";
    else if (entry.event === "run_finished") batchLogStatus = "finished";
    else if (entry.event === "queue_failed") batchLogStatus = "failed";
    else if (entry.runId && batchLogStatus === "idle") batchLogStatus = "running";
    if (entry.runId && $("batchLogSummary")) {
      $("batchLogSummary").textContent = `${entry.runId} · ${batchLogStatusLabel(batchLogStatus)} · ${logLines.length} 条（最多保留 400 条）`;
    }
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

  function hydrateBatchLog(batchLog, explicitStatus = "") {
    if (!batchLog || !Array.isArray(batchLog.entries)) return;
    batchLogStatus = explicitStatus || inferBatchLogStatus(batchLog.entries);
    logLines.length = 0;
    $("log")?.replaceChildren();
    for (const entry of batchLog.entries.slice(-400)) appendLogEntry(entry);
    const summary = $("batchLogSummary");
    if (summary) {
      const started = batchLog.startedAt ? new Date(batchLog.startedAt).toLocaleString() : "时间未知";
      summary.textContent = `${batchLog.runId || "诊断日志"} · ${batchLogStatusLabel(batchLogStatus)} · ${started} · ${batchLog.entries.length} 条（最多保留 400 条）`;
    }
  }

  function inferBatchLogStatus(entries = []) {
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const event = entries[index]?.event;
      if (["run_stopped", "run_stop_requested"].includes(event)) return "stopped";
      if (event === "run_finished") return "finished";
      if (event === "queue_failed") return "failed";
      if (event === "run_started") return "running";
    }
    return entries.length ? "diagnostic" : "idle";
  }

  function batchRunStatusForLog(status) {
    return {
      running: "running",
      paused: "paused",
      waiting_manual: "waiting_manual",
      stopped: "stopped",
      finished: "finished",
    }[status] || "";
  }

  function batchLogStatusLabel(status) {
    return {
      running: "运行中",
      paused: "已暂停",
      stopped: "已停止",
      finished: "已完成",
      waiting_manual: "等待人工处理",
      failed: "异常结束",
      diagnostic: "诊断日志",
      idle: "暂无运行",
    }[status] || "诊断日志";
  }

  $("btnCopyBatchLog")?.addEventListener("click", async () => {
    const text = logLines.map((line) => `[${line.time}] ${line.msg}`).join("\n");
    if (!text) {
      showToast("当前没有可复制的批量日志", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      showToast(`已复制 ${logLines.length} 条日志`);
    } catch (err) {
      showToast(`复制失败：${err.message}`, true);
    }
  });

  for (const id of ["cfgUnattended", "cfgUnattendedHours", "cfgUnattendedTasks", "cfgUnattendedManualTabs"]) {
    $(id)?.addEventListener("change", () => {
      const enabled = $("cfgUnattended")?.checked === true;
      $("unattendedOptions").hidden = !enabled;
      chrome.storage.local.set({ unattendedPreferences: {
        enabled,
        hours: Math.max(1, Math.min(12, Number($("cfgUnattendedHours").value) || 8)),
        tasks: Math.max(1, Math.min(500, Number($("cfgUnattendedTasks").value) || 100)),
        manualTabs: Math.max(1, Math.min(100, Number($("cfgUnattendedManualTabs").value) || 20)),
      } });
    });
  }

  async function refreshUnattendedSummary(savedBatch) {
    const element = $("unattendedRunSummary");
    if (!element) return;
    const batch = savedBatch === undefined
      ? (await chrome.storage.local.get("activeBatchRun")).activeBatchRun
      : savedBatch;
    element.hidden = batch?.config?.unattended !== true;
    if (element.hidden) return;
    const report = self.ExtLinkBatchReport.build(batch);
    const counts = report.summary;
    element.textContent = `本轮：取得回执 ${counts.success} · 待人工 ${counts.manual} · 失败 ${counts.failed} · 跳过 ${counts.skipped} · 剩余 ${counts.remaining}`;
    if (report.deadlineAt) element.textContent += ` · 截止 ${new Date(report.deadlineAt).toLocaleString()}`;
    element.textContent += ` · 模型调用 ${report.modelCallsUsed}`;
    element.textContent += ` · 保留人工页面 ${report.manualTabCount}/${report.maxManualTabs}`;
    if (report.waitReason === "manual_capacity") element.textContent += " · 已达容量，等待人工处理后继续";
    if (report.stopReason) element.textContent += ` · ${report.stopReason}`;
  }

  $("btnExportBatchReport")?.addEventListener("click", async () => {
    try {
      const { activeBatchRun } = await chrome.storage.local.get("activeBatchRun");
      const report = self.ExtLinkBatchReport.build(activeBatchRun);
      const blob = new Blob([self.ExtLinkBatchReport.markdown(report)], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `externallink-${report.runId}-本轮报告.md`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast("已导出本轮报告");
    } catch (err) { showToast(`报告导出失败：${err.message}`, true); }
  });

  $("btnExportAutomationRun")?.addEventListener("click", async () => {
    try {
      const stored = await chrome.storage.local.get("automationRunLedger");
      const ledger = stored.automationRunLedger || { schemaVersion: 1, order: [], runs: {} };
      const latestId = ledger.order?.[0];
      const payload = latestId ? ledger.runs?.[latestId] : null;
      if (!payload) {
        showToast("当前没有可导出的执行记录", true);
        return;
      }
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `externallink-${latestId}-执行记录.json`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast(`已导出 ${payload.events?.length || 0} 条执行事件`);
    } catch (err) {
      showToast(`导出失败：${err.message}`, true);
    }
  });

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
      needs_login: "🔐人工",
      needs_captcha: "🤖人工",
      needs_otp: "🔑人工",
      needs_manual: "🤖人工",
      filled: "✏️已填",
      verifying: "🔎验",
      submitted_unconfirmed: "🧾待证",
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
    if (taskWindow.truncated) {
      const notice = document.createElement("div");
      notice.className = "empty-state compact-empty";
      notice.textContent = `为避免侧栏卡死，仅显示第 ${taskWindow.start + 1}–${taskWindow.end} 项；本批共 ${taskWindow.total} 项，列表会随当前进度滚动。`;
      el.append(notice);
    }
    const waiting =
      batchStatus !== "stopped" &&
      (parkedTasks.length > 0 ||
        tasks.some((t) => ["captcha", "needs_captcha", "needs_otp", "needs_manual"].includes(t.status)));
    if ($("btnContinue")) $("btnContinue").hidden = !waiting;
    renderRunContext();
  }

  function renderRunContext() {
    const current = tasks.find((task) => task.status === "running");
    const status = $("autoFillStatus");
    if (!current || !status) return;
    const finished = stats.done + stats.skip + stats.err;
    setAutoFillStatus(
      `外链站 ${current.domain || current.url} · 正在提交 ${current.profileName || current.profileId} · 本站 ${current.groupJobIndex || 1}/${current.groupJobCount || 1} · 总进度 ${finished + 1}/${stats.total || taskWindow.total || tasks.length}`,
    );
  }

  function renderBatchControls() {
    const visibility = Controls.controlVisibility(batchStatus);
    running = batchStatus === "running";
    if ($("btnStart")) $("btnStart").hidden = visibility.startHidden;
    const toggle = $("btnBatchToggle");
    if (toggle) {
      toggle.hidden = visibility.pauseHidden && visibility.resumeHidden;
      toggle.textContent = batchStatus === "paused" ? "继续批量" : "暂停批量";
      toggle.classList.toggle("btn-primary", batchStatus === "paused");
      toggle.classList.toggle("btn-ghost", batchStatus !== "paused");
    }
    if ($("btnStop")) $("btnStop").hidden = visibility.stopHidden;
    for (const id of ["cfgUnattended", "cfgUnattendedHours", "cfgUnattendedTasks", "cfgUnattendedManualTabs", "cfgFillOnly"]) {
      if ($(id)) $(id).disabled = ["running", "paused"].includes(batchStatus);
    }
    updateLibraryCategoryStartButton();
    updateLibraryGroupStartButton();
  }

  function setBatchStatus(status, save = true) {
    const allowed = new Set(["idle", "running", "paused", "waiting_manual", "stopped", "finished"]);
    batchStatus = allowed.has(status) ? status : "idle";
    renderBatchControls();
    if (save) chrome.storage.local.set({ running: batchStatus === "running" });
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
      taskWindow = state?.taskWindow || { start: 0, end: tasks.length, total: tasks.length, truncated: false };
      parkedTasks = state?.parkedTasks || [];
      if (state?.status) setBatchStatus(state.status);
      else if (state?.running) setBatchStatus(state.paused ? "paused" : "running");
      else if (state?.stopped) setBatchStatus("stopped");
      if (state.stats) stats = state.stats;
      updateStats();
      renderTasks();
      renderManualTasks();
      refreshUnattendedSummary().catch(() => {});
    } catch {
      /* ignore */
    }
  }

  async function startSubmissionBatch({ category = "", group = "", button = null, switchToBatch = false } = {}) {
    if (running || batchStatus === "paused") return;
    if (!selectedSiteIds.length) {
      showToast("请至少勾选一个自家网站", true);
      return;
    }
    if (category && !LibraryClassifier.CATEGORY_ORDER.includes(category)) {
      showToast("请先选择有效的外链分类", true);
      return;
    }
    if (group && !LibraryGroups.GROUPS.some(([id]) => id === group)) {
      showToast("请先选择有效的外链分组", true);
      return;
    }
    const startButton = button || $("btnStart");
    const groupLabel = LibraryGroups.GROUPS.find(([id]) => id === group)?.[1];
    const idleText = groupLabel ? `提交「${groupLabel}」组` : category ? `提交「${category}」` : "开始提交";
    startButton.disabled = true;
    startButton.textContent = "正在构建队列…";
    try {
      const result = await chrome.runtime.sendMessage({
        action: "start",
        selectedSiteIds,
        category,
        group,
        config: {
          ...Sidepanel.buildBatchConfig({
            concurrency: batchConcurrency,
            pingIndex: batchPingIndex,
            fillOnly: $("cfgFillOnly")?.checked === true,
            unattended: $("cfgUnattended")?.checked === true,
            unattendedMaxHours: $("cfgUnattendedHours")?.value,
            unattendedMaxTasks: $("cfgUnattendedTasks")?.value,
            unattendedMaxManualTabs: $("cfgUnattendedManualTabs")?.value,
          }),
        },
      });
      if (!result?.ok) throw new Error(result?.error || "启动失败");
      tasks = result.tasks || [];
      taskWindow = result.taskWindow || { start: 0, end: tasks.length, total: tasks.length, truncated: false };
      stats = result.stats || { done: 0, skip: 0, err: 0, total: taskWindow.total || tasks.length };
      updateStats();
      renderTasks();
      setBatchStatus(stats.total > 0 ? "running" : "finished");
      updateBatchPreview();
      if (switchToBatch) document.querySelector('.tab[data-panel="batch"]')?.click();
    } catch (err) {
      await syncTasksFromBackground();
      showToast(err.message, true);
    } finally {
      startButton.disabled = false;
      startButton.textContent = idleText;
      updateLibraryCategoryStartButton();
      updateLibraryGroupStartButton();
    }
  }

  $("btnStart")?.addEventListener("click", () => {
    startSubmissionBatch({ button: $("btnStart") }).catch((err) => showToast(err.message, true));
  });

  $("btnStartLibraryCategory")?.addEventListener("click", () => {
    const category = $("sidepanelLibraryCategory")?.value || "";
    startSubmissionBatch({
      category,
      button: $("btnStartLibraryCategory"),
      switchToBatch: true,
    }).catch((err) => showToast(err.message, true));
  });

  $("btnStartLibraryGroup")?.addEventListener("click", () => {
    const group = $("sidepanelLibraryGroup")?.value || "";
    if (!group) return;
    startSubmissionBatch({
      group,
      button: $("btnStartLibraryGroup"),
      switchToBatch: true,
    }).catch((err) => showToast(err.message, true));
  });

  $("btnStop")?.addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({ action: "stop" });
    if (!result?.ok) {
      showToast(result?.error || "自动任务已停止，但批次状态保存失败", true);
      await syncTasksFromBackground();
      return;
    }
    setBatchStatus(result.status || "stopped");
    await syncTasksFromBackground();
    log("已停止", "warn");
  });

  $("btnBatchToggle")?.addEventListener("click", async () => {
    if (!["running", "paused"].includes(batchStatus)) return;
    const resuming = batchStatus === "paused";
    const result = await chrome.runtime.sendMessage({ action: resuming ? "resume" : "pause" });
    if (!result?.ok) {
      showToast(result?.error || (resuming ? "继续失败" : "暂停失败"), true);
      return;
    }
    setBatchStatus(resuming ? "running" : "paused");
    syncTasksFromBackground();
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
      if (task.tabId && batchStatus !== "stopped") {
        const open = document.createElement("button");
        open.type = "button";
        open.className = "btn btn-ghost";
        open.textContent = "查看原页面";
        open.addEventListener("click", async () => {
          try {
            await chrome.tabs.update(task.tabId, { active: true });
          } catch {
            showToast("原页签已关闭，请刷新待人工列表", true);
            syncTasksFromBackground();
          }
        });
        actions.append(open);
      }
      const resume = document.createElement("button");
      resume.type = "button";
      const productHuntReady = /Product Hunt 必填 100%.*Create draft/i.test(
        task.parkedReason || task.skipReason || "",
      );
      resume.className = productHuntReady ? "btn btn-primary" : "btn btn-ghost";
      resume.textContent = task.tabId
        ? batchStatus === "stopped"
          ? "打开页签"
          : productHuntReady
            ? "确认创建 Product Hunt 草稿"
            : "处理后继续"
        : "打开待办页面";
      resume.addEventListener("click", async () => {
        if (!task.tabId) {
          try {
            const url = new URL(task.url);
            if (!["https:", "http:"].includes(url.protocol)) throw new Error("无法打开此站点地址");
            await chrome.tabs.create({ url: url.href, active: true, windowId: await ownerWindowIdPromise });
            showToast("已打开待办页面，请核查站点状态后处理");
          } catch (err) { showToast(err.message, true); }
          return;
        }
        if (task.tabId) await chrome.tabs.update(task.tabId, { active: true }).catch(() => {});
        if (batchStatus === "stopped") return;
        await chrome.runtime.sendMessage({
          action: "manualContinue",
          taskIndex: task.index,
          taskId: task.id,
          runId: task.runId,
          platformType: task.platformType,
          confirmProductHuntCreate: productHuntReady,
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
          taskId: task.id,
          runId: task.runId,
          confirmationNonce: task.confirmationNonce,
          evidence: "user confirmed from side panel",
        });
        syncTasksFromBackground();
      });
      actions.append(resume);
      if (!productHuntReady) actions.append(confirm);
      card.append(title, reason, actions);
      el.append(card);
    }
    if ($("manualTabCount")) {
      $("manualTabCount").textContent = parkedTasks.length ? `(${parkedTasks.length})` : "";
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === "batchLogReset") {
      hydrateBatchLog({ runId: msg.runId, startedAt: msg.startedAt, entries: [] }, "running");
      return;
    }
    if (msg.action === "logPersistenceError") {
      appendLogEntry({
        msg: `日志持久化失败：${msg.error || "未知错误"}`,
        cls: "err",
      });
      return;
    }
    if (msg.action === "mediaUploadStatus") {
      handleMediaUploadStatus(msg);
      return;
    }
    if (msg.action === "autoFillUpdate") {
      if (msg.status === "cloudReceiptConfirmed") {
        const ownedUrl = ownedSubmissionTabs.get(msg.tabId);
        if (!ownedUrl || cloudReceiptCompletionTabs.has(msg.tabId)
          || activeTabId !== msg.tabId || activeSiteId !== msg.profileId
          || Q.normalizeDestinationKey(ownedUrl) !== Q.normalizeDestinationKey(msg.url)
          || Q.normalizeUrlKey(currentPageUrl) !== Q.normalizeUrlKey(msg.url)) return;
        cloudReceiptCompletionTabs.add(msg.tabId);
        handleFillResult({
          submitted: true, matched: true, evidence: msg.evidence,
          publicationStatus: msg.publicationStatus || "submitted",
          ledgerSaved: true, cloudSynced: true, advance: true, receiptTabUrl: msg.url,
        }, "form", captureFillContext(msg.tabId, ownedUrl, msg.profileId))
          .then(() => chrome.runtime.sendMessage({
            action: "ackPendingSubmissionCloudTab",
            tabId: msg.tabId, url: msg.url, profileId: msg.profileId,
          }))
          .catch((err) => {
            cloudReceiptCompletionTabs.delete(msg.tabId);
            setAutoFillStatus(`云端已确认，但继续队列失败：${err.message}`, "warn");
          });
        return;
      }
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
      if (msg.status === "filling") {
        const request = msg.tabId
          ? [...sidepanelFillRequests.values()].find(
              (item) => !item.detached && item.tabId === msg.tabId,
            )
          : null;
        const message = msg.message || "正在自动填写…";
        setAutoFillStatus(
          request?.timedOut ? `${message}（已超过 30 秒，后台仍在处理）` : message,
          request?.timedOut ? "warn" : undefined,
        );
      }
      else if (msg.status === "done") {
        const cls =
          msg.submitReady === false || msg.invalidCount > 0 || msg.emptyCount > 0 ? "warn" : "ok";
        setAutoFillStatus(msg.message || "填写完成", cls);
        if (msg.ledgerSaved === true) {
          loadSubmissionQueue(currentPageUrl).catch(() => {});
          loadSidepanelTimeline(currentPageUrl).catch(() => {});
        }
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
    // Content-script log messages reach every extension page. Only render the
    // enriched background copy so each step appears once and includes context.
    if (msg.action === "log" && msg.entry) appendLogEntry(msg.entry);
    if (msg.action === "status") {
      setBatchStatus(msg.status || (msg.running ? "running" : msg.stopped ? "stopped" : "idle"));
      refreshUnattendedSummary().catch(() => {});
    }
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

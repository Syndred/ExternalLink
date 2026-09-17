// ExternalLink Settings Page — site profiles & global config (persistent tab)
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const P = self.ExtLinkProfiles;
  const Q = self.ExtLinkQueue;
  const Timeline = self.ExtLinkSubmissionTimeline;

  let siteProfiles = {};
  let activeSiteId = "";
  let pendingLogoDataUrl = null;
  let mediaPreviewToken = 0;
  let libraryItems = [];
  let libraryStats = {};
  let libraryVisibleLimit = 200;
  const LIBRARY_PAGE_SIZE = 200;
  let selectedLibraryKey = "";
  let editingTimelineEventId = "";
  let draggingSiteId = "";
  let siteEditorDirty = false;
  let siteEditorBaseline = null;
  const nonProfileDirtyScopes = new Set();
  let nonProfileEditorRevision = 0;
  const LIBRARY_STORAGE_KEYS = new Set([
    "urlList",
    "siteAnnotations",
    "submissionRecords",
    "siteProfiles",
    "domainMetricsCache",
    "linkMonitorResults",
    "submissionTimeline",
    "sheetTableData",
  ]);
  const LIBRARY_REFRESH_DEBOUNCE_MS = 80;
  const SETTINGS_PANEL_SESSION_KEY = "externallink.settings.activePanel";
  const SETTINGS_NOTICE_SESSION_KEY = "externallink.settings.reloadNotice";
  const SETTINGS_PANELS = new Set(["sites", "library", "config"]);
  let libraryLoadRequestId = 0;
  let libraryStorageRevision = 0;
  let libraryRefreshTimer = null;
  let libraryRefreshPending = false;
  let libraryInitialSyncPending = true;
  let libraryStorageListenerInstalled = false;
  let settingsToastTimer = null;
  const TIMELINE_TYPES = [
    ["submitted", "已提交"],
    ["pending_moderation", "待审核"],
    ["published", "已上线"],
    ["rejected", "被拒绝"],
    ["needs_follow_up", "需跟进"],
    ["needs_manual", "需人工"],
    ["link_missing", "链接失效"],
    ["note", "仅记录笔记"],
  ];
  const SITE_MARK_STATUSES = [
    ["can_submit", "可提交"],
    ["needs_login", "需登录"],
    ["needs_captcha", "验证码"],
    ["paid", "付费"],
    ["broken", "无法提交"],
    ["skip", "跳过"],
    ["deleted", "删除"],
  ];

  function renderProfileFields(profile) {
    const list = $("profileFieldList");
    if (!list) return;
    list.replaceChildren();
    const fields = profile?.fields || {};
    const notes = profile?.fieldNotes || {};
    const entries = Object.entries(fields);
    if ($("profileFieldCount")) $("profileFieldCount").textContent = `（${entries.length} 项）`;
    for (const [field, value] of entries) {
      const row = document.createElement("div");
      row.className = "profile-field-row";
      const name = document.createElement("div");
      name.className = "profile-field-name";
      name.textContent = field;
      const content = document.createElement("textarea");
      content.className = "profile-field-content";
      content.dataset.profileField = field;
      content.value = value == null ? "" : String(value);
      content.setAttribute("aria-label", `${field} 内容`);
      const note = document.createElement("input");
      note.type = "text";
      note.className = "profile-field-note";
      note.dataset.profileFieldNote = field;
      note.value = notes[field] == null ? "" : String(notes[field]);
      note.placeholder = "Notes（可选）";
      note.setAttribute("aria-label", `${field} 备注`);
      row.append(name, content, note);
      list.append(row);
    }
  }

  function readProfileFieldEditor() {
    const fields = {};
    const fieldNotes = {};
    document.querySelectorAll("[data-profile-field]").forEach((input) => {
      fields[input.dataset.profileField] = input.value;
    });
    document.querySelectorAll("[data-profile-field-note]").forEach((input) => {
      if (input.value.trim()) fieldNotes[input.dataset.profileFieldNote] = input.value.trim();
    });
    return { fields, fieldNotes };
  }

  function setCloudStatus(message, tone = "") {
    const el = $("cloudSyncStatus");
    if (!el) return;
    el.className = `sync-status${tone ? ` ${tone}` : ""}`;
    el.textContent = message;
  }

  function sessionGet(key) {
    try {
      return sessionStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }

  function sessionSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch {
      // The settings page still works when session storage is unavailable.
    }
  }

  function sessionTake(key) {
    const value = sessionGet(key);
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Ignore unavailable session storage.
    }
    return value;
  }

  function showSettingsToast(message, tone = "success") {
    const toast = $("settingsToast");
    if (!toast || !message) return;
    if (settingsToastTimer) clearTimeout(settingsToastTimer);
    toast.className = `settings-toast${tone === "warning" ? " warning" : ""}`;
    toast.textContent = message;
    toast.hidden = false;
    settingsToastTimer = setTimeout(() => {
      toast.hidden = true;
      settingsToastTimer = null;
    }, 8000);
  }

  function queueReloadNotice(message, tone = "success", panel = "library") {
    sessionSet(SETTINGS_NOTICE_SESSION_KEY, JSON.stringify({ message, tone, panel }));
    if (SETTINGS_PANELS.has(panel)) sessionSet(SETTINGS_PANEL_SESSION_KEY, panel);
  }

  function takeReloadNotice() {
    const raw = sessionTake(SETTINGS_NOTICE_SESSION_KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  function cloudConfigFromForm() {
    return {
      endpoint: $("cloudWorkerEndpoint")?.value || "",
      accessToken: $("cloudAccessToken")?.value || "",
      workspaceId: $("cloudWorkspaceId")?.value || "default",
    };
  }

  async function loadCloudSyncStatus() {
    const result = await chrome.runtime.sendMessage({ action: "cloudSyncStatus" });
    if (!result?.ok) throw new Error(result?.error || "读取云端状态失败");
    const config = result.config || {};
    const migrateButton = $("btnCloudMigrate");
    if (migrateButton) {
      const migrated = Boolean(config.migratedAt);
      migrateButton.disabled = migrated;
      migrateButton.textContent = migrated ? "首迁移已完成" : "首次迁移到云端";
      migrateButton.title = migrated ? "状态和媒体首迁移已完成，日常由云端自动保存" : "仅首次安装或灾备恢复时使用";
    }
    if ($("cloudWorkerEndpoint")) $("cloudWorkerEndpoint").value = config.endpoint || "";
    if ($("cloudAccessToken") && config.accessToken) $("cloudAccessToken").value = config.accessToken;
    if ($("cloudWorkspaceId")) $("cloudWorkspaceId").value = config.workspaceId || "default";
    if (!config.configured) {
      setCloudStatus("尚未连接。部署完成后填写 Worker 地址和本设备密钥。", "warning");
      return result;
    }
    if (!result.connected) {
      setCloudStatus(`云端不可用：${result.error || "连接失败"}`, "warning");
      return result;
    }
    const health = result.health || {};
    const parts = ["已连接 Neon + R2", `工作区 ${config.workspaceId || "default"}`, `状态文档 ${health.documentKeys || 0} 类`];
    if (config.migratedAt) parts.push(`首次迁移 ${new Date(config.migratedAt).toLocaleString()}`);
    if (config.lastPushAt) parts.push(`最近保存 ${new Date(config.lastPushAt).toLocaleString()}`);
    setCloudStatus(parts.join(" · "), "success");
    return result;
  }

  function setActivePanel(name, options = {}) {
    if (!SETTINGS_PANELS.has(name)) return;
    document.body.dataset.panel = name;
    document.querySelectorAll(".tab").forEach((tab) => {
      const active = tab.dataset.panel === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `panel-${name}`);
    });
    if (options.persist !== false) sessionSet(SETTINGS_PANEL_SESSION_KEY, name);
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setActivePanel(tab.dataset.panel));
  });

  const startupReloadNotice = takeReloadNotice();
  const startupSessionPanel = startupReloadNotice?.panel || sessionGet(SETTINGS_PANEL_SESSION_KEY);
  if (SETTINGS_PANELS.has(startupSessionPanel)) setActivePanel(startupSessionPanel, { persist: false });
  if (startupReloadNotice?.message) {
    showSettingsToast(startupReloadNotice.message, startupReloadNotice.tone);
  }

  function save(obj) {
    chrome.storage.local.set(obj);
  }

  function canonicalProfileSnapshot(value) {
    if (Array.isArray(value)) return value.map(canonicalProfileSnapshot);
    if (!value || typeof value !== "object") return value;
    return Object.keys(value).sort().reduce((result, key) => {
      if (key !== "updatedAt") result[key] = canonicalProfileSnapshot(value[key]);
      return result;
    }, {});
  }

  function profileHasUnsavedChanges(draft, persisted) {
    return JSON.stringify(canonicalProfileSnapshot(draft)) !== JSON.stringify(canonicalProfileSnapshot(persisted));
  }

  self.ExtLinkSettings = self.ExtLinkSettings || {};
  self.ExtLinkSettings.profileHasUnsavedChanges = profileHasUnsavedChanges;

  function updateLogoPreview(dataUrl) {
    const preview = $("siteLogoPreview");
    if (!preview) return;
    if (dataUrl) {
      preview.src = dataUrl;
      preview.removeAttribute("hidden");
    } else {
      preview.removeAttribute("src");
      preview.setAttribute("hidden", "");
    }
  }

  function profileMediaSources(profile) {
    const fields = profile?.fields || {};
    const media = profile?.media || {};
    const logo =
      media.logo ||
      fields["Cloud LOGO"] ||
      media.featured ||
      profile?.logoUrl ||
      fields.LOGO ||
      fields["Featured image"] ||
      profile?.logoDataUrl ||
      "";
    const cloudScreenshots = [1, 2, 3, 4].map(
      (index) => fields[`Cloud Screenshot ${index}`] || "",
    );
    const legacyScreenshots = [1, 2, 3, 4].map(
      (index) => fields[`Screenshot ${index}`] || fields[`Screenshot-${index}`] || "",
    );
    const screenshots =
      cloudScreenshots.some(Boolean)
        ? cloudScreenshots
        : Array.isArray(media.screenshots) && media.screenshots.length
          ? media.screenshots
          : legacyScreenshots;
    return [
      { label: "Logo", source: logo, kind: "logo" },
      ...screenshots.slice(0, 4).map((source, index) => ({
        label: `截图 ${index + 1}`,
        source,
        kind: "screenshot",
      })),
    ].filter((item) => {
      const source = typeof item.source === "object" ? item.source?.ref || item.source?.url : item.source;
      return String(source || "").trim();
    });
  }

  async function renderProfileMedia(profile) {
    const gallery = $("siteMediaGallery");
    if (!gallery) return;
    const token = ++mediaPreviewToken;
    gallery.replaceChildren();
    const sources = profileMediaSources(profile);
    if (!sources.length) {
      const empty = document.createElement("div");
      empty.className = "media-gallery-empty";
      empty.textContent = "当前网站暂无 Logo 或截图";
      gallery.append(empty);
      return;
    }
    const entries = sources.map((item) => {
      const figure = document.createElement("figure");
      figure.className = `media-gallery-item ${item.kind}`;
      const image = document.createElement("img");
      image.alt = item.label;
      image.loading = "lazy";
      const caption = document.createElement("figcaption");
      caption.textContent = item.label;
      figure.append(image, caption);
      gallery.append(figure);
      return { item, figure, image };
    });
    await Promise.all(
      entries.map(async ({ item, figure, image }) => {
        if (token !== mediaPreviewToken) return;
        const rawSource = typeof item.source === "object" ? item.source?.ref || item.source?.url : item.source;
        const source = String(rawSource || "").trim();
        figure.classList.add("is-loading");
        try {
          let dataUrl = source;
          if (/^cloud-media:\/\//i.test(source)) {
            const result = await chrome.runtime.sendMessage({
              action: "fetchCloudSubmissionMedia",
              ref: source,
              name: item.label,
            });
            if (!result?.ok || !result.dataUrl) throw new Error(result?.error || "无法读取云端媒体");
            dataUrl = result.dataUrl;
          }
          if (token !== mediaPreviewToken) return;
          image.src = dataUrl;
          image.addEventListener("error", () => {
            figure.classList.remove("is-loading");
            figure.classList.add("is-error");
            image.alt = `${item.label}不可用`;
          }, { once: true });
          figure.classList.remove("is-loading");
        } catch {
          if (token !== mediaPreviewToken) return;
          figure.classList.remove("is-loading");
          figure.classList.add("is-error");
          image.alt = `${item.label}不可用`;
        }
      }),
    );
  }

  function profileToForm(profile) {
    pendingLogoDataUrl = profile.logoDataUrl || null;
    const f = profile.fields || {};
    $("siteExtractUrl").value = profile.url || f.Url || "";
    $("siteLanguage").value = profile.language || "auto";
    $("siteName").value = profile.name || f.Name || "";
    $("siteHomeUrl").value = profile.url || f.Url || "";
    $("sitePromoUrl").value = profile.promoUrl || profile.url || f.Url || "";
    $("siteTitle").value = f.Title || "";
    $("siteEmail").value = f["Business mail"] || "";
    $("siteLogoUrl").value = profile.logoUrl || f.LOGO || f["Featured image"] || "";
    $("siteScreenshots").value = P.listToLines(
      profile.media?.screenshots || [
        f["Screenshot 1"] || f["Screenshot-1"],
        f["Screenshot 2"] || f["Screenshot-2"],
        f["Screenshot 3"] || f["Screenshot-3"],
        f["Screenshot 4"] || f["Screenshot-4"],
      ],
    );
    updateLogoPreview(pendingLogoDataUrl);
    renderProfileMedia(profile);
    if ($("siteLogoFile")) $("siteLogoFile").value = "";
    $("siteShortDesc").value = f["Short description(20-30 words)"] || "";
    $("siteMediumDesc").value = f["Short Discription(100-150 words)"] || "";
    $("siteLongDesc").value = f["Long description (250-500 words)"] || "";
    $("siteNote").value = f.Note || "";
    $("siteAudience").value = profile.targetAudience || "";
    $("siteValueProp").value = profile.valueProposition || "";
    $("siteUseCases").value = P.listToLines(profile.useCases);
    $("siteTags").value = f["Tags Keywords/Hashtags"] || "";
    $("siteFeatures").value = f["Feature description"] || "";
    $("siteSellPoints").value = P.listToLines(profile.sellablePoints);
    $("sitePricing").value = f.Pricing || "";
    $("sitePricingType").value = f["PRICING TYPE"] || "";
    $("siteAvoidContent").value = P.listToLines(profile.avoidContent);
    const anchor = profile.anchorRules || {};
    $("siteBrandKeywords").value = P.listToLines(anchor.brandKeywords);
    $("siteUrlKeywords").value = P.listToLines(anchor.urlKeywords);
    $("siteNaturalExprs").value = P.listToLines(anchor.naturalExpressions);
    $("siteKeywordExprs").value = P.listToLines(anchor.keywordExpressions);
    $("siteAvoidWords").value = P.listToLines(anchor.avoidWords);
    $("siteAllowExactAnchor").checked = !!anchor.allowExactMatch;
    const blog = profile.blogRules || {};
    $("siteBlogTone").value = blog.tone || "helpful";
    $("siteMaxLinks").value = String(blog.maxLinksPerDraft || 1);
    $("sitePreferredAnchor").value = blog.preferredAnchor || "natural";
    renderProfileFields(profile);
  }

  function formToProfile(existingId) {
    const name = ($("siteName").value || "").trim();
    const homeUrl = ($("siteHomeUrl").value || "").trim();
    const promoUrl = ($("sitePromoUrl").value || homeUrl).trim();
    const id = existingId || P.slugifySiteId(name || homeUrl || "site");

    const logoUrl = ($("siteLogoUrl").value || "").trim();
    const existing = existingId && siteProfiles[existingId] ? siteProfiles[existingId] : {};
    const logoDataUrl =
      pendingLogoDataUrl !== null ? pendingLogoDataUrl : existing.logoDataUrl || "";

    const rawEditor = readProfileFieldEditor();
    const fields = {
      ...(existing.fields || {}),
      ...rawEditor.fields,
      Name: name,
      Url: homeUrl,
      Title: ($("siteTitle").value || "").trim(),
      "Business mail": ($("siteEmail").value || "").trim(),
      LOGO: logoUrl || (logoDataUrl ? "(uploaded logo)" : ""),
      "Featured image":
        existing.fields?.["Featured image"] || logoUrl || (logoDataUrl ? "(uploaded logo)" : ""),
      Note: ($("siteNote").value || "").trim(),
      "Short description(20-30 words)": ($("siteShortDesc").value || "").trim(),
      "Short Discription(100-150 words)": ($("siteMediumDesc").value || "").trim(),
      "Long description (250-500 words)": ($("siteLongDesc").value || "").trim(),
      "Tags Keywords/Hashtags": ($("siteTags").value || "").trim(),
      "Feature description": ($("siteFeatures").value || "").trim(),
      Pricing: ($("sitePricing").value || "").trim(),
      "PRICING TYPE": ($("sitePricingType").value || "").trim(),
    };
    const screenshots = P.linesToList($("siteScreenshots").value).slice(0, 4);
    screenshots.forEach((url, index) => {
      fields[`Screenshot ${index + 1}`] = url;
      fields[`Screenshot-${index + 1}`] = url;
    });

    return {
      id,
      name: name || id,
      url: homeUrl,
      promoUrl,
      logoUrl,
      logoDataUrl: logoDataUrl || "",
      media: { screenshots },
      language: $("siteLanguage").value || "auto",
      fields,
      fieldNotes: {
        ...(existing.fieldNotes || {}),
        ...rawEditor.fieldNotes,
      },
      anchorRules: {
        brandKeywords: P.linesToList($("siteBrandKeywords").value),
        urlKeywords: P.linesToList($("siteUrlKeywords").value),
        naturalExpressions: P.linesToList($("siteNaturalExprs").value),
        keywordExpressions: P.linesToList($("siteKeywordExprs").value),
        avoidWords: P.linesToList($("siteAvoidWords").value),
        allowExactMatch: $("siteAllowExactAnchor").checked,
      },
      blogRules: {
        tone: $("siteBlogTone").value || "helpful",
        maxLinksPerDraft: parseInt($("siteMaxLinks").value, 10) || 1,
        preferredAnchor: $("sitePreferredAnchor").value || "natural",
      },
      targetAudience: ($("siteAudience").value || "").trim(),
      valueProposition: ($("siteValueProp").value || "").trim(),
      useCases: P.linesToList($("siteUseCases").value),
      sellablePoints: P.linesToList($("siteSellPoints").value),
      avoidContent: P.linesToList($("siteAvoidContent").value),
      sortIndex: Number.isFinite(Number(existing.sortIndex)) ? Number(existing.sortIndex) : P.nextProfileSortIndex(siteProfiles),
      updatedAt: new Date().toISOString(),
    };
  }

  function hasUnsavedSiteEdits() {
    if (siteEditorDirty) return true;
    if (!siteEditorBaseline) return false;
    try {
      return profileHasUnsavedChanges(
        formToProfile(activeSiteId || undefined),
        siteEditorBaseline,
      );
    } catch {
      return false;
    }
  }

  function hasUnsavedSettingsEdits() {
    return hasUnsavedSiteEdits() || nonProfileDirtyScopes.size > 0;
  }

  function nonProfileScopeForTarget(target) {
    const id = String(target?.id || "");
    if (
      id === "cfgEmail" ||
      id === "cfgName" ||
      id === "cfgCommentTemplate" ||
      id === "cfgConcurrency" ||
      id === "cfgPingIndex" ||
      id === "autoFillOnVisit" ||
      id === "autoSubmitDirectoryListings" ||
      id === "autoSubmitStandardWpComments"
    ) return "config";
    if (
      id === "filterBlacklistEnabled" ||
      id === "filterMinDomainAge" ||
      id === "filterRequireKnownAge" ||
      id === "filterMinOpportunityScore" ||
      id === "domainBlacklistText"
    ) return "target-gate";
    if (
      id === "filterAiComments" ||
      id === "filterAiCommentAllowLink" ||
      id === "filterManualFillIcons"
    ) return "assistant";
    if (id === "linkMonitorEnabled" || id === "linkMonitorMinutes") return "link-monitor";
    if (target?.closest?.("#libraryTimelinePane")) return "timeline";
    if (target?.closest?.(".library-ops")) {
      if (id === "cloudWorkerEndpoint" || id === "cloudAccessToken" || id === "cloudWorkspaceId") {
        return "cloud-config";
      }
    }
    return "";
  }

  function markNonProfileEditorDirty(target) {
    const scope = nonProfileScopeForTarget(target);
    if (!scope) return;
    nonProfileDirtyScopes.add(scope);
    nonProfileEditorRevision += 1;
  }

  function clearNonProfileEditorDirty(scope, revision = null) {
    if (revision !== null && revision !== nonProfileEditorRevision) return;
    if (scope) nonProfileDirtyScopes.delete(scope);
  }

  function adoptPulledSiteProfiles(state, preserveDraft = false) {
    if (!state || !Object.prototype.hasOwnProperty.call(state, "siteProfiles")) return;
    if (!state.siteProfiles || typeof state.siteProfiles !== "object" || Array.isArray(state.siteProfiles)) return;
    siteProfiles = state.siteProfiles;
    if (!preserveDraft) {
      renderSiteSelector();
      if (activeSiteId && siteProfiles[activeSiteId]) {
        profileToForm(siteProfiles[activeSiteId]);
      }
      captureSiteEditorBaseline();
    }
  }

  function captureSiteEditorBaseline() {
    try {
      siteEditorBaseline = canonicalProfileSnapshot(formToProfile(activeSiteId || undefined));
    } catch {
      siteEditorBaseline = null;
    }
  }

  function orderedSiteIds() {
    return P.orderedProfileIds(siteProfiles);
  }

  function renderSiteSelector() {
    const list = $("siteNavList");
    if (!list) return;
    const ids = orderedSiteIds();
    list.replaceChildren();
    if (!ids.length) {
      const empty = document.createElement("li");
      empty.className = "empty-state";
      empty.textContent = "还没有站点。点击右上角添加。";
      list.append(empty);
      return;
    }
    if (!activeSiteId || !siteProfiles[activeSiteId]) activeSiteId = ids[0] || "";
    for (const id of ids) {
      const profile = siteProfiles[id] || {};
      const item = document.createElement("li");
      item.className = `site-nav-item${id === activeSiteId ? " is-active" : ""}${id === draggingSiteId ? " is-dragging" : ""}`;
      item.dataset.siteId = id;
      item.draggable = true;
      item.setAttribute("role", "button");
      item.tabIndex = 0;
      item.setAttribute("aria-current", id === activeSiteId ? "true" : "false");
      const handle = document.createElement("span");
      handle.className = "site-nav-handle";
      handle.textContent = "⋮⋮";
      handle.title = "拖动排序";
      item.addEventListener("dragstart", (event) => {
        draggingSiteId = id;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", id);
        item.classList.add("is-dragging");
      });
      item.addEventListener("dragend", () => {
        draggingSiteId = "";
        renderSiteSelector();
      });
      const copy = document.createElement("div");
      copy.className = "site-nav-copy";
      const name = document.createElement("div");
      name.className = "site-nav-name";
      name.textContent = profile.name || id;
      const url = document.createElement("div");
      url.className = "site-nav-url";
      url.textContent = profile.url || profile.promoUrl || "尚未填写地址";
      copy.append(name, url);
      item.append(handle, copy);
      item.addEventListener("click", () => selectSite(id));
      item.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectSite(id);
        }
      });
      item.addEventListener("dragover", (event) => {
        if (!draggingSiteId || draggingSiteId === id) return;
        event.preventDefault();
      });
      item.addEventListener("drop", (event) => {
        event.preventDefault();
        const sourceId = event.dataTransfer.getData("text/plain") || draggingSiteId;
        if (!sourceId || sourceId === id) return;
        reorderSites(sourceId, id);
      });
      list.append(item);
    }
  }

  function selectSite(id) {
    if (!id || !siteProfiles[id] || id === activeSiteId) return;
    if (hasUnsavedSiteEdits()) {
      alert("当前站点资料有未保存修改，请先保存后再切换站点。");
      return;
    }
    activeSiteId = id;
    loadActiveToForm();
    persistProfiles();
    renderSiteSelector();
  }

  function reorderSites(sourceId, targetId) {
    const ids = orderedSiteIds();
    const from = ids.indexOf(sourceId);
    const to = ids.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    ids.splice(from, 1);
    ids.splice(to, 0, sourceId);
    siteProfiles = P.applyProfileOrder(siteProfiles, ids);
    draggingSiteId = "";
    persistProfiles();
    captureSiteEditorBaseline();
    renderSiteSelector();
  }

  function persistProfiles() {
    save({ siteProfiles, activeSiteId });
  }

  function loadActiveToForm() {
    siteEditorDirty = false;
    if (!activeSiteId || !siteProfiles[activeSiteId]) {
      pendingLogoDataUrl = null;
      profileToForm(P.emptySiteProfile("new"));
      captureSiteEditorBaseline();
      return;
    }
    profileToForm(siteProfiles[activeSiteId]);
    captureSiteEditorBaseline();
  }

  $("siteLogoFile")?.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert("图片请小于 2MB");
      e.target.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      pendingLogoDataUrl = reader.result;
      updateLogoPreview(pendingLogoDataUrl);
    };
    reader.onerror = () => alert("读取图片失败");
    reader.readAsDataURL(file);
  });

  $("btnClearLogo")?.addEventListener("click", () => {
    pendingLogoDataUrl = "";
    updateLogoPreview("");
    if ($("siteLogoFile")) $("siteLogoFile").value = "";
    siteEditorDirty = true;
  });

  $("btnAddSite")?.addEventListener("click", () => {
    if (hasUnsavedSiteEdits()) {
      alert("当前站点资料有未保存修改，请先保存后再添加站点。");
      return;
    }
    const id = "site-" + Date.now().toString(36);
    siteProfiles[id] = {
      ...P.emptySiteProfile(id, "新站点"),
      sortIndex: P.nextProfileSortIndex(siteProfiles),
    };
    activeSiteId = id;
    renderSiteSelector();
    loadActiveToForm();
    persistProfiles();
  });

  $("btnRemoveSite")?.addEventListener("click", () => {
    if (!activeSiteId || !siteProfiles[activeSiteId]) return;
    if (hasUnsavedSiteEdits()) {
      alert("当前站点资料有未保存修改，请先保存后再删除站点。");
      return;
    }
    if (!confirm(`删除「${siteProfiles[activeSiteId].name || activeSiteId}」？此操作会从云端资料里移除该站点。`)) return;
    delete siteProfiles[activeSiteId];
    siteProfiles = P.applyProfileOrder(siteProfiles, orderedSiteIds());
    activeSiteId = orderedSiteIds()[0] || "";
    renderSiteSelector();
    loadActiveToForm();
    persistProfiles();
  });

  $("btnSaveSite")?.addEventListener("click", () => {
    const profile = formToProfile(activeSiteId || undefined);
    if (!profile.name && !profile.url) {
      alert("请至少填写站点名称或首页地址");
      return;
    }
    activeSiteId = profile.id;
    siteProfiles[profile.id] = profile;
    pendingLogoDataUrl = profile.logoDataUrl || null;
    renderSiteSelector();
    persistProfiles();
    siteEditorDirty = false;
    captureSiteEditorBaseline();
    renderProfileMedia(profile);
    alert("✅ 站点资料已保存");
  });

  $("btnExtractSite")?.addEventListener("click", async () => {
    const url = ($("siteExtractUrl").value || $("siteHomeUrl").value || "").trim();
    if (!url) {
      alert("请先输入网站地址");
      return;
    }
    const btn = $("btnExtractSite");
    btn.disabled = true;
    btn.textContent = "提取中…（可切换标签页，不会中断）";
    try {
      const data = await chrome.runtime.sendMessage({
        action: "cloudAiExtractSite",
        payload: { url, language: $("siteLanguage").value || "auto" },
      });
      if (!data?.ok) throw new Error(data?.error || "云端资料提取失败");
      const current =
        activeSiteId && siteProfiles[activeSiteId]
          ? siteProfiles[activeSiteId]
          : P.emptySiteProfile(activeSiteId || P.slugifySiteId(url), "");
      const merged = P.mergeExtractedProfile(current, data.profile || {});
      profileToForm(merged);
      siteEditorDirty = true;
    } catch (err) {
      alert(`提取失败: ${err.message}\n\n请确认云端数据中心已连接。`);
    } finally {
      btn.disabled = false;
      btn.textContent = "🔍 从网址提取资料";
    }
  });

  $("btnGenerateSite")?.addEventListener("click", async () => {
    const btn = $("btnGenerateSite");
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      const partial = formToProfile(activeSiteId || undefined);
      const data = await chrome.runtime.sendMessage({
        action: "cloudAiGenerateSite",
        payload: { profile: partial, language: $("siteLanguage").value || "auto" },
      });
      if (!data?.ok) throw new Error(data?.error || "云端资料完善失败");
      profileToForm(P.mergeExtractedProfile(partial, data.profile || {}));
      siteEditorDirty = true;
    } catch (err) {
      alert(`生成失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ 完善当前资料";
    }
  });

  $("btnSaveConfig")?.addEventListener("click", () => {
    const editorRevision = nonProfileEditorRevision;
    save({
      cfgEmail: $("cfgEmail").value,
      cfgName: $("cfgName").value,
      cfgCommentTemplate: $("cfgCommentTemplate").value,
      cfgConcurrency: $("cfgConcurrency").value,
      cfgPingIndex: $("cfgPingIndex").checked,
      autoFillOnVisit: $("autoFillOnVisit").checked,
      autoSubmitDirectoryListings: $("autoSubmitDirectoryListings")?.checked !== false,
      autoSubmitStandardWpComments: $("autoSubmitStandardWpComments")?.checked === true,
    });
    clearNonProfileEditorDirty("config", editorRevision);
    alert("✅ 全局配置已保存");
  });

  function annotationLabel(status) {
    return (
      {
        can_submit: "可提交",
        needs_manual: "需人工",
        needs_login: "需登录",
        needs_captcha: "验证码",
        paid: "付费",
        broken: "无法提交",
        skip: "跳过",
        deleted: "已删除",
      }[status] || "未分类"
    );
  }

  function annotationTone(status) {
    return new Set([
      "can_submit",
      "needs_manual",
      "needs_login",
      "needs_captcha",
      "paid",
      "broken",
      "skip",
      "deleted",
    ]).has(status)
      ? status
      : "neutral";
  }

  function annotationStatuses(annotation) {
    return Q.normalizeAnnotationStatuses(annotation);
  }

  function activityLabel(type) {
    return (
      {
        submitted: "已提交",
        pending_moderation: "待审核",
        published: "已上线",
        rejected: "被拒绝",
        needs_follow_up: "需跟进",
        needs_manual: "需人工",
        link_missing: "链接失效",
        note: "笔记",
        legacy_import: "历史导入",
        link_submit: "表格历史记录",
        status: "状态更新",
      }[type] || type || "暂无动态"
    );
  }

  function formatActivityTime(value) {
    if (!value) return "暂无记录";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function toDatetimeLocalValue(date = new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function latestActivityText(item) {
    const event = item?.latestEvent;
    if (!event) return "暂无记录";
    const note = String(event.note || "").replace(/\s+/g, " ").trim();
    if (note) return note;
    const label = activityLabel(event.type || event.status);
    const profile = event.profileName || event.profileId || "";
    return profile && profile !== "外链站" ? `${label} · ${profile}` : label;
  }

  function createActivityFact(label, value, wide = false) {
    const fact = document.createElement("div");
    fact.className = `activity-fact${wide ? " wide" : ""}`;
    const caption = document.createElement("span");
    caption.className = "activity-fact-label";
    caption.textContent = label;
    const content = document.createElement("span");
    content.className = "activity-fact-value";
    content.textContent = value || "—";
    content.title = value || "";
    fact.append(caption, content);
    return fact;
  }

  const ICON_PATHS = {
    pin: "M16 12V4h1V2H7v2h1v8l-2 2v2h5.2V22h1.6v-6H18v-2l-2-2z",
    edit: "M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z",
    remove: "M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  };

  function createIconButton(kind, label, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `icon-btn${danger ? " icon-btn-danger" : ""}`;
    button.title = label;
    button.setAttribute("aria-label", label);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", ICON_PATHS[kind]);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    button.append(svg);
    return button;
  }

  function progressLabel(progress) {
    return (
      {
        unsubmitted: "未提交",
        action_recorded: "表格有提交动作 · 未核验",
        awaiting_index: "已提交 · 待确认收录",
        pending_moderation: "待审核",
        needs_follow_up: "待跟进",
        published: "已收录 / 已上线",
        rejected: "被拒绝",
        link_missing: "疑似丢链",
      }[progress?.current] || "暂无进度"
    );
  }

  function createKeyDetail(label, value, wide = false) {
    const row = document.createElement("div");
    row.className = `library-key-detail${wide ? " wide" : ""}`;
    const caption = document.createElement("span");
    caption.className = "library-key-detail-label";
    caption.textContent = label;
    const content = document.createElement("span");
    content.className = "library-key-detail-value";
    content.textContent = value || "—";
    row.append(caption, content);
    return row;
  }

  function timelinePayload(item, form) {
    return {
      destinationKey: item.key,
      destinationUrl: item.url,
      profileId: form.profile.value,
      profileName:
        form.profile.value === "__destination__"
          ? "外链站"
          : siteProfiles[form.profile.value]?.name || form.profile.value,
      type: form.type.value,
      occurredAt: form.occurredAt.value ? new Date(form.occurredAt.value).toISOString() : new Date().toISOString(),
      note: form.note.value.trim(),
      publicUrl: form.type.value === "published" ? form.url.value.trim() : "",
      evidenceUrl: form.type.value === "published" ? "" : form.url.value.trim(),
      source: "manual",
    };
  }

  function fillTimelineForm(form, event = null) {
    form.profile.value = event?.profileId || "__destination__";
    if (event?.profileId && !Array.from(form.profile.options).some((option) => option.value === event.profileId)) {
      const option = document.createElement("option");
      option.value = event.profileId;
      option.textContent = event.profileName || event.profileId;
      form.profile.append(option);
      form.profile.value = event.profileId;
    }
    if (event?.type && !Array.from(form.type.options).some((option) => option.value === event.type)) {
      const option = document.createElement("option");
      option.value = event.type;
      option.textContent = activityLabel(event.type);
      form.type.append(option);
    }
    form.type.value = event?.type || "submitted";
    const occurred = event?.occurredAt ? new Date(event.occurredAt) : new Date();
    form.occurredAt.value = Number.isNaN(occurred.getTime()) ? toDatetimeLocalValue() : toDatetimeLocalValue(occurred);
    form.url.value = event?.publicUrl || event?.evidenceUrl || "";
    form.note.value = event?.note || "";
    form.submit.textContent = event ? "保存修改" : "添加动态";
    form.cancel.hidden = !event;
  }

  function createTimelineForm(item) {
    const form = document.createElement("form");
    form.className = "timeline-form";
    const profile = document.createElement("select");
    profile.setAttribute("aria-label", "网站项目");
    const destinationOption = document.createElement("option");
    destinationOption.value = "__destination__";
    destinationOption.textContent = "外链站通用动态";
    profile.append(destinationOption);
    for (const id of orderedSiteIds()) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = siteProfiles[id]?.name || id;
      profile.append(option);
    }
    const type = document.createElement("select");
    type.setAttribute("aria-label", "动态状态");
    for (const [value, label] of TIMELINE_TYPES) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      type.append(option);
    }
    const occurredAt = document.createElement("input");
    occurredAt.type = "datetime-local";
    occurredAt.setAttribute("aria-label", "发生时间");
    const url = document.createElement("input");
    url.type = "url";
    url.placeholder = "公开页或证据链接（可选）";
    url.setAttribute("aria-label", "公开页或证据链接");
    const note = document.createElement("textarea");
    note.placeholder = "发生了什么、需要何时跟进、审核提示等";
    note.setAttribute("aria-label", "动态笔记");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "btn btn-primary";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-secondary";
    cancel.textContent = "取消编辑";
    cancel.hidden = true;
    const fields = { profile, type, occurredAt, url, note, submit, cancel };
    fillTimelineForm(fields);
    cancel.addEventListener("click", () => {
      editingTimelineEventId = "";
      fillTimelineForm(fields);
      clearNonProfileEditorDirty("timeline");
    });
    form.append(profile, type, occurredAt, url, note, submit, cancel);
    form.timelineFields = fields;
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      const editorRevision = nonProfileEditorRevision;
      const editing = Boolean(editingTimelineEventId);
      submit.textContent = editing ? "保存中…" : "保存中…";
      try {
        const payload = timelinePayload(item, fields);
        const result = await chrome.runtime.sendMessage(
          editing
            ? { action: "updateSubmissionTimelineEvent", eventId: editingTimelineEventId, ...payload }
            : { action: "addSubmissionTimelineEvent", ...payload },
        );
        if (!result?.ok) throw new Error(result?.error || (editing ? "保存动态失败" : "添加动态失败"));
        if (editorRevision === nonProfileEditorRevision) editingTimelineEventId = "";
        clearNonProfileEditorDirty("timeline", editorRevision);
        await loadLibrary();
      } catch (err) {
        alert(err.message);
        submit.textContent = editingTimelineEventId ? "保存修改" : "添加动态";
      } finally {
        submit.disabled = false;
        submit.textContent = editingTimelineEventId ? "保存修改" : "添加动态";
      }
    });
    return form;
  }

  async function markLibrarySite(item, status) {
    const currentStatuses = annotationStatuses(item.annotation);
    const selected = currentStatuses.includes(status);
    if (!selected && status === "deleted" && !confirm(`确认从外链列表删除 ${item.domain || item.url}？删除后不会再自动填表。`)) {
      return;
    }
    const result = await chrome.runtime.sendMessage({
      action: "markSubmissionSite",
      url: item.url,
      status,
      toggle: true,
    });
    if (!result?.ok) throw new Error(result?.error || "标记失败");
    if (!selected && status === "deleted" && selectedLibraryKey === item.key) selectedLibraryKey = "";
    await loadLibrary();
  }

  function createLibraryMarkPanel(item) {
    const wrap = document.createElement("section");
    wrap.className = "library-mark-panel";
    const title = document.createElement("div");
    title.className = "library-mark-title";
    title.textContent = "站点标记";
    const scope = document.createElement("p");
    scope.className = "library-mark-scope";
    scope.textContent = "按外链站保存，与自家网站 Profile 无关；切换 A/B 后仍保留。可同时选择多个标记，重复点击可取消单个标记。";
    const btns = document.createElement("div");
    btns.className = "library-mark-btns";
    const current = annotationStatuses(item.annotation);
    for (const [status, label] of SITE_MARK_STATUSES) {
      const btn = document.createElement("button");
      btn.type = "button";
      const selected = current.includes(status);
      btn.className = `library-mark-btn${status === "deleted" ? " mark-danger" : ""}${selected ? " active" : ""}`;
      btn.textContent = label;
      btn.setAttribute("aria-pressed", String(selected));
      btn.addEventListener("click", async (event) => {
        event.stopPropagation();
        btn.disabled = true;
        try {
          await markLibrarySite(item, status);
        } catch (err) {
          alert(err.message);
          btn.disabled = false;
        }
      });
      btns.append(btn);
    }
    wrap.append(title, scope, btns);
    return wrap;
  }

  function renderTimelinePanel(item, panel) {
    panel.replaceChildren();
    panel.append(createLibraryMarkPanel(item));
    const events = Array.isArray(item.events) ? item.events : [];
    const list = document.createElement("div");
    list.className = "timeline-list";
    if (!events.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "还没有动态记录，可以在下面添加第一次提交或跟进笔记。";
      list.append(empty);
    } else {
      for (const event of events) {
        const row = document.createElement("div");
        row.className = "timeline-event";
        const head = document.createElement("div");
        head.className = "timeline-event-head";
        const profileName = event.profileName || event.profileId || "外链站";
        const title = document.createElement("span");
        title.className = "timeline-event-title";
        title.textContent = `${formatActivityTime(event.occurredAt)} · ${profileName} · ${activityLabel(event.type || event.status)}`;
        const actions = document.createElement("div");
        actions.className = "timeline-event-actions";
        const edit = createIconButton("edit", `编辑 ${activityLabel(event.type || event.status)} 动态`);
        const remove = createIconButton("remove", `删除 ${activityLabel(event.type || event.status)} 动态`, true);
        edit.addEventListener("click", (clickEvent) => {
          clickEvent.stopPropagation();
          editingTimelineEventId = event.id || "";
          renderSelectedLibraryTimeline();
        });
        remove.addEventListener("click", async (clickEvent) => {
          clickEvent.stopPropagation();
          if (!event.id) return;
          if (!confirm("删除这条时间线动态？已核验的提交账本不会被撤销。")) return;
          const result = await chrome.runtime.sendMessage({
            action: "removeSubmissionTimelineEvent",
            eventId: event.id,
          });
          if (!result?.ok) return alert(result?.error || "删除动态失败");
          if (editingTimelineEventId === event.id) editingTimelineEventId = "";
          await loadLibrary();
        });
        actions.append(edit, remove);
        head.append(title, actions);
        row.append(head);
        if (event.note) {
          const note = document.createElement("div");
          note.className = "timeline-event-note";
          note.textContent = event.note;
          row.append(note);
        }
        const linkValue = event.publicUrl || event.evidenceUrl || "";
        if (/^https?:\/\//i.test(linkValue)) {
          const link = document.createElement("a");
          link.href = linkValue;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.textContent = "查看公开页 / 证据";
          link.className = "timeline-event-note";
          row.append(link);
        }
        list.append(row);
      }
    }
    const form = createTimelineForm(item);
    const editingEvent = events.find((event) => event.id === editingTimelineEventId) || null;
    if (editingEvent) fillTimelineForm(form.timelineFields, editingEvent);
    panel.append(list, form);
  }

  function captureTimelineEditorDraft() {
    const pane = $("libraryTimelinePane");
    const form = pane?.querySelector?.("form.timeline-form");
    if (!form || (!nonProfileDirtyScopes.has("timeline") && !editingTimelineEventId)) return null;
    return {
      form,
      focusedField: form.contains(document.activeElement) ? document.activeElement : null,
      selectedLibraryKey,
    };
  }

  function restoreTimelineEditorDraft(draft) {
    if (!draft || draft.selectedLibraryKey !== selectedLibraryKey) return;
    const pane = $("libraryTimelinePane");
    if (!pane) return;
    const form = pane.querySelector("form.timeline-form");
    // Keep the original editor and its handlers, including an in-flight save.
    if (form) form.replaceWith(draft.form);
    else pane.append(draft.form);
    draft.focusedField?.focus({ preventScroll: true });
  }

  function renderSelectedLibraryTimeline() {
    const pane = $("libraryTimelinePane");
    if (!pane) return;
    const item = libraryItems.find((entry) => entry.key === selectedLibraryKey);
    if (!item) {
      pane.replaceChildren();
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = selectedLibraryKey ? "这条外链已不在当前列表中，请重新选择。" : "先在左侧选择一个外链站。";
      pane.append(empty);
      return;
    }
    renderTimelinePanel(item, pane);
  }

  function renderLibrary() {
    const el = $("libraryList");
    if (!el) return;
    const query = ($("librarySearch")?.value || "").trim().toLowerCase();
    const categoryFilter = $("libraryCategoryFilter")?.value || "";
    const statusFilter = $("libraryStatusFilter")?.value || "";
    const progressFilter = $("libraryProgressFilter")?.value || "";
    const qualityFilter = Number($("libraryQualityFilter")?.value || 0);
    const sortMode = $("librarySort")?.value || "quality";
    const filtered = libraryItems.filter((item) => {
      const statuses = annotationStatuses(item.annotation);
      const progress = Timeline.deriveLibraryProgress(item);
      const haystack = [
        item.domain,
        item.url,
        item.name,
        item.category,
        item.language,
        item.accessModel,
        ...(item.tags || []),
        ...statuses,
        ...statuses.map((value) => annotationLabel(value)),
        item.note,
        item.record,
        item.detail,
        ...(item.events || []).map((event) => `${event.profileName || event.profileId || ""} ${event.note || ""} ${event.type || ""}`),
        ...(item.profileStatuses || []).map((profile) => profile.profileName),
      ]
        .join(" ")
        .toLowerCase();
      return (
        (!query || haystack.includes(query)) &&
        (!categoryFilter || item.category === categoryFilter) &&
        (!statusFilter || statuses.includes(statusFilter)) &&
        Timeline.matchesLibraryProgress(progress, progressFilter) &&
        Number(item.quality?.score || 0) >= qualityFilter
      );
    });
    filtered.sort((a, b) => {
      if (sortMode === "domain") return String(a.domain || "").localeCompare(String(b.domain || ""));
      if (sortMode === "position") return Number(a.position || 0) - Number(b.position || 0);
      return Number(b.quality?.score || 0) - Number(a.quality?.score || 0);
    });
    el.replaceChildren();
    const shown = filtered.slice(0, libraryVisibleLimit);
    if ($("libraryCount")) {
      const cloudRows = Number(libraryStats.cloudRows) || 0;
      const customOnly = Number(libraryStats.customOnly) || 0;
      const totalLabel = cloudRows
        ? `云端 ${cloudRows} 行 · ${libraryItems.length} 个目标${customOnly ? `（含 ${customOnly} 条自定义补充）` : ""}`
        : `共 ${libraryItems.length} 条`;
      $("libraryCount").textContent = filtered.length
        ? `${totalLabel} · 筛选后 ${filtered.length} 条 · 已展示 ${shown.length} 条`
        : `${totalLabel} · 没有符合筛选的外链站`;
    }
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "没有符合筛选条件的外链站。调整筛选后重试。";
      el.append(empty);
      if ($("btnLibraryLoadMore")) $("btnLibraryLoadMore").hidden = true;
      renderSelectedLibraryTimeline();
      return;
    }
    for (const item of shown) {
      const progress = Timeline.deriveLibraryProgress(item);
      const card = document.createElement("article");
      card.className = "library-item";
      const head = document.createElement("div");
      head.className = "library-item-head";
      const title = document.createElement("strong");
      title.textContent = item.domain || item.url;
      title.title = item.url;
      const category = document.createElement("div");
      category.className = "library-statuses";
      const markerStatuses = annotationStatuses(item.annotation);
      const visibleStatuses = markerStatuses.length ? markerStatuses : [""];
      for (const status of visibleStatuses) {
        const chip = document.createElement("span");
        chip.className = `library-status ${annotationTone(status)}`;
        chip.textContent = annotationLabel(status);
        chip.setAttribute("aria-label", `站点状态：${annotationLabel(status)}`);
        category.append(chip);
      }
      const pin = createIconButton("pin", `置顶 ${item.domain || item.url}`);
      pin.addEventListener("click", async (event) => {
        event.stopPropagation();
        const result = await chrome.runtime.sendMessage({ action: "pinLibraryUrl", url: item.url });
        if (!result?.ok) return alert(result?.error || "置顶失败");
        await loadLibrary();
      });
      const remove = createIconButton("remove", `删除 ${item.domain || item.url}`, true);
      remove.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm(`确认从队列删除 ${item.domain || item.url}？`)) return;
        const result = await chrome.runtime.sendMessage({
          action: "removeFromSubmissionQueue",
          url: item.url,
        });
        if (!result?.ok) return alert(result?.error || "删除失败");
        if (selectedLibraryKey === item.key) selectedLibraryKey = "";
        await loadLibrary();
      });
      const actions = document.createElement("div");
      actions.className = "library-item-actions";
      actions.append(pin, remove);
      head.append(title, category, actions);

      const meta = document.createElement("div");
      meta.className = "library-meta";
      const sourceLabel = { saved: "自定义", table: "迁移库", library: "内置" }[item.source] || "内置";
      const accessLabel = { free: "免费", freemium: "免费增值", paid: "付费", unknown: "费用待核验" }[item.accessModel] || "费用待核验";
      meta.textContent = `${sourceLabel} · ${item.category || "其他目录"} · ${accessLabel} · ${item.language || "语言未知"}`;
      if (item.playbook) meta.textContent += ` · 熟站 ${item.playbook.title}`;
      if (item.playbook?.notes) meta.title = item.playbook.notes;
      const destinationWrap = document.createElement("div");
      destinationWrap.className = "library-destination";
      const destinationLink = document.createElement("a");
      destinationLink.className = "library-destination-link";
      destinationLink.href = item.url;
      destinationLink.target = "_blank";
      destinationLink.rel = "noreferrer";
      destinationLink.textContent = item.url;
      destinationLink.addEventListener("click", (event) => {
        event.stopPropagation();
      });
      destinationWrap.append(destinationLink);

      const qualityRow = document.createElement("div");
      qualityRow.className = "quality-row";
      const qualityScore = document.createElement("span");
      const score = Number(item.quality?.score || 0);
      const scoreClass = score >= 75 ? "priority" : score >= 55 ? "workable" : score >= 35 ? "watch" : "low";
      qualityScore.className = `quality-score ${scoreClass}`;
      qualityScore.textContent = `质量分 ${score} · ${item.quality?.tier || "观察"}`;
      qualityScore.title =
        (item.quality?.reasons || []).join(" · ") ||
        "0–100 机会质量分：优先≥75，可做≥55，观察≥35，低于 35 为低质";
      qualityRow.append(qualityScore);
      const metricPairs = [
        ["DR", item.metrics?.dr],
        ["DA", item.metrics?.da],
        ["流量", item.metrics?.traffic],
        ["Spam", item.metrics?.spamScore],
      ];
      for (const [label, value] of metricPairs) {
        if (value === null || value === undefined || value === "") continue;
        const tag = document.createElement("span");
        tag.className = "metric-tag";
        tag.textContent = `${label} ${value}`;
        qualityRow.append(tag);
      }
      if (item.time) {
        const timeTag = document.createElement("span");
        timeTag.className = "metric-tag";
        timeTag.textContent = `表格时间 ${item.time}`;
        qualityRow.append(timeTag);
      }
      if (item.monitorStatus) {
        const monitor = document.createElement("span");
        monitor.className = `monitor-tag ${item.monitorStatus}`;
        monitor.textContent = { live: "外链存活", missing: "疑似丢链", unreachable: "无法访问" }[item.monitorStatus] || item.monitorStatus;
        qualityRow.append(monitor);
      }

      qualityRow.prepend(meta);

      const statuses = document.createElement("div");
      statuses.className = "profile-statuses";
      for (const profile of item.profileStatuses || []) {
        if (!profile.success && !profile.latestEvent) continue;
        const chip = document.createElement("span");
        const timelineStatus =
          profile.latestEvent?.publicationStatus ||
          (["submitted", "pending_moderation", "published", "rejected", "needs_follow_up", "needs_manual", "link_missing", "link_submit"].includes(profile.latestEvent?.type)
            ? profile.latestEvent.type
            : "");
        const publication = timelineStatus || profile.publicationStatus || "";
        const publicationLabel =
          {
            submitted: "已提交",
            pending_moderation: "待审核",
            published: "已上线",
            rejected: "被拒绝",
            needs_follow_up: "需跟进",
            needs_manual: "需人工",
            link_missing: "链接失效",
            link_submit: "表格有提交动作 · 未核验",
          }[publication] || "已有记录";
        chip.className = `profile-status${profile.success ? " success" : ""}${publication ? ` ${publication}` : ""}`;
        chip.textContent = `${profile.profileName} · ${publicationLabel}`;
        statuses.append(chip);
      }
      card.classList.toggle("is-selected", selectedLibraryKey === item.key);
      card.tabIndex = 0;
      card.setAttribute("aria-selected", String(selectedLibraryKey === item.key));
      card.addEventListener("click", (event) => {
        if (event.target.closest("a, button, input, textarea, select, label")) return;
        selectedLibraryKey = item.key;
        editingTimelineEventId = "";
        renderLibrary();
      });
      card.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          selectedLibraryKey = item.key;
          editingTimelineEventId = "";
          renderLibrary();
        }
      });
      card.append(head, destinationWrap, qualityRow);
      const activitySummary = document.createElement("div");
      activitySummary.className = "library-activity-summary";
      const projectNames = (item.projects || [])
        .map((id) => siteProfiles[id]?.name || id)
        .filter(Boolean)
        .join("、");
      activitySummary.append(
        createActivityFact("提交网站", projectNames || "尚未指定"),
        createActivityFact("当前进度", progressLabel(progress)),
        createActivityFact(
          "提交时间",
          progress.submittedAt ? formatActivityTime(progress.submittedAt) : "暂无提交记录",
        ),
        createActivityFact("最近动态", latestActivityText(item), true),
      );
      card.append(activitySummary);
      const keyDetails = document.createElement("div");
      keyDetails.className = "library-key-details";
      if (item.record) keyDetails.append(createKeyDetail("记录", item.record, true));
      if (item.detail) keyDetails.append(createKeyDetail("备注 / 详情", item.detail, true));
      const combinedNote = [item.record, item.detail].filter(Boolean).join(" | ");
      if (
        item.note &&
        item.note !== combinedNote &&
        item.note !== item.record &&
        item.note !== item.detail
      ) {
        keyDetails.append(createKeyDetail("补充备注", item.note, true));
      }
      if (keyDetails.childNodes.length) card.append(keyDetails);
      if (statuses.childNodes.length) card.append(statuses);
      el.append(card);
    }
    if ($("btnLibraryLoadMore")) {
      $("btnLibraryLoadMore").hidden = shown.length >= filtered.length;
      $("btnLibraryLoadMore").textContent = `加载更多（剩余 ${filtered.length - shown.length} 条）`;
    }
    renderSelectedLibraryTimeline();
  }

  function storageValuesEqual(left, right) {
    if (Object.is(left, right)) return true;
    const normalize = (value) => {
      if (Array.isArray(value)) return value.map(normalize);
      if (!value || typeof value !== "object") return value;
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = normalize(value[key]);
          return result;
        }, {});
    };
    try {
      return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
    } catch {
      return false;
    }
  }

  function hasLibraryStorageChanges(changes) {
    return Object.entries(changes || {}).some(([key, change]) =>
      LIBRARY_STORAGE_KEYS.has(key) &&
      !storageValuesEqual(change?.oldValue, change?.newValue),
    );
  }

  function setLibraryRefreshError(error) {
    const message = error?.message || String(error || "加载外链库失败");
    const count = $("libraryCount");
    if (count) count.textContent = `外链库刷新失败：${message}`;
  }

  function scheduleLibraryRefresh() {
    libraryRefreshPending = true;
    if (libraryInitialSyncPending || libraryRefreshTimer !== null) return;
    libraryRefreshTimer = setTimeout(() => {
      libraryRefreshTimer = null;
      libraryRefreshPending = false;
      loadLibrary().catch(setLibraryRefreshError);
    }, LIBRARY_REFRESH_DEBOUNCE_MS);
  }

  function onLibraryStorageChanged(changes, area) {
    if (area !== "local" || !hasLibraryStorageChanges(changes)) return false;
    libraryStorageRevision += 1;
    scheduleLibraryRefresh();
    return true;
  }

  function installLibraryStorageListener() {
    if (libraryStorageListenerInstalled || !chrome.storage?.onChanged?.addListener) return;
    chrome.storage.onChanged.addListener(onLibraryStorageChanged);
    libraryStorageListenerInstalled = true;
  }

  async function loadLibrary(options = {}) {
    const requestId = ++libraryLoadRequestId;
    const storageRevisionAtStart = libraryStorageRevision;
    const initial = options.initial === true;
    try {
      const result = await chrome.runtime.sendMessage({ action: "getLibraryManagerState" });
      if (requestId !== libraryLoadRequestId) return { stale: true };
      if (storageRevisionAtStart !== libraryStorageRevision) {
        scheduleLibraryRefresh();
        return { stale: true };
      }
      if (!result?.ok) throw new Error(result?.error || "加载外链库失败");

      const timelineDraft = captureTimelineEditorDraft();
      const preserveSiteDraft = hasUnsavedSiteEdits();
      const previousActiveSiteId = activeSiteId;
      const previousActiveProfile = previousActiveSiteId ? siteProfiles[previousActiveSiteId] : null;
      libraryStats = result.libraryStats || {};
      libraryItems = Array.isArray(result.items) ? result.items : [];
      if (result.profiles && typeof result.profiles === "object" && !Array.isArray(result.profiles)) {
        siteProfiles = result.profiles;
        if (preserveSiteDraft && previousActiveSiteId && !siteProfiles[previousActiveSiteId] && previousActiveProfile) {
          siteProfiles = { ...siteProfiles, [previousActiveSiteId]: previousActiveProfile };
        }
        if (!activeSiteId || !siteProfiles[activeSiteId]) {
          if (!preserveSiteDraft) activeSiteId = orderedSiteIds()[0] || "";
          else activeSiteId = previousActiveSiteId;
        }
        renderSiteSelector();
        if (!preserveSiteDraft) loadActiveToForm();
      }
      renderLibrary();
      restoreTimelineEditorDraft(timelineDraft);
      return result;
    } finally {
      if (initial) {
        libraryInitialSyncPending = false;
        if (libraryRefreshPending) {
          libraryRefreshPending = false;
          scheduleLibraryRefresh();
        }
      }
    }
  }

  function resetLibraryAndRender() {
    libraryVisibleLimit = LIBRARY_PAGE_SIZE;
    renderLibrary();
  }

  $("librarySearch")?.addEventListener("input", resetLibraryAndRender);
  $("libraryCategoryFilter")?.addEventListener("change", resetLibraryAndRender);
  $("libraryStatusFilter")?.addEventListener("change", resetLibraryAndRender);
  $("libraryProgressFilter")?.addEventListener("change", resetLibraryAndRender);
  $("libraryQualityFilter")?.addEventListener("change", resetLibraryAndRender);
  $("librarySort")?.addEventListener("change", resetLibraryAndRender);
  $("btnLibraryLoadMore")?.addEventListener("click", () => {
    libraryVisibleLimit += LIBRARY_PAGE_SIZE;
    renderLibrary();
  });

  $("btnCloudRefresh")?.addEventListener("click", () => {
    loadCloudSyncStatus().catch((err) => setCloudStatus(err.message, "warning"));
  });

  $("btnCloudConnect")?.addEventListener("click", async () => {
    const btn = $("btnCloudConnect");
    const editorRevision = nonProfileEditorRevision;
    btn.disabled = true;
    setCloudStatus("正在验证云端连接…");
    try {
      const result = await chrome.runtime.sendMessage({ action: "cloudSyncConnect", config: cloudConfigFromForm() });
      if (!result?.ok) throw new Error(result?.error || "无法连接云端数据中心");
      await loadCloudSyncStatus();
      clearNonProfileEditorDirty("cloud-config", editorRevision);
    } catch (err) {
      setCloudStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnCloudMigrate")?.addEventListener("click", async () => {
    if (!confirm("首次迁移会把当前插件资料、外链库、提交账本、时间线和备注保存为云端主数据。已有云端数据不会被覆盖。继续吗？")) return;
    const btn = $("btnCloudMigrate");
    btn.disabled = true;
    setCloudStatus("正在迁移当前插件数据到云端…");
    try {
      const result = await chrome.runtime.sendMessage({ action: "cloudSyncMigrate" });
      if (!result?.ok) throw new Error(result?.error || "首次迁移失败");
      const totalDocuments = result.pulledDocuments ?? result.totalDocuments ?? result.importedDocuments ?? 0;
      const importedDocuments = result.importedDocuments ?? 0;
      const timelineEvents = result.timelineEvents ?? 0;
      const prefix = result.resumed ? "迁移续传完成" : "迁移完成";
      setCloudStatus(`${prefix}：云端已核对 ${totalDocuments} 类数据（本次新增 ${importedDocuments} 类），新增 ${timelineEvents} 条时间线事件。`, "success");
      await loadLibrary();
    } catch (err) {
      setCloudStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnCloudPull")?.addEventListener("click", async () => {
    const btn = $("btnCloudPull");
    if (hasUnsavedSettingsEdits()) {
      setCloudStatus("当前设置有未保存修改，请先保存后再从云端回读。", "warning");
      return;
    }
    btn.disabled = true;
    setCloudStatus("正在从云端回读数据…");
    try {
      let result = await chrome.runtime.sendMessage({ action: "cloudSyncPull" });
      if (!result?.ok) throw new Error(result?.error || "云端回读失败");
      if (result.status === "conflict") {
        try {
          await downloadSubmissionBackup();
        } catch (err) {
          setCloudStatus("本地 JSON 备份失败，未执行强制回读：" + err.message, "warning");
          btn.disabled = false;
          return;
        }
        if (hasUnsavedSettingsEdits()) {
          setCloudStatus("备份期间产生了未保存修改，未执行强制回读；请先保存后重试。", "warning");
          btn.disabled = false;
          return;
        }
        const shouldResolve = confirm(
          "JSON 备份下载已发起，请确认文件已保存，再采用云端替换冲突数据；取消将保留原数据。是否继续？",
        );
        if (!shouldResolve) {
          setCloudStatus(result.message || "已取消冲突回读，原数据保持不变。", "warning");
          btn.disabled = false;
          return;
        }
        result = await chrome.runtime.sendMessage({
          action: "cloudSyncPull",
          resolveConflicts: true,
        });
        if (!result?.ok) throw new Error(result?.error || "冲突回读失败");
      }
      if (result.applied === false) {
        setCloudStatus(result.message || "云端回读暂未应用，请稍后重试。", "warning");
        btn.disabled = false;
        return;
      }
      const hasSiteDraftAfterPull = hasUnsavedSiteEdits();
      const hasDraftAfterPull = hasUnsavedSettingsEdits();
      adoptPulledSiteProfiles(result.state, hasSiteDraftAfterPull);
      if (hasDraftAfterPull) {
        setCloudStatus("回读完成，但期间产生了未保存修改；页面未刷新，请先保存当前资料。", "warning");
        btn.disabled = false;
        return;
      }
      const successMessage = `云端回读成功：已更新 ${result.documentCount || 0} 类数据。`;
      setCloudStatus(successMessage, "success");
      queueReloadNotice(successMessage, "success", "library");
      location.reload();
    } catch (err) {
      setCloudStatus(err.message, "warning");
      btn.disabled = false;
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target?.closest?.("#panel-sites")) {
      siteEditorDirty = true;
      return;
    }
    markNonProfileEditorDirty(event.target);
  });
  document.addEventListener("change", (event) => {
    if (event.target?.closest?.("#panel-sites")) {
      siteEditorDirty = true;
      return;
    }
    markNonProfileEditorDirty(event.target);
  });

  $("btnCloudPush")?.addEventListener("click", async () => {
    const btn = $("btnCloudPush");
    btn.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ action: "cloudSyncPush" });
      if (!result?.ok) throw new Error(result?.error || "云端保存失败");
      await loadCloudSyncStatus();
      const savedCount = Array.isArray(result.saved) ? result.saved.length : 0;
      const message = savedCount
        ? `云端保存成功：已保存 ${savedCount} 类修改。`
        : "云端已是最新，没有待保存修改。";
      setCloudStatus(message, "success");
      showSettingsToast(message, "success");
      setActivePanel("library");
    } catch (err) {
      setCloudStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  function monitorSummary(result) {
    const counts = result.counts || Object.values(result.results || {}).reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    return [
      `成功账本 ${result.totalSuccesses ?? "—"} 条`,
      `可复查 ${result.checkable ?? result.checked ?? 0} 条`,
      `存活 ${counts.live || 0}`,
      `疑似丢失 ${counts.missing || 0}`,
      `无法访问 ${counts.unreachable || 0}`,
      result.lastRunAt ? `最近 ${new Date(result.lastRunAt).toLocaleString()}` : "尚未运行",
    ].join(" · ");
  }

  async function loadLinkMonitorState() {
    const result = await chrome.runtime.sendMessage({ action: "getLinkMonitorState" });
    if (!result?.ok) throw new Error(result?.error || "读取外链监控失败");
    if ($("linkMonitorEnabled")) $("linkMonitorEnabled").checked = result.enabled !== false;
    if ($("linkMonitorMinutes")) $("linkMonitorMinutes").value = String(result.minutes || 1440);
    setStatusLine("linkMonitorStatus", monitorSummary(result), "success");
    return result;
  }

  $("btnRunLinkMonitor")?.addEventListener("click", async () => {
    const btn = $("btnRunLinkMonitor");
    btn.disabled = true;
    setStatusLine("linkMonitorStatus", "正在复查带公开结果页的成功外链…");
    try {
      const result = await chrome.runtime.sendMessage({ action: "runLinkMonitor" });
      if (!result?.ok) throw new Error(result?.error || "复查失败");
      setStatusLine("linkMonitorStatus", monitorSummary(result), (result.counts?.missing || result.counts?.unreachable) ? "warning" : "success");
      await loadLibrary();
    } catch (err) {
      setStatusLine("linkMonitorStatus", err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnSaveLinkMonitor")?.addEventListener("click", async () => {
    const editorRevision = nonProfileEditorRevision;
    const result = await chrome.runtime.sendMessage({
      action: "saveLinkMonitorSchedule",
      enabled: $("linkMonitorEnabled").checked,
      minutes: Number($("linkMonitorMinutes").value || 1440),
    });
    if (!result?.ok) return setStatusLine("linkMonitorStatus", result?.error || "保存失败", "warning");
    await loadLinkMonitorState();
    clearNonProfileEditorDirty("link-monitor", editorRevision);
  });

  async function downloadSubmissionBackup() {
    const result = await chrome.runtime.sendMessage({ action: "exportSubmissionData" });
    if (!result?.ok) throw new Error(result?.error || "导出失败");
    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "externallink-backup-" + new Date().toISOString().slice(0, 10) + ".json";
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  $("btnExportLedger")?.addEventListener("click", async () => {
    try {
      await downloadSubmissionBackup();
    } catch (err) {
      alert(err.message || "导出失败");
    }
  });

  $("btnImportLedger")?.addEventListener("click", () => $("ledgerImportFile")?.click());
  $("ledgerImportFile")?.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const result = await chrome.runtime.sendMessage({ action: "importSubmissionData", data });
      if (!result?.ok) throw new Error(result?.error || "导入失败");
      alert(`已导入 ${result.recordsImported} 条账本记录、${result.profilesImported} 个网站资料`);
      location.reload();
    } catch (err) {
      alert(`导入失败: ${err.message}`);
    } finally {
      event.target.value = "";
    }
  });

  // ─── Target gate + assistant settings ───
  function setStatusLine(id, message, tone = "") {
    const el = $(id);
    if (!el) return;
    el.className = `sync-status${tone ? ` ${tone}` : ""}`;
    el.textContent = message;
  }

  function applyGateStateToForm(state) {
    const filters = state.filters || {};
    if ($("filterBlacklistEnabled")) {
      $("filterBlacklistEnabled").checked = filters.blacklistEnabled !== false;
    }
    if ($("filterMinDomainAge")) {
      $("filterMinDomainAge").value = String(filters.minDomainAgeMonths || 0);
    }
    if ($("filterRequireKnownAge")) {
      $("filterRequireKnownAge").checked = filters.requireKnownDomainAge === true;
    }
    if ($("filterMinOpportunityScore")) {
      $("filterMinOpportunityScore").value = String(filters.minOpportunityScore || 0);
    }
    if ($("filterAiComments")) $("filterAiComments").checked = filters.aiComments !== false;
    if ($("filterAiCommentAllowLink")) {
      $("filterAiCommentAllowLink").checked = filters.aiCommentAllowLink !== false;
    }
    if ($("filterManualFillIcons")) {
      $("filterManualFillIcons").checked = filters.showManualFillIcons !== false;
    }
    if ($("domainBlacklistText")) {
      $("domainBlacklistText").value = (state.domainBlacklist || []).join("\n");
    }
    setStatusLine(
      "targetGateStatus",
      [
        `黑名单 ${(state.domainBlacklist || []).length} 条`,
        filters.minDomainAgeMonths
          ? `最小域名年龄 ${filters.minDomainAgeMonths} 个月`
          : "未启用年龄闸门",
        filters.minOpportunityScore
          ? `最低质量分 ${filters.minOpportunityScore}`
          : "未启用质量分闸门",
        `已缓存年龄数据 ${state.metricsCached || 0} 个域名`,
      ].join(" · "),
      "success",
    );
  }

  async function loadTargetGateState() {
    const state = await chrome.runtime.sendMessage({ action: "getTargetGateState" });
    if (!state?.ok) throw new Error(state?.error || "读取闸门设置失败");
    applyGateStateToForm(state);
    return state;
  }

  $("btnSaveTargetGate")?.addEventListener("click", async () => {
    const btn = $("btnSaveTargetGate");
    const editorRevision = nonProfileEditorRevision;
    btn.disabled = true;
    try {
      const entries = String($("domainBlacklistText").value || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean);
      const listResult = await chrome.runtime.sendMessage({
        action: "updateDomainBlacklist",
        add: entries,
        replace: true,
      });
      if (!listResult?.ok) throw new Error(listResult?.error || "保存黑名单失败");

      const filterResult = await chrome.runtime.sendMessage({
        action: "saveTargetFilters",
        filters: {
          blacklistEnabled: $("filterBlacklistEnabled").checked,
          minDomainAgeMonths: Number($("filterMinDomainAge").value || 0),
          requireKnownDomainAge: $("filterRequireKnownAge").checked,
          minOpportunityScore: Number($("filterMinOpportunityScore").value || 0),
        },
      });
      if (!filterResult?.ok) throw new Error(filterResult?.error || "保存闸门设置失败");
      await loadTargetGateState();
      setStatusLine("targetGateStatus", "闸门设置已保存，下一次构建队列生效。", "success");
      clearNonProfileEditorDirty("target-gate", editorRevision);
    } catch (err) {
      setStatusLine("targetGateStatus", err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnPrefetchDomainAge")?.addEventListener("click", async () => {
    const btn = $("btnPrefetchDomainAge");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = "查询中…";
    try {
      const queue = await chrome.runtime.sendMessage({ action: "getSubmissionQueue" });
      const domains = [
        ...new Set(
          (queue?.groups || queue?.tasks || [])
            .map((item) => item.domain || "")
            .filter(Boolean),
        ),
      ].slice(0, 200);
      if (!domains.length) throw new Error("当前队列没有可查询的域名");

      setStatusLine("targetGateStatus", `正在查询 ${domains.length} 个域名的注册年龄…`);
      const result = await chrome.runtime.sendMessage({ action: "getDomainMetrics", domains });
      const state = await loadTargetGateState();
      const known = Object.values(result?.results || {}).filter((item) =>
        Number.isFinite(item.ageMonths),
      ).length;
      setStatusLine(
        "targetGateStatus",
        [
          `查询 ${domains.length} 个域名`,
          `拿到注册日期 ${known} 个`,
          `缓存共 ${state.metricsCached || 0} 个`,
          result?.error ? `云端服务报错：${result.error}` : "",
        ]
          .filter(Boolean)
          .join(" · "),
        result?.error ? "warning" : "success",
      );
    } catch (err) {
      setStatusLine("targetGateStatus", err.message, "warning");
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  $("btnSaveAssistant")?.addEventListener("click", async () => {
    const btn = $("btnSaveAssistant");
    const editorRevision = nonProfileEditorRevision;
    btn.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({
        action: "saveTargetFilters",
        filters: {
          aiComments: $("filterAiComments").checked,
          aiCommentAllowLink: $("filterAiCommentAllowLink").checked,
          showManualFillIcons: $("filterManualFillIcons").checked,
        },
      });
      if (!result?.ok) throw new Error(result?.error || "保存助手设置失败");
      setStatusLine("mediaLibraryStatus", "助手设置已保存，新打开的页面生效。", "success");
      clearNonProfileEditorDirty("assistant", editorRevision);
    } catch (err) {
      setStatusLine("mediaLibraryStatus", err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnRefreshMediaLibrary")?.addEventListener("click", async () => {
    const btn = $("btnRefreshMediaLibrary");
    btn.disabled = true;
    try {
      const result = await chrome.runtime.sendMessage({ action: "listCloudSubmissionMedia" });
      if (!result?.ok) throw new Error(result?.error || "读取云端媒体失败");
      const grouped = (result.assets || []).reduce((map, item) => {
        const profile = item.profile_id || "未归类";
        if (!map[profile]) map[profile] = { logos: 0, shots: 0 };
        if (item.media_kind === "logo") map[profile].logos += 1;
        if (item.media_kind === "screenshot") map[profile].shots += 1;
        return map;
      }, {});
      const summary = Object.entries(grouped)
        .map(([profile, counts]) => `${profile}（Logo ${counts.logos} / 截图 ${counts.shots}）`)
        .join("，");
      setStatusLine(
        "mediaLibraryStatus",
        summary ? `R2 私有媒体库 → ${summary}` : "R2 中还没有可用图片",
        summary ? "success" : "warning",
      );
    } catch (err) {
      setStatusLine("mediaLibraryStatus", err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnClearData")?.addEventListener("click", () => {
    if (!confirm("确认清除所有扩展数据？")) return;
    chrome.storage.local.clear(() => {
      siteProfiles = {};
      activeSiteId = "";
      pendingLogoDataUrl = null;
      renderSiteSelector();
      loadActiveToForm();
      alert("已清除");
    });
  });

  installLibraryStorageListener();
  chrome.storage.local.get(
    [
      "siteProfiles",
      "activeSiteId",
      "cfgEmail",
      "cfgName",
      "cfgCommentTemplate",
      "cfgConcurrency",
      "cfgPingIndex",
      "autoFillOnVisit",
      "autoSubmitDirectoryListings",
      "autoSubmitStandardWpComments",
      "cloudSyncConfig",
      "settingsActivePanel",
    ],
    (items) => {
      siteProfiles = items.siteProfiles || {};
      if (SETTINGS_PANELS.has(items.settingsActivePanel)) {
        setActivePanel(items.settingsActivePanel);
        chrome.storage.local.remove("settingsActivePanel");
      } else if (SETTINGS_PANELS.has(startupSessionPanel)) {
        setActivePanel(startupSessionPanel, { persist: false });
      }
      activeSiteId = items.activeSiteId || P.orderedProfileIds(siteProfiles)[0] || "";
      renderSiteSelector();
      loadActiveToForm();
      if (items.cfgEmail) $("cfgEmail").value = items.cfgEmail;
      if (items.cfgName) $("cfgName").value = items.cfgName;
      if (items.cfgCommentTemplate) $("cfgCommentTemplate").value = items.cfgCommentTemplate;
      if (items.cfgConcurrency) $("cfgConcurrency").value = items.cfgConcurrency;
      $("cfgPingIndex").checked = items.cfgPingIndex !== false;
      $("autoFillOnVisit").checked = items.autoFillOnVisit !== false;
      if ($("autoSubmitDirectoryListings")) {
        $("autoSubmitDirectoryListings").checked = items.autoSubmitDirectoryListings !== false;
      }
      if ($("autoSubmitStandardWpComments")) {
        $("autoSubmitStandardWpComments").checked = items.autoSubmitStandardWpComments === true;
      }
      loadLibrary({ initial: true })
        .catch((err) => {
          const el = $("libraryList");
          if (el) {
            el.replaceChildren();
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = err.message;
            el.append(empty);
          }
        })
        .finally(() => {
          loadCloudSyncStatus().catch((err) => setCloudStatus(err.message, "warning"));
        });
      loadLinkMonitorState().catch((err) => setStatusLine("linkMonitorStatus", err.message, "warning"));
      loadTargetGateState().catch((err) => setStatusLine("targetGateStatus", err.message, "warning"));
    },
  );
})();

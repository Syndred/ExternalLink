// ExternalLink Settings Page — site profiles & global config (persistent tab)
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const P = self.ExtLinkProfiles;
  const Timeline = self.ExtLinkSubmissionTimeline;

  let siteProfiles = {};
  let activeSiteId = "";
  let pendingLogoDataUrl = null;
  let libraryItems = [];
  let libraryVisibleLimit = 200;
  const LIBRARY_PAGE_SIZE = 200;
  let googlePreviewRevision = "";

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

  function setGoogleStatus(message, tone = "") {
    const el = $("googleSyncStatus");
    if (!el) return;
    el.className = `sync-status${tone ? ` ${tone}` : ""}`;
    el.textContent = message;
  }

  function setGooglePreview(preview = null) {
    const el = $("googleSyncPreview");
    const apply = $("btnGoogleApply");
    googlePreviewRevision = preview?.revision || "";
    if (apply) apply.disabled = !googlePreviewRevision || !!preview?.conflicts?.length;
    if (!el) return;
    if (!preview) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const parts = [
      `外链站 ${preview.destinations || 0} 个`,
      `新增资料 ${preview.profilesAdded || 0} 个`,
      `更新资料 ${preview.profilesUpdated || 0} 个`,
      `移除资料 ${preview.profilesRemoved || 0} 个`,
      `新增成功记录 ${preview.recordsAdded || 0} 条`,
      `升级记录 ${preview.recordsUpgraded || 0} 条`,
      `保护本地强证据 ${preview.recordsProtected || 0} 条`,
      `分类变化 ${preview.annotationChanges || 0} 条`,
      `清除分类 ${preview.annotationsRemoved || 0} 条`,
    ];
    if (preview.conflicts?.length) {
      parts.push(`发现 ${preview.conflicts.length} 个冲突，请先在表格中处理后重新预览`);
    }
    el.textContent = parts.join(" · ");
    el.hidden = false;
  }

  async function loadGoogleSyncStatus({ probeAgent = false } = {}) {
    setGoogleStatus(probeAgent ? "正在检查本机 Agent 和 Google 授权…" : "正在读取本地缓存…");
    const result = await chrome.runtime.sendMessage({ action: "googleSyncStatus", probeAgent });
    if (!result?.ok) throw new Error(result?.error || "读取 Google 同步状态失败");
    if ($("googleSheetId") && result.spreadsheetId) {
      $("googleSheetId").value = result.spreadsheetId;
    }
    if ($("googleAutoPreviewEnabled")) {
      $("googleAutoPreviewEnabled").checked = result.autoPreviewEnabled === true;
    }
    if ($("googleAutoPreviewMinutes")) {
      $("googleAutoPreviewMinutes").value = String(result.autoPreviewMinutes || 60);
    }
    if (result.pendingPreview?.preview) setGooglePreview(result.pendingPreview.preview);
    const cache = result.cache || {};
    const cacheSummary = cache.ready
      ? `本地缓存已就绪：${cache.destinations || 0} 个外链、${cache.profiles || 0} 个网站资料`
      : "本地还没有完整表格缓存";
    const syncedAt = cache.syncedAt || result.meta?.appliedAt || result.meta?.fetchedAt || "";
    const pending = Number(result.pendingRecords || 0);
    if (!probeAgent) {
      setGoogleStatus(
        `${cacheSummary}${syncedAt ? ` · 最近更新 ${new Date(syncedAt).toLocaleString()}` : ""}${pending ? ` · 待回写 ${pending} 条` : ""} · 日常查看无需启动服务；只有从 Google 更新或回写时才需要本机 Agent。`,
        cache.ready ? "success" : "warning",
      );
      return result;
    }
    const agent = result.agent || {};
    if (result.agentError) {
      setGoogleStatus(
        `${cacheSummary} · 本机 Agent 当前未运行；不影响查看，只影响 Google 更新和回写。`,
        cache.ready ? "success" : "warning",
      );
      return result;
    }
    const authenticated = agent.authenticated === true || agent.connected === true;
    const configured = agent.configured === true;
    if (authenticated) {
      const details = [
        cacheSummary,
        result.enabled ? "Google 更新通道已启用" : "已授权，可按需更新本地缓存",
        pending ? `待回写 ${pending} 条` : "无待回写记录",
        syncedAt ? `最近同步 ${new Date(syncedAt).toLocaleString()}` : "尚未同步",
        result.pendingPreview?.revision ? "表格有待应用更新" : "表格版本已对齐",
      ];
      setGoogleStatus(details.join(" · "), result.enabled ? "success" : "warning");
    } else if (configured) {
      setGoogleStatus("本机配置已就绪，请点击“连接 Google”完成授权。", "warning");
    } else {
      setGoogleStatus(
        `${cacheSummary} · 本机 Agent 尚未配置 GOOGLE_SHEET_ID 和 GOOGLE_OAUTH_CLIENT_FILE。`,
        "warning",
      );
    }
    return result;
  }

  function setActivePanel(name) {
    document.body.dataset.panel = name;
    document.querySelectorAll(".tab").forEach((tab) => {
      tab.classList.toggle("active", tab.dataset.panel === name);
    });
    document.querySelectorAll(".panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `panel-${name}`);
    });
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => setActivePanel(tab.dataset.panel));
  });

  function save(obj) {
    chrome.storage.local.set(obj);
  }

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
      updatedAt: new Date().toISOString(),
    };
  }

  function renderSiteSelector() {
    const sel = $("siteSelect");
    const ids = Object.keys(siteProfiles);
    sel.replaceChildren();
    if (!ids.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "点击 + 添加站点";
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
    if (activeSiteId && siteProfiles[activeSiteId]) sel.value = activeSiteId;
    else if (ids.length) {
      activeSiteId = ids[0];
      sel.value = activeSiteId;
    }
  }

  function persistProfiles() {
    save({ siteProfiles, activeSiteId });
  }

  function loadActiveToForm() {
    if (!activeSiteId || !siteProfiles[activeSiteId]) {
      pendingLogoDataUrl = null;
      profileToForm(P.emptySiteProfile("new"));
      return;
    }
    profileToForm(siteProfiles[activeSiteId]);
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
  });

  $("btnAddSite")?.addEventListener("click", () => {
    const id = "site-" + Date.now().toString(36);
    siteProfiles[id] = P.emptySiteProfile(id, "新站点");
    activeSiteId = id;
    renderSiteSelector();
    loadActiveToForm();
    persistProfiles();
  });

  $("btnRemoveSite")?.addEventListener("click", () => {
    if (!activeSiteId || !siteProfiles[activeSiteId]) return;
    if (!confirm(`移除「${siteProfiles[activeSiteId].name || activeSiteId}」？`)) return;
    delete siteProfiles[activeSiteId];
    activeSiteId = Object.keys(siteProfiles)[0] || "";
    renderSiteSelector();
    loadActiveToForm();
    persistProfiles();
  });

  $("siteSelect")?.addEventListener("change", () => {
    activeSiteId = $("siteSelect").value;
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
      const data = await P.callLocalAgent("/extract-site", {
        url,
        language: $("siteLanguage").value || "auto",
      });
      const current =
        activeSiteId && siteProfiles[activeSiteId]
          ? siteProfiles[activeSiteId]
          : P.emptySiteProfile(activeSiteId || P.slugifySiteId(url), "");
      const merged = P.mergeExtractedProfile(current, data.profile || {});
      profileToForm(merged);
    } catch (err) {
      alert(`提取失败: ${err.message}\n\n请确认 local_agent 已启动且 DEEPSEEK_API_KEY 已配置`);
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
      const data = await P.callLocalAgent("/generate-site", {
        profile: partial,
        language: $("siteLanguage").value || "auto",
      });
      profileToForm(P.mergeExtractedProfile(partial, data.profile || {}));
    } catch (err) {
      alert(`生成失败: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "✨ 完善当前资料";
    }
  });

  $("btnSaveConfig")?.addEventListener("click", () => {
    save({
      cfgEmail: $("cfgEmail").value,
      cfgName: $("cfgName").value,
      cfgCommentTemplate: $("cfgCommentTemplate").value,
      cfgConcurrency: $("cfgConcurrency").value,
      cfgPingIndex: $("cfgPingIndex").checked,
      autoOpenSidePanel: $("autoOpenSidePanel").checked,
      autoFillOnVisit: $("autoFillOnVisit").checked,
      autoSubmitStandardWpComments: $("autoSubmitStandardWpComments")?.checked === true,
    });
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

  function createActivityFact(label, value) {
    const fact = document.createElement("div");
    fact.className = "activity-fact";
    const caption = document.createElement("span");
    caption.className = "activity-fact-label";
    caption.textContent = label;
    const content = document.createElement("span");
    content.className = "activity-fact-value";
    content.textContent = value || "—";
    fact.append(caption, content);
    return fact;
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

  function createSheetFieldsDetails(item) {
    const details = document.createElement("details");
    details.className = "sheet-fields";
    const summary = document.createElement("summary");
    summary.textContent = `表格原始字段${item.rowNumber ? ` · 第 ${item.rowNumber} 行` : ""}`;
    const list = document.createElement("dl");
    for (const [field, value] of Object.entries(item.rawFields || {})) {
      if (value === undefined || value === null || String(value).trim() === "") continue;
      const term = document.createElement("dt");
      term.textContent = field;
      const description = document.createElement("dd");
      description.textContent = String(value);
      list.append(term, description);
    }
    details.append(summary, list);
    return details;
  }

  function renderTimelinePanel(item, panel) {
    panel.replaceChildren();
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
        head.textContent = `${formatActivityTime(event.occurredAt)} · ${profileName} · ${activityLabel(event.type || event.status)}`;
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

    const form = document.createElement("form");
    form.className = "timeline-form";
    const profile = document.createElement("select");
    profile.setAttribute("aria-label", "网站项目");
    const destinationOption = document.createElement("option");
    destinationOption.value = "__destination__";
    destinationOption.textContent = "外链站通用动态";
    profile.append(destinationOption);
    for (const [id, itemProfile] of Object.entries(siteProfiles)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = itemProfile.name || id;
      profile.append(option);
    }
    const type = document.createElement("select");
    type.setAttribute("aria-label", "动态状态");
    for (const [value, label] of [
      ["submitted", "已提交"],
      ["pending_moderation", "待审核"],
      ["published", "已上线"],
      ["rejected", "被拒绝"],
      ["needs_follow_up", "需跟进"],
      ["needs_manual", "需人工"],
      ["link_missing", "链接失效"],
      ["note", "仅记录笔记"],
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      type.append(option);
    }
    const occurredAt = document.createElement("input");
    occurredAt.type = "datetime-local";
    occurredAt.value = toDatetimeLocalValue();
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
    submit.className = "btn btn-primary timeline-form-wide";
    submit.textContent = "添加动态";
    form.append(profile, type, occurredAt, url, note, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      submit.disabled = true;
      submit.textContent = "保存中…";
      try {
        const result = await chrome.runtime.sendMessage({
          action: "addSubmissionTimelineEvent",
          destinationKey: item.key,
          destinationUrl: item.url,
          profileId: profile.value,
          profileName:
            profile.value === "__destination__"
              ? "外链站"
              : siteProfiles[profile.value]?.name || profile.value,
          type: type.value,
          occurredAt: occurredAt.value ? new Date(occurredAt.value).toISOString() : new Date().toISOString(),
          note: note.value.trim(),
          publicUrl: type.value === "published" ? url.value.trim() : "",
          evidenceUrl: type.value === "published" ? "" : url.value.trim(),
          source: "manual",
        });
        if (!result?.ok) throw new Error(result?.error || "保存动态失败");
        await loadLibrary();
      } catch (err) {
        alert(err.message);
      } finally {
        submit.disabled = false;
        submit.textContent = "添加动态";
      }
    });
    panel.append(list, form);
  }

  function renderLibrary() {
    const el = $("libraryList");
    if (!el) return;
    const query = ($("librarySearch")?.value || "").trim().toLowerCase();
    const statusFilter = $("libraryStatusFilter")?.value || "";
    const progressFilter = $("libraryProgressFilter")?.value || "";
    const qualityFilter = Number($("libraryQualityFilter")?.value || 0);
    const sortMode = $("librarySort")?.value || "quality";
    const filtered = libraryItems.filter((item) => {
      const status = item.annotation?.status || "";
      const progress = Timeline.deriveLibraryProgress(item);
      const haystack = [
        item.domain,
        item.url,
        status,
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
        (!statusFilter || status === statusFilter) &&
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
      $("libraryCount").textContent = filtered.length
        ? `共 ${libraryItems.length} 条 · 筛选后 ${filtered.length} 条 · 已展示 ${shown.length} 条`
        : `共 ${libraryItems.length} 条 · 没有符合筛选的外链站`;
    }
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "没有符合筛选条件的外链站。调整筛选后重试。";
      el.append(empty);
      if ($("btnLibraryLoadMore")) $("btnLibraryLoadMore").hidden = true;
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
      const category = document.createElement("span");
      const status = item.annotation?.status || "";
      category.className = `library-status ${annotationTone(status)}`;
      category.textContent = annotationLabel(item.annotation?.status);
      category.setAttribute("aria-label", `站点状态：${annotationLabel(status)}`);
      head.append(title, category);

      const meta = document.createElement("div");
      meta.className = "library-meta";
      const sourceLabel = { saved: "自定义", table: "Google 表格", library: "内置" }[item.source] || "内置";
      meta.textContent = item.playbook
        ? `${sourceLabel} · ${item.platformType || "directory"} · 熟站 ${item.playbook.title}`
        : `${sourceLabel} · ${item.platformType || "directory"}`;
      if (item.playbook?.notes) meta.title = item.playbook.notes;
      const destinationLink = document.createElement("a");
      destinationLink.className = "library-destination-link";
      destinationLink.href = item.url;
      destinationLink.target = "_blank";
      destinationLink.rel = "noreferrer";
      destinationLink.textContent = item.url;

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

      const actions = document.createElement("div");
      actions.className = "library-item-actions";
      const pin = document.createElement("button");
      pin.type = "button";
      pin.className = "btn btn-secondary btn-sm";
      pin.textContent = "置顶";
      pin.setAttribute("aria-label", `置顶 ${item.domain || item.url}`);
      pin.addEventListener("click", async () => {
        const result = await chrome.runtime.sendMessage({ action: "pinLibraryUrl", url: item.url });
        if (!result?.ok) return alert(result?.error || "置顶失败");
        await loadLibrary();
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-danger btn-sm";
      remove.textContent = "删除";
      remove.setAttribute("aria-label", `删除 ${item.domain || item.url}`);
      remove.addEventListener("click", async () => {
        if (!confirm(`确认从队列删除 ${item.domain || item.url}？`)) return;
        const result = await chrome.runtime.sendMessage({
          action: "removeFromSubmissionQueue",
          url: item.url,
        });
        if (!result?.ok) return alert(result?.error || "删除失败");
        await loadLibrary();
      });
      const timeline = document.createElement("button");
      timeline.type = "button";
      timeline.className = "btn btn-primary btn-sm";
      timeline.textContent = `时间线${item.events?.length ? ` ${item.events.length}` : ""}`;
      timeline.setAttribute("aria-expanded", "false");
      const timelinePanel = document.createElement("div");
      timelinePanel.className = "timeline-panel";
      timelinePanel.hidden = true;
      timeline.addEventListener("click", () => {
        timelinePanel.hidden = !timelinePanel.hidden;
        timeline.setAttribute("aria-expanded", String(!timelinePanel.hidden));
        if (!timelinePanel.hidden) renderTimelinePanel(item, timelinePanel);
      });
      actions.append(timeline, pin, remove);
      card.append(head, destinationLink, meta, qualityRow);
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
        createActivityFact(
          "最近动态",
          item.latestEvent
            ? `${formatActivityTime(item.latestEvent.occurredAt)} · ${activityLabel(item.latestEvent.type || item.latestEvent.status)}`
            : item.time
              ? formatActivityTime(item.time)
              : "暂无记录",
        ),
      );
      card.append(activitySummary);
      const keyDetails = document.createElement("div");
      keyDetails.className = "library-key-details";
      if (item.record) keyDetails.append(createKeyDetail("记录", item.record));
      if (item.detail) keyDetails.append(createKeyDetail("备注 / 详情", item.detail));
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
      if (Object.keys(item.rawFields || {}).length) card.append(createSheetFieldsDetails(item));
      if (statuses.childNodes.length) card.append(statuses);
      card.append(actions, timelinePanel);
      el.append(card);
    }
    if ($("btnLibraryLoadMore")) {
      $("btnLibraryLoadMore").hidden = shown.length >= filtered.length;
      $("btnLibraryLoadMore").textContent = `加载更多（剩余 ${filtered.length - shown.length} 条）`;
    }
  }

  async function loadLibrary() {
    const result = await chrome.runtime.sendMessage({ action: "getLibraryManagerState" });
    if (!result?.ok) throw new Error(result?.error || "加载外链库失败");
    libraryItems = result.items || [];
    if (result.profiles && Object.keys(result.profiles).length) {
      const hadProfiles = Object.keys(siteProfiles).length > 0;
      siteProfiles = result.profiles;
      if (!activeSiteId || !siteProfiles[activeSiteId]) {
        activeSiteId = Object.keys(siteProfiles)[0] || "";
      }
      renderSiteSelector();
      if (!hadProfiles) loadActiveToForm();
    }
    renderLibrary();
  }

  function resetLibraryAndRender() {
    libraryVisibleLimit = LIBRARY_PAGE_SIZE;
    renderLibrary();
  }

  $("librarySearch")?.addEventListener("input", resetLibraryAndRender);
  $("libraryStatusFilter")?.addEventListener("change", resetLibraryAndRender);
  $("libraryProgressFilter")?.addEventListener("change", resetLibraryAndRender);
  $("libraryQualityFilter")?.addEventListener("change", resetLibraryAndRender);
  $("librarySort")?.addEventListener("change", resetLibraryAndRender);
  $("btnLibraryLoadMore")?.addEventListener("click", () => {
    libraryVisibleLimit += LIBRARY_PAGE_SIZE;
    renderLibrary();
  });

  function googleSheetValue() {
    return ($("googleSheetId")?.value || "").trim();
  }

  $("btnGoogleRefresh")?.addEventListener("click", async () => {
    setGooglePreview();
    try {
      await loadGoogleSyncStatus({ probeAgent: true });
    } catch (err) {
      setGoogleStatus(err.message, "warning");
    }
  });

  $("btnGoogleConnect")?.addEventListener("click", async () => {
    const btn = $("btnGoogleConnect");
    btn.disabled = true;
    setGooglePreview();
    setGoogleStatus("正在打开 Google 授权页…");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "googleAuthStart",
        spreadsheetId: googleSheetValue(),
      });
      if (!result?.ok) throw new Error(result?.error || "无法开始 Google 授权");
      setGoogleStatus("授权页已打开。完成授权后回到这里点击“刷新状态”。", "warning");
    } catch (err) {
      setGoogleStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnGooglePreview")?.addEventListener("click", async () => {
    const btn = $("btnGooglePreview");
    btn.disabled = true;
    setGooglePreview();
    setGoogleStatus("正在读取 Google Sheet，仅生成变更预览…");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "googleSyncPreview",
        spreadsheetId: googleSheetValue(),
      });
      if (!result?.ok) throw new Error(result?.error || "同步预览失败");
      setGooglePreview(result.preview);
      setGoogleStatus(
        result.preview?.conflicts?.length
          ? "预览完成，但存在冲突，未改动扩展数据。"
          : "检查完成。确认统计无误后更新本地缓存。",
        result.preview?.conflicts?.length ? "warning" : "success",
      );
    } catch (err) {
      setGoogleStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnGoogleCheckChanges")?.addEventListener("click", async () => {
    const btn = $("btnGoogleCheckChanges");
    btn.disabled = true;
    setGoogleStatus("正在检查表格版本变化…");
    try {
      const result = await chrome.runtime.sendMessage({ action: "googleCheckChanges" });
      if (!result?.ok) throw new Error(result?.error || "检查失败");
      if (result.changed) {
        setGooglePreview(result.preview);
        setGoogleStatus("检测到表格更新，请确认后更新本地缓存。", "warning");
      } else {
        setGooglePreview();
        setGoogleStatus("表格与插件运行缓存版本一致。", "success");
      }
    } catch (err) {
      setGoogleStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnGoogleSaveSchedule")?.addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({
      action: "googleSyncSchedule",
      enabled: $("googleAutoPreviewEnabled").checked,
      minutes: Number($("googleAutoPreviewMinutes").value || 60),
    });
    if (!result?.ok) return setGoogleStatus(result?.error || "保存检查频率失败", "warning");
    setGoogleStatus(`表格变化检查已保存：${result.autoPreviewEnabled ? `每 ${result.autoPreviewMinutes} 分钟` : "已关闭"}`, "success");
  });

  $("btnGoogleApply")?.addEventListener("click", async () => {
    if (!googlePreviewRevision) return;
    const btn = $("btnGoogleApply");
    btn.disabled = true;
    setGoogleStatus("正在把已确认的数据更新到本地缓存…");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "googleSyncApply",
        spreadsheetId: googleSheetValue(),
        revision: googlePreviewRevision,
      });
      if (!result?.ok) throw new Error(result?.error || "更新本地缓存失败");
      googlePreviewRevision = "";
      setGooglePreview();
      await loadLibrary();
      await loadGoogleSyncStatus();
      setGoogleStatus(
        `本地缓存已更新${result.pendingRecords ? ` · 有 ${result.pendingRecords} 条记录可单独回写 Google` : ""}。日常查看无需启动服务。`,
        "success",
      );
    } catch (err) {
      setGoogleStatus(err.message, "warning");
    }
  });

  $("btnGooglePush")?.addEventListener("click", async () => {
    const btn = $("btnGooglePush");
    btn.disabled = true;
    setGoogleStatus("正在回写待同步成功记录…");
    try {
      const result = await chrome.runtime.sendMessage({ action: "googlePushLedger" });
      if (!result?.ok) throw new Error(result?.error || "回写失败");
      await loadGoogleSyncStatus();
    } catch (err) {
      setGoogleStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnGoogleDisconnect")?.addEventListener("click", async () => {
    if (!confirm("断开本机 Google 授权？扩展内现有资料和提交账本不会删除。")) return;
    setGooglePreview();
    try {
      const result = await chrome.runtime.sendMessage({ action: "googleDisconnect" });
      if (!result?.ok) throw new Error(result?.error || "断开失败");
      await loadGoogleSyncStatus();
    } catch (err) {
      setGoogleStatus(err.message, "warning");
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
    const result = await chrome.runtime.sendMessage({
      action: "saveLinkMonitorSchedule",
      enabled: $("linkMonitorEnabled").checked,
      minutes: Number($("linkMonitorMinutes").value || 1440),
    });
    if (!result?.ok) return setStatusLine("linkMonitorStatus", result?.error || "保存失败", "warning");
    await loadLinkMonitorState();
  });

  $("btnExportLedger")?.addEventListener("click", async () => {
    const result = await chrome.runtime.sendMessage({ action: "exportSubmissionData" });
    if (!result?.ok) return alert(result?.error || "导出失败");
    const blob = new Blob([JSON.stringify(result.data, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `externallink-backup-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
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
          result?.error ? `Agent 报错：${result.error}` : "",
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
      const result = await chrome.runtime.sendMessage({ action: "listLocalSubmissionMedia" });
      if (!result?.ok) throw new Error(result?.error || "读取本地图库失败");
      if (!result.mediaRootExists) {
        setStatusLine("mediaLibraryStatus", `图库目录不存在：${result.mediaRoot}`, "warning");
        return;
      }
      const summary = (result.profiles || [])
        .map((entry) => {
          const logos = entry.files.filter((file) => file.kind === "logo").length;
          const shots = entry.files.filter((file) => file.kind === "screenshot").length;
          return `${entry.profile}（Logo ${logos} / 截图 ${shots}）`;
        })
        .join("，");
      setStatusLine(
        "mediaLibraryStatus",
        summary ? `${result.mediaRoot} → ${summary}` : `${result.mediaRoot} 下没有可用图片`,
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

  chrome.storage.local.get(
    [
      "siteProfiles",
      "activeSiteId",
      "cfgEmail",
      "cfgName",
      "cfgCommentTemplate",
      "cfgConcurrency",
      "cfgPingIndex",
      "autoOpenSidePanel",
      "autoFillOnVisit",
      "autoSubmitStandardWpComments",
    ],
    (items) => {
      siteProfiles = items.siteProfiles || {};
      activeSiteId = items.activeSiteId || Object.keys(siteProfiles)[0] || "";
      renderSiteSelector();
      loadActiveToForm();
      if (items.cfgEmail) $("cfgEmail").value = items.cfgEmail;
      if (items.cfgName) $("cfgName").value = items.cfgName;
      if (items.cfgCommentTemplate) $("cfgCommentTemplate").value = items.cfgCommentTemplate;
      if (items.cfgConcurrency) $("cfgConcurrency").value = items.cfgConcurrency;
      $("cfgPingIndex").checked = items.cfgPingIndex !== false;
      $("autoOpenSidePanel").checked = items.autoOpenSidePanel === true;
      $("autoFillOnVisit").checked = items.autoFillOnVisit !== false;
      if ($("autoSubmitStandardWpComments")) {
        $("autoSubmitStandardWpComments").checked = items.autoSubmitStandardWpComments === true;
      }
      loadLibrary()
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
          loadGoogleSyncStatus().catch((err) => setGoogleStatus(err.message, "warning"));
        });
      loadLinkMonitorState().catch((err) => setStatusLine("linkMonitorStatus", err.message, "warning"));
      loadTargetGateState().catch((err) => setStatusLine("targetGateStatus", err.message, "warning"));
    },
  );
})();

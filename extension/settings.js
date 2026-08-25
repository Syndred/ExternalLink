// ExternalLink Settings Page — site profiles & global config (persistent tab)
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const P = self.ExtLinkProfiles;

  let siteProfiles = {};
  let activeSiteId = "";
  let pendingLogoDataUrl = null;
  let libraryItems = [];
  let googlePreviewRevision = "";

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

  async function loadGoogleSyncStatus() {
    setGoogleStatus("正在检查本机 Agent 和 Google 授权…");
    const result = await chrome.runtime.sendMessage({ action: "googleSyncStatus" });
    if (!result?.ok) throw new Error(result?.error || "读取 Google 同步状态失败");
    if ($("googleSheetId") && result.spreadsheetId) {
      $("googleSheetId").value = result.spreadsheetId;
    }
    const agent = result.agent || {};
    if (result.agentError) {
      setGoogleStatus(`本机 Agent 未就绪：${result.agentError}`, "warning");
      return result;
    }
    const authenticated = agent.authenticated === true || agent.connected === true;
    const configured = agent.configured === true;
    const pending = Number(result.pendingRecords || 0);
    const syncedAt = result.meta?.appliedAt || result.meta?.fetchedAt || "";
    if (authenticated) {
      const details = [
        result.enabled ? "自动同步已启用" : "已授权，尚未应用同步",
        pending ? `待回写 ${pending} 条` : "无待回写记录",
        syncedAt ? `最近同步 ${new Date(syncedAt).toLocaleString()}` : "尚未同步",
      ];
      setGoogleStatus(details.join(" · "), result.enabled ? "success" : "warning");
    } else if (configured) {
      setGoogleStatus("本机配置已就绪，请点击“连接 Google”完成授权。", "warning");
    } else {
      setGoogleStatus(
        "本机 Agent 尚未配置 GOOGLE_SHEET_ID 和 GOOGLE_OAUTH_CLIENT_FILE。",
        "warning",
      );
    }
    return result;
  }

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      const panel = $(`panel-${tab.dataset.panel}`);
      panel?.classList.add("active");
    });
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

    const fields = {
      ...(existing.fields || {}),
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

  function renderLibrary() {
    const el = $("libraryList");
    if (!el) return;
    const query = ($("librarySearch")?.value || "").trim().toLowerCase();
    const statusFilter = $("libraryStatusFilter")?.value || "";
    const filtered = libraryItems.filter((item) => {
      const status = item.annotation?.status || "";
      const haystack = [
        item.domain,
        item.url,
        status,
        ...(item.profileStatuses || []).map((profile) => profile.profileName),
      ]
        .join(" ")
        .toLowerCase();
      return (!query || haystack.includes(query)) && (!statusFilter || status === statusFilter);
    });
    el.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "没有符合筛选条件的外链站。调整筛选后重试。";
      el.append(empty);
      return;
    }
    for (const item of filtered.slice(0, 300)) {
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
      meta.textContent = `${item.source === "saved" ? "自定义" : "内置"} · ${item.platformType || "directory"}`;

      const statuses = document.createElement("div");
      statuses.className = "profile-statuses";
      for (const profile of item.profileStatuses || []) {
        const chip = document.createElement("span");
        chip.className = profile.success ? "profile-status success" : "profile-status";
        chip.textContent = `${profile.profileName}: ${profile.success ? "已成功" : "未提交"}`;
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
      actions.append(pin, remove);
      card.append(head, meta, statuses, actions);
      el.append(card);
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

  $("librarySearch")?.addEventListener("input", renderLibrary);
  $("libraryStatusFilter")?.addEventListener("change", renderLibrary);

  function googleSheetValue() {
    return ($("googleSheetId")?.value || "").trim();
  }

  $("btnGoogleRefresh")?.addEventListener("click", async () => {
    setGooglePreview();
    try {
      await loadGoogleSyncStatus();
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
          : "预览完成。确认统计无误后再应用同步。",
        result.preview?.conflicts?.length ? "warning" : "success",
      );
    } catch (err) {
      setGoogleStatus(err.message, "warning");
    } finally {
      btn.disabled = false;
    }
  });

  $("btnGoogleApply")?.addEventListener("click", async () => {
    if (!googlePreviewRevision) return;
    const btn = $("btnGoogleApply");
    btn.disabled = true;
    setGoogleStatus("正在应用已预览的数据并回写待同步成功记录…");
    try {
      const result = await chrome.runtime.sendMessage({
        action: "googleSyncApply",
        spreadsheetId: googleSheetValue(),
        revision: googlePreviewRevision,
      });
      if (!result?.ok) throw new Error(result?.error || "应用同步失败");
      googlePreviewRevision = "";
      setGooglePreview();
      await loadLibrary();
      await loadGoogleSyncStatus();
      if (result.push?.ok === false) {
        setGoogleStatus(`资料已同步；账本暂存待重试：${result.push.error}`, "warning");
      }
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
      loadLibrary().catch((err) => {
        const el = $("libraryList");
        if (el) {
          el.replaceChildren();
          const empty = document.createElement("div");
          empty.className = "empty-state";
          empty.textContent = err.message;
          el.append(empty);
        }
      });
      loadGoogleSyncStatus().catch((err) => setGoogleStatus(err.message, "warning"));
    },
  );
})();

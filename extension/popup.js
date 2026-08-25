// ExternalLink Extension - Popup UI & State Management
(function () {
  "use strict";

  // ─── Tab Switching ───
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      document.getElementById("panel-" + t.dataset.panel).classList.add("active");
    });
  });

  // ─── DOM Refs ───
  const $ = (id) => document.getElementById(id);
  function bindClick(id, handler) {
    const el = $(id);
    if (el) el.addEventListener("click", handler);
  }
  const btnStart = $("btnStart");
  const btnStop = $("btnStop");
  const urlList = $("urlList");
  const taskList = $("taskList");
  const logEl = $("log");
  const targetDomain = $("targetDomain");
  const brandName = $("brandName");
  const anchorText = $("anchorText");
  const cfgEmail = $("cfgEmail");
  const cfgName = $("cfgName");
  const projectSelect = $("projectSelect");

  const PROJECT_PRESETS = {
    OldPhotoLive: {
      targetDomain: "https://oldphotoliveai.com",
      brandName: "OldPhotoLiveAI",
      anchorText: "OldPhotoLiveAI - AI Photo Restoration Tool",
      description: "AI-powered photo restoration tool that brings old photos back to life.",
    },
    TextComparison: {
      targetDomain: "https://www.comparison-text.site",
      brandName: "Comparison-Text",
      anchorText: "Comparison-Text - Free Online Text Comparison Tool",
      description: "Free online text comparison tool for writers, developers, and editors.",
    },
    GraffitiName: {
      targetDomain: "https://graffitinameai.com",
      brandName: "GraffitiNameAI",
      anchorText: "GraffitiNameAI - AI Graffiti Name Generator",
      description: "AI graffiti name generator for creative branding and design inspiration.",
    },
  };

  const LOCAL_AGENT_URL = "http://127.0.0.1:8787";

  // ─── Site Profiles ───
  let siteProfiles = {};
  let activeSiteId = "";
  let selectedSiteIds = [];

  function slugifySiteId(name) {
    const base = String(name || "site")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 40);
    return base || "site-" + Date.now().toString(36);
  }

  function linesToList(text) {
    return String(text || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function listToLines(items) {
    return Array.isArray(items) ? items.join("\n") : "";
  }

  function emptySiteProfile(id, name = "") {
    return {
      id,
      name: name || id,
      url: "",
      promoUrl: "",
      language: "auto",
      fields: {},
      anchorRules: {
        brandKeywords: [],
        urlKeywords: [],
        naturalExpressions: [],
        keywordExpressions: [],
        avoidWords: [],
        allowExactMatch: false,
      },
      blogRules: {
        tone: "helpful",
        maxLinksPerDraft: 1,
        preferredAnchor: "natural",
      },
      targetAudience: "",
      valueProposition: "",
      useCases: [],
      sellablePoints: [],
      avoidContent: [],
      updatedAt: new Date().toISOString(),
    };
  }

  function profileToForm(profile) {
    const f = profile.fields || {};
    $("siteExtractUrl").value = profile.url || f.Url || "";
    $("siteLanguage").value = profile.language || "auto";
    $("siteName").value = profile.name || f.Name || "";
    $("siteHomeUrl").value = profile.url || f.Url || "";
    $("sitePromoUrl").value = profile.promoUrl || profile.url || f.Url || "";
    $("siteTitle").value = f.Title || "";
    $("siteEmail").value = f["Business mail"] || "";
    $("siteShortDesc").value = f["Short description(20-30 words)"] || "";
    $("siteMediumDesc").value = f["Short Discription(100-150 words)"] || "";
    $("siteLongDesc").value = f["Long description (250-500 words)"] || "";
    $("siteNote").value = f.Note || "";
    $("siteAudience").value = profile.targetAudience || "";
    $("siteValueProp").value = profile.valueProposition || "";
    $("siteUseCases").value = listToLines(profile.useCases);
    $("siteTags").value = f["Tags Keywords/Hashtags"] || "";
    $("siteFeatures").value = f["Feature description"] || "";
    $("siteSellPoints").value = listToLines(profile.sellablePoints);
    $("sitePricing").value = f.Pricing || "";
    $("sitePricingType").value = f["PRICING TYPE"] || "";
    $("siteAvoidContent").value = listToLines(profile.avoidContent);
    const anchor = profile.anchorRules || {};
    $("siteBrandKeywords").value = listToLines(anchor.brandKeywords);
    $("siteUrlKeywords").value = listToLines(anchor.urlKeywords);
    $("siteNaturalExprs").value = listToLines(anchor.naturalExpressions);
    $("siteKeywordExprs").value = listToLines(anchor.keywordExpressions);
    $("siteAvoidWords").value = listToLines(anchor.avoidWords);
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
    const id = existingId || slugifySiteId(name || homeUrl || "site");

    const fields = {
      Name: name,
      Url: homeUrl,
      Title: ($("siteTitle").value || "").trim(),
      "Business mail": ($("siteEmail").value || "").trim(),
      Note: ($("siteNote").value || "").trim(),
      "Short description(20-30 words)": ($("siteShortDesc").value || "").trim(),
      "Short Discription(100-150 words)": ($("siteMediumDesc").value || "").trim(),
      "Long description (250-500 words)": ($("siteLongDesc").value || "").trim(),
      "Tags Keywords/Hashtags": ($("siteTags").value || "").trim(),
      "Feature description": ($("siteFeatures").value || "").trim(),
      Pricing: ($("sitePricing").value || "").trim(),
      "PRICING TYPE": ($("sitePricingType").value || "").trim(),
    };

    return {
      id,
      name: name || id,
      url: homeUrl,
      promoUrl,
      language: $("siteLanguage").value || "auto",
      fields,
      anchorRules: {
        brandKeywords: linesToList($("siteBrandKeywords").value),
        urlKeywords: linesToList($("siteUrlKeywords").value),
        naturalExpressions: linesToList($("siteNaturalExprs").value),
        keywordExpressions: linesToList($("siteKeywordExprs").value),
        avoidWords: linesToList($("siteAvoidWords").value),
        allowExactMatch: $("siteAllowExactAnchor").checked,
      },
      blogRules: {
        tone: $("siteBlogTone").value || "helpful",
        maxLinksPerDraft: parseInt($("siteMaxLinks").value, 10) || 1,
        preferredAnchor: $("sitePreferredAnchor").value || "natural",
      },
      targetAudience: ($("siteAudience").value || "").trim(),
      valueProposition: ($("siteValueProp").value || "").trim(),
      useCases: linesToList($("siteUseCases").value),
      sellablePoints: linesToList($("siteSellPoints").value),
      avoidContent: linesToList($("siteAvoidContent").value),
      updatedAt: new Date().toISOString(),
    };
  }

  function mergeExtractedProfile(current, extracted) {
    const merged = { ...current, ...extracted };
    merged.fields = { ...(current.fields || {}), ...(extracted.fields || {}) };
    merged.anchorRules = {
      ...(current.anchorRules || {}),
      ...(extracted.anchorRules || {}),
    };
    merged.blogRules = {
      ...(current.blogRules || {}),
      ...(extracted.blogRules || {}),
    };
    merged.useCases = extracted.useCases?.length ? extracted.useCases : current.useCases;
    merged.sellablePoints = extracted.sellablePoints?.length
      ? extracted.sellablePoints
      : current.sellablePoints;
    merged.avoidContent = extracted.avoidContent?.length
      ? extracted.avoidContent
      : current.avoidContent;
    if (extracted.fields?.Name) merged.name = extracted.fields.Name;
    if (extracted.fields?.Url) {
      merged.url = extracted.fields.Url;
      if (!merged.promoUrl) merged.promoUrl = extracted.fields.Url;
    }
    merged.id = current.id;
    merged.updatedAt = new Date().toISOString();
    return merged;
  }

  function renderSiteSelector() {
    const select = $("siteSelect");
    if (!select) return;
    const ids = Object.keys(siteProfiles);
    if (ids.length === 0) {
      select.innerHTML = '<option value="">暂无站点，点击 + 添加</option>';
      return;
    }
    select.innerHTML = ids
      .map((id) => {
        const p = siteProfiles[id];
        return `<option value="${id}"${id === activeSiteId ? " selected" : ""}>${p.name || id}</option>`;
      })
      .join("");
    if (activeSiteId && siteProfiles[activeSiteId]) {
      select.value = activeSiteId;
    } else if (ids.length) {
      activeSiteId = ids[0];
      select.value = activeSiteId;
    }
  }

  function persistSiteProfiles() {
    saveStorage({ siteProfiles, activeSiteId });
  }

  function loadActiveSiteToForm() {
    if (!activeSiteId || !siteProfiles[activeSiteId]) {
      profileToForm(emptySiteProfile("new"));
      return;
    }
    profileToForm(siteProfiles[activeSiteId]);
  }

  async function callLocalAgent(path, body) {
    const res = await fetch(`${LOCAL_AGENT_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `HTTP ${res.status}`);
    }
    return data;
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
    const anchorText = natural[0] || title || name;

    return {
      projectKey: profile.id,
      targetDomain: url,
      brandName: name,
      anchorText,
      email,
      username: cfgName?.value || name,
      commentTemplate: longDesc || shortDesc,
      tags: fields["Tags Keywords/Hashtags"] || "",
      pricing: fields.Pricing || "",
      anchorRules: profile.anchorRules || {},
      blogRules: profile.blogRules || {},
      targetAudience: profile.targetAudience || "",
      valueProposition: profile.valueProposition || "",
      useCases: profile.useCases || [],
      sellablePoints: profile.sellablePoints || [],
      avoidContent: profile.avoidContent || [],
      projectFields: fields,
    };
  }

  function findMatchingProfile(projectKey, profiles) {
    if (!projectKey) return null;
    const key = String(projectKey).trim();
    if (profiles[key]) return profiles[key];
    const lower = key.toLowerCase();
    for (const profile of Object.values(profiles)) {
      if (
        profile.id === key ||
        profile.name === key ||
        String(profile.name || "").toLowerCase() === lower ||
        String(profile.id || "").toLowerCase() === lower
      ) {
        return profile;
      }
    }
    const aliases = {
      oldphotolive: "OldPhotoLive",
      textcomparison: "TextComparison",
      graffitiname: "GraffitiName",
    };
    const alias = aliases[lower.replace(/[\s_-]/g, "")];
    if (alias && profiles[alias]) return profiles[alias];
    return null;
  }

  function applySavedProfilesToTasks(tasks, profiles) {
    if (!profiles || !Object.keys(profiles).length) return tasks;
    return tasks.map((task) => {
      const profile = findMatchingProfile(task.projectKey, profiles);
      if (!profile) return task;
      const config = buildAgentConfigFromProfile(profile);
      return {
        ...task,
        config: {
          ...(task.config || {}),
          ...config,
          projectFields: {
            ...((task.config && task.config.projectFields) || {}),
            ...config.projectFields,
          },
        },
      };
    });
  }

  function initSiteProfilesUI(items) {
    siteProfiles = items.siteProfiles || {};
    activeSiteId = items.activeSiteId || Object.keys(siteProfiles)[0] || "";
    renderSiteSelector();
    loadActiveSiteToForm();

    bindClick("btnAddSite", () => {
      const id = "site-" + Date.now().toString(36);
      siteProfiles[id] = emptySiteProfile(id, "新站点");
      activeSiteId = id;
      renderSiteSelector();
      loadActiveSiteToForm();
      persistSiteProfiles();
    });

    bindClick("btnRemoveSite", () => {
      if (!activeSiteId || !siteProfiles[activeSiteId]) return;
      if (!confirm(`确认移除站点「${siteProfiles[activeSiteId].name || activeSiteId}」？`)) return;
      delete siteProfiles[activeSiteId];
      activeSiteId = Object.keys(siteProfiles)[0] || "";
      renderSiteSelector();
      loadActiveSiteToForm();
      persistSiteProfiles();
    });

    $("siteSelect")?.addEventListener("change", () => {
      activeSiteId = $("siteSelect").value;
      loadActiveSiteToForm();
      persistSiteProfiles();
    });

    bindClick("btnSaveSite", () => {
      const profile = formToProfile(activeSiteId || undefined);
      if (!profile.name && !profile.url) {
        alert("请至少填写站点名称或首页地址");
        return;
      }
      activeSiteId = profile.id;
      siteProfiles[profile.id] = profile;
      renderSiteSelector();
      persistSiteProfiles();
      log(`已保存站点资料: ${profile.name}`, "ok");
      alert("✅ 站点资料已保存");
    });

    bindClick("btnExtractSite", async () => {
      const url = ($("siteExtractUrl").value || $("siteHomeUrl").value || "").trim();
      if (!url) {
        alert("请先输入网站地址");
        return;
      }
      const btn = $("btnExtractSite");
      btn.disabled = true;
      btn.textContent = "提取中…";
      try {
        const data = await callLocalAgent("/extract-site", {
          url,
          language: $("siteLanguage").value || "auto",
        });
        const current =
          activeSiteId && siteProfiles[activeSiteId]
            ? siteProfiles[activeSiteId]
            : emptySiteProfile(activeSiteId || slugifySiteId(url), "");
        const merged = mergeExtractedProfile(current, data.profile || {});
        profileToForm(merged);
        log(`AI 已从 ${url} 提取站点资料`, "ok");
      } catch (err) {
        log(`提取失败: ${err.message}`, "err");
        alert(`提取失败: ${err.message}\n\n请确认 local_agent 已启动且 DEEPSEEK_API_KEY 已配置`);
      } finally {
        btn.disabled = false;
        btn.textContent = "🔍 从网址提取资料";
      }
    });

    bindClick("btnGenerateSite", async () => {
      const btn = $("btnGenerateSite");
      btn.disabled = true;
      btn.textContent = "生成中…";
      try {
        const partial = formToProfile(activeSiteId || undefined);
        const data = await callLocalAgent("/generate-site", {
          profile: partial,
          language: $("siteLanguage").value || "auto",
        });
        const merged = mergeExtractedProfile(partial, data.profile || {});
        profileToForm(merged);
        log(`AI 已完善站点资料: ${merged.name || merged.id}`, "ok");
      } catch (err) {
        log(`生成失败: ${err.message}`, "err");
        alert(`生成失败: ${err.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = "✨ 基于当前资料生成";
      }
    });
  }

  // ─── State ───
  let tasks = [];
  let queueMeta = { fromTable: 0, fromPlugin: 0, total: 0 };
  let running = false;
  let stats = { done: 0, skip: 0, err: 0, total: 0, dofollow: 0, nofollow: 0 };
  const logLines = [];
  const storedLogLines = "logLines";
  const Q = self.ExtLinkQueue;

  // ─── Load/Save ───
  function loadStorage(keys, cb) {
    chrome.storage.local.get(keys, (items) => {
      if (chrome.runtime.lastError) return cb(null);
      cb(items);
    });
  }

  function saveStorage(obj) {
    chrome.storage.local.set(obj);
  }

  // Load persisted data
  loadStorage(
    [
      "targetDomain",
      "brandName",
      "anchorText",
      "cfgEmail",
      "cfgName",
      "cfgAutoSkipCaptcha",
      "cfgConcurrency",
      "cfgCommentTemplate",
      "cfgPingIndex",
      "cfgFillOnly",
      "cfgManualWaitSec",
      "projectKey",
      "urlList",
      "tasks",
      "stats",
      "running",
      storedLogLines,
      "siteProfiles",
      "activeSiteId",
      "selectedSiteIds",
    ],
    (items) => {
      if (!items) return;
      initSiteProfilesUI(items);
      selectedSiteIds = Array.isArray(items.selectedSiteIds)
        ? items.selectedSiteIds.filter((id) => items.siteProfiles?.[id])
        : [];
      if (!selectedSiteIds.length && items.activeSiteId) selectedSiteIds = [items.activeSiteId];
      if (items.projectKey && projectSelect) projectSelect.value = items.projectKey;
      if (items.targetDomain && targetDomain) targetDomain.value = items.targetDomain;
      if (items.brandName && brandName) brandName.value = items.brandName;
      if (items.anchorText && anchorText) anchorText.value = items.anchorText;
      if (items.cfgEmail && cfgEmail) cfgEmail.value = items.cfgEmail;
      if (items.cfgName && cfgName) cfgName.value = items.cfgName;
      if (items.urlList && urlList) urlList.value = items.urlList;
      if (items.tasks && items.tasks.length) {
        tasks = items.tasks;
        renderTasks();
      } else {
        refreshMergedQueue({ silent: true }).catch(() => {});
      }
      if (items.queueMeta) queueMeta = items.queueMeta;
      if (items.stats) {
        stats = items.stats;
        updateStats();
      }
      if (Array.isArray(items[storedLogLines])) {
        logLines.push(...items[storedLogLines].slice(-200));
        renderLog();
      }
      if (items.running) {
        setRunning(true, false);
        syncTasksFromBackground();
      }
      $("cfgAutoSkipCaptcha").checked = !!items.cfgAutoSkipCaptcha;
      $("cfgConcurrency").value = items.cfgConcurrency || "3";
      $("cfgCommentTemplate").value = items.cfgCommentTemplate || "";
      $("cfgPingIndex").checked = items.cfgPingIndex !== false;
      if ($("cfgFillOnly")) $("cfgFillOnly").checked = !!items.cfgFillOnly;
      if ($("cfgManualWaitSec")) $("cfgManualWaitSec").value = items.cfgManualWaitSec || "120";
      if (!items.targetDomain && items.projectKey && PROJECT_PRESETS[items.projectKey]) {
        applyProjectPreset(items.projectKey, false);
      }
    },
  );

  function applyProjectPreset(key, save = true) {
    const preset = PROJECT_PRESETS[key];
    if (!preset) return;
    if (targetDomain) targetDomain.value = preset.targetDomain;
    if (brandName) brandName.value = preset.brandName;
    if (anchorText) anchorText.value = preset.anchorText;
    if ($("cfgCommentTemplate") && !($("cfgCommentTemplate").value || "").trim()) {
      $("cfgCommentTemplate").value = preset.description;
    }
    if (save) {
      saveStorage({
        projectKey: key,
        targetDomain: preset.targetDomain,
        brandName: preset.brandName,
        anchorText: preset.anchorText,
        cfgCommentTemplate: $("cfgCommentTemplate").value,
      });
    }
  }

  if (projectSelect) {
    projectSelect.addEventListener("change", () => {
      const key = projectSelect.value;
      saveStorage({ projectKey: key });
      if (key !== "custom") applyProjectPreset(key);
    });
  }

  if ($("cfgFillOnly")) {
    $("cfgFillOnly").addEventListener("change", () => {
      saveStorage({ cfgFillOnly: $("cfgFillOnly").checked });
    });
  }

  // Auto-save on change
  [targetDomain, brandName, anchorText].filter(Boolean).forEach((el) => {
    el.addEventListener("change", () => {
      saveStorage({
        targetDomain: targetDomain ? targetDomain.value : "",
        brandName: brandName ? brandName.value : "",
        anchorText: anchorText ? anchorText.value : "",
      });
    });
  });
  if (urlList) {
    urlList.addEventListener("change", () => {
      saveStorage({ urlList: urlList.value });
      if (!running) {
        refreshMergedQueue({ silent: true }).catch(() => {});
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || running) return;
    if (changes.deletedSubmissionKeys || changes.siteAnnotations || changes.urlList) {
      refreshMergedQueue({ silent: true }).catch(() => {});
    }
  });

  // ─── Config Save ───
  bindClick("btnSaveConfig", () => {
    saveStorage({
      cfgEmail: cfgEmail.value,
      cfgName: cfgName.value,
      cfgAutoSkipCaptcha: $("cfgAutoSkipCaptcha").checked,
      cfgConcurrency: $("cfgConcurrency").value,
      cfgManualWaitSec: $("cfgManualWaitSec").value,
      cfgCommentTemplate: $("cfgCommentTemplate").value,
      cfgPingIndex: $("cfgPingIndex").checked,
    });
    alert("✅ 配置已保存");
  });

  bindClick("btnClearData", () => {
    if (confirm("确认清除所有数据？包括已提交记录和日志")) {
      chrome.storage.local.clear();
      tasks = [];
      stats = { done: 0, skip: 0, err: 0, total: 0, dofollow: 0, nofollow: 0 };
      logLines.length = 0;
      updateStats();
      renderTasks();
      renderLog();
      alert("已清除");
    }
  });

  bindClick("btnClearLog", () => {
    logLines.length = 0;
    saveStorage({ [storedLogLines]: [] });
    renderLog();
  });

  bindClick("btnLoadLibrary", () => {
    if (!urlList) return;
    const library = self.ExtLinkUrlLibrary || [];
    urlList.value = library.join("\n");
    saveStorage({ urlList: urlList.value });
    log(`已加载 ${library.length} 个外链库 URL 到手动列表`, "ok");
    refreshMergedQueue().catch((err) => log(`刷新合并队列失败: ${err.message}`, "err"));
  });

  bindClick("btnRefreshMerge", () => {
    refreshMergedQueue().catch((err) => {
      log(`刷新合并队列失败: ${err.message}`, "err");
      alert(err.message);
    });
  });

  // ─── Logging ───
  function log(msg, cls) {
    const time = new Date().toLocaleTimeString();
    logLines.push({ time, msg: formatAgentLog(msg), cls: cls || "" });
    if (logLines.length > 200) logLines.shift();
    saveStorage({ [storedLogLines]: logLines });
    renderLog();
  }

  function formatAgentLog(msg) {
    const text = String(msg || "");
    if (
      /DeepSeek local agent unavailable|local agent unavailable|127\.0\.0\.1:8787|ECONNREFUSED/i.test(
        text,
      )
    ) {
      return `${text} - 本地代理未运行：请在仓库根目录执行 python3 -m local_agent.server`;
    }
    if (/需要人工处理|needs_manual/i.test(text)) {
      return `${text} - needs_manual: 请查看前面的具体原因；可能是必填字段、图片上传、登录/验证码，或页面需要人工判断`;
    }
    if (/提交成功|judge success|success evidence|\/judge/i.test(text)) {
      return `${text} - /judge 已看到成功证据`;
    }
    return text;
  }

  function renderLog() {
    logEl.innerHTML = logLines
      .map((l) => `<div class="log-line${l.cls ? " " + l.cls : ""}">[${l.time}] ${l.msg}</div>`)
      .join("");
    logEl.scrollTop = logEl.scrollHeight;
  }

  // ─── Stats ───
  function updateStats() {
    const remaining = Math.max(0, stats.total - stats.done - stats.skip - stats.err);
    $("statQueue").textContent = remaining;
    $("statDone").textContent = stats.done;
    $("statSkip").textContent = stats.skip;
    $("statErr").textContent = stats.err;
    const pct = stats.total > 0 ? ((stats.done + stats.skip + stats.err) / stats.total) * 100 : 0;
    $("progressFill").style.width = pct + "%";
    saveStorage({ stats });
  }

  function persistTasks() {
    saveStorage({ tasks, queueMeta, stats });
  }

  function updateQueueMetaUI() {
    const el = $("queueMeta");
    if (el) {
      const excluded = queueMeta.excluded || 0;
      const excludedNote = excluded > 0 ? ` − 已排除 <b>${excluded}</b>` : "";
      el.innerHTML = `与侧边栏同步：表 <b>${queueMeta.fromTable || 0}</b> + 库 <b>${queueMeta.fromPlugin || 0}</b>${excludedNote} → 共 <b>${queueMeta.total || tasks.length}</b> 个可切换`;
    }
  }

  function updateQueueProgressUI() {
    const runningTask = tasks.find((t) => t.status === "running");
    const finished = tasks.filter((t) =>
      ["ok", "filled", "skip", "err", "blocked", "unavailable"].includes(t.status),
    );
    const prev = finished.length ? finished[finished.length - 1] : null;

    const nowEl = $("queueNow");
    if (nowEl) {
      nowEl.textContent = runningTask
        ? `当前：#${runningTask.index} ${runningTask.domain}${runningTask.projectKey ? ` · ${runningTask.projectKey}` : ""}`
        : running
          ? "当前：等待下一个任务…"
          : "当前：尚未开始";
    }

    const prevEl = $("queuePrev");
    if (prevEl) {
      prevEl.textContent = prev
        ? `上一个：#${prev.index} ${prev.domain} — ${statusLabel(prev.status)}`
        : "";
    }
  }

  // ─── Tasks ───
  function renderTasks() {
    const waiting = tasks.filter((t) => t.status === "captcha" || t.status === "needs_manual");
    if ($("btnContinue")) {
      $("btnContinue").style.display = waiting.length > 0 ? "block" : "none";
    }

    const runningIdx = tasks.findIndex((t) => t.status === "running");
    const finished = tasks.filter((t) =>
      ["ok", "filled", "skip", "err", "blocked", "unavailable"].includes(t.status),
    );
    const prev = finished.length ? finished[finished.length - 1] : null;

    taskList.innerHTML = tasks
      .map((t) => {
        const classes = ["task"];
        if (t.status === "running") classes.push("current");
        if (prev && t.index === prev.index && t.status !== "running") classes.push("prev-done");
        const source = t.source === "table" ? "表" : t.source === "library" ? "库" : "";
        return `<div class="${classes.join(" ")}" data-idx="${t.index}">
      <span class="idx">#${t.index}</span>
      <span class="domain">${t.domain}${t.projectKey ? ` · ${t.projectKey}` : ""}${source ? ` · ${source}` : ""}</span>
      <span class="status ${t.status}">${statusLabel(t.status)}</span>
    </div>`;
      })
      .join("");

    updateQueueMetaUI();
    updateQueueProgressUI();

    const scrollTarget =
      runningIdx >= 0 ? taskList.querySelector(`[data-idx="${tasks[runningIdx].index}"]`) : null;
    if (scrollTarget) scrollTarget.scrollIntoView({ block: "nearest" });
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
      blocked: "⛔停",
      unavailable: "⚠️代理",
    };
    return map[s] || s;
  }

  function buildRuntimeConfig() {
    return {
      autoSkipCaptcha: $("cfgAutoSkipCaptcha").checked,
      concurrency: Math.max(1, parseInt($("cfgConcurrency").value, 10) || 1),
      pingIndex: $("cfgPingIndex").checked,
      fillOnly: $("cfgFillOnly") ? $("cfgFillOnly").checked : false,
      manualWaitSec: parseInt($("cfgManualWaitSec") && $("cfgManualWaitSec").value, 10) || 120,
    };
  }

  async function refreshMergedQueue({ silent = false, resetStatus = true } = {}) {
    const result = await chrome.runtime.sendMessage({
      action: "getSubmissionQueue",
      selectedSiteIds,
    });
    if (!result?.ok || !result.tasks?.length) {
      throw new Error(
        "没有可提交的任务。请更新 Table.xlsx 后运行 python3 tools/import_table_xlsx.py，或在侧边栏标记/加载外链。",
      );
    }

    let nextTasks = result.tasks;
    if (!resetStatus && tasks.length) {
      const statusByKey = new Map(tasks.map((t) => [t.key || Q.normalizeUrlKey(t.url), t.status]));
      nextTasks = nextTasks.map((task) => ({
        ...task,
        status: statusByKey.get(task.key) || task.status,
      }));
    }

    tasks = nextTasks;
    queueMeta = result.meta || {
      fromTable: tasks.filter((t) => t.source === "table").length,
      fromPlugin: tasks.filter((t) => t.source === "library").length,
      total: tasks.length,
      excluded: 0,
    };
    queueMeta = {
      ...queueMeta,
      total: result.meta?.destinationTotal ?? tasks.length,
    };
    stats = { done: 0, skip: 0, err: 0, total: tasks.length, dofollow: 0, nofollow: 0 };
    updateStats();
    renderTasks();
    persistTasks();

    if (!silent) {
      const excluded = queueMeta.excluded ? `，已排除 ${queueMeta.excluded} 个删除/跳过` : "";
      log(
        `待提交队列：表格 ${queueMeta.fromTable} + 外链库 ${queueMeta.fromPlugin}${excluded} = 共 ${queueMeta.total} 个`,
        "ok",
      );
    }
    return { tasks, meta: queueMeta };
  }

  async function syncTasksFromBackground() {
    try {
      const state = await chrome.runtime.sendMessage({ action: "getState" });
      if (!state || !state.tasks?.length) return;
      tasks = state.tasks;
      if (state.stats) stats = state.stats;
      updateStats();
      renderTasks();
      persistTasks();
    } catch {
      /* background may be unavailable */
    }
  }

  // ─── Run Control ───
  if (btnStart)
    btnStart.addEventListener("click", async () => {
      if (running) return;

      try {
        if (!tasks.length) {
          await refreshMergedQueue({ silent: true });
        }
      } catch (err) {
        log(`合并队列失败: ${err.message}`, "err");
        alert(err.message);
        return;
      }

      tasks = tasks.map((t) => ({ ...t, status: "pending" }));
      stats = { done: 0, skip: 0, err: 0, total: tasks.length, dofollow: 0, nofollow: 0 };
      updateStats();
      renderTasks();
      persistTasks();
      log(`开始提交 ${tasks.length} 个合并后的外链目标`, "ok");

      setRunning(true);
      const result = await chrome.runtime.sendMessage({
        action: "start",
        selectedSiteIds,
        config: buildRuntimeConfig(),
      });
      if (!result?.ok) throw new Error(result?.error || "启动失败");
      tasks = result.tasks || [];
      stats = { done: 0, skip: 0, err: 0, total: tasks.length, dofollow: 0, nofollow: 0 };
      updateStats();
      renderTasks();
      log("任务已发送到后台，可在任务栏查看实时进度", "ok");
    });

  bindClick("btnContinue", async () => {
    const waiting = tasks.filter((t) => t.status === "captcha");
    if (waiting.length === 0) return alert("当前没有等待人工确认的任务");
    const task = waiting[waiting.length - 1];
    await chrome.runtime.sendMessage({
      action: "manualContinue",
      taskIndex: task.index,
      platformType: task.platformType,
    });
    log(`已请求继续任务 #${task.index} ${task.domain} [${task.projectKey || ""}]`, "ok");
  });

  if (btnStop)
    btnStop.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ action: "stop" });
      setRunning(false);
      log("已请求停止", "warn");
    });

  function setRunning(r, save = true) {
    running = r;
    btnStart.style.display = r ? "none" : "block";
    btnStop.style.display = r ? "block" : "none";
    if (save) saveStorage({ running: r });
  }

  // ─── Background Messages ───
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg.action === "taskUpdate") {
      const t = tasks.find((x) => x.index === msg.index);
      if (t) {
        t.status = msg.status;
        if (msg.status === "ok" || msg.status === "filled") {
          stats.done++;
          if (msg.isDofollow) stats.dofollow++;
          else stats.nofollow++;
        } else if (msg.status === "skip") stats.skip++;
        else if (msg.status === "err") stats.err++;
        updateStats();
        renderTasks();
        persistTasks();
      }
    }
    if (msg.action === "log") {
      log(msg.msg, msg.cls);
    }
    if (msg.action === "status") {
      setRunning(msg.running);
    }
    if (msg.action === "progress") {
      stats = msg.stats;
      updateStats();
    }
  });

  // ─── Helpers ───
  function extractDomain(url) {
    try {
      return new URL(url.startsWith("http") ? url : "https://" + url).hostname;
    } catch (e) {
      return url;
    }
  }

  function generateEmail() {
    const base = "user" + Date.now().toString(36);
    return base + "@gmail.com";
  }

  function generateName() {
    const first = [
      "Alex",
      "Jordan",
      "Taylor",
      "Morgan",
      "Casey",
      "Riley",
      "Quinn",
      "Avery",
      "Blake",
      "Drew",
    ];
    const last = [
      "Johnson",
      "Williams",
      "Brown",
      "Davis",
      "Wilson",
      "Moore",
      "Clark",
      "Lewis",
      "Walker",
      "Allen",
    ];
    return first[Math.floor(Math.random() * 10)] + " " + last[Math.floor(Math.random() * 10)];
  }

  // Init log
  log("ExternalLink 外链提交扩展已就绪", "ok");
  log("用法：刷新合并队列 → 查看任务栏 → 启动 local_agent → 开始提交", "");
})();

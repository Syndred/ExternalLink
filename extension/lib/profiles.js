// Shared site profile helpers for settings, side panel, and background.
(function (global) {
  "use strict";

  const LOCAL_AGENT_URL = "http://127.0.0.1:8787";

  function linesToList(text) {
    return String(text || "")
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function listToLines(items) {
    return Array.isArray(items) ? items.join("\n") : "";
  }

  function slugifySiteId(name) {
    const base = String(name || "site")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .slice(0, 40);
    return base || "site-" + Date.now().toString(36);
  }

  function canonicalProfileId(value) {
    const token = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    const aliases = {
      oldphotolive: "OldPhotoLive",
      oldphotoliveai: "OldPhotoLive",
      rainbowpetai: "RainbowPetAI",
      rspai: "RspAi",
      textcomparison: "TextComparison",
      comparisontext: "TextComparison",
      graffitiname: "GraffitiName",
      graffitinameai: "GraffitiName",
    };
    return aliases[token] || "";
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

  function buildAgentConfigFromProfile(profile, globalConfig = {}) {
    const fields = profile.fields || {};
    const name = fields.Name || profile.name || "";
    const url = profile.promoUrl || profile.url || fields.Url || "";
    const email = fields["Business mail"] || globalConfig.email || "";
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
      username: globalConfig.username || name,
      commentTemplate: globalConfig.commentTemplate || longDesc || shortDesc,
      tags: fields["Tags Keywords/Hashtags"] || "",
      pricing: fields.Pricing || "",
      launchDate: fields["Launch Date"] || fields["Launch date"] || "",
      featuredImage: fields["Featured image"] || profile.logoUrl || fields.LOGO || "",
      logoUrl: profile.logoUrl || fields.LOGO || fields["Featured image"] || "",
      logoDataUrl: profile.logoDataUrl || "",
      screenshots:
        profile.media?.screenshots ||
        [1, 2, 3, 4]
          .map(
            (index) =>
              fields[`Screenshot ${index}`] || fields[`Screenshot-${index}`] || "",
          )
          .filter(Boolean),
      learnedFieldMappings: profile.learnedFieldMappings || {},
      anchorRules: profile.anchorRules || {},
      blogRules: profile.blogRules || {},
      targetAudience: profile.targetAudience || "",
      valueProposition: profile.valueProposition || "",
      useCases: profile.useCases || [],
      sellablePoints: profile.sellablePoints || [],
      avoidContent: profile.avoidContent || [],
      projectFields: fields,
      fillOnly: globalConfig.fillOnly !== false,
    };
  }

  function getScreenshotValuesFromConfig(config) {
    const fields = config?.projectFields || {};
    const configured = Array.isArray(config?.screenshots) ? config.screenshots : [];
    const values = configured.length
      ? configured
      : [1, 2, 3, 4].map(
          (index) =>
            fields[`Screenshot ${index}`] || fields[`Screenshot-${index}`] || "",
        );
    return values.map((value) => String(value || "").trim()).filter(Boolean);
  }

  function resolveMediaField(config, hint, fallbackScreenshotIndex = 0) {
    const fields = config?.projectFields || {};
    const normalizedHint = String(hint || "").toLowerCase();
    const screenshotField =
      /\b(screenshot|screen shot|gallery|product image|app image|interface image)\b/.test(
        normalizedHint,
      );
    if (screenshotField) {
      const screenshots = getScreenshotValuesFromConfig(config);
      const explicit = normalizedHint.match(
        /\b(?:screenshot|screen shot|gallery|image|photo)[^\d]{0,8}([1-4])\b/,
      );
      const index = explicit ? Number(explicit[1]) - 1 : fallbackScreenshotIndex;
      return {
        value: screenshots[index] || screenshots[fallbackScreenshotIndex] || "",
        profileKey: `Screenshot ${index + 1}`,
        useLogoDataUrl: false,
        screenshot: true,
        explicitIndex: !!explicit,
      };
    }
    if (/\b(logo|icon|avatar)\b/.test(normalizedHint)) {
      return {
        value:
          fields.LOGO ||
          config?.logoUrl ||
          fields["Featured image"] ||
          config?.featuredImage ||
          "",
        profileKey: "LOGO",
        useLogoDataUrl: true,
        screenshot: false,
        explicitIndex: false,
      };
    }
    if (/\b(featured|cover|banner|thumbnail|image|photo)\b/.test(normalizedHint)) {
      return {
        value:
          fields["Featured image"] ||
          config?.featuredImage ||
          config?.logoUrl ||
          fields.LOGO ||
          "",
        profileKey: "Featured image",
        useLogoDataUrl: false,
        screenshot: false,
        explicitIndex: false,
      };
    }
    return {
      value: "",
      profileKey: "",
      useLogoDataUrl: false,
      screenshot: false,
      explicitIndex: false,
    };
  }

  function findMatchingProfile(projectKey, profiles) {
    if (!projectKey || !profiles) return null;
    const key = String(projectKey).trim();
    if (profiles[key]) return profiles[key];
    const lower = key.toLowerCase();
    const canonicalKey = canonicalProfileId(key);
    for (const profile of Object.values(profiles)) {
      if (
        profile.id === key ||
        profile.name === key ||
        String(profile.name || "").toLowerCase() === lower ||
        String(profile.id || "").toLowerCase() === lower ||
        (canonicalKey &&
          [profile.id, profile.name].some(
            (value) => canonicalProfileId(value) === canonicalKey,
          ))
      ) {
        return profile;
      }
    }
    const aliases = {
      oldphotolive: "OldPhotoLive",
      rainbowpetai: "RainbowPetAI",
      rspai: "RspAi",
      textcomparison: "TextComparison",
      graffitiname: "GraffitiName",
    };
    const alias = aliases[lower.replace(/[\s_-]/g, "")];
    if (alias && profiles[alias]) return profiles[alias];
    return null;
  }

  function stabilizeTableProfiles(tableProjects, storedProfiles) {
    const profiles = { ...(storedProfiles || {}) };
    const idRemap = {};
    let changed = false;

    for (const [projectKey, fields] of Object.entries(tableProjects || {})) {
      const canonicalKey = canonicalProfileId(projectKey) || projectKey;
      const matches = Object.entries(profiles).filter(
        ([id, profile]) =>
          id === projectKey ||
          canonicalProfileId(id) === canonicalKey ||
          canonicalProfileId(profile?.name) === canonicalKey,
      );
      const stableProfile = profiles[projectKey];
      const legacyMatches = matches.filter(([id]) => id !== projectKey);
      if (stableProfile && legacyMatches.length === 0) continue;
      const userProfile =
        matches
          .map(([, profile]) => profile)
          .find((profile) => profile?.source !== "table") || matches[0]?.[1];
      const preferred = userProfile || stableProfile;
      const next = preferred
        ? {
            ...preferred,
            id: projectKey,
            fields: { ...(fields || {}), ...(preferred.fields || {}) },
          }
        : {
            ...emptySiteProfile(projectKey, fields?.Name || projectKey),
            id: projectKey,
            name: fields?.Name || projectKey,
            url: fields?.Url || "",
            promoUrl: fields?.Url || "",
            fields: { ...(fields || {}) },
            source: "table",
          };

      for (const [id] of matches) {
        if (id === projectKey) continue;
        idRemap[id] = projectKey;
        delete profiles[id];
        changed = true;
      }
      changed = true;
      profiles[projectKey] = next;
    }

    return { profiles, idRemap, changed };
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

  function mergeExtractedProfile(current, extracted) {
    const merged = { ...current, ...extracted };
    merged.fields = { ...(current.fields || {}), ...(extracted.fields || {}) };
    merged.anchorRules = { ...(current.anchorRules || {}), ...(extracted.anchorRules || {}) };
    merged.blogRules = { ...(current.blogRules || {}), ...(extracted.blogRules || {}) };
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
    if (current.logoDataUrl && !extracted.logoDataUrl) merged.logoDataUrl = current.logoDataUrl;
    merged.id = current.id;
    merged.updatedAt = new Date().toISOString();
    return merged;
  }

  async function callLocalAgent(path, body) {
    const res = await fetch(`${LOCAL_AGENT_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
    return data;
  }

  function getActiveProfile(storage) {
    const profiles = storage.siteProfiles || {};
    const activeId = storage.activeSiteId || Object.keys(profiles)[0] || "";
    return activeId && profiles[activeId] ? profiles[activeId] : null;
  }

  function profileConfigured(profile) {
    if (!profile) return false;
    const f = profile.fields || {};
    return !!(profile.name || f.Name || profile.url || f.Url);
  }

  global.ExtLinkProfiles = {
    LOCAL_AGENT_URL,
    linesToList,
    listToLines,
    slugifySiteId,
    canonicalProfileId,
    emptySiteProfile,
    buildAgentConfigFromProfile,
    getScreenshotValuesFromConfig,
    resolveMediaField,
    findMatchingProfile,
    stabilizeTableProfiles,
    applySavedProfilesToTasks,
    mergeExtractedProfile,
    callLocalAgent,
    getActiveProfile,
    profileConfigured,
  };
})(typeof self !== "undefined" ? self : window);

// Shared site profile helpers for settings, side panel, and background.
(function (global) {
  "use strict";

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
      rainbowpet: "RainbowPetAI",
      rspai: "RspAi",
      textcomparison: "TextComparison",
      comparisontext: "TextComparison",
      graffitiname: "GraffitiName",
      graffitinameai: "GraffitiName",
      jevplay: "JevPlay",
      jev: "JevPlay",
      typesafejev: "JevPlay",
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
    const storedFields = profile.fields || {};
    // This old Graffiti contact domain has no MX record. Keep an already
    // synced Profile intact, but never send another directory a dead address.
    const fields = profile.id === "GraffitiName" &&
      /^support@graffitinameai\.com$/i.test(String(storedFields["Business mail"] || "").trim())
      ? {
          ...storedFields,
          "Business mail": "syndredyoung@gmail.com",
          "Feedback mail": "syndredyoung@gmail.com",
        }
      : storedFields;
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
      commentTemplate:
        globalConfig.applyCommentTemplate === true && globalConfig.commentTemplate
          ? globalConfig.commentTemplate
          : longDesc || shortDesc,
      tags: fields["Tags Keywords/Hashtags"] || "",
      pricing: fields.Pricing || "",
      launchDate: fields["Launch Date"] || fields["Launch date"] || "",
      featuredImage:
        fields["Cloud Featured image"] ||
        profile.media?.featured ||
        fields["Featured image"] ||
        profile.logoUrl ||
        fields.LOGO ||
        "",
      logoUrl:
        fields["Cloud LOGO"] || profile.media?.logo || profile.logoUrl || fields.LOGO || fields["Featured image"] || "",
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
      fillOnly: globalConfig.fillOnly === true,
    };
  }

  const FILL_RUNTIME_KEYS = [
    "autoSkipCaptcha",
    "fillOnly",
    "autoSubmitDirectory",
    "autoSubmitStandardWpComments",
    "manualWaitSec",
    "pingIndex",
    "concurrency",
    "useAgent",
  ];

  const PRODUCT_IDENTITY_KEYS = [
    "projectKey",
    "brandName",
    "targetDomain",
    "anchorText",
    "commentTemplate",
    "projectFields",
    "tags",
    "pricing",
    "launchDate",
    "featuredImage",
    "logoUrl",
    "logoDataUrl",
    "screenshots",
    "learnedFieldMappings",
    "anchorRules",
    "blogRules",
    "targetAudience",
    "valueProposition",
    "useCases",
    "sellablePoints",
    "avoidContent",
  ];

  function pickKeys(source, keys) {
    const out = {};
    if (!source || typeof source !== "object") return out;
    for (const key of keys) {
      if (source[key] !== undefined) out[key] = source[key];
    }
    return out;
  }

  function omitKeys(source, keys) {
    const skip = new Set(keys);
    const out = {};
    if (!source || typeof source !== "object") return out;
    for (const [key, value] of Object.entries(source)) {
      if (!skip.has(key)) out[key] = value;
    }
    return out;
  }

  function normalizeIdentityUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw.includes("://") ? raw : `https://${raw.replace(/^\/+/, "")}`);
      return `${url.hostname.replace(/^www\./i, "").toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      return raw
        .replace(/^https?:\/\//i, "")
        .replace(/^www\./i, "")
        .replace(/\/+$/, "")
        .toLowerCase();
    }
  }

  function mergeFillConfig(runtimeConfig = {}, profileConfig = {}, extraConfig = {}) {
    const runtime = pickKeys(runtimeConfig, FILL_RUNTIME_KEYS);
    const extraRuntime = pickKeys(extraConfig, FILL_RUNTIME_KEYS);
    const extraRest = omitKeys(extraConfig, [...FILL_RUNTIME_KEYS, ...PRODUCT_IDENTITY_KEYS]);
    const fillOnly = extraRuntime.fillOnly === true || runtime.fillOnly === true;
    const autoSubmitDirectory =
      extraRuntime.autoSubmitDirectory !== undefined
        ? extraRuntime.autoSubmitDirectory !== false && !fillOnly
        : runtime.autoSubmitDirectory !== false && !fillOnly;
    return {
      ...profileConfig,
      ...extraRest,
      ...runtime,
      ...extraRuntime,
      projectKey: profileConfig.projectKey || "",
      brandName: profileConfig.brandName || "",
      targetDomain: profileConfig.targetDomain || "",
      anchorText: profileConfig.anchorText || "",
      commentTemplate: profileConfig.commentTemplate || "",
      projectFields: profileConfig.projectFields || {},
      tags: profileConfig.tags || "",
      pricing: profileConfig.pricing || "",
      launchDate: profileConfig.launchDate || "",
      featuredImage: profileConfig.featuredImage || "",
      logoUrl: profileConfig.logoUrl || "",
      logoDataUrl: profileConfig.logoDataUrl || "",
      screenshots: profileConfig.screenshots || [],
      learnedFieldMappings: profileConfig.learnedFieldMappings || {},
      anchorRules: profileConfig.anchorRules || {},
      blogRules: profileConfig.blogRules || {},
      targetAudience: profileConfig.targetAudience || "",
      valueProposition: profileConfig.valueProposition || "",
      useCases: profileConfig.useCases || [],
      sellablePoints: profileConfig.sellablePoints || [],
      avoidContent: profileConfig.avoidContent || [],
      fillOnly,
      autoSubmitDirectory,
      autoSubmitStandardWpComments:
        extraRuntime.autoSubmitStandardWpComments === true ||
        runtime.autoSubmitStandardWpComments === true,
    };
  }

  function fillIdentityMismatch(config, profile) {
    if (!config || !profile) return "missing_profile";
    const expectedKey = String(profile.id || "").trim();
    if (expectedKey && config.projectKey && String(config.projectKey) !== expectedKey) {
      return "projectKey";
    }
    const expectedName = String(profile.fields?.Name || profile.name || "").trim();
    const actualName = String(config.brandName || "").trim();
    if (expectedName && actualName && expectedName !== actualName) return "brandName";
    const expectedUrl = normalizeIdentityUrl(
      profile.promoUrl || profile.url || profile.fields?.Url || "",
    );
    const actualUrl = normalizeIdentityUrl(config.targetDomain || config.projectFields?.Url || "");
    if (expectedUrl && actualUrl && expectedUrl !== actualUrl) return "targetDomain";
    return "";
  }

  function taskConfigIdentityMismatch(task, config) {
    if (!task || !config) return "missing_task";
    return fillIdentityMismatch(config, {
      id: task.profileId || task.projectKey || task.config?.projectKey || "",
      name: task.profileName || task.config?.brandName || "",
      promoUrl: task.config?.targetDomain || "",
      url: task.config?.targetDomain || "",
      fields: {
        Name: task.config?.brandName || task.profileName || "",
        Url: task.config?.targetDomain || "",
        ...((task.config && task.config.projectFields) || {}),
      },
    });
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
      // A profile's legacy Screenshot fields may contain example output art.
      // Upload only private cloud screenshots or URLs clearly naming a UI capture.
      const screenshots = getScreenshotValuesFromConfig(config).filter((value) =>
        /^cloud-media:\/\//i.test(value) ||
        /(?:^|[\/_-])(?:screenshots?|screen[-_]?shots?|screen|dashboard|editor|homepage|home|ui)(?=[\/_.-]|$)/i.test(value));
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
        index,
      };
    }
    if (/\b(logo|icon|avatar)\b/.test(normalizedHint)) {
      return {
        value:
          fields["Cloud LOGO"] ||
          config?.logoUrl ||
          config?.cloudLogo ||
          fields["Cloud Featured image"] ||
          config?.featuredImage ||
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
      rainbowpet: "RainbowPetAI",
      rspai: "RspAi",
      textcomparison: "TextComparison",
      graffitiname: "GraffitiName",
      jevplay: "JevPlay",
      jev: "JevPlay",
      typesafejev: "JevPlay",
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

  const REUSABLE_PROFILE_KEYS = new Set([
    "Name",
    "Url",
    "Title",
    "Business mail",
    "Note",
    "Short description(20-30 words)",
    "Short Discription(100-150 words)",
    "Long description (250-500 words)",
    "Tags Keywords/Hashtags",
    "Feature description",
    "Pricing",
    "PRICING TYPE",
    "Discord",
    "Twitter",
    "GitHub",
    "LinkedIn",
    "Slack",
    "YouTube",
    "Telegram",
    "Instagram",
    "Facebook",
    "Product Hunt",
    "Founded year",
    "Integration list",
    "Alternative to",
    "API docs",
    "Changelog",
    "Founder",
  ]);

  const SITE_SPECIFIC_FIELD =
    /\b(captcha|password|otp|verify|verification|agree|terms|privacy|consent|newsletter|subscribe|comment|message|username|login|sign[\s-]?in|how did you hear|hear about us|referr|utm|traffic source|referral source|lead source|category|categories|listing type|directory|topic|coupon|promo code)\b/;

  const REUSABLE_FIELD_ALIASES = [
    { key: "Discord", pattern: /\bdiscord\b/ },
    { key: "Twitter", pattern: /\b(twitter|\bx\b|x\.com)\b/ },
    { key: "GitHub", pattern: /\bgithub\b/ },
    { key: "LinkedIn", pattern: /\blinkedin\b/ },
    { key: "Slack", pattern: /\bslack\b/ },
    { key: "YouTube", pattern: /\byoutube\b/ },
    { key: "Telegram", pattern: /\btelegram\b/ },
    { key: "Instagram", pattern: /\binstagram\b/ },
    { key: "Facebook", pattern: /\bfacebook\b/ },
    { key: "Product Hunt", pattern: /\bproduct\s*hunt\b/ },
    { key: "Founded year", pattern: /\b(founded year|year founded|founding year|established)\b/ },
    { key: "Integration list", pattern: /\bintegration(s| list)?\b/ },
    { key: "Alternative to", pattern: /\balternative(s| to)?\b/ },
    { key: "API docs", pattern: /\bapi\s*(docs?|documentation|reference)\b/ },
    { key: "Changelog", pattern: /\bchange\s*log\b/ },
    { key: "Founder", pattern: /\b(founder|maker)\b/ },
  ];

  function normalizeFieldHint(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/[:*]+$/g, "")
      .replace(/[^a-z0-9\s./+-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function isSiteSpecificField(label = "", profileKey = "") {
    const known = String(profileKey || "").trim();
    if (known === "category" || known === "select" || known === "username") return true;
    const hint = `${normalizeFieldHint(label)} ${normalizeFieldHint(known)}`.trim();
    return SITE_SPECIFIC_FIELD.test(hint);
  }

  function matchExistingFieldKey(label, existingKeys = []) {
    const norm = normalizeFieldHint(label);
    if (!norm) return "";
    const keys = Array.isArray(existingKeys) ? existingKeys : Object.keys(existingKeys || {});
    for (const key of keys) {
      if (normalizeFieldHint(key) === norm) return key;
    }
    const tokens = new Set(norm.split(/\s+/).filter((token) => token.length > 2));
    if (!tokens.size) return "";
    for (const key of keys) {
      const keyTokens = new Set(
        normalizeFieldHint(key)
          .split(/\s+/)
          .filter((token) => token.length > 2),
      );
      if (!keyTokens.size) continue;
      if ([...keyTokens].every((token) => tokens.has(token))) return key;
      if ([...tokens].every((token) => keyTokens.has(token))) return key;
    }
    return "";
  }

  function stableFieldKeyFromLabel(label) {
    const cleaned = String(label || "")
      .replace(/[:*]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || cleaned.length > 80) return "";
    if (/^(other|please specify|additional info|notes?|details?)$/i.test(cleaned)) return "";
    return cleaned.replace(/\b[a-z]/g, (char) => char.toUpperCase()).slice(0, 80);
  }

  function looksReusableProductField(label = "", value = "") {
    const hint = normalizeFieldHint(label);
    const text = String(value || "").trim();
    if (!hint || !text || isSiteSpecificField(label)) return false;
    if (REUSABLE_FIELD_ALIASES.some((alias) => alias.pattern.test(hint))) return true;
    if (/^https?:\/\//i.test(text) && /\b(url|link|profile|page|community|docs?)\b/.test(hint)) {
      return true;
    }
    if (/^\d{4}$/.test(text) && /found|establish|launch year|year/.test(hint)) return true;
    if (
      text.length >= 2 &&
      text.length <= 500 &&
      /^[a-z][a-z0-9 /&+_.-]{1,60}$/i.test(String(label || "").trim()) &&
      !/^(what|which|how|please|select|choose|pick)\b/.test(hint)
    ) {
      return true;
    }
    return false;
  }

  function inferReusableProfileKey(label = "", profileKey = "", existingKeys = [], value = "") {
    const known = String(profileKey || "").trim();
    const hint = `${normalizeFieldHint(label)} ${normalizeFieldHint(known)}`.trim();
    if (isSiteSpecificField(label, known)) return "";
    if (REUSABLE_PROFILE_KEYS.has(known)) return known;
    if (/\b(e-?mail|business mail|contact mail)\b/.test(hint)) return "Business mail";
    if (/\b(tool name|product name|app name|startup name|company name|brand name)\b/.test(hint)) {
      return "Name";
    }
    if (/\b(website|homepage|product url|tool url|official (site|url))\b/.test(hint)) return "Url";
    if (/\b(tagline|one.?liner|elevator pitch|short description|short desc)\b/.test(hint)) {
      return "Short description(20-30 words)";
    }
    if (/\b(long description|detailed description|about the (tool|product))\b/.test(hint)) {
      return "Long description (250-500 words)";
    }
    if (/\b(description|summary|about)\b/.test(hint)) return "Short Discription(100-150 words)";
    if (/\b(title|headline|subject)\b/.test(hint)) return "Title";
    if (/\b(tags|keywords|hashtags)\b/.test(hint) && !/\bcategor/.test(hint)) {
      return "Tags Keywords/Hashtags";
    }
    if (/\b(feature description|features|what (it|the tool) does)\b/.test(hint)) {
      return "Feature description";
    }
    if (/\b(pricing type|price type|billing type)\b/.test(hint)) return "PRICING TYPE";
    if (/\b(pricing|price|cost)\b/.test(hint)) return "Pricing";
    const alias = REUSABLE_FIELD_ALIASES.find((item) => item.pattern.test(hint));
    if (alias) return alias.key;
    const existing = matchExistingFieldKey(label, existingKeys);
    if (existing) return existing;
    if (looksReusableProductField(label, value)) return stableFieldKeyFromLabel(label);
    return "";
  }

  function isReusableFillValue(key, mapping = {}) {
    const value = String(mapping.value || "").trim();
    if (!key || !value) return false;
    if (value.length > 2000) return false;
    if (/^(on|off|true|false|yes|no|1|0)$/i.test(value)) return false;
    if (isSiteSpecificField(mapping.label || mapping.hint || "", mapping.profileKey)) return false;
    if (/^\d{4}-\d{2}-\d{2}/.test(value) && /date|launch/i.test(`${mapping.label || ""} ${key}`)) {
      return false;
    }
    if (!/^https?:\/\//i.test(value) && /\.(png|jpe?g|gif|webp|svg|pdf)$/i.test(value)) return false;
    if (key === "Url" && !/^https?:\/\//i.test(value)) return false;
    if (key === "Business mail" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
    return true;
  }

  function learnProfileFieldsFromFill(profile, mappings = {}) {
    const current = profile && typeof profile === "object" ? profile : emptySiteProfile("site");
    const fields = { ...(current.fields || {}) };
    const notes = { ...(current.fieldNotes || {}) };
    const added = [];
    for (const mapping of Object.values(mappings || {})) {
      if (!mapping || typeof mapping !== "object") continue;
      const key = inferReusableProfileKey(
        mapping.label || mapping.hint || "",
        mapping.profileKey,
        Object.keys(fields),
        mapping.value,
      );
      if (!key || String(fields[key] || "").trim()) continue;
      if (!isReusableFillValue(key, mapping)) continue;
      fields[key] = String(mapping.value).trim();
      if (!notes[key]) notes[key] = "填表学习";
      added.push(key);
    }
    if (!added.length) return { profile: current, added };
    return {
      profile: {
        ...current,
        fields,
        fieldNotes: notes,
        name: current.name || fields.Name || current.name,
        url: current.url || fields.Url || current.url,
        promoUrl: current.promoUrl || fields.Url || current.promoUrl,
        updatedAt: new Date().toISOString(),
      },
      added,
    };
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

  function orderedProfileIds(profiles = {}) {
    return Object.keys(profiles || {}).sort((leftId, rightId) => {
      const left = Number(profiles[leftId]?.sortIndex);
      const right = Number(profiles[rightId]?.sortIndex);
      const leftOrder = Number.isFinite(left) ? left : Number.MAX_SAFE_INTEGER;
      const rightOrder = Number.isFinite(right) ? right : Number.MAX_SAFE_INTEGER;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return String(profiles[leftId]?.name || leftId).localeCompare(
        String(profiles[rightId]?.name || rightId),
        "zh",
      );
    });
  }

  function applyProfileOrder(profiles = {}, orderedIds = []) {
    const next = { ...profiles };
    const remaining = orderedProfileIds(next).filter((id) => !orderedIds.includes(id));
    [...orderedIds, ...remaining].forEach((id, index) => {
      if (!next[id]) return;
      next[id] = { ...next[id], sortIndex: index };
    });
    return next;
  }

  function nextProfileSortIndex(profiles = {}) {
    return orderedProfileIds(profiles).reduce((max, id) => {
      const value = Number(profiles[id]?.sortIndex);
      return Number.isFinite(value) ? Math.max(max, value) : max;
    }, -1) + 1;
  }

  function getActiveProfile(storage) {
    const profiles = storage.siteProfiles || {};
    const activeId = storage.activeSiteId || orderedProfileIds(profiles)[0] || "";
    return activeId && profiles[activeId] ? profiles[activeId] : null;
  }

  function profileConfigured(profile) {
    if (!profile) return false;
    const f = profile.fields || {};
    return !!(profile.name || f.Name || profile.url || f.Url);
  }

  global.ExtLinkProfiles = {
    linesToList,
    listToLines,
    slugifySiteId,
    canonicalProfileId,
    emptySiteProfile,
    buildAgentConfigFromProfile,
    mergeFillConfig,
    fillIdentityMismatch,
    taskConfigIdentityMismatch,
    getScreenshotValuesFromConfig,
    resolveMediaField,
    findMatchingProfile,
    stabilizeTableProfiles,
    applySavedProfilesToTasks,
    mergeExtractedProfile,
    inferReusableProfileKey,
    isSiteSpecificField,
    learnProfileFieldsFromFill,
    orderedProfileIds,
    applyProfileOrder,
    nextProfileSortIndex,
    getActiveProfile,
    profileConfigured,
  };
})(typeof self !== "undefined" ? self : window);

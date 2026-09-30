// Shared backlink-library taxonomy for Settings, the side panel and imports.
(function (global) {
  "use strict";

  const CATEGORY_ORDER = [
    "AI 工具目录",
    "启动发布",
    "SaaS / 软件目录",
    "应用目录",
    "企业 / 本地目录",
    "内容 / 客座投稿",
    "社区 / 论坛",
    "设计 / 作品展示",
    "社交 / 资料页",
    "其他目录",
  ];

  function compact(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function normalizeTags(value) {
    if (Array.isArray(value)) return value.flatMap(normalizeTags).filter(Boolean);
    const raw = compact(value);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeTags(parsed);
    } catch {
      /* Keep plain comma-separated tags. */
    }
    return raw.split(/[,|]/).map(compact).filter(Boolean);
  }

  function categoryFromText(value) {
    const text = compact(value).toLowerCase();
    if (!text) return "";
    if (/ai[ -]?(?:tool|tools)|人工智能|aigc|gpt/.test(text)) return "AI 工具目录";
    if (/startup|launch|product hunt|beta|maker|indie product|founder/.test(text)) return "启动发布";
    if (/app(?:lication)? (?:directory|review)|mobile app|chrome extension/.test(text)) return "应用目录";
    if (/saas|software|technology directory|tech product|product directory|review/.test(text)) return "SaaS / 软件目录";
    if (/guest post|content submission|publishing|blog|article|podcast|投稿|媒体/.test(text)) return "内容 / 客座投稿";
    if (/forum|community|discussion|feedback|user voice|uservoice|论坛|社区/.test(text)) return "社区 / 论坛";
    if (/design|gallery|showcase|creative|作品|设计/.test(text)) return "设计 / 作品展示";
    if (/profile|social|bookmark|社交|资料页/.test(text)) return "社交 / 资料页";
    if (/business|local|company|b2b|yellow page|marketplace|企业|本地/.test(text)) return "企业 / 本地目录";
    if (/directory|listing|catalog|resource|tools|导航|收录/.test(text)) return "其他目录";
    return "";
  }

  function inferCategory(input = {}) {
    const entry = input.entry || {};
    const tags = normalizeTags(entry.tags || input.tags);
    const explicit = compact(entry.category || entry.linkCategory || entry.link_category || input.category);
    const combined = [
      explicit,
      entry.opportunityType,
      entry.opportunity_type,
      entry.name,
      input.name,
      tags.join(" "),
      input.url,
      input.domain,
      input.note,
      input.detail,
    ].filter(Boolean).join(" ");
    return categoryFromText(combined) || "其他目录";
  }

  function normalizeAccessModel(value) {
    const raw = compact(value).toLowerCase();
    if (/^(?:free|免费)$/.test(raw)) return "free";
    if (/freemium|免费增值/.test(raw)) return "freemium";
    if (/paid|付费|subscription/.test(raw)) return "paid";
    return "unknown";
  }

  function describe(input = {}) {
    const entry = input.entry || {};
    const tags = normalizeTags(entry.tags || input.tags);
    const category = inferCategory({ ...input, entry, tags });
    const language = compact(entry.language || input.language) || "未知";
    const accessModel = normalizeAccessModel(
      entry.accessModel || entry.access_model || entry.pricing || input.accessModel || input.pricing,
    );
    const name = compact(entry.name || input.name || input.domain || input.url);
    const dr = Number(entry.dr ?? entry.metrics?.dr ?? input.dr ?? input.metrics?.dr);
    const traffic = Number(
      entry.organicTraffic ?? entry.organic_traffic ?? entry.metrics?.traffic ?? input.organicTraffic ?? input.metrics?.traffic,
    );
    return {
      name,
      category,
      language,
      accessModel,
      tags,
      dr: Number.isFinite(dr) ? dr : null,
      organicTraffic: Number.isFinite(traffic) ? traffic : null,
    };
  }

  function normalizeProfileIds(value) {
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((item) => compact(item)).filter(Boolean))];
  }

  function normalizeLibraryGroups(value) {
    if (!Array.isArray(value)) return [];
    const allowed = new Set(["high_quality", "free_submit"]);
    return [...new Set(value.map((item) => compact(item)).filter((item) => allowed.has(item)))];
  }

  function libraryPreferences(annotation = {}) {
    const library = annotation && typeof annotation.library === "object" && !Array.isArray(annotation.library)
      ? annotation.library
      : {};
    return {
      favorite: library.favorite === true,
      enabled: library.enabled !== false,
      profileIds: normalizeProfileIds(library.profileIds),
      groups: normalizeLibraryGroups(library.groups),
      updatedAt: compact(library.updatedAt),
    };
  }

  function libraryEligibility(annotation, profileId = "") {
    const preferences = libraryPreferences(annotation);
    if (!preferences.enabled) return { allowed: false, reason: "library_disabled", preferences };
    if (preferences.profileIds.length && !preferences.profileIds.includes(compact(profileId))) {
      return { allowed: false, reason: "profile_not_assigned", preferences };
    }
    return { allowed: true, reason: "", preferences };
  }

  global.ExtLinkLibraryClassifier = {
    CATEGORY_ORDER,
    categoryFromText,
    describe,
    inferCategory,
    libraryEligibility,
    libraryPreferences,
    normalizeAccessModel,
    normalizeLibraryGroups,
    normalizeProfileIds,
    normalizeTags,
  };
})(typeof self !== "undefined" ? self : globalThis);

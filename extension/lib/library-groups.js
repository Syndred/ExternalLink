// Reusable library views. Explicit per-site group choices live in siteAnnotations;
// these conservative defaults make existing evidence useful for a new Profile.
(function (global) {
  "use strict";

  const GROUPS = Object.freeze([
    ["high_quality", "高质量优先"],
    ["free_submit", "免费可提交"],
  ]);
  // Free routes confirmed by ordinary submissions on 2026-09-25. Their terms
  // still need a fresh check before each new submission.
  const RECENT_FREE_ROUTES = new Set([
    "thenextai.com/submit-ai-tool",
    "listai.cc/submit",
    "launchingnext.com/submit",
    "free-ai-tools-directory.com/submit-request",
    "bestofai.com/tool/add",
    "viesearch.com/submit",
  ]);
  const EXCLUDED_STATUSES = new Set(["broken", "skip", "deleted"]);
  const PRIORITY_CATEGORIES = new Set([
    "AI 工具目录", "启动发布", "SaaS / 软件目录", "应用目录",
    "企业 / 本地目录", "设计 / 作品展示", "其他目录",
  ]);

  function number(value) {
    if (value === undefined || value === null || value === "") return null;
    const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function routeKey(value) {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      const path = parsed.pathname.replace(/\/+$/, "") || "";
      return `${host}${path}`;
    } catch {
      return "";
    }
  }

  function statuses(annotation = {}) {
    const raw = Array.isArray(annotation?.statuses)
      ? annotation.statuses
      : [annotation?.status];
    return new Set(raw.map((value) => String(value || "").trim()).filter(Boolean));
  }

  function metricsFor(item = {}) {
    return item.metrics || item.quality?.metrics || {};
  }

  function automaticHighQuality(item = {}) {
    if (!PRIORITY_CATEGORIES.has(item.category)) return false;
    const metrics = metricsFor(item);
    const authority = Math.max(number(metrics.dr) || 0, number(metrics.da) || 0);
    const traffic = number(metrics.traffic) || 0;
    const spam = number(metrics.spamScore);
    if (spam !== null && spam > 20) return false;
    if (metrics.indexable === false || item.monitorStatus === "missing") return false;
    return authority >= 60 ||
      (authority >= 40 && Number(item.quality?.score || 0) >= 75) ||
      (traffic >= 10000 && Number(item.quality?.score || 0) >= 75);
  }

  function automaticFreeSubmit(item = {}, marked = statuses(item.annotation)) {
    const knownRoute = RECENT_FREE_ROUTES.has(routeKey(item.url));
    const classifiedAndSubmitted = item.accessModel === "free" &&
      marked.has("can_submit") &&
      (item.profileStatuses || []).some((profile) => profile.success === true);
    return knownRoute || classifiedAndSubmitted;
  }

  function matches(item = {}, groupId = "") {
    if (!GROUPS.some(([id]) => id === groupId)) return false;
    const annotation = item.annotation || {};
    const marked = statuses(annotation);
    if ([...EXCLUDED_STATUSES].some((status) => marked.has(status))) return false;
    if (groupId === "free_submit" && marked.has("paid")) return false;
    const preferences = global.ExtLinkLibraryClassifier.libraryPreferences(annotation);
    if (!preferences.enabled) return false;
    const explicitGroups = annotation.library &&
      Object.prototype.hasOwnProperty.call(annotation.library, "groups");
    if (explicitGroups) return preferences.groups.includes(groupId);
    return groupId === "high_quality"
      ? automaticHighQuality(item)
      : automaticFreeSubmit(item, marked);
  }

  global.ExtLinkLibraryGroups = {
    GROUPS,
    matches,
  };
})(typeof self !== "undefined" ? self : globalThis);

// Deterministic backlink-opportunity scoring shared by the queue and Settings.
(function (global) {
  "use strict";

  function numberValue(value) {
    if (value === undefined || value === null || value === "") return null;
    const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function booleanValue(value) {
    if (typeof value === "boolean") return value;
    const token = String(value || "").trim().toLowerCase();
    if (["1", "true", "yes", "y", "是", "dofollow", "follow"].includes(token)) return true;
    if (["0", "false", "no", "n", "否", "nofollow"].includes(token)) return false;
    return null;
  }

  function normalizeMetrics(source = {}) {
    return {
      dr: numberValue(source.dr ?? source.DR ?? source.domainRating),
      da: numberValue(source.da ?? source.DA ?? source.domainAuthority),
      traffic: numberValue(source.traffic ?? source.organicTraffic),
      spamScore: numberValue(source.spamScore ?? source.spam ?? source.spam_score),
      difficulty: numberValue(source.difficulty ?? source.submissionDifficulty),
      ageMonths: numberValue(source.ageMonths ?? source.domainAgeMonths),
      dofollow: booleanValue(source.dofollow ?? source.follow),
      indexable: booleanValue(source.indexable),
      verifiedAt: String(source.verifiedAt ?? source.lastVerified ?? "").trim(),
      linkType: String(source.linkType ?? source.type ?? "").trim(),
      relevance: numberValue(source.relevance ?? source.relevanceScore),
    };
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function recencyPoints(value, now = Date.now()) {
    if (!value) return 0;
    const stamp = Date.parse(value);
    if (!Number.isFinite(stamp)) return 0;
    const days = Math.max(0, (now - stamp) / 86400000);
    if (days <= 7) return 10;
    if (days <= 30) return 7;
    if (days <= 90) return 4;
    return 1;
  }

  function scoreOpportunity(input = {}, now = Date.now()) {
    const metrics = normalizeMetrics(input.metrics || input);
    let score = 35;
    const reasons = [];

    const authority = Math.max(metrics.dr ?? 0, metrics.da ?? 0);
    if (authority > 0) {
      const points = clamp(authority / 5, 0, 18);
      score += points;
      reasons.push(`权威 +${Math.round(points)}`);
    }
    if (metrics.traffic != null) {
      const points = clamp(Math.log10(Math.max(1, metrics.traffic)) * 3, 0, 15);
      score += points;
      reasons.push(`流量 +${Math.round(points)}`);
    }
    if (metrics.spamScore != null) {
      const penalty = clamp(metrics.spamScore / 4, 0, 25);
      score -= penalty;
      reasons.push(`Spam -${Math.round(penalty)}`);
    }
    if (metrics.dofollow === true) {
      score += 12;
      reasons.push("Dofollow +12");
    } else if (metrics.dofollow === false) {
      score -= 3;
      reasons.push("Nofollow -3");
    }
    if (metrics.indexable === true) score += 7;
    if (metrics.indexable === false) score -= 12;
    if (metrics.relevance != null) score += clamp(metrics.relevance / 10, 0, 10);
    if (metrics.ageMonths != null) score += clamp(metrics.ageMonths / 24, 0, 6);
    if (metrics.difficulty != null) score -= clamp(metrics.difficulty / 10, 0, 10);
    score += recencyPoints(metrics.verifiedAt, now);

    const status = String(input.status || input.annotation?.status || "");
    if (status === "can_submit") score += 8;
    if (["paid", "broken", "skip", "deleted"].includes(status)) score -= 40;
    if (["needs_captcha", "needs_login", "needs_manual"].includes(status)) score -= 5;
    if (input.monitorStatus === "live") score += 10;
    if (["missing", "unreachable"].includes(input.monitorStatus)) score -= 25;

    const rounded = Math.round(clamp(score, 0, 100));
    const tier = rounded >= 75 ? "优先" : rounded >= 55 ? "可做" : rounded >= 35 ? "观察" : "低质";
    return { score: rounded, tier, reasons, metrics };
  }

  function compareOpportunities(a, b) {
    return Number(b?.quality?.score || 0) - Number(a?.quality?.score || 0);
  }

  global.ExtLinkOpportunityScore = {
    numberValue,
    booleanValue,
    normalizeMetrics,
    scoreOpportunity,
    compareOpportunities,
  };
})(typeof self !== "undefined" ? self : window);

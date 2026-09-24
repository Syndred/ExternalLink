// Shared queue merge: Table.xlsx pending links + plugin URL library
(function (global) {
  "use strict";

  const DEFAULT_PROJECT = "TextComparison";
  const SUBMISSION_SCHEMA_VERSION = 2;
  const PUBLICATION_STATUSES = ["submitted", "pending_moderation", "published"];
  const PUBLICATION_LABELS = {
    submitted: "已提交",
    pending_moderation: "待审核",
    published: "已上线",
  };
  // These libraries contain both a landing URL and a submit-route alias for
  // the same directory. Treat each host as one destination so a Profile is
  // never opened twice for the same service.
  const HOST_SCOPED_DESTINATIONS = new Set([
    "aitools.neilpatel.com",
    "producthunt.com",
  ]);
  const NON_RECEIPT_MIGRATION_EVIDENCE = new Set([
    "table.xlsx submitted seed",
    "legacy siteannotations.submittedprojects",
  ]);

  function normalizeUrlKey(url) {
    try {
      const parsed = new URL(url.startsWith("http") ? url : `https://${url}`);
      const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "") || "/";
      return `${host}${path === "/" ? "" : path}`;
    } catch {
      return String(url || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/^www\./, "")
        .replace(/\/+$/, "");
    }
  }

  function extractDomain(url) {
    const raw = String(url || "").trim();
    try {
      if (typeof URL !== "undefined") {
        return new URL(raw.startsWith("http") ? raw : `https://${raw}`).hostname.replace(
          /^www\./,
          "",
        );
      }
    } catch {
      /* fall through */
    }
    const match = raw.match(/^(?:https?:\/\/)?(?:www\.)?([^/?#]+)/i);
    return match ? match[1] : raw;
  }

  function normalizeDestinationKey(url) {
    const normalized = normalizeUrlKey(url);
    const domain = extractDomain(url).toLowerCase();
    return HOST_SCOPED_DESTINATIONS.has(domain) ? domain : normalized;
  }

  function hasStoredDestinationKey(keys, destinationKey) {
    return [...(keys || [])].some(
      (key) => key === destinationKey || normalizeDestinationKey(key) === destinationKey,
    );
  }

  function findDestinationAnnotation(annotations, destinationKey, domain = "") {
    const direct = annotations?.[destinationKey] || annotations?.[domain];
    if (direct) return direct;
    const match = Object.entries(annotations || {}).find(
      ([key]) => normalizeDestinationKey(key) === destinationKey,
    );
    return match?.[1] || null;
  }

  // Site classifications used to be stored in the singular `status` field.
  // Keep that field as a compatibility projection, while allowing the UI and
  // cloud snapshot to retain every manually selected marker in `statuses`.
  function normalizeAnnotationStatuses(annotationOrStatuses) {
    const raw = Array.isArray(annotationOrStatuses)
      ? annotationOrStatuses
      : Array.isArray(annotationOrStatuses?.statuses)
        ? annotationOrStatuses.statuses
        : annotationOrStatuses?.status
          ? [annotationOrStatuses.status]
          : [];
    return [...new Set(raw.map((value) => String(value || "").trim()).filter(Boolean))];
  }

  const ANNOTATION_STATUS_PRIORITY = Object.freeze({
    deleted: 100,
    paid: 90,
    broken: 80,
    skip: 70,
    needs_otp: 60,
    needs_captcha: 55,
    needs_login: 50,
    needs_manual: 45,
    can_submit: 10,
  });

  function primaryAnnotationStatus(annotationOrStatuses) {
    return normalizeAnnotationStatuses(annotationOrStatuses).sort(
      (left, right) =>
        (ANNOTATION_STATUS_PRIORITY[right] || 0) -
        (ANNOTATION_STATUS_PRIORITY[left] || 0),
    )[0] || "";
  }

  function hasAnnotationStatus(annotationOrStatuses, status) {
    const wanted = String(status || "").trim();
    return !!wanted && normalizeAnnotationStatuses(annotationOrStatuses).includes(wanted);
  }

  function hasAnnotationStatusInSet(annotationOrStatuses, statuses) {
    const wanted = statuses instanceof Set ? statuses : new Set(statuses || []);
    return normalizeAnnotationStatuses(annotationOrStatuses).some((status) => wanted.has(status));
  }

  function submissionRecordKey(destinationKey, profileId) {
    return `${String(destinationKey || "").trim()}::${String(profileId || "").trim()}`;
  }

  function isSubmissionSuccessful(records, destinationKey, profileId) {
    // Imported table/annotation flags preserve history, but have no receipt.
    // A queue skip requires a source that can produce a receipt plus evidence;
    // status alone is not enough to prevent a real submission for this Profile.
    const hasVerifiedSuccess = (item) => {
      if (item?.status !== "success") return false;
      const confirmedBy = String(item.confirmedBy || "").trim().toLowerCase();
      const evidence = String(item.evidence || "").trim();
      return (
        (confirmedBy === "agent" || confirmedBy === "manual") &&
        Boolean(evidence) &&
        !NON_RECEIPT_MIGRATION_EVIDENCE.has(evidence.toLowerCase())
      );
    };
    const record = (records || {})[submissionRecordKey(destinationKey, profileId)];
    if (hasVerifiedSuccess(record)) return true;
    if (!HOST_SCOPED_DESTINATIONS.has(destinationKey)) return false;
    return Object.values(records || {}).some(
      (item) =>
        hasVerifiedSuccess(item) &&
        item?.profileId === profileId &&
        normalizeDestinationKey(item.destinationKey || item.destinationUrl || "") === destinationKey,
    );
  }

  function normalizePublicationStatus(value) {
    const raw = String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/g, "_");
    if (raw === "under_review" || raw === "pending" || raw === "pending_review") {
      return "pending_moderation";
    }
    return PUBLICATION_STATUSES.includes(raw) ? raw : "";
  }

  function publicationRank(value) {
    return { submitted: 1, pending_moderation: 2, published: 3 }[normalizePublicationStatus(value)] || 0;
  }

  function hasCheckablePublicUrl(url) {
    const value = String(url || "").trim();
    if (!/^https?:\/\//i.test(value)) return false;
    return !/\/(submit|add|new|apply|list-your|contact)(?:\/|$)/i.test(value);
  }

  function inferPublicationStatus(record = {}) {
    const explicit = normalizePublicationStatus(record.publicationStatus);
    if (explicit) return explicit;
    const publicUrl = String(record.publicUrl || "").trim();
    const evidenceUrl = String(record.evidenceUrl || "").trim();
    const text = `${record.evidence || ""} ${publicUrl} ${evidenceUrl}`.toLowerCase();
    if (hasCheckablePublicUrl(publicUrl) && /published|live listing|launched this week|launched in \d{4}/.test(text)) {
      return "published";
    }
    if (hasCheckablePublicUrl(publicUrl) && /awaiting moderation|held for moderation|pending moderation|comment is awaiting/.test(text)) {
      return "pending_moderation";
    }
    if (/awaiting moderation|held for moderation|pending moderation|comment is awaiting/.test(text)) {
      return "pending_moderation";
    }
    if (/under review|in queue|submitted for review|pending review|waiting line|in review/.test(text)) {
      return "pending_moderation";
    }
    return "submitted";
  }

  function hydratePublicationRecord(record) {
    if (!record || typeof record !== "object") return record;
    const publicationStatus = inferPublicationStatus(record);
    if (record.publicationStatus === publicationStatus) return record;
    return { ...record, publicationStatus };
  }

  function mergePublicationFields(winner, other) {
    if (!winner) return other || null;
    if (!other) return winner;
    const nextStatus =
      publicationRank(other.publicationStatus || inferPublicationStatus(other)) >
      publicationRank(winner.publicationStatus || inferPublicationStatus(winner))
        ? normalizePublicationStatus(other.publicationStatus) || inferPublicationStatus(other)
        : normalizePublicationStatus(winner.publicationStatus) || inferPublicationStatus(winner);
    return {
      ...winner,
      publicationStatus: nextStatus,
      publicUrl: String(winner.publicUrl || other.publicUrl || "").trim(),
      evidenceUrl: String(winner.evidenceUrl || other.evidenceUrl || "").trim(),
    };
  }

  function applyPublicationUpgrade(record, nextStatus, extra = {}) {
    if (!record || typeof record !== "object") return record;
    const normalized = normalizePublicationStatus(nextStatus);
    if (!normalized) return hydratePublicationRecord(record);
    const current = normalizePublicationStatus(record.publicationStatus) || inferPublicationStatus(record);
    if (publicationRank(normalized) < publicationRank(current)) {
      return hydratePublicationRecord({ ...record, ...extra, publicationStatus: current });
    }
    return hydratePublicationRecord({
      ...record,
      ...extra,
      publicationStatus: normalized,
    });
  }

  function buildSuccessRecord({
    destinationUrl,
    destinationKey,
    profileId,
    profileName,
    submittedAt,
    confirmedBy = "agent",
    evidence = "",
    publicUrl = "",
    evidenceUrl = "",
    publicationStatus,
  }) {
    const normalizedDestinationKey = destinationKey || normalizeUrlKey(destinationUrl || "");
    const record = {
      status: "success",
      destinationKey: normalizedDestinationKey,
      destinationUrl: destinationUrl || "",
      profileId,
      profileName: profileName || profileId,
      submittedAt: submittedAt || new Date().toISOString(),
      confirmedBy,
      evidence,
      publicUrl: publicUrl || "",
      evidenceUrl: evidenceUrl || "",
      schemaVersion: SUBMISSION_SCHEMA_VERSION,
    };
    record.publicationStatus = inferPublicationStatus({ ...record, publicationStatus });
    return record;
  }

  function createMigratedSuccessRecord(destinationKey, destinationUrl, profileId, source, date) {
    return buildSuccessRecord({
      destinationKey,
      destinationUrl: destinationUrl || "",
      profileId,
      submittedAt: date || new Date().toISOString(),
      confirmedBy: "migration",
      evidence: source,
    });
  }

  function migrateSubmissionRecords({ records = {}, annotations = {}, tableData = {} } = {}) {
    const migrated = { ...records };
    let migratedCount = 0;

    const seenAnnotations = new Set();
    for (const [storedKey, annotation] of Object.entries(annotations || {})) {
      if (!annotation || typeof annotation !== "object") continue;
      const destinationUrl = annotation.url || "";
      const destinationKey = destinationUrl ? normalizeUrlKey(destinationUrl) : storedKey;
      if (!destinationKey || seenAnnotations.has(destinationKey)) continue;
      seenAnnotations.add(destinationKey);

      for (const rawProfileId of annotation.submittedProjects || []) {
        const profileId = String(rawProfileId || "").trim();
        if (!profileId) continue;
        const key = submissionRecordKey(destinationKey, profileId);
        if (migrated[key]?.status === "success") continue;
        migrated[key] = createMigratedSuccessRecord(
          destinationKey,
          destinationUrl,
          profileId,
          "legacy siteAnnotations.submittedProjects",
          annotation.updatedAt,
        );
        migratedCount += 1;
      }
    }

    for (const entry of tableData?.entries || []) {
      if (!entry?.submitted) continue;
      const destinationUrl = String(entry.indexPage || entry.link || "").trim();
      if (!destinationUrl) continue;
      const destinationKey = normalizeUrlKey(destinationUrl);
      for (const rawProfileId of entry.projects || []) {
        const profileId = String(rawProfileId || "").trim();
        if (!profileId) continue;
        const key = submissionRecordKey(destinationKey, profileId);
        if (migrated[key]?.status === "success") continue;
        migrated[key] = createMigratedSuccessRecord(
          destinationKey,
          destinationUrl,
          profileId,
          "Table.xlsx submitted seed",
        );
        migratedCount += 1;
      }
    }

    const hydrated = {};
    for (const [key, record] of Object.entries(migrated)) {
      hydrated[key] = hydratePublicationRecord(record);
    }
    return { records: hydrated, migratedCount, schemaVersion: SUBMISSION_SCHEMA_VERSION };
  }

  function remapSubmissionRecords(records, idRemap) {
    const remapped = {};
    for (const record of Object.values(records || {})) {
      if (!record || typeof record !== "object") continue;
      const profileId = idRemap?.[record.profileId] || record.profileId;
      const destinationKey = record.destinationKey || normalizeUrlKey(record.destinationUrl || "");
      const key = submissionRecordKey(destinationKey, profileId);
      remapped[key] = hydratePublicationRecord({ ...record, destinationKey, profileId });
    }
    return remapped;
  }

  function firstNonempty(fields, keys) {
    for (const key of keys) {
      const value = String((fields && fields[key]) || "").trim();
      if (value && !/^not specified/i.test(value)) return value;
    }
    return "";
  }

  function buildAgentConfigFromTableFields(projectKey, fields) {
    const name = firstNonempty(fields, ["Name"]);
    let url = firstNonempty(fields, ["Url", "URL", "Website"]);
    if (url && !url.startsWith("http")) url = `https://${url.replace(/^\//, "")}`;

    const email = firstNonempty(fields, ["Business mail", "Feedback mail", "Email"]);
    const title = firstNonempty(fields, ["Title", "Name"]);
    const shortDesc = firstNonempty(fields, [
      "Short description(20-30 words)",
      "Short Discription(100-150 words)",
      "Note",
    ]);
    const longDesc = firstNonempty(fields, [
      "Long description (250-500 words)",
      "Short Discription(150-250 words)",
      "Feature description",
      shortDesc,
    ]);

    return {
      projectKey,
      targetDomain: url,
      brandName: name,
      anchorText: title || name,
      email,
      username: name,
      commentTemplate: longDesc || shortDesc,
      tags: firstNonempty(fields, ["Tags Keywords/Hashtags", "Tags"]),
      pricing: firstNonempty(fields, ["Pricing", "Starting Price", "PRICING TYPE"]),
      projectFields: fields || {},
    };
  }

  function parseUrlLines(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|").map((s) => s.trim());
        const url = parts[0];
        return {
          url,
          platformType: parts[1] || "directory",
          key: normalizeUrlKey(url),
          domain: extractDomain(url),
        };
      });
  }

  function resolveProjectKey(entry, fallbackProject) {
    const projects = Array.isArray(entry?.projects) ? entry.projects : [];
    if (projects.length) return projects[0];
    return fallbackProject || DEFAULT_PROJECT;
  }

  function mergePendingQueue({
    tableData,
    pluginUrls = [],
    siteProfiles = {},
    activeSiteId = "",
    fallbackProject = DEFAULT_PROJECT,
    findMatchingProfile,
    buildAgentConfigFromProfile,
  }) {
    const entries = Array.isArray(tableData?.entries) ? tableData.entries : [];
    const projects = tableData?.projects || {};
    const submittedKeys = new Set(
      entries.filter((e) => e.submitted).map((e) => normalizeUrlKey(e.indexPage || e.link)),
    );

    const merged = new Map();
    let fromTable = 0;

    for (const entry of entries) {
      if (entry.submitted) continue;
      const link = (entry.indexPage || entry.link || "").trim();
      if (!link) continue;

      const key = normalizeUrlKey(link);
      if (submittedKeys.has(key) && entry.submitted) continue;

      const projectKey = resolveProjectKey(entry, fallbackProject);
      const fields = projects[projectKey] || {};
      let config = buildAgentConfigFromTableFields(projectKey, fields);

      if (findMatchingProfile && buildAgentConfigFromProfile) {
        const profile = findMatchingProfile(projectKey, siteProfiles);
        if (profile) {
          const profileConfig = buildAgentConfigFromProfile(profile);
          config = {
            ...config,
            ...profileConfig,
            projectKey: profile.id || projectKey,
            projectFields: {
              ...(config.projectFields || {}),
              ...(profileConfig.projectFields || {}),
            },
          };
        }
      } else if (
        activeSiteId &&
        siteProfiles[activeSiteId] &&
        buildAgentConfigFromProfile &&
        (projectKey === activeSiteId ||
          findMatchingProfile?.(projectKey, { [activeSiteId]: siteProfiles[activeSiteId] }))
      ) {
        const profileConfig = buildAgentConfigFromProfile(siteProfiles[activeSiteId]);
        config = {
          ...config,
          ...profileConfig,
          projectKey: profileConfig.projectKey || activeSiteId,
          projectFields: {
            ...(config.projectFields || {}),
            ...(profileConfig.projectFields || {}),
          },
        };
      }

      merged.set(key, {
        key,
        url: link,
        domain: extractDomain(link),
        platformType: "directory",
        projectKey,
        note: entry.note || "",
        source: "table",
        status: "pending",
        config,
      });
      fromTable += 1;
    }

    let fromPlugin = 0;
    for (const item of pluginUrls) {
      const key = item.key || normalizeUrlKey(item.url);
      if (submittedKeys.has(key) || merged.has(key)) continue;

      let config = {};
      let projectKey = fallbackProject;
      if (activeSiteId && siteProfiles[activeSiteId] && buildAgentConfigFromProfile) {
        config = buildAgentConfigFromProfile(siteProfiles[activeSiteId]);
        projectKey = config.projectKey || activeSiteId;
      } else if (findMatchingProfile && buildAgentConfigFromProfile) {
        const profile = findMatchingProfile(fallbackProject, siteProfiles);
        if (profile) {
          config = buildAgentConfigFromProfile(profile);
          projectKey = config.projectKey || fallbackProject;
        }
      }

      merged.set(key, {
        key,
        url: item.url,
        domain: item.domain || extractDomain(item.url),
        platformType: item.platformType || "directory",
        projectKey,
        note: "",
        source: "library",
        status: "pending",
        config,
      });
      fromPlugin += 1;
    }

    const tasks = Array.from(merged.values()).map((task, i) => ({
      ...task,
      index: i + 1,
    }));

    return {
      tasks,
      meta: {
        fromTable,
        fromPlugin,
        total: tasks.length,
        skippedSubmitted: submittedKeys.size,
      },
    };
  }

  function taskMatchesPage(task, pageUrl) {
    if (!task || !pageUrl) return false;
    const pageKey = normalizeUrlKey(pageUrl);
    const pageHost = extractDomain(pageUrl).toLowerCase();
    if ((task.key || task.destinationKey) === pageKey) return true;
    const taskHost = String(task.domain || extractDomain(task.url)).toLowerCase();
    return !!(taskHost && taskHost === pageHost);
  }

  function taskMatchesProfile(task, profileId) {
    const wanted = String(profileId || "").trim();
    if (!wanted || !task) return false;
    return (
      task.profileId === wanted ||
      task.projectKey === wanted ||
      task.config?.projectKey === wanted
    );
  }

  /** Match current page to a pending submission target (exact URL or same domain). */
  function matchSubmissionTarget(pageUrl, tasks, profileId = "") {
    if (!pageUrl || !Array.isArray(tasks) || !tasks.length) return null;
    const matches = tasks.filter((task) => taskMatchesPage(task, pageUrl));
    if (!matches.length) return null;
    if (profileId) {
      return matches.find((task) => taskMatchesProfile(task, profileId)) || null;
    }
    return matches[0];
  }

  function findSubmissionIndex(pageUrl, tasks, profileId = "") {
    const match = matchSubmissionTarget(pageUrl, tasks, profileId);
    if (!match) return -1;
    const byId = tasks.findIndex((t) => t.id && match.id && t.id === match.id);
    if (byId >= 0) return byId;
    return tasks.findIndex((t) => t === match);
  }

  /** Saved urlList lines + built-in library, deduped (saved entries win). */
  function resolvePluginUrls(urlListText, builtinUrls = []) {
    const fromSaved = parseUrlLines(urlListText || "").map((item) => ({
      ...item,
      source: "saved",
    }));
    const savedKeys = new Set(fromSaved.map((item) => item.key));
    const merged = [...fromSaved];
    for (const url of builtinUrls || []) {
      const parsed = parseUrlLines(String(url).trim())[0];
      if (!parsed || savedKeys.has(parsed.key)) continue;
      savedKeys.add(parsed.key);
      merged.push({ ...parsed, source: "library" });
    }
    return merged;
  }

  /** Dead-end statuses: permanently excluded from pending queue (until revoked). */
  const DEAD_END_STATUSES = new Set(["deleted", "skip", "broken", "paid"]);
  /** Gate statuses: keep tab for human, do not permanently exclude from queue. */
  const GATE_STATUSES = new Set(["needs_login", "needs_captcha", "needs_otp", "needs_manual"]);

  function classifyStatusFromReason(reason, fallback = "broken") {
    const text = String(reason || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();

    // Human gates take precedence over payment words. A page can mention a
    // payment option and still only need a CAPTCHA, OTP, or login from the
    // operator before the free submission can continue.
    if (
      /验证码|captcha|recaptcha|hcaptcha|turnstile|human\s*verification|verify you are human|security check/.test(
        text,
      )
    ) {
      return "needs_captcha";
    }
    if (
      /\botp\b|one[-\s]*time (?:password|code)|email verification|required verification code|邮箱验证|邮件验证|一次性密码/.test(
        text,
      )
    ) {
      return "needs_otp";
    }
    if (
      /需登录|登录|log\s*in|sign\s*in|signin|authentication required|account required|login required/.test(
        text,
      )
    ) {
      return "needs_login";
    }

    // A product's Pricing/Paid/Free/Freemium or subscription field describes
    // the submitted product. It does not prove that this directory charges
    // for the submission. Mark such and other ambiguous payment observations
    // for review instead of permanently excluding the destination as paid.
    const submissionAction =
      "(?:submit(?:ted|ting)?|submission|list(?:ing)?|directory|catalog(?:ue)?|feature|publish(?:ing)?|post|launch|promot(?:e|ion)|add\\s+(?:a\\s+)?(?:site|product|listing)|提交|收录|发布|上架|目录|推广|入库|刊登|投稿)";
    const paymentTerm =
      "(?:付费|收费|费用|价格|付款|支付|payment|paid|fee|charge|cost|pay(?:\\s+now)?|credit\\s*card|[$€£]\\s*\\d|\\d+\\s*(?:usd|eur|gbp))";
    const productPricingField =
      /pricing|\b(?:product|app|service|plan|tier)\b.{0,30}\b(?:free|freemium|paid|subscription)\b|\b(?:free|freemium|paid|subscription)\b.{0,30}\b(?:product|app|service|plan|tier)\b|\b(?:free|freemium)(?:\s*[-/]\s*(?:free|freemium|paid))+\b|产品.{0,20}(?:免费|付费|收费|订阅)|(?:免费|付费|收费|订阅).{0,20}产品/.test(
        text,
      );
    const uncertainPayment =
      /(?:是否|有没有|有无|未说明|没有说明|未提及|没有表明|不确定|无法判断|不清楚|no\s+(?:indication|evidence)|not\s+(?:stated|specified|clear)|unknown|unclear|cannot tell|not clear).{0,50}(?:付费|订阅|收费|支付|付款|payment|paid|fee|charge|cost)|(?:付费|订阅|收费|支付|付款|payment|paid|fee|charge|cost).{0,50}(?:是否|有没有|有无|未说明|没有说明|未提及|没有表明|不确定|无法判断|不清楚|no\s+(?:indication|evidence)|not\s+(?:stated|specified|clear)|unknown|unclear|cannot tell|not clear)/.test(
        text,
      );
    const negatedPayment =
      /(?:does?\s+not|doesn't|do\s+not|don't|not)\s+(?:require|need|charge)\w*.{0,35}(?:pay|fee|charge|cost)|(?:no|without)\s+(?:a\s+)?(?:payment|submission fee|listing fee)|(?:不需要|无需|不必|不用|不要求).{0,20}(?:付费|收费|支付|付款)|(?:不是|并非).{0,20}(?:提交|收录).{0,10}(?:收费|付费)|(?:提交|收录).{0,10}(?:免费|不收费)/.test(text);
    if (productPricingField || uncertainPayment || negatedPayment) {
      return "needs_manual";
    }
    const submissionFee = new RegExp(
      [
        `(?:${submissionAction})\\s+(?:is|are)\\s+(?:paid|premium|not\\s+free)`,
        `(?:${submissionAction}).{0,50}(?:requires?|needs?|costs?|charges?).{0,30}(?:a\\s+)?(?:${paymentTerm}|fee|charge|cost)`,
        `(?:${submissionAction}).{0,30}(?:has|includes?)\\s+(?:a\\s+)?(?:fee|charge|cost)`,
        `(?:${submissionAction}).{0,30}(?:for|with)\\s+(?:a\\s+)?(?:fee|charge|cost|payment)`,
        `(?:${submissionAction})\\s+(?:fee|charge|cost)\\b`,
        `(?:${paymentTerm})\\s+(?:required|needed)\\s+(?:to|for)\\s+(?:${submissionAction})`,
        `(?:payment|fee|charge|cost)\\s+(?:for|on)\\s+(?:${submissionAction})`,
        `(?:paid|premium)\\s+(?:${submissionAction})`,
        `(?:提交|收录|发布|上架|目录|推广|入库|刊登|投稿).{0,20}(?:付费|收费|费用|支付|付款|价格)`,
        `(?:付费|收费|费用|支付|付款|价格).{0,20}(?:提交|收录|发布|上架|目录|推广|入库|刊登|投稿)`,
      ].join("|"),
    );
    const explicitPaidAction =
      /\bcheckout\b|\bpay\s+now\b|\bbuy\s+(?:a\s+)?(?:listing|submission|placement|feature)\b|\bpurchase\s+(?:a\s+)?(?:listing|submission|placement|feature)\b|\bupgrade\s+to\s+(?:submit|list|publish)\b|\b(?:promote|boost)\s+(?:this\s+)?(?:launch|listing|post|site|product)\b|(?:页面|当前)?提交按钮.{0,20}(?:付费|收费|支付|付款)入口|(?:页面要求|需要).{0,30}(?:付费|收费|支付|付款).{0,30}(?:提交|收录|发布)/.test(
        text,
      );
    if (submissionFee.test(text) || explicitPaidAction) {
      return "paid";
    }

    const ambiguousPayment =
      /付费|订阅|收费|payment|paid\b|paywall|credit\s*card|subscribe(?:d|r)?|subscription|paid\s*plan|subscription\s*required/.test(
        text,
      );
    if (ambiguousPayment) {
      return "needs_manual";
    }

    if (
      /无法提交|坏链|失效|closed|not\s*accept|no longer|404|not found|access denied|forbidden|unavailable|cannot submit|broken|dead\s*link|domain.*(expired|invalid)/.test(
        text,
      )
    ) {
      return "broken";
    }
    if (/跳过|skip|not\s*worth|low\s*value/.test(text)) {
      return "skip";
    }
    return fallback;
  }

  function isDeadEndStatus(status) {
    return DEAD_END_STATUSES.has(status);
  }

  function isGateStatus(status) {
    return GATE_STATUSES.has(status);
  }

  function normalizeBlacklistEntry(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/^[*.]+/, "")
      .replace(/^www\./, "")
      .split("/")[0]
      .split(":")[0]
      .replace(/\.+$/, "");
  }

  function buildBlacklistMatcher(entries) {
    const exact = new Set();
    const suffixes = [];
    for (const raw of entries || []) {
      const entry = normalizeBlacklistEntry(raw);
      if (!entry) continue;
      // A leading dot or wildcard blocks the domain and every subdomain under it.
      if (/^[*.]/.test(String(raw).trim())) suffixes.push(entry);
      else exact.add(entry);
    }
    if (!exact.size && !suffixes.length) return null;

    return function matches(domain) {
      const host = normalizeBlacklistEntry(domain);
      if (!host) return false;
      if (exact.has(host)) return true;
      for (const suffix of suffixes) {
        if (host === suffix || host.endsWith(`.${suffix}`)) return true;
      }
      for (const entry of exact) {
        if (host.endsWith(`.${entry}`)) return true;
      }
      return false;
    };
  }

  function domainAgeGate(domain, options = {}) {
    const minMonths = Number(options.minDomainAgeMonths || 0);
    if (!(minMonths > 0)) return null;

    const metrics = (options.domainMetrics || {})[normalizeBlacklistEntry(domain)];
    if (!metrics) {
      return options.requireKnownDomainAge ? "domain_age_unknown" : null;
    }
    const age = Number(metrics.ageMonths);
    if (!Number.isFinite(age)) {
      return options.requireKnownDomainAge ? "domain_age_unknown" : null;
    }
    return age < minMonths ? "domain_too_young" : null;
  }

  function filterSubmissionTasks(tasks, options = {}) {
    const deletedKeys = new Set(options.deletedKeys || []);
    const annotations = options.annotations || {};
    const skipStatuses = new Set(
      options.excludeStatuses || [...DEAD_END_STATUSES, ...GATE_STATUSES],
    );
    const activeProject = options.activeProjectKey || "";
    const isBlacklisted = buildBlacklistMatcher(options.blacklist);
    const excluded = [];

    const kept = (tasks || []).filter((task) => {
      if (hasStoredDestinationKey(deletedKeys, task.key)) return false;
      const ann = findDestinationAnnotation(annotations, task.key, task.domain);
      if (ann && hasAnnotationStatusInSet(ann, skipStatuses)) return false;
      if (
        activeProject &&
        Array.isArray(ann?.submittedProjects) &&
        ann.submittedProjects.includes(activeProject)
      ) {
        return false;
      }
      if (isBlacklisted && isBlacklisted(task.domain)) {
        excluded.push({ key: task.key, domain: task.domain, reason: "blacklist" });
        return false;
      }
      const ageReason = domainAgeGate(task.domain, options);
      if (ageReason) {
        excluded.push({ key: task.key, domain: task.domain, reason: ageReason });
        return false;
      }
      return true;
    });

    if (options.collectExclusions) {
      kept.gateExclusions = excluded;
    }
    return kept;
  }

  function resolveProfileForSelection(profileId, siteProfiles, tableProjects, findMatchingProfile) {
    if (siteProfiles?.[profileId]) return siteProfiles[profileId];
    if (findMatchingProfile) {
      const matched = findMatchingProfile(profileId, siteProfiles || {});
      if (matched) return matched;
    }
    const fields = tableProjects?.[profileId];
    if (!fields) return null;
    return {
      id: profileId,
      name: fields.Name || profileId,
      url: fields.Url || "",
      promoUrl: fields.Url || "",
      fields,
    };
  }

  function entryAllowsProfile(entry, profile, siteProfiles, findMatchingProfile) {
    const allowed = Array.isArray(entry?.projects) ? entry.projects.filter(Boolean) : [];
    if (!allowed.length) return true;
    const profileId = String(profile?.id || "").toLowerCase();
    const profileName = String(profile?.name || "").toLowerCase();
    return allowed.some((projectKey) => {
      const raw = String(projectKey || "");
      if (raw.toLowerCase() === profileId || raw.toLowerCase() === profileName) return true;
      const matched = findMatchingProfile?.(raw, siteProfiles || {});
      return !!matched && String(matched.id || "").toLowerCase() === profileId;
    });
  }

  function buildDestinationGroups({
    tableData = {},
    pluginUrls = [],
    siteProfiles = {},
    selectedProfileIds = [],
    submissionRecords = {},
    annotations = {},
    findMatchingProfile,
    buildAgentConfigFromProfile,
  } = {}) {
    const tableEntries = Array.isArray(tableData?.entries) ? tableData.entries : [];
    const tableProjects = tableData?.projects || {};
    const candidates = [
      ...pluginUrls.filter((item) => item?.source === "saved"),
      ...tableEntries.map((entry) => ({
        url: entry.indexPage || entry.link,
        platformType: "directory",
        source: "table",
        note: entry.note || "",
        entry,
      })),
      ...pluginUrls.filter((item) => item?.source !== "saved"),
    ];

    const destinations = new Map();
    for (const candidate of candidates) {
      const url = String(candidate?.url || "").trim();
      if (!url) continue;
      const destinationKey = normalizeDestinationKey(url);
      if (!destinationKey) continue;
      const existing = destinations.get(destinationKey);
      if (existing) {
        if (candidate.entry && !existing.entry) existing.entry = candidate.entry;
        continue;
      }
      destinations.set(destinationKey, {
        destinationKey,
        url,
        domain: candidate.domain || extractDomain(url),
        platformType: candidate.platformType || "directory",
        source: candidate.source || "library",
        note: candidate.note || "",
        entry: candidate.entry || null,
      });
    }

    const profiles = selectedProfileIds
      .map((profileId) =>
        resolveProfileForSelection(
          profileId,
          siteProfiles,
          tableProjects,
          findMatchingProfile,
        ),
      )
      .filter(Boolean);
    // A Profile can contain several KB of copy and media metadata. Building it
    // once per destination made a large batch allocate tens/hundreds of MB.
    // Jobs share the immutable run snapshot; the background strips it before
    // persisting task state.
    const profileConfigs = new Map(
      profiles.map((profile) => {
        const config = buildAgentConfigFromProfile
          ? buildAgentConfigFromProfile(profile)
          : buildAgentConfigFromTableFields(profile.id, profile.fields || {});
        return [profile.id, { ...config, projectKey: profile.id }];
      }),
    );

    const groups = [];
    for (const destination of destinations.values()) {
      const annotation = findDestinationAnnotation(
        annotations,
        destination.destinationKey,
        destination.domain,
      );
      if (annotation && hasAnnotationStatusInSet(annotation, DEAD_END_STATUSES)) continue;

      const jobs = [];
      for (const profile of profiles) {
        if (
          destination.entry &&
          !entryAllowsProfile(destination.entry, profile, siteProfiles, findMatchingProfile)
        ) {
          continue;
        }
        if (
          isSubmissionSuccessful(
            submissionRecords,
            destination.destinationKey,
            profile.id,
          )
        ) {
          continue;
        }

        const config = profileConfigs.get(profile.id) || {};
        jobs.push({
          id: submissionRecordKey(destination.destinationKey, profile.id),
          destinationKey: destination.destinationKey,
          destinationUrl: destination.url,
          profileId: profile.id,
          profileName: profile.name || profile.fields?.Name || profile.id,
          projectKey: profile.id,
          status: "pending",
          config,
        });
      }

      if (!jobs.length) continue;
      groups.push({
        id: destination.destinationKey,
        key: destination.destinationKey,
        ...destination,
        jobs,
        status: "pending",
        currentJobIndex: 0,
      });
    }

    return groups.map((group, index) => ({
      ...group,
      index: index + 1,
      jobs: group.jobs.map((job, jobIndex) => ({
        ...job,
        index: jobIndex + 1,
        groupSize: group.jobs.length,
      })),
    }));
  }

  function flattenDestinationGroups(groups) {
    const tasks = [];
    for (const group of groups || []) {
      for (const job of group.jobs || []) {
        tasks.push({
          ...job,
          key: group.key,
          url: group.url,
          domain: group.domain,
          platformType: group.platformType,
          source: group.source,
          category: group.category || "",
          note: group.note,
          quality: group.quality || null,
          destinationGroupKey: group.key,
          destinationGroupIndex: group.index,
          groupJobIndex: job.index,
          groupJobCount: job.groupSize,
        });
      }
    }
    return tasks.map((task, index) => ({ ...task, index: index + 1 }));
  }

  global.ExtLinkQueue = {
    SUBMISSION_SCHEMA_VERSION,
    PUBLICATION_STATUSES,
    PUBLICATION_LABELS,
    normalizeUrlKey,
    normalizeDestinationKey,
    hasStoredDestinationKey,
    findDestinationAnnotation,
    normalizeAnnotationStatuses,
    primaryAnnotationStatus,
    hasAnnotationStatus,
    hasAnnotationStatusInSet,
    extractDomain,
    submissionRecordKey,
    isSubmissionSuccessful,
    normalizePublicationStatus,
    publicationRank,
    inferPublicationStatus,
    hydratePublicationRecord,
    mergePublicationFields,
    applyPublicationUpgrade,
    buildSuccessRecord,
    migrateSubmissionRecords,
    remapSubmissionRecords,
    parseUrlLines,
    buildAgentConfigFromTableFields,
    mergePendingQueue,
    resolvePluginUrls,
    filterSubmissionTasks,
    normalizeBlacklistEntry,
    buildBlacklistMatcher,
    buildDestinationGroups,
    flattenDestinationGroups,
    matchSubmissionTarget,
    findSubmissionIndex,
    taskMatchesProfile,
    classifyStatusFromReason,
    isDeadEndStatus,
    isGateStatus,
    DEAD_END_STATUSES,
    GATE_STATUSES,
    DEFAULT_PROJECT,
  };
})(typeof self !== "undefined" ? self : window);

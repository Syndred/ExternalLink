// Shared queue merge: Table.xlsx pending links + plugin URL library
(function (global) {
  "use strict";

  const DEFAULT_PROJECT = "TextComparison";
  const SUBMISSION_SCHEMA_VERSION = 2;

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

  function submissionRecordKey(destinationKey, profileId) {
    return `${String(destinationKey || "").trim()}::${String(profileId || "").trim()}`;
  }

  function isSubmissionSuccessful(records, destinationKey, profileId) {
    const record = (records || {})[submissionRecordKey(destinationKey, profileId)];
    return record?.status === "success";
  }

  function buildSuccessRecord({
    destinationUrl,
    destinationKey,
    profileId,
    profileName,
    submittedAt,
    confirmedBy = "agent",
    evidence = "",
  }) {
    const normalizedDestinationKey = destinationKey || normalizeUrlKey(destinationUrl || "");
    return {
      status: "success",
      destinationKey: normalizedDestinationKey,
      destinationUrl: destinationUrl || "",
      profileId,
      profileName: profileName || profileId,
      submittedAt: submittedAt || new Date().toISOString(),
      confirmedBy,
      evidence,
      schemaVersion: SUBMISSION_SCHEMA_VERSION,
    };
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

    return { records: migrated, migratedCount, schemaVersion: SUBMISSION_SCHEMA_VERSION };
  }

  function remapSubmissionRecords(records, idRemap) {
    const remapped = {};
    for (const record of Object.values(records || {})) {
      if (!record || typeof record !== "object") continue;
      const profileId = idRemap?.[record.profileId] || record.profileId;
      const destinationKey = record.destinationKey || normalizeUrlKey(record.destinationUrl || "");
      const key = submissionRecordKey(destinationKey, profileId);
      remapped[key] = { ...record, destinationKey, profileId };
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
            projectFields: {
              ...(config.projectFields || {}),
              ...(profileConfig.projectFields || {}),
            },
          };
        }
      } else if (activeSiteId && siteProfiles[activeSiteId] && buildAgentConfigFromProfile) {
        const profileConfig = buildAgentConfigFromProfile(siteProfiles[activeSiteId]);
        config = {
          ...config,
          ...profileConfig,
          projectKey: config.projectKey || profileConfig.projectKey,
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

  /** Match current page to a pending submission target (exact URL or same domain). */
  function matchSubmissionTarget(pageUrl, tasks) {
    if (!pageUrl || !Array.isArray(tasks) || !tasks.length) return null;
    const pageKey = normalizeUrlKey(pageUrl);
    const pageHost = extractDomain(pageUrl).toLowerCase();

    for (const task of tasks) {
      if (task.key === pageKey) return task;
    }
    for (const task of tasks) {
      const taskHost = String(task.domain || extractDomain(task.url)).toLowerCase();
      if (taskHost && taskHost === pageHost) return task;
    }
    return null;
  }

  function findSubmissionIndex(pageUrl, tasks) {
    const match = matchSubmissionTarget(pageUrl, tasks);
    if (!match) return -1;
    return tasks.findIndex((t) => t.key === match.key);
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
  const GATE_STATUSES = new Set(["needs_login", "needs_captcha", "needs_manual"]);

  function classifyStatusFromReason(reason, fallback = "broken") {
    const text = String(reason || "").toLowerCase();
    if (
      /付费|订阅|收费|pricing|payment|paid\b|paywall|credit\s*card|checkout|subscribe to continue|paid\s*plan|subscription\s*required/.test(
        text,
      )
    ) {
      return "paid";
    }
    if (
      /验证码|captcha|recaptcha|hcaptcha|turnstile|human\s*verification|verify you are human|security check/.test(
        text,
      )
    ) {
      return "needs_captcha";
    }
    if (
      /需登录|登录|log\s*in|sign\s*in|signin|authentication required|account required|login required/.test(
        text,
      )
    ) {
      return "needs_login";
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

  function filterSubmissionTasks(tasks, options = {}) {
    const deletedKeys = new Set(options.deletedKeys || []);
    const annotations = options.annotations || {};
    const skipStatuses = new Set(options.excludeStatuses || [...DEAD_END_STATUSES]);
    const activeProject = options.activeProjectKey || "";

    return (tasks || []).filter((task) => {
      if (deletedKeys.has(task.key)) return false;
      const ann = annotations[task.key] || annotations[task.domain];
      if (ann && skipStatuses.has(ann.status)) return false;
      if (
        activeProject &&
        Array.isArray(ann?.submittedProjects) &&
        ann.submittedProjects.includes(activeProject)
      ) {
        return false;
      }
      return true;
    });
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
      const destinationKey = normalizeUrlKey(url);
      if (!destinationKey || destinations.has(destinationKey)) continue;
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

    const groups = [];
    for (const destination of destinations.values()) {
      const annotation =
        annotations[destination.destinationKey] || annotations[destination.domain] || null;
      if (annotation && DEAD_END_STATUSES.has(annotation.status)) continue;

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

        const config = buildAgentConfigFromProfile
          ? buildAgentConfigFromProfile(profile)
          : buildAgentConfigFromTableFields(profile.id, profile.fields || {});
        jobs.push({
          id: submissionRecordKey(destination.destinationKey, profile.id),
          destinationKey: destination.destinationKey,
          destinationUrl: destination.url,
          profileId: profile.id,
          profileName: profile.name || profile.fields?.Name || profile.id,
          projectKey: profile.id,
          status: "pending",
          config: { ...config, projectKey: profile.id },
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
          note: group.note,
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
    normalizeUrlKey,
    extractDomain,
    submissionRecordKey,
    isSubmissionSuccessful,
    buildSuccessRecord,
    migrateSubmissionRecords,
    remapSubmissionRecords,
    parseUrlLines,
    buildAgentConfigFromTableFields,
    mergePendingQueue,
    resolvePluginUrls,
    filterSubmissionTasks,
    buildDestinationGroups,
    flattenDestinationGroups,
    matchSubmissionTarget,
    findSubmissionIndex,
    classifyStatusFromReason,
    isDeadEndStatus,
    isGateStatus,
    DEAD_END_STATUSES,
    GATE_STATUSES,
    DEFAULT_PROJECT,
  };
})(typeof self !== "undefined" ? self : window);

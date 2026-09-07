// Pure helpers for an append-only external-link submission timeline.
//
// The runtime keeps `submissionRecords` as the success ledger.  This module is
// deliberately additive: timeline events explain what happened over time and
// never replace or downgrade the success ledger.
(function (global) {
  "use strict";

  const SCHEMA_VERSION = 1;
  const KEY_SEPARATOR = "::";
  const SUCCESS_STATUS = "success";
  const TIMELINE_BACKUP_FORMAT = "externallink-submission-timeline-backup";
  const FULL_BACKUP_FORMAT = "externallink-submission-backup";

  function text(value) {
    return value === undefined || value === null ? "" : String(value).trim();
  }

  function isObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function cloneValue(value) {
    if (Array.isArray(value)) return value.map(cloneValue);
    if (isObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
    }
    return value;
  }

  function stableValue(value) {
    if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
    if (isObject(value)) {
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
        .join(",")}}`;
    }
    return JSON.stringify(value);
  }

  // A small deterministic hash keeps legacy migration idempotent without
  // requiring crypto APIs that are unavailable in extension unit-test VMs.
  function hash(value) {
    let result = 2166136261;
    for (const character of String(value || "")) {
      result ^= character.charCodeAt(0);
      result = Math.imul(result, 16777619);
    }
    return (result >>> 0).toString(36);
  }

  function randomId(prefix = "event") {
    try {
      if (global.crypto && typeof global.crypto.randomUUID === "function") {
        return `${prefix}_${global.crypto.randomUUID()}`;
      }
    } catch {
      // Fall through to a browser-compatible fallback.
    }
    return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  }

  function normalizeDestinationKey(value) {
    const raw = text(value);
    if (!raw) return "";
    try {
      const parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
      const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
      const path = parsed.pathname.replace(/\/+$/, "");
      return `${host}${path}`;
    } catch {
      return raw
        .toLowerCase()
        .replace(/^[a-z][a-z\d+.-]*:\/\//i, "")
        .replace(/^www\./, "")
        .replace(/[?#].*$/, "")
        .replace(/\/+$/, "");
    }
  }

  function normalizeProfileId(value) {
    return text(value);
  }

  function timelineKey(destinationKey, profileId) {
    return `${normalizeDestinationKey(destinationKey)}${KEY_SEPARATOR}${normalizeProfileId(profileId)}`;
  }

  function splitTimelineKey(key) {
    const raw = text(key);
    const separator = raw.lastIndexOf(KEY_SEPARATOR);
    if (separator < 1) return { destinationKey: raw, profileId: "" };
    return {
      destinationKey: raw.slice(0, separator),
      profileId: raw.slice(separator + KEY_SEPARATOR.length),
    };
  }

  function parseTime(value) {
    const raw = text(value);
    if (!raw) return Number.NaN;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }

  function eventTime(event) {
    return parseTime(event?.occurredAt);
  }

  function compareEvents(left, right) {
    const leftTime = eventTime(left);
    const rightTime = eventTime(right);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    if (Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return -1;
    if (!Number.isFinite(leftTime) && Number.isFinite(rightTime)) return 1;
    return 0;
  }

  function normalizeType(value, status) {
    const raw = text(value);
    if (raw) return raw;
    return text(status) === SUCCESS_STATUS ? "submitted" : "note";
  }

  function normalizeEvent(input = {}, defaults = {}) {
    if (!isObject(input)) throw new Error("时间线事件必须是对象");
    const destinationKey = normalizeDestinationKey(
      input.destinationKey || input.destinationUrl || input.url || defaults.destinationKey || defaults.destinationUrl,
    );
    const profileId = normalizeProfileId(
      input.profileId || input.projectId || defaults.profileId || defaults.projectId,
    );
    if (!destinationKey || !profileId) {
      throw new Error("时间线事件缺少 destinationKey 或 profileId");
    }

    const status = text(input.status || input.publicationStatus || defaults.status);
    const occurredAt = text(
      input.occurredAt || input.submittedAt || input.time || input.updatedAt || defaults.occurredAt,
    ) || new Date().toISOString();
    const destinationUrl = text(input.destinationUrl || input.url || defaults.destinationUrl);
    const profileName = text(input.profileName || defaults.profileName);
    const event = {
      id: text(input.id) || randomId("timeline"),
      destinationKey,
      profileId,
      occurredAt,
      type: normalizeType(input.type || input.eventType, status),
      status,
      note: text(input.note || input.notes),
      evidenceUrl: text(input.evidenceUrl),
      publicUrl: text(input.publicUrl),
      source: text(input.source || defaults.source) || "manual",
    };
    if (destinationUrl) event.destinationUrl = destinationUrl;
    if (profileName) event.profileName = profileName;
    if (input.publicationStatus !== undefined || defaults.publicationStatus !== undefined) {
      event.publicationStatus = text(input.publicationStatus || defaults.publicationStatus);
    }
    if (input.metadata !== undefined) event.metadata = cloneValue(input.metadata);
    if (input.legacy !== undefined) event.legacy = cloneValue(input.legacy);
    if (input.confirmedBy !== undefined) event.confirmedBy = text(input.confirmedBy);
    if (input.recordKey !== undefined) event.recordKey = text(input.recordKey);
    return event;
  }

  function readTimelineGroups(timeline) {
    if (!timeline) return {};
    if (Array.isArray(timeline)) {
      const groups = {};
      for (const event of timeline) {
        if (!isObject(event)) continue;
        const key = timelineKey(event.destinationKey || event.destinationUrl, event.profileId || event.projectId);
        if (!key || key === KEY_SEPARATOR) continue;
        (groups[key] ||= []).push(event);
      }
      return groups;
    }
    if (!isObject(timeline)) return {};
    if (isObject(timeline.groups)) return timeline.groups;
    if (Array.isArray(timeline.events)) return readTimelineGroups(timeline.events);
    return Object.fromEntries(
      Object.entries(timeline).filter(
        ([key, events]) => key !== "schemaVersion" && key !== "version" && Array.isArray(events),
      ),
    );
  }

  function eventExists(groups, eventId) {
    const id = text(eventId);
    if (!id) return false;
    return Object.values(groups).some((events) => events.some((event) => text(event?.id) === id));
  }

  function normalizeTimeline(timeline, { strict = false } = {}) {
    const normalized = {};
    for (const [storedKey, rawEvents] of Object.entries(readTimelineGroups(timeline))) {
      if (!Array.isArray(rawEvents)) {
        if (strict) throw new Error(`时间线分组无效: ${storedKey}`);
        continue;
      }
      const keyParts = splitTimelineKey(storedKey);
      for (const rawEvent of rawEvents) {
        if (!isObject(rawEvent)) {
          if (strict) throw new Error(`时间线事件无效: ${storedKey}`);
          continue;
        }
        let event;
        try {
          event = normalizeEvent(rawEvent, keyParts);
        } catch (error) {
          if (strict) throw error;
          continue;
        }
        const key = timelineKey(event.destinationKey, event.profileId);
        if (strict && storedKey !== key) {
          throw new Error(`时间线分组键不匹配: ${storedKey}`);
        }
        (normalized[key] ||= []).push(event);
      }
    }
    for (const events of Object.values(normalized)) {
      events.sort(compareEvents);
    }
    return normalized;
  }

  function append(timeline, rawEvent) {
    const current = normalizeTimeline(timeline);
    const event = normalizeEvent(rawEvent);
    if (eventExists(current, event.id)) return current;
    const key = timelineKey(event.destinationKey, event.profileId);
    const next = { ...current };
    next[key] = [...(current[key] || []), event].sort(compareEvents);
    return next;
  }

  function appendWithResult(timeline, rawEvent) {
    const current = normalizeTimeline(timeline);
    const event = normalizeEvent(rawEvent);
    if (eventExists(current, event.id)) {
      return { timeline: current, event, added: false };
    }
    const next = append(current, event);
    return { timeline: next, event, added: true };
  }

  function findEvent(groups, eventId) {
    const id = text(eventId);
    if (!id) return null;
    for (const [key, events] of Object.entries(groups || {})) {
      const index = events.findIndex((event) => text(event?.id) === id);
      if (index >= 0) return { key, index, event: events[index] };
    }
    return null;
  }

  function writeGroup(groups, key, events) {
    const next = { ...groups };
    if (events.length) next[key] = events;
    else delete next[key];
    return next;
  }

  function updateEvent(timeline, eventId, patch = {}) {
    const current = normalizeTimeline(timeline);
    const found = findEvent(current, eventId);
    if (!found) throw new Error("找不到这条动态");
    const nextEvent = normalizeEvent({
      ...found.event,
      ...(isObject(patch) ? patch : {}),
      id: found.event.id,
      destinationKey: patch.destinationKey || patch.destinationUrl || found.event.destinationKey,
      destinationUrl: patch.destinationUrl || found.event.destinationUrl,
      profileId: patch.profileId || found.event.profileId,
    });
    let next = writeGroup(
      current,
      found.key,
      (current[found.key] || []).filter((event) => text(event.id) !== text(found.event.id)),
    );
    const newKey = timelineKey(nextEvent.destinationKey, nextEvent.profileId);
    next = writeGroup(next, newKey, [...(next[newKey] || []), nextEvent].sort(compareEvents));
    return { timeline: next, event: nextEvent };
  }

  function removeEvent(timeline, eventId) {
    const current = normalizeTimeline(timeline);
    const found = findEvent(current, eventId);
    if (!found) throw new Error("找不到这条动态");
    return {
      timeline: writeGroup(
        current,
        found.key,
        (current[found.key] || []).filter((event) => text(event.id) !== text(found.event.id)),
      ),
      event: found.event,
    };
  }

  function appendMany(timeline, events) {
    let next = normalizeTimeline(timeline);
    let added = 0;
    for (const event of events || []) {
      const result = appendWithResult(next, event);
      next = result.timeline;
      if (result.added) added += 1;
    }
    return { timeline: next, added };
  }

  function isSuccessEvent(event) {
    return text(event?.status).toLowerCase() === SUCCESS_STATUS ||
      text(event?.ledgerStatus).toLowerCase() === SUCCESS_STATUS;
  }

  function currentEvent(events) {
    if (!events.length) return null;
    return events.reduce((latest, event) => {
      if (!latest) return event;
      const comparison = compareEvents(latest, event);
      return comparison <= 0 ? event : latest;
    }, null);
  }

  // Derive a display/runtime current record without losing success semantics.
  // A later review/note can become the visible current event, while any prior
  // explicit success still yields status=success and ledgerStatus=success.
  function deriveCurrent(timeline) {
    const groups = normalizeTimeline(timeline);
    const current = {};
    for (const [key, events] of Object.entries(groups)) {
      const latest = currentEvent(events);
      if (!latest) continue;
      const successEvent = events.find((event) => isSuccessEvent(event));
      const result = {
        ...cloneValue(latest),
        currentStatus: text(latest.status),
        ledgerStatus: successEvent ? SUCCESS_STATUS : text(latest.status),
        isSuccessful: !!successEvent,
        eventCount: events.length,
        lastEventAt: latest.occurredAt,
      };
      if (successEvent) {
        result.status = SUCCESS_STATUS;
        result.submittedAt = successEvent.occurredAt;
        if (!result.destinationUrl && successEvent.destinationUrl) {
          result.destinationUrl = successEvent.destinationUrl;
        }
        if (!result.publicUrl && successEvent.publicUrl) result.publicUrl = successEvent.publicUrl;
        if (!result.evidenceUrl && successEvent.evidenceUrl) result.evidenceUrl = successEvent.evidenceUrl;
      }
      current[key] = result;
    }
    return current;
  }

  function groupByDestination(timeline) {
    const groups = normalizeTimeline(timeline);
    const destinations = {};
    for (const [key, events] of Object.entries(groups)) {
      const { destinationKey, profileId } = splitTimelineKey(key);
      const current = deriveCurrent({ groups: { [key]: events } })[key] || null;
      const item = { key, destinationKey, profileId, events: cloneValue(events), current };
      const destination = (destinations[destinationKey] ||= {
        destinationKey,
        profiles: [],
        groups: {},
      });
      destination.profiles.push(item);
      destination.groups[key] = item;
    }
    for (const destination of Object.values(destinations)) {
      destination.profiles.sort((left, right) => left.profileId.localeCompare(right.profileId));
    }
    return destinations;
  }

  function deriveLibraryProgress(item = {}) {
    const profiles = Array.isArray(item.profileStatuses) ? item.profileStatuses : [];
    const events = Array.isArray(item.events) ? item.events : [];
    const eventsByProfile = {};
    for (const event of events) {
      const profileId = normalizeProfileId(event?.profileId);
      if (profileId) (eventsByProfile[profileId] ||= []).push(event);
    }
    const profileById = Object.fromEntries(
      profiles.map((profile) => [normalizeProfileId(profile?.profileId), profile]).filter(([id]) => id),
    );
    const profileIds = new Set([...Object.keys(profileById), ...Object.keys(eventsByProfile)]);
    const states = [];
    const submittedTimes = [];
    const historyTimes = [item.time];
    let hasActionRecorded = false;
    for (const profileId of profileIds) {
      const profile = profileById[profileId] || {};
      const profileEvents = eventsByProfile[profileId] || [];
      const latestFromEvents = currentEvent(profileEvents);
      const latest = !latestFromEvents
        ? profile.latestEvent
        : !profile.latestEvent
          ? latestFromEvents
          : compareEvents(profile.latestEvent, latestFromEvents) >= 0
            ? profile.latestEvent
            : latestFromEvents;
      const latestType = text(latest?.publicationStatus || latest?.type || latest?.status);
      const publicationStatus = latestType === "note"
        ? text(profile.publicationStatus)
        : latestType || text(profile.publicationStatus);
      const submitted = profile.success === true;
      if (submitted && Number.isFinite(parseTime(profile.submittedAt))) {
        submittedTimes.push(profile.submittedAt);
      }
      for (const event of profileEvents) {
        if (Number.isFinite(parseTime(event?.occurredAt))) historyTimes.push(event.occurredAt);
        if (text(event?.type) === "link_submit") hasActionRecorded = true;
      }
      if (submitted) hasActionRecorded = true;
      let state = "unsubmitted";
      if (["link_missing"].includes(publicationStatus)) state = "link_missing";
      else if (publicationStatus === "rejected") state = "rejected";
      else if (publicationStatus === "needs_follow_up") state = "needs_follow_up";
      else if (publicationStatus === "published") state = "published";
      else if (publicationStatus === "pending_moderation") state = "pending_moderation";
      else if (submitted) state = "awaiting_index";
      else if (profileEvents.some((event) => text(event?.type) === "link_submit")) {
        state = "action_recorded";
      }
      states.push(state);
    }
    const hasSubmitted = profiles.some((profile) => profile?.success === true);
    const hasPublished = item.monitorStatus === "live" || states.includes("published");
    const hasPendingModeration = states.includes("pending_moderation");
    const needsFollowUp = states.some((state) => ["needs_follow_up", "awaiting_index"].includes(state));
    submittedTimes.sort((left, right) => parseTime(right) - parseTime(left));
    const validHistoryTimes = historyTimes.filter((value) => Number.isFinite(parseTime(value)));
    validHistoryTimes.sort((left, right) => parseTime(right) - parseTime(left));
    const priority = [
      "needs_follow_up",
      "pending_moderation",
      "awaiting_index",
      "link_missing",
      "rejected",
      "published",
      "action_recorded",
      "unsubmitted",
    ];
    const current = priority.find((state) => states.includes(state)) ||
      (item.monitorStatus === "missing" || item.monitorStatus === "unreachable"
        ? "link_missing"
        : item.monitorStatus === "live"
          ? "published"
          : hasActionRecorded
            ? "action_recorded"
            : "unsubmitted");
    return {
      current,
      hasSubmitted,
      hasPublished,
      hasPendingModeration,
      needsFollowUp,
      hasActionRecorded,
      submittedAt: submittedTimes[0] || "",
      historyAt: validHistoryTimes[0] || "",
      profileStates: states,
    };
  }

  function matchesLibraryProgress(progress, filter) {
    const value = text(filter);
    if (!value) return true;
    if (value === "submitted") return progress?.hasSubmitted === true;
    if (value === "awaiting_index") {
      return Array.isArray(progress?.profileStates) && progress.profileStates.includes("awaiting_index");
    }
    if (value === "needs_follow_up") return progress?.needsFollowUp === true;
    if (value === "published") return progress?.hasPublished === true;
    if (value === "action_recorded") return progress?.hasActionRecorded === true && progress?.hasSubmitted !== true;
    return progress?.current === value;
  }

  function sourceRecordEvent(record, storedKey, index) {
    const raw = isObject(record) ? record : {};
    const keyParts = splitTimelineKey(storedKey);
    const destinationKey = raw.destinationKey || keyParts.destinationKey || raw.destinationUrl;
    const profileId = raw.profileId || keyParts.profileId;
    if (!normalizeDestinationKey(destinationKey) || !normalizeProfileId(profileId)) return null;
    const status = text(raw.status);
    const idSeed = `submission-record:${storedKey}:${stableValue(raw)}:${index}`;
    return normalizeEvent({
      id: `migration_${hash(idSeed)}`,
      destinationKey,
      destinationUrl: raw.destinationUrl || "",
      profileId,
      profileName: raw.profileName || "",
      // Do not manufacture a date for a legacy row that had no timestamp.
      // `unknown` is sortable as an undated event and keeps that limitation
      // visible to the card instead of pretending migration happened now.
      occurredAt: raw.submittedAt || raw.updatedAt || "unknown",
      type: raw.type || raw.eventType || (status === SUCCESS_STATUS ? "submitted" : "status"),
      status,
      note: raw.note || raw.evidence || "",
      evidenceUrl: raw.evidenceUrl || "",
      publicUrl: raw.publicUrl || "",
      publicationStatus: raw.publicationStatus,
      source: "migration",
      confirmedBy: raw.confirmedBy,
      recordKey: raw.recordKey || storedKey,
      legacy: {
        source: "submissionRecords",
        recordKey: storedKey,
        record: cloneValue(raw),
      },
    }, { destinationKey, profileId, source: "migration" });
  }

  function linkSubmitEvent(entry, profileId, rowIndex) {
    const raw = isObject(entry) ? entry : {};
    const destinationUrl = text(raw.destinationUrl || raw.indexPage || raw.link || raw.url);
    const destinationKey = raw.destinationKey || destinationUrl;
    if (!normalizeDestinationKey(destinationKey) || !normalizeProfileId(profileId)) return null;
    const time = text(raw.time);
    const record = text(raw.record);
    const detail = text(raw.detail);
    const note = text(raw.note) || [record, detail].filter(Boolean).join(" | ");
    const legacySubmitted = raw.legacySubmitted !== undefined
      ? !!raw.legacySubmitted
      : !!raw.submitted;
    // Link Submit.Submit is a site-level legacy flag.  It is intentionally not
    // emitted as success, because it cannot prove a destination/profile pair.
    const status = legacySubmitted ? "legacy_submitted" : "";
    const idSeed = `link-submit:${rowIndex}:${destinationKey}:${profileId}:${stableValue({
      time,
      record,
      detail,
      note,
      legacySubmitted,
      indexPage: raw.indexPage,
    })}`;
    return normalizeEvent({
      id: `migration_${hash(idSeed)}`,
      destinationKey,
      destinationUrl,
      profileId,
      occurredAt: time || "unknown",
      type: "link_submit",
      status,
      note,
      source: "migration",
      legacy: {
        source: "Link Submit",
        rowIndex,
        time,
        record,
        detail,
        legacySubmitted,
        entry: cloneValue(raw),
      },
      metadata: raw.metrics ? { metrics: cloneValue(raw.metrics) } : undefined,
    }, { destinationKey, destinationUrl, profileId, source: "migration" });
  }

  function normalizeLinkEntries(input) {
    if (Array.isArray(input)) return input;
    if (Array.isArray(input?.entries)) return input.entries;
    if (Array.isArray(input?.tableData?.entries)) return input.tableData.entries;
    return [];
  }

  function entryProfileIds(entry, profileIdMap) {
    const values = Array.isArray(entry?.projects)
      ? entry.projects
      : Array.isArray(entry?.submitProjects)
        ? entry.submitProjects
        : entry?.profileId
          ? [entry.profileId]
          : [];
    return [...new Set(values.map((value) => {
      const raw = text(value);
      return text(profileIdMap?.[raw] || raw);
    }).filter(Boolean))];
  }

  function migrateLegacy(input = {}) {
    const options = isObject(input) ? input : {};
    let next = normalizeTimeline(options.timeline || options.submissionTimeline);
    const migratedEvents = [];
    const skipped = [];
    let sourceRecordCount = 0;
    let linkSubmitCount = 0;

    const records = options.submissionRecords || {};
    for (const [storedKey, record] of Object.entries(records)) {
      const event = sourceRecordEvent(record, storedKey, sourceRecordCount);
      sourceRecordCount += 1;
      if (!event) {
        skipped.push({ source: "submissionRecords", key: storedKey, reason: "missing destination/profile" });
        continue;
      }
      const result = appendWithResult(next, event);
      next = result.timeline;
      if (result.added) migratedEvents.push(event);
    }

    const entries = normalizeLinkEntries(options.linkSubmit || options.tableData || options.entries);
    entries.forEach((entry, rowIndex) => {
      const profileIds = entryProfileIds(entry, options.profileIdMap);
      // Rows without a project cannot be assigned to a destination/profile
      // group.  Keep a diagnostic rather than inventing a fake profile.
      if (!profileIds.length) {
        if (text(entry?.time || entry?.note || entry?.record || entry?.detail || entry?.submitted || entry?.legacySubmitted)) {
          skipped.push({ source: "Link Submit", rowIndex, reason: "missing profileId" });
        }
        return;
      }
      for (const profileId of profileIds) {
        const hasHistory = !!(
          text(entry?.time) ||
          text(entry?.note) ||
          text(entry?.record) ||
          text(entry?.detail) ||
          entry?.submitted === true ||
          entry?.legacySubmitted === true
        );
        // The 2,905-row library should not create thousands of empty timeline
        // notes; rows with no historical value remain represented by the URL.
        if (!hasHistory) continue;
        const event = linkSubmitEvent(entry, profileId, rowIndex);
        linkSubmitCount += 1;
        if (!event) {
          skipped.push({ source: "Link Submit", rowIndex, profileId, reason: "missing destination" });
          continue;
        }
        const result = appendWithResult(next, event);
        next = result.timeline;
        if (result.added) migratedEvents.push(event);
      }
    });

    return {
      timeline: next,
      events: migratedEvents,
      migratedCount: migratedEvents.length,
      skipped,
      sourceCounts: {
        submissionRecords: sourceRecordCount,
        linkSubmit: linkSubmitCount,
      },
      current: deriveCurrent(next),
    };
  }

  function mergeTimelines(current, incoming) {
    const result = appendMany(normalizeTimeline(current), Object.values(normalizeTimeline(incoming)).flat());
    return result.timeline;
  }

  function validateTimeline(timeline) {
    if (timeline === undefined || timeline === null) return {};
    if (!Array.isArray(timeline) && !isObject(timeline)) {
      throw new Error("外链提交时间线格式无效");
    }
    const groups = readTimelineGroups(timeline);
    for (const [key, events] of Object.entries(groups)) {
      if (!Array.isArray(events)) throw new Error(`时间线分组无效: ${key}`);
      for (const event of events) {
        if (!isObject(event)) throw new Error(`时间线事件无效: ${key}`);
        if (!text(event.id)) throw new Error(`时间线事件缺少 id: ${key}`);
        if (!text(event.occurredAt)) throw new Error(`时间线事件缺少 occurredAt: ${key}`);
        if (!text(event.destinationKey) && !text(event.destinationUrl)) {
          throw new Error(`时间线事件缺少 destinationKey: ${key}`);
        }
        if (!text(event.profileId)) throw new Error(`时间线事件缺少 profileId: ${key}`);
      }
    }
    return normalizeTimeline(timeline, { strict: true });
  }

  function validateBackup(data) {
    if (!isObject(data)) throw new Error("时间线备份必须是对象");
    if (data.format && ![TIMELINE_BACKUP_FORMAT, FULL_BACKUP_FORMAT].includes(data.format)) {
      throw new Error("不是有效的 ExternalLink 时间线备份文件");
    }
    const rawTimeline = data.submissionTimeline !== undefined
      ? data.submissionTimeline
      : data.timeline !== undefined
        ? data.timeline
        : {};
    return {
      ...cloneValue(data),
      submissionTimeline: validateTimeline(rawTimeline),
      timelineSchemaVersion: Number(data.timelineSchemaVersion || data.version || SCHEMA_VERSION),
    };
  }

  function mergeBackup(current, rawBackup) {
    const backup = validateBackup(rawBackup);
    const base = isObject(current) ? current : {};
    const mergedTimeline = mergeTimelines(
      base.submissionTimeline !== undefined ? base.submissionTimeline : base.timeline,
      backup.submissionTimeline,
    );
    return {
      ...cloneValue(base),
      submissionTimeline: mergedTimeline,
      timelineSchemaVersion: SCHEMA_VERSION,
    };
  }

  global.ExtLinkSubmissionTimeline = {
    SCHEMA_VERSION,
    KEY_SEPARATOR,
    SUCCESS_STATUS,
    TIMELINE_BACKUP_FORMAT,
    normalizeDestinationKey,
    normalizeProfileId,
    timelineKey,
    submissionTimelineKey: timelineKey,
    splitTimelineKey,
    normalizeEvent,
    normalizeTimeline,
    validateTimeline,
    append,
    appendEvent: append,
    appendWithResult,
    appendMany,
    updateEvent,
    removeEvent,
    deriveCurrent,
    current: deriveCurrent,
    groupByDestination,
    groupTimelineByDestination: groupByDestination,
    deriveLibraryProgress,
    matchesLibraryProgress,
    migrateLegacy,
    migrateSubmissionTimeline: migrateLegacy,
    migrateFromLegacy: migrateLegacy,
    mergeTimelines,
    mergeTimeline: mergeTimelines,
    validateBackup,
    validateTimelineBackup: validateBackup,
    mergeBackup,
    mergeTimelineBackup: mergeBackup,
  };
})(typeof self !== "undefined" ? self : window);

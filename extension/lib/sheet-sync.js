// Pure helpers for Google Sheet preview, conflict-safe merge, and ledger outbox handling.
(function (global) {
  "use strict";

  const SNAPSHOT_FORMAT = "externallink-google-sheet-snapshot";
  const SUCCESS_STATUS = "success";

  function nonempty(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function compactObject(object) {
    return Object.fromEntries(
      Object.entries(object || {}).filter(([, value]) => nonempty(value)),
    );
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || snapshot.format !== SNAPSHOT_FORMAT) {
      throw new Error("Google Sheet 同步数据格式无效");
    }
    if (!snapshot.spreadsheetId || !snapshot.revision) {
      throw new Error("Google Sheet 同步数据缺少工作簿或版本");
    }
    const tableData = snapshot.tableData || {};
    if (!tableData.projects || typeof tableData.projects !== "object") {
      throw new Error("Google Sheet 同步数据缺少网站资料");
    }
    if (!Array.isArray(tableData.entries)) {
      throw new Error("Google Sheet 同步数据缺少外链列表");
    }
    return {
      ...snapshot,
      tableData: {
        projects: tableData.projects,
        entries: tableData.entries,
        tasks: Array.isArray(tableData.tasks) ? tableData.tasks : [],
      },
      submissionRecords:
        snapshot.submissionRecords && typeof snapshot.submissionRecords === "object"
          ? snapshot.submissionRecords
          : {},
      siteAnnotations:
        snapshot.siteAnnotations && typeof snapshot.siteAnnotations === "object"
          ? snapshot.siteAnnotations
          : {},
    };
  }

  function mergeProfile(profileId, fields, existing = {}) {
    const remoteFields = compactObject(fields);
    const nextFields = { ...(existing.fields || {}), ...remoteFields };
    const remoteScreenshots = [1, 2, 3, 4]
      .map((index) => remoteFields[`Screenshot ${index}`] || remoteFields[`Screenshot-${index}`])
      .filter(nonempty);
    const next = {
      ...existing,
      id: profileId,
      name: remoteFields.Name || existing.name || profileId,
      url: remoteFields.Url || existing.url || "",
      promoUrl: remoteFields.Url || existing.promoUrl || existing.url || "",
      fields: nextFields,
      source: "google-sheet",
      updatedAt: new Date().toISOString(),
    };
    if (remoteFields.LOGO || remoteFields["Featured image"]) {
      next.logoUrl = remoteFields.LOGO || remoteFields["Featured image"];
    }
    if (remoteScreenshots.length) {
      next.media = { ...(existing.media || {}), screenshots: remoteScreenshots };
    }
    // Local embedded media and learned mappings never leave the browser and must survive sync.
    if (existing.logoDataUrl) next.logoDataUrl = existing.logoDataUrl;
    if (existing.learnedFieldMappings) {
      next.learnedFieldMappings = existing.learnedFieldMappings;
    }
    return next;
  }

  function recordStrength(record) {
    if (!record || record.status !== SUCCESS_STATUS) return 0;
    const sourceScore = { agent: 40, manual: 40, migration: 10 }[record.confirmedBy] || 20;
    const evidenceScore = Math.min(String(record.evidence || "").trim().length, 100) / 10;
    return sourceScore + evidenceScore;
  }

  function chooseSuccessRecord(localRecord, remoteRecord) {
    if (localRecord?.status === SUCCESS_STATUS && remoteRecord?.status !== SUCCESS_STATUS) {
      return localRecord;
    }
    if (remoteRecord?.status === SUCCESS_STATUS && localRecord?.status !== SUCCESS_STATUS) {
      return remoteRecord;
    }
    if (localRecord?.status === SUCCESS_STATUS && remoteRecord?.status === SUCCESS_STATUS) {
      const winner =
        recordStrength(remoteRecord) > recordStrength(localRecord) ? remoteRecord : localRecord;
      const other = winner === remoteRecord ? localRecord : remoteRecord;
      return global.ExtLinkQueue && typeof global.ExtLinkQueue.mergePublicationFields === "function"
        ? global.ExtLinkQueue.mergePublicationFields(winner, other)
        : winner;
    }
    return remoteRecord || localRecord || null;
  }

  function computePreview(current, rawSnapshot) {
    const snapshot = validateSnapshot(rawSnapshot);
    const currentProfiles = current.siteProfiles || {};
    const currentRecords = current.submissionRecords || {};
    const currentAnnotations = current.siteAnnotations || {};
    let profilesAdded = 0;
    let profilesUpdated = 0;
    const managedProfileIds = Array.isArray(current.sheetSyncMeta?.managedProfileIds)
      ? current.sheetSyncMeta.managedProfileIds
      : [];
    const remoteProfileIds = new Set(Object.keys(snapshot.tableData.projects));
    const profilesRemoved = managedProfileIds.filter((id) => !remoteProfileIds.has(id)).length;
    for (const [profileId, fields] of Object.entries(snapshot.tableData.projects)) {
      if (!currentProfiles[profileId]) profilesAdded += 1;
      else {
        const merged = mergeProfile(profileId, fields, currentProfiles[profileId]);
        const comparable = { ...merged };
        const existingComparable = { ...currentProfiles[profileId] };
        delete comparable.updatedAt;
        delete existingComparable.updatedAt;
        if (JSON.stringify(comparable) !== JSON.stringify(existingComparable)) {
          profilesUpdated += 1;
        }
      }
    }

    let recordsAdded = 0;
    let recordsUpgraded = 0;
    let recordsProtected = 0;
    for (const [key, remoteRecord] of Object.entries(snapshot.submissionRecords)) {
      const localRecord = currentRecords[key];
      if (!localRecord && remoteRecord?.status === SUCCESS_STATUS) recordsAdded += 1;
      else if (localRecord) {
        const chosen = chooseSuccessRecord(localRecord, remoteRecord);
        if (chosen === remoteRecord && JSON.stringify(localRecord) !== JSON.stringify(remoteRecord)) {
          recordsUpgraded += 1;
        } else if (
          localRecord.status === SUCCESS_STATUS &&
          remoteRecord?.status !== SUCCESS_STATUS
        ) {
          recordsProtected += 1;
        }
      }
    }

    const annotationChanges = Object.entries(snapshot.siteAnnotations).filter(
      ([key, value]) => JSON.stringify(currentAnnotations[key] || null) !== JSON.stringify(value),
    ).length;
    const managedAnnotationKeys = Array.isArray(current.sheetSyncMeta?.managedAnnotationKeys)
      ? current.sheetSyncMeta.managedAnnotationKeys
      : [];
    const remoteAnnotationKeys = new Set(Object.keys(snapshot.siteAnnotations));
    const annotationsRemoved = managedAnnotationKeys.filter(
      (key) => !remoteAnnotationKeys.has(key),
    ).length;

    return {
      spreadsheetId: snapshot.spreadsheetId,
      revision: snapshot.revision,
      fetchedAt: snapshot.fetchedAt || "",
      profilesAdded,
      profilesUpdated,
      profilesRemoved,
      destinations: snapshot.tableData.entries.length,
      recordsAdded,
      recordsUpgraded,
      recordsProtected,
      annotationChanges,
      annotationsRemoved,
      conflicts: Array.isArray(snapshot.conflicts) ? snapshot.conflicts : [],
    };
  }

  function applySnapshot(current, rawSnapshot, schemaVersion = 2) {
    const snapshot = validateSnapshot(rawSnapshot);
    const siteProfiles = { ...(current.siteProfiles || {}) };
    for (const profileId of current.sheetSyncMeta?.managedProfileIds || []) {
      if (!snapshot.tableData.projects[profileId]) delete siteProfiles[profileId];
    }
    for (const [profileId, fields] of Object.entries(snapshot.tableData.projects)) {
      siteProfiles[profileId] = mergeProfile(profileId, fields, siteProfiles[profileId]);
    }

    const submissionRecords = { ...(current.submissionRecords || {}) };
    for (const [key, remoteRecord] of Object.entries(snapshot.submissionRecords)) {
      const chosen = chooseSuccessRecord(submissionRecords[key], remoteRecord);
      if (chosen) submissionRecords[key] = chosen;
    }

    const siteAnnotations = { ...(current.siteAnnotations || {}) };
    for (const key of current.sheetSyncMeta?.managedAnnotationKeys || []) {
      if (!snapshot.siteAnnotations[key]) delete siteAnnotations[key];
    }
    Object.assign(siteAnnotations, snapshot.siteAnnotations);
    const selectedSiteIds = (current.selectedSiteIds || []).filter((id) => siteProfiles[id]);
    const activeSiteId = siteProfiles[current.activeSiteId]
      ? current.activeSiteId
      : Object.keys(siteProfiles)[0] || "";

    return {
      siteProfiles,
      submissionRecords,
      submissionSchemaVersion: schemaVersion,
      siteAnnotations,
      selectedSiteIds,
      activeSiteId,
      sheetTableData: snapshot.tableData,
      sheetSyncMeta: {
        spreadsheetId: snapshot.spreadsheetId,
        revision: snapshot.revision,
        fetchedAt: snapshot.fetchedAt || "",
        appliedAt: new Date().toISOString(),
        managedProfileIds: Object.keys(snapshot.tableData.projects),
        managedAnnotationKeys: Object.keys(snapshot.siteAnnotations),
      },
    };
  }

  function enqueueRecord(outbox, record) {
    if (!record?.destinationKey || !record?.profileId || record.status !== SUCCESS_STATUS) {
      return { ...(outbox || {}) };
    }
    const key = `${record.destinationKey}::${record.profileId}`;
    return {
      ...(outbox || {}),
      [key]: { ...record, recordKey: key, queuedAt: new Date().toISOString() },
    };
  }

  function removePushed(outbox, pushedKeys) {
    const next = { ...(outbox || {}) };
    for (const key of pushedKeys || []) delete next[key];
    return next;
  }

  global.ExtLinkSheetSync = {
    SNAPSHOT_FORMAT,
    validateSnapshot,
    mergeProfile,
    recordStrength,
    chooseSuccessRecord,
    computePreview,
    applySnapshot,
    enqueueRecord,
    removePushed,
  };
})(typeof self !== "undefined" ? self : window);

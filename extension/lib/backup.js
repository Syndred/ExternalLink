// Pure helpers for validating and merging submission-ledger backups.
(function (global) {
  "use strict";

  const FORMAT = "externallink-submission-backup";

  function validateBackup(data) {
    if (!data || data.format !== FORMAT) {
      throw new Error("不是有效的 ExternalLink 备份文件");
    }
    if (!data.submissionRecords || typeof data.submissionRecords !== "object") {
      throw new Error("备份缺少提交账本");
    }
    const profiles =
      data.siteProfiles && typeof data.siteProfiles === "object" ? data.siteProfiles : {};
    for (const [id, profile] of Object.entries(profiles)) {
      if (!id || profile?.id !== id) throw new Error(`Profile ID 不稳定: ${id || "unknown"}`);
    }
    return { ...data, siteProfiles: profiles };
  }

  function mergeBackup(current, rawBackup, schemaVersion) {
    const backup = validateBackup(rawBackup);
    const profiles = { ...(current.siteProfiles || {}), ...backup.siteProfiles };
    const selectedSiteIds = (Array.isArray(backup.selectedSiteIds)
      ? backup.selectedSiteIds
      : []
    ).filter((id) => profiles[id]);
    return {
      submissionRecords: {
        ...(current.submissionRecords || {}),
        ...backup.submissionRecords,
      },
      submissionSchemaVersion: schemaVersion,
      siteAnnotations: {
        ...(current.siteAnnotations || {}),
        ...(backup.siteAnnotations || {}),
      },
      siteProfiles: profiles,
      activeSiteId:
        backup.activeSiteId && profiles[backup.activeSiteId]
          ? backup.activeSiteId
          : Object.keys(profiles)[0] || "",
      selectedSiteIds,
      urlList: backup.urlList || current.urlList || "",
    };
  }

  global.ExtLinkBackup = { FORMAT, validateBackup, mergeBackup };
})(typeof self !== "undefined" ? self : window);

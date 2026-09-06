import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sidepanelHtml = readFileSync("extension/sidepanel.html", "utf8");
const sidepanelJs = readFileSync("extension/sidepanel.js", "utf8");
const settingsHtml = readFileSync("extension/settings.html", "utf8");
const settingsJs = readFileSync("extension/settings.js", "utf8");
const settingsCss = readFileSync("extension/settings.css", "utf8");
const css = readFileSync("extension/sidepanel.css", "utf8");
const background = readFileSync("extension/background.js", "utf8");
const popupHtml = readFileSync("extension/popup.html", "utf8");
const popupJs = readFileSync("extension/popup.js", "utf8");

for (const panel of ["home", "batch", "manual"]) {
  assert.match(sidepanelHtml, new RegExp(`id="panel-${panel}"`));
}
assert.match(sidepanelHtml, /id="batchSiteChoices"/);
assert.match(sidepanelHtml, /id="batchSelectionSummary"/);
assert.match(sidepanelHtml, /id="manualTaskList"/);
assert.match(sidepanelJs, /selectedSiteIds/);
assert.match(sidepanelJs, /action:\s*"confirmSubmissionSuccess"/);
assert.match(sidepanelJs, /外链站.*正在提交.*本站.*总进度/);
assert.doesNotMatch(sidepanelJs, /innerHTML\s*=/);

assert.match(settingsHtml, /id="panel-library"/);
assert.match(settingsHtml, /class="library-split"/);
assert.match(settingsHtml, /id="railLibraryTools"/);
assert.match(settingsHtml, /id="libraryCount"/);
assert.match(settingsHtml, /id="siteScreenshots"/);
assert.match(settingsHtml, /id="btnExportLedger"/);
assert.match(settingsHtml, /id="btnImportLedger"/);
assert.match(settingsHtml, /id="profileFieldList"/);
assert.match(settingsHtml, /id="btnLibraryLoadMore"/);
assert.match(settingsHtml, /id="libraryProgressFilter"/);
assert.match(settingsHtml, /lib\/submission-timeline\.js/);
assert.match(settingsHtml, /href="settings\.css"/);
for (const id of [
  "cloudWorkerEndpoint",
  "cloudAccessToken",
  "cloudWorkspaceId",
  "btnCloudConnect",
  "btnCloudMigrate",
  "btnCloudPull",
  "btnCloudPush",
  "cloudSyncStatus",
  "linkMonitorStatus",
  "btnRunLinkMonitor",
  "libraryQualityFilter",
  "librarySort",
  "autoSubmitStandardWpComments",
]) {
  assert.match(settingsHtml, new RegExp(`id="${id}"`));
}
assert.match(settingsJs, /action:\s*"getLibraryManagerState"/);
assert.match(settingsJs, /action:\s*"exportSubmissionData"/);
assert.match(settingsJs, /action:\s*"importSubmissionData"/);
assert.match(settingsJs, /action:\s*"cloudSyncConnect"/);
assert.match(settingsJs, /action:\s*"cloudSyncMigrate"/);
assert.match(settingsJs, /action:\s*"cloudSyncPull"/);
assert.match(settingsJs, /action:\s*"cloudSyncPush"/);
assert.match(settingsJs, /action:\s*"runLinkMonitor"/);
assert.match(settingsJs, /library-status/);
assert.match(settingsJs, /annotationTone/);
assert.match(settingsJs, /setActivePanel/);
assert.match(settingsJs, /profile\.latestEvent/);
assert.match(settingsJs, /action:\s*"addSubmissionTimelineEvent"/);
assert.match(settingsJs, /createSheetFieldsDetails/);
assert.match(settingsJs, /renderProfileFields/);
assert.match(settingsJs, /deriveLibraryProgress/);
assert.match(settingsJs, /createKeyDetail/);
assert.match(settingsJs, /质量分 \$\{score\}/);
assert.match(settingsJs, /待确认收录/);
assert.match(settingsJs, /表格有提交动作 · 未核验/);
assert.doesNotMatch(settingsJs, /innerHTML\s*=/);

assert.match(settingsCss, /library-status\.can_submit/);
assert.match(settingsCss, /library-status\.needs_manual/);
assert.match(settingsCss, /library-item:hover/);
assert.match(settingsCss, /profile-statuses:empty/);
assert.match(settingsCss, /library-item-actions[\s\S]*gap:\s*10px/);
assert.match(settingsCss, /library-item-actions \.btn:focus-visible/);
assert.match(settingsCss, /prefers-reduced-motion/);
assert.match(settingsCss, /quality-score\.priority/);
assert.match(settingsCss, /library-split/);
assert.match(settingsCss, /#panel-library \.library-tools[\s\S]*overflow-y:\s*auto/);
assert.match(
  settingsCss,
  /#panel-library \.library-list\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/,
  "the dense library needs one full-width destination card per row",
);
assert.match(settingsCss, /monitor-tag\.missing/);
assert.match(settingsCss, /timeline-event/);
assert.match(settingsCss, /profile-field-row/);

assert.match(css, /min-height:\s*44px/);
assert.match(css, /:focus-visible/);
assert.match(background, /case "getLibraryManagerState"/);
assert.match(
  background,
  /case "getLibraryManagerState":\s*getLibraryManagerState\(msg\)/,
  "a side panel timeline query must pass its current URL through to the existing library manager",
);
assert.match(background, /case "addSubmissionTimelineEvent"/);
assert.match(background, /submissionTimeline/);
assert.match(background, /case "cloudSyncMigrate"/);
assert.match(background, /case "runLinkMonitor"/);
assert.match(background, /gatedByQuality/);
assert.match(sidepanelJs, /renderMetricChip\("可索引"/);
assert.match(sidepanelJs, /renderMetricChip\("Noindex"/);
assert.match(sidepanelHtml, /id="playbookNote"/);
assert.match(sidepanelJs, /熟站 \$\{playbook\.title\}/);
assert.doesNotMatch(background, /python3 -m local_agent\.server/);
assert.match(settingsJs, /autoSubmitStandardWpComments/);
assert.match(settingsJs, /pending_moderation/);
assert.match(settingsCss, /profile-status\.published/);
assert.match(background, /LINK_MONITOR_ALARM/);
assert.match(background, /cloudSyncPendingKeys/);
assert.match(background, /candidateKeys\.has\(key\)/);
assert.match(
  background,
  /isSubmissionSuccessful\(records,\s*key,\s*profile\.id\)/,
);
assert.match(background, /self\.ExtLinkBackup\.mergeBackup/);
assert.match(background, /restoreActiveBatchRun/);
assert.match(background, /\["running", "waiting_manual", "paused"\]/);
assert.match(background, /parkedTaskIds/);
const advanceGroup = background.match(
  /async function advanceDestinationGroup[\s\S]*?\n}\n\nfunction getManualWaitTimeoutSec/,
)?.[0];
assert.ok(advanceGroup, "advanceDestinationGroup should exist");
assert.match(advanceGroup, /nextTask\.status = "needs_manual"/);
assert.match(advanceGroup, /无法重新进入提交入口/);
assert.match(advanceGroup, /parkTaskEntry/);
assert.doesNotMatch(advanceGroup, /recordSubmittedProject/);

for (const panel of ["submit", "sites", "config", "log"]) {
  assert.match(popupHtml, new RegExp(`id="panel-${panel}"`));
}
assert.match(popupJs, /action:\s*"getSubmissionQueue",\s*selectedSiteIds/);
assert.match(popupJs, /action:\s*"start",\s*selectedSiteIds/);
assert.match(background, /tasks:\s*groups\.map\(toSubmissionGroupSummary\)/);
assert.doesNotMatch(
  background.match(/async function getSubmissionQueueState[\s\S]*?\n}\n\nfunction toSubmissionGroupSummary/)?.[0] || "",
  /\bjobs,\s*\n/,
);

console.log("UI workflow tests passed");

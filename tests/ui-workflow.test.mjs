import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sidepanelHtml = readFileSync("extension/sidepanel.html", "utf8");
const sidepanelJs = readFileSync("extension/sidepanel.js", "utf8");
const settingsHtml = readFileSync("extension/settings.html", "utf8");
const settingsJs = readFileSync("extension/settings.js", "utf8");
const settingsCss = readFileSync("extension/settings.css", "utf8");
const css = readFileSync("extension/sidepanel.css", "utf8");
const background = readFileSync("extension/background.js", "utf8");

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
assert.match(settingsHtml, /id="siteScreenshots"/);
assert.match(settingsHtml, /id="btnExportLedger"/);
assert.match(settingsHtml, /id="btnImportLedger"/);
assert.match(settingsHtml, /href="settings\.css"/);
for (const id of [
  "googleSheetId",
  "btnGoogleConnect",
  "btnGooglePreview",
  "btnGoogleApply",
  "btnGooglePush",
  "btnGoogleDisconnect",
  "googleSyncStatus",
  "googleSyncPreview",
]) {
  assert.match(settingsHtml, new RegExp(`id="${id}"`));
}
assert.match(settingsJs, /action:\s*"getLibraryManagerState"/);
assert.match(settingsJs, /action:\s*"exportSubmissionData"/);
assert.match(settingsJs, /action:\s*"importSubmissionData"/);
assert.match(settingsJs, /action:\s*"googleAuthStart"/);
assert.match(settingsJs, /action:\s*"googleSyncPreview"/);
assert.match(settingsJs, /action:\s*"googleSyncApply"/);
assert.match(settingsJs, /action:\s*"googlePushLedger"/);
assert.match(settingsJs, /library-status/);
assert.match(settingsJs, /annotationTone/);
assert.doesNotMatch(settingsJs, /innerHTML\s*=/);

assert.match(settingsCss, /library-status\.can_submit/);
assert.match(settingsCss, /library-status\.needs_manual/);
assert.match(settingsCss, /library-item:hover/);
assert.match(settingsCss, /profile-statuses:empty/);
assert.match(settingsCss, /library-item-actions[\s\S]*gap:\s*10px/);
assert.match(settingsCss, /library-item-actions \.btn:focus-visible/);
assert.match(settingsCss, /prefers-reduced-motion/);

assert.match(css, /min-height:\s*44px/);
assert.match(css, /:focus-visible/);
assert.match(background, /case "getLibraryManagerState"/);
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

console.log("UI workflow tests passed");

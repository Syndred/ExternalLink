import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");
const background = readFileSync(resolve(root, "extension/background.js"), "utf8");
const sidepanel = readFileSync(resolve(root, "extension/sidepanel.js"), "utf8");
const popup = readFileSync(resolve(root, "extension/popup.js"), "utf8");
const readme = readFileSync(resolve(root, "extension/README.md"), "utf8");
const envExample = readFileSync(resolve(root, ".env.example"), "utf8");
const manifestText = readFileSync(resolve(root, "extension/manifest.json"), "utf8");
const manifest = JSON.parse(manifestText);

assert.equal(
  content.includes(":has-text("),
  false,
  "content.js must not use Playwright-only :has-text selectors in browser querySelector",
);

assert.match(
  content,
  /findSubmissionLink/,
  "content.js should discover submit/add/list links when the landing page has no form",
);

assert.match(
  content,
  /navigating:\s*true/,
  "content.js should return a navigation request when it discovers submission links",
);

assert.match(
  background,
  /chrome\.tabs\.update\(tabId,\s*\{\s*url(?:,|:)/,
  "background.js should navigate tracked task tabs after content.js returns a navigation request",
);
assert.match(
  content,
  /const beforeStage = formStageSignature\(\);[\s\S]*afterStage !== beforeStage[\s\S]*stageAdvanced: true/,
  "same-URL multi-step forms must continue when the form stage changes without final evidence",
);
assert.doesNotMatch(
  background,
  /sidePanel\.open\(/,
  "the background must not call sidePanel.open outside a user gesture",
);
assert.doesNotMatch(
  readFileSync(resolve(root, "extension/settings.html"), "utf8"),
  /id=["']autoOpenSidePanel["']/,
  "settings must not expose an automatic side-panel option Chrome cannot support",
);

assert.doesNotMatch(
  content,
  /chrome\.runtime\.sendMessage\(\s*\{\s*action:\s*'navigateToSubmission'/,
  "content.js must not navigate during an in-flight tabs.sendMessage response",
);

assert.match(content, /input\[type="email"\]/, "generic form filling should include email inputs");

assert.match(
  content,
  /marketingOptIn[\s\S]*bestScore\s*>\s*candidate\.fillable\.length/,
  "newsletter popups must not hide a larger directory submission form",
);

assert.match(
  content,
  /function\s+detectArticleComment\s*\([\s\S]*commentField\s*&&\s*submit/,
  "generic POST/search forms must not be misclassified as comment forms",
);

assert.match(
  content,
  /\[contenteditable=["']true["']\]/,
  "generic form filling should discover rich-text contenteditable editors",
);

assert.match(
  content,
  /function\s+isContentEditableField\s*\(/,
  "contenteditable fields should use explicit editor handling",
);

assert.match(
  content,
  /classList\?\.remove\(["']ql-blank["']\)/,
  "Quill editors should leave their blank state after a programmatic fill",
);

assert.match(
  background,
  /case\s+["']fetchSubmissionMedia["']:/,
  "the background should proxy cross-origin submission media downloads",
);

assert.match(
  content,
  /action:\s*["']fetchSubmissionMedia["']/,
  "file filling should fall back to the background media proxy",
);

assert.match(
  content,
  /canvas\.toBlob/,
  "file filling should normalize unsupported image formats and dimensions",
);

assert.match(
  content,
  /function\s+fillChoiceGroups\s*\(/,
  "required checkbox groups should be treated as one logical field",
);

assert.match(
  content,
  /function\s+resolveDateValue\s*\(/,
  "launch-date fields should have an explicit resolver",
);

assert.match(
  content,
  /getNativeValueSetter/,
  "form filling should use native value setters so React/Vue controlled inputs receive changes",
);

assert.match(
  content,
  /manual:\s*true/,
  "content.js should keep a tab open when fields were filled but no submit button was found",
);

assert.match(
  background,
  /judge\.status\s*===\s*['"]needs_manual['"]/,
  "background.js should keep task tabs open when the local agent needs manual submit",
);
assert.match(
  content,
  /停放中，不会自动关闭/,
  "manual task banners should explain that parked tabs are not closed by a timeout",
);
assert.match(
  sidepanel,
  /action:\s*["']confirmSubmissionSuccess["']/,
  "the trusted extension side panel should let the user confirm a real submission success",
);
assert.doesNotMatch(content, /action:\s*["']confirmSubmissionSuccess["']/,
  "target pages must not be able to trigger trusted success confirmation");
assert.match(
  background,
  /countProcessingSlots\(state\.activeTabs\)/,
  "parked tabs should not consume the batch concurrency slot",
);

assert.match(
  background,
  /EXECUTION_TIMEOUT_MS/,
  "background.js should use a named timeout for form execution instead of one hard-coded page timer",
);

assert.match(
  background,
  /delayCloseTab/,
  "background.js should delay closing tabs after a successful fill/submit so the user can inspect the result",
);

assert.match(
  background,
  /resetEntryTimeout\(entry,\s*tab\.id,\s*EXECUTION_TIMEOUT_MS\)/,
  "background.js should reset the timeout before starting slow form filling",
);

assert.match(background, /function\s+callCloudAgent\s*\(/, "background should use the authenticated cloud Worker");
assert.doesNotMatch(background, /127\.0\.0\.1:8790/, "background must not require a local Agent service");

assert.match(
  background,
  /function\s+runAgentLoop\s*\(/,
  "background.js should define runAgentLoop()",
);

assert.match(
  background,
  /case\s+["']start["']:[\s\S]{0,160}?startBatchRunOnce\(msg\)/,
  "the start message should rebuild a fresh batch run",
);
assert.match(
  background,
  /async function\s+startBatchRun\(msg\)[\s\S]*?const preservedManualTabs = preserveManualTabsForNewBatch\(\)[\s\S]*?state\.tasks =/,
  "a fresh batch run should preserve manual-review tabs before replacing task state",
);
assert.match(
  background,
  /profileConfigs:\s*state\.profileConfigs[\s\S]{0,180}?destinations:\s*serializeBatchDestinations[\s\S]{0,180}?tasks:\s*serializeBatchTasks/,
  "batch persistence should store one Profile snapshot plus compact destination/task rows",
);
assert.match(
  background,
  /const\s+BATCH_TASK_WINDOW_SIZE\s*=\s*\d+[\s\S]*function\s+buildTaskWindow/,
  "large batches should send a bounded task window to the side panel",
);
assert.match(
  background,
  /function\s+scheduleQueueProcessing[\s\S]*if\s*\(processQueuePromise\)/,
  "only one queue-processing loop may run at a time",
);
assert.match(
  background,
  /BATCH_LOG_STORAGE_KEY\s*=\s*["']batchRunLog["'][\s\S]*function\s+persistBatchLogEntry/,
  "batch diagnostics should persist in extension storage instead of living only in the open panel",
);
assert.match(
  background,
  /case\s+["']log["']:[\s\S]{0,500}?sender\.tab\?\.id[\s\S]{0,500}?event:\s*msg\.event\s*\|\|\s*["']content_step["']/,
  "content-script progress logs should be accepted only from a real task tab and persisted with context",
);
assert.doesNotMatch(
  background.match(/function\s+broadcastTaskUpdate[\s\S]*?\n}\n\nfunction\s+broadcastStatus/)?.[0] || "",
  /activeBatchRun/,
  "each task update must not rewrite the full batch checkpoint",
);
for (const action of ["executeSubmit", "finalizeSubmit", "trySubmit"]) {
  assert.match(
    content,
    new RegExp(`msg\\.action === ["']${action}["'][\\s\\S]{0,220}?\\.catch\\(\\(err\\) => sendResponse`),
    `${action} should return async failures instead of leaving an unhandled rejection`,
  );
}

assert.match(
  background,
  /function\s+handleTimeout[\s\S]*bumpEntryRunId\(entry\)/,
  "background.js should invalidate in-flight agent work when a tab times out",
);

assert.match(
  background,
  /function\s+runAgentLoop[\s\S]*const\s+runId\s*=\s*nextEntryRunId\(entry\)[\s\S]*assertRunCurrent\(tabId,\s*entry,\s*runId\)/,
  "background.js should check a per-entry run token before continuing after awaits",
);

assert.match(
  background,
  /function\s+handleContentReady[\s\S]*pendingRejudge[\s\S]*runRuleBasedFill\(tab\.id,\s*task,\s*entry,\s*\{[\s\S]*pendingRejudge:/,
  "background.js should resume deterministic handling when contentReady fires after navigation",
);

assert.match(
  background,
  /agentPaused[\s\S]*looksReadyForManualResume[\s\S]*runRuleBasedFill\(tab\.id,\s*task,\s*entry,\s*\{[\s\S]*manual:\s*true/,
  "background.js should automatically resume deterministic handling when the user navigates to a recognizable form page",
);

assert.match(background, /function\s+handOffToVisualAgent\s*\(/,
  "complex or failed deterministic flows need an explicit visual-agent handoff");
assert.match(background, /allowAgent:\s*false/,
  "ordinary batch forms must complete their deterministic pass before an AI escalation");
assert.match(background, /visualEscalation:\s*true/,
  "only an explicit handoff may enter the visual execution loop");
assert.match(background, /function\s+isVisualSubmissionAction\s*\(/,
  "fill-only visual supervision must filter final submission clicks");
assert.match(background, /function\s+resolveVisualCoordinateTarget\s*\([\s\S]*\.rect[\s\S]*selector/,
  "coordinate plans must resolve to annotated controls before fill-only safety filtering");
assert.match(content, /function\s+isAutomatableFileInput\s*\(/,
  "visible upload dropzones should expose their hidden file control for DataTransfer injection");
assert.match(content, /function\s+isLikelyCustomClickTarget\s*\(/,
  "visual snapshots must discover framework custom controls that omit native input and ARIA roles");
assert.match(content, /getComputedStyle\(element\)\.cursor\s*!==\s*["']pointer["']/,
  "generic custom-control discovery should recognize visible pointer-style cards");
assert.match(content, /element\.matches\(["']label["']\)[\s\S]*querySelector\(["']input\[type=[^\n]+radio[^\n]+checkbox/,
  "visual snapshots must expose label cards that wrap hidden radio or checkbox controls");
assert.match(content, /collectVisualSnapshotCandidates\(\)/,
  "the annotated screenshot must use the shared custom-control candidate collector");
assert.match(content, /return\s+\[\.\.\.customCandidates,\s*\.\.\.nativeCandidates\][\s\S]*filter\(isInVisualViewport\)[\s\S]*slice\(0,\s*80\)/,
  "visible custom controls must not be displaced by offscreen navigation and footer links");
assert.match(content, /uploadedFiles/,
  "a media injection should request a visual preview check before the batch continues");

assert.match(
  background,
  /action:\s*['"]getPageSnapshot['"]/,
  "background.js should request page snapshots from content.js",
);

assert.match(
  background,
  /action:\s*['"]executeActionPlan['"]/,
  "background.js should send local-agent action plans to content.js",
);

assert.match(
  background,
  /summarizePlanActions/,
  "background.js should log local-agent action summaries for debugging partial fills",
);

assert.match(
  background,
  /summarizeActionResults/,
  "background.js should log action execution results when a form fill stalls",
);

assert.match(
  background,
  /judge\.status\s*===\s*['"]success['"]/,
  "background.js should only complete a task after judge reports success",
);

assert.match(
  background,
  /function\s+handleTerminalJudge[\s\S]*judge\.status\s*===\s*['"]error['"][\s\S]*markTask(?:NeedsManual|Blocked)\(/,
  "background.js should treat judge error status as terminal before planning",
);

assert.doesNotMatch(
  background,
  /if\s*\([^)]*result\s*(?:&&|\?\.)\s*result\.ok[^)]*\)\s*\{[\s\S]{0,500}?task\.status\s*=\s*['"]ok['"]/,
  'background.js must not directly mark task.status = "ok" from result.ok without judge success evidence',
);

assert.ok(
  Array.isArray(manifest.host_permissions) && (
    manifest.host_permissions.includes("https://*/*") || manifest.host_permissions.includes("<all_urls>")
  ),
  "manifest.json should allow the extension service worker to fetch its HTTPS Worker",
);
assert.equal(
  manifest.host_permissions.includes("http://127.0.0.1:8790/*"),
  false,
  "manifest must not depend on a local Agent port",
);

assert.match(
  content,
  /msg\.type\s*===\s*['"]getPageSnapshot['"]/,
  "content.js should handle getPageSnapshot messages from background.js",
);

assert.match(
  content,
  /msg\.action\s*===\s*['"]getPageSnapshot['"]/,
  "content.js should also handle getPageSnapshot action messages from background.js",
);

assert.match(
  content,
  /msg\.type\s*===\s*['"]executeActionPlan['"]/,
  "content.js should handle executeActionPlan messages from background.js",
);

assert.match(
  content,
  /msg\.action\s*===\s*['"]executeActionPlan['"]/,
  "content.js should also handle executeActionPlan action messages from background.js",
);

for (const functionName of [
  "getPageSnapshot",
  "assignStableSelectors",
  "extSelector",
  "snapshotField",
  "snapshotButton",
  "isRelevantSnapshotElement",
  "executeActionPlan",
  "executeModelAction",
  "redactSnapshotUrl",
  "setSelectValue",
  "isActionElementAllowed",
]) {
  assert.match(
    content,
    new RegExp(`function\\s+${functionName}\\s*\\(`),
    `content.js should define ${functionName}()`,
  );
}

for (const sensitiveParam of ["token", "key", "secret", "code", "session", "csrf", "nonce"]) {
  assert.match(
    content,
    new RegExp(sensitiveParam, "i"),
    `redactSnapshotUrl should recognize sensitive ${sensitiveParam} query parameters`,
  );
}

assert.match(content, /REDACTED/, "redactSnapshotUrl should mask sensitive query values");

assert.match(
  content,
  /url:\s*redactSnapshotUrl\(location\.href\)/,
  "getPageSnapshot should redact location.href before returning it",
);

assert.match(
  content,
  /action:\s*redactSnapshotUrl\(form\.getAttribute\(['"]action['"]\)/,
  "getPageSnapshot should redact form action URLs",
);

assert.match(
  content,
  /href:\s*redactSnapshotUrl\(/,
  "snapshotButton should redact link href values",
);

assert.match(
  content,
  /data-extlink-selector/,
  "content snapshots should use data-extlink-selector stable selectors",
);

assert.match(
  content,
  /setAttribute\(\s*['"]data-extlink-selector['"]/,
  "content snapshots should assign data-extlink-selector attributes",
);

assert.match(
  content,
  /setFieldValue\(\s*element\s*,\s*fitted\s*\)/,
  "fill actions should apply the constraint-fitted value through the native setter helper",
);
assert.match(
  content,
  /fitValueToConstraints\(\s*raw\s*,\s*getFieldConstraints\(element\)\s*\)/,
  "fill actions should fit generated values to the target field constraints",
);

assert.match(
  content,
  /setSelectValue\(\s*element\s*,\s*action\.value/,
  "select actions should use the native value setter helper",
);

assert.match(popup, /云端服务暂不可用/, "popup should explain when the cloud service is unavailable");
assert.doesNotMatch(popup, /local_agent\.server|127\.0\.0\.1/, "popup must not require a local Agent");

assert.match(
  popup,
  /needs_manual|需要人工处理/,
  "popup should display or explain local-agent needs_manual status",
);

assert.match(
  popup,
  /storedLogLines/,
  "popup should persist recent log lines so reopening the popup does not lose diagnostics",
);

assert.doesNotMatch(
  popup,
  /needs_manual:\s*请手动处理验证码、登录或页面确认/,
  "popup should not explain every needs_manual stop as captcha/login/page confirmation",
);

assert.match(
  popup,
  /successEvidence|success evidence|成功证据|\/judge/,
  "popup should surface success evidence or judge-based success log language",
);

assert.match(readme, /Cloudflare Worker/, "README should document the cloud Worker data center");
assert.match(readme, /R2 私有媒体/, "README should document private cloud media");
assert.doesNotMatch(readme, /python3 -m local_agent\.server/, "README must not require a local Agent");

assert.match(
  readme,
  /judge[\s\S]{0,220}(success evidence|success\/thank-you\/submitted|page confirmation|成功证据|确认)/i,
  "README should explain success is marked only after cloud judge sees success evidence or page confirmation",
);

assert.match(
  readme,
  /not a fixed timer|not .*timer|不是.*定时|不是.*计时/i,
  "README should explain success is not determined by a fixed timer",
);

assert.match(envExample, /^EXTERNALLINK_CLOUD_URL=/m, ".env.example should include the Worker endpoint for one-time migration");
assert.match(envExample, /^EXTERNALLINK_CLOUD_TOKEN=/m, ".env.example should include the one-time migration device key");
assert.doesNotMatch(envExample, /^DEEPSEEK_API_KEY=/m, "DeepSeek credentials belong in Worker Secrets, not a local .env");

assert.match(
  content,
  /option\.textContent/,
  "select actions should match options by visible option text",
);

assert.match(content, /option\.label/, "select actions should match options by option label");

assert.match(
  content,
  /return actionFailure\(action,\s*['"]select option not found['"]\)/,
  "select actions should fail clearly when no option matches",
);

assert.match(
  content,
  /getNativeCheckedSetter/,
  "check actions should use a native checked setter helper",
);

assert.match(
  content,
  /action\.value\s*!==\s*false/,
  "check actions should honor normalized value: false actions",
);

assert.match(
  content,
  /action\.timeout_ms/,
  "wait actions should honor normalized timeout_ms actions",
);

assert.match(
  content,
  /isActionElementAllowed\(\s*element\s*,\s*action\.type\s*\)/,
  "action execution should reject hidden or off-snapshot action targets",
);

assert.match(
  content,
  /hasAttribute\(SNAPSHOT_SELECTOR_ATTR\)/,
  "action execution should only target snapshot-assigned elements",
);

assert.match(
  content,
  /Number\.isFinite/,
  "wait actions should normalize malformed waits to a finite timeout",
);

assert.match(
  content,
  /dispatchEvent\(new Event\(\s*['"]input['"]\s*,\s*\{\s*bubbles:\s*true\s*\}\)\)/,
  "fill/check actions should dispatch bubbling input events",
);

assert.match(
  content,
  /dispatchEvent\(new Event\(\s*['"]change['"]\s*,\s*\{\s*bubbles:\s*true\s*\}\)\)/,
  "fill/select/check actions should dispatch bubbling change events",
);

for (const actionType of ["fill", "click", "select", "check", "submit", "scroll", "wait"]) {
  assert.match(
    content,
    new RegExp(`case\\s+['"]${actionType}['"]`),
    `executeModelAction should support ${actionType} actions`,
  );
}

assert.match(
  content,
  /function\s+inspectStandardWpCommentForm\s*\(/,
  "standard WordPress comment preflight should exist",
);
assert.match(
  content,
  /autoSubmitStandardWpComments/,
  "optional standard WP auto-submit must stay behind an explicit flag",
);
assert.match(
  content,
  /isFillOnly\(config\) && !canAutoSubmit/,
  "fill-only must still win unless the standard WP preflight passed",
);
assert.match(
  content,
  /function\s+shouldAutoSubmitListing\s*\(/,
  "directory listings should have an explicit auto-submit gate",
);
assert.match(
  content,
  /function\s+detectSubmitBlockers\s*\(/,
  "auto-submit must stop on captcha, login, or paid buttons",
);
assert.match(
  content,
  /function\s+submitFilledForm\s*\(/,
  "filled directory forms should submit only after blocker checks",
);
assert.match(
  content,
  /function\s+collectFormValidationState\s*\(/,
  "submit should inspect required and invalid fields before treating a click as success",
);
assert.match(content, /validationFailed:\s*true/);
assert.match(content, /deferSubmit/);
assert.match(content, /action === ["']collectFormValidation["']/);
assert.match(
  content,
  /页签留下等人/,
  "captcha tabs should stay open for a human instead of being closed",
);
assert.match(
  background,
  /function tryAutoSubmitFilledForm/,
  "side panel fill should attempt directory auto-submit after a ready form",
);
assert.match(
  background,
  /function submitUntilAccepted/,
  "failed HTML/site validation should refill with AI instead of parking immediately",
);
assert.match(
  background,
  /function completeTaskFromSubmit/,
  "batch auto-submit should write the ledger only after submit evidence",
);
assert.match(
  background,
  /autoSubmitDirectoryListings/,
  "directory auto-submit should be a persisted setting",
);
assert.match(
  background,
  /lib\/playbooks\.js/,
  "background should load directory playbooks",
);
assert.match(manifestText, /lib\/playbooks\.js/, "content scripts should include playbooks");

const queue = readFileSync(resolve(root, "extension/lib/queue.js"), "utf8");
assert.match(queue, /publicationStatus/, "success records should store publication status");
assert.match(
  background,
  /submitResult\?\.submitted\s*&&\s*!submitResult\?\.matched[\s\S]*classifySubmitEvidence/,
  "a clicked submission must re-read evidence from the current document after same-URL navigation",
);
assert.match(
  background,
  /submitResult\.beforeStage[\s\S]*inspectCurrentFormStage[\s\S]*stageAdvanced: true/,
  "late-rendered same-URL stages must be detected before parking an unmatched submission",
);
assert.match(
  content,
  /inspectCurrentFormStage[\s\S]*signature: formStageSignature\(\)/,
  "content script should expose a read-only current-stage signature",
);
assert.match(
  content,
  /Multi-step pages sometimes render the next-step taxonomy controls[\s\S]*document\.querySelectorAll\("select"\)[\s\S]*categor\|industry\|sector\|niche\|vertical\|topic/,
  "generic filling should include taxonomy selects mounted outside the initial URL form",
);
assert.match(
  content,
  /function\s+findSubmitButton[\s\S]*Submit link[\s\S]*compareDocumentPosition[\s\S]*DOCUMENT_POSITION_FOLLOWING/,
  "submit selection should prefer the action belonging to the latest visible multi-step stage",
);
assert.match(
  content,
  /Links styled as buttons usually reopen[\s\S]*tagName\.toLowerCase\(\) === "a"/,
  "submission must not click promotional links styled as buttons",
);
assert.match(queue, /pending_moderation/, "publication status should include pending moderation");
assert.match(queue, /classifyStatusFromReason/, "queue should classify failure reasons");
assert.match(queue, /DEAD_END_STATUSES/, "queue should define dead-end statuses including paid");
assert.match(
  queue,
  /excludeStatuses \|\| \[\.\.\.DEAD_END_STATUSES, \.\.\.GATE_STATUSES\]/,
  "filterSubmissionTasks should exclude paid and parked human gates by default",
);
assert.match(background, /lines\.unshift/, "new URL library entries should prepend");
assert.match(
  background,
  /autoClassifySite/,
  "background should auto-classify blocked/manual sites",
);
assert.match(background, /listSiteAnnotations/, "background should list classified sites");
assert.match(
  background,
  /clearSiteAnnotation/,
  "background should support revoking classification",
);

// ─── AI comment generation replaces the hardcoded template pool ───
assert.doesNotMatch(
  content,
  /Great insights on this topic|Thanks for putting this together|Excellent breakdown\./,
  "content.js must not ship the old canned English comment templates",
);
assert.match(
  content,
  /async function generateComment\s*\(/,
  "generateComment should be async so it can request an AI draft",
);
assert.match(
  content,
  /action:\s*["']generateCommentDrafts["']/,
  "content.js should request comment drafts through the background service worker",
);
assert.match(
  content,
  /function extractArticleText\s*\(/,
  "content.js should extract article body text as comment context",
);
assert.match(
  content,
  /clone\.querySelectorAll\(ARTICLE_NOISE_SELECTORS\)/,
  "article extraction must strip nav/footer/comment noise from a clone, not the live page",
);
assert.match(
  background,
  /case\s+["']generateCommentDrafts["']:/,
  "background should expose a comment draft endpoint to content scripts",
);
assert.match(
  background,
  /callCloudAgent\("\/comment"/,
  "background should call the cloud comment endpoint",
);
for (const site of ["wp_comment", "article"]) {
  assert.match(
    content,
    new RegExp(`reason:\\s*["']no_comment_text["'][\\s\\S]{0,80}|platform:\\s*["']${site}["']`),
    `${site} submission should bail out instead of posting an empty comment`,
  );
}
assert.match(
  content,
  /await generateComment\(config,\s*\{/,
  "comment call sites must await the async draft",
);

// ─── Cloud media upload injection ───
assert.match(
  content,
  /function isCloudMediaRef\s*\(/,
  "content.js should recognise authenticated cloud media references",
);
assert.match(
  content,
  /action:\s*["']fetchCloudSubmissionMedia["']/,
  "content.js should request cloud media bytes from the background",
);
assert.match(
  content,
  /new DataTransfer\(\)[\s\S]{0,120}input\.files = dt\.files/,
  "uploads must be injected with File + DataTransfer instead of a file picker",
);
assert.match(
  background,
  /case\s+["']fetchCloudSubmissionMedia["']:/,
  "background should proxy private cloud media reads",
);
assert.match(
  background,
  /\/v1\/media\//,
  "background should read media through the Worker API",
);

// ─── Target quality prescan and gating ───
assert.match(content, /function prescanPage\s*\(/, "content.js should expose a target prescan");
assert.match(
  content,
  /dofollowLikely/,
  "prescan should estimate whether the site grants dofollow links",
);
assert.match(
  content,
  /commentExternal >= 3/,
  "prescan should prefer existing comment links over editorial links as the dofollow signal",
);
assert.match(
  background,
  /case\s+["']getDomainMetrics["']:/,
  "background should expose domain age lookups",
);
assert.match(
  background,
  /callCloudAgent\("\/domain\/metrics"/,
  "background should resolve domain age through the cloud Worker",
);
assert.match(
  background,
  /function normalizeTargetFilters\s*\(/,
  "background should normalize the target filter settings",
);
assert.match(
  background,
  /minDomainAgeMonths:\s*filters\.minDomainAgeMonths/,
  "queue building should pass the age threshold into the shared filter",
);
assert.match(
  background,
  /domainMetrics:\s*storage\.domainMetricsCache/,
  "queue building must read cached ages instead of blocking on network lookups",
);
assert.doesNotMatch(
  background,
  /await getDomainMetrics\([\s\S]{0,200}loadPendingSubmissionTasks/,
  "queue building must not trigger RDAP lookups inline",
);

// ─── Manual fill icons ───
assert.match(
  content,
  /function syncManualIcons\s*\(/,
  "content.js should install per-field manual fill icons",
);
assert.match(
  content,
  /filters\.showManualFillIcons === false/,
  "manual fill icons must respect the settings toggle",
);
assert.match(
  content,
  /function pageLooksLikeManualFillTarget\s*\(/,
  "manual fill icons should only decorate comment or directory submission pages",
);
assert.match(
  content,
  /isSearchOrChromeField/,
  "manual fill icons should skip search and chrome fields",
);
assert.match(
  content,
  /function teardownManualIcons\s*\(/,
  "manual fill icons should be removable when disabled",
);
assert.match(
  background,
  /case\s+["']getActiveFillConfig["']:/,
  "background should hand the active profile config to in-page icons",
);
assert.doesNotMatch(
  content,
  /if \(manualIconConfig\) return manualIconConfig/,
  "EL icons must re-read the current Profile instead of caching the first site's copy",
);
assert.match(content, /changes\.activeSiteId \|\| changes\.siteProfiles/);

const settingsHtml = readFileSync(resolve(root, "extension/settings.html"), "utf8");
const settingsJs = readFileSync(resolve(root, "extension/settings.js"), "utf8");
for (const id of [
  "filterBlacklistEnabled",
  "filterMinDomainAge",
  "filterRequireKnownAge",
  "domainBlacklistText",
  "filterAiComments",
  "filterAiCommentAllowLink",
  "filterManualFillIcons",
  "btnSaveTargetGate",
  "btnPrefetchDomainAge",
  "btnSaveAssistant",
  "btnRefreshMediaLibrary",
]) {
  assert.match(settingsHtml, new RegExp(`id="${id}"`), `settings.html should expose #${id}`);
  assert.match(settingsJs, new RegExp(`"${id}"`), `settings.js should bind #${id}`);
}
assert.match(
  settingsJs,
  /action:\s*["']updateDomainBlacklist["'][\s\S]{0,160}replace:\s*true/,
  "saving the blacklist textarea should replace the stored list, not append forever",
);

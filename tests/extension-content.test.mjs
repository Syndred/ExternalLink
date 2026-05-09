import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const content = readFileSync(resolve(root, 'extension/content.js'), 'utf8');
const background = readFileSync(resolve(root, 'extension/background.js'), 'utf8');
const popup = readFileSync(resolve(root, 'extension/popup.js'), 'utf8');
const readme = readFileSync(resolve(root, 'extension/README.md'), 'utf8');
const envExample = readFileSync(resolve(root, '.env.example'), 'utf8');
const manifestText = readFileSync(resolve(root, 'extension/manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);

assert.equal(
  content.includes(':has-text('),
  false,
  'content.js must not use Playwright-only :has-text selectors in browser querySelector',
);

assert.match(
  content,
  /findSubmissionLink/,
  'content.js should discover submit/add/list links when the landing page has no form',
);

assert.match(
  content,
  /navigating:\s*true/,
  'content.js should return a navigation request when it discovers submission links',
);

assert.match(
  background,
  /chrome\.tabs\.update\(tabId,\s*\{\s*url(?:,|:)/,
  'background.js should navigate tracked task tabs after content.js returns a navigation request',
);

assert.doesNotMatch(
  content,
  /chrome\.runtime\.sendMessage\(\s*\{\s*action:\s*'navigateToSubmission'/,
  'content.js must not navigate during an in-flight tabs.sendMessage response',
);

assert.match(
  content,
  /input\[type="email"\]/,
  'generic form filling should include email inputs',
);

assert.match(
  content,
  /getNativeValueSetter/,
  'form filling should use native value setters so React/Vue controlled inputs receive changes',
);

assert.match(
  content,
  /manual:\s*true/,
  'content.js should keep a tab open when fields were filled but no submit button was found',
);

assert.match(
  background,
  /judge\.status\s*===\s*['"]needs_manual['"]/,
  'background.js should keep task tabs open when the local agent needs manual submit',
);

assert.match(
  background,
  /EXECUTION_TIMEOUT_MS/,
  'background.js should use a named timeout for form execution instead of one hard-coded page timer',
);

assert.match(
  background,
  /delayCloseTab/,
  'background.js should delay closing tabs after a successful fill/submit so the user can inspect the result',
);

assert.match(
  background,
  /resetEntryTimeout\(entry,\s*tab\.id,\s*EXECUTION_TIMEOUT_MS\)/,
  'background.js should reset the timeout before starting slow form filling',
);

assert.match(
  background,
  /LOCAL_AGENT_URL\s*=\s*['"]http:\/\/127\.0\.0\.1:8787['"]/,
  'background.js should point LOCAL_AGENT_URL at the local agent service',
);

assert.match(
  background,
  /function\s+callLocalAgent\s*\(/,
  'background.js should define callLocalAgent()',
);

assert.match(
  background,
  /function\s+runAgentLoop\s*\(/,
  'background.js should define runAgentLoop()',
);

assert.match(
  background,
  /case\s+["']start["']:[\s\S]{0,300}?closeAllTabs\(\)[\s\S]{0,300}?state\.config\s*=\s*msg\.config/,
  'background.js should clear existing active tabs before replacing task state on start',
);

assert.match(
  background,
  /function\s+handleTimeout[\s\S]*bumpEntryRunId\(entry\)/,
  'background.js should invalidate in-flight agent work when a tab times out',
);

assert.match(
  background,
  /function\s+runAgentLoop[\s\S]*const\s+runId\s*=\s*nextEntryRunId\(entry\)[\s\S]*assertRunCurrent\(tabId,\s*entry,\s*runId\)/,
  'background.js should check a per-entry run token before continuing after awaits',
);

assert.match(
  background,
  /function\s+handleContentReady[\s\S]*pendingRejudge[\s\S]*runAgentLoop\(tab\.id,\s*task,\s*entry,\s*\{[\s\S]*pendingRejudge:\s*true/,
  'background.js should resume a pending rejudge when contentReady fires after navigation',
);

assert.match(
  background,
  /agentPaused[\s\S]*looksReadyForManualResume[\s\S]*runAgentLoop\(tab\.id,\s*task,\s*entry,\s*\{[\s\S]*manual:\s*true/,
  'background.js should automatically resume a paused manual task when the user navigates to a recognizable form page',
);

assert.match(
  background,
  /action:\s*['"]getPageSnapshot['"]/,
  'background.js should request page snapshots from content.js',
);

assert.match(
  background,
  /action:\s*['"]executeActionPlan['"]/,
  'background.js should send local-agent action plans to content.js',
);

assert.match(
  background,
  /summarizePlanActions/,
  'background.js should log local-agent action summaries for debugging partial fills',
);

assert.match(
  background,
  /summarizeActionResults/,
  'background.js should log action execution results when a form fill stalls',
);

assert.match(
  background,
  /judge\.status\s*===\s*['"]success['"]/,
  'background.js should only complete a task after judge reports success',
);

assert.match(
  background,
  /function\s+handleTerminalJudge[\s\S]*judge\.status\s*===\s*['"]error['"][\s\S]*markTask(?:NeedsManual|Blocked)\(/,
  'background.js should treat judge error status as terminal before planning',
);

assert.doesNotMatch(
  background,
  /if\s*\([^)]*result\s*(?:&&|\?\.)\s*result\.ok[^)]*\)\s*\{[\s\S]{0,500}?task\.status\s*=\s*['"]ok['"]/,
  'background.js must not directly mark task.status = "ok" from result.ok without judge success evidence',
);

assert.ok(
  Array.isArray(manifest.host_permissions) &&
    manifest.host_permissions.includes('http://127.0.0.1:8787/*'),
  'manifest.json should allow the extension service worker to fetch the local agent',
);

assert.match(
  content,
  /msg\.type\s*===\s*['"]getPageSnapshot['"]/,
  'content.js should handle getPageSnapshot messages from background.js',
);

assert.match(
  content,
  /msg\.action\s*===\s*['"]getPageSnapshot['"]/,
  'content.js should also handle getPageSnapshot action messages from background.js',
);

assert.match(
  content,
  /msg\.type\s*===\s*['"]executeActionPlan['"]/,
  'content.js should handle executeActionPlan messages from background.js',
);

assert.match(
  content,
  /msg\.action\s*===\s*['"]executeActionPlan['"]/,
  'content.js should also handle executeActionPlan action messages from background.js',
);

for (const functionName of [
  'getPageSnapshot',
  'assignStableSelectors',
  'extSelector',
  'snapshotField',
  'snapshotButton',
  'isRelevantSnapshotElement',
  'executeActionPlan',
  'executeModelAction',
  'redactSnapshotUrl',
  'setSelectValue',
  'isActionElementAllowed',
]) {
  assert.match(
    content,
    new RegExp(`function\\s+${functionName}\\s*\\(`),
    `content.js should define ${functionName}()`,
  );
}

for (const sensitiveParam of ['token', 'key', 'secret', 'code', 'session', 'csrf', 'nonce']) {
  assert.match(
    content,
    new RegExp(sensitiveParam, 'i'),
    `redactSnapshotUrl should recognize sensitive ${sensitiveParam} query parameters`,
  );
}

assert.match(
  content,
  /REDACTED/,
  'redactSnapshotUrl should mask sensitive query values',
);

assert.match(
  content,
  /url:\s*redactSnapshotUrl\(location\.href\)/,
  'getPageSnapshot should redact location.href before returning it',
);

assert.match(
  content,
  /action:\s*redactSnapshotUrl\(form\.getAttribute\(['"]action['"]\)/,
  'getPageSnapshot should redact form action URLs',
);

assert.match(
  content,
  /href:\s*redactSnapshotUrl\(/,
  'snapshotButton should redact link href values',
);

assert.match(
  content,
  /data-extlink-selector/,
  'content snapshots should use data-extlink-selector stable selectors',
);

assert.match(
  content,
  /setAttribute\(\s*['"]data-extlink-selector['"]/,
  'content snapshots should assign data-extlink-selector attributes',
);

assert.match(
  content,
  /setFieldValue\(\s*element\s*,\s*action\.value/,
  'fill actions should use the native value setter helper',
);

assert.match(
  content,
  /setSelectValue\(\s*element\s*,\s*action\.value/,
  'select actions should use the native value setter helper',
);

assert.match(
  popup,
  /local agent unavailable|本地代理未运行|python3 -m local_agent\.server/i,
  'popup should explain when the local agent is unavailable',
);

assert.match(
  popup,
  /needs_manual|需要人工处理/,
  'popup should display or explain local-agent needs_manual status',
);

assert.match(
  popup,
  /storedLogLines/,
  'popup should persist recent log lines so reopening the popup does not lose diagnostics',
);

assert.doesNotMatch(
  popup,
  /needs_manual:\s*请手动处理验证码、登录或页面确认/,
  'popup should not explain every needs_manual stop as captcha/login/page confirmation',
);

assert.match(
  popup,
  /successEvidence|success evidence|成功证据|\/judge/,
  'popup should surface success evidence or judge-based success log language',
);

assert.match(
  readme,
  /DEEPSEEK_API_KEY/,
  'README should document DEEPSEEK_API_KEY setup for the local agent',
);

assert.match(
  readme,
  /python3 -m local_agent\.server/,
  'README should document starting the local agent from the repo root',
);

assert.match(
  readme,
  /\/judge[\s\S]{0,220}(success evidence|success\/thank-you\/submitted|page confirmation|成功证据|确认)/i,
  'README should explain success is marked only after /judge sees success evidence or page confirmation',
);

assert.match(
  readme,
  /not a fixed timer|not .*timer|不是.*定时|不是.*计时/i,
  'README should explain success is not determined by a fixed timer',
);

assert.match(
  envExample,
  /^DEEPSEEK_API_KEY=/m,
  '.env.example should include DEEPSEEK_API_KEY=',
);

assert.match(
  envExample,
  /^DEEPSEEK_BASE_URL=https:\/\/api\.deepseek\.com$/m,
  '.env.example should include the DeepSeek base URL',
);

assert.match(
  envExample,
  /^DEEPSEEK_MODEL=deepseek-v4-pro$/m,
  '.env.example should default to deepseek-v4-pro',
);

assert.match(
  content,
  /option\.textContent/,
  'select actions should match options by visible option text',
);

assert.match(
  content,
  /option\.label/,
  'select actions should match options by option label',
);

assert.match(
  content,
  /return actionFailure\(action,\s*['"]select option not found['"]\)/,
  'select actions should fail clearly when no option matches',
);

assert.match(
  content,
  /getNativeCheckedSetter/,
  'check actions should use a native checked setter helper',
);

assert.match(
  content,
  /action\.value\s*!==\s*false/,
  'check actions should honor normalized value: false actions',
);

assert.match(
  content,
  /action\.timeout_ms/,
  'wait actions should honor normalized timeout_ms actions',
);

assert.match(
  content,
  /isActionElementAllowed\(\s*element\s*,\s*action\.type\s*\)/,
  'action execution should reject hidden or off-snapshot action targets',
);

assert.match(
  content,
  /hasAttribute\(SNAPSHOT_SELECTOR_ATTR\)/,
  'action execution should only target snapshot-assigned elements',
);

assert.match(
  content,
  /Number\.isFinite/,
  'wait actions should normalize malformed waits to a finite timeout',
);

assert.match(
  content,
  /dispatchEvent\(new Event\(\s*['"]input['"]\s*,\s*\{\s*bubbles:\s*true\s*\}\)\)/,
  'fill/check actions should dispatch bubbling input events',
);

assert.match(
  content,
  /dispatchEvent\(new Event\(\s*['"]change['"]\s*,\s*\{\s*bubbles:\s*true\s*\}\)\)/,
  'fill/select/check actions should dispatch bubbling change events',
);

for (const actionType of ['fill', 'click', 'select', 'check', 'submit', 'wait']) {
  assert.match(
    content,
    new RegExp(`case\\s+['"]${actionType}['"]`),
    `executeModelAction should support ${actionType} actions`,
  );
}

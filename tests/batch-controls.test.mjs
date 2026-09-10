import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const background = readFileSync(resolve(root, "extension/background.js"), "utf8");
const sidepanelHtml = readFileSync(resolve(root, "extension/sidepanel.html"), "utf8");
const sidepanel = readFileSync(resolve(root, "extension/sidepanel.js"), "utf8");

assert.match(background, /case\s+["']pause["']:/, "batch runs need an explicit pause message");
assert.match(background, /case\s+["']resume["']:/, "batch runs need an explicit resume message");
assert.match(background, /function\s+pauseBatchRun\s*\(/, "pause must persist a paused batch state");
assert.match(background, /function\s+resumeBatchRun\s*\(/, "resume must restart a paused batch state");
const pauseFunction = background.match(/async function\s+pauseBatchRun\s*\([\s\S]*?\n}\n\nasync function/)?.[0] || "";
assert.doesNotMatch(pauseFunction, /close(?:All|Automated)Tabs\(\)|activeTabs\.clear\(\)|queue\s*=\s*\[\]/, "pause must keep queue and tabs intact");
assert.match(sidepanelHtml, /id="btnBatchToggle"/, "batch UI needs one pause/resume toggle button");
assert.doesNotMatch(sidepanelHtml, /id="btnResumeBatch"/, "pause and resume must not be separate buttons");
assert.match(sidepanelHtml, /lib\/batch-controls\.js/, "side panel must load the shared batch state predicates");
assert.match(sidepanel, /btnBatchToggle/, "side panel must wire the pause/resume toggle");
assert.match(sidepanel, /resuming \? "resume" : "pause"/, "the toggle action must follow the current batch state");
assert.match(sidepanel, /batchStatus === "paused" \? "继续批量" : "暂停批量"/, "the toggle label must follow the current batch state");
assert.match(sidepanel, /确认创建 Product Hunt 草稿/, "Product Hunt final action needs an explicit action-time confirmation label");
assert.match(sidepanel, /confirmProductHuntCreate:\s*productHuntReady/, "only the explicit Product Hunt confirmation button may authorize Create draft");
const toggleClickHandler = sidepanel.match(/\$\("btnBatchToggle"\)\?\.addEventListener\([\s\S]*?\n  \}\);/)?.[0] || "";
assert.doesNotMatch(toggleClickHandler, /\blog\(/, "background is the single source of pause/resume log lines");

const stopCase = background.match(/case\s+["']stop["']:[\s\S]*?\n\s*break;/)?.[0] || "";
assert.doesNotMatch(stopCase, /closeAllTabs\(\)/, "stop must not close parked human-review tabs");
assert.match(background, /function\s+closeAutomatedTabs\s*\(/, "stop needs a selective automated-tab closer");
assert.match(stopCase, /stopBatchRun\(\)/, "the stop message must await the serialized stop transition");
assert.match(background, /async function\s+stopBatchRun[\s\S]*?await markActiveBatchStopped\(\)/, "stop must persist the stopped batch before replying");
assert.match(background, /function\s+markActiveBatchStopped[\s\S]*?parkedTaskIds:\s*\[\.\.\.state\.parkedTaskIds\]/, "stopped persistence must retain parked task ids");
assert.match(
  background,
  /const exactTab = task\.manualTabId\s*\?\s*tabsById\.get\(Number\(task\.manualTabId\)\)/,
  "restoring parked tabs must first honor the persisted task-to-tab binding",
);
assert.match(
  background,
  /sameDestinationTasks\.length === 1 && candidates\.length === 1/,
  "legacy parked tabs may use a destination fallback only when the host mapping is unambiguous",
);
assert.equal(
  [...background.matchAll(/log\("任务已停止"/g)].length,
  1,
  "a stop transition must write one final stopped line instead of duplicate identical logs",
);
const removedHandler = background.match(/chrome\.tabs\.onRemoved\.addListener\([\s\S]*?\n}\);/)?.[0] || "";
assert.match(removedHandler, /if \(state\.stopped\)/, "closing a tab after stop must not restart the queue");

const playbooks = readFileSync(resolve(root, "extension/lib/playbooks.js"), "utf8");
assert.match(playbooks, /id:\s*["']producthunt["'][\s\S]*?kind:\s*["']custom_launch["']/, "Product Hunt must use the custom launch route");
const playbookContext = { self: {}, URL };
vm.createContext(playbookContext);
vm.runInContext(playbooks, playbookContext);
assert.equal(
  playbookContext.self.ExtLinkPlaybooks.lookup("https://www.producthunt.com/posts/demo").kind,
  "custom_launch",
  "Product Hunt lookup must resolve to the custom launch playbook",
);
assert.match(background, /function\s+runProductHuntLaunchLoop\s*\(/, "Product Hunt needs a dedicated resumable launch loop");
assert.match(background, /isCustomLaunchTask\(task\)[\s\S]*https:\/\/www\.producthunt\.com\/posts\/new/,
  "Product Hunt batches must start from the launch dashboard rather than the marketing homepage");
const productGuard = background.match(/if \(isCustomLaunchUrl\(currentUrl\)\)\s*\{[\s\S]*?\n  \}/)?.[0] || "";
assert.match(productGuard, /runProductHuntStep/, "Product Hunt must use its dedicated content adapter");
assert.doesNotMatch(productGuard, /Product Hunt 多步骤发布需人工完成/, "Product Hunt must not be parked before running its workflow");
assert.match(background, /function\s+waitForTabContentReady\s*\(/, "content readiness needs a named wait helper");
assert.match(background, /tab\.status\s*===\s*["']complete["']/, "automation must wait for tabs.onUpdated complete");
assert.match(background, /state\.paused && !state\.stopped && entry\.slotActive !== false/, "pause must defer automated tab closes");
assert.match(background, /批量已暂停，暂不判定当前页签超时/, "pause must defer page timeout classification");
assert.match(background, /async function\s+handleContentReady[\s\S]*?if \(state\.stopped\) return;/, "contentReady must not restart a stopped run");
assert.match(background, /async function\s+resumeAfterCaptcha[\s\S]*?if \(state\.stopped\) return;/, "captcha callbacks must not restart a stopped run");
assert.match(sidepanel, /if \(batchStatus === "stopped"\) return;/, "a stopped run may open a manual tab but must not restart automation");
const confirmFunction = background.match(/async function\s+confirmSubmissionSuccess[\s\S]*?\n}\n\nasync function\s+resumeAfterCaptcha/)?.[0] || "";
assert.match(confirmFunction, /state\.parkedTaskIds\.delete\(task\.id\)/, "manual confirmation must clear parked state even if its tab was closed");

const helperContext = { self: {} };
vm.createContext(helperContext);
vm.runInContext(readFileSync(resolve(root, "extension/lib/batch-controls.js"), "utf8"), helperContext);
const controls = helperContext.self.ExtLinkBatchControls;
assert.equal(typeof controls.shouldProcessQueue, "function");
assert.deepEqual({ ...controls.controlVisibility("running") }, {
  startHidden: true,
  pauseHidden: false,
  resumeHidden: true,
  stopHidden: false,
});
assert.deepEqual({ ...controls.controlVisibility("paused") }, {
  startHidden: true,
  pauseHidden: true,
  resumeHidden: false,
  stopHidden: false,
});
assert.deepEqual({ ...controls.controlVisibility("stopped") }, {
  startHidden: false,
  pauseHidden: true,
  resumeHidden: true,
  stopHidden: true,
});
assert.equal(controls.shouldProcessQueue({ running: true, paused: true, stopped: false }), false);
assert.equal(
  controls.isStableContentReady({ tabStatus: "loading", contentReady: true, stableChecks: 2 }),
  false,
);
assert.equal(
  controls.isStableContentReady({ tabStatus: "complete", contentReady: false, stableChecks: 2 }),
  false,
);
assert.equal(
  controls.isStableContentReady({ tabStatus: "complete", contentReady: true, stableChecks: 2 }),
  true,
);
assert.equal(
  controls.hasContentReadySignal({ snapshot: { title: "Product Hunt", text: "Product Hunt" }, detection: {} }),
  false,
  "a title-only SPA shell must not count as ready",
);
assert.equal(
  controls.hasContentReadySignal({ snapshot: { text: "Loading…".padEnd(100, " ") }, detection: {} }),
  false,
  "a loading shell must not count as ready",
);
assert.equal(
  controls.hasContentReadySignal({
    snapshot: {
      title: "请稍候…",
      text: "Product Hunt security interstitial content without a completed launch page".padEnd(120, " "),
    },
    detection: { operable: true, formFieldCount: 2 },
  }),
  false,
  "a loading browser title must override provisional body content and controls",
);
assert.equal(
  controls.hasContentReadySignal({
    snapshot: { text: "Loading…".padEnd(100, " ") },
    detection: { operable: true, formFieldCount: 3 },
  }),
  false,
  "loading text must win over provisional interactive controls",
);
assert.equal(
  controls.hasContentReadySignal({ snapshot: { text: "A fully rendered submission page with stable content and a visible launch workflow." }, detection: {} }),
  true,
);
assert.equal(
  controls.hasContentReadySignal({ snapshot: { text: "Short form" }, detection: { operable: true } }),
  true,
  "an operable form can be ready even when its copy is short",
);
assert.equal(
  controls.parkedTaskStatus("needs_manual"),
  "needs_manual",
  "custom launches must stay a manual gate instead of being mislabeled as captcha or login",
);
assert.equal(controls.parkedTaskStatus("needs_login"), "needs_manual");
assert.equal(controls.parkedTaskStatus("needs_captcha"), "captcha");
const markManual = background.match(/function\s+markTaskNeedsManual[\s\S]*?\n}\n\nfunction\s+markTaskBlocked/)?.[0] || "";
assert.match(markManual, /:\s*"needs_manual"/,
  "an unresolved automation failure must default to the manual queue, not be mislabeled as login");
assert.equal(controls.shouldAutoSkipGate(true, "needs_captcha"), true);
assert.equal(
  controls.shouldAutoSkipGate(true, "needs_manual"),
  false,
  "auto-skip-captcha must never skip a custom manual launch",
);
assert.equal(
  controls.stopTabDisposition({
    entry: { taskId: "producthunt::OldPhotoLive", slotActive: true },
    parkedTaskIds: new Set(),
    taskStatus: "running",
    customLaunch: true,
  }),
  "close_automated",
  "stopping an actively automated custom launch must close it like other automated tabs",
);
assert.equal(
  controls.stopTabDisposition({
    entry: { taskId: "directory::OldPhotoLive", slotActive: true },
    parkedTaskIds: new Set(),
    taskStatus: "running",
    customLaunch: false,
  }),
  "close_automated",
);
assert.equal(
  controls.stopTabDisposition({
    entry: { taskId: "producthunt::OldPhotoLive", slotActive: true },
    parkedTaskIds: new Set(),
    taskStatus: "ok",
    customLaunch: true,
  }),
  "close_automated",
  "a successful custom launch waiting for delayed close must not be demoted back to manual",
);

const serial = controls.createSerialExecutor();
const order = [];
const first = serial(async () => {
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  order.push("stopped");
});
const second = serial(async () => {
  order.push("paused");
});
await Promise.all([first, second]);
assert.deepEqual(order, ["stopped", "paused"], "active batch writes must commit in call order");

const longShapeA = { fields: [{ value: `${"x".repeat(13000)}A` }] };
const longShapeB = { fields: [{ value: `${"x".repeat(13000)}B` }] };
assert.notEqual(
  controls.contentFingerprint(longShapeA),
  controls.contentFingerprint(longShapeB),
  "readiness must notice changes beyond the first 12KB of a large form",
);

const stopHandler = sidepanel.match(/\$\("btnStop"\)\?\.addEventListener\([\s\S]*?\n  \}\);/)?.[0] || "";
assert.match(stopHandler, /result\?\.ok/, "the side panel must not claim stopped when persistence fails");

console.log("batch controls tests passed");

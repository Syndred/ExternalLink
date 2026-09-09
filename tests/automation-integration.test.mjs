import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const background = readFileSync("extension/background.js", "utf8");
const content = readFileSync("extension/content.js", "utf8");
const worker = readFileSync("cloud/worker/src/index.mjs", "utf8");
const schema = readFileSync("cloud/worker/schema.sql", "utf8");
const sidepanel = readFileSync("extension/sidepanel.js", "utf8");

const recorder = background.match(/async function recordSubmittedProject[\s\S]*?\n}\n\nasync function addToUrlList/)?.[0] || "";
assert.match(recorder, /validateSuccessProof/, "every permanent success write must use the hard evidence gate");
assert.doesNotMatch(recorder, /judge confirmed submission success|judge success/, "placeholder model prose cannot be permanent evidence");

const completion = background.match(/function completeTaskFromJudge[\s\S]*?\n}\n\nfunction markTaskUnconfirmed/)?.[0] || "";
assert.match(completion, /validateSuccessProof/);
assert.match(completion, /task\.status = "verifying"[\s\S]*recordSubmittedProject[\s\S]*task\.status = "ok"/,
  "the UI may show success only after the ledger write completes");
assert.match(background, /submitted_unconfirmed/, "unverified submissions need a distinct recoverable state");
assert.match(background, /const runId = normalized\.runId/, "queued writes must retain their originating run id");
assert.match(background, /run_waiting_manual/, "parked runs must be durable in the cloud ledger");
assert.match(background, /tryAgentDeterministicSubmit/, "AI fill must hand submission to a deterministic preflight");
assert.match(background, /automationEventOutbox/,
  "cloud events need a persistent replay outbox for MV3 worker suspension");
assert.match(background, /confirmationNonce/,
  "manual success confirmation must be bound to the parked task and current run");
assert.doesNotMatch(content, /__extlink_manual_success_btn/,
  "a target page must not host the trusted success confirmation control");

assert.match(content, /waitForSubmissionEvidence/);
assert.match(content, /beforeEvidence = classifyVisibleEvidence/,
  "pre-existing receipt text must be captured before clicking submit");
assert.match(content, /currentEvidence !== baselineEvidence/,
  "unchanged stale receipt text cannot prove a new submission");
assert.match(content, /findSafeAdvanceButton/,
  "multi-step forms need deterministic next-stage navigation");
assert.match(content, /evidenceSignals/);
assert.match(content, /domHash:\s*hashSnapshot/);
assert.match(content, /contenteditable=\\?"true/);
assert.match(content, /type === "file"[\s\S]*files:/);
assert.match(content, /snapshotWidget/);
assert.match(content, /prepareVisualSnapshot/);
assert.match(content, /AI action plans cannot submit/);
assert.match(content, /try free/);
assert.match(content, /if \(!strongMatches && !explicitPath\) return null/,
  "generic marketing links must not be mistaken for submission routes");

assert.match(background, /captureVisibleTab/);
assert.match(background, /cloud-artifact:\/\//);
assert.match(background, /executeVisualFallback/);
assert.match(background, /runProductHuntLaunchLoop/);
assert.match(background, /type:\s*["']producthunt_stage["']/,
  "Product Hunt must persist a checkpoint for every stage");
assert.match(background, /status === ["']ready_to_create["'][\s\S]*通用截图智能体执行 Create draft/,
  "Product Hunt preparation must hand off to the same general visual agent used on other sites");
assert.match(background, /function handOffToVisualAgent[\s\S]*type:\s*["']visual_escalation["']/,
  "the batch must write a durable escalation event before visual supervision starts");
assert.match(background, /extra\.escalationReason[\s\S]*Previous action produced no visible page change/,
  "the visual supervisor must receive the deterministic failure that caused its handoff");
assert.match(background, /async function runRuleBasedFill[\s\S]*allowAgent:\s*false/,
  "ordinary batch forms must start with the original deterministic filler");
assert.match(background, /DETERMINISTIC_ENTRY_WAIT_RETRIES[\s\S]*result\.waiting[\s\S]*页面暂未暴露表单或入口[\s\S]*await sleep\(800\)/,
  "an incompletely rendered page must get bounded deterministic waits before visual escalation");
assert.match(background, /async function runAgentLoop[\s\S]*if \(!extra\.visualEscalation\)[\s\S]*runRuleBasedFill/,
  "the visual loop must reject accidental all-sites invocation without an explicit escalation");
assert.doesNotMatch(background, /Product Hunt 多步骤发布需人工完成/,
  "Product Hunt must not be hard-coded to manual before automation runs");
assert.match(background, /createVisualActionPlan\(tabId, task, snapshot/,
  "every agent turn must start from a fresh annotated screenshot");
assert.match(background, /entry\.agentHistory\.push/,
  "the visual agent must retain bounded cross-step action history");
assert.match(background, /submissionEvidenceBaseline/,
  "model-driven submission evidence must be compared with its pre-click baseline");
assert.match(worker, /deepseek-v4-flash-vision-exp/);
assert.match(worker, /allowedTypes = new Set\(\["fill", "select", "check", "click", "scroll", "wait"\]\)/,
  "the visual agent must be able to navigate unfamiliar multi-step sites");
assert.match(worker, /final ordinary free directory\/listing submission control/,
  "ordinary submissions should be standing-authorized in the visual-agent prompt");
assert.match(worker, /fill-only supervision pass/,
  "manual visual filling must not silently click a final submission control");
assert.match(content, /classifyModelClickGate/,
  "model clicks still need runtime gates for captcha, login, payment, legal, and destructive actions");
assert.match(worker, /MEDIA_BUCKET\.head\(objectKey\)/,
  "referenced audit screenshots must be immutable");
assert.match(worker, /status in \('finished', 'stopped', 'failed'\)/,
  "late events must not downgrade terminal automation runs");
assert.doesNotMatch(
  worker.match(/async function handlePlan[\s\S]*?\n}\n/)?.[0] || "",
  /"submit"/,
  "text AI plans must not receive submission authority",
);

for (const table of ["externallink_automation_runs", "externallink_automation_attempts", "externallink_automation_steps"]) {
  assert.match(schema, new RegExp(`create table if not exists ${table}`));
}
assert.match(sidepanel, /btnExportAutomationRun/);

console.log("automation integration tests passed");

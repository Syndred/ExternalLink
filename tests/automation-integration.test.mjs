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
assert.match(background, /snapshot\.domHash === previousSnapshotHash/,
  "silent custom-widget failures must trigger visual fallback");
assert.match(worker, /deepseek-v4-flash-vision-exp/);
assert.match(worker, /allowedTypes = new Set\(\["fill", "select", "check", "wait"\]\)/);
assert.doesNotMatch(worker, /allowedTypes = new Set\([^\n]*"click"/,
  "models must not receive generic click authority");
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

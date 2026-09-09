import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { self: {}, URL, structuredClone };
vm.createContext(context);
vm.runInContext(readFileSync("extension/lib/automation-ledger.js", "utf8"), context);
const A = context.self.ExtLinkAutomationLedger;

const empty = A.normalizeLedger();
const started = A.startRun(empty, {
  runId: "run-1",
  selectedProfileIds: ["RainbowPetAI"],
  taskTotal: 2,
  destinationTotal: 2,
  startedAt: "2026-09-09T10:00:00.000Z",
});
assert.equal(started.order[0], "run-1");
assert.equal(started.runs["run-1"].status, "running");

const withEvent = A.appendEvent(started, "run-1", {
  taskId: "sideprojectors.com::RainbowPetAI",
  type: "snapshot",
  at: "2026-09-09T10:00:01.000Z",
  before: { url: "https://sideprojectors.com/submit", domHash: "abc" },
});
assert.equal(withEvent.runs["run-1"].events.length, 1);
assert.equal(started.runs["run-1"].events.length, 0, "ledger operations must be immutable");

const waiting = A.finishRun(withEvent, "run-1", "waiting_manual", "2026-09-09T10:00:02.000Z");
assert.equal(waiting.runs["run-1"].status, "waiting_manual");
assert.equal(waiting.runs["run-1"].finishedAt, undefined, "human waiting is recoverable, not terminal");

const noProof = A.validateSuccessProof({
  confirmedBy: "agent",
  evidence: "judge says it probably worked",
});
assert.equal(noProof.ok, false, "model prose alone is not success evidence");

const deterministic = A.validateSuccessProof({
  confirmedBy: "agent",
  source: "deterministic_submit",
  actionObserved: true,
  evidence: "Submitted for Review",
  evidenceSignals: [{
    type: "visible_confirmation",
    text: "Submitted for Review",
    url: "https://sideprojectors.com/thanks",
    matched: true,
  }],
});
assert.equal(deterministic.ok, true);
assert.equal(deterministic.evidence, "Submitted for Review");

const missingAction = A.validateSuccessProof({
  confirmedBy: "agent",
  source: "judge",
  actionObserved: false,
  evidence: "Submitted for Review",
  evidenceSignals: [{ type: "visible_confirmation", text: "Submitted for Review", matched: true }],
});
assert.equal(missingAction.ok, false, "an initial page must not become success from matching text alone");

const published = A.validateSuccessProof({
  confirmedBy: "agent",
  source: "judge",
  publicationStatus: "published",
  publicUrl: "https://producthunt.com/products/rainbowpetai",
  destinationUrl: "https://producthunt.com/posts/new",
  evidence: "Launched in 2026",
  evidenceSignals: [{ type: "public_listing", text: "Launched in 2026", url: "https://producthunt.com/products/rainbowpetai", matched: true }],
});
assert.equal(published.ok, true, "a distinct public listing with visible evidence is authoritative");

const manual = A.validateSuccessProof({
  confirmedBy: "manual",
  evidence: "用户在结果页点击确认成功",
});
assert.equal(manual.ok, true);

const capped = Array.from({ length: 240 }, (_, index) => ({
  runId: `old-${index}`,
  startedAt: new Date(2026, 0, 1, 0, index).toISOString(),
})).reduce((ledger, run) => A.startRun(ledger, run), A.normalizeLedger());
assert.ok(capped.order.length <= A.MAX_RUNS, "the cloud document must remain bounded");

console.log("automation ledger tests passed");

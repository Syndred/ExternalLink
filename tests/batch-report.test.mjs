import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { self: {} };
vm.runInNewContext(readFileSync(new URL("../extension/lib/batch-report.js", import.meta.url), "utf8"), context);
const { build, markdown } = context.self.ExtLinkBatchReport;
const batch = { runId: "test", status: "waiting_manual", config: { unattended: true, secret: "never-export" },
  destinations: [[1, "example.test", "https://example.test/submit", "example.test"]],
  tasks: [
    [1, 1, "p", "Project", "ok", 1, 1, "", "Submission received", "under_review", "", "https://example.test/receipt"],
    [2, 1, "p2", "Project 2", "submitted_unconfirmed", 1, 1, "Receipt missing"],
    [3, 1, "p3", "Project 3", "captcha"],
    [4, 1, "p4", "Project 4", "pending"],
    [5, 1, "p5", "Project 5", "err"],
  ] };
const report = build(batch);
assert.deepEqual({ ...report.summary }, { success: 1, manual: 2, failed: 1, skipped: 0, remaining: 1 });
assert.equal(report.groups.success[0].publicationStatus, "under_review");
assert.equal(report.groups.manual[0].status, "submitted_unconfirmed");
assert.equal(report.groups.remaining[0].url, "https://example.test/submit");
assert.doesNotMatch(JSON.stringify(report), /never-export/);
assert.match(markdown(report), /https:\/\/example.test\/receipt/);
assert.match(markdown(report), /取得回执（1）/);
assert.throws(() => build(null), /没有批次/);
const capacityReport = build({ ...batch, status: "running", unattendedState: {
  waitReason: "manual_capacity", manualTabCount: 2, maxManualTabs: 2,
} });
assert.equal(capacityReport.status, "running");
assert.equal(capacityReport.groups.remaining.length, 1, "capacity waiting must preserve queued work in the report");
assert.match(markdown(capacityReport), /等待人工处理：已保留 2\/2 个页面/);
assert.doesNotMatch(markdown(capacityReport), /暂停原因/);
const resumedReport = build({ ...batch, unattendedState: { waitReason: "", manualTabCount: 1, maxManualTabs: 2 } });
assert.doesNotMatch(markdown(resumedReport), /等待人工处理/);
console.log("batch report tests passed");

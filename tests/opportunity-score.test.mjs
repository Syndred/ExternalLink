import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { readFileSync as read } from "node:fs";

const sandbox = { self: {} };
runInNewContext(read("extension/lib/opportunity-score.js", "utf8"), sandbox);
const S = sandbox.self.ExtLinkOpportunityScore;

assert.equal(S.booleanValue("dofollow"), true);
assert.equal(S.booleanValue("nofollow"), false);
assert.equal(S.numberValue("12,345 visits"), 12345);

const strong = S.scoreOpportunity({
  metrics: { DR: 72, traffic: 50000, spamScore: 3, dofollow: true, indexable: true },
  status: "can_submit",
});
const weak = S.scoreOpportunity({
  metrics: { DR: 5, traffic: 0, spamScore: 80, dofollow: false, indexable: false },
  status: "broken",
});
assert.ok(strong.score >= 75, `expected strong score, got ${strong.score}`);
assert.ok(weak.score < 35, `expected weak score, got ${weak.score}`);
assert.ok(strong.score > weak.score);

console.log("opportunity score tests passed");

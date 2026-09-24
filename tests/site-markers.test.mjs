import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const context = { self: {}, URL };
runInNewContext(readFileSync("extension/lib/queue.js", "utf8"), context);
runInNewContext(readFileSync("extension/lib/opportunity-score.js", "utf8"), context);
const Q = context.self.ExtLinkQueue;
const S = context.self.ExtLinkOpportunityScore;
const plain = (value) => JSON.parse(JSON.stringify(value));

assert.deepEqual(plain(Q.normalizeAnnotationStatuses({ status: "needs_login" })), ["needs_login"]);
assert.deepEqual(plain(Q.normalizeAnnotationStatuses({ status: "paid", statuses: [] })), []);
assert.deepEqual(plain(Q.normalizeAnnotationStatuses({ statuses: ["needs_login", "needs_login", "can_submit"] })), ["needs_login", "can_submit"]);

const destinationKey = "directory.example";
const base = {
  tableData: { projects: {}, entries: [{ link: "https://directory.example", projects: [] }] },
  pluginUrls: [],
  siteProfiles: { A: { id: "A", name: "A", fields: { Name: "A", Url: "https://a.example" } } },
  selectedProfileIds: ["A"],
  submissionRecords: {},
  buildAgentConfigFromProfile: (profile) => ({ projectKey: profile.id }),
  findMatchingProfile: (id, profiles) => profiles[id] || null,
};
const groupsFor = (annotation) => Q.buildDestinationGroups({ ...base, annotations: { [destinationKey]: annotation } });
assert.equal(groupsFor({ statuses: ["can_submit", "needs_login", "needs_captcha"] }).length, 1);
for (const status of ["paid", "broken", "skip", "deleted"]) {
  for (const statuses of [["can_submit", status], [status, "can_submit"]]) {
    const annotation = { status: "can_submit", statuses };
    assert.equal(Q.primaryAnnotationStatus(annotation), status);
    assert.equal(groupsFor(annotation).length, 0, `${status} must block new batch tasks regardless of order`);
    assert.equal(Q.filterSubmissionTasks([{ key: destinationKey, domain: destinationKey }], {
      annotations: { [destinationKey]: annotation },
      excludeStatuses: [...Q.DEAD_END_STATUSES],
    }).length, 0);
    assert.ok(S.scoreOpportunity({ annotation }).score < S.scoreOpportunity({ status: "can_submit" }).score,
      `${status} must lower priority even with a stale legacy status`);
  }
}
assert.equal(groupsFor({ status: "paid", statuses: [] }).length, 1, "cleared markers must restore queue eligibility");

const verifiedRecord = (destinationKey, profileId, evidence = "Submission received") => ({
  status: "success",
  destinationKey,
  destinationUrl: `https://${destinationKey}`,
  profileId,
  confirmedBy: "agent",
  evidence,
});
const markerRecords = {
  "good.example/submit::JevPlay": verifiedRecord("good.example/submit", "JevPlay"),
  "good.example/submit::OldPhotoLive": verifiedRecord("good.example/submit", "OldPhotoLive"),
  "captcha.example/submit::JevPlay": verifiedRecord("captcha.example/submit", "JevPlay"),
  "paid.example/submit::JevPlay": verifiedRecord("paid.example/submit", "JevPlay"),
  "legacy.example/submit::JevPlay": verifiedRecord("legacy.example/submit", "JevPlay", "Table.xlsx submitted seed"),
  "wrong.example/submit::JevPlay": { ...verifiedRecord("wrong.example/submit", "Other") },
};
const markerExisting = {
  "captcha.example": { status: "needs_captcha", statuses: ["needs_captcha"], note: "人工验证" },
  "paid.example": { status: "paid", statuses: ["paid"] },
  "good.example": { formKnowledge: { version: 1 } },
};
const markerResult = Q.verifiedSubmissionSiteAnnotationUpdates(
  markerRecords,
  markerExisting,
  (url) => Q.extractDomain(url),
  "2026-09-24T14:00:00.000Z",
);
assert.deepEqual(plain(markerResult.addedKeys), ["good.example"]);
assert.deepEqual(plain(markerResult.annotations["good.example"].statuses), ["can_submit"]);
assert.deepEqual(plain(markerResult.annotations["good.example"].formKnowledge), { version: 1 });
assert.deepEqual(plain(markerResult.annotations["captcha.example"].statuses), ["needs_captcha"]);
assert.deepEqual(plain(markerResult.annotations["paid.example"].statuses), ["paid"]);
assert.equal(markerResult.annotations["legacy.example"], undefined);
assert.equal(markerResult.annotations["wrong.example"], undefined);
assert.deepEqual(plain(Q.verifiedSubmissionSiteAnnotationUpdates(
  markerRecords,
  markerResult.annotations,
  (url) => Q.extractDomain(url),
).addedKeys), [], "reconciling the same verified receipts must not rewrite markers");
console.log("site marker migration, multiselect, queue and priority tests passed");

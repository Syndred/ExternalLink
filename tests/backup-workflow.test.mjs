import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { self: {} };
vm.createContext(context);
vm.runInContext(readFileSync("extension/lib/backup.js", "utf8"), context);
const B = context.self.ExtLinkBackup;

const current = {
  submissionRecords: {
    "d::B": { status: "success", destinationKey: "d", profileId: "B" },
  },
  siteAnnotations: { d: { status: "needs_login" } },
  siteProfiles: { B: { id: "B", name: "B" } },
  urlList: "https://d.example",
};
const exported = JSON.parse(
  JSON.stringify({
    format: B.FORMAT,
    version: 2,
    submissionRecords: {
      "e::C": { status: "success", destinationKey: "e", profileId: "C" },
    },
    siteAnnotations: { e: { status: "can_submit" } },
    siteProfiles: { C: { id: "C", name: "C" } },
    activeSiteId: "C",
    selectedSiteIds: ["B", "C", "missing"],
    urlList: "https://e.example",
  }),
);
const merged = B.mergeBackup(current, exported, 2);

assert.deepEqual(Object.keys(merged.submissionRecords).sort(), ["d::B", "e::C"]);
assert.deepEqual(Object.keys(merged.siteProfiles).sort(), ["B", "C"]);
assert.deepEqual(JSON.parse(JSON.stringify(merged.selectedSiteIds)), ["B", "C"]);
assert.equal(merged.activeSiteId, "C");
assert.equal(merged.submissionSchemaVersion, 2);
assert.equal(
  merged.urlList,
  "https://d.example\nhttps://e.example",
  "backup import should merge external-link rows instead of replacing the local list",
);

const protectedMerge = B.mergeBackup(
  {
    submissionRecords: {
      "d::B": {
        status: "success",
        destinationKey: "d",
        profileId: "B",
        confirmedBy: "agent",
        evidence: "visible confirmation page",
      },
    },
    siteProfiles: {
      B: {
        id: "B",
        name: "Local B",
        logoDataUrl: "data:image/png;base64,local",
        fields: { Name: "Local B", Title: "Local title" },
      },
    },
  },
  {
    ...exported,
    submissionRecords: {
      "d::B": { status: "pending", destinationKey: "d", profileId: "B" },
    },
    siteProfiles: {
      B: { id: "B", name: "", fields: { Name: "", Title: "Sheet title" } },
    },
    selectedSiteIds: ["B"],
    activeSiteId: "B",
  },
  2,
);
assert.equal(protectedMerge.submissionRecords["d::B"].status, "success");
assert.equal(protectedMerge.submissionRecords["d::B"].confirmedBy, "agent");
assert.equal(protectedMerge.siteProfiles.B.name, "Local B");
assert.equal(protectedMerge.siteProfiles.B.logoDataUrl, "data:image/png;base64,local");
assert.equal(protectedMerge.siteProfiles.B.fields.Title, "Sheet title");
assert.throws(
  () =>
    B.mergeBackup(
      current,
      {
        ...exported,
        siteProfiles: { C: { id: "changed", name: "C" } },
      },
      2,
    ),
  /Profile ID/,
);

console.log("backup workflow tests passed");

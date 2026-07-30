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

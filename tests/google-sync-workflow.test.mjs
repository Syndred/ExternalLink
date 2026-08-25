import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { self: {} };
vm.createContext(context);
vm.runInContext(readFileSync("extension/lib/sheet-sync.js", "utf8"), context);
const S = context.self.ExtLinkSheetSync;

const current = {
  siteProfiles: {
    RainbowPetAI: {
      id: "RainbowPetAI",
      name: "Old local name",
      fields: { Name: "Old local name", Url: "https://old.example", LOGO: "old-logo" },
      logoDataUrl: "data:image/png;base64,LOCAL",
      learnedFieldMappings: { title: "#tool-name" },
    },
  },
  submissionRecords: {
    "example.com::RainbowPetAI": {
      status: "success",
      destinationKey: "example.com",
      profileId: "RainbowPetAI",
      confirmedBy: "agent",
      evidence: "Visible Submitted for Review confirmation",
    },
  },
  siteAnnotations: {},
  selectedSiteIds: ["RainbowPetAI"],
  activeSiteId: "RainbowPetAI",
};

const snapshot = {
  format: S.SNAPSHOT_FORMAT,
  spreadsheetId: "sheet-1",
  revision: "rev-1",
  fetchedAt: "2026-08-25T00:00:00Z",
  tableData: {
    projects: {
      RainbowPetAI: {
        Name: "RainbowPetAI",
        Url: "https://rainbowpetai.com",
        LOGO: "https://rainbowpetai.com/logo.png",
      },
      VideoToArticleAI: {
        Name: "VideoToArticleAI",
        Url: "https://videotoarticleai.com",
      },
    },
    entries: [{ link: "https://example.com", projects: ["RainbowPetAI"] }],
  },
  submissionRecords: {
    "example.com::RainbowPetAI": {
      status: "pending",
      destinationKey: "example.com",
      profileId: "RainbowPetAI",
    },
    "new.example::VideoToArticleAI": {
      status: "success",
      destinationKey: "new.example",
      destinationUrl: "https://new.example",
      profileId: "VideoToArticleAI",
      confirmedBy: "manual",
      evidence: "User confirmed submission",
    },
  },
  siteAnnotations: { "paid.example": { status: "paid" } },
};

const preview = S.computePreview(current, snapshot);
assert.equal(preview.profilesAdded, 1);
assert.equal(preview.profilesUpdated, 1);
assert.equal(preview.destinations, 1);
assert.equal(preview.recordsAdded, 1);
assert.equal(preview.recordsProtected, 1);

const merged = S.applySnapshot(current, snapshot, 2);
assert.equal(merged.siteProfiles.RainbowPetAI.name, "RainbowPetAI");
assert.equal(merged.siteProfiles.RainbowPetAI.url, "https://rainbowpetai.com");
assert.equal(merged.siteProfiles.RainbowPetAI.logoDataUrl, "data:image/png;base64,LOCAL");
assert.deepEqual(
  JSON.parse(JSON.stringify(merged.siteProfiles.RainbowPetAI.learnedFieldMappings)),
  { title: "#tool-name" },
);
assert.equal(
  merged.submissionRecords["example.com::RainbowPetAI"].evidence,
  "Visible Submitted for Review confirmation",
);
assert.equal(merged.submissionRecords["new.example::VideoToArticleAI"].status, "success");
assert.equal(merged.sheetSyncMeta.revision, "rev-1");
assert.deepEqual(
  JSON.parse(JSON.stringify(merged.sheetSyncMeta.managedProfileIds)),
  ["RainbowPetAI", "VideoToArticleAI"],
);

const removalSnapshot = {
  ...snapshot,
  revision: "rev-2",
  tableData: {
    ...snapshot.tableData,
    projects: { RainbowPetAI: snapshot.tableData.projects.RainbowPetAI },
  },
  siteAnnotations: {},
};
const removalPreview = S.computePreview(merged, removalSnapshot);
assert.equal(removalPreview.profilesRemoved, 1);
assert.equal(removalPreview.annotationsRemoved, 1);
const removed = S.applySnapshot(merged, removalSnapshot, 2);
assert.equal(removed.siteProfiles.VideoToArticleAI, undefined);
assert.equal(removed.siteAnnotations["paid.example"], undefined);

const queued = S.enqueueRecord({}, merged.submissionRecords["new.example::VideoToArticleAI"]);
assert.deepEqual(Object.keys(queued), ["new.example::VideoToArticleAI"]);
assert.equal(queued["new.example::VideoToArticleAI"].recordKey, "new.example::VideoToArticleAI");
assert.deepEqual(Object.keys(S.removePushed(queued, ["new.example::VideoToArticleAI"])), []);

assert.throws(() => S.validateSnapshot({}), /格式无效/);

console.log("Google Sheet sync workflow tests passed");

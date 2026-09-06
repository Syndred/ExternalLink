import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync("extension/background.js", "utf8");
const settings = readFileSync("extension/settings.js", "utf8");

const context = { self: {}, URL };
vm.createContext(context);
vm.runInContext(readFileSync("extension/lib/cloud-sync.js", "utf8"), context);

const C = context.self.ExtLinkCloudSync;

assert.equal(
  C.normalizeConfig({ endpoint: "https://externallink-api.example.workers.dev/", accessToken: "token" }).endpoint,
  "https://externallink-api.example.workers.dev",
  "worker endpoints are stored once without a trailing slash",
);
assert.equal(
  C.normalizeConfig({ endpoint: "http://127.0.0.1:8790", accessToken: "token" }).configured,
  false,
  "the cloud data source must never fall back to a local Agent",
);
assert.equal(
  C.normalizeConfig({ endpoint: "https://externallink-api.example.workers.dev" }).configured,
  false,
  "a Worker URL without the device credential is not a usable data source",
);

const state = {
  siteProfiles: { RainbowPetAI: { id: "RainbowPetAI", fields: { LOGO: "cloud-media://logo-a" } } },
  selectedSiteIds: ["RainbowPetAI"],
  submissionRecords: { "directory.example::RainbowPetAI": { status: "success" } },
  submissionTimeline: {
    "directory.example::RainbowPetAI": [
      { id: "event-1", destinationKey: "directory.example", profileId: "RainbowPetAI", occurredAt: "2026-09-06T10:00:00Z", note: "已提交" },
    ],
  },
  siteAnnotations: { "directory.example": { status: "needs_followup" } },
  deletedSubmissionKeys: ["removed.example"],
  urlList: "https://directory.example",
  targetFilters: { aiComments: true },
  activeBatchRun: null,
};
const documents = C.stateToDocuments(state);
assert.equal(documents.siteProfiles.RainbowPetAI.id, "RainbowPetAI");
assert.equal(documents.submissionTimeline["directory.example::RainbowPetAI"][0].id, "event-1");
assert.deepEqual(JSON.parse(JSON.stringify(documents.deletedSubmissionKeys)), ["removed.example"]);
assert.equal(Object.hasOwn(documents, "googleSheetId"), false, "Google credentials are never migrated");

const restored = C.documentsToState(documents);
assert.deepEqual(JSON.parse(JSON.stringify(restored.submissionRecords)), state.submissionRecords);
assert.deepEqual(JSON.parse(JSON.stringify(restored.siteAnnotations)), state.siteAnnotations);

const changedTimeline = structuredClone(state.submissionTimeline);
changedTimeline["directory.example::RainbowPetAI"][0].note = "已审核通过";
changedTimeline["directory.example::RainbowPetAI"].push({
  id: "event-2",
  destinationKey: "directory.example",
  profileId: "RainbowPetAI",
  occurredAt: "2026-09-08T10:00:00Z",
  note: "已收录",
});
assert.deepEqual(
  JSON.parse(JSON.stringify(C.diffTimelineEvents(state.submissionTimeline, changedTimeline))),
  [
    { eventId: "event-1", operation: "updated" },
    { eventId: "event-2", operation: "created" },
  ],
  "timeline edits stay auditable when an event is changed rather than appended",
);

assert.equal(C.isCloudMediaRef("cloud-media://logo-a"), true);
assert.equal(C.isCloudMediaRef("/Users/syndred/Desktop/projects/media/RainbowPetAI/logo.png"), false);
assert.equal(C.cloudMediaAssetId("cloud-media://folder/logo-a"), "folder/logo-a");
assert.match(background, /source: "cloud-cache"/, "cloud state takes precedence over the bundled first-run snapshot");
assert.doesNotMatch(background, /selectCachedTableData/, "the live data flow no longer selects a Google Sheet cache");
assert.match(background, /cloudSyncIgnoredValues/, "pulled values must be ignored by value, not by a stale key marker");
assert.match(background, /scheduleCloudSyncRetry/, "temporary cloud save failures must retry");
assert.match(settings, /result\.pulledDocuments \?\? result\.totalDocuments/, "migration success must show the total cloud document count");
assert.match(settings, /result\.resumed \? "迁移续传完成"/, "a resumed migration must not look like an empty migration");
assert.match(settings, /migrateButton\.disabled = migrated/, "completed first migration must disable the one-time button");

console.log("cloud sync workflow tests passed");

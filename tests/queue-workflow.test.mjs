import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

function loadQueueModule() {
  const context = {
    self: {},
    URL,
    console,
  };
  vm.createContext(context);
  vm.runInContext(readFileSync("extension/lib/queue.js", "utf8"), context);
  return context.self.ExtLinkQueue;
}

function profile(id) {
  return {
    id,
    name: id,
    fields: {
      Name: id,
      Url: `https://${id.toLowerCase()}.example`,
    },
  };
}

const Q = loadQueueModule();

{
  const record = Q.buildSuccessRecord({
    destinationUrl: "https://d.example/submit",
    profileId: "C",
    profileName: "Site C",
    confirmedBy: "manual",
    evidence: "user confirmed",
    submittedAt: "2026-07-30T12:00:00.000Z",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(record)), {
    status: "success",
    destinationKey: "d.example/submit",
    destinationUrl: "https://d.example/submit",
    profileId: "C",
    profileName: "Site C",
    submittedAt: "2026-07-30T12:00:00.000Z",
    confirmedBy: "manual",
    evidence: "user confirmed",
    schemaVersion: 2,
  });
}

{
  const destinationD = Q.normalizeUrlKey("https://d.example/submit");
  const records = {
    [Q.submissionRecordKey(destinationD, "B")]: {
      status: "success",
      destinationKey: destinationD,
      profileId: "B",
    },
  };

  const groups = Q.buildDestinationGroups({
    tableData: {
      projects: {},
      entries: [
        { link: "https://d.example/submit", projects: ["B", "C"], submitted: false },
        { link: "https://e.example/submit", projects: [], submitted: false },
      ],
    },
    pluginUrls: [],
    siteProfiles: { B: profile("B"), C: profile("C") },
    selectedProfileIds: ["B", "C"],
    submissionRecords: records,
    annotations: {},
    buildAgentConfigFromProfile: (item) => ({ projectKey: item.id }),
    findMatchingProfile: (id, profiles) => profiles[id] || null,
  });

  assert.deepEqual(
    JSON.parse(
      JSON.stringify(
        groups.map((group) => ({
          destination: group.domain,
          jobs: group.jobs.map((job) => job.profileId),
        })),
      ),
    ),
    [
      { destination: "d.example", jobs: ["C"] },
      { destination: "e.example", jobs: ["B", "C"] },
    ],
    "a destination should contain only selected profiles without a success record",
  );
}

{
  const destinationD = Q.normalizeUrlKey("https://d.example/submit");
  const groups = Q.buildDestinationGroups({
    tableData: {
      projects: {},
      entries: [{ link: "https://d.example/submit", projects: [], submitted: false }],
    },
    pluginUrls: [],
    siteProfiles: { B: profile("B"), C: profile("C") },
    selectedProfileIds: ["B", "C"],
    submissionRecords: {},
    annotations: {
      [destinationD]: { status: "paid", url: "https://d.example/submit" },
    },
    buildAgentConfigFromProfile: (item) => ({ projectKey: item.id }),
    findMatchingProfile: (id, profiles) => profiles[id] || null,
  });

  assert.equal(groups.length, 0, "paid destinations should block every selected profile");
}

{
  const destinationD = Q.normalizeUrlKey("https://d.example/submit");
  const initial = Q.migrateSubmissionRecords({
    records: {},
    annotations: {
      [destinationD]: {
        url: "https://d.example/submit",
        submittedProjects: ["B"],
        updatedAt: "2026-07-30T00:00:00.000Z",
      },
    },
    tableData: {
      entries: [
        {
          link: "https://sourceforge.net/",
          projects: ["OldPhotoLive"],
          submitted: true,
        },
      ],
    },
  });

  assert.equal(initial.migratedCount, 2);
  assert.equal(
    initial.records[Q.submissionRecordKey(destinationD, "B")].status,
    "success",
  );
  assert.equal(
    initial.records[
      Q.submissionRecordKey(Q.normalizeUrlKey("https://sourceforge.net/"), "OldPhotoLive")
    ].status,
    "success",
  );

  const repeated = Q.migrateSubmissionRecords({
    records: initial.records,
    annotations: {},
    tableData: { entries: [] },
  });
  assert.equal(repeated.migratedCount, 0, "migration should be idempotent");
}

{
  const destinationD = Q.normalizeUrlKey("https://d.example/submit");
  const legacyKey = Q.submissionRecordKey(destinationD, "oldphotolive-ai");
  const remapped = Q.remapSubmissionRecords(
    {
      [legacyKey]: {
        status: "success",
        destinationKey: destinationD,
        profileId: "oldphotolive-ai",
        submittedAt: "2026-07-30T00:00:00.000Z",
      },
    },
    { "oldphotolive-ai": "OldPhotoLive" },
  );
  const stableKey = Q.submissionRecordKey(destinationD, "OldPhotoLive");
  assert.equal(remapped[legacyKey], undefined);
  assert.equal(remapped[stableKey].profileId, "OldPhotoLive");
  assert.equal(remapped[stableKey].status, "success");
}

assert.equal(Q.isGateStatus("needs_manual"), true);

console.log("queue workflow tests passed");

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
    publicUrl: "",
    evidenceUrl: "",
    schemaVersion: 2,
    publicationStatus: "submitted",
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
    initial.records[Q.submissionRecordKey(destinationD, "B")].publicationStatus,
    "submitted",
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

// ─── Domain blacklist normalization and matching ───
{
  assert.equal(Q.normalizeBlacklistEntry("HTTPS://WWW.Spam.com/submit?a=1"), "spam.com");
  assert.equal(Q.normalizeBlacklistEntry(".example-network.net"), "example-network.net");
  assert.equal(Q.normalizeBlacklistEntry("host.com:8443"), "host.com");
  assert.equal(Q.normalizeBlacklistEntry(""), "");

  assert.equal(Q.buildBlacklistMatcher([]), null, "an empty list should not build a matcher");
  assert.equal(Q.buildBlacklistMatcher(["  ", ""]), null, "blank entries should not build a matcher");

  const matches = Q.buildBlacklistMatcher(["spam.com", ".ring.net", "*.farm.io"]);
  assert.equal(matches("spam.com"), true);
  assert.equal(matches("https://www.spam.com/submit"), true);
  assert.equal(matches("sub.spam.com"), true, "an exact entry should still cover its subdomains");
  assert.equal(matches("ring.net"), true);
  assert.equal(matches("a.b.ring.net"), true);
  assert.equal(matches("deep.farm.io"), true);
  assert.equal(matches("notspam.com"), false);
  assert.equal(matches("spam.com.evil.org"), false, "suffix matching must respect label boundaries");
  assert.equal(matches(""), false);
}

// ─── Target gating inside filterSubmissionTasks ───
{
  const tasks = [
    { key: "young.example/submit", domain: "young.example" },
    { key: "old.example/submit", domain: "old.example" },
    { key: "unknown.example/submit", domain: "unknown.example" },
    { key: "spam.example/submit", domain: "spam.example" },
  ];
  const domainMetrics = {
    "young.example": { ageMonths: 2 },
    "old.example": { ageMonths: 120 },
  };

  const noGate = Q.filterSubmissionTasks(tasks, { deletedKeys: [], annotations: {} });
  assert.equal(noGate.length, 4, "no filters configured should keep every task");

  const blacklisted = Q.filterSubmissionTasks(tasks, {
    blacklist: ["spam.example"],
    collectExclusions: true,
  });
  assert.deepEqual(
    blacklisted.map((task) => task.domain),
    ["young.example", "old.example", "unknown.example"],
  );
  assert.deepEqual(JSON.parse(JSON.stringify(blacklisted.gateExclusions)), [
    { key: "spam.example/submit", domain: "spam.example", reason: "blacklist" },
  ]);

  const aged = Q.filterSubmissionTasks(tasks, {
    minDomainAgeMonths: 12,
    domainMetrics,
    collectExclusions: true,
  });
  assert.deepEqual(
    aged.map((task) => task.domain),
    ["old.example", "unknown.example", "spam.example"],
    "unknown ages should pass unless explicitly required",
  );
  assert.deepEqual(
    [...aged.gateExclusions].map((item) => item.reason),
    ["domain_too_young"],
  );

  const strict = Q.filterSubmissionTasks(tasks, {
    minDomainAgeMonths: 12,
    requireKnownDomainAge: true,
    domainMetrics,
    collectExclusions: true,
  });
  assert.deepEqual(
    strict.map((task) => task.domain),
    ["old.example"],
  );
  assert.deepEqual(
    [...strict.gateExclusions].map((item) => item.reason).sort(),
    ["domain_age_unknown", "domain_age_unknown", "domain_too_young"],
  );

  const zeroThreshold = Q.filterSubmissionTasks(tasks, {
    minDomainAgeMonths: 0,
    requireKnownDomainAge: true,
    domainMetrics: {},
  });
  assert.equal(
    zeroThreshold.length,
    4,
    "requireKnownDomainAge must be inert while the age threshold is zero",
  );

  const nullAge = Q.filterSubmissionTasks([{ key: "k", domain: "n.example" }], {
    minDomainAgeMonths: 6,
    requireKnownDomainAge: true,
    domainMetrics: { "n.example": { ageMonths: null } },
  });
  assert.equal(nullAge.length, 0, "a cached record without an age counts as unknown");

  const withoutCollect = Q.filterSubmissionTasks(tasks, { blacklist: ["spam.example"] });
  assert.equal(withoutCollect.gateExclusions, undefined);
}

console.log("queue workflow tests passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const context = { self: {}, URL, console };
vm.createContext(context);
vm.runInContext(readFileSync("extension/lib/submission-timeline.js", "utf8"), context);
const T = context.self.ExtLinkSubmissionTimeline;

assert.equal(
  typeof T.deriveLibraryProgress,
  "function",
  "library progress derivation should be available to filters and cards",
);

const awaitingIndex = T.deriveLibraryProgress({
  monitorStatus: "",
  profileStatuses: [
    {
      profileId: "RainbowPetAI",
      success: true,
      publicationStatus: "submitted",
      submittedAt: "2026-09-01T10:00:00Z",
      latestEvent: { type: "submitted", occurredAt: "2026-09-01T10:00:00Z" },
    },
  ],
  events: [
    {
      type: "submitted",
      profileId: "RainbowPetAI",
      occurredAt: "2026-09-01T10:00:00Z",
    },
  ],
});
assert.equal(awaitingIndex.current, "awaiting_index");
assert.equal(awaitingIndex.hasSubmitted, true);
assert.equal(awaitingIndex.hasPublished, false);
assert.equal(awaitingIndex.needsFollowUp, true);
assert.equal(awaitingIndex.submittedAt, "2026-09-01T10:00:00Z");
assert.equal(T.matchesLibraryProgress(awaitingIndex, "submitted"), true);
assert.equal(T.matchesLibraryProgress(awaitingIndex, "awaiting_index"), true);
assert.equal(T.matchesLibraryProgress(awaitingIndex, "published"), false);

const publishedProgress = T.deriveLibraryProgress({
  monitorStatus: "live",
  profileStatuses: [
    {
      profileId: "VideoToArticleAI",
      success: true,
      publicationStatus: "published",
      submittedAt: "2026-08-24T03:00:00Z",
    },
  ],
  events: [],
});
assert.equal(publishedProgress.current, "published");
assert.equal(publishedProgress.needsFollowUp, false);
assert.equal(T.matchesLibraryProgress(publishedProgress, "published"), true);

const explicitFollowUp = T.deriveLibraryProgress({
  profileStatuses: [
    {
      profileId: "RspAi",
      success: false,
      latestEvent: { type: "needs_follow_up", occurredAt: "2026-09-05T08:00:00Z" },
    },
  ],
  events: [
    { type: "needs_follow_up", profileId: "RspAi", occurredAt: "2026-09-05T08:00:00Z" },
  ],
});
assert.equal(explicitFollowUp.current, "needs_follow_up");
assert.equal(T.matchesLibraryProgress(explicitFollowUp, "needs_follow_up"), true);

const legacyActionOnly = T.deriveLibraryProgress({
  time: "2026-08-20T09:30:00Z",
  profileStatuses: [{ profileId: "RainbowPetAI", success: false }],
  events: [
    {
      type: "link_submit",
      status: "legacy_submitted",
      profileId: "RainbowPetAI",
      occurredAt: "2026-08-20T09:30:00Z",
    },
  ],
});
assert.equal(legacyActionOnly.hasActionRecorded, true);
assert.equal(legacyActionOnly.hasSubmitted, false, "legacy Link Submit must not become verified submission");
assert.equal(legacyActionOnly.current, "action_recorded");
assert.equal(legacyActionOnly.historyAt, "2026-08-20T09:30:00Z");
assert.equal(T.matchesLibraryProgress(legacyActionOnly, "submitted"), false);
assert.equal(T.matchesLibraryProgress(legacyActionOnly, "action_recorded"), true);

const mixedProfiles = T.deriveLibraryProgress({
  profileStatuses: [
    {
      profileId: "RainbowPetAI",
      success: true,
      publicationStatus: "published",
      submittedAt: "2026-08-01T08:00:00Z",
    },
    {
      profileId: "VideoToArticleAI",
      success: true,
      publicationStatus: "submitted",
      submittedAt: "2026-09-05T08:00:00Z",
    },
  ],
  events: [],
});
assert.equal(mixedProfiles.hasPublished, true);
assert.equal(mixedProfiles.needsFollowUp, true, "one published profile must not hide another pending profile");
assert.equal(mixedProfiles.current, "awaiting_index");
assert.equal(T.matchesLibraryProgress(mixedProfiles, "published"), true);
assert.equal(T.matchesLibraryProgress(mixedProfiles, "awaiting_index"), true);

const profileLatestOnly = T.deriveLibraryProgress({
  profileStatuses: [
    {
      profileId: "OldPhotoLive",
      success: false,
      latestEvent: { type: "rejected", occurredAt: "2026-09-04T08:00:00Z" },
    },
  ],
  events: [],
});
assert.equal(profileLatestOnly.current, "rejected", "profile latest event must work without duplicated card events");

assert.equal(T.timelineKey("https://www.Example.com/submit/", "RainbowPetAI"), "example.com/submit::RainbowPetAI");
assert.deepEqual(
  JSON.parse(JSON.stringify(T.splitTimelineKey("example.com/submit::RainbowPetAI"))),
  { destinationKey: "example.com/submit", profileId: "RainbowPetAI" },
);

const first = T.normalizeEvent({
  id: "event-1",
  destinationUrl: "https://www.example.com/submit/",
  profileId: "RainbowPetAI",
  occurredAt: "2026-09-01T10:00:00+08:00",
  type: "submitted",
  status: "success",
  note: "明确看到 Submitted for Review",
  evidenceUrl: "https://example.com/evidence",
  publicUrl: "https://example.com/listing",
  source: "agent",
});
const afterFirst = T.append({}, first);
assert.deepEqual(
  JSON.parse(JSON.stringify(afterFirst["example.com/submit::RainbowPetAI"])),
  [JSON.parse(JSON.stringify(first))],
);
assert.deepEqual(T.append(afterFirst, first), afterFirst, "same event id is idempotent");

const duplicateAgentReceipt = T.normalizeEvent({
  ...first,
  id: "event-duplicate",
  occurredAt: "2026-09-01T10:00:20+08:00",
});
assert.equal(
  T.normalizeTimeline({
    "example.com/submit::RainbowPetAI": [first, duplicateAgentReceipt],
  })["example.com/submit::RainbowPetAI"].length,
  1,
  "identical agent receipts created within one automation run must collapse",
);

const second = T.normalizeEvent({
  id: "event-2",
  destinationKey: "example.com/submit",
  profileId: "RainbowPetAI",
  occurredAt: "2026-09-03T10:00:00+08:00",
  type: "reviewed",
  status: "published",
  note: "两天后审核通过",
  publicUrl: "https://example.com/listing/rainbow",
  source: "manual",
});
const timeline = T.append(afterFirst, second);
assert.deepEqual(
  JSON.parse(JSON.stringify(timeline["example.com/submit::RainbowPetAI"].map((event) => event.id))),
  ["event-1", "event-2"],
  "events are presented chronologically",
);
const current = T.deriveCurrent(timeline)["example.com/submit::RainbowPetAI"];
assert.equal(current.currentStatus, "published");
assert.equal(current.status, "success", "a later review must not downgrade the success ledger");
assert.equal(current.ledgerStatus, "success");
assert.equal(current.isSuccessful, true);
assert.equal(current.eventCount, 2);
assert.equal(current.submittedAt, first.occurredAt);
assert.equal(current.publicUrl, second.publicUrl);

const grouped = T.groupByDestination(timeline);
assert.deepEqual(JSON.parse(JSON.stringify(Object.keys(grouped))), ["example.com/submit"]);
assert.equal(grouped["example.com/submit"].profiles.length, 1);
assert.equal(grouped["example.com/submit"].profiles[0].profileId, "RainbowPetAI");
assert.equal(grouped["example.com/submit"].profiles[0].events.length, 2);

const legacyRecords = {
  "directory.example/submit::VideoToArticleAI": {
      status: "success",
      destinationKey: "directory.example/submit",
      destinationUrl: "https://directory.example/submit",
      profileId: "VideoToArticleAI",
      submittedAt: "2026-08-24T03:00:00.000Z",
      confirmedBy: "agent",
      evidence: "Submitted for Review",
      evidenceUrl: "https://directory.example/evidence",
      publicUrl: "https://directory.example/tools/video",
  },
  "pending.example::RainbowPetAI": {
      status: "pending",
      destinationKey: "pending.example",
      profileId: "RainbowPetAI",
      submittedAt: "2026-08-25",
      note: "等待人工复核",
  },
};
const legacy = T.migrateLegacy({
  submissionRecords: legacyRecords,
  linkSubmit: [
    {
      link: "https://directory.example/submit",
      destinationKey: "directory.example/submit",
      projects: ["VideoToArticleAI", "RainbowPetAI"],
      time: "2026-08-25 11:20",
      record: "Link Submit row",
      detail: "review in two days",
      legacySubmitted: true,
    },
    {
      link: "https://notes.example/submit",
      projects: ["VideoToArticleAI"],
      note: "没有时间的历史备注",
    },
    {
      link: "https://orphan.example/submit",
      time: "2026-08-25",
      record: "无法确定项目",
      projects: [],
    },
  ],
});
assert.equal(legacy.migratedCount, 5);
assert.equal(legacy.sourceCounts.submissionRecords, 2);
assert.equal(legacy.sourceCounts.linkSubmit, 3);
const migratedRecord = legacy.timeline["directory.example/submit::VideoToArticleAI"].find(
  (event) => event.legacy?.source === "submissionRecords",
);
assert.equal(migratedRecord.status, "success");
assert.equal(migratedRecord.source, "migration");
assert.equal(migratedRecord.evidenceUrl, "https://directory.example/evidence");
assert.equal(migratedRecord.publicUrl, "https://directory.example/tools/video");
assert.deepEqual(JSON.parse(JSON.stringify(migratedRecord.legacy.record)), {
  status: "success",
  destinationKey: "directory.example/submit",
  destinationUrl: "https://directory.example/submit",
  profileId: "VideoToArticleAI",
  submittedAt: "2026-08-24T03:00:00.000Z",
  confirmedBy: "agent",
  evidence: "Submitted for Review",
  evidenceUrl: "https://directory.example/evidence",
  publicUrl: "https://directory.example/tools/video",
});
const migratedLink = legacy.timeline["directory.example/submit::RainbowPetAI"].find(
  (event) => event.legacy?.source === "Link Submit",
);
assert.equal(migratedLink.note, "Link Submit row | review in two days");
assert.equal(migratedLink.status, "legacy_submitted");
assert.notEqual(migratedLink.status, "success", "legacy site-level Submit must not create pair success");
assert.equal(migratedLink.legacy.record, "Link Submit row");
assert.equal(migratedLink.legacy.detail, "review in two days");
const unknownTime = legacy.timeline["notes.example/submit::VideoToArticleAI"][0];
assert.equal(unknownTime.occurredAt, "unknown", "migration must not pretend an undated note happened now");
assert.equal(legacy.skipped[0].reason, "missing profileId");

const repeated = T.migrateLegacy({
  timeline: legacy.timeline,
  submissionRecords: legacyRecords,
});
assert.equal(
  repeated.timeline["directory.example/submit::VideoToArticleAI"].length,
  legacy.timeline["directory.example/submit::VideoToArticleAI"].length,
  "legacy migration is idempotent for unchanged source rows",
);

const backup = T.validateBackup({
  format: T.TIMELINE_BACKUP_FORMAT,
  version: 1,
  submissionTimeline: timeline,
});
assert.equal(backup.submissionTimeline["example.com/submit::RainbowPetAI"].length, 2);
const mergedBackup = T.mergeBackup(
  { submissionTimeline: afterFirst, unrelated: "keep" },
  { format: T.TIMELINE_BACKUP_FORMAT, submissionTimeline: timeline },
);
assert.equal(mergedBackup.unrelated, "keep");
assert.equal(mergedBackup.submissionTimeline["example.com/submit::RainbowPetAI"].length, 2);
assert.throws(
  () => T.validateBackup({ format: T.TIMELINE_BACKUP_FORMAT, submissionTimeline: { bad: [{}] } }),
  /缺少 id|缺少 occurredAt|缺少 destinationKey|缺少 profileId/,
);

const edited = T.updateEvent(timeline, "event-2", {
  type: "published",
  note: "公开页已确认",
  publicUrl: "https://example.com/listing/rainbow-live",
});
assert.equal(edited.event.note, "公开页已确认");
assert.equal(edited.event.id, "event-2");
assert.equal(
  edited.timeline["example.com/submit::RainbowPetAI"].find((event) => event.id === "event-2").publicUrl,
  "https://example.com/listing/rainbow-live",
);
const removed = T.removeEvent(edited.timeline, "event-2");
assert.equal(removed.event.id, "event-2");
assert.equal(removed.timeline["example.com/submit::RainbowPetAI"].length, 1);
assert.equal(removed.timeline["example.com/submit::RainbowPetAI"][0].id, "event-1");
assert.throws(() => T.removeEvent(removed.timeline, "missing-event"), /找不到这条动态/);

console.log("submission timeline tests passed");

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const Core = await import("../cloud/worker/src/worker-core.mjs");

assert.equal(Core.normalizeWorkspaceId(" ExternalLink_Prod "), "externallink_prod");
assert.equal(Core.normalizeWorkspaceId("../../bad"), "bad");

const documents = Core.normalizeDocuments({
  siteProfiles: { RainbowPetAI: { id: "RainbowPetAI" } },
  submissionTimeline: {
    "directory.example::RainbowPetAI": [
      { id: "event-1", occurredAt: "2026-09-06T10:00:00Z", note: "已提交" },
    ],
  },
});
assert.equal(documents.siteProfiles.RainbowPetAI.id, "RainbowPetAI");
assert.ok(Core.STATE_DOCUMENT_KEYS.includes("deletedSubmissionKeys"), "deleted task filters must sync between devices");
assert.throws(
  () => Core.normalizeDocuments({ googleSheetId: "sensitive-id" }),
  /unsupported state document/i,
  "Google connection data is not part of the cloud migration contract",
);

const timelineAudit = Core.timelineAuditRows(
  documents.submissionTimeline,
  {
    "directory.example::RainbowPetAI": [
      { id: "event-1", occurredAt: "2026-09-06T10:00:00Z", note: "审核通过" },
      { id: "event-2", occurredAt: "2026-09-08T10:00:00Z", note: "已收录" },
    ],
  },
);
assert.deepEqual(
  timelineAudit.map((entry) => ({ eventId: entry.eventId, operation: entry.operation })),
  [
    { eventId: "event-1", operation: "updated" },
    { eventId: "event-2", operation: "created" },
  ],
);
assert.equal(timelineAudit[0].event.note, "审核通过");

assert.equal(
  Core.mediaObjectKey("default", "sha256-abc.png"),
  "workspaces/default/media/sha256-abc.png",
);
assert.throws(() => Core.mediaObjectKey("default", "../secret"), /invalid media asset/i);

assert.equal(await Core.secureEqual("same-access-token", "same-access-token"), true);
assert.equal(await Core.secureEqual("same-access-token", "different-token"), false);
assert.equal(await Core.secureEqual("short", "longer"), false);

const workerSource = await readFile("cloud/worker/src/index.mjs", "utf8");
assert.match(workerSource, /sha256Hex\(bytes\).*!== sha256/s, "media uploads must verify the supplied checksum");
assert.match(workerSource, /where externallink_workspace_documents\.revision = \$\{expectedRevision\}/, "state writes must use an atomic revision predicate");

console.log("cloud worker core tests passed");

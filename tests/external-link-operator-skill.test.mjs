import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditState } from "../skills/external-link-operator/scripts/audit-state.mjs";
import { discoverMedia } from "../skills/external-link-operator/scripts/discover-media.mjs";
import { recordSuccess } from "../skills/external-link-operator/scripts/record-success.mjs";

const audit = await auditState({ profile: "RainbowPetAI" });
assert.equal(audit.ok, true);
assert.equal(audit.ledgerSuccessPairs, 8);
assert.deepEqual(audit.missingInLedger, []);
assert.deepEqual(audit.duplicateTableAliases, []);

const media = await discoverMedia({ profile: "RainbowPetAI" });
assert.match(media.projectRoot, /rainbowPetAi$/);
assert.match(media.logo[0]?.path || "", /public\/logo\.png$/);
assert.match(media.featured[0]?.path || "", /public\/imgs\/generated\/home-hero/);
assert.ok(media.screenshot.length >= 4);

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-link-operator-"));
const handoffPath = path.join(tempDir, "handoff.json");
await fs.writeFile(
  handoffPath,
  `${JSON.stringify({ submissionRecords: {} }, null, 2)}\n`,
);
const first = await recordSuccess({
  profile: "RainbowPetAI",
  destinationUrl: "https://www.sideprojectors.com/",
  evidence: "Project ID 87446; Under Review",
  submittedAt: "2026-08-02",
  confirmedBy: "agent",
  handoffPath,
  write: true,
});
assert.equal(first.changed, true);
assert.equal(first.recordKey, "sideprojectors.com/submit::RainbowPetAI");
const second = await recordSuccess({
  profile: "RainbowPetAI",
  destinationUrl: "https://www.sideprojectors.com/submit",
  evidence: "duplicate evidence",
  submittedAt: "2026-08-02",
  confirmedBy: "agent",
  handoffPath,
  write: true,
});
assert.equal(second.changed, false);

console.log("external-link operator skill tests passed");

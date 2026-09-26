import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditState } from "../skills/external-link-operator/scripts/audit-state.mjs";

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-link-audit-state-"));
const libraryPath = path.join(tempDir, "library.json");
const handoffPath = path.join(tempDir, "handoff.json");

async function writeFixtures(library, submissionRecords) {
  await fs.writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`);
  await fs.writeFile(
    handoffPath,
    `${JSON.stringify({ submissionRecords }, null, 2)}\n`,
  );
}

function assertLocalAuditMetadata(result) {
  assert.equal(result.source, "local_seed_backup");
  assert.equal(result.liveCloudVerified, false);
}

try {
  await writeFixtures({ entries: [] }, {});
  const noProfile = await auditState({
    profile: "JevPlay",
    libraryPath,
    handoffPath,
  });
  assert.equal(noProfile.ok, false);
  assert.equal(noProfile.reason, "no_evidence");
  assert.equal(noProfile.profileRecordCount, 0);
  assert.equal(noProfile.tableSuccessPairs, 0);
  assert.equal(noProfile.ledgerSuccessPairs, 0);
  assertLocalAuditMetadata(noProfile);

  await writeFixtures(
    { entries: [] },
    {
      "credibleaitools.com/submit-tool::JevPlay": {
        profileId: "JevPlay",
        destinationKey: "credibleaitools.com/submit-tool",
        status: "failed",
        evidence: "HTTP 500",
      },
    },
  );
  const failedOnly = await auditState({
    profile: "JevPlay",
    libraryPath,
    handoffPath,
  });
  assert.equal(failedOnly.ok, false);
  assert.equal(failedOnly.reason, "no_evidence");
  assert.equal(failedOnly.profileRecordCount, 1);
  assert.equal(failedOnly.tableSuccessPairs, 0);
  assert.equal(failedOnly.ledgerSuccessPairs, 0);
  assertLocalAuditMetadata(failedOnly);

  await writeFixtures(
    {
      entries: [{
        indexPage: "https://sideprojectors.com/",
        submitted: true,
        projects: ["JevPlay"],
      }],
    },
    {
      "sideprojectors.com/submit::JevPlay": {
        profileId: "JevPlay",
        destinationKey: "sideprojectors.com/submit",
        status: "success",
        evidence: "Project ID 87446; Under Review",
      },
    },
  );
  const completeLocal = await auditState({
    profile: "JevPlay",
    libraryPath,
    handoffPath,
  });
  assert.equal(completeLocal.ok, true);
  assert.equal(completeLocal.reason, null);
  assert.equal(completeLocal.profileRecordCount, 2);
  assert.equal(completeLocal.tableSuccessPairs, 1);
  assert.equal(completeLocal.ledgerSuccessPairs, 1);
  assert.deepEqual(completeLocal.missingInLedger, []);
  assert.deepEqual(completeLocal.duplicateTableAliases, []);
  assertLocalAuditMetadata(completeLocal);

  console.log("operator audit state tests passed");
} finally {
  await fs.rm(tempDir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { auditState } from "../skills/external-link-operator/scripts/audit-state.mjs";
import { discoverMedia } from "../skills/external-link-operator/scripts/discover-media.mjs";
import { recordSuccess } from "../skills/external-link-operator/scripts/record-success.mjs";

const skillText = await fs.readFile(
  path.resolve("skills/external-link-operator/SKILL.md"),
  "utf8",
);
const dataModelText = await fs.readFile(
  path.resolve("skills/external-link-operator/references/data-model.md"),
  "utf8",
);
assert.match(skillText, /connected Neon workspace as the only human-maintained source/);
assert.match(skillText, /persisted to the cloud/);
assert.match(skillText, /legacy imported `Link Submit\.Submit` field as permanent success truth/);
assert.match(dataModelText, /Canonical data center: Neon PostgreSQL/);
assert.match(dataModelText, /chrome\.storage\.local/);
assert.match(dataModelText, /not a per-submission maintenance target/);
assert.match(dataModelText, /legacy imported `Link Submit\.Submit` field.*permanent success/);

const audit = await auditState({ profile: "RainbowPetAI" });
assert.equal(audit.ok, true);
assert.equal(audit.ledgerSuccessPairs, 10);
assert.deepEqual(audit.missingInLedger, []);
assert.deepEqual(audit.duplicateTableAliases, []);

// Use the real profile fields with an isolated checkout fixture. A developer's
// sibling product repository is not a prerequisite for the test suite.
const mediaDir = await fs.mkdtemp(path.join(os.tmpdir(), "external-link-media-"));
try {
  const productRoot = path.join(mediaDir, "rainbowPetAi");
  const library = JSON.parse(await fs.readFile("extension/table-library.json", "utf8"));
  const fields = library.projects.RainbowPetAI;
  for (const url of [fields.LOGO, fields["Featured image"], ...[1,2,3,4].map(index => fields[`Screenshot ${index}`])]) {
    const file = path.join(productRoot, "public", new URL(url).pathname.replace(/^\/+/, ""));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l4sAAAAASUVORK5CYII=", "base64"));
  }
  const rootsPath = path.join(mediaDir, "roots.json");
  await fs.writeFile(rootsPath, JSON.stringify({RainbowPetAI:productRoot}));
  const media = await discoverMedia({ profile: "RainbowPetAI", rootsPath });
  assert.match(media.projectRoot, /rainbowPetAi$/);
  assert.match(media.logo[0]?.path.replaceAll("\\", "/") || "", /public\/logo\.png$/);
  assert.match(media.featured[0]?.path.replaceAll("\\", "/") || "", /public\/imgs\/generated\/home-hero/);
  assert.ok(media.screenshot.length >= 4);
} finally { await fs.rm(mediaDir, {recursive:true,force:true}); }

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

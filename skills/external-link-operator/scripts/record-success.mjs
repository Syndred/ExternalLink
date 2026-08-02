#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  buildAliasLookup,
  canonicalDestinationKey,
  isMain,
  parseArgs,
  readJson,
  repoRoot,
  skillRoot,
} from "./shared.mjs";

export async function recordSuccess({
  profile,
  destinationUrl,
  evidence,
  submittedAt,
  confirmedBy = "agent",
  handoffPath = path.join(repoRoot, "data/submission-handoff-2026-08-02.json"),
  aliasesPath = path.join(skillRoot, "references/destination-aliases.json"),
  write = false,
} = {}) {
  if (!profile || !destinationUrl || !evidence || !submittedAt) {
    throw new Error("profile, destinationUrl, evidence, and submittedAt are required");
  }
  if (!new Set(["agent", "manual"]).has(confirmedBy)) {
    throw new Error("confirmedBy must be agent or manual");
  }

  const [handoff, aliases] = await Promise.all([readJson(handoffPath), readJson(aliasesPath)]);
  const destinationKey = canonicalDestinationKey(
    destinationUrl,
    buildAliasLookup(aliases),
  );
  const recordKey = `${destinationKey}::${profile}`;
  const existing = handoff.submissionRecords?.[recordKey];
  if (existing?.status === "success") {
    return { changed: false, recordKey, record: existing };
  }
  const record = {
    status: "success",
    destinationKey,
    destinationUrl,
    profileId: profile,
    profileName: profile,
    submittedAt,
    confirmedBy,
    evidence,
    schemaVersion: 2,
  };
  handoff.submissionRecords ||= {};
  handoff.submissionRecords[recordKey] = record;
  handoff.exportedAt = new Date().toISOString();
  if (write) await fs.writeFile(handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
  return { changed: true, written: write, recordKey, record };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = await recordSuccess({
    profile: args.profile,
    destinationUrl: args["destination-url"],
    evidence: args.evidence,
    submittedAt: args["submitted-at"],
    confirmedBy: args["confirmed-by"] || "agent",
    handoffPath: args.handoff ? path.resolve(args.handoff) : undefined,
    write: args.write === true,
  });
  console.log(JSON.stringify(result, null, 2));
}

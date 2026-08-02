#!/usr/bin/env node
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

export async function auditState({
  profile = "RainbowPetAI",
  libraryPath = path.join(repoRoot, "extension/table-library.json"),
  handoffPath = path.join(repoRoot, "data/submission-handoff-2026-08-02.json"),
  aliasesPath = path.join(skillRoot, "references/destination-aliases.json"),
} = {}) {
  const [library, handoff, aliases] = await Promise.all([
    readJson(libraryPath),
    readJson(handoffPath),
    readJson(aliasesPath),
  ]);
  const aliasLookup = buildAliasLookup(aliases);
  const tablePairs = [];
  for (const entry of library.entries || []) {
    if (!entry?.submitted || !(entry.projects || []).includes(profile)) continue;
    const sourceKey = String(entry.indexPage || entry.link || "").trim();
    if (!sourceKey) continue;
    tablePairs.push({
      canonicalKey: canonicalDestinationKey(sourceKey, aliasLookup),
      sourceKey,
      note: entry.note || "",
    });
  }

  const grouped = new Map();
  for (const pair of tablePairs) {
    const values = grouped.get(pair.canonicalKey) || [];
    values.push(pair);
    grouped.set(pair.canonicalKey, values);
  }

  const ledgerPairs = new Map();
  for (const record of Object.values(handoff.submissionRecords || {})) {
    if (record?.profileId !== profile || record.status !== "success") continue;
    const sourceKey = record.destinationKey || record.destinationUrl;
    ledgerPairs.set(canonicalDestinationKey(sourceKey, aliasLookup), record);
  }

  const missingInLedger = [...grouped.keys()]
    .filter((key) => !ledgerPairs.has(key))
    .map((key) => ({ canonicalKey: key, sources: grouped.get(key) }));
  const duplicateTableAliases = [...grouped.entries()]
    .filter(([, values]) => values.length > 1)
    .map(([canonicalKey, sources]) => ({ canonicalKey, sources }));
  const ledgerOnly = [...ledgerPairs.keys()].filter((key) => !grouped.has(key));

  return {
    profile,
    tableSuccessPairs: grouped.size,
    ledgerSuccessPairs: ledgerPairs.size,
    missingInLedger,
    duplicateTableAliases,
    ledgerOnly,
    ok: missingInLedger.length === 0 && duplicateTableAliases.length === 0,
  };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  const result = await auditState({
    profile: args.profile || "RainbowPetAI",
    libraryPath: args.library
      ? path.resolve(args.library)
      : path.join(repoRoot, "extension/table-library.json"),
    handoffPath: args.handoff
      ? path.resolve(args.handoff)
      : path.join(repoRoot, "data/submission-handoff-2026-08-02.json"),
  });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const skillRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const repoRoot = path.resolve(skillRoot, "../..");

export function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

export function normalizeUrlKey(value) {
  const raw = String(value || "").trim();
  try {
    const parsed = new URL(raw.startsWith("http") ? raw : `https://${raw}`);
    const host = parsed.hostname.replace(/^www\./, "").toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return `${host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return raw
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/+$/, "");
  }
}

export function buildAliasLookup(aliasGroups) {
  const lookup = new Map();
  for (const [canonical, aliases] of Object.entries(aliasGroups || {})) {
    lookup.set(normalizeUrlKey(canonical), normalizeUrlKey(canonical));
    for (const alias of aliases || []) {
      lookup.set(normalizeUrlKey(alias), normalizeUrlKey(canonical));
    }
  }
  return lookup;
}

export function canonicalDestinationKey(value, aliasLookup) {
  const normalized = normalizeUrlKey(value);
  return aliasLookup.get(normalized) || normalized;
}

export function isMain(importMetaUrl) {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}

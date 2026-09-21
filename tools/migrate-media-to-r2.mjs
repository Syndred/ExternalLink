#!/usr/bin/env node
// One-time, explicit migration of the curated ExternalLink media library into
// the private R2 bucket through the authenticated Worker. It never scans a
// broad Desktop folder and it does not delete the source files.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, extname, basename } from "node:path";

const MEDIA_ROOT = "/Users/syndred/Desktop/projects/media";
const MAX_BYTES = 6 * 1024 * 1024;
const MIME = Object.freeze({
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
});
const PROFILE_FOLDER_ALIASES = Object.freeze({
  FreeLanguage: "AISpeakLearn",
});

function requiredEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function endpoint(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") throw new Error("EXTERNALLINK_CLOUD_URL must use HTTPS");
  return parsed.href.replace(/\/$/, "");
}

function requestUrl(base, pathname, workspace) {
  const url = new URL(`${base}${pathname}`);
  url.searchParams.set("workspace", workspace);
  return url;
}

async function request(base, token, workspace, pathname, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(requestUrl(base, pathname, workspace), { ...init, headers });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

async function mediaPlan() {
  const folders = (await readdir(MEDIA_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));
  const plan = [];
  for (const folder of folders) {
    const files = (await readdir(resolve(MEDIA_ROOT, folder.name), { withFileTypes: true }))
      .filter((entry) => entry.isFile() && MIME[extname(entry.name).toLowerCase()])
      .sort((a, b) => a.name.localeCompare(b.name));
    let screenshotIndex = 0;
    for (const file of files) {
      const path = resolve(MEDIA_ROOT, folder.name, file.name);
      const details = await stat(path);
      if (details.size > MAX_BYTES) throw new Error(`${path} exceeds the 6MB upload limit`);
      const kind = /^logo\./i.test(file.name) ? "logo" : "screenshot";
      const index = kind === "logo" ? 0 : screenshotIndex++;
      const ext = extname(file.name).toLowerCase();
      const assetId = `${folder.name}-${kind}-${index}${ext}`.replace(/[^a-z0-9._-]/gi, "-");
      plan.push({ profileId: folder.name, path, name: basename(path), kind, index, assetId, contentType: MIME[ext] });
    }
  }
  return plan;
}

function applyMediaReferences(profiles, rows) {
  const next = structuredClone(profiles || {});
  for (const row of rows) {
    const profile = next[row.profileId];
    if (!profile) throw new Error(`Cloud state has no Profile named ${row.profileId}; migrate extension data first`);
    const ref = `cloud-media://${row.assetId}`;
    const media = { ...(profile.media || {}) };
    const fields = { ...(profile.fields || {}) };
    if (row.kind === "logo") {
      media.logo = ref;
      fields["Cloud LOGO"] = ref;
    } else {
      const shots = Array.isArray(media.screenshots) ? [...media.screenshots] : [];
      shots[row.index] = ref;
      media.screenshots = shots;
      fields[`Cloud Screenshot ${row.index + 1}`] = ref;
      if (row.index === 0) fields["Cloud Featured image"] = ref;
    }
    next[row.profileId] = { ...profile, media, fields, updatedAt: new Date().toISOString() };
  }
  return next;
}

function resolveProfileIds(rows, profiles) {
  const entries = Object.entries(profiles || {});
  return rows.map((row) => {
    if (profiles?.[row.profileId]) return row;
    const expectedName = PROFILE_FOLDER_ALIASES[row.profileId];
    const matches = entries.filter(([, profile]) => String(profile?.name || "").trim() === expectedName);
    if (matches.length !== 1) {
      throw new Error(`Cloud state has no unique Profile for media folder ${row.profileId}`);
    }
    return { ...row, profileId: matches[0][0] };
  });
}

function applyTableMediaReferences(table, rows) {
  if (!table || typeof table !== "object" || !table.projects || typeof table.projects !== "object") return table;
  const next = structuredClone(table);
  for (const row of rows) {
    const fields = next.projects[row.profileId];
    if (!fields || typeof fields !== "object") continue;
    const ref = `cloud-media://${row.assetId}`;
    if (row.kind === "logo") fields["Cloud LOGO"] = ref;
    else {
      fields[`Cloud Screenshot ${row.index + 1}`] = ref;
      if (row.index === 0) fields["Cloud Featured image"] = ref;
    }
  }
  return next;
}

function safeHeaderFileName(name, fallback) {
  const value = String(name || "").trim();
  return /^[\x20-\x7e]+$/.test(value) ? value : String(fallback || "media");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const base = endpoint(requiredEnv("EXTERNALLINK_CLOUD_URL"));
  const token = requiredEnv("EXTERNALLINK_CLOUD_TOKEN");
  const workspace = String(process.env.EXTERNALLINK_CLOUD_WORKSPACE || "default").trim() || "default";
  let plan = await mediaPlan();
  const logos = plan.filter((row) => row.kind === "logo").length;
  const screenshots = plan.length - logos;
  if (dryRun) {
    console.log(JSON.stringify({ ok: true, mediaRoot: MEDIA_ROOT, files: plan.length, logos, screenshots, profiles: [...new Set(plan.map((row) => row.profileId))] }, null, 2));
    return;
  }

  const snapshot = await request(base, token, workspace, "/v1/snapshot");
  if (!snapshot.documents?.siteProfiles) throw new Error("Cloud state is empty; complete the first data migration before media migration");
  plan = resolveProfileIds(plan, snapshot.documents.siteProfiles);
  for (const row of plan) {
    const bytes = await readFile(row.path);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await request(base, token, workspace, `/v1/media/${encodeURIComponent(row.assetId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": row.contentType,
        "X-Asset-Name": safeHeaderFileName(row.name, row.assetId),
        "X-Asset-Sha256": sha256,
        "X-Profile-Id": row.profileId,
        "X-Media-Kind": row.kind,
        "X-Media-Index": String(row.index),
      },
      body: bytes,
    });
  }
  const siteProfiles = applyMediaReferences(snapshot.documents.siteProfiles, plan);
  await request(base, token, workspace, "/v1/state/siteProfiles", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: siteProfiles, revision: snapshot.revisions?.siteProfiles || 0 }),
  });
  if (snapshot.documents.sheetTableData) {
    const table = applyTableMediaReferences(snapshot.documents.sheetTableData, plan);
    await request(base, token, workspace, "/v1/state/sheetTableData", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: table, revision: snapshot.revisions?.sheetTableData || 0 }),
    });
  }
  console.log(JSON.stringify({ ok: true, files: plan.length, logos, screenshots, profiles: [...new Set(plan.map((row) => row.profileId))] }, null, 2));
}

main().catch((error) => {
  console.error(`media migration failed: ${error.message}`);
  process.exitCode = 1;
});

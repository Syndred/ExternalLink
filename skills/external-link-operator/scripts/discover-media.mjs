#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { isMain, parseArgs, readJson, repoRoot, skillRoot } from "./shared.mjs";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".ico", ".avif"]);
const NEGATIVE = /(?:stripe|paypal|creem|avatar|node_modules|framework|shadcn|tailwind|react|nextjs|vercel|admin|demo|template|archive|design-reference)/i;

async function walkImages(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await walkImages(fullPath)));
    else if (IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) result.push(fullPath);
  }
  return result;
}

function score(filePath, role) {
  const normalized = filePath.toLowerCase();
  let value = NEGATIVE.test(normalized) ? -80 : 0;
  if (role === "logo") {
    if (/\/(?:logo|brand-icon|logo-mark)\.(?:png|jpe?g|webp|svg)$/i.test(normalized)) value += 120;
    if (/(?:logo|brand|mark)/i.test(normalized)) value += 65;
    if (/(?:apple-touch|favicon)/i.test(normalized)) value += 20;
  } else if (role === "featured") {
    if (/(?:og-preview|opengraph|twitter-image|preview|featured)/i.test(normalized)) value += 100;
    if (/(?:home|product|hero|banner)/i.test(normalized)) value += 55;
    if (/(?:favicon|logo|icon)/i.test(normalized)) value -= 30;
  } else {
    if (/(?:screenshot|workspace|result|landing-page|feature|case)/i.test(normalized)) value += 75;
    if (/(?:preview|hero|product)/i.test(normalized)) value += 35;
    if (/(?:favicon|logo|icon)/i.test(normalized)) value -= 40;
  }
  return value;
}

function localPathFromUrl(value, publicRoot) {
  try {
    const parsed = new URL(value);
    return path.join(publicRoot, decodeURIComponent(parsed.pathname).replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

function uniqueRanked(items, role) {
  const seen = new Set();
  return items
    .filter((item) => {
      const key = item.path || item.sourceUrl;
      return key && !seen.has(key) && seen.add(key);
    })
    .map((item) => ({
      ...item,
      score: item.score ?? score(item.path || item.sourceUrl, role),
    }))
    .filter((item) => item.score > -50)
    .sort((a, b) => b.score - a.score)
    .slice(0, role === "screenshot" ? 8 : 5);
}

export async function discoverMedia({
  profile = "RainbowPetAI",
  libraryPath = path.join(repoRoot, "extension/table-library.json"),
  rootsPath = path.join(skillRoot, "references/project-roots.json"),
} = {}) {
  const [library, roots] = await Promise.all([readJson(libraryPath), readJson(rootsPath)]);
  const fields = library.projects?.[profile];
  if (!fields) throw new Error(`Unknown Profile: ${profile}`);
  const relativeRoot = roots[profile];
  if (!relativeRoot) throw new Error(`No project root configured for Profile: ${profile}`);
  const projectRoot = path.resolve(repoRoot, relativeRoot);
  const publicRoot = path.join(projectRoot, "public");
  const files = await walkImages(publicRoot);

  const explicit = {
    logo: [fields.LOGO],
    featured: [fields["Featured image"]],
    screenshot: [1, 2, 3, 4].flatMap((index) => [
      fields[`Screenshot ${index}`],
      fields[`Screenshot-${index}`],
    ]),
  };
  const result = {};
  for (const role of ["logo", "featured", "screenshot"]) {
    const explicitItems = await Promise.all(
      explicit[role].filter(Boolean).map(async (url, index) => {
        const candidatePath = localPathFromUrl(url, publicRoot);
        let localPath = "";
        try {
          if (candidatePath && (await fs.stat(candidatePath)).isFile()) localPath = candidatePath;
        } catch {
          /* retain the deployed URL when there is no matching public file */
        }
        return {
          path: localPath,
          sourceUrl: url,
          source: localPath ? "profile-field" : "profile-field-remote",
          score: 300 - index,
        };
      }),
    );
    const scannedItems = files.map((filePath) => ({ path: filePath, source: "public-scan" }));
    result[role] = uniqueRanked([...explicitItems, ...scannedItems], role);
  }

  return { profile, projectRoot, publicRoot, ...result };
}

if (isMain(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    JSON.stringify(
      await discoverMedia({
        profile: args.profile || "RainbowPetAI",
        libraryPath: args.library ? path.resolve(args.library) : undefined,
      }),
      null,
      2,
    ),
  );
}

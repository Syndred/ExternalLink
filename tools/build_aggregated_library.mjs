import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const [sourceDirArg, outputDirArg, existingCsvArg] = process.argv.slice(2);
if (!sourceDirArg || !outputDirArg) {
  throw new Error("用法: node tools/build_aggregated_library.mjs <source-dir> <output-dir>");
}

const sourceDir = resolve(sourceDirArg);
const outputDir = resolve(outputDirArg);
const candidates = new Map();

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) rows.push([...row, field.replace(/\r$/, "")]);
  return rows;
}

function normalizeUrl(raw) {
  let value = String(raw || "").trim();
  if (!value || /^(mailto:|javascript:|#)/i.test(value)) return "";
  if (!/^https?:\/\//i.test(value) && /^[\w.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) {
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return "";
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    for (const key of [...url.searchParams.keys()]) {
      if (/^(ref|utm_|source|sa|ust|usg)/i.test(key)) url.searchParams.delete(key);
    }
    url.hash = "";
    if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch {
    return "";
  }
}

function canonicalKey(url) {
  const parsed = new URL(url);
  return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`;
}

function platformType(category, details, url) {
  const value = `${category} ${details}`.toLowerCase();
  if (/forum|communit|social|bookmark/.test(value)) return "community";
  if (/profile|local|review/.test(value)) return "profile";
  if (/article|press|infographic|file upload/.test(value)) return "article";
  if (/comment/.test(value)) return "wp_comment";
  if (/submit|launch|directory|software|startup|product/.test(`${value} ${url}`)) return "directory";
  return "profile";
}

function add(rawUrl, metadata) {
  const url = normalizeUrl(rawUrl);
  if (!url) return;
  const key = canonicalKey(url);
  const current = candidates.get(key) || {
    key,
    url,
    platformType: metadata.platformType || "directory",
    categories: [],
    sources: [],
    linkTypes: [],
    instantApproval: false,
    freeClaimed: false,
    notes: [],
  };
  current.categories.push(metadata.category || "");
  current.sources.push(metadata.source || "");
  current.linkTypes.push(metadata.linkType || "");
  current.instantApproval ||= /^y$/i.test(String(metadata.instantApproval || "").trim());
  current.freeClaimed ||= metadata.freeClaimed === true;
  if (metadata.note) current.notes.push(metadata.note);
  if (current.platformType === "profile" && metadata.platformType) {
    current.platformType = metadata.platformType;
  }
  current.categories = [...new Set(current.categories.filter(Boolean))];
  current.sources = [...new Set(current.sources.filter(Boolean))];
  current.linkTypes = [...new Set(current.linkTypes.filter(Boolean))];
  current.notes = [...new Set(current.notes.filter(Boolean))];
  candidates.set(key, current);
}

const daluo = JSON.parse(readFileSync(resolve(sourceDir, "daluoseo-all-sheets.json"), "utf8"));
for (const row of daluo.rows || []) {
  const [rawUrl, category = "", details = "", linkType = "", instantApproval = ""] = row.cells || [];
  if (/^(url|daluoseo)$/i.test(String(rawUrl || "").trim())) continue;
  add(rawUrl, {
    source: `大罗SEO/${row.sheet}`,
    category: details || row.sheet,
    linkType,
    instantApproval,
    freeClaimed: true,
    platformType: platformType(category, details || row.sheet, rawUrl),
    note: category,
  });
}

for (const [file, sourceName] of [
  ["webcafe-candidates.json", "Web.Cafe 海外产品发布渠道"],
  ["notion-free-candidates.json", "Notion 100+ DIR/FREE"],
]) {
  const path = resolve(sourceDir, file);
  if (!existsSync(path)) continue;
  const data = JSON.parse(readFileSync(path, "utf8"));
  for (const link of data.links || []) {
    const url = normalizeUrl(link.href);
    if (!url || new URL(url).hostname.endsWith("web.cafe") || new URL(url).hostname.endsWith("notion.site")) continue;
    add(url, {
      source: sourceName,
      category: "Product Launch",
      freeClaimed: true,
      platformType: platformType("Product Launch", link.parent || link.text, url),
      note: link.text || "",
    });
  }
}

const githubPath = resolve(sourceDir, "github-candidates.json");
if (existsSync(githubPath)) {
  const github = JSON.parse(readFileSync(githubPath, "utf8"));
  for (const item of github.candidates || github.items || []) {
    if (item.eligibleForSubmission === false || item.paidLikely === true) continue;
    if (item.freeLikely !== true) continue;
    add(item.url || item.href, {
      source: `GitHub/${(item.sourceFiles || [item.sourceFile || item.file || "Startup-Launch-Directory"]).join("+")}`,
      category: item.category || item.linkRole || "Directory",
      freeClaimed: item.freeLikely === true || /free|免费/i.test(`${item.price || ""} ${item.note || ""}`),
      platformType: platformType(item.category || item.linkRole || "Directory", item.note || "", item.url || item.href),
      note: [item.name, item.price, ...(item.freeEvidence || []), item.note].filter(Boolean).join("；"),
    });
  }
}

const items = [...candidates.values()].sort((a, b) => a.key.localeCompare(b.key));
const existingKeys = new Set();
if (existingCsvArg) {
  const existingRows = parseCsv(readFileSync(resolve(existingCsvArg), "utf8"));
  const headers = existingRows.shift() || [];
  const linkIndex = headers.indexOf("Link");
  if (linkIndex < 0) throw new Error("现有 CSV 缺少 Link 列");
  for (const row of existingRows) {
    const url = normalizeUrl(row[linkIndex]);
    if (url) existingKeys.add(canonicalKey(url));
  }
}
const missingItems = items.filter((item) => !existingKeys.has(item.key));
const annotations = {};
for (const item of missingItems) {
  if (item.platformType !== "community") continue;
  annotations[item.key] = {
    status: "needs_manual",
    note: "社区/论坛候选，仅供人工评估，不进入普通目录自动提交",
    source: "aggregate-import",
  };
}

const backup = {
  format: "externallink-submission-backup",
  version: 2,
  exportedAt: new Date().toISOString(),
  submissionRecords: {},
  siteAnnotations: annotations,
  siteProfiles: {},
  activeSiteId: "",
  selectedSiteIds: [],
  urlList: missingItems.map((item) => `${item.url}|${item.platformType}`).join("\n"),
};

const sheetRows = missingItems.map((item) => [
  item.url,
  "VideoToArticleAI",
  "FALSE",
  "",
  [
    item.freeClaimed ? "聚合源标记免费" : "免费状态待复核",
    `来源：${item.sources.join(" / ")}`,
    item.categories.length ? `类型：${item.categories.join(" / ")}` : "",
    item.linkTypes.length ? `链接：${item.linkTypes.join(" / ")}` : "",
    item.instantApproval ? "聚合源标记可即时通过" : "",
    "导入日期 2026-08-25；执行前复核当前规则",
  ].filter(Boolean).join("；"),
  "",
].join("\t"));

mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, "all-aggregated-candidates.json"), `${JSON.stringify({ items }, null, 2)}\n`);
writeFileSync(resolve(outputDir, "全量外链候选导入.json"), `${JSON.stringify(backup, null, 2)}\n`);
writeFileSync(resolve(outputDir, "google-sheet-rows.tsv"), `${sheetRows.join("\n")}\n`);
const byPlatformType = items.reduce((counts, item) => {
  counts[item.platformType] = (counts[item.platformType] || 0) + 1;
  return counts;
}, {});
writeFileSync(resolve(outputDir, "统计.json"), `${JSON.stringify({
  rawRows: (daluo.rows || []).length,
  uniqueCandidates: items.length,
  existingCandidates: existingKeys.size,
  missingCandidates: missingItems.length,
  freeClaimed: items.filter((item) => item.freeClaimed).length,
  instantApproval: items.filter((item) => item.instantApproval).length,
  manualCommunity: Object.keys(annotations).length,
  byPlatformType,
}, null, 2)}\n`);

console.log(JSON.stringify({
  uniqueCandidates: items.length,
  existingCandidates: existingKeys.size,
  missingCandidates: missingItems.length,
  freeClaimed: items.filter((item) => item.freeClaimed).length,
  instantApproval: items.filter((item) => item.instantApproval).length,
  manualCommunity: Object.keys(annotations).length,
}, null, 2));

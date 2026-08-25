import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

const [inputArg, outputArg] = process.argv.slice(2);
if (!inputArg || !outputArg) {
  throw new Error("用法: node tools/build_url_import_from_csv.mjs <Link Submit.csv> <output.json>");
}

const rows = parseCsv(readFileSync(resolve(inputArg), "utf8"));
const headers = rows.shift() || [];
const linkIndex = headers.indexOf("Link");
const noteIndex = headers.indexOf("Note");
if (linkIndex < 0 || noteIndex < 0) throw new Error("CSV 缺少 Link 或 Note 列");

const urls = rows
  .filter((row) => String(row[noteIndex] || "").includes("Notion 100+ DIR / FREE"))
  .map((row) => String(row[linkIndex] || "").trim())
  .filter((url) => /^https:\/\//.test(url));

const output = {
  format: "externallink-submission-backup",
  version: 2,
  exportedAt: new Date().toISOString(),
  submissionRecords: {},
  siteAnnotations: {},
  siteProfiles: {},
  activeSiteId: "",
  selectedSiteIds: [],
  urlList: [...new Set(urls)].map((url) => `${url}|directory`).join("\n"),
};

const outputPath = resolve(outputArg);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`已生成 ${new Set(urls).size} 条外链候选：${outputPath}`);

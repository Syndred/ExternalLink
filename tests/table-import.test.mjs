import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const tempDir = mkdtempSync(join(tmpdir(), "externallink-table-import-"));
const outputPath = join(tempDir, "table-library.json");
const imported = spawnSync(
  "python3",
  ["tools/import_table_xlsx.py", "--input", "Table.xlsx", "--output", outputPath],
  { encoding: "utf8" },
);
assert.equal(imported.status, 0, imported.stderr || imported.stdout);
const table = JSON.parse(readFileSync(outputPath, "utf8"));
assert.deepEqual(Object.keys(table.projects), [
  "OldPhotoLive",
  "RainbowPetAI",
  "RspAi",
  "TextComparison",
  "GraffitiName",
  "VideoToArticleAI",
]);
const g2 = table.entries.find((entry) => entry.link === "https://www.g2.com/");
assert.deepEqual(g2?.projects, ["OldPhotoLive", "TextComparison", "GraffitiName"]);
assert.equal(g2?.indexPage, "", "free-form notes must not be treated as navigation URLs");

const g2Tasks = table.tasks.filter((task) => task.url === "https://www.g2.com/");
assert.deepEqual(
  g2Tasks.map((task) => task.projectKey),
  ["OldPhotoLive", "TextComparison", "GraffitiName"],
  "Excel import must expand every listed project instead of choosing projects[0]",
);

const submitted = table.entries.filter((entry) => entry.submitted);
assert.equal(submitted.length, 7);
assert.deepEqual(
  submitted.map((entry) => entry.indexPage || entry.link),
  [
    "https://www.sideprojectors.com/submit",
    "https://thejoai.com/aitools/submissions/",
    "https://moge.ai/zh",
    "https://neeed.directory/submit",
    "https://sourceforge.net/",
    "https://pitchwall.co/",
    "https://github.com/Syndred/pet-memorial-resources",
  ],
);

const sideProjectors = table.entries.find(
  (entry) => entry.link === "https://www.sideprojectors.com/submit",
);
assert.deepEqual(sideProjectors?.projects, ["OldPhotoLive", "RspAi", "RainbowPetAI"]);
assert.equal(
  table.entries.some((entry) => entry.link === "https://www.sideprojectors.com/"),
  false,
  "canonical submit entry must replace the duplicate root alias",
);

for (const projectId of ["OldPhotoLive", "RainbowPetAI", "RspAi"]) {
  const fields = table.projects[projectId];
  assert.match(fields.LOGO, /^https:\/\//);
  for (let index = 1; index <= 4; index += 1) {
    assert.match(fields[`Screenshot ${index}`], /^https:\/\//);
  }
}

assert.equal(
  table.projects.VideoToArticleAI?.Url,
  "https://videotoarticleai.com",
  "re-running the legacy XLSX importer must preserve the transitional VideoToArticleAI profile",
);

console.log("Table import tests passed");
rmSync(tempDir, { recursive: true, force: true });

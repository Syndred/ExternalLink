import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const table = JSON.parse(readFileSync("extension/table-library.json", "utf8"));
assert.deepEqual(Object.keys(table.projects), [
  "OldPhotoLive",
  "RainbowPetAI",
  "RspAi",
  "TextComparison",
  "GraffitiName",
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
assert.equal(submitted.length, 5);
assert.deepEqual(
  submitted.map((entry) => entry.indexPage || entry.link),
  [
    "https://www.sideprojectors.com/submit",
    "https://thejoai.com/aitools/submissions/",
    "https://moge.ai/zh",
    "https://neeed.directory/submit",
    "https://sourceforge.net/",
  ],
);

for (const projectId of ["OldPhotoLive", "RainbowPetAI", "RspAi"]) {
  const fields = table.projects[projectId];
  assert.match(fields.LOGO, /^https:\/\//);
  for (let index = 1; index <= 4; index += 1) {
    assert.match(fields[`Screenshot ${index}`], /^https:\/\//);
  }
}

console.log("Table import tests passed");

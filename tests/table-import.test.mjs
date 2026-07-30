import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const table = JSON.parse(readFileSync("extension/table-library.json", "utf8"));
const g2 = table.entries.find((entry) => entry.link === "https://www.g2.com/");
assert.deepEqual(g2?.projects, ["OldPhotoLive", "TextComparison", "GraffitiName"]);

const g2Tasks = table.tasks.filter((task) => task.url === "https://www.g2.com/");
assert.deepEqual(
  g2Tasks.map((task) => task.projectKey),
  ["OldPhotoLive", "TextComparison", "GraffitiName"],
  "Excel import must expand every listed project instead of choosing projects[0]",
);

const submitted = table.entries.filter((entry) => entry.submitted);
assert.equal(submitted.length, 1);
assert.equal(submitted[0].indexPage || submitted[0].link, "https://sourceforge.net/");
assert.deepEqual(submitted[0].projects, ["OldPhotoLive"]);

console.log("Table import tests passed");

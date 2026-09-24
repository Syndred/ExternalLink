import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("extension/content.js", "utf8");
const start = source.indexOf("  function pickDescriptionForField(");
const end = source.indexOf("  function findCharCounter(", start);
assert.ok(start > 0 && end > start);
const pick = new Function(
  "getFieldConstraints", "getFieldHint", "getProfileFields", "pickShortPitch", "pickDescription", "fitValueToConstraints",
  `${source.slice(start, end)}; return pickDescriptionForField;`,
)(
  () => ({}),
  (field) => field.hint,
  (config) => config.projectFields || {},
  () => "Fallback pitch.",
  () => "First sentence. Second sentence. Third sentence. Fourth sentence.",
  (value, constraints) => constraints.maxWords
    ? value.split(/\s+/).slice(0, constraints.maxWords).join(" ")
    : value,
);
assert.equal(pick({ projectFields: { "Short description(20-30 words)": "A compact product summary." } },
  { hint: "Tool short description (Optional)" }), "A compact product summary.");
assert.equal(pick({}, { hint: "Tool Description Please describe your product in 2-3 sentences." }),
  "First sentence. Second sentence. Third sentence.");
console.log("short description and sentence count routing passed");

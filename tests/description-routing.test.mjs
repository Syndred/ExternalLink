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
const shortWithMinimum = new Function(
  "getFieldConstraints", "getFieldHint", "getProfileFields", "pickShortPitch", "pickDescription", "fitValueToConstraints",
  `${source.slice(start, end)}; return pickDescriptionForField;`,
)(
  () => ({ minWords: 10, maxWords: 30 }),
  (field) => field.hint,
  (config) => config.projectFields || {},
  () => "Tiny pitch.",
  () => "This longer product summary has enough words to satisfy the directory minimum for short descriptions.",
  (value) => value,
);
assert.match(shortWithMinimum({}, { hint: "Short description (10-30 words)" }), /longer product summary/,
  "a too-short profile pitch must fall back to factual longer copy");
const constraintsSource = source.slice(source.indexOf("  function findCharCounter("), source.indexOf("  function fitValueToConstraints("));
const actualConstraints = new Function(
  "getSnapshotLabel", "getFieldHint", "document", `${constraintsSource}; return getFieldConstraints;`,
)(
  () => "Short description (10-30 words)",
  () => "Short description (10-30 words)",
  { getElementById: () => null },
);
const shortField = {
  parentElement: { textContent: "Short description (10-30 words) 0/30 words" },
  getAttribute: () => null,
  maxLength: -1,
  minLength: -1,
  required: false,
};
assert.deepEqual(actualConstraints(shortField), {
  maxLength: null, minLength: null, maxWords: 30, minWords: 10, required: false,
}, "a word counter must not become a 30-character limit");
console.log("short description and sentence count routing passed");

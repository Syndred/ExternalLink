import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");

function extractFunction(name, nextName) {
  const start = content.indexOf(`  function ${name}(`);
  const end = content.indexOf(`  function ${nextName}(`, start);
  assert.ok(start >= 0 && end > start, `${name} source must exist`);
  return content.slice(start, end).trim();
}

const mediaHelper = new Function(
  "getProfileFields",
  `${extractFunction("publicMediaUrlForField", "resolveValueForField")}; return publicMediaUrlForField;`,
)((config) => config.projectFields || {});

assert.equal(
  mediaHelper({ targetDomain: "https://jevplay.com/games", projectFields: {} }, "product image url"),
  "",
  "product homepage must never be used as an image URL",
);
assert.equal(
  mediaHelper({ logoUrl: "cloud-media://private-logo", projectFields: {} }, "product icon url"),
  "",
  "private cloud media references must not be sent to third-party URL fields",
);
assert.equal(
  mediaHelper({ projectFields: { LOGO: "https://cdn.example.com/logo.png" } }, "product icon url"),
  "https://cdn.example.com/logo.png",
);

const selectTokens = new Function(
  "getFieldHint",
  "getProfileFields",
  `${extractFunction("resolveSelectTokens", "resolveSelectValueForField")}; return resolveSelectTokens;`,
)((element) => element.hint, (config) => config.projectFields || {});
const tags = selectTokens(
  { hint: "tags max 5" },
  { brandName: "JevPlay", tags: "AI games, decision games, human vs AI, TypeSafe Jev, daily challenge, sixth tag" },
);
assert.deepEqual(tags.slice(0, 5), ["AI games", "decision games", "human vs AI", "TypeSafe Jev", "daily challenge"]);
assert.equal(tags.includes("sixth tag"), false, "the custom tag selector should use at most five profile tags");

const isCustomDropdownEmpty = new Function(
  "compactText",
  `${extractFunction("isCustomDropdownEmpty", "countEmptyFillableFields")}; return isCustomDropdownEmpty;`,
)((value, limit) => String(value || "").trim().slice(0, limit));
const reactSelectInput = (selected, value = "") => ({
  tagName: "INPUT",
  value,
  textContent: "",
  closest: () => ({ querySelector: () => selected ? { textContent: selected } : null }),
  getAttribute: (name) => name === "role" ? "combobox" : null,
});
assert.equal(isCustomDropdownEmpty(reactSelectInput("", "AI games, decision games")), true);
assert.equal(isCustomDropdownEmpty(reactSelectInput("Free")), false);

const fieldIsRequired = new Function(
  "getSnapshotLabel",
  `${extractFunction("fieldIsRequired", "collectFillLearnings")}; return fieldIsRequired;`,
)((element) => element.label);
assert.equal(fieldIsRequired({ required: false, getAttribute: () => null, label: "Pricing* Select..." }), true);

const routing = content.slice(content.indexOf("  function resolveValueForField("), content.indexOf("  async function fillSelectField("));
assert.ok(routing.indexOf("publicMediaUrlForField(config, normalizedHint)") < routing.indexOf("const learnedKey"));
assert.ok(routing.indexOf('element.getAttribute("role") === "combobox"') < routing.indexOf("const learnedKey"));
assert.doesNotMatch(content, /options\[0\]\.el\.click\(\)/, "custom selects must not choose an arbitrary first option");
assert.match(content, /new KeyboardEvent\("keydown"[\s\S]*key: "ArrowDown"/);
assert.match(content, /new MouseEvent\("mousedown"/);

console.log("content media and custom select routing tests passed");

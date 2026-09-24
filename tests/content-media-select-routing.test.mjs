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

const snapshotLabel = new Function(
  "document", "cssEscape", "compactText",
  `${extractFunction("getSnapshotLabel", "getSnapshotValueInfo")}; return getSnapshotLabel;`,
)(
  {
    getElementById: (id) => id === "label-tool-name" ? { textContent: "Tool Name" } : null,
    querySelectorAll: () => [],
  },
  (value) => value,
  (value, limit) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit),
);
assert.equal(snapshotLabel({
  id: "random-id", textContent: "", closest: () => null,
  getAttribute: (name) => name === "aria-labelledby" ? "label-tool-name" : null,
}), "Tool Name", "aria-labelledby headings must supply semantic form labels for Tally fields");

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
assert.equal(selectTokens({ hint: "pricing model" }, {
  projectFields: { "PRICING TYPE": "Paid generation with credits. Public browsing is free." },
})[0], "paid", "free browsing must not classify paid generation as free");

const selectValue = new Function(
  "getNativeSelectOptions", "resolveSelectTokens", "getFieldHint", "findBestSelectOption",
  `${extractFunction("resolveSelectValueForField", "queryCustomDropdowns")}; return resolveSelectValueForField;`,
)(
  (element) => element.options,
  selectTokens,
  (element) => element.hint,
  (options, token) => options.find((option) => option.label.toLowerCase() === String(token).toLowerCase()) || null,
);
const industrySelect = { tagName: "SELECT", hint: "Primary industry", options: [
  { value: "retail", label: "E-commerce & Retail" },
  { value: "tech", label: "Technology & Software" },
  { value: "other", label: "Other" },
] };
assert.equal(selectValue(industrySelect, { brandName: "JevPlay", tags: "AI games, decision games" }), "other",
  "an unrelated category must not be picked from a generic token or first option");

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
const fieldHelpers = content.slice(
  content.indexOf("  function isEmailFieldHint("),
  content.indexOf("  function getProfileFields("),
);
assert.ok(routing.indexOf("publicMediaUrlForField(config, normalizedHint)") < routing.indexOf("const learnedKey"));
assert.ok(routing.indexOf('element.getAttribute("role") === "combobox"') < routing.indexOf("const learnedKey"));
assert.ok(routing.indexOf('element.parentElement?.querySelector(\'input[type="hidden"][name*="category"]\')') < routing.indexOf("const learnedKey"));
assert.ok(routing.indexOf('pickDescriptionForField(config, element)') < routing.indexOf("const learnedKey"));
const resolveValue = new Function(
  "getProfileFields", "getFieldHint", "getSnapshotLabel", "fitValueToConstraints", "getFieldConstraints", "pickDescriptionForField",
  `${fieldHelpers}; ${routing}; return resolveValueForField;`,
)(
  (config) => config.projectFields || {},
  (element) => element.hint.toLowerCase(),
  (element) => element.label || element.hint,
  (value) => value,
  () => ({}),
  () => "JevPlay is a free browser game against Jev.",
);
const wrongLearned = { "viesearch.com": { title: { value: "https://jevplay.com/games" } } };
assert.equal(resolveValue({ brandName: "JevPlay", projectFields: {}, learnedFieldMappings: wrongLearned },
  { tagName: "INPUT", type: "text", hint: "Title (Optional) Leave blank to auto-fetch from website", getAttribute: () => null }), "JevPlay");
assert.equal(resolveValue({ brandName: "JevPlay", projectFields: {}, learnedFieldMappings: wrongLearned },
  { tagName: "TEXTAREA", type: "textarea", hint: "Description (Optional) Leave blank to auto-fetch from website" }),
  "JevPlay is a free browser game against Jev.");
assert.equal(resolveValue({ brandName: "JevPlay", projectFields: {}, tags: "AI games, decision games" },
  { tagName: "INPUT", type: "text", hint: "Category (Optional) Suggest a New Category", getAttribute: () => null, parentElement: { querySelector: () => ({}) } }), "");
assert.equal(resolveValue({ brandName: "JevPlay", projectFields: {}, tags: "AI games, decision games", email: "contact@example.com" },
  { tagName: "INPUT", type: "text", hint: "Tag Tool category form_fields[email]", label: "Tag Tool category", getAttribute: () => null }),
  "AI games", "visible category label must outrank an internal email field name");
assert.equal(resolveValue({ targetDomain: "https://jevplay.com/games", email: "contact@example.com", projectFields: {} },
  { tagName: "INPUT", type: "url", hint: "Website URL form_fields[email]", label: "Website URL", getAttribute: () => null }),
  "https://jevplay.com/games", "URL input must outrank an internal email field name");
assert.equal(resolveValue({ targetDomain: "https://jevplay.com/games", projectFields: {} },
  { tagName: "INPUT", type: "url", hint: "Affiliate Link", label: "Affiliate Link", getAttribute: () => null }),
  "", "an optional affiliate URL must not reuse the product homepage");
assert.equal(resolveValue({ projectFields: { "Affiliate Link": "https://partner.example.com/jev" } },
  { tagName: "INPUT", type: "url", hint: "Affiliate Link", label: "Affiliate Link", getAttribute: () => null }),
  "https://partner.example.com/jev");
assert.equal(resolveValue({ username: "Syndred", projectFields: {} },
  { tagName: "INPUT", type: "text", hint: "First name", getAttribute: () => null }), "Syndred");
assert.equal(resolveValue({ username: "Syndred", projectFields: {} },
  { tagName: "INPUT", type: "text", hint: "Last name", getAttribute: () => null }), "",
  "a one-token username must not be duplicated into the surname field");
assert.equal(resolveValue({ username: "Syndred Young", projectFields: {} },
  { tagName: "INPUT", type: "text", hint: "Last name", getAttribute: () => null }), "Young");
assert.equal(resolveValue({ projectFields: { "Feature description": "Side-by-side replay" } },
  { tagName: "TEXTAREA", type: "textarea", hint: "Key features", label: "Key features" }), "Side-by-side replay");
assert.equal(resolveValue({ useCases: ["Compare daily puzzle decisions"] },
  { tagName: "TEXTAREA", type: "textarea", hint: "Use cases", label: "Use cases" }), "Compare daily puzzle decisions");
const aiSuperRequired = new Function("getSnapshotLabel", "location",
  `${extractFunction("fieldIsRequired", "collectFillLearnings")}; return fieldIsRequired;`,
)((element) => element.label || "", { hostname: "www.aisuperhub.io" });
assert.equal(aiSuperRequired({ name: "email", required: false, getAttribute: () => null }), true);
assert.equal(aiSuperRequired({ name: "shortDescription", required: false, getAttribute: () => null }), true);
assert.equal(aiSuperRequired({ name: "socialUrl", required: false, getAttribute: () => null }), false);
assert.doesNotMatch(content, /options\[0\]\.el\.click\(\)/, "custom selects must not choose an arbitrary first option");
assert.match(content, /new KeyboardEvent\("keydown"[\s\S]*key: "ArrowDown"/);
assert.match(content, /new MouseEvent\("mousedown"/);

console.log("content media and custom select routing tests passed");

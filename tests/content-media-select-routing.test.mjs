import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");

function extractFunction(name, nextName) {
  const plain = content.indexOf(`  function ${name}(`);
  const asyncStart = content.indexOf(`  async function ${name}(`);
  const start = plain >= 0 ? plain : asyncStart;
  const nextPlain = content.indexOf(`  function ${nextName}(`, start);
  const nextAsync = content.indexOf(`  async function ${nextName}(`, start);
  const end = nextPlain >= 0 ? nextPlain : nextAsync;
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
assert.equal(snapshotLabel({
  id: "", textContent: "", closest: () => null,
  parentElement: {
    querySelectorAll: () => [{}],
    querySelector: () => ({ textContent: "Tool name *" }),
  },
  getAttribute: (name) => name === "placeholder" ? "e.g. ChatGPT" : null,
}), "Tool name * e.g. ChatGPT", "an adjacent visible label must identify unbound React inputs");
assert.equal(snapshotLabel({
  id: "", textContent: "Free Freemium Paid", closest: () => null,
  parentElement: {
    querySelectorAll: () => [{}], querySelector: () => null,
    previousElementSibling: { textContent: "Pricing Model", querySelector: () => null },
  },
  getAttribute: () => null,
}), "Pricing Model Free Freemium Paid", "unbound native selects must inherit a preceding label");

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
assert.equal(
  mediaHelper({ projectFields: { "Screenshot 1": "https://example.com/og.png", "Featured image": "https://example.com/og.png" } }, "screenshot url"),
  "",
  "a featured marketing image must not be relabeled as a screenshot",
);
assert.equal(
  mediaHelper({ projectFields: { "Screenshot 1": "https://example.com/real-screen.png", "Featured image": "https://example.com/og.png" } }, "screenshot url"),
  "https://example.com/real-screen.png",
);
assert.equal(
  mediaHelper({ projectFields: { "Screenshot 1": "https://graffitinameai.com/images/graffiti-examples/throw-up-kilo.png" } }, "screenshot url"),
  "",
  "a generated graffiti example is not a product-screen screenshot",
);
assert.equal(
  mediaHelper({ projectFields: { "Screenshot 1": "https://cdn.example.com/01-home.png" } }, "screenshot url"),
  "https://cdn.example.com/01-home.png",
);

const selectTokens = new Function(
  "getFieldHint",
  "getProfileFields",
  `${extractFunction("resolveSelectTokens", "resolveSelectValueForField")}; return resolveSelectTokens;`,
)((element) => String(element.hint || "").toLowerCase(), (config) => config.projectFields || {});
const tags = selectTokens(
  { hint: "tags max 5" },
  { brandName: "JevPlay", tags: "AI games, decision games, human vs AI, TypeSafe Jev, daily challenge, sixth tag" },
);
assert.deepEqual(tags.slice(0, 5), ["AI games", "decision games", "human vs AI", "TypeSafe Jev", "daily challenge"]);
assert.equal(tags.includes("sixth tag"), false, "the custom tag selector should use at most five profile tags");
assert.equal(selectTokens({ hint: "pricing model" }, {
  projectFields: { "PRICING TYPE": "Paid generation with credits. Public browsing is free." },
})[0], "paid", "free browsing must not classify paid generation as free");
assert.equal(selectTokens({ hint: "Category *", label: "Category *" }, {
  brandName: "Graffiti Name AI", tags: "graffiti name generator, bubble letters",
})[0], "Design Assets & Icons", "broad directory category must precede SEO tags");
assert.equal(selectTokens({ hint: "Category *" }, {
  brandName: "OldPhotoLive AI", tags: "old photo animation, photo restoration",
})[0], "Image Generation");
assert.ok(selectTokens({ hint: "Category *" }, {
  brandName: "OldPhotoLive AI", tags: "old photo animation, photo restoration",
}).includes("Image & Video Generators"), "photo tools must match a directory's exact image and video category");
assert.ok(selectTokens({ hint: "Category *" }, {
  brandName: "Graffiti Name AI", tags: "graffiti name generator, bubble letters",
}).includes("Design Generators"), "design tools must match a directory's exact design category");
assert.equal(selectTokens({ hint: "Category *" }, {
  brandName: "JevPlay", tags: "AI games, decision games",
})[0], "AI Tools (Other)");
assert.equal(selectTokens({ hint: "Primary Use Case *" }, {
  brandName: "JevPlay", tags: "AI games, decision games",
})[0], "General Purpose", "JevPlay must not be classified as a business workflow");
assert.equal(selectTokens({ hint: "Primary Use Case *" }, {
  brandName: "OldPhotoLive AI",
})[0], "For Content Creators");
assert.equal(selectTokens({ hint: "Primary Use Case *" }, {
  brandName: "Graffiti Name AI",
})[0], "For Designers");
assert.equal(selectTokens({ hint: "Pricing Model Free Freemium Paid" }, {
  brandName: "Graffiti Name AI", projectFields: { "PRICING TYPE": "Paid generation with credits" },
})[0], "paid");
const matchOption = new Function("normalizeOptionText",
  `${extractFunction("findBestSelectOption", "resolveSelectTokens")}; return findBestSelectOption;`,
)((value) => String(value || "").toLowerCase());
assert.equal(matchOption([
  { value: "Design", label: "Image & Video Generators" },
  { value: "Development", label: "Design Generators" },
], "Design")?.label, "Design Generators",
"visible category label must outrank opaque Select2 option values");

const selectValue = new Function(
  "getNativeSelectOptions", "resolveSelectTokens", "getFieldHint", "findBestSelectOption", "getProfileFields",
  `${extractFunction("resolveSelectValueForField", "queryCustomDropdowns")}; return resolveSelectValueForField;`,
)(
  (element) => element.options,
  selectTokens,
  (element) => element.hint,
  (options, token) => options.find((option) => option.label.toLowerCase() === String(token).toLowerCase()) || null,
  (config) => config.projectFields || {},
);
const industrySelect = { tagName: "SELECT", hint: "Primary industry", options: [
  { value: "retail", label: "E-commerce & Retail" },
  { value: "tech", label: "Technology & Software" },
  { value: "other", label: "Other" },
] };
assert.equal(selectValue(industrySelect, { brandName: "JevPlay", tags: "AI games, decision games" }), "other",
  "an unrelated category must not be picked from a generic token or first option");
assert.equal(selectValue({ tagName: "SELECT", hint: "Pricing Model", options: [
  { value: "Free", label: "Free" }, { value: "Freemium", label: "Freemium" }, { value: "Paid", label: "Paid" },
] }, { brandName: "Graffiti Name AI", projectFields: { "PRICING TYPE": "Paid generation with credits" } }),
"Paid", "directory pricing choice must reflect paid generation");
assert.equal(selectValue({ tagName: "SELECT", hint: "Pricing Model", options: [
  { value: "Free", label: "Free" }, { value: "Freemium", label: "Freemium" }, { value: "Paid", label: "Paid" },
] }, { brandName: "OldPhotoLive AI", projectFields: { "PRICING TYPE": "Freemium" } }),
"Freemium", "a free default must not misstate an OldPhoto freemium product");
assert.equal(selectValue({ tagName: "SELECT", hint: "Where the company is based", options: [
  { value: "", label: "Not sure / prefer not to say" }, { value: "US", label: "United States" },
] }, { brandName: "Graffiti Name AI" }), "",
"unknown company location must not be fabricated as United States");

const freePanelClick = { count: 0, click() { this.count++; }, textContent: "Verify & get listed free" };
const openFreePanel = new Function(
  "document", "isInsideCollapsedPanel", "isVisible", "sleep",
  `${extractFunction("openFreeListingPanelIfNeeded", "queryFillableElements")}; return openFreeListingPanelIfNeeded;`,
)(
  { querySelector: (selector) => selector === "#panel-free.st-form-panel"
    ? { querySelector: () => ({}) }
    : selector === "#card-free button" ? freePanelClick : null },
  () => true,
  () => true,
  async () => {},
);
await openFreePanel();
assert.equal(freePanelClick.count, 1, "collapsed free listing panel must open before selecting a form");
const collapsedPanel = {
  parentElement: null,
  getBoundingClientRect: () => ({ height: 0 }),
};
const formInCollapsedPanel = { parentElement: collapsedPanel };
const clipped = new Function("document", "window",
  `${extractFunction("isInsideCollapsedPanel", "openFreeListingPanelIfNeeded")}; return isInsideCollapsedPanel;`,
)(
  { body: {} },
  { getComputedStyle: () => ({ overflow: "hidden", overflowY: "hidden" }) },
);
assert.equal(clipped(formInCollapsedPanel), true, "zero-height clipped paid panels must be excluded from form selection");
assert.match(content, /select2-hidden-accessible/, "hidden Select2 native control must be eligible when its form is open");
assert.ok(content.includes("const wrongPricingDefault = (selectedDefault || controlledFreeDefault)"),
  "native and controlled Free defaults must be eligible for Profile pricing reconciliation");

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
const testLocation = { hostname: "www.iatool.online" };
const resolveValue = new Function(
  "getProfileFields", "getFieldHint", "getSnapshotLabel", "fitValueToConstraints", "getFieldConstraints", "pickDescriptionForField", "location",
  `${fieldHelpers}; ${routing}; return resolveValueForField;`,
)(
  (config) => config.projectFields || {},
  (element) => element.hint.toLowerCase(),
  (element) => element.label || element.hint,
  (value) => value,
  () => ({}),
  () => "JevPlay is a free browser game against Jev.",
  testLocation,
);
assert.equal(resolveValue({ brandName: "Graffiti Name AI", projectFields: {}, tags: "graffiti name generator, bubble letters" },
  { tagName: "INPUT", type: "text", hint: "Category (optional)", label: "Category (optional)", getAttribute: () => null }),
  "Image Generation & Editing", "Come AI category must describe the tool rather than repeat a search keyword");
assert.equal(resolveValue({ brandName: "OldPhotoLive AI", projectFields: {}, tags: "old photo restoration, animation" },
  { tagName: "INPUT", type: "text", hint: "Category (optional)", label: "Category (optional)", getAttribute: () => null }),
  "Image Generation & Editing");
assert.equal(resolveValue({ brandName: "JevPlay", projectFields: {}, tags: "AI games, decision games" },
  { tagName: "INPUT", type: "text", hint: "Category (optional)", label: "Category (optional)", getAttribute: () => null }),
  "", "an optional category without a matching site taxonomy must remain empty");
testLocation.hostname = "example.com";
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
assert.equal(resolveValue({ targetDomain: "https://graffitinameai.com", projectFields: {} },
  { tagName: "INPUT", type: "url", hint: "2. Paste the page you added it to, then verify", label: "2. Paste the page you added it to, then verify", getAttribute: () => null }),
  "", "a backlink verification field must stay blank until a backlink exists");
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
assert.equal(resolveValue({ targetAudience: "Daily puzzle players", projectFields: {} },
  { tagName: "TEXTAREA", type: "textarea", hint: "Target audience", label: "Target audience" }), "Daily puzzle players");
assert.equal(resolveValue({ useCases: ["Compare AI game decisions"], projectFields: {} },
  { tagName: "TEXTAREA", type: "textarea", hint: "Short description. Who is this for and what is its primary use case?", label: "Short description. Who is this for and what is its primary use case?" }),
  "JevPlay is a free browser game against Jev.", "a description hint mentioning a use case must remain a description");
assert.equal(resolveValue({ useCases: ["Compare AI game decisions"], projectFields: {} },
  { tagName: "TEXTAREA", type: "textarea", hint: "Full product description. Explain core use cases and features.", label: "Full product description. Explain core use cases and features." }),
  "JevPlay is a free browser game against Jev.", "a full description must not receive only a feature list");
assert.equal(resolveValue({ projectFields: {} },
  { tagName: "TEXTAREA", type: "textarea", hint: "Target audience", label: "Target audience" }), "",
  "a required audience field must not receive the whole product description");
assert.equal(resolveValue({ projectFields: {} },
  { tagName: "TEXTAREA", type: "textarea", hint: "Pros (one per line)", label: "Pros (one per line)" }), "",
  "pros must not receive the whole product description");
assert.equal(resolveValue({ projectFields: { Pros: "No account needed to play" } },
  { tagName: "TEXTAREA", type: "textarea", hint: "Pros (one per line)", label: "Pros (one per line)" }), "No account needed to play");
assert.equal(resolveValue({ username: "Syndred Young", projectFields: {} },
  { tagName: "INPUT", type: "text", hint: "Founder or company name", label: "Founder or company name", getAttribute: () => null }), "Syndred Young");
assert.equal(resolveValue({ username: "Syndred", projectFields: {} },
  { tagName: "INPUT", type: "text", hint: "Founder / company", label: "Founder / company", getAttribute: () => null }), "Syndred");
assert.equal(resolveValue({ brandName: "JevPlay", projectFields: { "Short description(20-30 words)": "Play free daily decision games against TypeSafe Jev." } },
  { tagName: "INPUT", type: "text", hint: "One-line description one_liner", label: "One-line description", getAttribute: () => null }),
  "Play free daily decision games against TypeSafe Jev.", "a one-line field must use the short Profile copy");
assert.equal(resolveValue({ projectFields: { Note: "Free server-verified games with replay evidence." } },
  { tagName: "TEXTAREA", type: "textarea", hint: "Why should we list it?", label: "Why should we list it?" }),
  "Free server-verified games with replay evidence.");
assert.equal(resolveValue({ useCases: ["Compare daily puzzle decisions"] },
  { tagName: "TEXTAREA", type: "textarea", hint: "Use cases", label: "Use cases" }), "Compare daily puzzle decisions");
assert.equal(resolveValue({ projectFields: { Pricing: "Free: 1 photo/day. Pro: $19.99/month." } },
  { tagName: "TEXTAREA", type: "textarea", hint: "Pricing Details", label: "Pricing Details" }),
  "Free: 1 photo/day. Pro: $19.99/month.", "pricing details must not receive the long product description");
assert.equal(resolveValue({ screenshots: ["https://example.com/scene.png", "cloud-media://private", "https://example.com/page"] },
  { tagName: "TEXTAREA", type: "textarea", hint: "Screenshots (one image URL per line)", label: "Screenshots (one image URL per line)" }),
  "https://example.com/scene.png", "screenshot URL lists must exclude private media references and page URLs");
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

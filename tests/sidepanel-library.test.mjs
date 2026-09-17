import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const classifierSource = readFileSync(new URL("../extension/lib/library-classifier.js", import.meta.url), "utf8");
const sidepanelHtml = readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanelSource = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const settingsHtml = readFileSync(new URL("../extension/settings.html", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../extension/settings.js", import.meta.url), "utf8");

const context = vm.createContext({ self: {}, URL, JSON, Number, String, Array, Object, RegExp });
vm.runInContext(classifierSource, context);
const classifier = context.self.ExtLinkLibraryClassifier;

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}`);
}

assert.equal(classifier.inferCategory({ entry: { link_category: "AI Tools Directory" } }), "AI 工具目录");
assert.equal(classifier.inferCategory({ entry: { tags: ["startup", "launch"] } }), "启动发布");
assert.equal(classifier.inferCategory({ entry: { link_category: "Community Forum" } }), "社区 / 论坛");
assert.equal(classifier.inferCategory({ entry: { link_category: "Business Directory" } }), "企业 / 本地目录");
assert.deepEqual(
  Array.from(classifier.normalizeTags('["directory","ai-tools"]')),
  ["directory", "ai-tools"],
);
assert.equal(classifier.normalizeAccessModel("freemium"), "freemium");
assert.deepEqual(
  JSON.parse(JSON.stringify(classifier.libraryPreferences({
    library: { favorite: true, enabled: false, profileIds: ["Video", "Video", "AISpeak"] },
  }))),
  { favorite: true, enabled: false, profileIds: ["Video", "AISpeak"], updatedAt: "" },
);
assert.equal(classifier.libraryEligibility({}, "Video").allowed, true);
assert.equal(classifier.libraryEligibility({ library: { enabled: false } }, "Video").reason, "library_disabled");
assert.equal(
  classifier.libraryEligibility({ library: { profileIds: ["AISpeak"] } }, "Video").reason,
  "profile_not_assigned",
);
assert.equal(classifier.libraryEligibility({ library: { profileIds: ["AISpeak"] } }, "AISpeak").allowed, true);

assert.match(sidepanelHtml, /data-panel="library"[^>]*>外链</);
assert.match(sidepanelHtml, /id="panel-library"/);
assert.match(sidepanelHtml, /id="sidepanelLibraryCategory"/);
assert.match(sidepanelHtml, /id="btnStartLibraryCategory"/);
assert.match(sidepanelHtml, /id="sidepanelLibraryFavorite"/);
assert.match(sidepanelHtml, /id="btnQuickOpenBatch"/);
assert.match(sidepanelHtml, /lib\/library-classifier\.js/);
assert.match(sidepanelSource, /action: "getLibraryManagerState"/);
assert.match(sidepanelSource, /action: "updateLibraryPreferences"/);
assert.match(sidepanelSource, /action: "quickOpenLibraryUrls"/);
assert.match(sidepanelSource, /category,\s*config:/);
assert.match(sidepanelSource, /loadSidepanelLibrary/);
assert.match(backgroundSource, /ExtLinkLibraryClassifier\.describe/);
assert.match(backgroundSource, /hasCanonicalLibrary\s*\? \[\.\.\.tableCandidates/);
assert.match(backgroundSource, /category: requestedCategory/);
assert.match(backgroundSource, /function updateLibraryPreferences/);
assert.match(backgroundSource, /function quickOpenLibraryUrls/);
assert.match(backgroundSource, /libraryEligibility\(annotation, task\.profileId\)/);
assert.match(backgroundSource, /case "syncSubmifyLibrary"/);
assert.match(backgroundSource, /api\/banklinks/);
assert.match(settingsHtml, /id="btnSyncSubmifyLibrary"/);
assert.match(settingsHtml, /id="submifySyncStatus"/);
assert.match(settingsSource, /action: "syncSubmifyLibrary"/);

vm.runInContext(extractFunction(backgroundSource, "scopeDestinationGroupsByLibraryCategory"), context);
const scoped = context.scopeDestinationGroupsByLibraryCategory([
  { url: "https://example.ai/submit", domain: "example.ai", source: "table", entry: { category: "AI Tools Directory" } },
  { url: "https://forum.example/", domain: "forum.example", source: "table", entry: { category: "Community Forum" } },
  { url: "https://legacy.example/", domain: "legacy.example", source: "library", entry: null },
], "AI 工具目录");
assert.equal(scoped.length, 1);
assert.equal(scoped[0].category, "AI 工具目录");
assert.equal(scoped[0].domain, "example.ai");

console.log("sidepanel library classification regressions passed");

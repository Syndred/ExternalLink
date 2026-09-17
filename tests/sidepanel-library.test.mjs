import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const classifierSource = readFileSync(new URL("../extension/lib/library-classifier.js", import.meta.url), "utf8");
const sidepanelHtml = readFileSync(new URL("../extension/sidepanel.html", import.meta.url), "utf8");
const sidepanelSource = readFileSync(new URL("../extension/sidepanel.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

const context = vm.createContext({ self: {}, URL, JSON, Number, String, Array, Object, RegExp });
vm.runInContext(classifierSource, context);
const classifier = context.self.ExtLinkLibraryClassifier;

assert.equal(classifier.inferCategory({ entry: { link_category: "AI Tools Directory" } }), "AI 工具目录");
assert.equal(classifier.inferCategory({ entry: { tags: ["startup", "launch"] } }), "启动发布");
assert.equal(classifier.inferCategory({ entry: { link_category: "Community Forum" } }), "社区 / 论坛");
assert.equal(classifier.inferCategory({ entry: { link_category: "Business Directory" } }), "企业 / 本地目录");
assert.deepEqual(
  Array.from(classifier.normalizeTags('["directory","ai-tools"]')),
  ["directory", "ai-tools"],
);
assert.equal(classifier.normalizeAccessModel("freemium"), "freemium");

assert.match(sidepanelHtml, /data-panel="library"[^>]*>外链</);
assert.match(sidepanelHtml, /id="panel-library"/);
assert.match(sidepanelHtml, /id="sidepanelLibraryCategory"/);
assert.match(sidepanelHtml, /lib\/library-classifier\.js/);
assert.match(sidepanelSource, /action: "getLibraryManagerState"/);
assert.match(sidepanelSource, /loadSidepanelLibrary/);
assert.match(backgroundSource, /ExtLinkLibraryClassifier\.describe/);

console.log("sidepanel library classification regressions passed");

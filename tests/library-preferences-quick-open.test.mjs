import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const classifierSource = readFileSync(new URL("../extension/lib/library-classifier.js", import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const signatureEnd = source.indexOf(") {", start);
  assert.ok(signatureEnd >= 0, `${name} signature must end`);
  const open = signatureEnd + 2;
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const storageData = {
  siteProfiles: { Video: { id: "Video" }, AISpeak: { id: "AISpeak" } },
  siteAnnotations: {},
};
const opened = [];
const context = {
  self: {},
  URL,
  Date,
  Set,
  Map,
  String,
  Number,
  Array,
  Object,
  Promise,
  Error,
  setTimeout,
  runSiteAnnotationWrite: (callback) => callback(),
  siteKeyForUrl: (url) => new URL(url).hostname.replace(/^www\./, ""),
  getLibraryManagerState: async () => ({
    ok: true,
    items: [
      { key: "one.example", url: "https://one.example/submit" },
      { key: "two.example", url: "https://two.example/submit" },
    ],
  }),
  chrome: {
    storage: {
      local: {
        async get() { return structuredClone(storageData); },
        async set(value) { Object.assign(storageData, structuredClone(value)); },
      },
    },
    tabs: {
      async create(options) {
        opened.push(options);
        return { id: opened.length };
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(classifierSource, context);
context.self.ExtLinkQueue = {
  extractDomain: (url) => new URL(url).hostname.replace(/^www\./, ""),
};
vm.runInContext(extractFunction(backgroundSource, "updateLibraryPreferences"), context);
vm.runInContext(extractFunction(backgroundSource, "quickOpenLibraryUrls"), context);

const saved = await context.updateLibraryPreferences({
  url: "https://one.example/submit",
  favorite: true,
  enabled: false,
  profileIds: ["Video"],
});
assert.equal(saved.ok, true);
assert.deepEqual(
  JSON.parse(JSON.stringify(saved.library)),
  { favorite: true, enabled: false, profileIds: ["Video"], updatedAt: saved.library.updatedAt },
);
assert.equal(storageData.siteAnnotations["one.example"].library.favorite, true);
await assert.rejects(
  context.updateLibraryPreferences({ url: "https://one.example", profileIds: ["Missing"] }),
  /不存在的 Profile/,
);

const quick = await context.quickOpenLibraryUrls({
  urls: ["https://one.example/submit", "javascript:alert(1)", "https://unknown.example", "https://two.example/submit"],
  batchSize: 2,
  intervalMs: 100,
});
assert.equal(quick.opened.length, 2);
assert.deepEqual(JSON.parse(JSON.stringify(opened)), [
  { url: "https://one.example/submit", active: false },
  { url: "https://two.example/submit", active: false },
]);

console.log("library preferences and Quick Open tests passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const classifierSource = readFileSync(new URL("../extension/lib/library-classifier.js", import.meta.url), "utf8");
const importerSource = readFileSync(new URL("../extension/lib/submify-import.js", import.meta.url), "utf8");
const backgroundSource = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
const context = vm.createContext({ self: {}, URL, Date, JSON, Number, String, Array, Object, Set, Map });
vm.runInContext(classifierSource, context);
vm.runInContext(importerSource, context);

const normalizeKey = (value) => {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};
const importedAt = "2026-09-17T08:00:00.000Z";
const sourceItems = [
  {
    id: "sub-1",
    name: "Example refreshed",
    link: "https://example.com/submit",
    tips: "Current instructions",
    tags: ["directory", "ai-tools"],
    access_model: "free",
    link_category: "AI Tools Directory",
    status: "approved",
    site_status: "active",
    eligibility: "eligible",
    opportunity_type: "directory_listing",
    dr: 42,
  },
  {
    id: "sub-2",
    name: "Paid directory",
    link: "https://paid.example/list",
    is_paid: true,
    access_model: "paid",
    status: "approved",
    site_status: "active",
    eligibility: "eligible",
  },
];

const merged = context.self.ExtLinkSubmifyImport.mergeLibrary({
  entries: [
    {
      link: "https://example.com/old",
      indexPage: "https://example.com/old",
      name: "Old source value",
      source: "submify-public",
      sourceId: "sub-1",
      projects: ["VideoToArticleAI"],
      submitted: true,
      rawFields: { PersonalNote: "keep me" },
    },
    {
      link: "https://shared.example/submit",
      indexPage: "https://shared.example/submit",
      name: "My custom name",
      source: "manual",
      note: "My note",
    },
  ],
}, sourceItems, { normalizeKey, importedAt });

assert.equal(merged.stats.sourceTotal, 2);
assert.equal(merged.stats.added, 1);
assert.equal(merged.stats.total, 3);
const refreshed = merged.tableData.entries.find((entry) => entry.sourceId === "sub-1");
assert.equal(refreshed.name, "Example refreshed");
assert.deepEqual(Array.from(refreshed.projects), ["VideoToArticleAI"]);
assert.equal(refreshed.submitted, true);
assert.equal(refreshed.rawFields.PersonalNote, "keep me");
assert.equal(refreshed.metrics.dr, 42);
assert.equal(merged.addedItems[0].gate, "paid");
assert.equal(merged.tableData.snapshotMeta.lastExternalImport.sourceTotal, 2);

const shared = context.self.ExtLinkSubmifyImport.mergeLibrary({
  entries: [{ link: "https://example.com/custom", indexPage: "https://example.com/custom", name: "Keep custom", source: "manual" }],
}, [sourceItems[0]], { normalizeKey, importedAt });
assert.equal(shared.tableData.entries.length, 1);
assert.equal(shared.tableData.entries[0].name, "Keep custom");
assert.deepEqual(Array.from(shared.tableData.entries[0].sourceRefs), ["sub-1"]);

assert.equal(context.self.ExtLinkSubmifyImport.recommendedGate({ opportunity_type: "community_post" }), "skip");
assert.equal(context.self.ExtLinkSubmifyImport.recommendedGate(sourceItems[0]), "");

function extractAsyncFunction(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const pages = new Map([
  [1, { list: Array.from({ length: 50 }, (_, index) => ({ id: `id-${index + 1}` })), pagination: { total: 51 } }],
  [2, { list: [{ id: "id-51" }], pagination: { total: 51 } }],
]);
context.fetch = async (url) => {
  const page = Number(new URL(url).searchParams.get("page"));
  return { ok: true, status: 200, json: async () => ({ code: 0, data: pages.get(page) }) };
};
vm.runInContext(extractAsyncFunction(backgroundSource, "fetchSubmifyPublicLibrary"), context);
const fetched = await context.fetchSubmifyPublicLibrary();
assert.equal(fetched.advertisedTotal, 51);
assert.equal(fetched.items.length, 51);
assert.equal(fetched.items.at(-1).id, "id-51");

console.log("Submify incremental import tests passed");

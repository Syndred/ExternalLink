import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const html = readFileSync("extension/sidepanel.html", "utf8");
const js = readFileSync("extension/sidepanel.js", "utf8");
const css = readFileSync("extension/sidepanel.css", "utf8");

for (const id of ["sidepanelTimelineCard", "sidepanelTimelineSummary", "sidepanelTimelineList"]) {
  assert.match(html, new RegExp(`id="${id}"`), `sidepanel should expose #${id}`);
}
assert.match(js, /function\s+renderSidepanelTimeline\s*\(/);
assert.match(js, /getLibraryManagerState/);
assert.match(js, /action:\s*["']getLibraryManagerState["'][\s\S]*url:\s*pageUrl/);
assert.match(css, /sidepanel-timeline/);
assert.match(
  css,
  /@media \(max-width: 380px\)[\s\S]*?\.sidepanel-timeline-event-head\s*\{\s*flex-wrap:\s*wrap;/,
  "long timeline statuses must wrap rather than overflow a narrow side panel",
);

const helperSource = js.slice(0, js.indexOf("// ExternalLink Side Panel"));
const context = { self: {} };
vm.runInNewContext(helperSource, context);
const buildTimelineModel = context.self.ExtLinkSidepanel?.buildTimelineModel;
assert.equal(typeof buildTimelineModel, "function", "sidepanel should expose its timeline model");

const model = buildTimelineModel(
  {
    events: [
      {
        profileId: "RainbowPetAI",
        profileName: "RainbowPetAI",
        type: "submitted",
        occurredAt: "2026-09-01T01:00:00.000Z",
        note: "等待审核",
      },
      {
        profileId: "TextComparison",
        type: "published",
        occurredAt: "2026-09-03T01:00:00.000Z",
        note: "公开页已可访问",
        publicUrl: "https://example.com/listing",
      },
    ],
    profileStatuses: [
      { profileId: "RainbowPetAI", profileName: "RainbowPetAI", eventCount: 1 },
      { profileId: "TextComparison", profileName: "TextComparison", eventCount: 1 },
    ],
  },
  {
    RainbowPetAI: { name: "RainbowPetAI" },
    TextComparison: { name: "TextComparison" },
  },
);

assert.equal(model.profileCount, 2);
assert.equal(model.events.length, 2);
assert.deepEqual(
  JSON.parse(JSON.stringify(model.events.map((event) => [event.profileId, event.type, event.note]))),
  [
    ["TextComparison", "published", "公开页已可访问"],
    ["RainbowPetAI", "submitted", "等待审核"],
  ],
  "sidebar timeline should keep Profile labels and show newest activity first",
);
assert.equal(model.events[0].publicUrl, "https://example.com/listing");

console.log("Sidepanel timeline tests passed");

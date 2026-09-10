import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("extension/sidepanel.js", "utf8");

function extractFunction(text, name) {
  const start = text.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `sidepanel.js should define ${name}()`);
  const open = text.indexOf("{", text.indexOf(")", start) + 1);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  throw new Error(`could not extract ${name}()`);
}

const loadSource = extractFunction(source, "loadSidepanelTimeline");
let resolveCloudGate;
const cloudGate = new Promise((resolve) => {
  resolveCloudGate = resolve;
});
const calls = [];
const localItem = { key: "devpages.io/submit-a-tool", url: "https://devpages.io/submit-a-tool", events: [{ id: "local" }] };
const remoteItem = { ...localItem, events: [{ id: "rspai" }, { id: "remote" }] };
let currentTimelineItem = null;
let timelineLoadToken = 0;
let currentPageUrl = localItem.url;
const context = {
  console,
  Promise,
  URL,
  String,
  Number,
  Date,
  resolveCloudGate,
  currentPageUrl,
  chrome: {
    runtime: {
      sendMessage(message) {
        calls.push(message);
        if (message.action === "getLibraryManagerState") {
          return Promise.resolve({ ok: true, items: [calls.some((entry) => entry.action === "refreshSubmissionLedger") ? remoteItem : localItem] });
        }
        if (message.action === "refreshSubmissionLedger") return cloudGate;
        throw new Error(`unexpected message ${message.action}`);
      },
    },
  },
  findSidepanelTimelineItem(items) {
    return items?.[0] || null;
  },
  renderSidepanelTimeline(item, options = {}) {
    calls.push({ render: item, options });
    currentTimelineItem = item;
  },
};
context.self = context;
vm.createContext(context);
vm.runInContext(
  `let currentTimelineItem = null;
   let timelineLoadToken = 0;
   let currentPageUrl = ${JSON.stringify(currentPageUrl)};
   const chrome = globalThis.chrome;
   const findSidepanelTimelineItem = globalThis.findSidepanelTimelineItem;
   const renderSidepanelTimeline = globalThis.renderSidepanelTimeline;
   ${loadSource}`,
  context,
);

const load = vm.runInContext("loadSidepanelTimeline", context);
const pending = load(currentPageUrl);
await pending;

const localRender = calls.find((entry) => entry.render?.events?.[0]?.id === "local");
assert.ok(localRender, "local timeline should render before cloud refresh completes");
assert.ok(calls.some((entry) => entry.action === "refreshSubmissionLedger"), "cloud refresh should start after local render");
assert.equal(calls.some((entry) => entry.render?.events?.[0]?.id === "rspai"), false, "cloud response must not render before it resolves");

context.resolveCloudGate({ ok: true, sync: { status: "applied", message: "已从云端更新外链动态。" } });
await new Promise((resolve) => setImmediate(resolve));
assert.ok(calls.some((entry) => entry.render?.events?.[0]?.id === "rspai"), "cloud timeline should render after the refresh resolves");

console.log("sidepanel timeline refresh tests passed");

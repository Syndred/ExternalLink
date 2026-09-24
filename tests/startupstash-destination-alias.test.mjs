import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync("extension/background.js", "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (["'", '"', "`"].includes(char)) {
      quote = char;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not extract ${name}`);
}

const helperStart = background.indexOf("const DISPLAY_HOST_DESTINATIONS");
const helperEnd = background.indexOf("async function getSiteAnnotation", helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const context = {
  Set,
  Date,
  URL,
  Object,
  self: {
    ExtLinkQueue: {
      normalizeDestinationKey(value) {
        const parsed = new URL(String(value).startsWith("http") ? value : `https://${value}`);
        return `${parsed.hostname.replace(/^www\./i, "").toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
      },
      extractDomain(value) {
        return new URL(String(value).startsWith("http") ? value : `https://${value}`).hostname.replace(/^www\./i, "").toLowerCase();
      },
      submissionRecordKey(destinationKey, profileId) {
        return `${destinationKey}::${profileId}`;
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(`${background.slice(helperStart, helperEnd)}\n${extractFunction(background, "siteKeyForUrl")}`, context);

assert.equal(context.siteKeyForUrl("https://startupstash.com"), "startupstash.com");
assert.equal(context.siteKeyForUrl("https://startupstash.com/add-listing/"), "startupstash.com");
assert.equal(context.siteKeyForUrl("https://www.tipseason.com/ai-tools/submit-free/success"), "tipseason.com");
assert.equal(context.siteKeyForUrl("https://library.phygital.plus/tool-submission"), "library.phygital.plus");
assert.equal(context.siteKeyForUrl("https://other.example/submit"), "other.example/submit");

const pathRecord = {
  status: "success",
  destinationKey: "startupstash.com/add-listing",
  destinationUrl: "https://startupstash.com/add-listing/",
  profileId: "JevPlay",
  confirmedBy: "agent",
  evidence: "Thank you for applying to get listed on StartupStash!",
};
const records = { "startupstash.com/add-listing::JevPlay": pathRecord };
const expanded = context.expandSubmissionRecordsForQueue(records, ["https://startupstash.com/"]);
assert.equal(expanded["startupstash.com::JevPlay"], pathRecord);
assert.equal(records["startupstash.com::JevPlay"], undefined, "alias expansion must not mutate persisted records");

const tipRecord = { ...pathRecord, destinationKey: "tipseason.com/ai-tools/submit-free" };
const tipAliases = context.expandSubmissionRecordsForQueue(
  { "tipseason.com/ai-tools/submit-free::JevPlay": tipRecord },
  ["https://www.tipseason.com/ai-tools/submit"],
);
assert.equal(tipAliases["tipseason.com/ai-tools/submit::JevPlay"], tipRecord);

assert.match(background, /if \(sidePanelOpen\) \{[\s\S]*chrome\.tabs\.query\(\{ active: true, lastFocusedWindow: true \}\)/,
  "side-panel auto-fill must be restricted to the active tab");
assert.match(background, /const currentTab = await chrome\.tabs\.get\(tabId\);[\s\S]*if \(currentTab\.url !== tabUrl\) return/,
  "debounced auto-fill must recheck the exact tab URL before writing");
assert.match(background, /if \(preferredTabId !== undefined && preferredTabId !== null\)[\s\S]*return null;/,
  "a stale explicit tab id must fail closed instead of falling back to another tab");

console.log("StartupStash alias and tab isolation tests passed");

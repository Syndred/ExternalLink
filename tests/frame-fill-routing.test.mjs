import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("extension/background.js", "utf8");
const routeStart = source.indexOf("async function sendTabMessage(");
const routeEnd = source.indexOf("async function getFillableFrameIds(", routeStart);
assert.ok(routeStart >= 0 && routeEnd > routeStart);
const topFrameCalls = [];
let frameDetections = {
  0: { operable: true, platform: "directory", formFieldCount: 25, submitBlocker: { blocked: true, reason: "listing fee" } },
  2: { operable: false, platform: "unknown", formFieldCount: 0 },
};
const routeContext = {
  ensureContentScript: async () => {},
  getSubmissionWatchFrameIds: async () => ({ frameIds: [0, 2] }),
  chrome: {
    tabs: {
      sendMessage: async (_tabId, message, options) => {
        topFrameCalls.push({ action: message.action, frameId: options?.frameId });
        return message.action === "detectPage"
          ? frameDetections[options?.frameId]
          : { ok: true };
      },
    },
  },
};
vm.createContext(routeContext);
vm.runInContext(source.slice(routeStart, routeEnd), routeContext);
let detected = await routeContext.sendTabMessage(42, { action: "detectPage" });
assert.equal(detected.frameId, 0);
assert.equal(detected.formFieldCount, 25);
assert.equal(detected.submitBlocker.blocked, true,
  "a zero-field Stripe/payment iframe must not hide the main form or its fee");
frameDetections = {
  0: { operable: false, platform: "unknown", formFieldCount: 0 },
  2: { operable: true, platform: "directory", formFieldCount: 5 },
};
detected = await routeContext.sendTabMessage(42, { action: "detectPage" });
assert.equal(detected.frameId, 2);
assert.equal(detected.formFieldCount, 5,
  "a real embedded submission form must remain detectable");
assert.deepEqual(topFrameCalls.filter(({ action }) => action === "detectPage").map(({ frameId }) => frameId),
  [0, 2, 0, 2]);

const start = source.indexOf("async function getFillableFrameIds(");
const end = source.indexOf("async function refreshContentScriptsForManualWatch(", start);
assert.ok(start >= 0 && end > start);

const messages = [];
const context = {
  Promise,
  Number,
  Set,
  ensureContentScript: async () => {},
  chrome: {
    webNavigation: {
      getAllFrames: async () => [{ frameId: 0 }, { frameId: 2 }],
    },
    tabs: {
      sendMessage: async (_tabId, message, options = {}) => {
        messages.push({ message, frameId: options.frameId });
        if (message.action === "countEmptyFields") {
          return options.frameId === 2
            ? { emptyCount: 1, invalidCount: 0, totalCount: 2, allValid: false }
            : { emptyCount: 0, invalidCount: 0, totalCount: 0, allValid: true };
        }
        if (message.action === "smartFill") {
          return { ok: true, filledCount: 2, inferredFields: ["First name"] };
        }
        return { validationFailed: false };
      },
    },
  },
};
vm.createContext(context);
vm.runInContext(source.slice(start, end), context);

const result = await context.smartFillAcrossFrames(42, { projectKey: "JevPlay" });
assert.equal(result.ok, true);
assert.equal(result.filledCount, 2);
assert.deepEqual([...result.inferredFields], ["First name"]);
const smartFrames = messages
  .filter(({ message }) => message.action === "smartFill")
  .map(({ frameId }) => frameId);
assert.deepEqual(smartFrames, [2], "a zero-field top frame must not make the iframe look complete");
const zeroField = context.mergeFrameFillResults([
  { response: { totalCount: 0, emptyCount: 0, invalidCount: 0, allValid: true } },
]);
assert.equal(zeroField.validationFailed, true, "a zero-field response must not claim a usable form is complete");
assert.equal(zeroField.emptyCount, 1);

context.chrome.tabs.sendMessage = async () => undefined;
const unavailable = await context.countEmptyFieldsAcrossFrames(42);
assert.equal(unavailable.validationFailed, true, "missing frame responses must fail closed");
assert.equal(unavailable.emptyCount, 1, "missing frame responses must not claim an empty form is complete");

console.log("cross-frame fill routing tests passed");

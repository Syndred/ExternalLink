import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync("extension/content.js", "utf8");
const start = source.indexOf("  function clearStaleProfileListingForm(");
const end = source.indexOf("  async function smartFillFromConfig(", start);
assert.ok(start > 0 && end > start);
const clear = new Function(
  "getElementFillValue", "resolveValueForField", "getSnapshotLabel", "setFieldValue", "logStep", "Event",
  `${source.slice(start, end)}; return clearStaleProfileListingForm;`,
)(
  (field) => field.value,
  (config, field) => field.label === "Link" ? config.targetDomain : field.label === "Tool Name" ? config.brandName : "",
  (field) => field.label,
  (field, value) => { field.value = value; },
  () => {},
  Event,
);

function field(form, label, value, tagName = "INPUT", type = "text") {
  return { form, label, value, tagName, type,
    closest: () => form, dispatchEvent: () => {} };
}

const form = {};
const oldLink = field(form, "Link", "https://jevplay.com/games");
const oldMessage = field(form, "Message", "JevPlay description", "TEXTAREA", "textarea");
const oldTag = field(form, "Tag", "AI games");
const unrelated = field({}, "Email", "person@example.com", "INPUT", "email");
assert.equal(clear([oldLink, oldMessage, oldTag, unrelated], { targetDomain: "https://oldphotoliveai.com" }), 3);
assert.deepEqual([oldLink.value, oldMessage.value, oldTag.value, unrelated.value], ["", "", "", "person@example.com"]);

const sameLink = field(form, "Link", "https://oldphotoliveai.com/");
const sameMessage = field(form, "Message", "User edited content", "TEXTAREA", "textarea");
assert.equal(clear([sameLink, sameMessage], { targetDomain: "https://oldphotoliveai.com" }), 0);
assert.equal(sameMessage.value, "User edited content");

const draftForm = {};
const currentLink = field(draftForm, "Link", "https://graffitinameai.com");
const previousName = field(draftForm, "Tool Name", "OldPhotoLive AI");
const previousDescription = field(draftForm, "Description", "OldPhotoLive AI restores photos", "TEXTAREA", "textarea");
assert.equal(clear([currentLink, previousName, previousDescription], {
  targetDomain: "https://graffitinameai.com", brandName: "Graffiti Name AI",
}), 3, "a site-restored draft with the new URL but old product name must be cleared");
assert.deepEqual([currentLink.value, previousName.value, previousDescription.value], ["", "", ""]);

const routing = source.slice(source.indexOf("  function resolveValueForField("), source.indexOf("  async function fillSelectField("));
assert.ok(routing.indexOf('tag === "textarea"') < routing.indexOf("const learnedKey"));
assert.doesNotMatch(routing, /if \(learned\.value\)/);
assert.match(source.slice(source.indexOf("  function collectFillLearnings("), source.indexOf("  function isFillableField(")), /if \(!profileKey\) continue/);
console.log("profile switch stale form and learned value regressions passed");

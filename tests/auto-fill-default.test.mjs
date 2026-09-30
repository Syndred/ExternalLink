import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync("extension/background.js", "utf8");
const settings = readFileSync("extension/settings.js", "utf8");
const settingsHtml = readFileSync("extension/settings.html", "utf8");

const helperStart = background.indexOf("function isAutoFillOnVisitEnabled(value) {");
const helperEnd = background.indexOf("\n}", helperStart) + 2;
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const context = {};
vm.createContext(context);
vm.runInContext(background.slice(helperStart, helperEnd), context);

assert.equal(context.isAutoFillOnVisitEnabled(undefined), false, "fresh installs must not auto-fill by default");
assert.equal(context.isAutoFillOnVisitEnabled(false), false, "an explicit opt-out must stay disabled");
assert.equal(context.isAutoFillOnVisitEnabled(true), true, "an explicit opt-in must remain enabled");
assert.match(background, /if \(!isAutoFillOnVisitEnabled\(storage\.autoFillOnVisit\)\) return;/);
assert.match(settings, /\$\("autoFillOnVisit"\)\.checked = items\.autoFillOnVisit === true;/);

const checkboxStart = settingsHtml.indexOf('id="autoFillOnVisit"');
assert.ok(checkboxStart >= 0);
const inputStart = settingsHtml.lastIndexOf("<input", checkboxStart);
const checkboxEnd = settingsHtml.indexOf(">", checkboxStart) + 1;
assert.ok(inputStart >= 0 && checkboxEnd > checkboxStart);
assert.doesNotMatch(settingsHtml.slice(inputStart, checkboxEnd), /\bchecked\b/);

console.log("auto-fill default opt-in regressions passed");

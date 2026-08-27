import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync("extension/background.js", "utf8");
const helper = source.match(/function detectLinkRel\(html, targetHost\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(helper, "link rel detector should exist");
const sandbox = {};
runInNewContext(`${helper}\nresult = detectLinkRel('<a href="https://example.com/x" rel="ugc nofollow">x</a>', 'example.com');`, sandbox);
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), { found: true, rel: "nofollow" });
runInNewContext("result = detectLinkRel('<a href=\"https://example.com/x\">x</a>', 'example.com');", sandbox);
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), { found: true, rel: "dofollow" });
runInNewContext("result = detectLinkRel('<p>nothing</p>', 'example.com');", sandbox);
assert.deepEqual(JSON.parse(JSON.stringify(sandbox.result)), { found: false, rel: "" });

console.log("link monitor tests passed");

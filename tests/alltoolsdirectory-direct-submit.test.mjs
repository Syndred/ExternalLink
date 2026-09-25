import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync("extension/background.js", "utf8");
const directStart = source.indexOf("async function trySiteSpecificDirectSubmit(");
const directEnd = source.indexOf("function markTaskFilled(", directStart);
const shortStart = source.indexOf("function shortText(");
const shortEnd = source.indexOf("function handleTerminalJudge(", shortStart);
assert.ok(directStart >= 0 && directEnd > directStart, "AllToolsDirectory direct-submit helpers should exist");
assert.ok(shortStart >= 0 && shortEnd > shortStart, "shortText helper should exist");

const context = { URL };
vm.createContext(context);
vm.runInContext(`${shortTextSource()}\n${source.slice(directStart, directEnd)}`, context);

assert.equal(context.isAllToolsDirectorySubmitUrl("https://www.alltoolsdirectory.com/submit"), true);
assert.equal(context.isAllToolsDirectorySubmitUrl("https://alltoolsdirectory.com/submit/"), true);
assert.equal(context.isAllToolsDirectorySubmitUrl("https://example.com/submit"), false);

const jevPayload = context.buildAllToolsDirectoryPayload({
  brandName: "JevPlay",
  targetDomain: "https://jevplay.com",
  email: "syndredyoung@gmail.com",
  username: "Syndred Young",
  pricing: "Free to play; no paid plan or checkout.",
  tags: "AI games, decision games, human vs AI",
  screenshots: [
    "https://jevplay.com/og-default.png",
    "https://jevplay.com/imgs/generated/jevplay-dungeon-card-v2.png",
  ],
  projectFields: {
    Name: "JevPlay",
    Url: "https://jevplay.com",
    "Short description(20-30 words)": "Play free daily decision games against TypeSafe Jev.",
    "Feature description": "Code Breaker, Word Ladder, Dungeon Crawler, and Snake Challenge.",
    "Featured image": "https://jevplay.com/og-default.png",
    Pricing: "Free to play; no paid plan or checkout.",
    "Business mail": "syndredyoung@gmail.com",
  },
});

assert.equal(jevPayload.toolName, "JevPlay");
assert.equal(jevPayload.websiteUrl, "https://jevplay.com");
assert.equal(jevPayload.githubUrl, "https://jevplay.com", "homepage is used only for this site's no-repo fallback");
assert.equal(jevPayload.category, "AI & ML");
assert.equal(jevPayload.pricingModel, "Free");
assert.match(jevPayload.screenshots, /og-default\.png/);
assert.equal(jevPayload.agreeToTerms, false);

const graffitiPayload = context.buildAllToolsDirectoryPayload({
  brandName: "Graffiti Name AI",
  targetDomain: "https://graffitinameai.com",
  email: "support@graffitinameai.com",
  pricing: "Public browsing is free; paid credits start at $4.99.",
  tags: "graffiti name generator, AI graffiti generator, PNG artwork",
  projectFields: {
    Name: "Graffiti Name AI",
    "Short description(20-30 words)": "Online graffiti name generator for tag ideas and downloadable PNG name art.",
    "Business mail": "support@graffitinameai.com",
  },
});

assert.equal(graffitiPayload.category, "Design Tool");
assert.equal(graffitiPayload.pricingModel, "Freemium");
assert.equal(graffitiPayload.email, "support@graffitinameai.com");

assert.doesNotMatch(
  source.slice(directStart, directEnd),
  /["'](?:Origin|Referer)["']\s*:/,
  "extension fetch should not try to set browser-forbidden request headers",
);

console.log("AllToolsDirectory direct-submit tests passed");

function shortTextSource() {
  return source.slice(shortStart, shortEnd);
}

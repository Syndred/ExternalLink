import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");

function loadProductHuntHooks() {
  const runtime = {
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage() {
      return Promise.resolve({ ok: true });
    },
  };
  const document = {
    body: { innerText: "", textContent: "" },
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };
  const context = {
    console,
    Promise,
    Set,
    Map,
    URL,
    URLSearchParams,
    Date,
    Math,
    JSON,
    String,
    Number,
    Boolean,
    RegExp,
    Array,
    Object,
    Error,
    TypeError,
    InputEvent: class InputEvent {},
    Event: class Event {},
    FocusEvent: class FocusEvent {},
    KeyboardEvent: class KeyboardEvent {},
    document,
    location: { hostname: "www.producthunt.com", href: "https://www.producthunt.com/posts/new" },
    chrome: { runtime },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  context.window = context;
  context.self = context;
  context.__extLinkBootstrapped = true;
  vm.createContext(context);
  vm.runInContext(content, context, { filename: "extension/content.js" });
  return context.__extLinkProductHuntTestHooks;
}

const hooks = loadProductHuntHooks();
assert.ok(hooks, "content.js should expose the Product Hunt safety test surface");
assert.deepEqual([...hooks.stages], [
  "entry",
  "main_info",
  "images",
  "makers",
  "shoutouts",
  "extras",
  "investors",
  "checklist",
]);

const stage = (fields, buttons = [], text = "") => hooks.detectStage({
  title: "Product Hunt",
  text,
  fields,
  buttons,
});

assert.equal(
  stage([
    { name: "name", type: "text", label: "Product name" },
    { name: "tagline", type: "text", label: "Tagline" },
    { name: "topics", type: "text", label: "Topics" },
    { name: "commentBody", type: "textarea", label: "Comment" },
  ]),
  "main_info",
);
assert.equal(
  stage([
    { id: "file-input-thumbnailImageUuid", type: "file", label: "Thumbnail" },
    { id: "file-input-media", type: "file", label: "Gallery" },
  ], [
    { text: "Next step: Makers" },
  ]),
  "images",
);
assert.equal(
  stage([{ name: "isMaker", type: "checkbox", label: "I am a maker" }], [
    { text: "Next step: Shoutouts" },
  ]),
  "makers",
);
assert.equal(stage([], [{ text: "Next step: Extras" }]), "shoutouts");
assert.equal(stage([{ name: "pricingType", type: "select", label: "Pricing" }]), "extras");
assert.equal(
  stage([{ name: "investorInfo", type: "textarea", label: "Investors" }], [
    { text: "Next step: Launch checklist" },
  ]),
  "investors",
);
assert.equal(
  stage([], [{ text: "Create draft" }], "Launch checklist 100% Complete"),
  "checklist",
);
assert.equal(
  stage([], [{ text: "Launch In Progress" }], "OldPhotoLive AI In progress"),
  "entry",
  "the product detail bridge must remain part of the automated entry stage",
);
assert.equal(
  stage([{ name: "name", type: "text", label: "Product name" }], [
    { text: "Main info" },
    { text: "Images" },
    { text: "Makers" },
    { text: "Shoutouts" },
    { text: "Extras" },
    { text: "Investors" },
    { text: "Launch checklist" },
  ]),
  "main_info",
  "the stepper's full list must not force every page to checklist",
);

assert.equal(hooks.buttonPolicy("Create draft", "create"), true);
assert.equal(hooks.buttonPolicy("Schedule launch", "create"), false);
assert.equal(hooks.buttonPolicy("Create draft and schedule launch", "create"), false);
assert.equal(hooks.buttonPolicy("Promote", "create"), false);
assert.equal(hooks.buttonPolicy("Next step: Shoutouts", "advance"), true);
assert.equal(hooks.buttonPolicy("Next step: Schedule launch", "advance"), false);
assert.equal(hooks.buttonPolicy("Next", "advance"), true);
assert.equal(hooks.buttonPolicy("Skip for now", "skip"), true);
assert.equal(hooks.shouldClickCreateDraft(false, true, "Create draft"), false);
assert.equal(hooks.shouldClickCreateDraft(true, false, "Create draft"), false);
assert.equal(hooks.shouldClickCreateDraft(true, true, "Schedule launch"), false);
assert.equal(hooks.shouldClickCreateDraft(true, true, "Create draft"), true);
assert.equal(hooks.pricingValue("Freemium with pay-as-you-go credits"), "free_options");
assert.equal(hooks.pricingValue("Completely free"), "free");
assert.equal(hooks.pricingValue("Paid only"), "payment_required");

assert.equal(hooks.detectGate({ text: "Please log in to continue" }), "login");
assert.equal(
  hooks.detectGate({ fields: [{ name: "verificationCode", type: "text", label: "Verification code" }] }),
  "otp",
);
assert.equal(hooks.detectGate({ text: "Cloudflare Turnstile verify you are human" }), "captcha");
assert.equal(hooks.detectGate({ text: "Promote this launch — payment required" }), "pay");
assert.equal(
  hooks.detectGate({ fields: [{ type: "checkbox", label: "I agree to the terms", checked: false }] }),
  "legal",
);

assert.match(content, /msg\.action === ["']runProductHuntStep["']/);
assert.match(content, /async function\s+runProductHuntStep\s*\(/);
assert.match(content, /confirmCreate === true/);
assert.match(content, /clickedCreateDraft: true/);
assert.match(content, /submittedAttempt: true/);
assert.match(content, /productHuntButtonPolicy\(label, "create"\)/);
assert.match(content, /productHuntMediaInputs[\s\S]*input\[type="file"\]/);
assert.match(content, /previewVerified/);
assert.match(
  content,
  /productHuntSelectExact[\s\S]*?simulateTyping\(control, value\)[\s\S]*?productHuntOptionElements/,
  "plain Product Hunt topic inputs must type the exact topic before selecting a suggestion",
);

console.log("Product Hunt stage, gate, media, and final-action safety tests passed");

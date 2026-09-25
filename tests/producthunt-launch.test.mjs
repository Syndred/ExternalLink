import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");
const background = readFileSync(resolve(root, "extension/background.js"), "utf8");
const sidepanel = readFileSync(resolve(root, "extension/sidepanel.js"), "utf8");

function loadProductHuntHooks() {
  const runtime = {
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage() {
      return Promise.resolve({ ok: true });
    },
  };
  const document = {
    addEventListener() {},
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
assert.equal(
  hooks.fieldSnapshotChecked({ checked: false, value: "on" }),
  false,
  "an unchecked radio/checkbox value=on must not be treated as selected",
);
assert.equal(hooks.fieldSnapshotChecked({ checked: true, value: "on" }), true);
assert.deepEqual(
  [...hooks.requiredUncheckedFromSnapshot([
    { name: "acceptTerms", label: "Accept terms", type: "checkbox", required: true, checked: false, value: "on", hidden: true },
  ])],
  ["accept terms acceptterms"],
  "hidden required legal controls must block the final Product Hunt action",
);
assert.deepEqual([...hooks.stages], [
  "entry",
  "main_info",
  "images",
  "makers",
  "company_info",
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
assert.equal(
  stage([{ name: "isMaker", type: "checkbox", label: "I am a maker" }], [
    { text: "Next step: Company info" },
  ]),
  "makers",
  "the live Makers action may use the Company info label",
);
assert.equal(
  stage([
    { name: "bootstrapped", type: "checkbox", label: "Bootstrapped Have not raised VC funding", hidden: true },
    { name: "teamSize", type: "text", label: "Team size" },
    { name: "crunchbaseUrl", type: "text", label: "Crunchbase URL" },
  ], [{ text: "Next step: Shoutouts" }]),
  "company_info",
  "Company info must win over the next-step label for the following Shoutouts page",
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
assert.equal(hooks.buttonPolicy("Next step: Company info", "advance"), true);
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
assert.equal(
  hooks.makerIdentityMatches(
    { dataTest: "maker-syndred", text: "Syndred @syndred" },
    "@syndred",
  ),
  true,
  "a live Product Hunt maker data-test chip must confirm the configured handle",
);
assert.equal(
  hooks.makerIdentityMatches(
    { dataTest: "maker-support@oldphotoliveai.com", text: "support@oldphotoliveai.com Pending" },
    "@syndred",
  ),
  false,
  "a pending email maker chip must not confirm a different configured handle",
);

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

// P0/P1 regression contracts from the live Product Hunt review.
const productHuntLoop = background.match(/async function\s+runProductHuntLaunchLoop[\s\S]*?\n}\n\nfunction\s+looksReadyForManualResume/)?.[0] || "";
const submittedBranch = productHuntLoop.indexOf("result.submittedAttempt");
const readyBranch = productHuntLoop.indexOf("result.ready_to_create");
assert.ok(submittedBranch >= 0 && readyBranch >= 0 && submittedBranch < readyBranch,
  "a submitted attempt with fresh evidence must be completed before ready_to_create is parked");
assert.match(
  productHuntLoop,
  /if\s*\(result\.waiting[\s\S]*?retryAfterMs[\s\S]*?await sleep\([\s\S]*?continue;/,
  "Product Hunt waiting results must sleep and retry inside the launch loop instead of becoming manual",
);
assert.match(
  background,
  /function\s+productHuntGateStatus[\s\S]*?result\.gate\s*===\s*["']captcha["'][\s\S]*?needs_captcha/,
  "Product Hunt gate=captcha must map to the recoverable captcha task state",
);
assert.match(
  background,
  /async function\s+resumeAfterCaptcha[\s\S]*?isCustomLaunchTask\(task\)[\s\S]*?runProductHuntLaunchLoop/,
  "captcha recovery on Product Hunt must return to the dedicated launch loop",
);
const sidepanelFill = background.match(
  /async function\s+handleSidepanelFill[\s\S]*?\n}\n\nasync function\s+persistFillLearnings/,
)?.[0] || "";
const productHuntSidepanelBranch = sidepanelFill.indexOf("isCustomLaunchUrl");
const genericFillBranch = sidepanelFill.indexOf("fillFormUntilReady");
assert.ok(
  productHuntSidepanelBranch >= 0 &&
    genericFillBranch >= 0 &&
    productHuntSidepanelBranch < genericFillBranch,
  "single-site Product Hunt runs must enter the dedicated adapter before generic AI validation",
);
assert.match(
  sidepanelFill,
  /isCustomLaunchUrl[\s\S]*?runProductHuntSidepanelWithVisualFallback/,
  "the Product Hunt sidepanel path must use the multi-stage loop plus general visual fallback without generic form validation",
);
assert.match(
  background,
  /async function\s+runProductHuntSidepanelLoop[\s\S]*?runProductHuntStep[\s\S]*?retryAfterMs[\s\S]*?continue;/,
  "single-site Product Hunt runs must retry loading states inside the dedicated adapter",
);
assert.match(
  background,
  /runProductHuntSidepanelLoop[\s\S]*?stableWaitingRetries[\s\S]*?shouldHandOffStableProductHuntStep[\s\S]*?visualEscalation/,
  "a loaded Product Hunt pane with stable missing prerequisites must escalate to visual supervision instead of using the loading budget",
);
assert.match(
  productHuntLoop,
  /stableWaitingRetries[\s\S]*?shouldHandOffStableProductHuntStep[\s\S]*?handOffToVisualAgent[\s\S]*?visualFillOnly:\s*true/,
  "batch Product Hunt runs must hand stable custom controls to visual supervision in fill-only mode",
);
assert.match(
  background,
  /function\s+productHuntVisualFillReachedFinalConfirmation[\s\S]*?hasVisibleProductHuntCreateDraft[\s\S]*?parkProductHuntReadyToCreate/,
  "a visual Product Hunt pass must preserve the existing final Create draft confirmation",
);
assert.match(
  sidepanel,
  /productHuntReadyToCreateTabId[\s\S]*?确认创建 Product Hunt 草稿[\s\S]*?confirmProductHuntCreate/,
  "the single-site side panel must expose the same explicit Create draft action",
);
assert.match(
  content,
  /productHuntHasExistingMaker[\s\S]*?\[data-test\^=["']maker-[\s\S]*?productHuntSelectionConfirmed/,
  "an already-selected Product Hunt maker chip must count as selected",
);
assert.match(
  content,
  /pf\["Product Hunt First Comment"\][\s\S]*?config\.firstComment/,
  "Product Hunt-specific first-comment copy must win over the generic comment template",
);
const handleFillResult = sidepanel.match(
  /async function\s+handleFillResult[\s\S]*?\n  }\n\n  async function\s+refreshSiteAnnotation/,
)?.[0] || "";
assert.ok(
  handleFillResult.indexOf('result?.platform === "product_hunt"') >= 0 &&
    handleFillResult.indexOf('result?.platform === "product_hunt"') <
      handleFillResult.indexOf("result?.needs_manual"),
  "Product Hunt manual-stage results must render their stage before the generic manual branch",
);
assert.match(
  sidepanel,
  /async function\s+fillPage\(mode(?:,\s*options\s*=\s*\{\})?\)[\s\S]*?await refreshActiveTab\(\)/,
  "single-site actions must resolve the real active tab again at click time",
);
assert.match(
  content,
  /productHuntFormSnapshot[\s\S]*?(?:hidden|RawControls|input\[name=[^\n]*(?:isMaker|soloMaker|pricingType|legal|terms|consent))/i,
  "stage snapshots must include hidden Product Hunt state controls",
);
assert.match(
  content,
  /fillProductHuntMaker[\s\S]*?input\[type=["']radio["']\][\s\S]*?worked on this product/i,
  "Makers must survive renamed radio fields by matching the visible choice semantics",
);
assert.match(background, /dispatchTrustedTabClick[\s\S]*?Input\.dispatchMouseEvent/,
  "a Product Hunt transition rejected by DOM click must escalate to a trusted browser click");
assert.match(background, /stageCompleted[\s\S]*?stageAdvanced\s*===\s*false[\s\S]*?advancePoint/,
  "trusted clicking must only run after a verified DOM transition failure");
assert.match(background, /confirmCreate\s*===\s*true[\s\S]*?createPoint[\s\S]*?dispatchTrustedTabClick/,
  "an explicitly confirmed Create draft action may use the same trusted-click fallback");
assert.match(
  background,
  /runProductHuntSidepanelLoop[\s\S]*?options\.confirmCreate\s*===\s*true[\s\S]*?result\.createPoint[\s\S]*?dispatchTrustedTabClick[\s\S]*?followup\?\.matched\s*&&\s*followup\?\.evidence/,
  "the side-panel Create draft action must also use a trusted click and read back a receipt",
);
assert.match(
  content,
  /connect with investors[\s\S]*?return ["']extras["']/i,
  "Connect with Investors is the Extras step boundary, not an unknown stage",
);
assert.match(
  content,
  /stage === ["']company_info["'][\s\S]*?fillProductHuntCompanyInfo/,
  "Company info must have a dedicated adapter step instead of reusing Makers",
);
assert.doesNotMatch(
  content,
  /const identity = input\.id \|\| input\.name \|\| input;/,
  "duplicate Product Hunt file IDs must not drop real inputs during media discovery",
);
assert.match(
  content,
  /productHuntMediaInputs[\s\S]*?seen\.has\(input\)[\s\S]*?seen\.add\(input\)/,
  "media inputs should deduplicate DOM nodes by object identity, not duplicate ids",
);
assert.match(
  content,
  /selectedAfter[\s\S]*?missing\.push\(value\)|productHuntSelectionConfirmed/,
  "maker/topic selection must be verified after the option/chip is actually selected",
);
assert.match(
  content,
  /const baseline = productHuntResultBaseline\(config\)[\s\S]*?createButton\.click\(\)[\s\S]*?waitForProductHuntResult\(/,
  "Product Hunt result polling must start from a baseline captured immediately before the click",
);
assert.match(
  content,
  /const beforeEvidence = normalizeProductHuntText\(baseline\.evidence \|\| ""\)[\s\S]*?const newEvidence = [\s\S]*?beforeEvidence[\s\S]*?const publicChanged = [\s\S]*?baseline\.publicUrl/,
  "Product Hunt receipt evidence must be new relative to the pre-click baseline",
);
assert.match(content, /productHuntReceipt[\s\S]*?this product is a draft/i,
  "a Product Hunt draft success page must expose a recoverable receipt");
assert.match(
  content,
  /function\s+productHuntVisibleText[\s\S]*requested\s*===\s*document\s*\?\s*document\.body/,
  "Product Hunt receipt detection must read document.body because Document.textContent is null",
);
assert.match(background, /success_page_recovery[\s\S]*?recordSubmittedProject/,
  "detecting a matching Product Hunt draft page must recover the ledger record");
assert.match(
  background,
  /ensureProfilesFromTable[\s\S]*Object\.values\(seeded\.profiles\s*\|\|\s*\{\}\)\.find\(matchesReceipt\)/,
  "success-page recovery should find the matching profile even when another profile is active",
);
assert.match(
  background,
  /function\s+siteKeyForUrl\s*\([^)]*\)\s*\{[\s\S]*normalizeDestinationKey/,
  "host-scoped launch and receipt URLs must share one ledger destination key",
);
assert.match(background, /productHuntReceipt[\s\S]*?confirmedBy:\s*"manual"/,
  "success-page recovery must not pretend the extension observed the submit action");
assert.match(sidepanel, /submissionRecovered[\s\S]*?loadSidepanelTimeline/,
  "success-page recovery must immediately refresh the visible ledger timeline");

console.log("Product Hunt stage, gate, media, and final-action safety tests passed");

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");

function loadHooks() {
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
    location: { hostname: "directory.example", href: "https://directory.example/submit" },
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
  return {
    payment: context.__extLinkPaymentTestHooks,
    fields: context.__extLinkFieldMappingTestHooks,
  };
}

const hooks = loadHooks();
assert.ok(hooks.payment, "content.js should expose the payment-context test surface");
assert.ok(hooks.fields, "content.js should expose the shared-field test surface");

const classify = hooks.payment.classifyPaymentContext;

assert.equal(
  classify({
    label: "Paid",
    fieldset: "How is your product priced?",
    options: "Free Freemium Paid",
    local: "Pricing type",
    choiceControl: true,
  }).classification,
  "product_pricing",
  "a Paid product-pricing option must not be treated as a checkout action",
);

assert.equal(
  classify({
    label: "Does your website require payment?",
    fieldset: "About your website",
    options: "Yes No",
    local: "Does your website require payment?",
    choiceControl: true,
  }).classification,
  "product_pricing",
  "a product billing question must remain a form choice",
);

assert.equal(
  classify({
    label: "Paid",
    local: "Pricing type",
    options: "Free Paid",
    pageText: "This directory has paid premium placement",
    choiceControl: true,
  }).classification,
  "product_pricing",
  "page-wide Paid text must not override the local pricing field",
);

for (const input of [
  { label: "Pay now", local: "Submit listing" },
  { label: "Checkout", local: "Checkout to continue" },
  { label: "Card number", local: "Billing details" },
  { label: "Place subscription order", local: "Subscription plan" },
  { label: "Submit", local: "Pay to submit this listing" },
]) {
  assert.equal(
    classify(input).classification,
    "confirmed_payment",
    `real payment action should stay blocked: ${input.label}`,
  );
}

const uncertain = classify({
  label: "Payment",
  fieldset: "Additional information",
  options: "",
  local: "Payment details",
});
assert.equal(uncertain.classification, "uncertain_payment");
assert.equal(uncertain.uncertain, true);
assert.ok(uncertain.evidence.local.includes("payment details"));

assert.equal(
  classify({
    label: "Subscription plan",
    local: "Choose a pricing plan",
    options: "Monthly Annual",
    choiceControl: true,
  }).classification,
  "product_pricing",
  "choosing a product subscription plan is not itself an order",
);

const matches = hooks.fields.sharedLearnedMappingMatches;
const resolveShared = hooks.fields.resolveSharedLearnedProfileValue;
assert.equal(
  matches(
    { shared: true, profileKey: "Name", label: "Product name", hint: "Name of your product" },
    { label: "Product name", hint: "Name of your product" },
  ),
  true,
  "shared mappings should match the current field semantics",
);
assert.equal(
  matches(
    { shared: true, profileKey: "Name", label: "Product name", hint: "Name of your product" },
    { label: "Pricing", hint: "How is your product priced" },
  ),
  false,
  "changed form semantics must invalidate a shared mapping",
);
assert.equal(
  matches({ shared: true, profileKey: "Name" }, { label: "Product name", hint: "Name" }),
  false,
  "a shared mapping without its semantic fingerprint must not replay",
);
assert.equal(
  matches({ shared: false, value: "legacy value" }, { label: "Changed field", hint: "Changed" }),
  true,
  "legacy non-shared mappings retain their existing compatibility path",
);
assert.equal(
  resolveShared(
    {
      shared: true,
      profileKey: "Name",
      value: "another-project-answer",
      label: "Product name",
      hint: "Name of your product",
    },
    { label: "Product name", hint: "Name of your product" },
    { Name: "current-profile-answer" },
  ),
  "current-profile-answer",
  "shared mappings must resolve only through the current profile field",
);
assert.equal(
  resolveShared(
    {
      shared: true,
      profileKey: "Name",
      value: "another-project-answer",
      label: "Product name",
      hint: "Name of your product",
    },
    { label: "Pricing", hint: "How is your product priced" },
    { Name: "current-profile-answer" },
  ),
  "",
  "a changed field must not consume a shared mapping or its stale value",
);

console.log("pricing context and shared field mapping tests passed");

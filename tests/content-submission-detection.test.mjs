import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "extension/content.js"), "utf8");
const forms = [];

class FakeField {
  constructor({
    type = "text",
    tagName = "input",
    name = "",
    id = "",
    placeholder = "",
    ariaLabel = "",
    minLength = 0,
    maxLength = 0,
    required = false,
  } = {}) {
    this.type = type;
    this.tagName = tagName.toUpperCase();
    this.name = name;
    this.id = id;
    this.placeholder = placeholder;
    this.ariaLabel = ariaLabel;
    this.minLength = minLength;
    this.maxLength = maxLength;
    this.required = required;
    this.value = "";
    this.disabled = false;
    this.readOnly = false;
    this.form = null;
    this.parentElement = null;
  }

  getAttribute(name) {
    return ({
      name: this.name,
      id: this.id,
      type: this.type,
      placeholder: this.placeholder,
      "aria-label": this.ariaLabel,
    })[name] || "";
  }

  closest(selector) {
    return selector === "form" ? this.form : null;
  }

  getBoundingClientRect() {
    return { width: 160, height: 32 };
  }
}

class FakeForm {
  constructor({ action = "", id = "", name = "", text = "", fields = [] } = {}) {
    this.id = id;
    this.className = "";
    this.action = action;
    this.name = name;
    this.innerText = text;
    this.textContent = text;
    this.fields = fields;
    for (const field of fields) field.form = this;
  }

  getAttribute(name) {
    return ({ action: this.action, name: this.name, id: this.id })[name] || "";
  }

  matches(selector) {
    return selector === "form";
  }

  contains(element) {
    return this.fields.includes(element);
  }

  querySelector(selector) {
    return this.fields.find((field) => {
      const type = String(field.type || "").toLowerCase();
      const hint = `${field.name || ""} ${field.id || ""} ${field.placeholder || ""}`.toLowerCase();
      if (field.tagName === "INPUT") {
        return (
          (type === "url" && selector.includes('input[type="url"]')) ||
          (/url|website|link|product|title/.test(hint) && /url|website|link|product|title/.test(selector))
        );
      }
      if (field.tagName === "TEXTAREA") {
        return (
          (/description|summary/.test(hint) && /description|summary/.test(selector)) ||
          (/message/.test(hint) && /message/.test(selector))
        );
      }
      return false;
    }) || null;
  }

  querySelectorAll(selector) {
    if (/^button\b|^input\[type=['"]submit/.test(selector)) return [];
    return this.fields;
  }

  getBoundingClientRect() {
    return { width: 600, height: 300 };
  }
}

const document = {
  title: "",
  body: { innerText: "", textContent: "" },
  addEventListener() {},
  querySelector(selector) {
    const fields = forms.flatMap((form) => form.fields);
    if (selector.startsWith('form[action*="submit"]')) {
      return forms.find((form) => form.action.includes("submit") || form.action.includes("add")) || null;
    }
    return fields.find((field) => {
      const hasExactName = field.name && selector.includes(`input[name="${field.name}"]`);
      return hasExactName || (field.type === "url" && selector.includes('input[type="url"]'));
    }) || null;
  },
  querySelectorAll(selector) {
    if (selector === "form") return forms;
    if (/input|textarea|select|contenteditable/.test(selector)) return forms.flatMap((form) => form.fields);
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
  location: { hostname: "futuretools.io", href: "https://futuretools.io/", referrer: "" },
  chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} }, sendMessage: async () => ({ ok: true }) } },
  getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};
context.window = context;
context.self = context;
context.__extLinkBootstrapped = true;
vm.createContext(context);
vm.runInContext(readFileSync("extension/lib/playbooks.js", "utf8"), context, { filename: "extension/lib/playbooks.js" });
vm.runInContext(source, context, { filename: "extension/content.js" });

const hooks = context.__extLinkSubmissionTestHooks;
assert.ok(hooks, "content.js should expose submission detection test hooks");
const auditHooks = context.__extLinkContentAuditTestHooks;
assert.equal(auditHooks.detectSubmissionTransportFailure(), "", "ordinary forms have no transport failure");
const transportQuerySelector = document.querySelector;
context.location.hostname = "aitoolclaw.com";
document.querySelector = (selector) => selector === "#submit-error"
  ? { textContent: "Something went wrong. Please try again or email us at submit@aitoolclaw.com." }
  : transportQuerySelector(selector);
assert.match(auditHooks.detectSubmissionTransportFailure(), /Something went wrong/,
  "a visible AI Tool Claw error must stop receipt polling without recording success");
document.querySelector = transportQuerySelector;
context.location.hostname = "futuretools.io";
document.querySelector = (selector) => selector.startsWith(".wpcf7 form.failed")
  ? { querySelector: () => ({ textContent: "There was an error trying to send your message. Please try again later." }) }
  : transportQuerySelector(selector);
assert.match(auditHooks.detectSubmissionTransportFailure(), /error trying to send your message/,
  "a failed Contact Form 7 response must be treated as a site error, not a login or success receipt");
document.querySelector = transportQuerySelector;
context.location.hostname = "www.iatool.online";
context.location.href = "https://www.iatool.online/submit-tool/";
context.performance = {
  getEntriesByType: () => [
    { name: "https://www.iatool.online/api/submit-tool", startTime: 10, responseStatus: 500 },
  ],
};
assert.equal(auditHooks.detectSubmissionTransportFailure(11), "", "old failed requests must not affect a new attempt");
assert.match(auditHooks.detectSubmissionTransportFailure(10), /HTTP 500/, "Come AI API failure must not become a success receipt");
context.location.hostname = "futuretools.io";
context.location.href = "https://futuretools.io/";
delete context.performance;
assert.equal(
  auditHooks.isLegalAcceptanceField(new FakeField({ type: "checkbox", name: "asset_permission", required: true })),
  true,
  "a required permission to reuse product assets must stay with the submitter",
);
assert.equal(
  auditHooks.isLegalAcceptanceField(new FakeField({ type: "checkbox", name: "newsletter_opt_in" })),
  false,
  "an optional newsletter choice is not a legal permission",
);
assert.match(source, /function isHumanDeclarationField\(field\)/,
  "explicit acknowledgement checkboxes need a human declaration gate");
assert.match(source, /options\.some\(isHumanDeclarationField\)/,
  "a matching word in the Profile must not automatically check a declaration");
const fieldHooks = context.__extLinkFieldRoutingTestHooks;
assert.ok(fieldHooks, "content.js should expose field routing test hooks");

const oldPhotoConfig = {
  targetDomain: "https://oldphotoliveai.com",
  brandName: "OldPhotoLive AI",
  username: "Syndred",
  email: "",
  useCases: ["Restore and animate old family photos"],
  projectFields: {
    "Business mail": "support@oldphotoliveai.com",
    "Short description(20-30 words)":
      "OldPhotoLive AI restores, colorizes, and animates old family photos online, turning faded memories into vivid images and short videos.",
    "Extra Link:X/Twitter/YouTube/Instagram/..": "Not specified in the project.",
  },
};
assert.equal(fieldHooks.resolveValueForField(oldPhotoConfig,
  new FakeField({ ariaLabel: "Open-source licenceOptional", placeholder: "Apache-2.0" })), "",
"a proprietary tool must not inherit a made-up open-source licence from its description");
context.location.hostname = "docs.google.com";
context.location.pathname = "/forms/d/e/1FAIpQLSf_NRrGlkrWusy8Anci9eMrOC_aAAiT7LBmm60IFZzZ6TizdQ/viewform";
assert.equal(fieldHooks.resolveValueForField(oldPhotoConfig, new FakeField({ ariaLabel: "Contact person" })), "Syndred");
assert.equal(fieldHooks.resolveValueForField(oldPhotoConfig, new FakeField({ tagName: "textarea", ariaLabel: "Comments or questions?" })), "");
context.location.hostname = "futuretools.io";
context.location.pathname = "/";
assert.match(source, /isAiGenerationGoogleForm\(\)[\s\S]*?direct\.push\([\s\S]*?\[role="button"\]/,
  "the known Google Form must route its role-button Submit through the plugin");
{
  const originalQueryAll = document.querySelectorAll;
  const submitButton = {
    tagName: "DIV", innerText: "提交", textContent: "提交", disabled: false,
    getAttribute(name) { return name === "aria-label" ? "提交" : ""; },
    getBoundingClientRect() { return { width: 100, height: 36 }; },
    closest() { return null; },
  };
  document.querySelectorAll = (selector) => selector === '[role="button"]' ? [submitButton] : [];
  context.location.hostname = "docs.google.com";
  context.location.pathname = "/forms/d/e/1FAIpQLSf_NRrGlkrWusy8Anci9eMrOC_aAAiT7LBmm60IFZzZ6TizdQ/viewform";
  assert.equal(hooks.findSubmitButton('button[type="submit"], input[type="submit"]', ["submit"]), submitButton,
    "duplicate text and aria-label on a Google role-button must still match Submit");
  document.querySelectorAll = originalQueryAll;
  context.location.hostname = "futuretools.io";
  context.location.pathname = "/";
}
{
  const originalQueryAll = document.querySelectorAll;
  const makeAction = (tagName, innerText, ariaLabel = "") => ({
    tagName, innerText, textContent: innerText, value: "", disabled: false,
    getAttribute(name) { return name === "aria-label" ? ariaLabel : ""; },
    getBoundingClientRect() { return { width: 120, height: 36 }; },
    closest() { return null; },
  });
  const newsletterButton = makeAction("BUTTON", "Subscribe");
  const listingButton = makeAction("DIV", "→", "Submit for review");
  document.querySelectorAll = (selector) => {
    if (selector === 'button[type="submit"], input[type="submit"]') return [newsletterButton];
    if (selector === '[role="button"]') return [listingButton];
    if (selector.includes('button, input[type="submit"]')) return [newsletterButton];
    return [];
  };
  assert.equal(hooks.findSubmitButton('button[type="submit"], input[type="submit"]', ["submit"]), listingButton,
    "a generic accessible Submit action should win over an unrelated newsletter submit button");
  document.querySelectorAll = originalQueryAll;
}
{
  const originalQueryAll = document.querySelectorAll;
  const website = new FakeField({ type: "url", name: "website" });
  website.compareDocumentPosition = () => 0;
  const listingForm = new FakeForm({ id: "listing", fields: [website] });
  const newsletterForm = new FakeForm({ id: "newsletter", text: "Subscribe to newsletter", fields: [new FakeField({ type: "email", name: "email" })] });
  const otherForm = new FakeForm({ id: "account", fields: [new FakeField({ name: "first_name" }), new FakeField({ name: "last_name" })] });
  const action = (text, form) => ({
    tagName: "BUTTON", innerText: text, textContent: text, value: "", disabled: false, form,
    getAttribute() { return ""; },
    getBoundingClientRect() { return { width: 120, height: 36 }; },
    closest(selector) { return selector === "form" ? null : null; },
  });
  const unrelated = action("Submit for review", otherForm);
  const owned = action("Submit", listingForm);
  forms.push(listingForm, newsletterForm, otherForm);
  context.Node = { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 };
  document.querySelectorAll = (selector) => {
    if (selector === "form") return forms;
    if (selector === "select" || selector === '[role="button"]') return [];
    if (selector === 'button[type="submit"], input[type="submit"]' || selector.includes('button, input[type="submit"]')) return [unrelated, owned];
    return originalQueryAll(selector);
  };
  assert.equal(hooks.findSubmitButton('button[type="submit"], input[type="submit"]', ["submit"]), owned,
    "the active listing form's externally associated button should beat another form's stronger action label");
  forms.length = 0;
  document.querySelectorAll = originalQueryAll;
}
{
  const originalQuery = document.querySelector;
  document.querySelector = (selector) => selector.includes("usp=form_confirm")
    ? { href: "https://docs.google.com/forms/d/e/example/viewform?usp=form_confirm" }
    : originalQuery(selector);
  context.location.hostname = "docs.google.com";
  context.location.pathname = "/forms/u/0/d/e/1FAIpQLSf_NRrGlkrWusy8Anci9eMrOC_aAAiT7LBmm60IFZzZ6TizdQ/formResponse";
  context.location.href = `https://docs.google.com${context.location.pathname}`;
  document.body.innerText = "Add Listing / Contact Us Thanks for contributing to the directory!";
  const receipt = context.__extLinkSubmissionTestHooks.classifyVisibleEvidence({ destinationUrl: "https://www.theaigeneration.com/add/" });
  assert.equal(receipt.matched, true);
  assert.equal(receipt.evidence, "Thanks for contributing to the directory!");
  document.querySelector = originalQuery;
  document.body.innerText = "";
  context.location.hostname = "futuretools.io";
  context.location.pathname = "/";
  context.location.href = "https://futuretools.io/";
}
const emailField = new FakeField({ name: "email", ariaLabel: "Email address" });
assert.equal(
  fieldHooks.resolveValueForField(oldPhotoConfig, emailField),
  "support@oldphotoliveai.com",
  "profile email should fill a text input whose label carries the email intent",
);
const shortDescriptionField = new FakeField({
  tagName: "textarea",
  ariaLabel: "Short description (minimum 10 words)",
});
const shortDescription = fieldHooks.resolveValueForField(oldPhotoConfig, shortDescriptionField);
assert.ok(shortDescription.split(/\s+/).length >= 10, "short description must satisfy its minimum word count");
assert.match(shortDescription, /^OldPhotoLive AI restores, colorizes, and animates/);
const primaryUseCaseField = new FakeField({
  tagName: "textarea",
  ariaLabel: "Primary Use Case",
});
assert.equal(
  fieldHooks.resolveValueForField(oldPhotoConfig, primaryUseCaseField),
  "Restore and animate old family photos",
  "primary use case should use the configured profile value",
);
const socialUrlField = new FakeField({ type: "url", ariaLabel: "Social media URL (optional)" });
assert.equal(
  fieldHooks.resolveValueForField(oldPhotoConfig, socialUrlField),
  "",
  "an optional social URL must stay blank when the profile has no social URL",
);
const sourceField = new FakeField({ ariaLabel: "How did you hear about us?" });
assert.equal(
  fieldHooks.resolveValueForField(oldPhotoConfig, sourceField),
  "",
  "site-specific acquisition fields must not receive product copy",
);
assert.equal(
  fieldHooks.modelFillGuard(socialUrlField, "https://cdn.oldphotoliveai.com/example/01-restored.jpg"),
  "field-requires-configured-profile-value",
  "the visual fallback must not put a media URL into an optional social field",
);
assert.equal(
  fieldHooks.modelFillGuard(shortDescriptionField, "OldPhotoLive AI restores,."),
  "field-minimum-not-met",
  "the visual fallback must not replace a short description with an underlength value",
);
shortDescriptionField.value = shortDescription;
assert.equal(
  fieldHooks.modelFillGuard(shortDescriptionField, "OldPhotoLive AI restores,."),
  "preserve-existing-value",
  "a valid deterministic value must survive a later asynchronous visual fill",
);
assert.equal(fieldHooks.shouldClearStaleProtectedValue(emailField, "not-an-email"), true);
assert.equal(fieldHooks.shouldReplaceExistingProfileEmail(emailField, "syndredyoung@gmail.com", "support@oldphotoliveai.com"), true);
assert.equal(fieldHooks.shouldReplaceExistingProfileEmail(emailField, "support@oldphotoliveai.com", "support@oldphotoliveai.com"), false);
assert.equal(fieldHooks.shouldReplaceExistingProfileEmail(emailField, "syndredyoung@gmail.com", ""), false);
assert.equal(fieldHooks.shouldReplaceExistingProfileEmail(new FakeField({ name: "email", ariaLabel: "Tool category" }), "Art", "support@oldphotoliveai.com"), false);
assert.equal(fieldHooks.shouldClearStaleProtectedValue(socialUrlField, "https://cdn.example.com/a.jpg"), true);

const newsletter = new FakeForm({
  action: "/submit-email",
  text: "Stay ahead on AI. Join 250,000 readers. Subscribe to Newsletter.",
  fields: [new FakeField({ type: "email", name: "email", placeholder: "Enter your email" })],
});
forms.push(newsletter);
assert.equal(hooks.isMarketingOptInForm(newsletter), true, "email-only newsletter forms should be recognized as marketing opt-ins");
assert.equal(hooks.hasLikelySubmissionFields(newsletter), false, "email alone is not evidence of a product submission form");
assert.equal(hooks.detectSubmissionForm(), false, "a newsletter signup must not be classified as a submission form");
assert.equal(hooks.identifyPlatform(), null, "a newsletter home page must remain an unclassified page");
assert.equal(hooks.queryFillableElements(newsletter).length, 0, "newsletter inputs must be excluded from automatic fill candidates");

const newsletterWithName = new FakeForm({
  action: "/newsletter/subscribe",
  text: "Join our newsletter and tell us what you want to read",
  fields: [
    new FakeField({ type: "text", name: "first_name" }),
    new FakeField({ type: "email", name: "email" }),
    new FakeField({ tagName: "textarea", name: "message" }),
  ],
});
assert.equal(hooks.isMarketingOptInForm(newsletterWithName), true, "newsletter forms may include a name field and still be marketing opt-ins");
forms.push(newsletterWithName);
assert.equal(hooks.identifyPlatform(), null, "newsletter forms with submit-like actions and extra fields must not trigger auto-fill");

forms.length = 0;
const directory = new FakeForm({
  action: "/submit-tool",
  text: "Submit your AI tool",
  fields: [
    new FakeField({ type: "url", name: "website" }),
    new FakeField({ type: "text", name: "product_title" }),
    new FakeField({ tagName: "textarea", name: "description" }),
  ],
});
forms.push(directory);
document.body.textContent = "Submit your AI tool";
assert.equal(hooks.isMarketingOptInForm(directory), false, "multi-field directory forms are not marketing opt-ins");
assert.equal(hooks.hasLikelySubmissionFields(directory), true, "URL, title, and description fields identify a listing form");
assert.equal(hooks.detectDirectory(), true, "a product directory keyword paired with a URL field should retain directory detection");
assert.equal(hooks.detectSubmissionForm(), true, "valid directory fields should remain detectable");
assert.equal(hooks.identifyPlatform(), "directory", "directory form detection should retain its specific platform");
document.body.textContent = "Submit your AI tool. Popular categories: AI Image Editing. Settings";
context.location.href = "https://aitoolsratings.com/submit-ai-tools/";
context.location.pathname = "/submit-ai-tools/";
assert.equal(hooks.identifyPlatform(), "directory", "a directory website field and unrelated Edit/Settings copy must not become a profile form");
assert.equal(hooks.queryFillableElements(directory).length, 3, "directory fields should remain eligible for filling");

forms.length = 0;
forms.push(new FakeForm({
  action: "/account/settings",
  fields: [new FakeField({ type: "url", name: "website" })],
}));
context.location.href = "https://example.com/account/settings";
context.location.pathname = "/account/settings";
document.body.textContent = "Account settings";
assert.equal(hooks.identifyPlatform(), "profile", "an actual account settings form should retain profile routing");
forms.length = 0;
forms.push(directory);
context.location.href = "https://futuretools.io/submit-tool";
context.location.pathname = "/submit-tool";
document.body.textContent = "Submit your AI tool";

directory.fields[0].value = "https://oldphotoliveai.com/";
let guard = hooks.inspectAutoFillGuard("https://graffitinameai.com");
assert.equal(guard.blocked, true, "a different Profile URL already in the form must block auto-fill");
assert.deepEqual([...guard.foreignUrls], ["https://oldphotoliveai.com/"]);
directory.fields[0].value = "";
document.body.innerText = "Thank you for your submission!";
guard = hooks.inspectAutoFillGuard("https://graffitinameai.com");
assert.equal(guard.blocked, true, "a visible success receipt must block auto-fill overwrite");
document.body.innerText = "Submit your AI tool";

const placeholderDirectory = new FakeForm({
  fields: [new FakeField({ type: "text", name: "site", placeholder: "Your website URL" })],
});
assert.equal(hooks.hasLikelySubmissionFields(placeholderDirectory), true, "URL placeholders should identify unlabelled listing fields");

forms.length = 0;
const contact = new FakeForm({
  action: "/contact",
  text: "Contact us",
  fields: [
    new FakeField({ type: "email", name: "email" }),
    new FakeField({ tagName: "textarea", name: "message" }),
  ],
});
forms.push(contact);
document.body.textContent = "Contact us";
assert.equal(hooks.detectSubmissionForm(), true, "email plus a message field should remain a valid contact form");
assert.equal(hooks.identifyPlatform(), "submission", "contact forms with messages should remain supported");

context.location.href = "https://rb6zn ef2.typeform.com/to/RB6ZnEf2".replace(" ", "");
document.body.innerText = "Thank you for applying to get listed on StartupStash! We will get back to you as early as possible :)";
let receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://startupstash.com/submit" });
assert.equal(receipt.matched, true, "the exact StartupStash Typeform receipt should be accepted in a cross-origin frame");
context.location.href = "https://aitoolsratings.com/submit-ai-tools/?submit=sent";
context.location.hostname = "aitoolsratings.com";
document.body.innerText = "Thanks — we received your message and will get back to you soon.";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://aitoolsratings.com/submit-ai-tools/" });
assert.equal(receipt.matched, true, "AI Tools Ratings post-submit message should be recognized");
assert.equal(receipt.publicationStatus, "pending_moderation");
document.body.innerText = "Submit a listing for review. Complete submissions typically go live within 24–72 hours.";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://aitoolsratings.com/submit-ai-tools/" });
assert.equal(receipt.matched, false, "AI Tools Ratings review instructions must not be treated as a receipt");
document.body.innerText = "Thank you for your response. Sponsored by Typeform.";
context.location.href = "https://rb6znef2.typeform.com/to/RB6ZnEf2";
context.location.hostname = "rb6znef2.typeform.com";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://startupstash.com/submit" });
assert.equal(receipt.matched, false, "generic Typeform thank-you copy must not count as StartupStash success");

context.location.href = "https://loxr142exnq.typeform.com/to/RB6ZnEf2";
document.body.innerText = "Your contact details. We will be in touch to finalize your tool's listing.";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://aitools.inc/submit" });
assert.equal(receipt.matched, false, "AI Tools Inc contact question must not look like a receipt");
document.body.innerText = "Thanks! We'll be in touch over the next few days to proceed with your listing.";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://aitools.inc/submit" });
assert.equal(receipt.matched, true, "a standalone Typeform receipt should use the original directory playbook");
assert.equal(receipt.playbookId, "aitools-inc");

context.location.href = "https://tally.so/embed/nG1V7j?alignLeft=1";
document.body.innerText = "Form submitted Are you interested in a guaranteed spot on our directory and the #1 spot for 5 days?";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://www.aimarketing.directory/submit" });
assert.equal(receipt.matched, true, "the known Tally form's final confirmation should count as a submission receipt");
assert.equal(receipt.evidence, "Form submitted");
const tallyQuerySelector = document.querySelector.bind(document);
context.location.href = "https://tally.so/embed/3xrj59";
document.body.innerText = "Form submitted Thanks for completing this form!";
document.querySelector = (selector) => selector === '[role="status"]'
  ? { textContent: "Form submitted" }
  : selector === 'h1'
    ? { textContent: "Thanks for completing this form!" }
    : tallyQuerySelector(selector);
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://launchpedia.co/submit/" });
assert.equal(receipt.matched, true, "a source-bound Tally final status and heading prove submission");
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://tally.so/embed/3xrj59" });
assert.equal(receipt.matched, false, "a Tally receipt without an external source must not be attributed");
document.querySelector = tallyQuerySelector;
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://launchpedia.co/submit/" });
assert.equal(receipt.matched, false, "generic text without a Tally final status is not enough");
const formSubmitQuerySelector = document.querySelector.bind(document);
const formSubmitQuerySelectorAll = document.querySelectorAll.bind(document);
context.location.href = "https://formsubmit.co/hansraj.kumararlani@gmail.com";
context.location.hostname = "formsubmit.co";
document.body.innerText = "Thanks!\nThe form was submitted successfully.\nReturn to original site: https://aitoolsdirectory.site/";
document.querySelector = (selector) => selector === "h1" ? { textContent: "Thanks!" } : formSubmitQuerySelector(selector);
document.querySelectorAll = (selector) => selector === "a[href]" ? [{
  href: "https://aitoolsdirectory.site/",
  getBoundingClientRect: () => ({ width: 140, height: 20 }),
  parentElement: null,
}] : formSubmitQuerySelectorAll(selector);
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://aitoolsdirectory.site/submit.html" });
assert.equal(receipt.matched, true, "FormSubmit's visible return link and final success text prove the source submission");
assert.equal(receipt.evidence, "The form was submitted successfully.");
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://another-directory.example/submit" });
assert.equal(receipt.matched, false, "a FormSubmit receipt must not be attributed to another directory");
document.body.innerText = "Submit your tool. Return to original site: https://aitoolsdirectory.site/";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://aitoolsdirectory.site/submit.html" });
assert.equal(receipt.matched, false, "FormSubmit's recipient form page must not count as its final receipt");
document.querySelector = formSubmitQuerySelector;
document.querySelectorAll = formSubmitQuerySelectorAll;
const originalQuerySelector = document.querySelector.bind(document);
context.location.href = "https://credibleaitools.com/submit-tool/";
context.location.hostname = "credibleaitools.com";
const credibleReceipt = {
  textContent: "Thanks! We’ve received your submission and will get back to you shortly.",
  getBoundingClientRect: () => ({ width: 320, height: 38 }),
  parentElement: null,
};
document.querySelector = (selector) => selector === "#panel-free .forminator-response-message.forminator-success"
  ? credibleReceipt : originalQuerySelector(selector);
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://credibleaitools.com/submit-tool/" });
assert.equal(receipt.matched, true, "visible Credible AI free-form success alert proves receipt");
credibleReceipt.getBoundingClientRect = () => ({ width: 0, height: 0 });
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://credibleaitools.com/submit-tool/" });
assert.equal(receipt.matched, false, "hidden retained Forminator success text must not prove a new receipt");
credibleReceipt.getBoundingClientRect = () => ({ width: 320, height: 38 });
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://another-directory.example/submit" });
assert.equal(receipt.matched, false, "Credible AI receipt must not be attributed to another source");
document.querySelector = originalQuerySelector;
context.location.href = "https://docs.google.com/forms/d/e/1FAIpQLSfxtP1hx6kN9nkAYXquRq2eTG24_YPEx5-pHov2POonNLeuOw/viewform";
document.body.innerText = "您的回复已记录。另填写一份回复";
document.querySelector = (selector) => selector.includes("usp=form_confirm") ? { href: "https://docs.google.com/forms/d/e/example/viewform?usp=form_confirm" } : originalQuerySelector(selector);
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://startupcollections.com/submit-product/" });
assert.equal(receipt.matched, true, "a source-bound Google Form confirmation link and final text prove submission");
assert.equal(receipt.evidence, "您的回复已记录。");
document.querySelector = originalQuerySelector;
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://startupcollections.com/submit-product/" });
assert.equal(receipt.matched, false, "thank-you text without the final confirmation link is not enough");
context.location.href = "https://tally.so/embed/another-form";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://www.aimarketing.directory/submit" });
assert.equal(receipt.matched, false, "another Tally form must not inherit AI Marketing's receipt shortcut");

console.log("Content submission detection tests passed");

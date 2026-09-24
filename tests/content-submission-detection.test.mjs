import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "extension/content.js"), "utf8");
const forms = [];

class FakeField {
  constructor({ type = "text", tagName = "input", name = "", id = "", placeholder = "" } = {}) {
    this.type = type;
    this.tagName = tagName.toUpperCase();
    this.name = name;
    this.id = id;
    this.placeholder = placeholder;
    this.value = "";
    this.disabled = false;
    this.readOnly = false;
    this.form = null;
    this.parentElement = null;
  }

  getAttribute(name) {
    return ({ name: this.name, id: this.id, type: this.type, placeholder: this.placeholder })[name] || "";
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
assert.equal(hooks.queryFillableElements(directory).length, 3, "directory fields should remain eligible for filling");

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
document.body.innerText = "Thank you for your response. Sponsored by Typeform.";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://startupstash.com/submit" });
assert.equal(receipt.matched, false, "generic Typeform thank-you copy must not count as StartupStash success");

context.location.href = "https://loxr142exnq.typeform.com/to/RB6ZnEf2";
document.body.innerText = "Thanks we'll be in touch soon.";
receipt = hooks.classifyVisibleEvidence({ destinationUrl: "https://aitools.inc/submit" });
assert.equal(receipt.matched, true, "a standalone Typeform receipt should use the original directory playbook");
assert.equal(receipt.playbookId, "aitools-inc");

console.log("Content submission detection tests passed");

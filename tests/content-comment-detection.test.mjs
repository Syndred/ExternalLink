import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");

class FakeElement {
  constructor({ tagName = "textarea", name = "", id = "", value = "", text = "" } = {}) {
    this.tagName = tagName.toUpperCase();
    this.name = name;
    this.id = id;
    this.value = value;
    this.textContent = text;
    this.innerText = text;
    this.form = null;
  }

  getAttribute(name) {
    return {
      name: this.name,
      id: this.id,
    }[name] || "";
  }

  closest(selector) {
    return selector === "form" ? this.form : null;
  }
}

class FakeForm {
  constructor({ action = "", id = "", className = "", text = "", field, submit = true, listingField = null, extraFields = [] } = {}) {
    this.id = id;
    this.className = className;
    this.innerText = text;
    this.textContent = text;
    this.attributes = { action };
    this.field = field;
    this.submit = submit ? new FakeElement({ tagName: "button", text: "Post" }) : null;
    this.listingField = listingField;
    this.extraFields = extraFields;
    if (field) field.form = this;
    for (const extra of extraFields) extra.form = this;
    if (this.submit) this.submit.form = this;
  }

  getAttribute(name) {
    return this.attributes[name] || "";
  }

  querySelector(selector) {
    if (/button\[type="submit"\]|input\[type="submit"\]/.test(selector)) return this.submit;
    if (/input\[type="url"\]|input\[name\*="url"|input\[name\*="website"|input\[name\*="product"|input\[name\*="title"|textarea\[name\*="description"|textarea\[name\*="summary"/.test(selector)) {
      return this.listingField;
    }
    if (/textarea\[name\*="comment"|textarea\[id\*="comment"|textarea\[name\*="message"|textarea\[id\*="message"|textarea\[name\*="body"|textarea\[id\*="body"|contenteditable/.test(selector)) {
      return this.field;
    }
    return null;
  }

  querySelectorAll(selector) {
    if (/button|input\[type=submit\]|label/.test(selector)) return this.submit ? [this.submit] : [];
    return [];
  }

  contains(element) {
    return element === this.field || element === this.submit || element === this.listingField || this.extraFields.includes(element);
  }
}

const forms = [];
const document = {
  addEventListener() {},
  body: { innerText: "", textContent: "" },
  querySelector(selector) {
    return null;
  },
  querySelectorAll(selector) {
    return selector === "form" ? forms : [];
  },
  getElementById() {
    return null;
  },
};

const runtime = {
  onMessage: { addListener() {}, removeListener() {} },
  sendMessage() {
    return Promise.resolve({ ok: true });
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
const hooks = context.__extLinkCommentTestHooks;
assert.ok(hooks, "content.js should expose the comment detector test surface");

const directoryMessage = new FakeElement({ name: "message", id: "message" });
const directoryUrl = new FakeElement({ tagName: "input", name: "website", id: "website" });
const directoryForm = new FakeForm({
  action: "/post",
  id: "submit-tool",
  className: "tool-form",
  text: "Post your product",
  field: directoryMessage,
  listingField: directoryUrl,
});
forms.push(directoryForm);
assert.equal(hooks.detectArticleComment(), false, "a product POST form with message must not be detected as a blog comment");
assert.equal(hooks.isArticleCommentField(directoryMessage), false, "directory message field must not enter comment generation");

forms.length = 0;
const articleMessage = new FakeElement({ name: "message", id: "message" });
const articleDescription = new FakeElement({ name: "description", id: "description" });
const articleForm = new FakeForm({
  action: "/post",
  id: "comment-form",
  className: "article-comment",
  text: "Leave a comment",
  field: articleMessage,
  extraFields: [articleDescription],
});
forms.push(articleForm);
assert.equal(hooks.detectArticleComment(), true, "a local Leave a comment form should be detected");
assert.equal(hooks.isArticleCommentField(articleMessage), true, "confirmed article comment field may generate a draft");
assert.equal(hooks.isArticleCommentField(articleDescription), false, "a sibling description field must not receive a comment draft");

forms.length = 0;
const genericBody = new FakeElement({ name: "body", id: "body" });
const genericForm = new FakeForm({
  action: "/post",
  id: "new-listing",
  text: "Post your tool",
  field: genericBody,
  listingField: directoryUrl,
});
forms.push(genericForm);
assert.equal(hooks.detectArticleComment(), false, "a product POST body field must stay out of comment detection");

console.log("Content comment detector tests passed");

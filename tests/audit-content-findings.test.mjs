import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(root, "extension/content.js"), "utf8");

function splitSelector(selector) {
  return String(selector || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function simpleSelectorMatches(element, selector) {
  let part = String(selector || "").trim();
  if (!part) return false;
  // This audit DOM intentionally supports only the selector forms used by
  // the content routes under test. Unknown pseudo selectors are ignored.
  part = part.replace(/:not\([^)]*\)/g, "");
  // Attribute selectors may carry a case-insensitive flag (`[name*="x" i]`);
  // remove that flag before looking for descendant combinators.
  part = part.replace(/\s+[is](?=\])/gi, "");
  const descendant = part.lastIndexOf(" ");
  if (descendant >= 0) part = part.slice(descendant + 1);

  const tag = part.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && element.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  const id = part.match(/#([\w-]+)/)?.[1];
  if (id && element.id !== id) return false;
  const classes = [...part.matchAll(/\.([\w-]+)/g)].map((match) => match[1]);
  if (classes.some((name) => !String(element.className || "").split(/\s+/).includes(name))) return false;

  for (const match of part.matchAll(/\[([^\]]+)\]/g)) {
    const expression = match[1].trim();
    const attrMatch = expression.match(/^([\w:-]+)\s*(\*=|=)?\s*(?:["']([^"']*)["']|([^\s]+))?/);
    if (!attrMatch) continue;
    const [, name, operator, quoted, bare] = attrMatch;
    const actual = element.getAttribute(name);
    const expected = quoted ?? bare ?? "";
    if (operator && actual == null) return false;
    if (operator === "=" && actual !== expected) return false;
    if (operator === "*=" && !actual.toLowerCase().includes(expected.toLowerCase())) return false;
    if (!operator && actual == null) return false;
  }
  return true;
}

function selectorMatches(element, selector) {
  return splitSelector(selector).some((part) => simpleSelectorMatches(element, part));
}

class FakeElement {
  constructor({ tagName = "div", name = "", id = "", type = "", value = "", text = "", className = "", visible = true, hidden = false } = {}) {
    this.tagName = tagName.toUpperCase();
    this.name = name;
    this.id = id;
    this.type = type;
    this._value = value;
    this.textContent = text;
    this.innerText = text;
    this.className = className;
    this.visible = visible;
    this.hidden = hidden;
    this.disabled = false;
    this.readOnly = false;
    this.attributes = {};
    if (name) this.attributes.name = name;
    if (id) this.attributes.id = id;
    if (type) this.attributes.type = type;
    if (className) this.attributes.class = className;
    this.form = null;
    this.parentElement = null;
    this.children = [];
    this.clicked = 0;
    this.files = [];
    this.style = {};
  }

  get value() {
    return this._value;
  }

  set value(value) {
    this._value = String(value ?? "");
  }

  getAttribute(name) {
    if (name === "value") return this.value;
    if (name === "hidden") return this.hidden ? "" : null;
    if (name === "aria-hidden") return this.attributes[name] || "";
    return this.attributes[name] ?? null;
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  hasAttribute(name) {
    return this.getAttribute(name) != null && this.getAttribute(name) !== "";
  }

  matches(selector) {
    return selectorMatches(this, selector);
  }

  closest(selector) {
    if (selector.includes("form") && this.form) return this.form;
    if (selector.includes("label")) return null;
    if (selector.includes("[hidden]") && this.hidden) return this;
    if (selector.includes("[aria-hidden") && this.getAttribute("aria-hidden") === "true") return this;
    return null;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this.children.filter((child) => selectorMatches(child, selector));
  }

  contains(element) {
    return element === this || this.children.includes(element);
  }

  getBoundingClientRect() {
    return this.visible && !this.hidden
      ? { x: 0, y: 0, width: 160, height: 24, top: 0, left: 0, right: 160, bottom: 24 }
      : { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
  }

  compareDocumentPosition() {
    return 0;
  }

  focus() {}
  blur() {}
  dispatchEvent() {}
  scrollIntoView() {}
  click() {
    this.clicked += 1;
  }
}

class FakeForm extends FakeElement {
  constructor(options = {}) {
    super({ tagName: "form", ...options });
    this.action = options.action || "";
    this.attributes.action = this.action;
    for (const child of options.children || []) {
      child.form = this;
      child.parentElement = this;
      this.children.push(child);
    }
  }
}

class FakeTextArea extends FakeElement {
  constructor(options = {}) {
    super({ tagName: "textarea", ...options });
  }
}

class FakeInput extends FakeElement {
  constructor(options = {}) {
    super({ tagName: "input", ...options });
  }
}

class FakeButton extends FakeElement {
  constructor(options = {}) {
    super({ tagName: "button", type: "submit", ...options });
  }
}

class FakeBody extends FakeElement {
  constructor(text) {
    super({ tagName: "body", text });
  }

  cloneNode() {
    return {
      innerText: this.innerText,
      textContent: this.textContent,
      querySelectorAll() {
        return [];
      },
    };
  }
}

function createContentContext({ elements = [], bodyText = "", href = "https://directory.example/submit", sendMessage } = {}) {
  const body = new FakeBody(bodyText);
  const document = {
    title: "",
    body,
    addEventListener() {},
    removeEventListener() {},
    querySelector(selector) {
      return elements.find((element) => selectorMatches(element, selector)) || null;
    },
    querySelectorAll(selector) {
      return elements.filter((element) => selectorMatches(element, selector));
    },
    getElementById() {
      return null;
    },
  };
  const runtime = {
    id: "audit",
    onMessage: { addListener() {}, removeListener() {} },
    sendMessage: sendMessage || (() => Promise.resolve({ ok: true })),
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
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: FakeTextArea,
    HTMLSelectElement: class FakeSelect extends FakeElement {},
    Node: { DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    document,
    location: { href, hostname: new URL(href).hostname, pathname: new URL(href).pathname, origin: new URL(href).origin },
    chrome: { runtime },
    window: null,
    self: null,
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setTimeout(callback) {
      callback();
      return 1;
    },
    clearTimeout() {},
    setInterval() {
      return 1;
    },
    clearInterval() {},
  };
  context.window = context;
  context.self = context;
  context.__extLinkBootstrapped = true;
  vm.createContext(context);
  vm.runInContext(content, context, { filename: "extension/content.js" });
  return { context, document, body };
}

// Directory forms that call their description field `comment` must remain
// directory forms. This exercises the same detector order used by executeSubmit.
{
  const comment = new FakeTextArea({ name: "comment" });
  const directoryBody = new FakeTextArea({ name: "body" });
  const directoryMessage = new FakeTextArea({ name: "message" });
  const website = new FakeInput({ name: "website", type: "url" });
  const submit = new FakeButton({ text: "Submit product" });
  const form = new FakeForm({ action: "/post", id: "submit-tool", className: "tool-form", text: "Submit your product", children: [comment, directoryBody, directoryMessage, website, submit] });
  const { context } = createContentContext({ elements: [form, comment, directoryBody, directoryMessage, website, submit], bodyText: "Submit your product" });
  const hooks = context.__extLinkContentAuditTestHooks;
  assert.equal(hooks.detectWPComment(), false, "directory comment-named copy must not route to WP comments");
  assert.equal(hooks.identifyPlatform(), "directory", "directory detector should win after rejecting generic comment copy");
  assert.equal(hooks.isCommentLikeField(comment), false, "directory comment copy must not generate a comment");
  assert.equal(hooks.isCommentLikeField(directoryBody), false, "directory body must not generate a comment");
  assert.equal(hooks.isCommentLikeField(directoryMessage), false, "directory message must not generate a comment");
}

// Hidden login/verification controls and unrelated postal-code fields must not
// stop a visible submission form; a visible captcha still is a human gate.
{
  const hiddenPassword = new FakeInput({ type: "password", hidden: true, visible: false });
  const postalCode = new FakeInput({ name: "postalCode", type: "text" });
  const { context } = createContentContext({ elements: [hiddenPassword, postalCode] });
  const hooks = context.__extLinkContentAuditTestHooks;
  assert.equal(hooks.detectSubmitBlockers(), null, "hidden password and postalCode must not block submission");

  const captcha = new FakeElement({ className: "g-recaptcha" });
  const gated = createContentContext({ elements: [captcha] });
  const visibleCaptchaBlock = gated.context.__extLinkContentAuditTestHooks.detectSubmitBlockers();
  assert.equal(visibleCaptchaBlock?.captcha, true, "visible captcha remains a human gate");
}

// A comment submit click without a changed, matched receipt must park the tab
// for manual confirmation instead of returning a successful submission.
{
  let clock = 0;
  class FastDate extends Date {
    static now() {
      clock += 20_000;
      return clock;
    }
  }
  const comment = new FakeTextArea({ name: "comment" });
  const submit = new FakeButton({ text: "Post comment" });
  const form = new FakeForm({
    id: "comment-form",
    className: "article-comment",
    text: "Leave a comment",
    children: [comment, submit],
  });
  const hiddenComment = new FakeTextArea({ name: "comment", hidden: true, visible: false });
  const hiddenSubmit = new FakeButton({ text: "Post comment", hidden: true, visible: false });
  const hiddenForm = new FakeForm({
    id: "old-comment-form",
    className: "article-comment",
    hidden: true,
    visible: false,
    children: [hiddenComment, hiddenSubmit],
  });
  const { context } = createContentContext({ elements: [hiddenForm, hiddenComment, hiddenSubmit, form, comment, submit] });
  assert.equal(
    context.__extLinkContentAuditTestHooks.identifyPlatform(),
    "article",
    "an ordinary article form named comment must route to the article handler",
  );
  assert.equal(
    context.__extLinkContentAuditTestHooks.isCommentLikeField(comment),
    true,
    "the confirmed article comment field remains eligible for comment generation",
  );
  context.Date = FastDate;
  const result = await context.__extLinkContentAuditTestHooks.submitArticleComment({
    projectKey: "p1",
    username: "Tester",
    email: "tester@example.com",
    targetDomain: "https://product.example",
    commentTemplate: "A relevant comment.",
  });
  assert.equal(submit.clicked, 1, "the test must exercise the real submit click");
  assert.equal(hiddenSubmit.clicked, 0, "hidden duplicate comment forms must not receive the submit click");
  assert.equal(comment.value, "A relevant comment.", "the visible article comment field must be filled");
  assert.equal(result.needs_manual, true, "unconfirmed comment submission must require manual review");
  assert.equal(result.submitted, false);
  assert.equal(result.matched, false);
}

// A normal comment POST may navigate to a same-origin receipt page. The
// click itself authorizes that navigation, so a matched moderation receipt
// must still be accepted as a successful submission.
{
  let clock = 0;
  class ReceiptDate extends Date {
    static now() {
      clock += 1_000;
      return clock;
    }
  }
  const comment = new FakeTextArea({ name: "comment" });
  const submit = new FakeButton({ text: "Post comment" });
  const form = new FakeForm({
    id: "comment-form",
    className: "article-comment",
    text: "Leave a comment",
    children: [comment, submit],
  });
  const loaded = createContentContext({
    href: "https://blog.example/article-a",
    elements: [form, comment, submit],
    bodyText: "Article body",
  });
  submit.click = () => {
    submit.clicked += 1;
    loaded.context.location.href = "https://blog.example/thanks";
    loaded.context.document.body = new FakeBody("Comment awaiting moderation");
  };
  loaded.context.Date = ReceiptDate;
  const result = await loaded.context.__extLinkContentAuditTestHooks.submitArticleComment({
    projectKey: "p1",
    username: "Tester",
    email: "tester@example.com",
    targetDomain: "https://product.example",
    commentTemplate: "A relevant comment.",
  });
  assert.equal(submit.clicked, 1, "the receipt test must exercise the submit click");
  assert.equal(result.ok, true, "a matched same-origin moderation receipt is success");
  assert.equal(result.submitted, true);
  assert.equal(result.matched, true);
  assert.match(result.evidence, /comment awaiting moderation/i);
}

// An AI response for page A arriving after a same-content-script SPA switch to
// page B must be discarded before it can be used as a comment draft.
{
  let resolveDrafts;
  const pending = new Promise((resolve) => {
    resolveDrafts = resolve;
  });
  let sent;
  const initialBodyText = "A".repeat(220);
  const loaded = createContentContext({
    href: "https://blog.example/article-a",
    bodyText: initialBodyText,
    sendMessage(message) {
      if (message.action === "generateCommentDrafts") {
        sent = message;
        return pending;
      }
      return Promise.resolve({ ok: true });
    },
  });
  const request = loaded.context.__extLinkContentAuditTestHooks.requestCommentDrafts({ projectKey: "p1" });
  await Promise.resolve();
  assert.equal(sent.pageUrl, "https://blog.example/article-a");
  loaded.context.location.href = "https://directory.example/submit";
  loaded.context.location.hostname = "directory.example";
  loaded.context.document.body = new FakeBody("B".repeat(220));
  resolveDrafts({ ok: true, drafts: [{ text: "old page A draft" }] });
  assert.equal(await request, null, "old-page AI draft must be discarded after navigation");
}

console.log("Content audit findings regression tests passed");

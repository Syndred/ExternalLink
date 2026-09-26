import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(resolve(root, "extension/sidepanel.js"), "utf8");

function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `sidepanel.js should contain ${start}`);
  assert.ok(to > from, `sidepanel.js should contain ${end}`);
  return source.slice(from, to);
}

assert.doesNotMatch(
  slice("  async function refreshActiveTab()", "  chrome.tabs.onActivated.addListener"),
  /await refreshSiteAnnotation\(/,
  "site badge loading must not block the Detect and Fill active-tab refresh",
);

// A marker click belongs to the page visible at click time. A slow annotation
// read must not redirect the subsequent write to whichever tab is active later.
{
  const firstRead = deferred();
  const messages = [];
  const context = {
    currentPageUrl: "https://launch.ignlab.net/submit.html",
    activeTabId: 7,
    activeSiteId: "OldPhotoLive",
    SITE_STATUS_MAP: { needs_captcha: { label: "需验证码" } },
    Q: { normalizeAnnotationStatuses: () => [] },
    chrome: { runtime: { sendMessage(message) {
      messages.push(message);
      return message.action === "getSiteAnnotation" ? firstRead.promise : Promise.resolve({ ok: true });
    } } },
    refreshSiteAnnotation: async () => {},
    loadSubmissionQueue: async () => {},
    loadClassifiedList: async () => {},
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(slice("  async function markCurrentSite(", "  async function addCurrentToUrlList("), context);
  const marking = vm.runInContext('markCurrentSite("needs_captcha")', context);
  context.currentPageUrl = "https://listai.cc/submit";
  context.activeTabId = 8;
  firstRead.resolve({ annotation: null });
  await marking;
  assert.equal(messages[1].url, "https://launch.ignlab.net/submit.html");
  assert.equal(messages[1].tabId, 7);
  assert.equal(messages[1].profileId, "OldPhotoLive");
}

// A receipt closes only an owned, still-active tab after canonical cloud
// readback. Local ledger success alone must leave the page available.
{
  const removed = [];
  const url = "https://directory.example/submit";
  const context = {
    activeTabId: 7,
    activeSiteId: "OldPhotoLive",
    ownedSubmissionTabs: new Map([[7, url]]),
    skipActivationFromVerifiedClose: false,
    Q: { normalizeUrlKey: (value) => String(value || "").replace(/\/$/, "") },
    chrome: {
      tabs: {
        get: async () => ({ id: 7, active: true, url }),
        remove: async (tabId) => removed.push(tabId),
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(slice("  async function closeVerifiedOwnedTab", "  chrome.tabs.onRemoved.addListener"), context);
  const call = (result, tabId = 7) => vm.runInContext(
    `closeVerifiedOwnedTab(${JSON.stringify(result)}, ${JSON.stringify({
      tabId,
      expectedUrl: url,
      profileId: "OldPhotoLive",
      ownedUrl: url,
    })})`,
    context,
  );
  const receipt = {
    submitted: true, matched: true, evidence: "Accepted by directory",
    ledgerSaved: true, receiptTabUrl: url,
  };
  assert.equal(await call({ ...receipt, cloudSynced: false }), false);
  assert.deepEqual(removed, [], "unconfirmed cloud writes must keep the receipt tab open");
  assert.equal(await call({ ...receipt, cloudSynced: true }, 8), false);
  assert.deepEqual(removed, [], "a changed active tab must not be closed");
  assert.equal(await call({ ...receipt, cloudSynced: true }), true);
  assert.deepEqual(removed, [7], "a cloud-confirmed receipt may close its owned tab");
  assert.equal(context.ownedSubmissionTabs.has(7), false);
}

function deferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function statusElement(text = "") {
  return {
    disabled: false,
    textContent: text,
    hidden: false,
    className: "",
    setAttribute(name, value) {
      if (name === "hidden") this.hidden = true;
      this[name] = value;
    },
    removeAttribute(name) {
      if (name === "hidden") this.hidden = false;
      delete this[name];
    },
  };
}

// Unknown legacy timestamps should be rendered as a stable human label rather
// than leaking the literal value into the timeline card.
{
  const context = {
    Intl,
    Date,
    String,
    RegExp,
    Number,
    console,
  };
  vm.createContext(context);
  vm.runInContext(
    slice("  function formatSidepanelTimelineTime", "  function sidepanelTimelineLabel"),
    context,
  );
  assert.equal(vm.runInContext('formatSidepanelTimelineTime("unknown")', context), "时间未知");
  assert.equal(vm.runInContext('formatSidepanelTimelineTime("not-a-date")', context), "时间未知");
}

// Automatically fill only when content detection identifies a supported
// profile or submission workflow, not any arbitrary page with an input.
{
  const context = { String, Number };
  vm.createContext(context);
  vm.runInContext(
    slice("  function shouldAutoFillAfterDetection", "  // ─── Detect ───"),
    context,
  );
  assert.equal(
    vm.runInContext('shouldAutoFillAfterDetection({ operable: true, platform: "unknown", formFieldCount: 1 })', context),
    false,
    "unknown pages with one field must not trigger automatic fill",
  );
  assert.equal(
    vm.runInContext('shouldAutoFillAfterDetection({ operable: true, platform: "directory", formFieldCount: 3 })', context),
    true,
    "recognized directory forms should keep automatic fill enabled",
  );
  assert.equal(
    vm.runInContext('shouldAutoFillAfterDetection({ operable: true, platform: "directory", formFieldCount: 3, submitBlocker: { blocked: true, reason: "listing fee" } })', context),
    false,
    "a confirmed listing fee must stop the automatic fill handoff",
  );
}

// Detection starts fill as soon as sidepanelDetect returns. Slow quality
// requests are intentionally held open to prove they are not on the fill path.
{
  const metrics = deferred();
  const prescan = deferred();
  const button = statusElement("检测");
  const messages = [];
  let autoFillOptions = null;
  const context = {
    console,
    Promise,
    URL,
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
    activeTabId: 7,
    currentPageUrl: "https://devpages.io/submit-a-tool",
    activeSiteId: "TextComparison",
    detection: null,
    detectionRequestId: 0,
    pagePrescan: null,
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          if (message.action === "prescanPage") return prescan.promise;
          if (message.action === "sidepanelDetect") {
            return Promise.resolve({
              ok: true,
              tabId: 7,
              operable: true,
              platform: "directory",
              formFieldCount: 5,
              fields: [],
            });
          }
          return Promise.resolve({ ok: true });
        },
      },
    },
    $: (id) => (id === "btnDetect" ? button : null),
    refreshActiveTab: async () => {},
    fetchDomainMetricsForHost: () => metrics.promise,
    renderDetection() {},
    updateCommentAvailability() {},
    setWorkflowStep() {},
    shouldAutoFillAfterDetection: () => true,
    setAutoFillStatus() {},
    triggerAutoFillForCurrentTab(options) {
      autoFillOptions = options;
      return Promise.resolve({ ok: true, fillOnly: true });
    },
    renderPageMetrics() {},
    renderPageTdk() {},
    setStatusItem() {},
    refreshCommentFieldInfo: async () => null,
    refreshSiteAnnotation: async () => {},
    loadSidepanelTimeline: async () => {},
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(slice("  async function detectCurrentPage()", "  function renderDetection"), context);
  await vm.runInContext("detectCurrentPage()", context);
  assert.deepEqual(
    JSON.parse(JSON.stringify(autoFillOptions)),
    {
      tabId: 7,
      expectedUrl: "https://devpages.io/submit-a-tool",
      profileId: "TextComparison",
    },
    "detection should hand off the current tab, URL, and Profile immediately",
  );
  assert.equal(button.disabled, false, "detection button should recover after the fast detection response");
  assert.deepEqual(
    messages.map((message) => message.action),
    ["prescanPage", "sidepanelDetect"],
    "quality prescan may run in parallel but must not block sidepanelDetect",
  );
  prescan.resolve({ ok: true, hasCommentForm: false });
  metrics.resolve({});
  await new Promise((resolve) => setImmediate(resolve));
}

// A sidepanel fill request must be fill-only and bound to the captured page/Profile.
// A late response after switching Profile is marked stale for the caller.
{
  const response = deferred();
  const messages = [];
  const status = statusElement();
  const context = {
    console,
    Promise,
    URL,
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
    activeTabId: 7,
    currentPageUrl: "https://devpages.io/submit-a-tool",
    activeSiteId: "TextComparison",
    sidepanelFillRequestId: 0,
    sidepanelFillRequests: new Map(),
    SIDEPANEL_FILL_TIMEOUT_MS: 30000,
    SIDEPANEL_FILL_STALE_MS: 90000,
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          return Promise.resolve({ ok: true, fillOnly: true, filledCount: 5 });
        },
      },
    },
    $: (id) => (id === "autoFillStatus" ? status : null),
    handleFillResult: async () => {},
    captureFillContext: (tabId, expectedUrl, profileId) => ({ tabId, expectedUrl, profileId }),
    setTimeout,
    clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(
    slice("  function setAutoFillStatus", "  async function triggerAutoFillForCurrentTab"),
    context,
  );
  const result = await vm.runInContext(
    `runSidepanelFill({
      tabId: 7,
      expectedUrl: "https://devpages.io/submit-a-tool",
      profileId: "TextComparison",
      mode: "form",
    })`,
    context,
  );
  assert.equal(result.fillOnly, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].fillOnly, true, "manual and automatic sidepanel fill must never omit fillOnly");
  assert.equal(messages[0].profileId, "TextComparison");
  assert.equal(messages[0].expectedUrl, "https://devpages.io/submit-a-tool");

  context.chrome.runtime.sendMessage = () => response.promise;
  const late = vm.runInContext(
    `runSidepanelFill({
      tabId: 7,
      expectedUrl: "https://devpages.io/submit-a-tool",
      profileId: "TextComparison",
      mode: "form",
    })`,
    context,
  );
  context.activeSiteId = "RainbowPetAI";
  response.resolve({ ok: true, fillOnly: true, filledCount: 3 });
  const stale = await late;
  assert.equal(stale.stale, true, "a response for a previous Profile must not update the new page context");
}

// Timeline saves retain the current destination object even if a refresh replaces it
// while the background request is being sent.
{
  const fields = {
    timelineProfileSelect: { value: "TextComparison" },
    timelineEventType: { value: "published" },
    timelineOccurredAt: { value: "2026-09-10T10:00" },
    timelineNote: { value: "页面已显示上线" },
    timelinePublicUrl: { value: "https://devpages.io/tools/rspai" },
    timelineEvidenceUrl: { value: "https://devpages.io/tools/rspai#evidence" },
    timelineEditor: { hidden: false },
    btnAddTimelineEvent: { hidden: false },
    btnSaveTimelineEvent: { disabled: false, textContent: "保存人工动态" },
    btnCancelTimelineEvent: { disabled: false },
  };
  let savedMessage = null;
  const context = {
    console,
    Promise,
    URL,
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
    siteProfiles: { TextComparison: { name: "TextComparison" } },
    activeSiteId: "TextComparison",
    currentPageUrl: "https://devpages.io/submit-a-tool",
    currentTimelineItem: {
      key: "devpages.io/submit-a-tool",
      url: "https://devpages.io/submit-a-tool",
      domain: "devpages.io",
    },
    timelineSaveInProgress: false,
    timelineEditorUrl: "",
    Q: {
      normalizeDestinationKey: (url) => String(url).replace("https://", "").split("?")[0],
      normalizeUrlKey: (url) => String(url).replace("https://", "").split("?")[0],
    },
    $: (id) => fields[id] || null,
    chrome: {
      runtime: {
        sendMessage(message) {
          savedMessage = message;
          context.currentTimelineItem = null;
          return Promise.resolve({ ok: true });
        },
      },
    },
    loadSidepanelTimeline: async () => {},
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(slice("  function toDateTimeLocal", "  function renderSubmissionNav"), context);
  await vm.runInContext("saveTimelineEvent({ preventDefault() {} })", context);
  assert.equal(savedMessage.destinationKey, "devpages.io/submit-a-tool");
  assert.equal(savedMessage.destinationUrl, "https://devpages.io/submit-a-tool");
  assert.equal(savedMessage.profileId, "TextComparison");
  assert.equal(savedMessage.profileName, "TextComparison");
  assert.equal(savedMessage.source, "manual");
  assert.equal(savedMessage.type, "published");
  assert.match(savedMessage.occurredAt, /^2026-09-10T(?:02|10):00:00\.000Z$/);
}

// The manual fill button must recover after the runtime rejects the request.
{
  const button = statusElement("填表");
  const statuses = [];
  const context = {
    console,
    Promise,
    URL,
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
    activeTabId: 7,
    currentPageUrl: "https://devpages.io/submit-a-tool",
    activeSiteId: "TextComparison",
    productHuntReadyToCreateTabId: null,
    siteProfiles: { TextComparison: { name: "TextComparison" } },
    commentAvailability: { available: false, reason: "无评论表单" },
    P: { profileConfigured: () => true },
    $: (id) => (id === "btnFillForm" ? button : null),
    refreshActiveTab: async () => {},
    runSidepanelFill: async () => {
      throw new Error("后台请求失败");
    },
    resetMediaUploadState() {},
    setAutoFillStatus(message, cls) {
      statuses.push([message, cls]);
    },
    updateProductHuntFillButton() {
      button.textContent = "填表";
    },
    handleFillResult: async () => {},
    captureFillContext: (tabId, expectedUrl, profileId) => ({ tabId, expectedUrl, profileId }),
    showToast() {},
    chrome: { runtime: { openOptionsPage() {} } },
  };
  vm.createContext(context);
  vm.runInContext(slice("  async function fillPage(mode, options = {})", '  $("btnFillForm")'), context);
  await vm.runInContext('fillPage("form")', context);
  assert.equal(button.disabled, false, "fill button should be enabled after a failed request");
  assert.equal(button.textContent, "填表", "fill button label should recover after a failed request");
  assert.deepEqual(statuses, [["正在填写…", undefined], ["后台请求失败", "err"]]);

  const submitButton = statusElement("提交本页");
  let submitOptions;
  context.$ = (id) => (id === "btnSubmitPage" ? submitButton : null);
  context.runSidepanelFill = async (options) => {
    submitOptions = options;
    return {};
  };
  await vm.runInContext('fillPage("form", { submit: true })', context);
  assert.equal(submitOptions.fillOnly, false, "explicit submit action must request background submission");
  assert.equal(submitOptions.tabId, 7, "submission must target the active tab at click time");
  assert.equal(submitOptions.profileId, "TextComparison", "submission must retain the selected Profile");
  assert.equal(submitButton.disabled, false, "submit button should recover after the request");
  assert.equal(submitButton.textContent, "提交本页", "submit button label should recover after the request");
}

// An explicit single-page submission failure stays on that page for review.
{
  let nextOpened = false;
  const statuses = [];
  const context = {
    Promise,
    SITE_STATUS_MAP: { needs_manual: { label: "需人工" } },
    currentPageUrl: "https://aivalley.ai/submit-tool/",
    refreshMediaUploadResult: async () => {},
    setAutoFillStatus: (message) => statuses.push(message),
    loadClassifiedList: async () => {},
    loadSubmissionQueue: async () => {},
    cycleSubmission: () => { nextOpened = true; },
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(slice("  async function handleFillResult(", "  async function refreshSiteAnnotation"), context);
  await vm.runInContext('handleFillResult({ needs_manual: true, classified: "needs_manual", semanticReview: true, reason: "站方表单发送失败", advance: false }, "form")', context);
  assert.equal(nextOpened, false, "single-page failure must not open another directory");
  assert.deepEqual(statuses, ["站方表单发送失败"], "show the site failure instead of a generic gate");
}

// A manually opened directory must not launch an unrelated global queue item
// after a receipt or a manual gate. Queue-owned tabs may still advance.
{
  const opened = [];
  const listed = [];
  const context = {
    Promise,
    chrome: { runtime: { sendMessage: async (message) => { listed.push(message); return { ok: true }; } } },
    SITE_STATUS_MAP: { needs_manual: { label: "需人工" } },
    currentPageUrl: "https://directory.example/submit",
    submissionTasks: [{ key: "next", url: "https://next.example/submit" }],
    submissionIndex: 0,
    refreshMediaUploadResult: async () => {},
    setAutoFillStatus() {},
    loadClassifiedList: async () => {},
    loadSubmissionQueue: async () => {},
    closeVerifiedOwnedTab: async () => false,
    cycleSubmission: (...args) => opened.push(args),
    showToast() {},
    Q: { findSubmissionIndex: () => -1 },
  };
  vm.createContext(context);
  vm.runInContext(slice("  async function handleFillResult(", "  async function refreshSiteAnnotation"), context);
  const page = { tabId: 7, expectedUrl: "https://directory.example/submit", profileId: "OldPhotoLive", ownedUrl: "" };
  await vm.runInContext(`handleFillResult({ submitted: true, matched: true, evidence: "Submission Received", receiptTabUrl: "https://directory.example/receipt", ledgerSaved: true, cloudSynced: true, advance: true }, "form", ${JSON.stringify(page)})`, context);
  await vm.runInContext(`handleFillResult({ needs_manual: true, classified: "needs_manual", advance: true }, "form", ${JSON.stringify(page)})`, context);
  assert.deepEqual(opened, [], "single-page actions must not open the global queue");
  assert.equal(listed.length, 1, "newly confirmed source must be added to the library once");
  assert.equal(listed[0].url, page.expectedUrl);
}

// Comment generation also checks the captured tab/Profile after every awaited
// background call, so a slow old draft cannot be written into a new page.
{
  const button = statusElement("生成 3 条");
  const statuses = [];
  const messages = [];
  const context = {
    console,
    Promise,
    URL,
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
    activeTabId: 7,
    currentPageUrl: "https://blog.example/post",
    activeSiteId: "TextComparison",
    siteProfiles: { TextComparison: { name: "TextComparison" } },
    commentAvailability: { available: true, reason: "" },
    P: {
      profileConfigured: () => true,
      buildAgentConfigFromProfile: () => ({}),
    },
    $: (id) => {
      if (id === "btnRegenComment") return button;
      if (id === "commentTone") return { value: "helpful" };
      return null;
    },
    isCurrentFillContext: (tabId, url, profileId) =>
      context.activeTabId === tabId &&
      context.currentPageUrl === url &&
      context.activeSiteId === profileId,
    refreshCommentFieldInfo: async () => {
      context.activeTabId = 8;
      return { text: "article text" };
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(message);
          return Promise.resolve({ ok: true, drafts: [{ text: "old draft" }] });
        },
      },
    },
    setAutoFillStatus(message, cls) {
      statuses.push([message, cls]);
    },
    showToast() {},
  };
  vm.createContext(context);
  vm.runInContext(slice("  async function generateCommentCandidates()", "  function commentIsOverLimit"), context);
  await vm.runInContext("generateCommentCandidates()", context);
  assert.equal(messages.length, 0, "stale comment generation must not call or apply a draft after tab switch");
  assert.match(statuses[0][0], /页面或 Profile 已切换/);
}

console.log("Sidepanel behavior tests passed");

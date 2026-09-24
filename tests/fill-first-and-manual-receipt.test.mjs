import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync('extension/background.js', 'utf8');
const slice = (a,b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
async function fillHarness({ empty = 0, planFails = false } = {}) {
  const calls = [];
  const context = {
    MAX_FILL_ROUNDS: 1,
    applyDestinationFormKnowledge: async () => calls.push('knowledge'),
    broadcastAutoFillUpdate: (event) => calls.push(event.message),
    assertFillContext: async () => {},
    sendTabMessage: async (_, msg) => {
      calls.push(msg.action);
      if (msg.action === 'smartFill') return { filledCount: 3 };
      if (msg.action === 'countEmptyFields') return { emptyCount: empty, invalidCount: 0, totalCount: 4 };
      return { validationFailed: false };
    },
    smartFillAcrossFrames: async () => { calls.push('smartFillAcrossFrames'); return { filledCount: 3 }; },
    countEmptyFieldsAcrossFrames: async () => { calls.push('countEmptyFieldsAcrossFrames'); return { emptyCount: empty, invalidCount: 0, totalCount: 4 }; },
    collectFormValidationAcrossFrames: async () => { calls.push('collectFormValidationAcrossFrames'); return { validationFailed: false }; },
    understandFormBeforeFill: async () => {
      calls.push('plan');
      if (planFails) throw Error('云端请求超时');
      empty = 0;
    },
    runSidepanelAgentFill: async () => { calls.push('vision'); return {}; },
    runValidateAndFixFill: async () => ({ submitReady: true }),
    log() {},
  };
  vm.createContext(context);
  vm.runInContext(slice('async function fillFormUntilReady(', 'async function submitUntilAccepted('), context);
  const result = await context.fillFormUntilReady(7, {}, 'directory');
  return { calls, result };
}
let run = await fillHarness();
assert.ok(run.calls.includes('smartFillAcrossFrames'));
assert.equal(run.calls.includes('plan'), false, 'complete local fields must not wait for a model');
run = await fillHarness({ empty: 1 });
assert.ok(run.calls.indexOf('smartFillAcrossFrames') < run.calls.indexOf('plan'));
assert.equal(run.calls.includes('vision'), false, 'semantic fill success must skip screenshot agent');
run = await fillHarness({ empty: 1, planFails: true });
assert.equal(run.result.smartTotal, 3);
assert.equal(run.result.agentResult.needs_manual, true);
assert.equal(run.result.validation.submitReady, false);
assert.match(run.result.agentResult.reason, /本地已填写 3 个字段/);

const store = {};
const records = [];
const messages = [];
let evidence = { matched: false };
let sourceContext = { ok: true, referrer: "" };
let watchCounter = 0;
let refreshWatchCalls = 0;
const ctx = {
  Set, Date, URL,
  log() {},
  crypto: { randomUUID: () => `watch-token-${++watchCounter}` },
  state: { activeTabs: new Map(), tasks: [] },
  submissionLedgerWrite: async (fn) => fn(),
  chrome: { tabs: { get: async (id) => id === 13
    ? { openerTabId: 99 }
    : id === 99
      ? { url: 'https://aiinfinity-meetpatel.notion.site/AI-Infinity-AI-Tools-Directory-0da673c487124ea2b6f8ebe59b75a231' }
      : { openerTabId: null } }, storage: { local: {
    get: async (key) => ({ [key]: store[key] }),
    set: async (data) => Object.assign(store, data),
    remove: async (key) => { delete store[key]; },
  } } },
  getTabUrlSafe: async () => 'https://directory.example/submit',
  sendTabMessage: async (_, msg) => msg.action === 'classifySubmitEvidence' ? evidence : { ok: true },
  sendTopTabMessage: async (_, msg) => msg.action === 'classifySubmitEvidence'
    ? evidence
    : msg.action === 'getSubmissionSourceContext'
      ? sourceContext
      : { ok: true },
  refreshContentScriptsForManualWatch: async () => { refreshWatchCalls += 1; return { frameIds: [0, 2], enumerated: true }; },
  sendManualSubmissionWatchToFrames: async (_, msg) => msg.action === 'classifySubmitEvidence' ? evidence : { ok: true },
  sendTabMessageToFrame: async (_, _frameId, msg) => msg.action === 'classifySubmitEvidence' ? evidence : { ok: true },
  broadcastAutoFillUpdate: (event) => messages.push(event),
  recordSubmittedProject: async (record) => { records.push(record); return record; },
  sleep: async () => {},
};
vm.createContext(ctx);
vm.runInContext(slice('const manualReceiptChecks = ', 'async function persistFillLearnings('), ctx);
await ctx.armManualSubmissionWatch(7, { id: 'RspAi', name: 'RspAi' }, { targetDomain: 'https://rspai.com' });
assert.equal(refreshWatchCalls, 1, 'arming a watch must refresh already loaded frame scripts');
const firstWatchToken = store['manualSubmissionWatch:7'].token;
assert.equal((await ctx.observeManualSubmissionReceipt(7, 'wrong')).ok, false);
assert.equal(records.length, 0);
await ctx.registerManualSubmissionWatchFrame(7, firstWatchToken, 2, {
  frameUrl: 'https://rspai.typeform.com/to/form',
  baseline: { matched: false, evidence: '' },
});
assert.equal(store['manualSubmissionWatch:7'].frameBaselines['2'].url, 'https://rspai.typeform.com/to/form');
evidence = { matched: true, evidence: 'Submission received', publicationStatus: 'pending_moderation' };
assert.equal((await ctx.observeManualSubmissionReceipt(7, firstWatchToken, 2, {
  frameUrl: 'https://rspai.typeform.com/to/form',
})).ok, true);
assert.equal(records[0].profileId, 'RspAi');
assert.equal(records[0].confirmedBy, 'agent');
assert.equal(records[0].publicationStatus, 'pending_moderation');
assert.equal(records[0].successProof.actionObserved, true);
assert.equal(store['manualSubmissionWatch:7'], undefined);
await ctx.armManualSubmissionWatch(7, { id: 'A' }, {});
const secondWatchToken = store['manualSubmissionWatch:7'].token;
assert.equal((await ctx.observeManualSubmissionReceipt(7, firstWatchToken, 2, {
  frameUrl: 'https://rspai.typeform.com/to/form',
})).ok, false, 'a stale iframe token must not claim a new Profile');
assert.equal((await ctx.observeManualSubmissionReceipt(7, secondWatchToken)).ok, false);
assert.equal(records.length, 1, 'an unchanged preexisting success message must never create a new record');
evidence = { matched: false };
await ctx.armManualSubmissionWatch(7, { id: 'RspAi' }, {});
const thirdWatchToken = store['manualSubmissionWatch:7'].token;
ctx.recordSubmittedProject = async () => { throw Error('storage unavailable'); };
evidence = { matched: true, evidence: 'New submission received' };
assert.equal((await ctx.observeManualSubmissionReceipt(7, thirdWatchToken)).needs_manual, true);
assert.match(messages.at(-1).message, /保存失败.*登记动态/);
assert.ok(store['manualSubmissionWatch:7'], 'failed storage must retain the watch for recovery');

ctx.state.activeTabs = new Map([[8, { taskIndex: 9 }]]);
ctx.state.tasks = [{ index: 9, profileId: 'RspAi', url: 'https://startupstash.com/submit' }];
ctx.getTabUrlSafe = async () => 'https://loxr142exnq.typeform.com/to/RB6ZnEf2';
await ctx.armManualSubmissionWatch(8, { id: 'RspAi' }, { targetDomain: 'https://rspai.com' });
assert.equal(store['manualSubmissionWatch:8'].url, 'https://startupstash.com/submit', 'standalone Typeform watches must retain the original destination URL');
assert.equal(store['manualSubmissionWatch:8'].pageUrl, 'https://loxr142exnq.typeform.com/to/RB6ZnEf2');

ctx.state.activeTabs = new Map();
ctx.state.tasks = [];
ctx.getTabUrlSafe = async () => 'https://loxr142exnq.typeform.com/to/RB6ZnEf2?typeform-source=aitools.inc';
sourceContext = { ok: true, referrer: 'https://aitools.inc/submit' };
await ctx.armManualSubmissionWatch(10, { id: 'GraffitiName' }, { targetDomain: 'https://graffitinameai.com' });
assert.equal(
  store['manualSubmissionWatch:10'].url,
  'https://aitools.inc/submit',
  'a standalone Typeform must resolve to the allowlisted opener directory',
);
sourceContext = { ok: true, referrer: 'https://startupstash.com/submit' };
await assert.rejects(
  ctx.armManualSubmissionWatch(11, { id: 'GraffitiName' }, { targetDomain: 'https://graffitinameai.com' }),
  /未确认来源目录/,
  'a mismatched referrer must not let a copied typeform-source query redirect attribution',
);

ctx.getTabUrlSafe = async () => 'https://docs.google.com/forms/d/e/1FAIpQLSeuaZvj-s7KkI5Zp41q9LX0i9suH61c7JR2qe6sBdDtP9r9Sg/viewform';
sourceContext = {
  ok: true,
  referrer: 'https://aiinfinity-meetpatel.notion.site/AI-Infinity-AI-Tools-Directory-0da673c487124ea2b6f8ebe59b75a231',
};
await ctx.armManualSubmissionWatch(12, { id: 'OldPhotoLive' }, { targetDomain: 'https://oldphotoliveai.com' });
assert.equal(
  store['manualSubmissionWatch:12'].url,
  'https://aiinfinity-meetpatel.notion.site/AI-Infinity-AI-Tools-Directory-0da673c487124ea2b6f8ebe59b75a231',
  'a standalone Google Form must bind to the allowlisted AI Infinity opener',
);
sourceContext = { ok: true, referrer: 'https://forms.gle/' };
await ctx.armManualSubmissionWatch(13, { id: 'GraffitiName' }, { targetDomain: 'https://graffitinameai.com' });
assert.equal(
  store['manualSubmissionWatch:13'].url,
  'https://aiinfinity-meetpatel.notion.site/AI-Infinity-AI-Tools-Directory-0da673c487124ea2b6f8ebe59b75a231',
  'forms.gle redirect must use the browser-owned opener tab to retain the directory attribution',
);

const binding = {
  chrome: { storage: { local: { get: async () => ({ activeSiteId: 'B' }) } } },
  getTabUrlSafe: async () => 'https://directory.example/submit',
};
vm.createContext(binding);
vm.runInContext(slice('async function assertFillContext(', 'async function fillFormUntilReady('), binding);
await assert.rejects(binding.assertFillContext(7, {
  sidepanelContext: { profileId: 'A', url: 'https://directory.example/submit' },
}), /已停止旧填表任务/);
await binding.assertFillContext(7, {}); // Independent batch configs do not use the sidebar selection.
console.log('local-first fill and trusted manual receipt tests passed');
const content = readFileSync('extension/content.js', 'utf8');
const listeners = {};
const clicks = [];
const watcher = {
  window: {},
  URL,
  location: { href: 'https://directory.example/submit' },
  document: {
    addEventListener: (type, listener) => { listeners[type] = listener; },
    querySelector: () => null,
    querySelectorAll: () => [],
  },
  chrome: { runtime: { id: 'test-extension', sendMessage: async (msg) => { clicks.push(msg); return watcherResponse; } } },
  isSubmitControl: () => true,
};
let watcherResponse = { ok: true };
vm.createContext(watcher);
vm.runInContext(content.slice(content.indexOf('  let manualSubmissionWatch'), content.indexOf('  function onExtensionMessage')), watcher);
vm.runInContext("manualSubmissionWatch = { token: 'bound', targetDomain: 'https://rspai.com' };", watcher);
const form = { querySelector: () => ({}), querySelectorAll: () => [{ value: 'https://other.example' }] };
const event = { type: 'submit', isTrusted: false, target: form };
listeners.submit(event);
assert.equal(clicks.length, 0);
event.isTrusted = true;
listeners.submit(event);
assert.equal(clicks.length, 0, 'wrong product URL must not be attributed to the watched Profile');
form.querySelectorAll = () => [{ value: 'https://rspai.com/' }];
listeners.submit(event);
assert.equal(clicks.length, 1);
listeners.submit(event);
assert.equal(clicks.length, 1, 'click plus submit should notify exactly once');
vm.runInContext("manualSubmissionWatch = { token: 'path-variant', targetDomain: 'https://jevplay.com/games' };", watcher);
form.querySelectorAll = () => [{ value: 'https://fakejevplay.com' }];
listeners.submit(event);
assert.equal(clicks.length, 1, 'a different host must not claim the Profile');
form.querySelectorAll = () => [{ value: 'https://www.jevplay.com' }];
listeners.submit(event);
assert.equal(clicks.length, 2, 'a homepage should match a deep-link Profile on the same host');
vm.runInContext("manualSubmissionWatch = { token: 'simple-form', targetDomain: 'https://oldphotoliveai.com' };", watcher);
form.querySelector = () => null;
form.querySelectorAll = () => [{ value: 'https://oldphotoliveai.com', type: 'text', name: 'URL-2' }];
listeners.submit(event);
assert.equal(clicks.length, 3, 'URL-only directory forms should trigger a receipt check');
vm.runInContext("manualSubmissionWatch = { token: 'newsletter', targetDomain: 'https://oldphotoliveai.com' };", watcher);
form.querySelectorAll = () => [{ value: 'https://oldphotoliveai.com', type: 'hidden', name: 'tracking_url' }];
listeners.submit(event);
assert.equal(clicks.length, 3, 'hidden tracking fields must not trigger a receipt check');

watcher.location.href = 'https://form.typeform.com/to/RB6ZnEf2';
vm.runInContext("manualSubmissionWatch = { token: 'typeform-final', targetDomain: 'https://graffitinameai.com', destinationUrl: 'https://startupstash.com/submit' };", watcher);
const typeformButton = {
  tagName: 'BUTTON',
  textContent: 'Submit application',
  getAttribute: (name) => name === 'type' ? 'button' : name === 'data-qa' ? 'submit-button' : '',
  closest: () => null,
};
listeners.click({ type: 'click', isTrusted: true, target: { closest: () => typeformButton } });
assert.equal(clicks.length, 4, 'the final Typeform action should notify the background from its frame');
assert.equal(clicks.at(-1).frameUrl, 'https://form.typeform.com/to/RB6ZnEf2');
listeners.click({ type: 'click', isTrusted: true, target: { closest: () => typeformButton } });
assert.equal(clicks.length, 4, 'the final Typeform action should notify only once');

vm.runInContext("manualSubmissionWatch = { token: 'typeform-next', targetDomain: 'https://graffitinameai.com', destinationUrl: 'https://startupstash.com/submit' };", watcher);
const typeformNextButton = {
  tagName: 'BUTTON',
  textContent: 'Continue',
  getAttribute: (name) => name === 'type' ? 'button' : name === 'data-qa' ? 'continue-button' : '',
  closest: () => null,
};
listeners.click({ type: 'click', isTrusted: true, target: { closest: () => typeformNextButton } });
assert.equal(clicks.length, 4, 'intermediate Typeform controls must not claim a submission');

vm.runInContext("manualSubmissionWatch = { token: 'typeform-retry', targetDomain: 'https://graffitinameai.com', destinationUrl: 'https://startupstash.com/submit' };", watcher);
watcherResponse = { ok: false, needs_manual: true };
listeners.click({ type: 'click', isTrusted: true, target: { closest: () => typeformButton } });
await Promise.resolve();
assert.equal(vm.runInContext("manualSubmissionWatch.token", watcher), 'typeform-retry', 'a failed ledger response must restore the click watch');
watcherResponse = { ok: true };
listeners.click({ type: 'click', isTrusted: true, target: { closest: () => typeformButton } });
assert.equal(clicks.length, 6, 'a recovered Typeform watch should allow one retry');

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
assert.ok(run.calls.includes('smartFill'));
assert.equal(run.calls.includes('plan'), false, 'complete local fields must not wait for a model');
run = await fillHarness({ empty: 1 });
assert.ok(run.calls.indexOf('smartFill') < run.calls.indexOf('plan'));
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
const ctx = {
  Set, Date, URL,
  log() {},
  crypto: { randomUUID: () => 'watch-token' },
  chrome: { storage: { local: {
    get: async (key) => ({ [key]: store[key] }),
    set: async (data) => Object.assign(store, data),
    remove: async (key) => { delete store[key]; },
  } } },
  getTabUrlSafe: async () => 'https://directory.example/submit',
  sendTabMessage: async (_, msg) => msg.action === 'classifySubmitEvidence' ? evidence : { ok: true },
  broadcastAutoFillUpdate: (event) => messages.push(event),
  recordSubmittedProject: async (record) => { records.push(record); return record; },
  sleep: async () => {},
};
vm.createContext(ctx);
vm.runInContext(slice('const manualReceiptChecks = ', 'async function persistFillLearnings('), ctx);
await ctx.armManualSubmissionWatch(7, { id: 'RspAi', name: 'RspAi' }, { targetDomain: 'https://rspai.com' });
assert.equal((await ctx.observeManualSubmissionReceipt(7, 'wrong')).ok, false);
assert.equal(records.length, 0);
evidence = { matched: true, evidence: 'Submission received', publicationStatus: 'pending_moderation' };
assert.equal((await ctx.observeManualSubmissionReceipt(7, 'watch-token')).ok, true);
assert.equal(records[0].profileId, 'RspAi');
assert.equal(records[0].publicationStatus, 'pending_moderation');
assert.equal(records[0].successProof.actionObserved, true);
assert.equal(store['manualSubmissionWatch:7'], undefined);
await ctx.armManualSubmissionWatch(7, { id: 'A' }, {});
assert.equal((await ctx.observeManualSubmissionReceipt(7, 'watch-token')).ok, false);
assert.equal(records.length, 1, 'an unchanged preexisting success message must never create a new record');
evidence = { matched: false };
await ctx.armManualSubmissionWatch(7, { id: 'RspAi' }, {});
ctx.recordSubmittedProject = async () => { throw Error('storage unavailable'); };
evidence = { matched: true, evidence: 'New submission received' };
assert.equal((await ctx.observeManualSubmissionReceipt(7, 'watch-token')).needs_manual, true);
assert.match(messages.at(-1).message, /保存失败.*登记动态/);
assert.ok(store['manualSubmissionWatch:7'], 'failed storage must retain the watch for recovery');

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
  document: { addEventListener: (type, listener) => { listeners[type] = listener; } },
  chrome: { runtime: { id: 'test-extension', sendMessage: async (msg) => clicks.push(msg) } },
  isSubmitControl: () => true,
};
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

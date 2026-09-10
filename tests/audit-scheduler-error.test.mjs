import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function scheduleQueueProcessing('), source.indexOf('async function refreshBatchRunStatus('));
const stored = { status: 'running' };
const context = {
  initializationPromise: Promise.resolve(),
  processQueuePromise: null,
  processQueue: async () => { throw new Error('simulated storage failure'); },
  state: { runId: 'audit-run', running: true, stopped: false, paused: false, queue: [], tasks: [], parkedTaskIds: new Set(), activeTabs: new Map([[1, {slotActive: true}]]) },
  chrome: {storage: {local: {
    get: async () => ({activeBatchRun: structuredClone(stored)}),
    set: async data => Object.assign(stored, structuredClone(data.activeBatchRun)),
  }}},
  runActiveBatchWrite: task => task(),
  serializeBatchTasks: tasks => tasks,
  recordAutomationEvent: async () => {},
  self: { ExtLinkBatchControls: { shouldProcessQueue: s => s.running && !s.paused && !s.stopped } },
  manualCapacityReached: () => false,
  log() {}, broadcastStatus() {},
};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('async function pauseBatchRun('), source.indexOf('async function stopBatchRun(')), context);
vm.runInContext(source.slice(source.indexOf('async function persistActiveBatchStatus('), source.indexOf('function replaceActiveBatchRun(')), context);
vm.runInContext(code, context);
await context.scheduleQueueProcessing();
assert.equal(stored.status, 'paused', 'a scheduler failure must persist a resumable state instead of leaving a phantom running batch');
assert.equal(context.state.paused, true);
assert.equal(context.state.activeTabs.get(1).pauseRequested, true, 'active automated tabs must pause with the queue');
assert.equal(context.processQueuePromise, null);
context.state.stopped = true;
context.state.paused = false;
stored.status = 'stopped';
await context.scheduleQueueProcessing();
assert.equal(stored.status, 'stopped', 'late scheduler failure must preserve explicit stop');
let rejectOldRun;
context.processQueue = () => new Promise((resolve, reject) => { rejectOldRun = reject; });
context.state.stopped = false;
context.state.paused = false;
const oldRun = context.scheduleQueueProcessing();
context.state.runId = 'replacement-run';
stored.status = 'running';
rejectOldRun(new Error('old run failure'));
await oldRun;
assert.equal(stored.status, 'running', 'an old run failure must not pause a replacement batch');
assert.equal(context.state.paused, false);
console.log('scheduler failure recovery regression passed');

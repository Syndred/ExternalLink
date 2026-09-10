import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync('extension/background.js', 'utf8');
const start = source.indexOf('async function resumeBatchRun(');
const end = source.indexOf('function replaceActiveBatchRun(', start);
const stored = { activeBatchRun: { id: 'run-test', status: 'paused', tasks: [] } };
const ctx = {
  initializationPromise: Promise.resolve(),
  state: { paused: true, stopped: false, running: true, activeTabs: new Map(), tasks: [], parkedTaskIds: new Set() },
  chrome: { storage: { local: {
    get: async () => structuredClone(stored),
    set: async data => Object.assign(stored, structuredClone(data)),
  } } },
  runActiveBatchWrite: task => task(),
  serializeBatchTasks: tasks => tasks,
  recordAutomationEvent: async () => {},
  scheduleUnattendedWatchdog: async () => {},
  broadcastStatus() {}, scheduleQueueProcessing() {}, log() {},
};
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);
assert.equal((await ctx.resumeBatchRun()).ok, true);
assert.equal(ctx.state.paused, false);
assert.equal(stored.activeBatchRun.status, 'running', 'explicit resume must persist running so reopening does not restore paused');
stored.activeBatchRun.status = 'paused';
await ctx.persistActiveBatchStatus('running');
assert.equal(stored.activeBatchRun.status, 'paused', 'stale background writes must not undo a later pause');
stored.activeBatchRun.status = 'stopped';
await ctx.persistActiveBatchStatus('running', {}, {allowResume: true});
assert.equal(stored.activeBatchRun.status, 'stopped', 'resume must never undo an explicit stop');
console.log('batch resume persistence regression passed');

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
const start = source.indexOf('$("btnCloudPull")?.addEventListener');
const end = source.indexOf('document.addEventListener("input"', start);
assert.ok(start >= 0 && end > start);

async function run({ consent = true, backupFails = false, editDuringBackup = false, editDuringPull = false, applied = true, initialStatus = 'conflict' } = {}) {
  const trace = [];
  let handler;
  let dirty = false;
  const button = { disabled: false, addEventListener: (event, callback) => { handler = callback; } };
  const state = { siteProfiles: { A: { name: 'remote' } } };
  const context = {
    $: () => button,
    hasUnsavedSettingsEdits: () => dirty,
    hasUnsavedSiteEdits: () => dirty,
    setCloudStatus: () => {},
    confirm: () => { trace.push('confirm'); return consent; },
    downloadSubmissionBackup: async () => {
      trace.push('backup');
      if (backupFails) throw new Error('backup failed');
      if (editDuringBackup) dirty = true;
    },
    adoptPulledSiteProfiles: (received, preserveDraft) => {
      assert.equal(received, state);
      trace.push(preserveDraft ? 'adopt-preserving-draft' : 'adopt');
    },
    location: { reload: () => trace.push('reload') },
    chrome: { runtime: { sendMessage: async message => {
      assert.equal(message.action, 'cloudSyncPull');
      trace.push(message.resolveConflicts ? 'resolve' : 'pull');
      if (editDuringPull) dirty = true;
      if (!message.resolveConflicts && initialStatus !== 'applied') {
        return { ok: true, status: initialStatus, applied: false };
      }
      return { ok: true, applied, state, documentCount: 1 };
    } } },
  };
  vm.runInNewContext(source.slice(start, end), context);
  await handler();
  return { trace, button };
}

assert.deepEqual((await run()).trace, ['pull', 'backup', 'confirm', 'resolve', 'adopt', 'reload']);
const cancelled = await run({ consent: false });
assert.deepEqual(cancelled.trace, ['pull', 'backup', 'confirm']);
assert.equal(cancelled.button.disabled, false);
const failed = await run({ backupFails: true });
assert.deepEqual(failed.trace, ['pull', 'backup'], 'failed backup must never offer or send forced cloud recovery');
assert.equal(failed.button.disabled, false);
assert.deepEqual((await run({ editDuringBackup: true })).trace, ['pull', 'backup'], 'new drafts must stop recovery');
assert.deepEqual((await run({ applied: false })).trace, ['pull', 'backup', 'confirm', 'resolve'], 'a rejected backend apply must not reload');
assert.deepEqual((await run({ initialStatus: 'pending' })).trace, ['pull']);
assert.deepEqual((await run({ initialStatus: 'applied', editDuringPull: true })).trace, ['pull', 'adopt-preserving-draft'], 'adopt fresh profile data without discarding in-flight edits');
// Discarding a timeline edit must release only that editor's dirty marker.
{
  const cancelStart = source.indexOf('cancel.addEventListener("click"');
  const cancelEnd = source.indexOf('form.append(', cancelStart);
  let cancelHandler;
  const dirtyScopes = new Set(['timeline', 'config']);
  const context = {
    cancel: { addEventListener: (event, callback) => { cancelHandler = callback; } },
    editingTimelineEventId: 'editing', fields: {}, fillTimelineForm() {},
    clearNonProfileEditorDirty: scope => dirtyScopes.delete(scope),
  };
  vm.runInNewContext(source.slice(cancelStart, cancelEnd), context);
  cancelHandler();
  assert.equal(dirtyScopes.has('timeline'), false);
  assert.equal(dirtyScopes.has('config'), true);
}

// A fresh form's baseline must be its rendered/normalized form shape, not
// raw cloud JSON (which can omit empty fields and retain extra properties).
{
  const adoptStart = source.indexOf('function adoptPulledSiteProfiles(');
  const adoptEnd = source.indexOf('function captureSiteEditorBaseline(', adoptStart);
  let captures = 0;
  const context = {
    siteProfiles: {}, activeSiteId: 'A', siteEditorBaseline: null,
    renderSiteSelector() {}, profileToForm() {},
    canonicalProfileSnapshot: value => value,
    captureSiteEditorBaseline: () => { captures++; },
  };
  vm.runInNewContext(source.slice(adoptStart, adoptEnd), context);
  context.adoptPulledSiteProfiles({siteProfiles: {A: {name: 'remote'}}}, false);
  assert.equal(captures, 1);
  context.adoptPulledSiteProfiles({siteProfiles: {A: {name: 'new remote'}}}, true);
  assert.equal(captures, 1, 'preserving a draft must not declare its edited form to be a clean baseline');
}
console.log('Settings conflict recovery action flow passed');

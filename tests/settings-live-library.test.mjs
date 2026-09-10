import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/settings.js', import.meta.url), 'utf8');
function extract(name) {
  const match = new RegExp(`  (?:async )?function ${name}\\(`).exec(source);
  assert.ok(match, `missing ${name}`);
  const end = source.indexOf('\n  }', match.index);
  assert.ok(end > match.index);
  return source.slice(match.index, end + 4);
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

// The reverse direction already exists: settings writes update the sidepanel.
{
  const sidepanel = readFileSync(new URL('../extension/sidepanel.js', import.meta.url), 'utf8');
  const start = sidepanel.indexOf('chrome.storage.onChanged.addListener(');
  const end = sidepanel.indexOf('\n  });', start);
  let listener;
  const calls = [];
  const context = {
    chrome: {storage: {onChanged: {addListener: fn => { listener = fn; }}}},
    currentPageUrl: 'https://directory.example/submit',
    loadSubmissionQueue: () => calls.push('queue'),
    loadClassifiedList: () => calls.push('library'),
    refreshSiteAnnotation: async () => calls.push('markers'),
    loadSidepanelTimeline: async () => calls.push('timeline'),
  };
  vm.runInNewContext(sidepanel.slice(start, end + 6), context);
  listener({siteAnnotations: {newValue: {}}}, 'local');
  listener({submissionTimeline: {newValue: {}}}, 'local');
  assert.deepEqual(calls, ['queue', 'library', 'markers', 'timeline']);
  listener({cloudSyncMetadata: {newValue: {}}}, 'local');
  listener({urlList: {newValue: 'ignored'}}, 'sync');
  assert.equal(calls.length, 4);
}

// Keep the actual editor, handlers and focus even if the selected entry disappears.
{
  let focusCalls = 0;
  const field = {value: '未保存的笔记', focus: () => focusCalls++};
  const original = {contains: node => node === field, field};
  let current = original;
  const pane = {querySelector: () => current, append: form => {current = form;}};
  const context = vm.createContext({
    $: () => pane, document: {activeElement: field},
    nonProfileDirtyScopes: new Set(['timeline']), editingTimelineEventId: 'event1',
    selectedLibraryKey: 'example.com',
  });
  vm.runInContext(extract('captureTimelineEditorDraft') + extract('restoreTimelineEditorDraft'), context);
  const draft = context.captureTimelineEditorDraft();
  current = {replaceWith: form => {current = form;}};
  context.restoreTimelineEditorDraft(draft);
  assert.equal(current, original);
  assert.equal(current.field.value, '未保存的笔记');
  assert.equal(focusCalls, 1);
  current = null; // Item deleted remotely: keep draft beneath the missing-item notice.
  context.restoreTimelineEditorDraft(draft);
  assert.equal(current, original);
  context.selectedLibraryKey = 'other.example';
  current = null;
  context.restoreTimelineEditorDraft(draft);
  assert.equal(current, null, 'draft cannot leak across selected sites');
  current = original;
  context.editingTimelineEventId = '';
  context.nonProfileDirtyScopes.clear();
  assert.equal(context.captureTimelineEditorDraft(), null);
}

function refreshContext(extra = {}) {
  const timers = [];
  const context = vm.createContext({
    LIBRARY_STORAGE_KEYS: new Set(['urlList', 'siteAnnotations', 'submissionRecords', 'siteProfiles', 'domainMetricsCache', 'linkMonitorResults', 'submissionTimeline', 'sheetTableData']),
    LIBRARY_REFRESH_DEBOUNCE_MS: 80,
    libraryLoadRequestId: 0, libraryStorageRevision: 0, libraryRefreshTimer: null,
    libraryRefreshPending: false, libraryInitialSyncPending: false,
    libraryStorageListenerInstalled: false,
    libraryItems: [], siteProfiles: {RspAi: {name: 'RspAi'}}, activeSiteId: 'RspAi',
    captureTimelineEditorDraft: () => null, restoreTimelineEditorDraft: () => {},
    hasUnsavedSiteEdits: () => false, orderedSiteIds: () => ['RspAi'],
    renderSiteSelector: () => {}, loadActiveToForm: () => {}, renderLibrary: () => {},
    $: () => null,
    setTimeout: callback => {timers.push(callback); return timers.length;},
    chrome: {runtime: {sendMessage: async () => ({ok: true, items: []})}},
    ...extra,
  });
  vm.runInContext(['storageValuesEqual', 'hasLibraryStorageChanges', 'setLibraryRefreshError', 'scheduleLibraryRefresh', 'onLibraryStorageChanged', 'installLibraryStorageListener', 'loadLibrary'].map(extract).join('\n'), context);
  return {context, timers};
}

// Bursts coalesce; metadata, other storage areas, and equivalent writes cannot loop.
{
  const {context: c, timers} = refreshContext();
  assert.equal(c.onLibraryStorageChanged({cloudSyncMetadata: {newValue: 1}}, 'local'), false);
  assert.equal(c.onLibraryStorageChanged({urlList: {newValue: 'x'}}, 'sync'), false);
  assert.equal(c.onLibraryStorageChanged({siteAnnotations: {oldValue: {a: 1, b: 2}, newValue: {b: 2, a: 1}}}, 'local'), false);
  assert.equal(timers.length, 0);
  assert.equal(c.onLibraryStorageChanged({urlList: {newValue: 'x'}}, 'local'), true);
  c.onLibraryStorageChanged({submissionTimeline: {newValue: {events: [1]}}}, 'local');
  assert.equal(timers.length, 1);
  timers.shift()();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(c.libraryLoadRequestId, 1);
  assert.equal(timers.length, 0);
}

// A late result cannot overwrite a newer request, including an edited Profile.
{
  const older = deferred(), newer = deferred();
  let calls = 0, formLoads = 0, renders = 0;
  const {context: c} = refreshContext({
    chrome: {runtime: {sendMessage: () => (++calls === 1 ? older.promise : newer.promise)}},
    hasUnsavedSiteEdits: () => true,
    loadActiveToForm: () => {formLoads++;}, renderLibrary: () => {renders++;},
  });
  const a = c.loadLibrary(), b = c.loadLibrary();
  newer.resolve({ok: true, items: [{key: 'latest'}], profiles: {Other: {name: 'Other'}}});
  await b;
  older.resolve({ok: true, items: [{key: 'obsolete'}]});
  await a;
  assert.equal(c.libraryItems[0].key, 'latest');
  assert.equal(c.activeSiteId, 'RspAi');
  assert.equal(formLoads, 0);
  assert.equal(renders, 1);
}

// A mutation while a read is in flight invalidates that snapshot and queues a reread.
{
  const pending = deferred();
  const {context: c, timers} = refreshContext({chrome: {runtime: {sendMessage: () => pending.promise}}});
  const read = c.loadLibrary();
  c.onLibraryStorageChanged({siteAnnotations: {newValue: {changed: true}}}, 'local');
  pending.resolve({ok: true, items: [{key: 'stale'}]});
  assert.equal((await read).stale, true);
  assert.equal(c.libraryItems.length, 0);
  assert.equal(timers.length, 1);
}
console.log('settings live library regressions passed');

// Initialization must release the event queue even when a newer manual read overtakes it.
{
  const first = deferred(), second = deferred();
  let calls = 0;
  const {context: c, timers} = refreshContext({
    libraryInitialSyncPending: true,
    chrome: {runtime: {sendMessage: () => (++calls === 1 ? first.promise : second.promise)}},
  });
  const initial = c.loadLibrary({initial: true});
  const manual = c.loadLibrary();
  c.onLibraryStorageChanged({urlList: {newValue: 'new'}}, 'local');
  first.resolve({ok: true, items: []}); await initial;
  second.resolve({ok: true, items: []}); await manual;
  assert.equal(c.libraryInitialSyncPending, false);
  assert.equal(timers.length, 1);
}

// Successful save clears the saved draft before rerender; failed save retains it.
{
  const context = vm.createContext({
    document: {createElement: () => ({
      listeners: {}, append() {}, setAttribute() {},
      addEventListener(name, fn) {this.listeners[name] = fn;},
    })},
    orderedSiteIds: () => [], TIMELINE_TYPES: [], siteProfiles: {},
    editingTimelineEventId: 'event1', nonProfileEditorRevision: 1,
    fillTimelineForm: () => {}, timelinePayload: () => ({}),
    chrome: {runtime: {sendMessage: async () => ({ok: true})}},
    alert: () => {},
    clearNonProfileEditorDirty: () => {order.push('clear');},
    loadLibrary: async () => {order.push('render');},
  });
  const order = [];
  vm.runInContext(extract('createTimelineForm'), context);
  const form = context.createTimelineForm({});
  form.timelineFields.note.value = 'draft';
  await form.listeners.submit({preventDefault() {}});
  assert.deepEqual(order, ['clear', 'render']);
  assert.equal(context.editingTimelineEventId, '');
  assert.equal(form.timelineFields.submit.disabled, false);
  order.length = 0;
  context.chrome.runtime.sendMessage = async () => ({ok: false, error: 'offline'});
  await form.listeners.submit({preventDefault() {}});
  assert.equal(form.timelineFields.note.value, 'draft');
  assert.equal(order.length, 0);
}

// Wiring is installed before the initial storage read, once per settings page.
{
  let installed = 0;
  const {context: c} = refreshContext({chrome: {storage: {onChanged: {addListener: () => installed++}}}});
  c.installLibraryStorageListener(); c.installLibraryStorageListener();
  assert.equal(installed, 1);
  assert.match(source, /installLibraryStorageListener\(\);\s+chrome\.storage\.local\.get/);
  assert.match(source, /loadLibrary\(\{ initial: true \}\)/);
}

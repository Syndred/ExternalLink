import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { applicationMutation, applicationMutationSatisfied } from '../core/application-mutation.mjs';
import { Store } from '../executor/src/store.mjs';
import { workbenchScope } from '../executor/src/workbench-sync.mjs';
import { enqueueLibraryMutation, flushApplicationMutations, overlayApplication, pendingApplication, resolveApplicationConflict } from '../executor/src/application-mutations.mjs';
const url = 'https://target.example/submit', key = 'target.example/submit', domain = 'target.example';
const documents = () => ({ siteProfiles: { p: { id: 'p', name: 'Original' } }, siteAnnotations: { [key]: { status: 'needs_login', note: 'Original note', formKnowledge: { mappings: { Name: 'name' } }, submittedProjects: ['p'], library: { favorite: false, groups: ['high_quality'], profileIds: ['p'], custom: 'keep' } } }, deletedSubmissionKeys: ['other.example'], submissionRecords: { original: { status: 'success', profileId: 'p', evidence: 'Original receipt' } } });
function fixture(store, docs = documents()) {
  const pair = { endpoint: 'https://fixture.invalid', workspaceId: 'library-state' }, scope = workbenchScope(pair), snapshot = { documents: docs, revisions: { siteAnnotations: 1, deletedSubmissionKeys: 2, siteProfiles: 3 } }, writes = [];
  store.set('pair', pair); store.set('paused', true); store.set('applicationSnapshot', { scope, snapshot }); let online = false;
  const runtime = { store, cloud: { async request(route, input) { if (!online) throw Error('offline'); if (route === 'snapshot') return structuredClone(snapshot); writes.push(structuredClone(input)); const change = applicationMutation(snapshot.documents, input.operation); snapshot.documents[change.key] = change.data; snapshot.revisions[change.key] = (snapshot.revisions[change.key] || 0) + 1; throw Error('committed reply lost'); } } };
  return { runtime, snapshot, writes, online() { online = true; } };
}
test('manual multi-mark uses original primary priority and host alias while retaining knowledge, preferences and receipts', () => {
  const docs = documents(), operation = { type: 'mark', id: 'mark', at: 'now', url, statuses: ['can_submit', 'paid', 'needs_login', 'paid'], note: 'Updated note' }, change = applicationMutation(docs, operation);
  assert.equal(change.data[key].status, 'paid'); assert.deepEqual(change.data[key].statuses, ['can_submit', 'paid', 'needs_login']); assert.deepEqual(change.data[domain], change.data[key]);
  assert.equal(change.data[key].auto, false); assert.equal(change.data[key].url, url); assert.equal(change.data[key].domain, domain);
  assert.deepEqual(change.data[key].formKnowledge, docs.siteAnnotations[key].formKnowledge); assert.deepEqual(change.data[key].library, docs.siteAnnotations[key].library); assert.deepEqual(change.data[key].submittedProjects, ['p']);
  assert.deepEqual(docs.submissionRecords, documents().submissionRecords); assert.equal(applicationMutationSatisfied({ ...docs, siteAnnotations: change.data }, operation), true);
});
test('original blank mark note retains the old note and original host alias is required before a lost reply is confirmed', () => {
  const docs = documents(), operation = { type: 'mark', id: 'mark', at: 'now', url, statuses: ['needs_login'], note: '' }, change = applicationMutation(docs, operation);
  assert.equal(change.data[key].note, 'Original note'); assert.equal(applicationMutationSatisfied({ ...docs, siteAnnotations: change.data }, operation), true);
  const missing = structuredClone(change.data); delete missing[domain]; assert.equal(applicationMutationSatisfied({ ...docs, siteAnnotations: missing }, operation), false);
});
test('favorite and enabled preferences share the original host alias until a route has explicit groups', () => {
  const docs = documents(); delete docs.siteAnnotations[key].library.groups;
  const operation = { type: 'preferences', id: 'prefs', at: 'now', url, preferences: { favorite: true } }, change = applicationMutation(docs, operation);
  assert.equal(change.data[key].library.favorite, true); assert.deepEqual(change.data[domain], change.data[key]); assert.equal(change.data[key].url, url); assert.equal(change.data[key].domain, domain);
  assert.equal(Object.hasOwn(change.data[key].library, 'groups'), false); assert.equal(change.data[key].library.custom, 'keep'); assert.equal(applicationMutationSatisfied({ ...docs, siteAnnotations: change.data }, operation), true);
  const explicitDocs = documents(); explicitDocs.siteAnnotations[domain] = { library: { favorite: false, groups: ['free_submit'] } };
  const explicit = applicationMutation(explicitDocs, operation); assert.deepEqual(explicit.data[domain], explicitDocs.siteAnnotations[domain]); assert.deepEqual(explicit.data[key].library.groups, ['high_quality']);
});
test('original group and product preference lists normalize duplicates without discarding other annotation data', () => {
  const docs = documents(), operation = { type: 'preferences', id: 'prefs', at: 'now', url, preferences: { groups: ['high_quality', 'high_quality'], profileIds: ['p', 'p'] } }, change = applicationMutation(docs, operation);
  assert.deepEqual(change.data[key].library.groups, ['high_quality']); assert.deepEqual(change.data[key].library.profileIds, ['p']); assert.equal(change.data[key].note, 'Original note'); assert.equal(applicationMutationSatisfied({ ...docs, siteAnnotations: change.data }, operation), true);
});
test('archiving and restoring an original mark persist a full offline plan and resume original ids after SQLite reopen and lost replies', async () => {
  const home = await mkdtemp(join(tmpdir(), 'el-library-state-')), path = join(home, 'outbox.sqlite'); let store = new Store(path); const f = fixture(store);
  try {
    const archived = await enqueueLibraryMutation(f.runtime, { operation: { type: 'mark', url, statuses: ['deleted', 'needs_login'] } }); assert.equal(archived.pending, 2);
    assert.ok(overlayApplication(f.runtime, f.snapshot).documents.deletedSubmissionKeys.includes(key)); const originalIds = pendingApplication(f.runtime).map(item => item.id);
    store.close(); store = new Store(path); f.runtime.store = store; f.online(); for (let i = 0; i < 4; i++) await flushApplicationMutations(f.runtime);
    assert.deepEqual(f.writes.map(write => write.operation.id), originalIds); assert.ok(f.snapshot.documents.deletedSubmissionKeys.includes(key)); assert.equal(store.get('applicationPlan:' + archived.planId).status, 'completed');
    const restored = await enqueueLibraryMutation(f.runtime, { operation: { type: 'mark', url, statuses: ['can_submit'] } }); for (let i = 0; i < 4; i++) await flushApplicationMutations(f.runtime);
    assert.equal(f.snapshot.documents.deletedSubmissionKeys.includes(key), false); assert.deepEqual(f.snapshot.documents.deletedSubmissionKeys, ['other.example']); assert.equal(store.get('applicationPlan:' + restored.planId).status, 'completed'); assert.deepEqual(f.snapshot.documents.submissionRecords, documents().submissionRecords); assert.equal(store.get('paused'), true);
  } finally { store.close(); assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep)); await rm(home, { recursive: true, force: true }); }
});
test('discarding a concurrent archive mark also cancels its dependent queue exclusion, retaining both records', async () => {
  const store = new Store(':memory:'), f = fixture(store);
  try {
    const plan = await enqueueLibraryMutation(f.runtime, { operation: { type: 'mark', url, statuses: ['deleted'] } }); f.snapshot.documents.siteAnnotations[key].note = 'Concurrent note'; f.snapshot.revisions.siteAnnotations++; f.online(); await flushApplicationMutations(f.runtime);
    const conflict = pendingApplication(f.runtime).find(item => item.status === 'conflict'); await resolveApplicationConflict(f.runtime, { id: conflict.id, choice: 'cloud', revision: f.snapshot.revisions.siteAnnotations });
    assert.equal(f.writes.length, 0); assert.equal(pendingApplication(f.runtime).length, 0); assert.equal(f.snapshot.documents.deletedSubmissionKeys.includes(key), false); assert.equal(f.snapshot.documents.siteAnnotations[key].note, 'Concurrent note'); assert.equal(store.get('applicationPlan:' + plan.planId).excludedIds.length, 2);
  } finally { store.close(); }
});
test('local persistence failure rolls back the original mark and its queue list before cloud access', async () => {
  const store = new Store(':memory:'), f = fixture(store), set = store.set.bind(store);
  store.set = (key, value) => { if (key.startsWith('appMutation:') && value.operation.type === 'set_deleted') throw Error('local storage failure'); return set(key, value); };
  try { await assert.rejects(enqueueLibraryMutation(f.runtime, { operation: { type: 'mark', url, statuses: ['deleted'] } }), /local storage failure/); assert.equal(store.values('applicationPlan:').length, 0); assert.equal(pendingApplication(f.runtime).length, 0); assert.equal(f.writes.length, 0); } finally { store.close(); }
});

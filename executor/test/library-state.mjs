import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import { chromium } from 'playwright';
import { applicationModel } from '../../core/application-model.mjs';
import { applicationMutation } from '../../core/application-mutation.mjs';
import { Store } from '../src/store.mjs';
import { enqueueLibraryMutation, overlayApplication, pendingApplication,flushApplicationMutations } from '../src/application-mutations.mjs';
import { workbenchScope } from '../src/workbench-sync.mjs';
import {originalLibraryGroupPanel} from '../../tests/helpers/original-library-group-panel.mjs';
const first = 'https://automatic.example/submit', second = 'https://disabled.example/submit';
const documents = { siteProfiles: { p: { id: 'p', name: 'Original product', url: 'https://product.example' } }, activeSiteId: 'p', selectedSiteIds: ['p'],
  sheetTableData: { entries: [{ link: first, name: 'Automatic groups', category: 'AI 工具目录', metrics: { dr: 80, da: 60 } }, { link: second, name: 'Disabled explicit groups', category: 'AI 工具目录', metrics: { dr: 60 } }] },
  siteAnnotations: { 'automatic.example/submit': { status: 'can_submit', note: 'Original note', formKnowledge: { mappings: { Name: 'name' } } }, 'disabled.example/submit': { status: 'needs_login', library: { enabled: false, favorite: false, groups: ['high_quality'], profileIds: ['p'] }, note: 'Original disabled note' } },
  deletedSubmissionKeys: ['other.example'], submissionRecords: { original: { status: 'success', profileId: 'p', destinationUrl: first, evidence: 'Original receipt' } },
};
const originalReceipt = structuredClone(documents.submissionRecords), revisions = { siteAnnotations: 1, deletedSubmissionKeys: 1 }, writes = [], errors = [], pair = { endpoint: 'https://fixture.invalid', workspaceId: 'library-editor' };
const home=process.argv.includes('--groups')?await mkdtemp(join(tmpdir(),'el-group-panel-')):null,file=home?join(home,'outbox.sqlite'):':memory:';let store=new Store(file);
let online = true;
const snapshot = () => ({ documents: structuredClone(documents), revisions: { ...revisions } });
const cache = () => store.set('applicationSnapshot', { scope: workbenchScope(pair), snapshot: snapshot() });
store.set('pair', pair); store.set('paused', true); cache();
const runtime = { store, cloud: { async request(route, input) {
  if (!online) throw Error('offline'); if (route === 'snapshot') return snapshot();
  assert.equal(route, 'library'); const change = applicationMutation(documents, input.operation); assert.equal(input.revision, revisions[change.key] || 0);
  documents[change.key] = change.data; revisions[change.key] = (revisions[change.key] || 0) + 1; return { ok: true };
} } };
const baseline = process.argv.includes('--baseline') ? execFileSync('git', ['show', 'HEAD:executor/web/application.js'], { encoding: 'utf8' }) : null;
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const files = { '/': '../web/application.html', '/profiles-core.js': '../../core/profiles.js', '/target-filters-core.js': '../../core/target-filters.js', '/timeline-core.js': '../../core/submission-timeline.js' };
    if (path in files || ['/application.js', '/comment-studio.js', '/setup.js', '/application.css', '/activity-time.js'].includes(path)) {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(path === '/application.js' && baseline ? baseline : await readFile(new URL(files[path] || '../web' + path, import.meta.url))); return;
    }
    let raw = ''; for await (const chunk of req) raw += chunk; const input = raw ? JSON.parse(raw) : {}; let result;
    if (path === '/connection') result = { ok: true };
    else if (path === '/appData') { cache(); const overlaid = overlayApplication(runtime, snapshot()); result = { ok: true, model: applicationModel(overlaid), revisions: { ...revisions }, pendingEdits: store.values('appMutation:').filter(item => item.status === 'pending'), tasks: [], acceptances: [], workbenchBatches: [], settings: {}, assistant: { settings: { enabled: false }, fills: [] }, runtime: { paused: true, busy: false, pendingEvents: 0 } }; }
    else if (path === '/libraryMutation') { writes.push(structuredClone(input.operation)); result = await enqueueLibraryMutation(runtime, input); }
    else throw Error('Unexpected route ' + path);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-extensions'] });
try {
  const context = await browser.newContext(), page = await context.newPage(); page.setDefaultTimeout(7000);page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:' + server.address().port + '/#access=fixture');
  await page.getByRole('button', { name: '外链库', exact: true }).click();
  const row = url => page.locator('tr').filter({ has: page.getByRole('link', { name: url, exact: true }) });
  const open = async url => { await row(url).getByRole('button', { name: '编辑', exact: true }).click(); };
  const close = async () => page.getByRole('button', { name: '关闭详情', exact: true }).click();
  const save = async name => { const reply = page.waitForResponse(response => response.url().endsWith('/libraryMutation')); await page.getByRole('button', { name, exact: true }).click(); await reply; await page.waitForFunction(name => [...document.querySelectorAll('button')].some(node => node.textContent === name && !node.disabled), name); };
  let groupCases=0;
  if(process.argv.includes('--groups')){
    const initial=structuredClone(documents.siteAnnotations['automatic.example/submit']);
    const scenarios=[{name:'automatic',annotation:initial},...['paid','broken','skip','deleted'].map(status=>({name:status,annotation:{status,library:{enabled:true,groups:['high_quality','free_submit']}}})),{name:'disabled',annotation:{status:'can_submit',library:{enabled:false,groups:['high_quality','free_submit']}}},{name:'explicit-empty',annotation:{status:'can_submit',library:{groups:[]}}},{name:'explicit-both',annotation:{status:'can_submit',library:{groups:['high_quality','free_submit']}}}];
    for(const scenario of scenarios){
      documents.siteAnnotations['automatic.example/submit']=structuredClone(scenario.annotation);cache();await page.reload();await page.getByRole('button',{name:'外链库',exact:true}).click();

      await open(first);const current=applicationModel(snapshot()).library.find(item=>item.url===first),reference=originalLibraryGroupPanel({...current,library:current.preferences});
      for(const expected of reference){const input=page.getByLabel(expected.label,{exact:true});assert.equal(await input.isDisabled(),expected.disabled,scenario.name+': '+expected.label);assert.equal(await input.isChecked(),expected.selected,scenario.name+': selected '+expected.label);assert.equal(await input.getAttribute('title')||'',expected.title,scenario.name+': reason '+expected.label);}
      assert.deepEqual(documents.siteAnnotations['automatic.example/submit'],scenario.annotation);groupCases++;await close();
    }
    documents.siteAnnotations['automatic.example/submit']=initial;cache();await page.reload();await page.getByRole('button',{name:'外链库',exact:true}).click();
  }
  await open(first); assert.equal(await page.getByLabel('高质量优先', { exact: true }).isChecked(), true);
  await page.getByLabel('收藏此网站', { exact: true }).check(); await save('保存收藏与分组');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(node => node.textContent === '保存收藏与分组' && !node.disabled));
  assert.deepEqual(writes.at(-1).preferences, { favorite: true }, 'Changing favorite cannot freeze inferred groups as explicit choices');
  assert.equal(Object.hasOwn(documents.siteAnnotations['automatic.example/submit'].library, 'groups'), false);
  assert.deepEqual(documents.siteAnnotations['automatic.example'], documents.siteAnnotations['automatic.example/submit']);
  await page.getByLabel('高质量优先', { exact: true }).uncheck(); await save('保存收藏与分组');
  assert.deepEqual(writes.at(-1).preferences, { groups: [] }); assert.deepEqual(documents.siteAnnotations['automatic.example/submit'].library.groups, []);
  await close(); await open(first); assert.equal(await page.getByLabel('高质量优先', { exact: true }).isChecked(), false); await close();
  if(groupCases){await open(first);await page.getByLabel('高质量优先',{exact:true}).check();await save('保存收藏与分组');assert.deepEqual(documents.siteAnnotations['automatic.example/submit'].library.groups,['high_quality']);await page.getByLabel('免费可提交',{exact:true}).check();await save('保存收藏与分组');assert.deepEqual(documents.siteAnnotations['automatic.example/submit'].library.groups,['high_quality','free_submit']);await close();await open(first);assert.equal(await page.getByLabel('免费可提交',{exact:true}).isChecked(),true);await close();}
  await open(second); assert.equal(await page.getByLabel('高质量优先', { exact: true }).isChecked(), false, 'Original disabled targets retain saved groups but do not match an active group');
  await page.getByLabel('收藏此网站', { exact: true }).check(); await save('保存收藏与分组');
  assert.deepEqual(writes.at(-1).preferences, { favorite: true }); assert.deepEqual(documents.siteAnnotations['disabled.example/submit'].library.groups, ['high_quality']);
  await page.getByLabel('启用此网站', { exact: true }).check(); await save('保存收藏与分组'); assert.deepEqual(writes.at(-1).preferences, { enabled: true });
  await close(); assert.equal(await row(second).getByText('高质量优先', { exact: true }).count(), 1);
  await open(second); await page.getByLabel('已归档', { exact: true }).check(); await page.getByLabel('可以提交', { exact: true }).check();
  await page.getByLabel('站点备注', { exact: true }).fill('New archive note'); await save('保存提交条件');
  await page.getByText('提交条件已保存并回读云端', { exact: true }).waitFor();
  assert.ok(documents.deletedSubmissionKeys.includes('disabled.example/submit')); assert.equal(documents.siteAnnotations['disabled.example/submit'].status, 'deleted');
  assert.deepEqual(documents.siteAnnotations['disabled.example'], documents.siteAnnotations['disabled.example/submit']); assert.deepEqual(documents.siteAnnotations['disabled.example/submit'].library.groups, ['high_quality']);
  await page.getByLabel('已归档', { exact: true }).uncheck(); await save('保存提交条件');
  assert.equal(documents.deletedSubmissionKeys.includes('disabled.example/submit'), false); assert.equal(documents.siteAnnotations['disabled.example/submit'].status, 'needs_login');
  await close(); await open(second); assert.equal(await page.getByLabel('站点备注', { exact: true }).inputValue(), 'New archive note');
  online = false; await page.getByLabel('已归档', { exact: true }).check(); await save('保存提交条件');
  await page.getByText('提交条件已存本机，等待同步', { exact: true }).waitFor();
  const durable = pendingApplication(runtime); assert.equal(durable.length, 2);
  assert.deepEqual(durable.map(item => item.operation.type), ['mark', 'set_deleted']);
  assert.ok(overlayApplication(runtime, snapshot()).documents.deletedSubmissionKeys.includes('disabled.example/submit'));
  assert.deepEqual(documents.submissionRecords, originalReceipt); assert.equal(store.get('paused'), true); assert.deepEqual(errors, []);
  if(groupCases){const ids=durable.map(item=>item.id);store.close();store=new Store(file);runtime.store=store;assert.deepEqual(pendingApplication(runtime).map(item=>item.id),ids);assert.equal(store.get('paused'),true);online=true;for(let i=0;i<3&&pendingApplication(runtime).length;i++)await flushApplicationMutations(runtime);assert.equal(pendingApplication(runtime).length,0);assert.ok(documents.deletedSubmissionKeys.includes('disabled.example/submit'));assert.deepEqual(documents.siteAnnotations['automatic.example/submit'].library.groups,['high_quality','free_submit']);assert.deepEqual(documents.siteAnnotations['disabled.example/submit'].library.groups,['high_quality']);assert.deepEqual(documents.submissionRecords,originalReceipt);}
  console.log('Original inferred and explicit groups, favorite-only patches, disabled group retention, mark primary/host aliases, archive and restore queue keys, durable offline plan, and receipts passed; real submissions 0');
  if(groupCases)console.log(JSON.stringify({ok:true,completeOriginalPanelAndModulesExecuted:true,groupCases,actualGroupAddRemoveSaveReopen:true,sqliteReopenAndCloudRecoveryVerified:true,originalReceiptsPreserved:true,offlinePlanTypes:durable.map(item=>item.operation.type),paused:true,realSubmissions:0,productionWrites:0}));
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); store.close();if(home){assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-group-panel-'));await rm(home,{recursive:true,force:true});} }

import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { applicationModel } from '../../core/application-model.mjs';
import { applicationMutation } from '../../core/application-mutation.mjs';
import { Store } from '../src/store.mjs';
import { enqueueProfileMutation } from '../src/application-mutations.mjs';
import { workbenchScope } from '../src/workbench-sync.mjs';

const documents = {
  siteProfiles: {
    p: { id: 'p', name: 'Original', url: 'https://original.example', language: 'zh', fields: { Name: 'Original', Url: 'https://original.example', Title: 'Original title', 'Featured image': 'https://original.example/cover.png' }, fieldNotes: { Name: 'Original name note' }, mediaVersions: [{ assetId: 'original', kind: 'logo', ref: 'cloud-media://original', sha256: '0'.repeat(64) }] },
    q: { id: 'q', name: 'Other', url: 'https://other.example', fields: { Name: 'Other', Url: 'https://other.example' } },
  },
  activeSiteId: 'p', selectedSiteIds: ['p'], submissionRecords: { keep: { profileId: 'p', status: 'success', evidence: 'Original receipt' } },
};
const originals = structuredClone(documents), revisions = { siteProfiles: 1 }, writes = [], errors = [];
const store = new Store(':memory:'), pair = { endpoint: 'https://fixture.invalid', workspaceId: 'ai-editor' };
let responseProfile = {}, failAi = false, holdAi = false, aiHeld, releaseAi;
const snapshot = () => ({ documents: structuredClone(documents), revisions: { ...revisions } });
const cache = () => store.set('applicationSnapshot', { scope: workbenchScope(pair), snapshot: snapshot() });
store.set('pair', pair); store.set('paused', true); cache();
const runtime = { store, cloud: { async request(route, input) {
  if (route === 'snapshot') return snapshot();
  assert.equal(route, 'profile'); assert.equal(input.revision, revisions.siteProfiles);
  const change = applicationMutation(documents, { type: 'profile', profileId: input.profileId, profile: input.profile, at: new Date().toISOString() });
  documents[change.key] = change.data; revisions.siteProfiles++; return { ok: true };
} } };
const server = http.createServer(async (req, res) => {
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    const files = { '/': '../web/application.html', '/profiles-core.js': '../../core/profiles.js', '/target-filters-core.js': '../../core/target-filters.js', '/timeline-core.js': '../../core/submission-timeline.js' };
    if (path in files || ['/application.js', '/comment-studio.js', '/setup.js', '/application.css', '/activity-time.js'].includes(path)) {
      res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(await readFile(new URL(files[path] || '../web' + path, import.meta.url))); return;
    }
    if (path.startsWith('/cloud/workspace/media/')) { res.writeHead(404); res.end(); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const input = raw ? JSON.parse(raw) : {};
    let result;
    if (path === '/connection') result = { ok: true };
    else if (path === '/appData') { cache(); result = { ok: true, model: applicationModel(snapshot()), revisions: { ...revisions }, runtime: { paused: true, busy: false, pendingEvents: 0 }, assistant: { settings: { enabled: false }, fills: [] }, settings: {}, pendingEdits: [], tasks: [], acceptances: [], workbenchBatches: [] }; }
    else if (path === '/profile') { writes.push({ route: path, ...structuredClone(input) }); result = await enqueueProfileMutation(runtime, input); }
    else if (['/extractProfile', '/generateProfile'].includes(path)) {
      writes.push({ route: path, ...structuredClone(input) });
      if (holdAi) { holdAi = false; aiHeld?.(); await new Promise(resolve => releaseAi = resolve); }
      if (failAi) throw Error('AI provider unavailable');
      result = { ok: true, profile: structuredClone(responseProfile) };
    } else throw Error('Unexpected route ' + path);
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
  } catch (error) { res.writeHead(error.status || 500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: error.message })); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-extensions'] });
try {
  const context = await browser.newContext(), page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.goto('http://127.0.0.1:' + server.address().port + '/#access=fixture');
  await page.getByRole('button', { name: '编辑当前网站', exact: true }).click();
  assert.equal(await page.getByLabel('标志图片网址', { exact: true }).inputValue(), 'https://original.example/cover.png', 'Original Featured image fallback is visible in the logo URL editor');

  await page.getByLabel('提取资料的网站网址', { exact: true }).fill('');
  await page.getByLabel('产品官网', { exact: true }).fill('https://typed.example');
  responseProfile = { id: 'foreign', fields: { Name: 'Extracted', Url: 'https://final.example', Title: 'Extracted title', 'Featured image': 'https://final.example/cover.png' }, language: 'en', promoUrl: 'https://promo.example', media: { screenshots: ['https://final.example/one.png'] }, targetAudience: 'Developers' };
  await page.getByRole('button', { name: '从网站提取资料', exact: true }).click();
  await page.getByText('网站资料已提取并填入表单，请检查后保存。', { exact: true }).waitFor();
  assert.equal(writes.findLast(write => write.route === '/extractProfile').url, 'https://typed.example');
  assert.equal(writes.at(-1).language, 'zh');
  assert.equal(await page.getByLabel('产品名称', { exact: true }).inputValue(), 'Extracted');
  assert.equal(await page.getByLabel('产品官网', { exact: true }).inputValue(), 'https://final.example');
  assert.equal(await page.getByLabel('提取资料的网站网址', { exact: true }).inputValue(), 'https://final.example');
  assert.equal(await page.getByLabel('产品资料语言', { exact: true }).inputValue(), 'en');
  assert.equal(await page.getByLabel('推广网址', { exact: true }).inputValue(), 'https://promo.example');
  assert.equal(await page.getByLabel('标志图片网址', { exact: true }).inputValue(), 'https://final.example/cover.png');
  assert.equal(await page.getByLabel('截图网址（每行一个，最多四张）', { exact: true }).inputValue(), 'https://final.example/one.png');
  assert.deepEqual(documents, originals, 'Extraction stages all changes until explicit save');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByText('已保存并回读云端；历史投稿保留旧版本。', { exact: true }).waitFor();
  assert.equal(documents.siteProfiles.p.logoUrl, 'https://final.example/cover.png'); assert.equal(documents.siteProfiles.p.language, 'en');
  assert.equal(documents.siteProfiles.p.id, 'p'); assert.equal(documents.siteProfiles.p.promoUrl, 'https://promo.example');
  assert.equal(documents.siteProfiles.p.fields['Screenshot-1'], 'https://final.example/one.png');
  assert.deepEqual(documents.siteProfiles.p.mediaVersions, originals.siteProfiles.p.mediaVersions);
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  await page.getByRole('button', { name: '编辑当前网站', exact: true }).click();
  assert.equal(await page.getByLabel('标志图片网址', { exact: true }).inputValue(), documents.siteProfiles.p.logoUrl);

  await page.getByText('字段备注', { exact: true }).click();
  await page.getByLabel('字段备注：宣传标题', { exact: true }).fill('Before request note');
  responseProfile = { fields: { Name: 'AI name', Title: 'AI title', Note: 'AI note' }, fieldNotes: { Name: 'AI note', Title: 'AI title note' }, useCases: ['AI use'], blogRules: { tone: 'professional', maxLinksPerDraft: 4 } };
  const held = new Promise(resolve => aiHeld = resolve); holdAi = true;
  await page.getByRole('button', { name: 'AI 补全产品资料', exact: true }).click(); await held;
  await page.getByLabel('产品名称', { exact: true }).fill('Typed while waiting');
  await page.getByLabel('补充说明', { exact: true }).fill('User note');
  await page.getByLabel('字段备注：宣传标题', { exact: true }).fill('');
  await page.getByLabel('字段备注：产品名称', { exact: true }).fill('User field note');
  await page.getByLabel('每条评论最多链接数', { exact: true }).fill('0');
  const originalWrites = writes.length;
  await page.getByRole('button', { name: '从网站提取资料', exact: true }).click();
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByRole('button', { name: '停用此类媒体', exact: true }).click();
  await page.getByRole('button', { name: '下一个产品', exact: true }).click();
  await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  assert.equal(writes.length, originalWrites, 'Pending AI cannot race another extraction or save');
  assert.equal(await page.locator('dialog').evaluate(node => node.open), true);
  assert.equal(await page.getByLabel('产品名称', { exact: true }).inputValue(), 'Typed while waiting');
  releaseAi(); releaseAi = null;
  await page.getByText('资料草稿已补全，请检查后保存。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('产品名称', { exact: true }).inputValue(), 'Typed while waiting');
  assert.equal(await page.getByLabel('宣传标题', { exact: true }).inputValue(), 'AI title');
  assert.equal(await page.getByLabel('补充说明', { exact: true }).inputValue(), 'User note');
  assert.equal(await page.getByLabel('字段备注：产品名称', { exact: true }).inputValue(), 'User field note');
  assert.equal(await page.getByLabel('字段备注：宣传标题', { exact: true }).inputValue(), '', 'A note cleared while AI is pending stays blank in the editor');
  assert.equal(await page.getByLabel('每条评论最多链接数', { exact: true }).inputValue(), '0');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  assert.equal(await page.locator('dialog').evaluate(node => node.open), true);
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByText('已保存并回读云端；历史投稿保留旧版本。', { exact: true }).waitFor();
  assert.equal(documents.siteProfiles.p.name, 'Typed while waiting'); assert.equal(documents.siteProfiles.p.blogRules.maxLinksPerDraft, 0);
  assert.equal(documents.siteProfiles.p.fields.Title, 'AI title'); assert.equal(documents.siteProfiles.p.fields.Note, 'User note');
  assert.equal(documents.siteProfiles.p.fieldNotes.Name, 'User field note');

  failAi = true;
  await page.getByRole('button', { name: 'AI 补全产品资料', exact: true }).click();
  await page.getByText('资料生成失败，编辑内容保留：AI provider unavailable', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'AI 补全产品资料', exact: true }).isEnabled(), true);
  assert.equal(await page.getByLabel('产品名称', { exact: true }).inputValue(), 'Typed while waiting');
  failAi = false; await page.getByLabel('提取资料的网站网址', { exact: true }).fill(''); await page.getByLabel('产品官网', { exact: true }).fill('');
  const beforeEmpty = writes.length; await page.getByRole('button', { name: '从网站提取资料', exact: true }).click();
  await page.getByText('请先输入网站地址', { exact: true }).waitFor(); assert.equal(writes.length, beforeEmpty);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '关闭详情', exact: true }).click();
  documents.siteProfiles.p.logoUrl = ''; documents.siteProfiles.p.fields.LOGO = '(uploaded logo)'; documents.siteProfiles.p.fields['Featured image'] = 'cloud-media://original'; documents.siteProfiles.p.media.logo = 'cloud-media://original'; revisions.siteProfiles++;
  await page.getByRole('button', { name: '刷新云端', exact: true }).click();
  await page.getByRole('button', { name: '编辑当前网站', exact: true }).click();
  responseProfile = { fields: { Title: 'New title with old uploaded logo' } };
  await page.getByRole('button', { name: 'AI 补全产品资料', exact: true }).click();
  await page.getByText('资料草稿已补全，请检查后保存。', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('标志图片网址', { exact: true }).inputValue(), '', 'Uploaded markers and cloud references cannot become public logo URLs');
  await page.getByRole('button', { name: '保存资料', exact: true }).click();
  await page.getByText('已保存并回读云端；历史投稿保留旧版本。', { exact: true }).waitFor();
  assert.equal(documents.siteProfiles.p.logoUrl, ''); assert.equal(documents.siteProfiles.p.fields.LOGO, '(uploaded logo)'); assert.equal(documents.siteProfiles.p.media.logo, 'cloud-media://original');
  assert.deepEqual(documents.submissionRecords, originals.submissionRecords); assert.deepEqual(documents.siteProfiles.q, originals.siteProfiles.q);
  assert.deepEqual(errors, []); assert.equal(store.get('paused'), true);
  console.log('Original logo fallback, extraction homepage fallback, complete draft controls, explicit save/reopen, AI pending edits and operation ownership, failure retry, and empty URL validation passed; real submissions 0');
} finally { releaseAi?.(); await browser.close(); await new Promise(resolve => server.close(resolve)); store.close(); }

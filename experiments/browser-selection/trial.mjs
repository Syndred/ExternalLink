import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const { url } = JSON.parse(await readFile(path.join(root, 'endpoint.json')));
const runId = String(Date.now());
const namespace = `t-${createHash('sha256').update(root + runId).digest('hex').slice(0, 8)}`;
const evidence = path.join(root, 'evidence', runId);
await mkdir(evidence, { recursive: true });
const attachment = path.join(root, 'attachment.txt');
const fileSha256 = createHash('sha256').update(await readFile(attachment)).digest('hex');
const agentChrome = process.env.TRIAL_AGENT_CHROME;
assert(agentChrome, 'TRIAL_AGENT_CHROME must be the installed Chrome for Testing executable');
const report = { runId, namespace, startedAt: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, fixture: url, scope: 'Synthetic HTTP fixture and public HTTPS navigation; no extension, credentials or production submissions', limitations: ['Crash test restores already-saved state; no in-flight job recovery tested', 'No CAPTCHA, login, payment, production database or submission deduplication tested', 'Timings are diagnostic only; engines and versions differ'], results: {} };
const log = async (entry) => appendFile(path.join(evidence, 'steps.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

class Agent {
  name = 'agent-browser';
  constructor(suffix = '') { this.session = suffix ? 'b' : 'a'; this.profile = path.join(root, `profile-${runId}-agent${suffix}`); }
  async command(...args) {
    const base = ['--config', path.join(root, 'agent-browser.json'), '--namespace', namespace, '--session', this.session, '--profile', this.profile, '--executable-path', agentChrome, '--json'];
    const start = performance.now();
    try {
      const { stdout } = await exec(path.join(root, 'node_modules/.bin/agent-browser'), [...base, ...args], { cwd: root, timeout: 45000, maxBuffer: 1024 * 1024 });
      const result = JSON.parse(stdout);
      await log({ tool: this.name, session: this.session, args, ms: Math.round(performance.now() - start), result });
      assert(result.success, result.error);
      return result.data;
    } catch (error) { await log({ tool: this.name, args, error: String(error), stdout: error.stdout }); if (error.stdout) error.message += '\n' + error.stdout; throw error; }
  }
  async open(target) { return this.command('open', target); }
  async close() { return this.command('close'); }
  async refs() { const data = await this.command('snapshot', '-i'); return (name) => { const matches = Object.entries(data.refs).filter(([, v]) => v.name === name); assert.equal(matches.length, 1, `Unique ref ${name}`); return '@' + matches[0][0]; }; }
  async mark() { let ref = await this.refs(); await this.command('click', ref('Create synthetic session')); ref = await this.refs(); await this.command('click', ref('Save storage marker')); }
  async state() { return { cookie: (await this.command('get', 'text', '#cookie')).text, storage: (await this.command('get', 'text', '#storage')).text }; }
  async submit(product) {
    await this.command('wait', 'input[name=product]');
    const ref = await this.refs();
    await this.command('fill', ref('Product name'), product);
    await this.command('fill', ref('Website'), 'https://example.com/');
    await this.command('fill', ref('Description'), 'Synthetic browser trial 中文字段检查');
    await this.command('select', ref('Category'), 'games');
    await this.command('check', ref('Confirm synthetic test'));
    await this.command('upload', ref('Attachment'), attachment);
    await this.command('click', ref('Submit test'));
    await this.command('wait', '#receipt');
    await this.command('snapshot');
    return (await this.command('get', 'text', '#receipt')).text;
  }
  async screenshot(name) { await this.command('screenshot', path.join(evidence, name)); }
  async external() { const value = await this.open('https://www.selenium.dev/selenium/web/web-form.html'); assert.match(value.title, /Web form/i); const ref = await this.refs(); await this.command('fill', ref('Text input'), 'Synthetic connectivity check'); return value; }
}

class Playwright {
  name = 'playwright';
  constructor(suffix = '') { this.profile = path.join(root, `profile-${runId}-playwright${suffix}`); }
  async open(target) {
    if (!this.context) {
      this.context = await chromium.launchPersistentContext(this.profile, { headless: true, viewport: { width: 1280, height: 1000 } });
      this.context.setDefaultTimeout(10000);
      this.page = this.context.pages()[0] ?? await this.context.newPage();
    }
    await this.page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30000 });
    return { title: await this.page.title(), url: this.page.url(), browser: this.context.browser().version() };
  }
  async close() { await this.context?.close(); this.context = null; }
  async mark() { await this.page.getByRole('link', { name: 'Create synthetic session' }).click(); await this.page.getByRole('button', { name: 'Save storage marker' }).click(); }
  async state() { return { cookie: await this.page.locator('#cookie').innerText(), storage: await this.page.locator('#storage').innerText() }; }
  async submit(product) {
    const page = this.page;
    await page.getByLabel('Product name').fill(product);
    await page.getByLabel('Website').fill('https://example.com/');
    await page.getByLabel('Description').fill('Synthetic browser trial 中文字段检查');
    await page.getByLabel('Category').selectOption('games');
    await page.getByLabel('Confirm synthetic test').check();
    await page.getByLabel('Attachment').setInputFiles(attachment);
    await page.getByRole('button', { name: 'Submit test' }).click();
    return await page.locator('#receipt').innerText();
  }
  async screenshot(name) { await this.page.screenshot({ path: path.join(evidence, name) }); }
  async external() { const result = await this.open('https://www.selenium.dev/selenium/web/web-form.html'); assert.match(result.title, /Web form/i); await this.page.getByLabel('Text input', { exact: true }).fill('Synthetic connectivity check'); return result; }
}

async function crashOwnedBrowser(profile) {
  const { stdout } = await exec('ps', ['-axo', 'pid=,command=']);
  const matches = stdout.split('\n').filter(line => line.includes(`--user-data-dir=${profile}`) && !line.includes('--type='));
  assert.equal(matches.length, 1, 'Kill only the one browser owned by this fresh trial profile');
  const pid = Number(matches[0].trim().split(/\s+/, 1)[0]);
  assert(pid > 1 && pid !== process.pid);
  process.kill(pid, 'SIGKILL');
  await log({ operation: 'crash_owned_browser', profile, pid });
  return pid;
}

for (const Driver of [Agent, Playwright]) {
  const driver = new Driver();
  const result = report.results[driver.name] = { checks: [], receipts: [], normalRestartMs: [], errors: [] };
  async function check(name, fn) {
    const start = performance.now();
    try { const data = await fn(); result.checks.push({ name, pass: true, ms: Math.round(performance.now() - start), data }); console.log(`${driver.name}: PASS ${name}`); }
    catch (error) { result.checks.push({ name, pass: false, ms: Math.round(performance.now() - start), error: String(error) }); result.errors.push(String(error)); console.log(`${driver.name}: FAIL ${name}: ${error.message}`); }
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  }
  try {
    await check('cold-start-and-empty-state', async () => { const data = await driver.open(url); assert.deepEqual(await driver.state(), { cookie: 'absent', storage: 'absent' }); await driver.mark(); return data; });
    for (let cycle = 1; cycle <= 3; cycle++) {
      await check(`normal-restart-${cycle}`, async () => { await driver.close(); const start = performance.now(); const data = await driver.open(url); result.normalRestartMs.push(Math.round(performance.now() - start)); assert.deepEqual(await driver.state(), { cookie: 'present', storage: 'present' }); return data; });
      await check(`form-cycle-${cycle}`, async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          const product = `${runId}-${driver.name}-${cycle}-${attempt}`;
          await driver.open(attempt === 2 ? `${url}/delayed` : url);
          const receiptId = await driver.submit(product);
          const records = await fetch(`${url}/records`).then(r => r.json());
          const matching = records.filter(r => r.product === product);
          assert.equal(matching.length, 1);
          const record = matching[0];
          assert.equal(record.id, receiptId);
          for (const [key, value] of Object.entries({ product, website: 'https://example.com/', description: 'Synthetic browser trial 中文字段检查', category: 'games', confirmed: 'yes', fileName: 'attachment.txt', fileSha256 })) assert.equal(record[key], value);
          result.receipts.push(record);
          await driver.screenshot(`${driver.name}-receipt-${cycle}-${attempt}.png`);
        }
        await driver.screenshot(`${driver.name}-receipt.png`);
        return { verifiedReceipts: 3, delayedForms: 1 };
      });
    }
    await check('crash-and-explicit-relaunch', async () => {
      const pid = await crashOwnedBrowser(driver.profile);
      if (driver instanceof Playwright) { await driver.context.close().catch(() => {}); driver.context = null; }
      const start = performance.now();
      const data = await driver.open(url);
      assert.deepEqual(await driver.state(), { cookie: 'present', storage: 'present' });
      return { killedPid: pid, recoveryMs: Math.round(performance.now() - start), ...data };
    });
    await check('fresh-profile-isolation', async () => { const other = new Driver('-isolated'); try { await other.open(url); assert.deepEqual(await other.state(), { cookie: 'absent', storage: 'absent' }); } finally { await other.close().catch(error => result.errors.push(`isolation cleanup: ${error.message}`)); } });
    await check('public-https', async () => { const data = await driver.external(); await driver.screenshot(`${driver.name}-https.png`); return data; });
  } finally { await check('close-owned-browser', async () => { await driver.close(); const { stdout } = await exec('ps', ['-axo', 'pid=,command=']); assert(!stdout.split('\n').some(line => line.includes(`--user-data-dir=${driver.profile}`)), 'Owned browser process remains'); }); }
}
report.finishedAt = new Date().toISOString();
await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = Object.values(report.results).some(result => result.errors.length) ? 1 : 0;

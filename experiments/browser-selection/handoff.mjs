import { chromium } from 'playwright';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.env.TRIAL_WORKDIR;
assert(root && path.isAbsolute(root), 'TRIAL_WORKDIR must be an isolated absolute directory');
const { url } = JSON.parse(await readFile(path.join(root, 'endpoint.json')));
const profile = path.join(root, 'profile-playwright-handoff');
const evidence = path.join(root, 'evidence');
await mkdir(evidence, { recursive: true });
const log = async (event) => appendFile(path.join(evidence, 'handoff-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
const context = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1100, height: 860 }, args: ['--remote-debugging-port=0'] });
const page = context.pages()[0] ?? await context.newPage();
let owner = 'worker';
let completed = false;
try {
  await page.goto(url);
  await page.getByLabel('Product name').fill('supervisor-takeover-synthetic');
  await page.getByLabel('Website').fill('https://example.com/');
  await page.getByLabel('Description').fill('Worker draft waiting for supervisor correction');
  await page.getByLabel('Category').selectOption('games');
  await page.getByLabel('Confirm synthetic test').check();
  await page.getByLabel('Attachment').setInputFiles(path.join(root, 'attachment.txt'));
  await log({ state: 'worker_filled', owner, url: page.url() });
  try { await page.getByRole('button', { name: 'Old submit label that no longer exists', exact: true }).click({ timeout: 1200 }); }
  catch (error) {
    assert.equal(error.name, 'TimeoutError');
    owner = 'supervisor';
    const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    await page.screenshot({ path: path.join(evidence, 'paused.png') });
    const pending = { state: 'paused_for_supervisor', owner, pid: process.pid, browser: context.browser().version(), executable: chromium.executablePath(), profile, url: page.url(), cdpEndpoint: `http://127.0.0.1:${port}`, reason: 'Injected stale button label timeout; nothing submitted', expectedCorrection: 'Supervisor verified draft' };
    await writeFile(path.join(root, 'handoff.json'), JSON.stringify(pending, null, 2), { mode: 0o600 });
    await log(pending);
    console.log(JSON.stringify(pending));
  }
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    let command;
    try { command = JSON.parse(await readFile(path.join(root, 'resume.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await delay(300); continue; }
    assert.equal(owner, 'supervisor');
    assert.equal(command.owner, 'worker');
    assert.equal(command.action, 'resume');
    assert.equal(await page.getByLabel('Description').inputValue(), 'Supervisor verified draft');
    assert.equal(await page.getByLabel('Product name').inputValue(), 'supervisor-takeover-synthetic');
    await page.screenshot({ path: path.join(evidence, 'supervisor-corrected.png') });
    const before = await fetch(`${url}/records`).then(r => r.json());
    assert.equal(before.length, 0, 'Supervisor must not submit; one submit owner');
    owner = 'worker';
    await log({ state: 'worker_resumed', owner, correctionVerified: true, receiptCountBefore: before.length, takeoverMethod: command.takeoverMethod });
    await page.getByRole('button', { name: 'Submit test', exact: true }).click();
    const receiptId = await page.locator('#receipt').innerText();
    const records = await fetch(`${url}/records`).then(r => r.json());
    assert.equal(records.length, 1);
    assert.equal(records[0].id, receiptId);
    assert.equal(records[0].description, 'Supervisor verified draft');
    await page.screenshot({ path: path.join(evidence, 'verified-receipt.png') });
    await log({ state: 'verified', owner: 'supervisor', receipt: records[0], receiptCount: records.length });
    await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ pass: true, takeoverMethod: command.takeoverMethod, receipt: records[0], receiptCount: records.length, samePage: true, limitation: 'Injected selector fault; not a killed Playwright process or failed Chromium protocol', nativeCua: command.nativeCua }, null, 2));
    completed = true;
    console.log('PASS supervisor takeover, resume, server receipt verified');
    break;
  }
  assert(completed, 'Supervisor did not resume before deadline');
} finally { await context.close(); }

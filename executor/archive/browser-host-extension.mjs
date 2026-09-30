// Owns Chrome's lifetime. Control workers connect over CDP and can exit without
// closing this process or its dedicated profile.
import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repo } from './shared.mjs';
const root = process.env.EXTERNALLINK_HOME || path.join(os.homedir(), '.externallink-executor');
await mkdir(root, { recursive: true });
const profile = path.join(root, 'browser-profile');
const executablePath = process.env.EXTERNALLINK_CHROME || path.join(os.homedir(), '.agent-browser/browsers/chrome-154.0.8037.57/chrome.exe');
const openUrl = process.env.EXTERNALLINK_OPEN_URL || '';
if (openUrl && !['http:', 'https:'].includes(new URL(openUrl).protocol)) throw new Error('登录入口必须为 http/https 网站');
const context = await chromium.launchPersistentContext(profile, {
  executablePath, headless: false, viewport: null,
  args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--disable-extensions-except=${path.join(repo, 'extension')}`, `--load-extension=${path.join(repo, 'extension')}`]
});
const [port] = (await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 30000 });
// This is our dedicated development profile. Chrome 154 disables a command-line
// unpacked extension on runtime.reload unless developer mode is enabled.
if (!openUrl) {
  const extensionSetup = await context.newPage();
  await extensionSetup.goto('chrome://extensions/');
  const developerMode = extensionSetup.locator('#devMode');
  if (await developerMode.getAttribute('aria-checked') === 'false') await developerMode.click();
  await extensionSetup.close();
}
const instance = { pid: process.pid, endpoint: `http://127.0.0.1:${port}`, executablePath, version: context.browser().version(), profile, extensionId: new URL(worker.url()).host, startedAt: new Date().toISOString() };
await writeFile(path.join(root, 'host.json'), JSON.stringify(instance));
const page = openUrl ? await context.newPage() : context.pages()[0] || await context.newPage();
await page.goto(openUrl || `chrome-extension://${instance.extensionId}/settings.html#executor`);
await page.bringToFront();
process.on('SIGTERM', async () => { await context.close(); process.exit(); });
await new Promise(resolve => context.on('close', resolve));

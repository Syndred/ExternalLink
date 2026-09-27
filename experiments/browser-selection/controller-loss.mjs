import { chromium } from 'playwright';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile, mkdir, appendFile, access } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = process.env.TRIAL_WORKDIR;
assert(root && path.isAbsolute(root));
const mode = process.argv[2] ?? 'host';
const stateFile = path.join(root, 'controller-loss-state.json');
const evidence = path.join(root, 'evidence', 'controller-loss');
const resumeFile = path.join(root, 'controller-loss-resume.json');
const log = async data => appendFile(path.join(evidence, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...data }) + '\n');
const readRecords = async url => { const response = await fetch(`${url}/records`); assert(response.ok); return response.json(); };
const targetId = async (context, page) => {
  const session = await context.newCDPSession(page);
  try { return (await session.send('Target.getTargetInfo')).targetInfo.targetId; }
  finally { await session.detach(); }
};

if (mode === 'prepare' || mode === 'resume') {
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  const browser = await chromium.connectOverCDP(state.endpoint);
  const context = browser.contexts()[0];
  assert.equal(context.pages().length, 1);
  const page = context.pages()[0];
  if (mode === 'prepare') {
    await page.goto(state.url);
    await page.getByLabel('Product name').fill('controller-loss-synthetic');
    await page.getByLabel('Website').fill('https://example.com/');
    await page.getByLabel('Description').fill('Worker draft before controller loss');
    await page.getByLabel('Category').selectOption('games');
    await page.getByLabel('Confirm synthetic test').check();
    await page.getByLabel('Attachment').setInputFiles(path.join(root, 'attachment.txt'));
    process.send({ event: 'prepared', pid: process.pid, targetId: await targetId(context, page) });
    // No writes are in flight. The host kills this worker to drop its actual connection.
    setInterval(() => {}, 1000);
  } else {
    assert.equal(await targetId(context, page), state.targetId, 'Must reconnect to the same Chromium target');
    assert.equal(page.url(), state.url + '/');
    assert.equal(await page.getByLabel('Product name').inputValue(), 'controller-loss-synthetic');
    assert.equal(await page.getByLabel('Description').inputValue(), 'Supervisor restored after controller loss');
    assert.equal((await readRecords(state.url)).length, state.beforeCount);
    await page.screenshot({ path: path.join(evidence, 'reconnected-before-submit.png') });
    await page.getByRole('button', { name: 'Submit test', exact: true }).click();
    const id = await page.locator('#receipt').innerText();
    const records = await readRecords(state.url);
    assert.equal(records.length, state.beforeCount + 1);
    const receipt = records.find(item => item.id === id);
    assert.equal(receipt?.description, 'Supervisor restored after controller loss');
    process.send({ event: 'verified', pid: process.pid, targetId: await targetId(context, page), receipt });
    // The separate host owns the browser. End only this controller process.
    process.exit(0);
  }
} else {
  assert.equal(mode, 'host');
  for (const file of [stateFile, resumeFile]) {
    await access(file).then(() => { throw new Error(`Use a fresh trial: ${file} exists`); }, error => { if (error.code !== 'ENOENT') throw error; });
  }
  await mkdir(evidence, { recursive: true });
  const { url } = JSON.parse(await readFile(path.join(root, 'endpoint.json'), 'utf8'));
  assert.equal(new URL(url).hostname, '127.0.0.1');
  const context = await chromium.launchPersistentContext(path.join(root, 'profile-controller-loss'), {
    headless: false, viewport: { width: 1100, height: 860 }, args: ['--remote-debugging-port=0']
  });
  let activeChild;
  try {
    const [port] = (await readFile(path.join(root, 'profile-controller-loss', 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    const state = { url, endpoint: `http://127.0.0.1:${port}`, beforeCount: (await readRecords(url)).length, attemptId: randomUUID() };
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    function child(stage) {
      activeChild = fork(fileURLToPath(import.meta.url), [stage], { env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      return activeChild;
    }
    async function waitMessage(worker, expected) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.kill('SIGKILL'); reject(new Error(`Worker timeout: ${expected}`)); }, 45000);
        worker.once('error', error => { clearTimeout(timer); reject(error); });
        worker.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Worker exited before ${expected}: ${code}/${signal}`)); });
        worker.once('message', message => { clearTimeout(timer); try { assert.equal(message.event, expected); resolve(message); } catch (error) { reject(error); } });
      });
    }
    const initialWorker = child('prepare');
    const ready = await waitMessage(initialWorker, 'prepared');
    state.targetId = ready.targetId;
    await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
    await log({ event: 'worker_prepared', ...ready });
    const dead = once(initialWorker, 'exit');
    initialWorker.kill('SIGKILL');
    const [code, signal] = await dead;
    assert.equal(signal, 'SIGKILL');
    assert.equal((await readRecords(url)).length, state.beforeCount);
    await context.pages()[0].screenshot({ path: path.join(evidence, 'worker-dead-browser-alive.png') });
    await log({ event: 'controller_killed', pid: ready.pid, code, signal, owner: 'supervisor', browserAlive: true, targetId: state.targetId });
    console.log(JSON.stringify({ state: 'controller_dead_native_takeover_ready', attemptId: state.attemptId, url, targetId: state.targetId }));
    let resumed = false;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      let command;
      try { command = JSON.parse(await readFile(resumeFile, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; await delay(300); continue; }
      assert.equal(command.action, 'resume');
      assert.equal(command.attemptId, state.attemptId);
      const recoveryWorker = child('resume');
      const exited = once(recoveryWorker, 'exit');
      const result = await waitMessage(recoveryWorker, 'verified');
      assert.equal((await exited)[0], 0);
      assert.equal(result.targetId, state.targetId);
      await context.pages()[0].screenshot({ path: path.join(evidence, 'verified-receipt.png') });
      await log(result);
      await writeFile(path.join(evidence, 'result.json'), JSON.stringify({ pass: true, fault: 'SIGKILL of connected worker process', originalWorkerPid: ready.pid, recoveryWorkerPid: result.pid, targetIdBefore: state.targetId, targetIdAfter: result.targetId, sameTarget: result.targetId === state.targetId, newReceiptCount: (await readRecords(url)).length - state.beforeCount, receipt: result.receipt, limitation: 'Browser host survived; no network partition, browser-host crash or in-flight submit tested' }, null, 2));
      console.log('PASS controller loss, native correction and reconnect to same target');
      resumed = true;
      break;
    }
    assert(resumed, 'Native takeover did not resume before deadline');
  } finally {
    if (activeChild && activeChild.exitCode === null && activeChild.signalCode === null) activeChild.kill('SIGKILL');
    await context.close();
  }
}

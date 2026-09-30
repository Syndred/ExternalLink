import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright';
import { Cloud } from '../src/cloud.mjs';
import { inventory, selectScope, repo } from '../src/shared.mjs';
const home = process.env.EXTERNALLINK_HOME || path.join(os.homedir(), '.externallink-executor');
const output = path.join(repo, 'docs/evidence/executor-integration-2026-09-27');
await mkdir(output, { recursive: true });
const config = JSON.parse(await readFile(path.join(home,'enrollment.json'),'utf8'));
const cloud = new Cloud(config);
const before = await cloud.request('snapshot');
const diagnostic = await cloud.request('diagnostics', {});
assert(diagnostic.r2Readback); assert(diagnostic.businessDocumentsUnchanged);
const independentlyRead = await cloud.request(`events/${diagnostic.diagnostic.id}`);
assert.deepEqual(independentlyRead.event, diagnostic.diagnostic);
const after = await cloud.request('snapshot');
assert.deepEqual(after.documents, before.documents); assert.deepEqual(after.revisions,before.revisions);
const wrongWorkspace = new Cloud({...config,workspaceId:'not-authorized'});
await assert.rejects(wrongWorkspace.request('snapshot'));
const denied = await fetch(`${config.endpoint}/v1/state/submissionRecords?workspace=default`,{headers:{Authorization:`Bearer ${config.deviceToken}`}});
assert.equal(denied.status,401);
const deniedAdmin = await fetch(`${config.endpoint}/v1/executor/devices?workspace=default`,{method:'POST',headers:{Authorization:`Bearer ${config.deviceToken}`,'Content-Type':'application/json'},body:'{}'});
assert.equal(deniedAdmin.status,401);
const bundled=JSON.parse(await readFile(path.join(repo,'extension/table-library.json'),'utf8'));
const catalog = inventory(after,bundled);
const scope = selectScope(after,bundled,'JevPlay');
assert(scope.exclusions.some(x=>x.url.includes('apprater.net')) || Object.keys(after.documents.submissionRecords).some(k=>k==='apprater.net::JevPlay'));
const instance=JSON.parse(await readFile(path.join(home,'host.json'),'utf8'));
const server=JSON.parse(await readFile(path.join(home,'server.json'),'utf8'));
const browser=await chromium.connectOverCDP(instance.endpoint);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('settings.html')) || await browser.contexts()[0].newPage();
await page.goto(`chrome-extension://${instance.extensionId}/settings.html`);
const connection=await page.evaluate(async()=> (await chrome.storage.local.get('executorConnection')).executorConnection);
if (!connection) {
  const pairing=await readFile(path.join(home,'pairing.txt'),'utf8');
  await page.locator('#executor-endpoint').fill(server.endpoint);
  await page.locator('#executor-code').fill(pairing.match(/一次性配对码：(.+)/)[1]);
  await page.locator('#executor-pair').click();
  await page.waitForFunction(()=>document.querySelector('#executor-status').textContent.includes('配对成功'),null,{timeout:60000});
}
await page.waitForFunction(()=>[...document.querySelector('#executor-profile').options].some(o=>o.value==='JevPlay'));
await page.locator('#executor-profile').selectOption('JevPlay');
await page.locator('#executor-preview').click();
await page.waitForFunction(()=>document.querySelector('#executor-status').textContent.includes('范围预览完成'),null,{timeout:60000});
await page.locator('#executor-workbench').screenshot({path:path.join(output,'formal-pairing-and-library.png')});
const displayed=await page.locator('#executor-scope').innerText();
await browser.close();
assert.equal((await fetch(instance.endpoint+'/json/version')).status,200);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const report={pass:true,at:new Date().toISOString(),endpoint:config.endpoint,workspaceId:config.workspaceId,deviceId:config.deviceId,
  formalDevicePairing:true,cloudTransport:'production Worker / Neon / R2',diagnosticEventId:diagnostic.diagnostic.id,diagnosticIndependentReadback:true,
  r2Readback:true,businessDocumentsUnchanged:true,businessDocumentHashes:diagnostic.before,
  deviceDeniedLegacyAdmin:denied.status,deviceDeniedProvisioning:deniedAdmin.status,wrongWorkspaceDenied:true,
  library:{...catalog,candidates:undefined,eligibleJevPlay:scope.tasks.length,excludedJevPlay:scope.exclusions.length},
  submissionRecords:{count:Object.keys(after.documents.submissionRecords).length,revision:after.revisions.submissionRecords,sha256:hash(after.documents.submissionRecords),protectedReceipts:['apprater.net::JevPlay','sites-plus.com/submit::JevPlay'].map(key=>({key,present:!!after.documents.submissionRecords[key],sha256:hash(after.documents.submissionRecords[key])}))},
  chrome:instance.version,extensionId:instance.extensionId,displayed,browserSurvivedControllerDisconnect:true,
  realSiteSubmissionsThisTest:0,limitation:'This readback check writes only a device diagnostic event and R2 diagnostic object; no production submission receipt is fabricated.'};
await writeFile(path.join(output,'live-cloud-readback.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));

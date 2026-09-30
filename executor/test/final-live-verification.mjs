// Read-only final proof, except reloading the original installed extension.
import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { Cloud } from '../src/cloud.mjs';
import { Store } from '../src/store.mjs';
import { repo } from '../src/shared.mjs';
const home=path.join(os.homedir(),'.externallink-executor');
const output=path.join(repo,'docs/evidence/executor-integration-2026-09-27');
const store=new Store(path.join(home,'outbox.sqlite'),{readOnly:true});
const pair=store.get('pair'); store.close();
const server=JSON.parse(await readFile(path.join(home,'server.json'),'utf8'));
const state=await fetch(server.endpoint+'/status',{headers:{Authorization:`Bearer ${pair.localToken}`}}).then(r=>r.json());
assert(state.paused);assert.equal(state.pendingEvents,0);assert.equal(state.tasks.length,1);
const task=state.tasks[0];assert.equal(task.siteStatus,'not_submitted');assert.equal(task.attentionType,'payment');assert(!task.attemptBoundary);
const cloud=new Cloud(pair), snapshot=await cloud.request('snapshot'), remote=await cloud.request('runs');
const remoteTask=remote.tasks.find(t=>t.id===task.id);
assert.equal(remoteTask.artifactSha256,task.artifactSha256);assert.equal(remoteTask.reason,task.reason);
const artifact=await cloud.request('artifact-read',{taskId:task.id,ref:task.artifactRef});
const bytes=Buffer.from(artifact.dataUrl.split(',')[1],'base64');
assert.equal(createHash('sha256').update(bytes).digest('hex'),task.artifactSha256);
await writeFile(path.join(output,'real-payment-gate.png'),bytes);
const baseline=JSON.parse(await readFile(path.join(output,'live-cloud-readback-initial.json'),'utf8'));
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
assert.equal(hash(snapshot.documents.submissionRecords),baseline.submissionRecords.sha256);
const instance=JSON.parse(await readFile(path.join(home,'host.json'),'utf8'));
const browser=await chromium.connectOverCDP(instance.endpoint);
const context=browser.contexts()[0];
const worker=context.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${instance.extensionId}/`));
if(worker){
  const restarted=context.waitForEvent('serviceworker',{predicate:w=>w.url().startsWith(`chrome-extension://${instance.extensionId}/`),timeout:15000});
  await worker.evaluate(()=>chrome.runtime.reload()).catch(()=>{});
  await restarted;
}
const page=await context.newPage();
await page.goto(`chrome-extension://${instance.extensionId}/settings.html`);
await page.waitForFunction(()=>document.querySelector('#executor-results').innerText.includes('待人工'));
const version=await page.evaluate(()=>chrome.runtime.getManifest().version);assert.equal(version,'3.8.0');
await page.locator('#executor-profile').selectOption('JevPlay');
await page.locator('#executor-preview').click();
await page.waitForFunction(()=>document.querySelector('#executor-scope').textContent.includes('2,915')||document.querySelector('#executor-scope').textContent.includes('2915'));
const displayedScope=await page.locator('#executor-scope').innerText();
await page.locator('#executor-workbench').screenshot({path:path.join(output,'final-original-workbench.png')});
await browser.close();assert.equal((await fetch(instance.endpoint+'/json/version')).status,200);
const report={pass:true,at:new Date().toISOString(),workerVersion:'a4649eb0-aefc-4781-a0ab-d90b223a86a9',extensionVersion:version,
  realCloudTaskReadback:true,independentR2DownloadSha256:task.artifactSha256,hostPreserved:state.host.instance===instance.startedAt,
  task:{...task,screenshot:undefined},profileRevision:snapshot.revisions.siteProfiles,displayedScope,
  originalLedgerUnchanged:true,originalLedgerCount:Object.keys(snapshot.documents.submissionRecords).length,
  fiftySiteBatchStarted:false,realSiteSubmissions:0,paused:state.paused,pendingEvents:state.pendingEvents};
await writeFile(path.join(output,'final-live-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));

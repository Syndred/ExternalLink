// Explicit, single-site acceptance helper. Site is supplied by the operator;
// no fixed acceptance data or website is part of the product executor.
import assert from 'node:assert/strict';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { Store } from '../src/store.mjs';import { Cloud } from '../src/cloud.mjs';import { repo } from '../src/shared.mjs';
const url=process.argv[2];if(!url)throw new Error('需要明确提供一个已授权的真实投稿网址');
const home=process.env.EXTERNALLINK_HOME||path.join(os.homedir(),'.externallink-executor');
const store=new Store(path.join(home,'outbox.sqlite'),{readOnly:true});const pair=store.get('pair');store.close();
const cloud=new Cloud(pair);const before=await cloud.request('snapshot');
const instance=JSON.parse(await readFile(path.join(home,'host.json'),'utf8'));
const server=JSON.parse(await readFile(path.join(home,'server.json'),'utf8'));
const output=path.join(repo,'docs/evidence/executor-integration-2026-09-27',`smoke-${Date.now()}`);await mkdir(output,{recursive:true});
const browser=await chromium.connectOverCDP(instance.endpoint);
const page=browser.contexts()[0].pages().find(p=>p.url().includes('settings.html'))||await browser.contexts()[0].newPage();
const local=async(route,body)=>{const res=await fetch(server.endpoint+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${pair.localToken}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await res.json();if(!res.ok)throw new Error(data.error);return data;};
let report={at:new Date().toISOString(),url,profileId:'JevPlay',scope:'one explicitly selected real site through original extension and sole executor',pass:false};
try{
  await page.goto(`chrome-extension://${instance.extensionId}/settings.html`);
  await page.waitForFunction(()=>[...document.querySelector('#executor-profile').options].some(x=>x.value==='JevPlay'));
  await page.locator('#executor-profile').selectOption('JevPlay');
  await page.locator('#executor-limit').fill('1');
  await page.locator('#executor-urls').evaluate((element,value)=>{element.closest('details').open=true;element.value=value;element.dispatchEvent(new Event('change',{bubbles:true}));},url);
  await page.locator('#executor-preview').click();
  await page.waitForFunction(()=>!document.querySelector('#executor-start').disabled,null,{timeout:60000});
  await page.locator('#executor-start').click();
  await page.waitForFunction(()=>!document.querySelector('#executor-status').textContent.includes('正在处理'),null,{timeout:60000});
  let task;
  for(let i=0;i<150;i++){
    const status=await local('/status');task=status.tasks.find(t=>t.url===url);
    if(task && ['finished','needs_manual','submitted_unconfirmed','excluded'].includes(task.status) && !status.busy)break;
    if(status.cloudError && !status.busy)throw new Error(status.cloudError);
    await delay(1000);
  }
  await local('/pause',{});await local('/sync',{});
  const state=await local('/status');task=state.tasks.find(t=>t.url===url);
  const after=await cloud.request('snapshot');
  for(const [key,value] of Object.entries(before.documents.submissionRecords))assert.deepEqual(after.documents.submissionRecords[key],value,`原账本记录变化：${key}`);
  assert.deepEqual(after.documents.siteAnnotations,before.documents.siteAnnotations);
  await page.locator('#executor-refresh').click();await delay(500);
  await page.locator('#executor-workbench').screenshot({path:path.join(output,'original-plugin.png')});
  report={...report,pass:!!task,task,pendingEvents:state.pendingEvents,originalRecordsUnchanged:true,manualAnnotationsUnchanged:true,
    beforeCount:Object.keys(before.documents.submissionRecords).length,afterCount:Object.keys(after.documents.submissionRecords).length,
    ledgerRevision:after.revisions.submissionRecords,submissionConfirmed:task?.siteStatus==='accepted',cloudReceiptVerified:task?.cloudVerified===true};
}catch(error){report.error=error.stack;process.exitCode=1;}
finally{await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));await browser.close();}

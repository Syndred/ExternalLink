import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { repo, queue } from '../src/shared.mjs';
const output = path.join(repo, 'executor/test-output', new Date().toISOString().replace(/[:.]/g,'-'));
await mkdir(output, { recursive: true });
const profile = { id: 'SyntheticProduct', name: 'Executor Validation', url: 'https://example.com', logoDataUrl:'data:image/png;base64,'+(await readFile(path.join(repo,'extension/icons/icon48.png'))).toString('base64'), fields: { Name: 'Executor Validation', Url: 'https://example.com', 'Business mail': 'test@example.com', 'Short description(20-30 words)': 'A local synthetic product for testing reliable submission and durable recovery.' } };
const docs = { siteProfiles: { SyntheticProduct: profile }, sheetTableData: { entries: [], projects: {} }, urlList: '', submissionRecords: {}, submissionTimeline: {}, siteAnnotations: {} };
const runs = [], tasks = [], events = new Map(), receipts = [];
const artifacts=new Map();
let offline = false, runner, host, browser, page, deviceId = 'synthetic-device';
const report = { scope: 'Real Windows Chrome + original extension + production executor, synthetic HTTP site and cloud transport', startedAt: new Date().toISOString(), checks: [] };
const check = (name, data = {}) => { report.checks.push({ name, pass: true, ...data }); console.log(name); };
const service = http.createServer(async (req,res) => {
  res.setHeader('Content-Type','application/json');
  const route = new URL(req.url,'http://localhost').pathname;
  let raw = ''; for await (const chunk of req) raw += chunk;
  if (route.startsWith('/site/')) {
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(route==='/site/2'){res.end(`<title>Embedded submission</title><iframe title="Submission form" style="width:900px;height:700px;border:0" src="http://localhost:${service.address().port}/site/embedded"></iframe>`);return;}
    res.end(`<title>Submit your product</title><h1>Submit your product</h1><form id="listing"><div id="product_name">Product</div><label>Product name<input id="product_name" name="product_name" required></label><label>Website URL<input name="website" type="url" required></label><label>Email<input name="email" type="email" required></label><label>Description<textarea name="description" required></textarea></label><label>Logo<input name="logo" type="file" accept="image/png" required></label><button type="submit">Submit listing</button></form><script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const fields=Object.fromEntries(new FormData(e.target));const file=fields.logo;fields.logo={name:file.name,type:file.type,size:file.size};const response=await fetch('/receive',{method:'POST',body:JSON.stringify({path:location.pathname,fields})});const record=await response.json();document.body.innerHTML='<h1>Thank you for your submission!</h1><p>Your submission is pending moderation.</p><p id="receipt">'+record.id+'</p>'}</script>`); return;
  }
  if (route === '/receive') { const receipt = { ...JSON.parse(raw), id: `local-${receipts.length+1}` }; receipts.push(receipt); res.end(JSON.stringify(receipt)); return; }
  if (offline) { res.writeHead(503); res.end(JSON.stringify({ ok:false,error:'simulated transport offline' })); return; }
  const input = raw ? JSON.parse(raw) : {};
  const send = data => res.end(JSON.stringify({ ok:true, ...data }));
  if (route.endsWith('/snapshot')) return send({ deviceId,workspaceId:'test',documents:docs,revisions:{siteProfiles:1,submissionRecords:Object.keys(docs.submissionRecords).length} });
  if (route.endsWith('/runs') && req.method === 'GET') return send({runs,tasks});
  if (route.endsWith('/runs')) {
    const run = { ...input.run, profile, tasks: input.run.tasks.map(t=>t.id) }; runs.push(run);
    const made = input.run.tasks.map(t=>({...t,runId:run.id,profileId:run.profileId,version:1,status:'pending',siteStatus:'not_submitted',reviewStatus:'pending_review'})); tasks.push(...made); return send({run,tasks:made});
  }
  if (route.endsWith('/event')) { events.set(input.id,input); const index=tasks.findIndex(t=>t.id===input.taskId); tasks[index]=input.state; return send({eventId:input.id}); }
  if (route.includes('/events/')) return send({event:events.get(route.split('/').at(-1))});
  if (route.endsWith('/receipt')) { docs.submissionRecords[`${input.record.destinationKey}::${input.record.profileId}`]=input.record; return send({record:input.record}); }
  if (route.endsWith('/review')) { const task=tasks.find(t=>t.id===input.taskId); task.reviewStatus=input.reviewStatus; return send({task}); }
  if (route.endsWith('/artifact')) {const hash=createHash('sha256').update(Buffer.from(input.dataUrl.split(',')[1],'base64')).digest('hex');const ref=`cloud-artifact://${hash}`;artifacts.set(ref,input.dataUrl);return send({ref,sha256:hash});}
  if (route.endsWith('/artifact-read')) return send({dataUrl:artifacts.get(input.ref)});
  if (route.endsWith('/lease')) return send({version:1});
  if (route.endsWith('/handoff')) return send({version:input.version+1});
  res.writeHead(404); res.end(JSON.stringify({ok:false,error:'unknown test route'}));
});
await new Promise(resolve=>service.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${service.address().port}`;
docs.sheetTableData.entries = [1,2].map(id=>({link:`${base}/site/${id}`}));
await writeFile(path.join(output,'enrollment.json'),JSON.stringify({endpoint:base,workspaceId:'test',deviceId,deviceToken:'eld_synthetic_fixture'}));
async function spawnProcess(file) {
  const child=spawn(process.execPath,[file],{cwd:path.join(repo,'executor'),windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,EXTERNALLINK_HOME:output,EXTERNALLINK_PORT:'0'}});
  let log=''; child.stdout.on('data',x=>log+=x); child.stderr.on('data',x=>log+=x); child.on('exit',()=>writeFile(path.join(output,path.basename(file)+'.log'),log)); return child;
}
async function until(fn, timeout=60000) { const start=Date.now();let last;while(Date.now()-start<timeout){try{const value=await fn();if(value)return value;}catch(e){last=e;}await delay(150);}throw new Error(`Wait timeout: ${last?.message||''}`); }
async function startRunner() {
  runner=await spawnProcess('src/server.mjs');
  return until(async()=>{const data=JSON.parse(await readFile(path.join(output,'server.json'),'utf8'));return data.pid===runner.pid?data:null;});
}
async function click(id) { await page.locator('#executor-'+id).click(); await until(async()=>!(await page.locator('#executor-status').innerText()).includes('正在处理')); }
async function local(route,body) {
  const connection=await page.evaluate(async()=> (await chrome.storage.local.get('executorConnection')).executorConnection);
  const response=await fetch(connection.endpoint+route,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${connection.localToken}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
  const data=await response.json();if(!response.ok)throw new Error(data.error);return data;
}
try {
  host=await spawnProcess('src/browser-host.mjs');
  const instance=await until(async()=>JSON.parse(await readFile(path.join(output,'host.json'),'utf8')));
  browser=await chromium.connectOverCDP(instance.endpoint);
  const context=browser.contexts()[0]; page=context.pages().find(p=>p.url().includes('settings.html')) || await context.newPage();
  await page.goto(`chrome-extension://${instance.extensionId}/settings.html`);
  await page.evaluate(async profile=>chrome.storage.local.set({siteProfiles:{[profile.id]:profile},activeSiteId:profile.id}),profile); await page.reload();
  await page.locator('#executor-workbench').waitFor();
  const ready=await startRunner();
  const pairing=await readFile(path.join(output,'pairing.txt'),'utf8');
  await page.locator('#executor-endpoint').fill(ready.endpoint);
  await page.locator('#executor-code').fill(pairing.match(/一次性配对码：(.+)/)[1]);
  await click('pair'); assert.match(await page.locator('#executor-status').innerText(),/配对成功/);
  check('original-extension-pairing-button', {chrome:instance.version,extensionId:instance.extensionId});
  assert.equal((await fetch(ready.endpoint+'/status')).status,401);
  const connection=await page.evaluate(async()=> (await chrome.storage.local.get('executorConnection')).executorConnection);
  assert.equal((await fetch(ready.endpoint+'/status',{headers:{Origin:'https://untrusted.invalid',Authorization:`Bearer ${connection.localToken}`}})).status,403);
  check('loopback-auth-and-origin-denial');
  await page.locator('#executor-limit').fill('1');
  await click('preview'); assert.equal(await page.locator('#executor-start').isEnabled(),true);
  await click('start');
  await until(async()=>{const s=await local('/status');const t=s.tasks[0];if(t?.status==='needs_manual'||t?.status==='submitted_unconfirmed')throw new Error(JSON.stringify(t));return t?.cloudVerified;},60000);
  assert.equal(receipts.length,1); assert.equal(receipts[0].fields.website,'https://example.com');
  assert.equal(receipts[0].fields.logo.type,'image/png');assert(receipts[0].fields.logo.size>0);
  await click('refresh');await page.screenshot({path:path.join(output,'plugin-first-receipt.png'),fullPage:true});
  check('shared-engine-fill-submit-and-cloud-readback',{receiptCount:receipts.length});
  await click('pause');assert.equal((await local('/status')).paused,true);await click('resume');
  await page.reload(); await page.locator('#executor-workbench').waitFor();await until(()=>page.locator('#executor-status').innerText().then(t=>t.includes('待同步')));
  check('pause-resume-and-pair-survives-reload');
  await click('preview'); await click('start');
  await until(()=>receipts.length===2); offline=true; runner.kill('SIGKILL'); await until(()=>runner.exitCode!==null || runner.signalCode!==null);
  const hostVersion=await fetch(instance.endpoint+'/json/version');assert.equal(hostVersion.status,200);
  check('worker-killed-browser-host-and-submitted-page-survive');
  const restarted=await startRunner();
  await page.evaluate(async endpoint=>{const {executorConnection}=await chrome.storage.local.get('executorConnection');executorConnection.endpoint=endpoint;await chrome.storage.local.set({executorConnection});},restarted.endpoint);await page.reload();
  await until(()=>page.locator('#executor-status').innerText().then(t=>t.includes('待同步')));
  await local('/pause',{});
  let state=await local('/status');const unknown=state.tasks.find(t=>t.status==='submitted_unconfirmed');assert(unknown);
  await assert.rejects(local('/verify',{taskId:unknown.id}),/offline/);
  state=await local('/status');assert(state.pendingEvents>0);assert.equal(receipts.length,2);
  offline=false;await local('/sync',{});
  state=await local('/status');assert.equal(state.pendingEvents,0);assert.equal(state.tasks.find(t=>t.id===unknown.id).cloudVerified,true);
  check('post-submit-crash-verify-offline-outbox-replay-no-resubmit',{receiptCount:receipts.length});
  await local('/review',{taskId:unknown.id,reviewStatus:'reviewed'});
  await click('refresh');assert.match(await page.locator('#executor-results').innerText(),/已审阅/);
  await page.screenshot({path:path.join(output,'plugin-recovery-review.png'),fullPage:true});
  check('review-visible-in-original-plugin');
  const supervision=await promisify(execFile)(process.execPath,['src/supervise.mjs',unknown.id,'snapshot'],{cwd:path.join(repo,'executor'),windowsHide:true,timeout:120000,maxBuffer:4*1024*1024,env:{...process.env,EXTERNALLINK_HOME:output}});
  const inspected=JSON.parse(supervision.stdout);assert.equal(inspected.target.targetId,unknown.targetId);assert.equal((await fetch(instance.endpoint+'/json/version')).status,200);
  await writeFile(path.join(output,'supervisor-inspection.json'),JSON.stringify(inspected,null,2));
  check('agent-browser-same-target-inspection-disconnect-host-survives'); report.pass=true;
} catch(error) { report.pass=false;report.error=error.stack;if(page)await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});process.exitCode=1; }
finally {
  report.finishedAt=new Date().toISOString();await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
  runner?.kill(); if(browser)await browser.close().catch(()=>{}); host?.kill();service.close();
}

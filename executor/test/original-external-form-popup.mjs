import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {Store} from '../src/store.mjs';
import {observeExternalFormSources,resolveExternalFormSource,externalFormDestination} from '../src/external-form-source.mjs';
import {getTargetInfo} from '../src/browser-target.mjs';
import {originalExternalFormSource} from '../../tests/helpers/original-external-form-source.mjs';
const directory='https://aiinfinity-meetpatel.notion.site/AI-Infinity-AI-Tools-Directory-0da673c487124ea2b6f8ebe59b75a231',short='https://forms.gle/Ze6pdWzmweCfKWnLA',form='https://docs.google.com/forms/d/e/1FAIpQLSeuaZvj-s7KkI5Zp41q9LX0i9suH61c7JR2qe6sBdDtP9r9Sg/viewform';
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']}),context=await browser.newContext(),store=new Store(':memory:'),runtime={context,host:{startedAt:'isolated-popup-browser'},store};let externalRequests=0;
try{
 store.set('pair',{endpoint:'https://cloud.example',workspaceId:'source-fixture'});await observeExternalFormSources(runtime);
 await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith('https://aiinfinity-meetpatel.notion.site/'))return route.fulfill({contentType:'text/html',body:'<a target="_blank" rel="noreferrer" href="'+short+'">Open form</a>'});if(url===short)return route.fulfill({contentType:'text/html',body:'<script>location.replace('+JSON.stringify(form)+')</script>'});if(url===form)return route.fulfill({contentType:'text/html',body:'<h1>Google Forms fixture</h1>'});externalRequests++;return route.abort();});
 const source=await context.newPage();await source.goto(directory);const sourceInfo=await getTargetInfo(context,source),opened=context.waitForEvent('page');await source.getByRole('link').click();const page=await opened;await page.waitForURL(form);const info=await getTargetInfo(context,page);
 assert.equal(await page.evaluate(()=>window.opener),null);const referrer=await page.evaluate(()=>document.referrer);assert.equal(new URL(referrer).hostname,'forms.gle');
 const capture=runtime.externalFormSources.sources.get(info.targetId);assert.ok(capture,'browser target navigation captures noopener source before redirect');assert.equal(capture.sourceUrl,directory);assert.equal(capture.sourceTargetId,sourceInfo.targetId);
 const original=originalExternalFormSource({tabs:{7:{},9:{url:directory}}});await original.capture({sourceTabId:9,tabId:7,url:short});assert.deepEqual(await resolveExternalFormSource(runtime,page),await original.resolve(7,form,referrer));
 capture.capturedAt=Date.now()-11*60*1000;assert.equal(await resolveExternalFormSource(runtime,page),null);await assert.rejects(externalFormDestination(runtime,page),/未确认来源目录/);capture.capturedAt=Date.now();
 await source.goto(directory+'?different-source');assert.equal(await resolveExternalFormSource(runtime,page),null);await source.goto(directory);assert.ok(await resolveExternalFormSource(runtime,page));
 runtime.host.startedAt='another-browser';assert.equal(await resolveExternalFormSource(runtime,page),null);runtime.host.startedAt='isolated-popup-browser';await source.close();assert.equal(await resolveExternalFormSource(runtime,page),null);
 const standalone=await context.newPage();await standalone.goto(form);assert.equal(await resolveExternalFormSource(runtime,standalone),null);assert.equal(externalRequests,0);
 console.log(JSON.stringify({ok:true,actualNoopenerShortLinkCaptured:true,originalCapturedSourceMatched:true,expiredSourceRejected:true,changedSourceRejected:true,closedSourceRejected:true,browserRestartRejected:true,unattributedFormRejected:true,externalRequests,realSubmissions:0,realModelCalls:0}));
}finally{await runtime.externalFormSources?.session.detach().catch(()=>{});store.close();await browser.close();}

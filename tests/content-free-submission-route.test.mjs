import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {chromium} from '../executor/node_modules/playwright/index.mjs';
import {attachEngine} from '../executor/src/engine.mjs';

const core=readFileSync(new URL('../core/form-engine.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const extension=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const names=['findExplicitFreeSubmissionRoute','inspectExplicitFreeSubmissionRoute','prepareExplicitFreeSubmissionRoute',
  'getPaymentElementContext','classifyPaymentContext'];
test('standalone and compatibility copy share free-route proof and payment guards',()=>{
  for(const name of names){
    const pattern=new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?(?=\\n  (?:async )?function |\\n  //)`);
    assert.equal(core.match(pattern)?.[0],extension.match(pattern)?.[0],name);
  }
});

// Derived from the official public AIToolFinder form GET on 2026-10-14.
// The localhost form preserves the exact operational select/disabled-package
// relationship and nearby quote language, with no third-party connections.
function fixture(mode){
  return `<!doctype html><title>Submit a tool</title><style>input,textarea,select,button{display:block;margin:8px;min-height:26px}label{display:block}.field{margin:10px}</style>
    <form id="tool-submit-form"><div class="field"><label for="product-name">Product name</label><input id="product-name" name="productName" required></div>
    <div class="field"><label for="product-url">Product website URL</label><input id="product-url" name="productUrl" type="url" required></div>
    <div class="field"><label for="request-intent">What do you need?</label><select id="request-intent" name="requestIntent" required>
      <option value="">Choose one</option><option value="free">Free editorial consideration — no fee, no promised date</option>
      <option value="listing">Sponsored tool profile — $99 one-time, request a quote</option></select>
      <p>Free consideration stays free and is not invoiced. Paid options are quoted by email before anything is charged.</p></div>
    <div class="field"><label for="requested-package">Preferred paid package</label><select id="requested-package" name="requestedPackage" disabled>
      <option value="">Choose a package if requesting paid placement</option><option value="tool-profile">Sponsored tool profile — $99 one-time</option></select></div>
    <div class="field"><label for="product-pricing">Pricing or access model</label><input id="product-pricing" name="productPricing" required></div>
    <div class="field"><label for="product-summary">Short introduction</label><textarea id="product-summary" name="productSummary" required></textarea></div>
    ${mode==='card'?'<label>Card number<input name="card_number"></label>':''}
    ${mode==='legal'?'<label><input type="checkbox" name="accept_terms" required>I agree to the Terms of Service</label>':''}
    <div class="form-actions"><button type="submit">Submit for review</button><p>Free review has no promised inclusion or date; paid requests receive a written quote before invoicing.</p>
      ${mode==='fee'?'<p>Payment required to submit this listing. Credit card required.</p>':''}</div></form>
    <script>
      const route=document.getElementById('request-intent'),pack=document.getElementById('requested-package');
      window.routeChanges=0;window.submits=0;
      route.addEventListener('change',()=>{window.routeChanges++;pack.disabled=route.value!=='listing';${mode==='rejected'?"route.value='';":''}${mode==='unexpected'?"document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));":''}});
      document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();window.submits++;});
      ${mode==='selected-paid'?"route.value='listing';pack.disabled=false;pack.value='tool-profile';":''}
      ${mode==='stale-paid-package'?"pack.value='tool-profile';":''}
      ${mode==='missing-assurance'?"document.querySelector('#request-intent option[value=free]').textContent='Free editorial consideration';document.querySelector('#request-intent').nextElementSibling.textContent='Pick a request type';":''}
    </script>`;
}

test('real isolated DOM selects only explicitly free route before filling and preserves all hard gates',async t=>{
  let posts=0,external=0;
  const server=createServer((request,response)=>{if(request.method!=='GET'){posts++;response.writeHead(405).end();return;}
    response.setHeader('Content-Type','text/html');response.end(fixture(request.url.slice(1)||'normal'));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
  const context=await browser.newContext({serviceWorkers:'block'});
  await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():(external++,route.abort()));
  const page=await context.newPage(),config={brandName:'Fixture Photo',targetDomain:'https://photo.invalid/',pricing:'Paid',
    projectFields:{Name:'Fixture Photo',Url:'https://photo.invalid/','PRICING TYPE':'Paid',Pricing:'Paid $1.99 per photo',Description:'Restore damaged old photographs with a paid single-photo workflow.'},fillOnly:true};
  for(const mode of ['normal','legal','fee','card','selected-paid','stale-paid-package','missing-assurance','rejected','unexpected']){
    await page.goto(`http://127.0.0.1:${server.address().port}/${mode}`);
    const engine=await attachEngine(context,page.mainFrame(),async()=>({ok:true}));
    try{
      const before=await engine.call({action:'detectPage',config});
      if(['card','selected-paid','stale-paid-package','missing-assurance'].includes(mode)){
        assert.equal(before.freeSubmissionRoute,null,mode+' must not expose a safe preparation route');continue;
      }
      assert.ok(before.freeSubmissionRoute,mode+' must expose observed free choice');
      if(mode==='fee'){
        assert.equal(before.submitBlocker?.blocked,true);
        const refused=await engine.call({action:'prepareExplicitFreeSubmissionRoute',proof:before.freeSubmissionRoute});
        assert.equal(refused.ok,false);assert.equal(await page.locator('#request-intent').inputValue(),'');continue;
      }
      assert.equal(before.submitBlocker?.payment_uncertain,true,'original ambiguous quote wording is reproduced');
      if(mode==='normal'){
        const stale=await engine.call({action:'prepareExplicitFreeSubmissionRoute',proof:{...before.freeSubmissionRoute,signature:'changed'}});
        assert.equal(stale.ok,false);assert.equal(await page.evaluate(()=>window.routeChanges),0);
      }
      const prepared=await engine.call({action:'prepareExplicitFreeSubmissionRoute',proof:before.freeSubmissionRoute});
      if(mode==='rejected'){assert.equal(prepared.ok,false);continue;}
      if(mode==='unexpected'){assert.equal(prepared.ok,false);assert.equal(prepared.unexpectedSubmission,true);continue;}
      assert.equal(prepared.ok,true);
      const after=await engine.call({action:'detectPage',config});
      assert.equal(after.freeSubmissionRoute.selected,true);
      assert.notEqual(after.submitBlocker?.payment_uncertain,true);
      if(mode==='legal')assert.equal(after.submitBlocker?.needs_manual,true,'legal assent remains blocked');
      else assert.equal(after.submitBlocker,null);
      await engine.call({action:'smartFill',config});
      const state=await page.evaluate(()=>({route:document.getElementById('request-intent').value,package:document.getElementById('requested-package').value,
        packageDisabled:document.getElementById('requested-package').disabled,pricing:document.getElementById('product-pricing').value,submits:window.submits,routeChanges:window.routeChanges,
        legal:document.querySelector('[name=accept_terms]')?.checked}));
      assert.equal(state.route,'free');assert.equal(state.package,'');assert.equal(state.packageDisabled,true);
      assert.match(state.pricing,/Paid/);assert.equal(state.submits,0);assert.equal(state.routeChanges,1);
      if(mode==='legal')assert.equal(state.legal,false);
      t.diagnostic(JSON.stringify({mode,beforeGate:'payment_uncertain',afterGate:after.submitBlocker||null,...state,posts,external}));
    }finally{await engine.detach();}
  }
  assert.equal(posts,0);assert.equal(external,0);
});

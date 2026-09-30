import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { attachEngine } from '../src/engine.mjs';
import { profiles, plain } from '../src/shared.mjs';

// Synthetic form regression only: this is never a real-site acceptance receipt.
const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Standalone form regression</title>
<h1>Submit your product</h1><form><label>Product Name<input name="product_name" required></label>
<label>Website URL<input name="website" type="url" required></label>
<label>Contact Email<input name="email" type="email" required></label>
<label>Description<textarea name="description" required></textarea></label>
<label>Category<select name="category"><option value="">Select category</option><option value="productivity">Productivity</option></select></label>
<button type="submit">Submit product</button></form>`);});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
const context=await browser.newContext();
let engine;
try {
  const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  engine=await attachEngine(context,page.mainFrame());
  const profile={id:'regression',name:'Regression Product',url:'https://product.example',fields:{Name:'Regression Product',Url:'https://product.example','Business mail':'regression@example.com','Short description(20-30 words)':'A productivity application to organize projects, track tasks, and coordinate work across teams with clear schedules, shared documents, and useful progress reports.','Tags Keywords/Hashtags':'productivity'}};
  const config={...plain(profiles.buildAgentConfigFromProfile(profile)),fillOnly:true,autoSubmitDirectory:false};
  const detection=await engine.call({action:'detectPage',config});
  assert.equal(detection.operable,true);
  const fill=await engine.call({action:'smartFill',config});
  assert.ok(fill.filledCount>=3,JSON.stringify(fill));
  assert.equal(await page.locator('[name=product_name]').inputValue(),'Regression Product');
  assert.equal(await page.locator('[name=website]').inputValue(),'https://product.example');
  assert.equal(await page.locator('[name=email]').inputValue(),'regression@example.com');
  assert.equal(await page.evaluate(()=>typeof chrome.runtime),'undefined');
  const validation=await engine.call({action:'collectFormValidation'});
  assert.equal(validation.validationFailed,false,JSON.stringify(validation));
  await page.locator('form').evaluate(form=>form.insertAdjacentHTML('beforeend',`<div><label>Product Type *</label><button type="button" role="combobox" aria-haspopup="listbox" data-placeholder>Software or digital product?</button></div><div><label>Pricing *</label><button type="button" role="combobox" aria-haspopup="listbox" data-placeholder>How do you charge for it?</button></div><div><label>Product Logo *</label><div><button type="button" aria-label="Upload logo"><input type="file" style="width:0;height:0;opacity:0" aria-label="file upload"></button></div></div><div><label>Optional screenshot</label><input type="file"></div>`));
  const incomplete=await engine.call({action:'collectFormValidation'});
  assert.equal(incomplete.emptyCount,3,JSON.stringify(incomplete));
  assert.equal(incomplete.validationFailed,true);
  const snapshot=await engine.call({action:'getPageSnapshot'});
  assert.equal(snapshot.fields.find(f=>f.type==='file'&&f.label.includes('Product Logo')).required,true);
  assert.equal(snapshot.fields.filter(f=>f.type==='combobox').every(f=>f.required&&!f.value.present),true);
  await page.locator('[role=combobox]').nth(1).evaluate(trigger=>{trigger.addEventListener('click',()=>{if(document.querySelector('[role=listbox]'))return;const list=document.createElement('div');list.setAttribute('role','listbox');const option=document.createElement('div');option.setAttribute('role','option');option.textContent='Freemium';option.onclick=()=>{trigger.removeAttribute('data-placeholder');trigger.textContent='Freemium';list.remove();};list.append(option);document.body.append(list);});});
  await engine.call({action:'smartFill',config});
  assert.equal(await page.locator('[role=combobox]').nth(1).innerText(),'Freemium','Placeholder prose must not prevent ordinary dropdown fill');
  await page.locator('[role=combobox]').evaluateAll(items=>items.forEach((e,i)=>{e.removeAttribute('data-placeholder');e.textContent=i?'Free':'Software';}));
  await page.locator('button input[type=file]').setInputFiles({name:'logo.png',mimeType:'image/png',buffer:Buffer.from('fixture')});
  const ready=await engine.call({action:'collectFormValidation'});
  assert.equal(ready.emptyCount,0,JSON.stringify(ready));
  const report=await engine.call({action:'getFilledFieldsReport'});
  assert.equal(report.fields.find(f=>f.type==='combobox'&&f.label.includes('Pricing')).value,'Free');
  console.log(JSON.stringify({ok:true,kind:'synthetic_regression',extensionInstalled:false,filledCount:fill.filledCount,validation}));
} finally {await engine?.detach();await browser.close();await new Promise(resolve=>server.close(resolve));}

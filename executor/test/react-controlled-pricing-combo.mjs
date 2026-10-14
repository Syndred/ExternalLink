// Pinned local React assets only; uses an isolated browser with all requests
// intercepted. No user browser, service, database, submission or POST is used.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from '../node_modules/playwright/index.mjs';
import {attachEngine} from '../src/engine.mjs';
const deps=process.env.EXTERNALLINK_REACT_FIXTURE_DEPS||join(tmpdir(),'externallink-react-18-3-1','node_modules');
const [react,reactDom]=await Promise.all([readFile(join(deps,'react/umd/react.production.min.js'),'utf8'),readFile(join(deps,'react-dom/umd/react-dom.production.min.js'),'utf8')]);
const fixture=`<!doctype html><title>Controlled pricing fixture</title><main id="root"></main><script src="/react.js"></script><script src="/react-dom.js"></script><script>
const e=React.createElement,q=new URLSearchParams(location.search),mode=q.get('mode'),reject=q.has('reject'),missing=q.has('missing'),priceLabel=mode==='button'?'Pricing':'Product Pricing';
window.events=[];window.opens=0;window.commits=0;window.paymentOpens=0;window.legalOpens=0;
function App(){
 const [price,setPrice]=React.useState(q.get('initial')==='__empty__'?'':q.get('initial')||'Free'),[open,setOpen]=React.useState(false),[search,setSearch]=React.useState(''),[renders,setRenders]=React.useState(0);
 window.state={price,open,search,renders};
 const options=missing?['Free, no subscription','Freemium']:['Free, no subscription','Freemium with paid upgrades','Paid','Open Source'];
 const commit=label=>{window.commits++;window.events.push(label);if(!reject){setPrice(label.startsWith('Freemium')?'Freemium':label.startsWith('Free')?'Free':label);setSearch('');setOpen(false);}};
 const dropdown=mode==='native'?e('label',null,'Product Pricing',e('select',{name:'pricing',value:price,onChange:event=>commit(event.target.value)},...options.map(label=>e('option',{key:label,value:label==='Free, no subscription'?'Free':label==='Freemium with paid upgrades'?'Freemium':label},label)))):
  e('div',{className:mode==='input'?'css-fixture-container':'fixture-picker'},e('label',{htmlFor:'pricing'},priceLabel),mode==='input'?e(React.Fragment,null,price?e('div',{className:'fixture-singleValue'},price):null,e('input',{id:'pricing',name:'pricing',role:'combobox','aria-label':priceLabel,'aria-controls':'prices','aria-expanded':open,value:search,onChange:event=>setSearch(event.target.value),onClick:()=>{window.opens++;setOpen(true);},onKeyDown:event=>{if(event.key==='ArrowDown')setOpen(true);}})):
   e('button',{id:'pricing',name:'pricing',type:'button',role:'combobox','aria-label':priceLabel,'aria-haspopup':'listbox','aria-expanded':open,onClick:()=>{window.opens++;setOpen(true);}},price||'Select price'),
   open?e('div',{id:'prices',role:'listbox'},...options.map((label,index)=>e('div',{key:label,id:mode==='input'?'react-select-pricing-option-'+index:undefined,role:'option','aria-selected':String(price===label),onClick:()=>commit(label)},label))):null);
 return e('form',{onSubmit:event=>event.preventDefault()},e('h1',null,'Submit product'),
  e('label',null,'Product name',e('input',{name:'tool_name',defaultValue:'OldPhotoLive AI'})),
  e('label',null,'Product website',e('input',{type:'url',name:'tool_url',defaultValue:'https://product.example'})),dropdown,
  e('label',null,'Category',e('select',{name:'category',value:'Design',onChange:()=>window.events.push('unexpected-category')},e('option',{value:'Design'},'Design'),e('option',{value:'Writing'},'Writing'))),
  e('fieldset',null,e('legend',null,'Pay listing fee $49'),e('label',null,'Listing Price',e('select',{id:'payment-price',name:'listing_price',defaultValue:'Free',onChange:()=>window.events.push('unexpected-payment')},e('option',{value:'Free'},'Free'),e('option',{value:'Paid'},'Paid')))),
  e('fieldset',null,e('legend',null,'Pay listing fee $49'),e('button',{type:'button',role:'combobox','aria-label':'Product Pricing','aria-haspopup':'listbox',onClick:()=>window.paymentOpens++},'Select paid listing')),
  e('label',null,'I agree to pricing terms of service',e('button',{type:'button',role:'combobox','aria-label':'I agree to pricing terms of service','aria-haspopup':'listbox',onClick:()=>window.legalOpens++},'Select agreement')),
  e('button',{id:'rerender',type:'button',onClick:()=>setRenders(previous=>previous+1)},'Harmless render'));
}
ReactDOM.createRoot(document.getElementById('root')).render(e(App));
</script>`;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
const context=await browser.newContext();let outsideRequests=0,posts=0,bridgeCalls=0;const results=[];
try{
 await context.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(request.method()==='POST')posts++;
  if(url.hostname!=='pricing-fixture.example'){outsideRequests++;return route.abort();}
  if(url.pathname==='/react.js')return route.fulfill({contentType:'text/javascript',body:react});
  if(url.pathname==='/react-dom.js')return route.fulfill({contentType:'text/javascript',body:reactDom});
  return route.fulfill({contentType:'text/html',body:fixture});});
 const page=await context.newPage();
 for(const mode of ['native','button','input'])for(const [raw,wanted,initial,extra,valid] of [
  ['Paid generation; public browsing is free','Paid','Free','',true],['Freemium: free preview and paid downloads','Freemium','Free','',true],['Free','Free','Paid','',true],
  ['Paid','Paid','Paid','',true],['Paid','Free','Free','&missing=1',false],['Paid','Free','Free','&reject=1',false],
  ['Unknown','Free','Free','',false],...(mode==='input'?[['Paid','','__empty__','&missing=1',false]]:[])]){
  await page.goto('https://pricing-fixture.example/?mode='+mode+'&initial='+initial+extra);await page.waitForFunction(()=>!!window.state);
  if(mode==='native')assert.equal(await page.locator('select[name=pricing] option:checked').evaluate(el=>el.defaultSelected),false);
  const engine=await attachEngine(context,page.mainFrame(),async message=>{bridgeCalls++;assert.ok(['log','saveFillLearnings'].includes(message.action),message.action);return {ok:true};});
  try{
   const config={brandName:'OldPhotoLive AI',targetDomain:'https://product.example',tags:'Writing',projectFields:{'PRICING TYPE':raw}};
   const fill=await engine.call({action:'smartFill',config});assert.equal(fill.ok,true,JSON.stringify(fill));
   await page.locator('#rerender').click();const state=await page.evaluate(()=>window.state);
   assert.equal(state.price,wanted,JSON.stringify({mode,raw,fill,state}));
   const counts=await engine.call({action:'countEmptyFields'}),report=await engine.call({action:'getFilledFieldsReport'});
   assert.equal(counts.invalidCount>0,!valid,JSON.stringify({mode,raw,counts,report}));
   if(valid)assert.equal(report.allValid,true,JSON.stringify(report));
   else assert.ok(report.issues.some(issue=>issue.includes('产品定价未匹配资料')),JSON.stringify(report));
   if(valid&&initial!==wanted){const mapping=Object.values(fill.mappings).find(value=>value.profileKey==='PRICING TYPE');assert.ok(mapping,JSON.stringify(fill));}
   if(initial===wanted&&valid){assert.equal(await page.evaluate(()=>window.commits),0);assert.equal(await page.evaluate(()=>window.opens),0);}
   assert.equal(await page.locator('select[name=category]').inputValue(),'Design');assert.equal(await page.locator('#payment-price').inputValue(),'Free');
   assert.ok(!(await page.evaluate(()=>window.events)).some(event=>event.startsWith('unexpected')));
   assert.equal(await page.evaluate(()=>window.paymentOpens),0);assert.equal(await page.evaluate(()=>window.legalOpens),0);
   results.push({mode,raw,initial,actual:state.price,valid,correctPriceReadback:valid,priceMismatchBlocked:!valid,isolatedEngine:true});
  }finally{await engine.detach();}
 }
 assert.equal(posts,0);assert.equal(outsideRequests,0);
 console.log(JSON.stringify({ok:true,react:'18.3.1',results,posts,outsideRequests,bridgeCalls,realSubmissions:0,productionWrites:0}));
}finally{await context.close();await browser.close();}

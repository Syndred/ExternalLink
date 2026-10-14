// Local React fixture only. Install pinned fixture assets into a temporary
// directory; no production dependency, browser profile, store or service is used.
// npm install --prefix "$env:TEMP/externallink-react-18-3-1" --ignore-scripts --no-audit --no-fund react@18.3.1 react-dom@18.3.1
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {chromium} from '../node_modules/playwright/index.mjs';
import {attachEngine} from '../src/engine.mjs';

const deps=process.env.EXTERNALLINK_REACT_FIXTURE_DEPS||join(tmpdir(),'externallink-react-18-3-1','node_modules');
const [react,reactDom,reactPackage]=await Promise.all([
  readFile(join(deps,'react/umd/react.production.min.js'),'utf8'),
  readFile(join(deps,'react-dom/umd/react-dom.production.min.js'),'utf8'),
  readFile(join(deps,'react/package.json'),'utf8'),
]);
assert.equal(JSON.parse(reactPackage).version,'18.3.1');
const fixture=`<!doctype html><html><head><title>Local controlled product form</title></head><body><main id="root"></main>
<script src="/react.js"></script><script src="/react-dom.js"></script><script>
const e=React.createElement;window.fixtureEvents=[];window.fixturePosts=0;
function Form(){
 const initial=new URLSearchParams(location.search).get('initial')||'';
 const [values,setValues]=React.useState({name:'',url:'',email:'',description:'',pricing_tier:initial,works_browser:false,language:''});
 const [render,setRender]=React.useState(0),[error,setError]=React.useState('');
 window.fixtureState={...values,render,error};
 function change(key,event){const value=event.target.type==='checkbox'?event.target.checked:event.target.value;window.fixtureEvents.push({key,value,type:event.nativeEvent.type});setValues(previous=>({...previous,[key]:value}));}
 const input=(key,label,type='text')=>e('label',{key},label,e('input',{name:key,type,required:true,value:values[key],onChange:event=>change(key,event)}));
 return e('form',{onSubmit:event=>event.preventDefault()},
  e('h1',null,'Submit your product'),input('name','Product name'),input('url','Website','url'),input('email','Email','email'),
  e('label',null,'Description',e('textarea',{name:'description',required:true,value:values.description,onChange:event=>change('description',event)})),
  e('fieldset',null,e('legend',null,'Product Pricing'),...['Free','Freemium','Paid','Open Source'].map(label=>{const value=label.toLowerCase().replace(/ /g,'_');return e('label',{key:value},e('input',{type:'radio',name:'pricing_tier',value,required:true,checked:values.pricing_tier===value,onChange:event=>change('pricing_tier',event)}),e('span',{'data-price':value,'data-selected':String(values.pricing_tier===value)},label));})),
  e('label',null,'Works in browser',e('input',{type:'checkbox',name:'works_browser',checked:values.works_browser,onChange:event=>change('works_browser',event)})),
  e('label',null,'Language',e('select',{name:'language',required:true,value:values.language,onChange:event=>change('language',event)},e('option',{value:''},'Select language'),e('option',{value:'english'},'English'),e('option',{value:'french'},'French'))),
  e('button',{type:'button',id:'rerender',onClick:()=>setRender(previous=>previous+1)},'Harmless render'),
  e('button',{type:'button',id:'local-submit',onClick:()=>{if(!window.fixtureToken){setError('Verification missing');return;}window.fixturePosts++;window.fixtureSubmitted={...values};setError('Accepted locally');}},'Local submit'),
  e('div',{'aria-live':'polite'},error)
 );
}
ReactDOM.createRoot(document.getElementById('root')).render(e(Form));
</script></body></html>`;
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
const context=await browser.newContext();let outsideRequests=0,bridgeCalls=0;
try{
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  if(url.hostname!=='react-fixture.example'){outsideRequests++;return route.abort();}
  if(url.pathname==='/react.js')return route.fulfill({contentType:'text/javascript',body:react});
  if(url.pathname==='/react-dom.js')return route.fulfill({contentType:'text/javascript',body:reactDom});
  if(url.pathname==='/submit')return route.fulfill({contentType:'text/html',body:fixture});
  return route.abort();
 });
 const page=await context.newPage();
 await page.goto('https://react-fixture.example/submit');await page.waitForFunction(()=>!!window.fixtureState);
 const session=await context.newCDPSession(page),tree=await session.send('Page.getFrameTree');
 const oldContext=(await session.send('Page.createIsolatedWorld',{frameId:tree.frameTree.frame.id,worldName:'LocalOldCheckedFixture'})).executionContextId;
 const oldSource=execFileSync('git',['show','HEAD:core/form-engine.js'],{encoding:'utf8'});
 const checkedSlice=oldSource.slice(oldSource.indexOf('  function setCheckedValue('),oldSource.indexOf('  function setSelectValue('));
 await session.send('Runtime.evaluate',{contextId:oldContext,expression:`${checkedSlice};for(const element of [document.querySelector('input[value="freemium"]'),document.querySelector('input[type="checkbox"]')]){setCheckedValue(element,true);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));}`});
 assert.equal(await page.locator('input[value=freemium]').isChecked(),true);
 assert.equal((await page.evaluate(()=>window.fixtureState)).pricing_tier,'');
 assert.equal((await page.evaluate(()=>window.fixtureState)).works_browser,false);
 await page.locator('#rerender').click();
 assert.equal(await page.locator('input[value=freemium]').isChecked(),false);
 assert.equal(await page.locator('input[type=checkbox]').isChecked(),false);
 await session.detach();
 await page.locator('input[value=freemium]').check();await page.locator('input[type=checkbox]').check();
 await page.locator('#rerender').click();
 assert.equal((await page.evaluate(()=>window.fixtureState)).pricing_tier,'freemium');
 assert.equal((await page.evaluate(()=>window.fixtureState)).works_browser,true);
 const baseline={oldSetterDidNotUpdateReact:true,oldDomChoiceLostOnRender:true,userClickUpdatesReact:true};
 const results=[];
 for(const [raw,wanted,initial] of [['Freemium: free preview and paid unlock','freemium',''],['Paid generation with credits. Public browsing is free.','paid','free']]){
  await page.goto('https://react-fixture.example/submit?initial='+initial);await page.waitForFunction(()=>!!window.fixtureState);
  const engine=await attachEngine(context,page.mainFrame(),async message=>{bridgeCalls++;assert.ok(['log','saveFillLearnings'].includes(message.action),message.action);return {ok:true};});
  try{
   const config={brandName:'OldPhotoLive AI',targetDomain:'https://product.example',email:'owner@example.com',
    projectFields:{Name:'OldPhotoLive AI',Url:'https://product.example','Business mail':'owner@example.com','Short description(20-30 words)':'Restore old family photographs and animate images with simple photo editing tools.','PRICING TYPE':raw}};
   await page.evaluate(()=>{const challenge=document.createElement('div');challenge.className='g-recaptcha';document.querySelector('form').append(challenge);});
   const fill=await engine.call({action:'smartFill',config});assert.equal(fill.ok,true,JSON.stringify(fill));
   assert.equal(fill.mappings.pricing_tier.profileKey,'PRICING TYPE',JSON.stringify(fill));
   const checked=await engine.call({action:'executeActionPlan',actions:[{type:'check',selector:'input[name=works_browser]',value:true}]});
   assert.equal(checked.ok,true,JSON.stringify(checked));
   const once=(await page.evaluate(()=>window.fixtureEvents)).filter(event=>event.key==='works_browser').length;
   assert.equal(once,1);
   assert.equal((await engine.call({action:'executeActionPlan',actions:[{type:'check',selector:'input[name=works_browser]',value:true}]})).ok,true);
   assert.equal((await page.evaluate(()=>window.fixtureEvents)).filter(event=>event.key==='works_browser').length,once);
   await page.locator('#rerender').click();await page.locator('#local-submit').click();
   const state=await page.evaluate(()=>window.fixtureState);
   assert.equal(state.pricing_tier,wanted);assert.equal(state.works_browser,true);
   assert.equal(state.name,config.brandName);assert.equal(state.url,config.targetDomain);assert.equal(state.email,config.email);
   assert.equal(state.description,config.projectFields['Short description(20-30 words)']);assert.equal(state.language,'english');
   assert.equal(state.error,'Verification missing');assert.equal(await page.evaluate(()=>window.fixturePosts),0);
   assert.equal(await page.locator('input[value='+wanted+']').isChecked(),true);
   assert.equal(await page.locator('[data-price='+wanted+']').getAttribute('data-selected'),'true');
   const events=await page.evaluate(()=>window.fixtureEvents);
   for(const key of ['name','url','email','description','pricing_tier','works_browser','language'])assert.ok(events.some(event=>event.key===key),'missing React onChange '+key);
   assert.equal(events.find(event=>event.key==='pricing_tier').type,'click');
   assert.equal(events.find(event=>event.key==='works_browser').type,'click');
   const unchecked=await engine.call({action:'executeActionPlan',actions:[{type:'check',selector:'input[name=works_browser]',value:false}]});assert.equal(unchecked.ok,true,JSON.stringify(unchecked));
   await page.locator('#rerender').click();assert.equal((await page.evaluate(()=>window.fixtureState)).works_browser,false);
   await page.evaluate(()=>{window.fixtureToken='local-only';});await page.locator('#local-submit').click();
   assert.equal(await page.evaluate(()=>window.fixturePosts),1);
   assert.equal((await page.evaluate(()=>window.fixtureSubmitted)).pricing_tier,wanted);
   results.push({raw,wanted,initial,isolatedEngine:true,textStatePreserved:true,nativeSelectCommitted:true,nativeRadioClickCommitted:true,checkboxIdempotenceAndDeselection:true,verificationErrorPreservesState:true,localCallbackPosts:1});
  }finally{await engine.detach();}
 }
 // The action check path must retain the ordinary payment gate before click.
 await page.goto('https://react-fixture.example/submit');await page.waitForFunction(()=>!!window.fixtureState);
 await page.evaluate(()=>{const fieldset=document.createElement('fieldset');fieldset.innerHTML='<legend>Pay to submit: listing fee $49</legend><label>Paid listing<input name="paid_listing" type="checkbox"></label>';document.querySelector('form').append(fieldset);window.paymentClicks=0;fieldset.querySelector('input').addEventListener('click',()=>window.paymentClicks++);});
 const gatedEngine=await attachEngine(context,page.mainFrame(),async()=>({ok:true}));
 try{await gatedEngine.call({action:'detectPage'});const gate=await gatedEngine.call({action:'executeActionPlan',actions:[{type:'check',selector:'input[name=paid_listing]',value:true}]});assert.equal(gate.ok,false);assert.equal(gate.results[0].humanGate,'payment',JSON.stringify(gate));assert.equal(await page.evaluate(()=>window.paymentClicks),0);}finally{await gatedEngine.detach();}
 assert.equal(outsideRequests,0);
 console.log(JSON.stringify({ok:true,react:'18.3.1',...baseline,results,paymentGatePreserved:true,bridgeCalls,outsideRequests,realSubmissions:0,productionWrites:0}));
}finally{await context.close();await browser.close();}

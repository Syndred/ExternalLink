import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const sources=['core/form-engine.js','extension/content.js'].map(path=>readFileSync(new URL('../'+path,import.meta.url),'utf8').replace(/\r\n/g,'\n'));
function extract(source,name){const match=source.match(new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?(?=\\n  (?:async )?function |\\n  //)`));assert.ok(match,name);return match[0];}
const names=['normalizePricingType','explicitProductPricingTarget','pricingSelectionText','pricingOptionType','pricingSelectionMismatch','shouldReconcileDefaultCustomPricing'];
const code=names.map(name=>{const a=extract(sources[0],name);assert.equal(a,extract(sources[1],name),name+' compatibility copy');return a;}).join('\n');
const helpers=new Function('getFieldHint','getProfileFields','isHumanDeclarationField','choiceActivationGate','compactText','document','getPaymentElementContext',code+';return {target:explicitProductPricingTarget,text:pricingSelectionText,enum:pricingOptionType,mismatch:pricingSelectionMismatch,reconcile:shouldReconcileDefaultCustomPricing};')(
 el=>el.hint||'',config=>config.projectFields||{},el=>!!el.human,el=>el.payment?{type:el.payment==='uncertain'?'payment_uncertain':'payment'}:null,value=>String(value||'').trim(),{getElementById:()=>null},el=>({label:el.hint,local:el.context||'',options:'',fieldset:''}));
function field({label='Free',tagName='BUTTON',hint='Product Pricing',value='',selected=null,aria=null,...extra}={}){return {hint,tagName,textContent:label,value,selectedOptions:[{textContent:label}],getAttribute:name=>name==='data-extlink-expected-pricing'?'paid':name==='aria-valuetext'?aria:null,closest:()=>selected?{querySelector:()=>({textContent:selected})}:null,...extra};}
test('pricing enum options do not confuse free descriptions with paid or upgrades',()=>{
 for(const [label,wanted] of [['Free, no subscription','free'],['Freemium with paid upgrades','freemium'],['Paid: $1.99 per photo','paid'],['Open-source','open source'],['Upgrade to Paid',''],['No subscription','']])assert.equal(helpers.enum(label),wanted);
});
test('explicit product pricing reconciles all existing wrong defaults and leaves correct values alone',()=>{
 for(const [raw,label,wanted] of [['Paid generation; public browsing is free','Free',true],['Freemium: free preview paid downloads','Paid',true],['Free','Paid',true],['Paid','Paid: $1.99',false]])assert.equal(helpers.reconcile(field({label}),{projectFields:{'PRICING TYPE':raw}}),wanted);
});
test('combobox search text cannot become a committed pricing choice',()=>{
 assert.equal(helpers.text(field({tagName:'INPUT',value:'paid',label:''})), '');
 assert.ok(helpers.mismatch(field({tagName:'INPUT',value:'paid',label:''})));
 assert.equal(helpers.text(field({tagName:'INPUT',value:'free',selected:'Paid'})),'Paid');
 assert.equal(helpers.mismatch(field({tagName:'INPUT',value:'free',selected:'Paid'})),'');
});
test('product price identity excludes category, paid listing, human agreement and payment controls',()=>{
 for(const options of [{hint:'Category Pricing'},{hint:'Listing Price'},{hint:'Product Pricing',human:true},{hint:'Product Pricing',payment:true},{hint:'Language'}])assert.equal(helpers.target(field(options),{pricing:'Paid'}),null);
 assert.deepEqual(helpers.target(field(),{projectFields:{'PRICING TYPE':'Paid',Pricing:'Free'}}),{type:'paid',profileKey:'PRICING TYPE'});
 assert.equal(helpers.target(field(),{projectFields:{'PRICING TYPE':'Unknown'}}).type,'unknown');
});
test('uncertain closed pricing needs product identity and no local charge signal',()=>{
 assert.equal(helpers.target(field({payment:'uncertain'}),{pricing:'Paid'}).type,'paid');
 assert.equal(helpers.target(field({hint:'Pricing',payment:'uncertain'}),{pricing:'Paid'}),null);
 for(const context of ['Checkout $49','Purchase paid listing','Upgrade payment'])assert.equal(helpers.target(field({payment:'uncertain',context}),{pricing:'Paid'}),null);
 const form={querySelectorAll:selector=>selector==='input, textarea'?[{hint:'Tool name'},{hint:'Tool website'}]:[{textContent:'Submit tool'}]};
 assert.equal(helpers.target(field({hint:'Pricing',payment:'uncertain',closest:()=>form}),{pricing:'Paid'}).type,'paid');
});

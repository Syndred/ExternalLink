import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const core=readFileSync(new URL('../core/form-engine.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const extension=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const names=['normalizePricingType','commitChoiceCheckedValue','choiceActivationGate','choiceGroupKey','collectChoiceGroups',
  'choiceGroupRequired','profileChoiceCorpus','scoreChoiceLabel','isProductPricingChoiceGroup',
  'resolveProductPricingChoice','fillChoiceGroups'];
function extract(source,name){
  const match=source.match(new RegExp(`  (?:async )?function ${name}\\([\\s\\S]*?(?=\\n  (?:async )?function |\\n  //)`));
  assert.ok(match,name+' must exist');return match[0];
}
const functions=names.map(name=>{
  const source=extract(core,name);
  assert.equal(source,extract(extension,name),name+' must match the compatibility copy');
  return source;
}).join('\n');
const {fill,commit}=new Function('getProfileFields','getFieldHint','getSnapshotLabel','compactText',
  'normalizeOptionText','isHumanDeclarationField','fieldMappingKey','isToolsSoTallyForm','classifyPaymentContext','getPaymentElementContext','sleep',
  `${functions};return {fill:fillChoiceGroups,commit:commitChoiceCheckedValue};`
)(config=>config.projectFields||{},element=>element.hint||element.name,element=>element.label,
  (value,limit)=>String(value||'').trim().slice(0,limit),value=>String(value||'').trim().toLowerCase(),
  element=>element.human===true,element=>element.name,()=>false,
  element=>({classification:element.gated?'confirmed_payment':'safe'}),element=>element,async()=>{});

function choices({name='pricing_tier',labels=['Free','Freemium','Paid','Open Source'],heading='',initial='',reject=false}={}){
  const options=labels.map(label=>({type:'radio',name,label,value:label.toLowerCase().replace(/ /g,'_'),
    checked:label===initial,labels:[{textContent:label}],calls:0,isConnected:true,
    getAttribute(){return null;},closest(){return heading?{querySelector:()=>({textContent:heading}),getAttribute:()=>null}:null;},
    click(){this.calls++;if(!reject){for(const option of options)option.checked=false;this.checked=true;}}
  }));return options;
}
test('pricing radios use exact normalized profile pricing and preserve the source key',async()=>{
  for(const [raw,wanted] of [['Freemium: free watermarked previews and paid unlocks','freemium'],
    ['Paid generation with credits; public browsing is free','paid'],['Free','free'],['Open-source','open_source']]){
    const options=choices(),result=await fill(options,{tags:'free previews, image generation',projectFields:{'PRICING TYPE':raw,Pricing:'Free'}});
    assert.equal(options.find(option=>option.checked)?.value,wanted);
    assert.equal(result.filledCount,1);assert.equal(result.mappings.pricing_tier.profileKey,'PRICING TYPE');
  }
});
test('pricing uses Pricing then config.pricing, recognizes a fieldset heading and corrects a Free default',async()=>{
  for(const [config,key] of [[{projectFields:{Pricing:'Freemium'}},'Pricing'],[{pricing:'Paid'},'']]){
    const options=choices({name:'business_model',heading:'Product Pricing',initial:'Free'}),result=await fill(options,config);
    assert.equal(result.filledCount,1);assert.equal(result.mappings.business_model.profileKey,key);
    assert.equal(options.find(option=>option.checked).label,key?'Freemium':'Paid');
  }
});
test('missing pricing and unavailable exact choices do not fall back to categories or Free',async()=>{
  for(const [config,labels] of [[{},undefined],[{projectFields:{'PRICING TYPE':'Unknown'}},undefined],
    [{projectFields:{'PRICING TYPE':'Freemium'}},['Free','Paid']]]){
    const options=choices({labels}),result=await fill(options,{tags:'free',...config});
    assert.equal(result.filledCount,0);assert.equal(options.some(option=>option.checked),false);
    assert.deepEqual(result.mappings,{});assert.equal(result.handled.size,options.length);
  }
});
test('uncommitted choices and payment-gated choices are never counted as filled',async()=>{
  for(const mode of ['reject','payment']){
    const options=choices({reject:mode==='reject'});if(mode==='payment')options[1].gated=true;
    const result=await fill(options,{projectFields:{'PRICING TYPE':'Freemium'}});
    assert.equal(result.filledCount,0);assert.deepEqual(result.mappings,{});
    if(mode==='payment')assert.equal(options[1].calls,0);
  }
});
test('native checkbox activation is idempotent and supports deselection without a second toggle',async()=>{
  const checkbox={type:'checkbox',checked:false,isConnected:true,calls:0,click(){this.calls++;this.checked=!this.checked;}};
  assert.equal(await commit(checkbox,true),true);assert.equal(await commit(checkbox,true),true);
  assert.equal(checkbox.checked,true);assert.equal(checkbox.calls,1);
  assert.equal(await commit(checkbox,false),true);assert.equal(checkbox.calls,2);
  const radio=choices({initial:'Free'})[0];assert.equal(await commit(radio,false),false);assert.equal(radio.calls,0);
});
test('ordinary category selection still records category and leaves existing selection untouched',async()=>{
  const options=choices({name:'category',labels:['Writing','Image Generation','Other']});
  const result=await fill(options,{tags:'image generation',projectFields:{'PRICING TYPE':'Freemium'}});
  assert.equal(options.find(option=>option.checked)?.label,'Image Generation');
  assert.equal(result.mappings.category.profileKey,'category');
  assert.equal((await fill(options,{tags:'writing'})).filledCount,0);
  const costCategory=choices({name:'category',labels:['Cost Optimization','Image Generation','Other']});
  const selectedCost=await fill(costCategory,{tags:'cost optimization',projectFields:{'PRICING TYPE':'Freemium'}});
  assert.equal(costCategory.find(option=>option.checked)?.label,'Cost Optimization');
  assert.equal(selectedCost.mappings.category.profileKey,'category');
});

import test from 'node:test';import assert from 'node:assert/strict';import{aiOfDayCopy,profileFieldChoices,profileTagline}from'../executor/src/known-copy.mjs';
test('AIoftheday uses the current full description and five distinct features within its published limits',()=>{
  const description='Current independently verified JevPlay description. '.repeat(12);
  const features=['First original feature','Second original feature','Third original feature','Fourth original feature','Fifth original feature'],copy=aiOfDayCopy({name:'JevPlay',url:'https://jevplay.com',fields:{'Short Discription(100-150 words)':description,Tagline:'Original product tagline',Features:features}});
  assert.equal(copy.description,description.trim());assert.ok(copy.tagline.length<=60);
  assert.equal(new Set(copy.features).size,5);assert.ok(copy.features.every(x=>x.length<=160));assert.deepEqual(copy.features,features);
});
test('Site specific summaries cannot be applied to a different product or missing source copy',()=>{
  assert.throws(()=>aiOfDayCopy({name:'Other',url:'https://other.test'}));
  assert.throws(()=>aiOfDayCopy({name:'JevPlay',url:'https://jevplay.com',fields:{}}));
});
test('new products use their own descriptions taglines and features and never inherit JevPlay claims',()=>{
 const profile={id:'new-site',name:'New Photo Product',url:'https://new-photo.example',fields:{'Short Discription(100-150 words)':'Restore your own photographs.',Tagline:'Bring your photographs back',Features:'Restore old photos\nColorize photographs\nRepair scratches\nSave original resolution\nExport restored images'}},before=structuredClone(profile),copy=aiOfDayCopy(profile);assert.equal(copy.description,profile.fields['Short Discription(100-150 words)']);assert.equal(copy.tagline,profile.fields.Tagline);assert.deepEqual(copy.features,profile.fields.Features.split('\n'));assert.ok(!JSON.stringify(copy).includes('chat intent'));assert.ok(!JSON.stringify(copy).includes('Snake'));assert.deepEqual(profile,before);
});
test('missing facts remain missing and source-specific selections outrank generic values without invented categories pricing or technology',()=>{
 const profile={name:'Independent product',fields:{'Short Discription(100-150 words)':'Original description.',Category:'Utilities','PoweredByAI Category':['Photography','Utilities'],'PRICING TYPE':'Paid',Pricing:'Free','Tech Stack':'Vue; Python','10015 Tags':'Photo editing, Image restoration'}};assert.equal(aiOfDayCopy(profile).features.length,0);assert.equal(aiOfDayCopy(profile).tagline,profile.name);assert.deepEqual(profileFieldChoices(profile,['PoweredByAI Category','Category']),['Photography','Utilities']);assert.deepEqual(profileFieldChoices(profile,['PRICING TYPE','Pricing']),['Paid']);assert.deepEqual(profileFieldChoices(profile,['Tech Stack']),['Vue','Python']);assert.deepEqual(profileFieldChoices(profile,['10015 Tags']),['Photo editing','Image restoration']);assert.deepEqual(profileFieldChoices({fields:{}},['Category']),[]);assert.equal(profileTagline({fields:{Title:'Own title'}}),'Own title');
});

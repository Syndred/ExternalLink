import test from 'node:test';
import assert from 'node:assert/strict';
import Worker from '../cloud/worker/src/index.mjs';
import {aiCloudFixture} from '../executor/test/fixtures/ai-cloud.mjs';
import {visionPlanningJson} from '../core/vision-planning-input.mjs';

async function visionRequest(input,run){
 const fixture=aiCloudFixture(),realFetch=globalThis.fetch;let provider;
 globalThis.fetch=async(url,options)=>{
  if(new URL(typeof url==='string'?url:url.url).hostname==='provider.fixture.invalid'){
   provider=JSON.parse(options.body);
   return Response.json({choices:[{message:{content:JSON.stringify({status:'act',actions:[]})}}]});
  }
  return fixture.fetch(url,options);
 };
 const call=async(route,token,body)=>Worker.fetch(new Request('https://worker.fixture.invalid/v2/executor/'+route+'?workspace=default',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),fixture.env);
 try{
  const token=(await(await call('devices','fixture-admin',{})).json()).deviceToken;
  const response=await call('ai/vision-plan',token,{screenshot:'data:image/png;base64,aW1hZ2U=',viewport:{width:900,height:700},...input});
  assert.equal(response.status,200);
  const text=provider.messages[1].content.find(part=>part.type==='text').text;
  await run(text,provider);
 }finally{globalThis.fetch=realFetch;fixture.sqlite.close();}
}

const emptyFields=[
 {selector:'#tool',name:'tool',label:'Tool name',placeholder:'My AI Tool',required:true,value:{present:false,kind:'text',length:0}},
 {selector:'#email',type:'email',placeholder:'you@example.com',value:{present:false,kind:'email',length:0}},
 {selector:'#consent',type:'checkbox',value:{checked:false,kind:'checked'}},
 {selector:'#category',type:'select',value:{present:false,kind:'select',selectedLabel:''}},
];
const elements=emptyFields.map((field,index)=>({selector:field.selector,label:field.label||field.name||'Control',type:field.type||'input',rect:{x:10,y:30+index*30,width:250,height:25}}));

test('large inline media cannot truncate the vision snapshot or its empty value states',()=>visionRequest({
 task:{projectKey:'OldPhotoLive'},config:{logoDataUrl:'data:image/png;base64,'+'A'.repeat(100000),projectKey:'OldPhotoLive',brandName:'OldPhoto Live',pricing:'Free preview; restoration credits from $4.99',projectFields:{Name:'OldPhoto Live',Url:'https://oldphoto.live/',Pricing:'Free preview; restoration credits from $4.99','PRICING TYPE':'Freemium','Category':'Photo restoration'}},snapshot:{url:'https://form.fixture.invalid',fields:emptyFields},elements,
},(text,provider)=>{
 assert.doesNotThrow(()=>JSON.parse(text),'vision text must be complete JSON after large media removal');
 const input=JSON.parse(text);assert.ok(text.length<=60000);assert.deepEqual(input.snapshot.fields.map(field=>field.value),emptyFields.map(field=>field.value));assert.equal(input.snapshot.fields[0].placeholder,'My AI Tool');assert.equal(input.elements.length,elements.length);
 assert.equal(input.config.projectFields.Name,'OldPhoto Live');assert.equal(input.config.projectFields.Pricing,'Free preview; restoration credits from $4.99');assert.equal(input.config.projectFields['PRICING TYPE'],'Freemium');assert.equal(input.config.projectFields.Category,'Photo restoration');assert.equal(input.config.projectKey,'OldPhotoLive');assert.equal(input.config.pricing,'Free preview; restoration credits from $4.99');
 assert.ok(!text.includes('data:image'));assert.equal(provider.messages[1].content.find(part=>part.type==='image_url').image_url.url,'data:image/png;base64,aW1hZ2U=');
}));

test('vision text strips credentials and media while normal product and field information remains',()=>visionRequest({
 config:{projectKey:'p',brandName:'Ordinary Product',targetDomain:'https://product.fixture.invalid/',email:'owner@product.fixture.invalid',tags:'photo,ai',password:'FIXTURE_PASSWORD',apiKey:'FIXTURE_API_KEY',authorization:'Bearer FIXTURE_BEARER',screenshots:['data:image/png;base64,FIXTURE_MEDIA'],projectFields:{Name:'Ordinary Product',Title:'Restore memories',Pricing:'$4.99',Category:'Photography','Custom industry':'Family history','API Key':'FIXTURE_NESTED_KEY','Login password':'FIXTURE_NESTED_PASSWORD',LOGO:'data:image/png;base64,FIXTURE_LOGO'}},snapshot:{url:'https://form.fixture.invalid',fields:[...emptyFields,{selector:'#password',type:'password',value:{present:true,kind:'secret',length:16,text:'FIXTURE_PAGE_PASSWORD'}}]},elements:[...elements,{selector:'#password',type:'password',value:'FIXTURE_ELEMENT_PASSWORD',label:'Password',rect:{x:10,y:200,width:250,height:25}}],failure:'No visible progress',history:[{actions:[{type:'fill',selector:'#password',value:'FIXTURE_HISTORY_PASSWORD'}],after:{screenshot:'data:image/png;base64,FIXTURE_HISTORY_MEDIA'}}],
},(text,provider)=>{
 const input=JSON.parse(text);assert.ok(!/FIXTURE_(?:PASSWORD|API_KEY|BEARER|MEDIA|NESTED_KEY|NESTED_PASSWORD|LOGO|PAGE_PASSWORD|ELEMENT_PASSWORD|HISTORY_PASSWORD|HISTORY_MEDIA)/.test(text));
 assert.equal(input.config.projectFields.Name,'Ordinary Product');assert.equal(input.config.projectFields.Title,'Restore memories');assert.equal(input.config.projectFields.Pricing,'$4.99');assert.equal(input.config.projectFields['Custom industry'],'Family history');assert.equal(input.config.email,'owner@product.fixture.invalid');assert.equal(input.snapshot.fields.at(-1).value.present,true);
 assert.match(provider.messages[0].content,/present=false/);assert.match(provider.messages[0].content,/length=0/);assert.match(provider.messages[0].content,/checked=false/);assert.match(provider.messages[0].content,/placeholder/i);
}));

test('large page and product descriptions produce bounded valid JSON without changing 120 field states',()=>{
 const fields=Array.from({length:120},(_,index)=>({selector:'#field-'+index,name:'field-'+index,label:'Field '+index+' '+ 'L'.repeat(3000),placeholder:'P'.repeat(4000),constraints:{maxLength:100},value:index%2?{present:false,kind:'text',length:0}:{checked:false,kind:'checked'}}));
 const visible=fields.slice(0,80).map((field,index)=>({selector:field.selector,label:'V'.repeat(3000),aria:'A'.repeat(3000),rect:{x:5,y:index*5,width:250,height:5}}));
 const config={projectFields:{}};for(let index=0;index<160;index++)config.projectFields['Extra '+index]='Long text '.repeat(2000);
 Object.assign(config.projectFields,{Name:'Budget Product',Url:'https://product.fixture.invalid/',Pricing:'$4.99 per restoration',Category:'Photo restoration'});
 return visionRequest({config,snapshot:{url:'https://form.fixture.invalid',title:'Photo form',text:'Page text '.repeat(20000),fields},elements:visible,history:Array.from({length:8},()=>({reason:'Reason '.repeat(2000)}))},text=>{
  assert.ok(text.length<=60000);const input=JSON.parse(text);assert.equal(input.snapshot.fields.length,120);assert.equal(input.elements.length,80);assert.deepEqual(input.snapshot.fields.map(field=>field.value),fields.map(field=>field.value));assert.equal(input.config.projectFields.Name,'Budget Product');assert.equal(input.config.projectFields.Pricing,'$4.99 per restoration');assert.equal(input.config.projectFields.Category,'Photo restoration');
 });
});

test('escaped supplemental text stays within the JSON budget and input data is not mutated',()=>{
 const input={config:{projectFields:{Name:'Literal Product',Pricing:'$4.99',Category:'Photography'},valueProposition:'"\\\n'.repeat(16000)},snapshot:{url:'https://form.fixture.invalid',fields:emptyFields,text:'"\\\n'.repeat(20000)},elements};
 const original=JSON.stringify(input),text=visionPlanningJson(input),payload=JSON.parse(text);
 assert.ok(text.length<=60000);assert.equal(JSON.stringify(input),original);assert.deepEqual(payload.snapshot.fields.map(field=>field.value),emptyFields.map(field=>field.value));assert.equal(payload.config.projectFields.Pricing,'$4.99');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import Worker from '../cloud/worker/src/index.mjs';
import {aiCloudFixture} from '../executor/test/fixtures/ai-cloud.mjs';
import {reviewPlanningJson} from '../core/review-planning-input.mjs';

test('review routes keep configured model and complete evidence with bounded nonthinking JSON output',async()=>{
 const fixture=aiCloudFixture(),previousFetch=globalThis.fetch,requests=[];
 fixture.env.DEEPSEEK_MODEL='deepseek-v4-pro';
 globalThis.fetch=async(url,options)=>{
  if(new URL(typeof url==='string'?url:url.url).hostname==='provider.fixture.invalid'){
   requests.push({body:JSON.parse(options.body),signal:options.signal});
   return Response.json({choices:[{message:{content:JSON.stringify({status:'needs_manual',reason:'The current page requires verification',fields:[],submitReady:false})}}]});
  }
  return fixture.fetch(url,options);
 };
 const call=(route,token,body)=>Worker.fetch(new Request('https://worker.fixture.invalid/v2/executor/'+route+'?workspace=default',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(body)}),fixture.env);
 try{
  const token=(await(await call('devices','fixture-admin',{})).json()).deviceToken;
  const snapshot={url:'https://directory.fixture.invalid/submit',evidenceSignals:[{type:'submission_rejection',text:'Unable to accept submissions',matched:true,visible:true,scope:'current_submission_response'}],preparation:{filled:{fields:[{name:'pricing',value:'Paid'},{name:'toolUrl',value:'https://oldphotoliveai.com'}]}}};
  for(const [route,limit] of [['judge',1800],['validate-fill',4096]]){
   const result=await(await call('ai/'+route,token,{snapshot,config:{logoDataUrl:'data:image/png;base64,'+'A'.repeat(100000),password:'FIXTURE_SECRET',projectFields:{Name:'OldPhotoLive AI',Pricing:'$1.99 per photo; no subscription',LOGO:'data:image/png;base64,'+'A'.repeat(100000)}}})).json();
   const request=requests.at(-1);
   assert.equal(request.body.model,'deepseek-v4-pro');
   assert.deepEqual(request.body.thinking,{type:'disabled'});
   assert.equal(request.body.max_tokens,limit);
   assert.ok(request.signal instanceof AbortSignal);
   const input=JSON.parse(request.body.messages[1].content);
   assert.deepEqual(input.snapshot,snapshot);
   assert.equal(input.config.projectFields.Pricing,'$1.99 per photo; no subscription');
   assert.ok(!request.body.messages[1].content.includes('data:image'));
   assert.ok(!request.body.messages[1].content.includes('FIXTURE_SECRET'));
   if(route==='judge')assert.equal(result.status,'needs_manual');
   else assert.equal(result.submitReady,false);
  }
 }finally{globalThis.fetch=previousFetch;fixture.sqlite.close();}
});

test('review values and negative evidence remain whole; oversized evidence is refused instead of cut',()=>{
 const fields=[{name:'product_name',value:'OldPhotoLive AI'},{name:'pricing',value:'Paid'},{name:'csrf_token',value:'FIXTURE_CSRF'}];
 const input={config:{learnedFieldMappings:{'old.invalid':{pricing:{value:'obsolete free plan'}}}},snapshot:{fields,evidenceSignals:[{type:'submission_rejection',text:'Unable to accept submissions',matched:true}]}};
 const result=JSON.parse(reviewPlanningJson(input));
 assert.deepEqual(result.snapshot.fields.slice(0,2),fields.slice(0,2));
 assert.equal(result.snapshot.fields[2].value,'[credential omitted]');
 assert.equal(result.config.learnedFieldMappings,undefined);
 assert.deepEqual(result.snapshot.evidenceSignals,input.snapshot.evidenceSignals);
 assert.equal(input.snapshot.fields[2].value,'FIXTURE_CSRF');
 assert.throws(()=>reviewPlanningJson({snapshot:{text:'x'.repeat(70000)}}),/超过文字预算/);
});

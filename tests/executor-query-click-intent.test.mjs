import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createOriginalSubmissionAdapter} from '../executor/src/original-submission-adapter.mjs';
const source=readFileSync(new URL('../core/form-engine.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function extract(name){return source.match(new RegExp(`  function ${name}\\([\\s\\S]*?(?=\\n  (?:async )?function |\\n  //)`))?.[0]||'';}
const isSubmission=new Function('getElementLabel','getFieldHint','isVisible','compactText',
 `${extract('isQueryNavigationControl')} ${extract('attachmentUploadIntent')} ${extract('isModelSubmissionControl')} ${extract('isSubmitControl')};return isModelSubmissionControl;`
)(element=>element.label,element=>element.name,()=>true,value=>String(value||''));
function control({label='Search',query=true,method='get',role='search',mixed=false}={}){
 const fields=mixed?[{type:'text',name:'query'},{type:'text',name:'product_name'}]:[{type:'text',name:query?'query':'product_name'}];
 const form={querySelectorAll:()=>fields,getAttribute:name=>name==='method'?method:name==='role'?role:null};
 return {label,tagName:'BUTTON',type:'submit',form,getAttribute:name=>name==='type'?'submit':null,
  closest:selector=>selector==='form'?form:role==='search'?form:null};
}
test('Search submit in a verified query form is navigation; unknown and final controls stay protected',()=>{
 assert.equal(isSubmission(control(), 'Search'),false);
 assert.equal(isSubmission(control({label:'Search & Submit Product'}),'Search & Submit Product'),true);
 assert.equal(isSubmission(control({query:false,role:'',method:'post'}),'Search'),true);
 assert.equal(isSubmission(control({label:'Continue',query:false,role:'',method:'post'}),'Continue'),true);
 assert.equal(isSubmission(control({label:'Search',mixed:true,role:'',method:'get'}),'Search'),true);
});
function adapterFixture(intent){
 const task={id:'t',runId:'r',profileId:'p',url:'https://directory.example/add-site',status:'filling',profileSnapshot:{fields:{Name:'Original',Url:'https://product.example'}}};
 const events=[],calls=[],report={fields:[{name:'name',label:'Product name',type:'text',value:'Original'}],allValid:true};
 const frame={url:()=>task.url,locator:()=>({evaluateAll:async()=>[],evaluate:async()=>false})};
 const page={on(){},off(){},url:()=>task.url,mainFrame:()=>frame};
 const engine={call:async message=>{calls.push(message.action);if(message.action==='inspectModelClickIntent')return intent;
  if(message.action==='getFilledFieldsReport')return report;if(message.action==='classifySubmitEvidence')return {matched:false};
  if(message.action==='collectFormValidation')return {validationFailed:false};if(message.action==='executeActionPlan')return {ok:true,results:[{ok:true,clicked:true,submitted:intent?.intent!=='navigation'}]};throw Error(message.action);}};
 const runtime={store:{get:key=>key==='task:t'?task:null,pending:()=>[],valuesByInsertion:()=>[]},cloud:{request:async()=>({documents:{submissionRecords:{}}})},
  update(target,patch,event){Object.assign(target,patch);events.push(event);},reconcileTextInputs:async()=>{}};
 const adapter=createOriginalSubmissionAdapter(runtime,{task,page,config:{autoSubmitDirectory:true},active:()=>true,assertDocument:async()=>{},candidate:()=>({frame,engine,detection:{platform:'directory'}}),visual:()=>({elements:[{selector:'#query',label:'Search',type:'submit'}]}),ownership:{}});
 return {task,events,calls,adapter};
}
test('adapter records no submission boundary for DOM-proved query navigation, but retains real and unknown boundaries',async()=>{
 for(const intent of [{ok:true,intent:'navigation',queryAction:true},{ok:true,intent:'submission'},{ok:true,intent:'unknown'}]){
  const fixture=adapterFixture(intent);
  try{await fixture.adapter.act({type:'click',selector:'#query'});
   assert.equal(Boolean(fixture.task.attemptBoundary),intent.intent!=='navigation');
   assert.equal(fixture.events.includes('original_visual_attempt_boundary'),intent.intent!=='navigation');
   assert.ok(fixture.calls.includes('inspectModelClickIntent'));
  }finally{fixture.adapter.dispose();}
 }
});

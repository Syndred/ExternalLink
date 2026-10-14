import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createOriginalSubmissionAdapter} from '../executor/src/original-submission-adapter.mjs';
const core=readFileSync(new URL('../core/form-engine.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const extension=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const extract=source=>source.match(/  function attachmentUploadIntent\([\s\S]*?(?=\n  function )/)[0];
assert.equal(extract(core),extract(extension));
const intent=new Function('getElementLabel','isVisible',`${extract(core)};return attachmentUploadIntent;`)(element=>element.label,element=>element.visible!==false);
const files=[{name:'logo.png',size:15,type:'image/png',lastModified:1}];
function button({label='Upload 1 file',dialog=true,selected=files,mixed=false}={}){
 const scope={id:'uploads',tagName:'DIV',getAttribute:()=>null,querySelectorAll:()=>[{type:'file',files:selected},...(mixed?[{type:'text',value:'Original'}]:[])]};
 return {label,closest:()=>dialog?scope:null};
}
test('attachment intent requires a real upload dialog, native selected files and matching count',()=>{
 assert.deepEqual(intent(button()).attachmentFiles,files);
 assert.equal(intent(button({selected:[{...files[0],lastModified:999}]})).attachmentSignature,intent(button()).attachmentSignature,'reselecting the same file must not bypass the uncertain upload guard');
 for(const options of [{dialog:false},{selected:[]},{label:'Upload 2 files'},{mixed:true},{label:'Upload & Submit Product'},
  {label:'Publish 1 file'},{label:'Upload'}])assert.equal(intent(button(options)),null,JSON.stringify(options));
});
function fixture({fails=false}={}){
 const task={id:'t',runId:'r',profileId:'p',targetId:'target',browserInstance:'browser',url:'https://form.example/submit',status:'filling',profileSnapshot:{fields:{Name:'Original',Url:'https://product.example'}}},events=[],writes=[],pending=[],report={fields:[{name:'name',label:'Product name',value:'Original',type:'text'}],allValid:true};
 let clicks=0,finalNow=false;const frame={url:()=>task.url,locator:()=>({evaluateAll:async()=>[]})},page={on(){},off(){},url:()=>task.url,mainFrame:()=>frame};
 const attachment={ok:true,intent:'attachment',attachmentAction:true,attachmentSignature:JSON.stringify(files),attachmentDialog:'uploads',attachmentFiles:files,documentTimeOrigin:123};
 const engine={call:async message=>{if(message.action==='inspectModelClickIntent')return !finalNow&&message.clickAction.selector==='#upload'?attachment:{ok:true,intent:'submission',label:'Submit Product',documentTimeOrigin:123};
  if(message.action==='collectFormValidation')return {validationFailed:false};if(message.action==='getFilledFieldsReport')return report;if(message.action==='classifySubmitEvidence')return {matched:false};
  if(message.action==='executeActionPlan'){assert.equal(pending.length,0,'the started operation must flush before click');clicks++;if(fails)throw Error('upload response unavailable');return {ok:true,results:[{ok:true,clicked:true,submitted:finalNow||message.actions[0].selector==='#final'}]};}throw Error(message.action);}};
 const runtime={store:{get:key=>key==='task:t'?task:null,pending:()=>pending,valuesByInsertion:()=>[]},cloud:{request:async()=>({documents:{submissionRecords:{}}}),flush:async()=>{pending.length=0;}},update(target,patch,event){Object.assign(target,patch);events.push(event);writes.push(structuredClone(patch));pending.push({id:String(events.length),taskId:task.id});},reconcileTextInputs:async()=>{}};
 const adapter=createOriginalSubmissionAdapter(runtime,{task,page,config:{autoSubmitDirectory:true},active:()=>true,assertDocument:async()=>{},candidate:()=>({frame,engine,detection:{platform:'directory'}}),visual:()=>({elements:[{selector:'#upload',label:'Upload 1 file',type:'submit'},{selector:'#final',label:'Submit Product',type:'submit'}]}),ownership:{}});
 return {task,events,writes,adapter,clicks:()=>clicks,switchToFinal:()=>{finalNow=true;}};
}
test('attachment clicks persist a separate uncertain operation and cannot replay started or clicked files',async()=>{
 for(const fails of [false,true]){
  const f=fixture({fails});try{
   if(fails)await assert.rejects(f.adapter.act({type:'click',selector:'#upload'}),/response unavailable/);else await f.adapter.act({type:'click',selector:'#upload'});
   assert.equal(f.task.status,'filling');assert.equal(f.task.attemptBoundary,undefined);
   assert.equal(f.task.attachmentActionHistory[0].status,fails?'started':'clicked');
   assert.equal(f.writes[0].attachmentActionHistory[0].status,'started');
   const duplicate=await f.adapter.act({type:'click',selector:'#upload'});assert.equal(duplicate.attachmentActionGuard,true);assert.equal(f.clicks(),1);
   assert.equal(f.task.attemptBoundary,undefined);
  }finally{f.adapter.dispose();}
 }
});
test('a real final submit following attachment click retains its submission boundary and mutation protection',async()=>{
 const f=fixture();try{
  await f.adapter.act({type:'click',selector:'#upload'});assert.equal(f.task.attemptBoundary,undefined);
  await f.adapter.act({type:'click',selector:'#final'});assert.ok(f.task.attemptBoundary);assert.equal(f.clicks(),2);
  assert.equal(f.events.filter(event=>event==='original_visual_attempt_boundary').length,1);
  const blocked=await f.adapter.act({type:'fill',selector:'#name',value:'Original'},{entry:{submissionAttempted:true}});assert.equal(blocked.unconfirmed,true);assert.equal(f.clicks(),2);
 }finally{f.adapter.dispose();}
});
test('reusing an old upload selector for a genuine final control does not suppress the final submission boundary',async()=>{
 const f=fixture();try{
  await f.adapter.act({type:'click',selector:'#upload'});f.switchToFinal();
  await f.adapter.act({type:'click',selector:'#upload'});assert.ok(f.task.attemptBoundary);assert.equal(f.clicks(),2);
 }finally{f.adapter.dispose();}
});

import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fillOriginalVisitForm,mergeOriginalFrameFill} from './original-visit-fill.mjs';
import {capturePageEvidence} from './page-evidence.mjs';

export async function prepareOriginalVisitFields(runtime,{task,config,page,candidate,engines,assertBase}){
 const keys=['id','runId','profileId','profileRevision','version','targetId','browserInstance','controller'],identity=Object.fromEntries(keys.map(key=>[key,task[key]])),profile=structuredClone(task.profileSnapshot);
 async function assertCurrent(){
  await assertBase();const current=runtime.store.get('task:'+task.id);
  if(!current||keys.some(key=>current[key]!==identity[key])||!isDeepStrictEqual(current.profileSnapshot,profile)||current.attemptBoundary||current.receipt||['unknown_receipt','payment','paid','login','human_verification'].includes(current.attentionType)||['ai','supervisor'].includes(current.controller)||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold'))throw Error('原填写任务、产品或控制权已变化，停止旧计划');
  for(const item of engines)if(item.frame.isDetached()||item.frame.url()!==item.url||!await item.engine.isCurrentDocument())throw Error('原填写文档或表单区域已变化，停止旧计划');
 }
 async function selectedCall(message){await assertCurrent();const result=await candidate.engine.call(message);await assertCurrent();return result;}
 async function across(message){
  await assertCurrent();const active=[];
  for(const item of engines){const state=await item.engine.call({action:'countEmptyFields'});await assertCurrent();if(Number(state.totalCount)>0)active.push(item);}
  const results=[];for(const item of active.length?active:[candidate]){await assertCurrent();results.push(await item.engine.call(message));await assertCurrent();}
  return mergeOriginalFrameFill(results);
 }
 runtime.originalVisitUnderstoodForms||=new Map();
 const fill=await fillOriginalVisitForm({config,platformType:candidate.detection.platform,cache:runtime.originalVisitUnderstoodForms,cacheKey:JSON.stringify([task.runId,task.id,task.targetId,candidate.engine.documentId]),io:{assertCurrent,call:selectedCall,across,
  notice(message){runtime.update(task,{visitFillProgress:{at:new Date().toISOString(),message}},'assistant_fill_progress');},
  async model(route,body,options){await assertCurrent();await runtime.synchronize();await assertCurrent();return runtime.batchModelRequest(task,route,body,options);},
  async settle(ms){await new Promise(resolve=>setTimeout(resolve,ms));},
  async captureVisual(){
   const prepared=await selectedCall({action:'prepareVisualSnapshot'});if(!prepared.ok)throw Error('页面视觉快照准备失败');
   try{
    const box=candidate.frame===page.mainFrame()?{x:0,y:0}:await(await candidate.frame.frameElement()).boundingBox();if(!box)throw Error('原嵌入表单当前不可见');
    await assertCurrent();const bytes=await capturePageEvidence(runtime.context,page);await assertCurrent();
    const file=join(runtime.home,`${String(task.id).replace(/[^a-z0-9_-]/gi,'-')}-visit-fill-${Date.now()}.png`);await writeFile(file,bytes);await assertCurrent();
    let artifactRef='',artifactError='';try{const artifact=await runtime.cloud.request('artifact',{taskId:task.id,dataUrl:'data:image/png;base64,'+bytes.toString('base64')});await assertCurrent();const read=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:artifact.ref});await assertCurrent();if(createHash('sha256').update(Buffer.from(read.dataUrl.split(',')[1],'base64')).digest('hex')!==createHash('sha256').update(bytes).digest('hex'))throw Error('原填写截图回读不一致');artifactRef=artifact.ref;}catch(error){await assertCurrent();artifactError=error.message;}
    return{screenshot:'data:image/png;base64,'+bytes.toString('base64'),elements:(prepared.elements||[]).map(element=>({...element,rect:element.rect?{...element.rect,x:element.rect.x+box.x,y:element.rect.y+box.y}:element.rect})),viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),localScreenshot:file,artifactRef,artifactError};
   }finally{await candidate.engine.call({action:'clearVisualSnapshot'}).catch(()=>{});}
  },
  async recordVisual(plan,actions,visual){await assertCurrent();runtime.update(task,{visitFillVisualHistory:[...(task.visitFillVisualHistory||[]),{at:new Date().toISOString(),status:plan.status,stage:plan.stage||'',reason:plan.reason||'',actions:actions.map(action=>({type:action.type,selector:action.selector})),localScreenshot:visual.localScreenshot,artifactRef:visual.artifactRef,artifactError:visual.artifactError}].slice(-8)},'assistant_visual_plan');}
 }});
 const actual=await selectedCall({action:'getFilledFieldsReport'});await assertCurrent();return{fill,actual,assertCurrent};
}

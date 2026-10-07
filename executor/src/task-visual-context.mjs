import {createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {capturePageEvidence} from './page-evidence.mjs';

export async function captureOriginalTaskVisual(runtime,{task,page,candidate,assertCurrent}){
 await assertCurrent();const prepared=await candidate.engine.call({action:'prepareVisualSnapshot'});await assertCurrent();if(!prepared?.ok)throw Error('页面视觉快照准备失败');
 try{
  const box=candidate.frame===page.mainFrame()?{x:0,y:0}:await(await candidate.frame.frameElement()).boundingBox();if(!box)throw Error('原嵌入表单当前不可见');
  await assertCurrent();const bytes=await capturePageEvidence(runtime.context,page);await assertCurrent();
  const file=join(runtime.home,`${String(task.id).replace(/[^a-z0-9_-]/gi,'-')}-original-agent-${Date.now()}.png`);await writeFile(file,bytes);await assertCurrent();
  let artifactRef='',artifactError='';try{const artifact=await runtime.cloud.request('artifact',{taskId:task.id,dataUrl:'data:image/png;base64,'+bytes.toString('base64')});await assertCurrent();const read=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:artifact.ref});await assertCurrent();if(createHash('sha256').update(Buffer.from(read.dataUrl.split(',')[1],'base64')).digest('hex')!==createHash('sha256').update(bytes).digest('hex'))throw Error('原接管截图回读不一致');artifactRef=artifact.ref;}catch(error){await assertCurrent();artifactError=String(error.message||error);}
  return{screenshot:'data:image/png;base64,'+bytes.toString('base64'),elements:(prepared.elements||[]).map(element=>({...element,rect:element.rect?{...element.rect,x:element.rect.x+box.x,y:element.rect.y+box.y}:element.rect})),viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight})),localScreenshot:file,artifactRef,artifactError};
 }finally{await candidate.engine.call({action:'clearVisualSnapshot'}).catch(()=>{});}
}

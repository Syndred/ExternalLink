import {randomUUID,createHash} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {attachEngine} from './engine.mjs';
import {queue,profiles} from './shared.mjs';
import {cloudDigest} from './cloud-sync-state.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {fillOriginalVisitForm,mergeOriginalFrameFill} from './original-visit-fill.mjs';
import {capturePageEvidence} from './page-evidence.mjs';
import {captureFillLearning} from './fill-learning.mjs';
import {classifyOriginalFillGate} from './original-site-classification.mjs';
import {resolveOriginalCloudMediaDefaults,applyOriginalCloudMediaDefaults} from '../../core/original-cloud-media.mjs';
import {decodeImageAsset,validateImageBytes} from '../../core/media-assets.mjs';
import {armRefillReceiptWatch} from './refill-receipt-watch.mjs';
import {assertOriginalCommentLength} from '../../core/original-comment-constraints.mjs';

// The original ordinary sidepanel permits filling an already submitted site.
// Keep this preparation separate from task:/run:, so an old receipt, its task,
// queue position and submission authorization cannot be replaced by a refill.
export async function refillExistingPage(runtime,{input,snapshot,profile,page,destinationUrl,config,assertBase,assertSource}){
 const id=randomUUID(),key='singlePageRefill:'+id,connection=cloudDigest(runtime.store.get('pair')),browserInstance=runtime.host?.startedAt,engines=[],media=new Map(),catalogue=[];
 const state={id,scope:workbenchScope(runtime.store.get('pair')),at:new Date().toISOString(),profileId:profile.id,profileRevision:snapshot.revisions.siteProfiles,profile:structuredClone(profile),url:input.expectedUrl,destinationUrl,targetId:input.targetId,browserInstance,mode:input.mode||'form',status:'preparing',submitted:false,updates:[]};
 const save=patch=>{Object.assign(state,patch);runtime.store.set(key,state);};
 const conflict=task=>!task.tabClosedAt&&task.targetId===input.targetId&&task.browserInstance===browserInstance&&!['finished','excluded','skipped'].includes(task.status)||task.profileId===profile.id&&[input.expectedUrl,destinationUrl].some(url=>queue.extractDomain(task.url)===queue.extractDomain(url))&&(task.attemptBoundary&&!task.receipt||task.syncConflict||['ai','supervisor'].includes(task.controller));
 const check=()=>{assertBase();if(['checking','pending_sync','confirmed'].includes(runtime.store.get('refillWatch:'+id)?.status))throw Error('已观察到原网页手动提交，停止继续填写');if(connection!==cloudDigest(runtime.store.get('pair'))||browserInstance!==runtime.host?.startedAt||page.isClosed()||page.url()!==input.expectedUrl||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold'))throw Error('原网页、连接或执行状态已变化，停止再次填写');if(runtime.store.values('task:').some(conflict))throw Error('同站原任务有未知结果或控制冲突，请先核验');};
 const assertCurrent=async()=>{check();await assertSource();for(const item of engines)if(item.frame.isDetached()||item.frame.url()!==item.url||!await item.engine.isCurrentDocument())throw Error('原填写文档或表单区域已变化');check();};
 const checkCloud=async()=>{await assertCurrent();const fresh=await runtime.cloud.request('snapshot');await assertCurrent();if(!isDeepStrictEqual(fresh.documents.siteProfiles?.[profile.id],profile))throw Error('产品资料已变化，请重新填写');const inventory=await runtime.cloud.request('runs?view=inventory');await assertCurrent();if(inventory.tasks.some(conflict))throw Error('云端原任务有未知结果或控制冲突，请先核验');};
 const mediaEntries=()=>[['logo',config.logoUrl],['featured',config.featuredImage],...(config.screenshots||[]).map((ref,index)=>['screenshot'+(index+1),ref])].filter(([kind,ref])=>ref&&!config.mediaDisabled?.[kind]);
 async function readMedia(ref){
  await assertCurrent();if(!mediaEntries().some(([,value])=>value===ref))throw Error('图片不属于本次产品资料');if(media.has(ref))return media.get(ref);
  let url,headers={};const cloud=ref.startsWith('cloud-media://');
  if(cloud){const assetId=ref.slice(14);if(!/^[a-zA-Z0-9._-]+$/.test(assetId))throw Error('图片编号无效');const pair=runtime.store.get('pair');url=new URL((pair.storageBackend==='d1'?'/v2/executor/':'/v1/executor/')+'workspace/media/'+assetId,pair.endpoint);url.searchParams.set('workspace',pair.workspaceId);headers.Authorization='Bearer '+pair.deviceToken;}
  else{url=new URL(ref);if(url.protocol!=='https:'||url.username||url.password||/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(url.hostname))throw Error('素材地址不是公开 HTTPS 图片');}
  const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});await assertCurrent();const mime=response.headers.get('content-type')?.split(';')[0]||'';if(!response.ok||!mime.startsWith('image/')||Number(response.headers.get('content-length'))>6*1024*1024)throw Error('图片响应无效或过大');
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>6*1024*1024)throw Error('图片超过 6 MB');chunks.push(chunk);}const bytes=Buffer.concat(chunks);validateImageBytes(bytes,mime);await assertCurrent();
  const value={ok:true,dataUrl:'data:'+mime+';base64,'+bytes.toString('base64')},sha256=createHash('sha256').update(bytes).digest('hex'),asset=cloud?catalogue.find(item=>item.asset_id===ref.slice(14)):null;
  const productKey=value=>profiles.canonicalProfileId(value)||String(value).trim().toLowerCase();if(asset?.profile_id&&productKey(asset.profile_id)!==productKey(profile.id))throw Error('图片不属于所选产品');
  const expected=[asset?.sha256,...(profile.mediaVersions||[]).filter(version=>version.ref===ref||cloud&&version.assetId===ref.slice(14)).map(version=>version.sha256)].filter(Boolean);if(expected.some(value=>value!==sha256))throw Error('所选图片版本已变化，请重新选择');
  Object.assign(value,{sha256,source:cloud?'cloud':'remote'});media.set(ref,value);save({usedMedia:[...(state.usedMedia||[]),{ref,sha256,bytes:bytes.length,mime}]});return value;
 }
 const bridge=async message=>{
  await assertCurrent();
  if(message.action==='saveFillLearnings')return captureFillLearning(runtime,{profileId:profile.id,profile,targetId:input.targetId,browserInstance,profileRevision:state.profileRevision},message);
  if(message.action==='fetchCloudSubmissionMedia'||message.action==='fetchSubmissionMedia')return readMedia(message.ref||message.url);
  if(message.action==='mediaUploadStatus'){save({mediaFeedback:[...(state.mediaFeedback||[]),{at:new Date().toISOString(),status:message.status,label:message.fieldLabel||message.name,reason:message.reason,source:message.source,sourceSha256:message.sourceSha256}]});return{ok:true};}
  if(message.action==='log'){runtime.store.appendLog({at:new Date().toISOString(),type:'single_page_refill',profileId:profile.id,url:input.expectedUrl,refillId:id,message:String(message.msg||'').slice(0,4000),level:'info'});return{ok:true};}
  return{ok:false,error:'本次仅填写原网页，不操作投稿任务'};
 };
 try{
  check();if(input.mode==='comment'&&(typeof input.commentText!=='string'||!input.commentText.trim()))throw Error('请输入待填写的评论');await checkCloud();save({});
  const lookup=await resolveOriginalCloudMediaDefaults(profile,async()=>{const assets=[],seen=new Set();let cursor='';do{const result=await runtime.cloud.request('workspace/media'+(cursor?'?cursor='+encodeURIComponent(cursor):''));await assertCurrent();assets.push(...result.assets);cursor=result.next||'';if(cursor&&seen.has(cursor))throw Error('图片目录游标重复');seen.add(cursor);}while(cursor);catalogue.push(...assets);return assets;});await assertCurrent();config=applyOriginalCloudMediaDefaults({...config,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false},lookup.originalMediaDefaults);save(lookup);
  if(config.logoDataUrl)validateImageBytes(Buffer.from(decodeImageAsset(config.logoDataUrl)),config.logoDataUrl.slice(5,config.logoDataUrl.indexOf(';')));
  if(input.mode==='comment')config.commentTemplate=input.commentText;
  config.sidepanelContext={profileId:profile.id,url:page.url()};
  for(const frame of page.frames()){if(!/^https?:\/\//.test(frame.url()))continue;await assertCurrent();const engine=await attachEngine(runtime.context,frame,bridge);engines.push({engine,frame,url:frame.url(),detection:await engine.call({action:'detectPage',config})});}
  const candidate=engines.filter(item=>input.mode==='comment'?item.detection.commentFound:item.detection.operable).sort((a,b)=>(b.detection.formFieldCount||0)-(a.detection.formFieldCount||0))[0];if(!candidate)throw Error(input.mode==='comment'?'未发现评论表单':'未发现可填写表单');
  const call=async message=>{await assertCurrent();const result=await candidate.engine.call(message);await assertCurrent();return result;};
  if(input.mode!=='comment'){const guard=await call({action:'inspectAutoFillGuard',targetDomain:config.targetDomain});if(guard?.blocked)throw Error(guard.reason||'网页已有其他产品内容');}
  if(input.mode!=='comment')await armRefillReceiptWatch(runtime,{state,snapshot,page,config,assertCurrent});
  let fill,actual,validation,counts,submitReady=true;
  if(input.mode==='comment'){const platformType=candidate.detection.platform==='wp_comment'?'wp_comment':'article',fields=await call({action:'getCommentFieldReport',platformType});if(fields?.fields?.length!==1)throw Error('未发现真实评论字段');assertOriginalCommentLength(input.commentText,fields,{});fill=await call({action:'executeSubmit',config,platformType});if(fill?.error||fill?.ok===false)throw Error(fill.error||'评论填写未完成');actual=await call({action:'getCommentFieldReport',platformType});if(actual?.fields?.length!==1||actual.fields[0].value!==input.commentText)throw Error('评论填写未通过回读核验');validation=await call({action:'collectFormValidation'});}
  else{
   fill=await fillOriginalVisitForm({config,platformType:candidate.detection.platform,allowAgent:input.useAgent!==false,cacheKey:id,io:{assertCurrent,call,
    across:async message=>{const active=[];for(const item of engines){await assertCurrent();if(Number((await item.engine.call({action:'countEmptyFields'})).totalCount)>0)active.push(item);}const results=[];for(const item of active.length?active:[candidate]){await assertCurrent();results.push(await item.engine.call(message));await assertCurrent();}return mergeOriginalFrameFill(results);},
    notice:message=>save({updates:[...state.updates,{at:new Date().toISOString(),message}]}),
    model:async(route,body,options)=>{await checkCloud();const result=await runtime.cloud.request(route,body,undefined,options);await checkCloud();return result;},
    settle:ms=>new Promise(resolve=>setTimeout(resolve,ms)),
    captureVisual:async()=>{const prepared=await call({action:'prepareVisualSnapshot'});if(!prepared.ok)throw Error('页面视觉快照准备失败');try{const box=candidate.frame===page.mainFrame()?{x:0,y:0}:await(await candidate.frame.frameElement()).boundingBox();if(!box)throw Error('原嵌入表单不可见');await assertCurrent();const bytes=await capturePageEvidence(runtime.context,page);await assertCurrent();const localScreenshot=join(runtime.home,'refill-'+id+'-'+Date.now()+'.png');await writeFile(localScreenshot,bytes);return{screenshot:'data:image/png;base64,'+bytes.toString('base64'),localScreenshot,elements:(prepared.elements||[]).map(element=>({...element,rect:element.rect?{...element.rect,x:element.rect.x+box.x,y:element.rect.y+box.y}:element.rect})),viewport:await page.evaluate(()=>({width:innerWidth,height:innerHeight}))};}finally{await candidate.engine.call({action:'clearVisualSnapshot'}).catch(()=>{});}},
    recordVisual:async(plan,actions,visual)=>save({visualHistory:[...(state.visualHistory||[]),{status:plan.status,reason:plan.reason,actions:actions.map(action=>({type:action.type,selector:action.selector})),localScreenshot:visual.localScreenshot}]})
   }});
   actual=await call({action:'getFilledFieldsReport'});validation=fill.formState;counts=fill.lastEmpty;submitReady=fill.validation.submitReady!==false&&!validation.validationFailed&&!counts.emptyCount&&!counts.invalidCount&&!fill.agentResult.needs_manual&&!fill.agentResult.captcha&&!fill.agentResult.blocked;
   const classification=await classifyOriginalFillGate(runtime,{url:destinationUrl,fill,assertCurrent});if(classification)fill.classification=classification;
  }
  save({fill,actual,validation,counts,submitReady});await checkCloud();const reason=submitReady?'已再次填写原网页；原收件记录保持，未重复投稿':fill.agentResult?.reason||'仍有必填资料未完成，请检查原网页';save({status:submitReady?'prepared':'needs_manual',reason,completedAt:new Date().toISOString()});
  return{ok:true,refillId:id,filled:true,submitted:false,fillOnly:true,fill,actual,validation,counts,submitReady,reason};
 }catch(error){
  const partial=[];if(!page.isClosed()&&page.url()===input.expectedUrl)for(const item of engines){try{if(!item.frame.isDetached()&&item.frame.url()===item.url&&await item.engine.isCurrentDocument())partial.push({url:item.url,actual:await item.engine.call(input.mode==='comment'?{action:'getCommentFieldReport',platformType:item.detection.platform==='wp_comment'?'wp_comment':'article'}:{action:'getFilledFieldsReport'})});}catch{}}
  save({status:'needs_manual',error:error.message,...(partial.length?{partialActual:partial}: {})});throw error;
 }finally{for(const item of engines)await item.engine.detach();}
}

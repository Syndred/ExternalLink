import {createHash} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';import {priorProductSuccess} from './shared.mjs';
export function canRestoreLostPreparation(task,input,host){
 if(task.status!=='needs_manual'||task.receipt||!task.targetId||task.targetId!==input.expectedTargetId||task.browserInstance===host||
  (task.attemptBoundary??null)!==(input.expectedAttemptBoundary??null)||task.lostPreparationRecoveries?.some(r=>r.targetId===task.targetId))return false;
 if(task.url==='https://toolscout.ai/submit')return !task.attemptBoundary&&task.siteStatus==='not_submitted'&&task.logoutRecovery===true&&
  task.stageHistory?.some(s=>s.stage===5)&&task.attemptHistory?.every(a=>
   a.kind==='verified_non_submission_action'&&(a.submitResult?.clickedSubmit===false||a.submitResult?.reason==='no_submit_button')||
   a.kind==='verified_logout_only'&&a.networkResponses?.length===1&&a.networkResponses[0].url==='https://toolscout.ai/auth/logout'&&a.networkResponses[0].status===302);
 if(/^https:\/\/(?:www\.)?futuretools\.io\/submit-a-tool\/?$/.test(task.url))return !!task.attemptBoundary&&task.siteStatus==='rejected'&&
  task.attentionType==='human_verification'&&task.reason.includes('Please complete the captcha before submitting')&&
  task.submitResult?.submitted===false&&task.submitResult.validationFailed===true&&!(task.networkResponses||[]).length&&!(task.submitResult.networkResponses||[]).length;
 return false;
}
export async function restoreLostPreparation(runtime,task,input){
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.pending().length)throw new Error('受限原页恢复需要暂停空闲及完整回读');
 if(!runtime.context)await runtime.connect();
 if(!canRestoreLostPreparation(task,input,runtime.host.startedAt))throw new Error('原任务没有明确的未投稿准备或真人拒绝证据，不能恢复边界');
 await runtime.synchronize();const remote=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
 for(const k of ['attemptBoundary','attemptHistory','reason','siteStatus','targetId','browserInstance','stageHistory','artifactRef','artifactSha256'])
  if(!isDeepStrictEqual(remote?.[k]??null,JSON.parse(JSON.stringify(task[k]??null))))throw new Error('旧任务证据尚未独立回读');
 const artifact=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:task.artifactRef});
 if(createHash('sha256').update(Buffer.from(artifact.dataUrl.split(',')[1],'base64')).digest('hex')!==task.artifactSha256)throw new Error('旧截图回读不一致');
 const snapshot=await runtime.cloud.request('snapshot'),profile=snapshot.documents.siteProfiles?.[task.profileId];
 if(!profile||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw new Error('云端已有本产品收件或资料缺失');
 await runtime.lease(task);const previous={at:new Date().toISOString(),targetId:task.targetId,browserInstance:task.browserInstance,attemptBoundary:task.attemptBoundary,
  reason:task.reason,artifactRef:task.artifactRef,artifactSha256:task.artifactSha256,actualSubmission:task.actualSubmission,submitResult:task.submitResult,networkResponses:task.networkResponses,stageHistory:task.stageHistory};
 const attempts=task.attemptBoundary?[...(task.attemptHistory||[]),{...previous,at:task.attemptBoundary,kind:'verified_captcha_rejection'}]:task.attemptHistory;
 runtime.update(task,{lostPreparationRecoveries:[...(task.lostPreparationRecoveries||[]),previous],attemptHistory:attempts,
  attemptBoundary:null,targetId:null,browserInstance:null,stageHistory:[],baselineEvidence:'',status:'pending',siteStatus:'not_submitted',controller:'executor',
  profileSnapshot:profile,profileRevision:snapshot.revisions.siteProfiles,attentionType:'',submitResult:null,networkResponses:[],
  consentHistory:[...(task.consentHistory||[]),{at:previous.at,scope:'ordinary_submission_permissions',source:'user_reply',text:'用户已授权必要的普通免费投稿及注册权限'}],
  reason:'旧宿主页面丢失，明确非投稿准备或真人拒绝证据已保留并独立回读，仅恢复原免费流程至人工验证'},'lost_preparation_restored');
 await runtime.synchronize();return runtime.status();
}

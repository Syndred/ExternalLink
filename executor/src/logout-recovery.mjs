import{createHash}from'node:crypto';import{isDeepStrictEqual}from'node:util';import{priorProductSuccess}from'./shared.mjs';
export function isToolScoutLogoutOnly(task){return task.url==='https://toolscout.ai/submit'&&task.status==='submitted_unconfirmed'&&!task.receipt&&!!task.attemptBoundary&&
 task.networkResponses?.length===1&&task.networkResponses[0].url==='https://toolscout.ai/auth/logout'&&task.networkResponses[0].status===302&&
 task.submitResult?.networkResponses?.length===1&&task.submitResult.networkResponses[0].url==='https://toolscout.ai/auth/logout';}
export function logoutAuthObservation(task,input){if(!isToolScoutLogoutOnly(task))return null;return task.observationHistory?.find(o=>o.targetId===(input.observationTargetId||task.authObservationTargetId)&&o.artifactRef&&!o.closedAt&&new URL(o.url).origin==='https://toolscout.ai')||null;}
export function canRecoverLogout(task,input,observation){
 const text=observation?.frames?.find(f=>f.url==='https://toolscout.ai/submissions')?.text||'';
 const brand=task.profileSnapshot?.name||'JevPlay',host=new URL(task.profileSnapshot?.url||'https://jevplay.com').hostname;
 return isToolScoutLogoutOnly(task)&&!task.logoutRecovery&&input.expectedAttemptBoundary===task.attemptBoundary&&observation?.url==='https://toolscout.ai/submissions'&&!!observation.artifactRef&&
 /Your Submissions/.test(text)&&/\d+ submitted tools?|No submissions yet/i.test(text)&&!text.toLowerCase().includes(brand.toLowerCase())&&!text.toLowerCase().includes(host);
}
export async function recoverToolScoutLogout(runtime,task,input){
 if(runtime.job||runtime.store.get('paused')!==true||runtime.store.pending().length)throw new Error('退出动作恢复要求暂停空闲与事件完整回读');
 const observation=task.observationHistory?.findLast(o=>o.url==='https://toolscout.ai/submissions');
 if(!canRecoverLogout(task,input,observation))throw new Error('只有唯一退出请求及完整账户无本产品证明才可恢复一次');
 await runtime.synchronize();const remote=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
 if(!isDeepStrictEqual(remote?.observationHistory,JSON.parse(JSON.stringify(task.observationHistory)))||remote?.attemptBoundary!==task.attemptBoundary||remote?.receipt)throw new Error('账户核验及任务证据未回读');
 const artifact=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:observation.artifactRef});if(createHash('sha256').update(Buffer.from(artifact.dataUrl.split(',')[1],'base64')).digest('hex')!==observation.artifactSha256)throw new Error('账户截图回读不一致');
 const snapshot=await runtime.cloud.request('snapshot'),profile=snapshot.documents.siteProfiles?.[task.profileId];if(!profile||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw new Error('资料缺失或云端已有本产品收件');
 await runtime.lease(task);const previous={at:task.attemptBoundary,kind:'verified_logout_only',submitResult:task.submitResult,networkResponses:task.networkResponses,actualSubmission:task.actualSubmission,
  originalEvidence:task.authenticationHistory?.[0],inventoryProof:{url:observation.url,artifactRef:observation.artifactRef,artifactSha256:observation.artifactSha256,text:observation.frames[0].text}};
 runtime.update(task,{attemptHistory:[...(task.attemptHistory||[]),previous],logoutRecovery:true,attemptBoundary:null,baselineEvidence:'',targetId:null,browserInstance:null,status:'pending',siteStatus:'not_submitted',submitResult:null,networkResponses:[],attentionType:'',controller:'executor',profileSnapshot:profile,profileRevision:snapshot.revisions.siteProfiles,stageHistoryBeforeLogout:task.stageHistory,stageHistory:[],reason:'Google登录及完整账户清单核验完成，无JevPlay；旧唯一请求为退出，保留全部证据后仅恢复原任务一次'},'logout_only_recovered');await runtime.synchronize();return runtime.status();
}

import {createHash} from 'node:crypto';import {isDeepStrictEqual} from 'node:util';
export async function annotateObservation(runtime,task,input){
 if(runtime.job || runtime.store.get('paused')!==true || runtime.store.pending().length || !String(input.reason||'').trim())throw new Error('核验注释需要暂停空闲、无待回读事件与明确原因');
 const observation=task.observationHistory?.find(o=>o.targetId===input.expectedTargetId);
 if(!observation?.artifactRef || !observation.artifactSha256 || !observation.frames?.some(f=>f.text))throw new Error('查询证据不完整');
 await runtime.synchronize();const remote=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
 if(!isDeepStrictEqual(remote?.observationHistory,JSON.parse(JSON.stringify(task.observationHistory))))throw new Error('查询证据未独立回读');
 const artifact=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:observation.artifactRef});
 if(createHash('sha256').update(Buffer.from(artifact.dataUrl.split(',')[1],'base64')).digest('hex')!==observation.artifactSha256)throw new Error('查询截图回读不一致');
 await runtime.lease(task);
 const note={at:new Date().toISOString(),targetId:observation.targetId,url:observation.url,reason:String(input.reason).slice(0,2000),artifactRef:observation.artifactRef,artifactSha256:observation.artifactSha256};
 runtime.update(task,{reason:note.reason,attentionType:String(input.attentionType||'manual').slice(0,60),observationNotes:[...(task.observationNotes||[]),note],
 ...(input.freeRegistrationAuthorization==='explicit_user_approved'&&!task.attemptBoundary&&!task.receipt?{consentHistory:[...(task.consentHistory||[]),{at:note.at,scope:'ordinary_free_registration',source:'user_reply',text:'用户明确允许必要的普通免费站点注册，使用核实姓名与邮箱，密码仅保存本机'}]}:{})},'verified_observation_note');
 await runtime.synchronize();const after=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
 if(!isDeepStrictEqual(after?.observationNotes,JSON.parse(JSON.stringify(task.observationNotes))))throw new Error('注释回读待恢复');return runtime.status();
}

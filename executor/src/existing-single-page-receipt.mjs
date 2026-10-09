import {isDeepStrictEqual} from 'node:util';
import {queue,priorProductSuccess,plain} from './shared.mjs';
import {cloudDigest,cacheCloudSnapshot} from './cloud-sync-state.mjs';
import {pendingApplication,applicationMutationKeys,enqueueLibraryMutation,flushApplicationMutations} from './application-mutations.mjs';
import {persistedExistingReceipt,existingReceiptTimelineContains} from '../../core/existing-receipt.mjs';

export function existingSinglePageReceipt(runtime,snapshot,profileId,url,panel){
 const matches=Object.entries(snapshot.documents.submissionRecords||{}).filter(([key,record])=>persistedExistingReceipt({[key]:record},key)&&priorProductSuccess({[key]:record},profileId,url));
 const exact=matches.find(([,record])=>queue.normalizeDestinationKey(record.destinationKey)===queue.normalizeDestinationKey(url));
 const selected=exact||matches.length===1&&matches[0];if(!selected)throw Error('同站原收件身份不唯一或不完整，请核验原记录');
 const [recordKey,record]=selected;return plain({recordKey,record,url,profileId,profile:snapshot.documents.siteProfiles[profileId],connection:cloudDigest(runtime.store.get('pair')),panel:{id:panel.id,generation:panel.generation,profileId:panel.profileId,selectedTargetId:panel.selectedTargetId}});
}
export function existingReceiptTaskConflict(task,state,browserInstance){
 return !task.tabClosedAt&&task.targetId===state.panel.selectedTargetId&&task.browserInstance===browserInstance||task.profileId===state.profileId&&queue.extractDomain(task.url)===queue.extractDomain(state.url)&&(task.attemptBoundary&&!task.receipt||task.syncConflict||['ai','supervisor'].includes(task.controller));
}
export async function verifyExistingSinglePageReceipt(runtime,state,assertCurrent){
 const check=()=>{assertCurrent();if(state.connection!==cloudDigest(runtime.store.get('pair'))||runtime.store.values('task:').some(task=>existingReceiptTaskConflict(task,state,runtime.host?.startedAt)))throw Error('原连接、任务或页面归属已变化，保留原页核验');};
 check();const inventory=await runtime.cloud.request('runs?view=inventory');check();if(inventory.tasks.some(task=>existingReceiptTaskConflict(task,state,runtime.host?.startedAt)))throw Error('同站原任务仍需核验，保留原页');
 const validate=snapshot=>{check();if(!isDeepStrictEqual(snapshot.documents.submissionRecords?.[state.recordKey],state.record)||!isDeepStrictEqual(snapshot.documents.siteProfiles?.[state.profileId],state.profile))throw Error('原收件或产品资料已变化，保留原页重新核验');};
 let snapshot=await runtime.cloud.request('snapshot');validate(snapshot);
 const ledgerPending=()=>pendingApplication(runtime).filter(item=>applicationMutationKeys(item).some(key=>['submissionRecords','submissionTimeline'].includes(key)));
 if(ledgerPending().some(item=>item.operation.type!=='receipt_timeline_repair'||item.operation.recordKey!==state.recordKey||!isDeepStrictEqual(item.operation.expectedRecord,state.record)))throw Error('原收件或时间线有待同步修改，请先处理');
 if(ledgerPending().length){await flushApplicationMutations(runtime);check();if(ledgerPending().length)throw Error('旧回执动态尚未同步，保留原页');snapshot=await runtime.cloud.request('snapshot');validate(snapshot);}
 if(!existingReceiptTimelineContains(snapshot.documents.submissionTimeline,state.recordKey,state.record)){
  cacheCloudSnapshot(runtime,snapshot);await enqueueLibraryMutation(runtime,{operation:{type:'receipt_timeline_repair',recordKey:state.recordKey,expectedRecord:state.record}});check();
  snapshot=await runtime.cloud.request('snapshot');validate(snapshot);
 }
 if(ledgerPending().length||!existingReceiptTimelineContains(snapshot.documents.submissionTimeline,state.recordKey,state.record))throw Error('云端尚未回读到原收件对应的历史动态');
 return {ok:true,existingSubmission:true,submitted:false,cloudSynced:true,reason:'已有收件及历史动态已核验，未重复投稿。'};
}

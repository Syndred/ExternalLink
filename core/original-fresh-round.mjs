import {batchJson} from './workbench-batch-recovery.mjs';

// Original buildDestinationGroups starts from receipts and site annotations,
// not the previous round's skip/error statuses. These native guards preserve
// the extra durable attempt and controller boundaries introduced by migration.
export const freshRoundHost = url => new URL(url).hostname.toLowerCase().replace(/^www\./,'');
export const freshRoundRetiredIdentity = (successorId, sourceId) => 'retired:'+successorId+':'+sourceId;
export const freshRoundSuccessor = identity => String(identity||'').startsWith('retired:')?String(identity).split(':')[1]:null;
export function freshRoundTaskReason(task) {
  if(!task?.id||!task.runId||!task.profileId||!task.url||!task.destinationKey)return '原任务身份不完整';
  if(task.receipt||task.attemptBoundary||task.cloudVerified||['accepted','submitted','submitted_unconfirmed','sent_unconfirmed','under_review','live'].includes(task.siteStatus))return '同站原任务已有收件或未知投稿，须先核验';
  if(task.syncConflict||['supervisor','ai'].includes(task.controller)||['queued','preparing'].includes(task.originalResume?.status)||['queued','preparing'].includes(task.parkedResume?.status))return '原任务存在同步冲突、接管或待恢复操作';
  const history=task.attempts||task.attemptHistory||[],attempts=Array.isArray(history)?history:typeof history==='object'?Object.values(history):[];
  if(attempts.some(attempt=>attempt?.attemptBoundary||attempt?.receipt||['submitting','submitted_unconfirmed','sent_unconfirmed','unknown','success'].includes(attempt?.status)))return '原任务历史尝试仍须核验';
  if(!['skip','err','failed','excluded','blocked','cancelled','canceled'].includes(task.status))return '同站原任务仍在执行、待办或结果尚未核验';
  return '';
}
export async function freshRoundProof(task,hash) {
  return {sourceTaskId:task.id,sourceRunId:task.runId,sourceVersion:task.version,sourceSha256:await hash(batchJson(task))};
}
export async function validateFreshRoundSource(source,proof,target,hash) {
  const fail=message=>{throw Object.assign(Error(message),{status:409});};
  if(!proof||Object.keys(proof).sort().join(',')!=='sourceRunId,sourceSha256,sourceTaskId,sourceVersion'||!Number.isSafeInteger(proof.sourceVersion)||proof.sourceVersion<1||!/^[a-f0-9]{64}$/.test(proof.sourceSha256||'')||!/^[a-zA-Z0-9_-]{1,100}$/.test(target.id||''))fail('新一轮原任务证明无效');
  const reason=freshRoundTaskReason(source);if(reason)fail(reason);
  if(source.originalFreshRoundSuccessorTaskId||source.id!==proof.sourceTaskId||source.runId!==proof.sourceRunId||source.version!==proof.sourceVersion||source.profileId!==target.profileId||freshRoundHost(source.url)!==freshRoundHost(target.url)||source.id===target.id||source.runId===target.runId||proof.sourceSha256!==await hash(batchJson(source)))fail('原任务或新一轮范围已变化，保留旧记录');
}

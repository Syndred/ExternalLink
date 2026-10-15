import {isDeepStrictEqual} from 'node:util';
import {plain} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import {originalTaskSync} from './original-agent-unavailable.mjs';

// A single DOM-proved free request-type selection before ordinary filling.
// This does not authorize submission, payment, sponsored quotes or legal assent.
export async function prepareExplicitFreeRoute(runtime,{task,page,candidate,active,config,offline=false}) {
  const proof=candidate.detection?.freeSubmissionRoute;
  if(!candidate.detection?.submitBlocker?.payment_uncertain||!proof||proof.selected)return false;
  const scope=workbenchScope(runtime.store.get('pair'));
  const identity=Object.fromEntries(['id','runId','profileId','profileRevision','targetId','browserInstance','version','controllerId'].map(key=>[key,task[key]]));
  const assertCurrent=async()=>{
    const check=()=>{
      if(!active()||task.attemptBoundary||task.receipt||task.controller!=='executor'||page.isClosed()||
          scope!==workbenchScope(runtime.store.get('pair'))||
          !Object.entries(identity).every(([key,value])=>task[key]===value)||
          !isDeepStrictEqual(plain(runtime.store.get('task:'+task.id)),plain(task)))
        throw Object.assign(Error('免费投稿准备任务、控制权或授权已变化；未选择'),{staleTask:true});
    };
    check();
    if(candidate.frame.url()!==candidate.url||!await candidate.engine.isCurrentDocument())
      throw Object.assign(Error('免费投稿准备原文档已变化；未选择'),{staleTask:true});
    check();
  };
  await assertCurrent();
  const history=structuredClone(task.freeRoutePreparationHistory||[]);
  if(history.some(item=>item.selector===proof.selector&&['started','selected'].includes(item.status)))
    throw Error('原免费投稿类别已开始选择，先观察原页面，不重复未知准备动作');
  if(history.length>=20)throw Error('免费投稿类别准备记录已满，保留原任务');
  const index=history.length,at=new Date().toISOString();
  history.push({at,status:'started',proof:structuredClone(proof),selector:proof.selector,
    taskId:task.id,targetId:task.targetId,browserInstance:task.browserInstance,frameUrl:candidate.url});
  runtime.update(task,{freeRoutePreparationHistory:history},'explicit_free_route_preparation_boundary');
  if(!offline)await originalTaskSync(()=>flushBatchTaskEvents(runtime,task));
  await assertCurrent();
  const outcome=await candidate.engine.call({action:'prepareExplicitFreeSubmissionRoute',proof});
  await assertCurrent();
  history[index]={...history[index],status:outcome?.ok&&outcome.selected?'selected':'not_selected',
    observedAt:new Date().toISOString(),outcome:plain(outcome||{})};
  const patch={freeRoutePreparationHistory:history};
  if(outcome?.unexpectedSubmission)Object.assign(patch,{attemptBoundary:at,status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',
    reason:outcome.reason||'免费类别准备发生意外提交；先核验，禁止重投'});
  runtime.update(task,patch,outcome?.unexpectedSubmission?'explicit_free_route_unexpected_submission':'explicit_free_route_preparation_observed');
  if(!offline)await originalTaskSync(()=>flushBatchTaskEvents(runtime,task));
  if(outcome?.unexpectedSubmission)throw Object.assign(Error(task.reason),{preparationResult:{unconfirmed:true}});
  await assertCurrent();
  if(!outcome?.ok||!outcome.selected)throw Error(outcome?.reason||outcome?.error||'网页未确认免费投稿类别');
  candidate.detection=await candidate.engine.call({action:'detectPage',config});
  await assertCurrent();
  return true;
}

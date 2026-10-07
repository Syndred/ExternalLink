// Caller must authenticate the workspace. Viewing shared work never grants a device lease.
export async function readJournal(sql,workspaceId,query){
  const taskId=query.get('taskId');
  if(taskId){const rows=await sql`select data from externallink_executor_tasks where workspace_id=${workspaceId} and task_id=${taskId}`;return{ok:true,task:rows[0]?.data||null};}
  const limit=Math.max(1,Math.min(200,Number(query.get('limit'))||200)),after=query.get('after')||'';
  const rows=await sql`select task_id,jsonb_build_object('id',task_id,'profileId',data->>'profileId','url',data->>'url',
    'destinationKey',data->>'destinationKey','status',data->>'status','siteStatus',data->>'siteStatus',
    'reason',data->>'reason','attentionType',data->>'attentionType','attemptBoundary',data->'attemptBoundary',
    'receipt',data->'receipt','reviewStatus',data->>'reviewStatus','artifactRef',data->>'artifactRef',
    'profileRevision',data->'profileRevision','source','cloud','updatedAt',updated_at) as summary
    from externallink_executor_tasks where workspace_id=${workspaceId} and task_id>${after}
    order by task_id limit ${limit+1}`;
  return{ok:true,tasks:rows.slice(0,limit).map(r=>r.summary),next:rows.length>limit?rows[limit-1].task_id:null};
}

export function automationSummary(state={}){
  return {...Object.fromEntries(['id','url','profileId','destinationKey','status','siteStatus','attentionType','reason','attemptBoundary','artifactRef','profileRevision','version','workbenchBatchId','workbenchBatchRecoveryVersion','workbenchBatchConfigSha256','workbenchBatchScopeSha256'].filter(k=>state[k]!==undefined).map(k=>[k,state[k]])),...(state.workbenchBatchCheckpoint?{workbenchBatchCheckpointRevision:state.workbenchBatchCheckpoint.cloudCheckpointRevision}:{})};
}

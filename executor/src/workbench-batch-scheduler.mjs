import {nextWorkbenchTask,finishWorkbenchTask,pauseWorkbenchBatch} from './workbench-features.mjs';
import {assertBatchPolicy,batchConfig} from './workbench-batch-policy.mjs';

export function workbenchConcurrency(batch){const config=batchConfig(batch);return config.unattended?1:Math.max(1,parseInt(config.concurrency,10)||1);}
// Dispatch is serialized; each browser task has its own identity and promise.
// Completion may be out of order, but the cursor only passes completed items.
export async function runWorkbenchBatch(runtime){
 const id=runtime.store.get('activeWorkbenchBatch'),jobs=new Map();runtime.activeTaskIds??=new Set();
 const current=()=>runtime.store.get('activeWorkbenchBatch')===id&&runtime.store.get('workbenchBatch:'+id);
 await runtime.synchronize();if(runtime.store.get('paused')!==false)return;if(!runtime.context)await runtime.connect();
 try{
  while(runtime.store.get('paused')===false&&current()?.status==='running'){
   const batch=current();assertBatchPolicy(runtime,batch);const limit=workbenchConcurrency(batch);
   while(runtime.store.get('paused')===false&&jobs.size<limit&&current()?.status==='running'){
    const inFlightAtSelection=jobs.size,task=await nextWorkbenchTask(runtime,{single:false});if(!task){if(inFlightAtSelection&&!jobs.size)continue;break;}
    runtime.activeTaskIds.add(task.id);runtime.activeTaskId=[...runtime.activeTaskIds][0];
    const job=Promise.resolve().then(()=>runtime.work({taskId:task.id})).catch(error=>{
     runtime.cloudError=error.message;runtime.store.set('paused',true);pauseWorkbenchBatch(runtime,error.message);
    }).finally(()=>{
     finishWorkbenchTask(runtime,task.id);jobs.delete(task.id);runtime.activeTaskIds.delete(task.id);runtime.activeTaskId=[...runtime.activeTaskIds][0]||null;
    });jobs.set(task.id,job);
   }
   if(!jobs.size)break;await Promise.race(jobs.values());
  }
 }finally{
  await Promise.allSettled(jobs.values());
  // Read back terminal evidence only after its owning worker has relinquished
  // the task, so another worker cannot overwrite a receipt or screenshot.
  await runtime.synchronize();
 }
}

import{randomUUID}from'node:crypto';
import'../../core/submission-timeline.js';
import'../../core/journal-sync.js';
export const workbenchScope=pair=>String(pair?.endpoint||'')+'|'+String(pair?.workspaceId||'default');
export const pendingWorkbench=runtime=>(runtime.store.get('workbenchJournalPending')||[]).filter(item=>item.scope===workbenchScope(runtime.store.get('pair')));
export function journalSync(runtime){
 if(!runtime.workbenchJournalSync){const original=globalThis.ExtLinkJournalSync.create({
  storage:{get:async()=>({d1JournalPending:runtime.store.get('workbenchJournalPending')||[]}),set:async data=>runtime.store.set('workbenchJournalPending',data.d1JournalPending)},
  config:async()=>runtime.store.get('pair'),
  request:async(path,options)=>{if(options.method==='POST')return runtime.cloud.request('workspace/timeline',options.body);const proof=await runtime.cloud.request('workspace/journal-documents');return{ok:true,data:proof.documents.submissionTimeline||{}};}
 });const run=async work=>{if(runtime.cloudPullOperation)await runtime.cloudPullOperation.catch(()=>{});runtime.workbenchTimelineBusy=(runtime.workbenchTimelineBusy||0)+1;try{return await work();}finally{runtime.workbenchTimelineBusy--;}};runtime.workbenchJournalSync={enqueue:event=>run(()=>original.enqueue(event)),flush:()=>run(()=>original.flush())};}return runtime.workbenchJournalSync;
}
export async function workbenchDocuments(runtime){
 const scope=workbenchScope(runtime.store.get('pair'));
 try{const snapshot=await runtime.cloud.request('workspace/journal-documents');runtime.store.set('workbenchDocuments',{scope,snapshot,at:new Date().toISOString()});return{...snapshot,cached:false};}
 catch(error){const saved=runtime.store.get('workbenchDocuments');if(saved?.scope!==scope)throw error;return{...saved.snapshot,cached:true,cachedAt:saved.at,error:error.message};}
}
export async function enqueueWorkbench(runtime,input){
 const event=globalThis.ExtLinkSubmissionTimeline.normalizeEvent({...input.event,id:input.event?.id||randomUUID(),source:'manual',confirmedBy:'manual'});
 const result=await journalSync(runtime).enqueue(event);return{...result,event};
}

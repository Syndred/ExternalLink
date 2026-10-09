// Preserve the original content-script log context in the native journal.
export function formEngineLogEntry(task,message,{profileId=task?.profileId,url=task?.url,domain}={}) {
 const entry={at:new Date().toISOString(),type:'form_engine',runId:task?.runId,taskId:task?.id,profileId,url,message:String(message.msg||'').slice(0,4000),level:message.cls==='err'?'error':message.cls==='warn'?'warn':message.cls==='ok'?'success':'info',cls:message.cls||'',event:String(message.event||'content_step').slice(0,80)};
 if(task?.index)entry.taskIndex=task.index;
 if(domain)entry.domain=String(domain).slice(0,255);
 return entry;
}

const sources={cloud:'云端媒体',remote:'远程图片',embedded:'产品资料内置图片',mixed:'混合图片来源',original_frozen_backup:'原任务冻结备份'};
const text=value=>typeof value==='string'?value.trim().slice(0,500):'';
export function recordTaskMediaUpload(runtime,task,message){
 const current=runtime.store.get('task:'+task.id);
 if(!current||!task.targetId||!task.browserInstance||['targetId','browserInstance','profileId','runId','profileRevision','version'].some(key=>current[key]!==task[key])||['ai','supervisor'].includes(current.controller))return{ok:false,error:'原图片上传任务已变化'};
 if(!Number.isInteger(message.executorDocumentId)||!message.pageUrl||message.pageUrl!==message.executorFrameUrl)return{ok:false,error:'图片上传页面已变化'};
 if(!['success','failed'].includes(message.status))return{ok:false,error:'图片上传状态无效'};
 const item={label:text(message.fieldLabel||message.label||message.name)||'文件字段',name:text(message.name),source:sources[message.source]||'页面',reason:text(message.reason),
  ...(Number.isFinite(message.bytes)&&message.bytes>=0&&message.bytes<=6*1024*1024?{bytes:message.bytes}:{}),...(typeof message.mime==='string'&&/^image\/[a-z0-9.+-]+$/i.test(message.mime)?{mime:message.mime}:{}),
  ...(/^[a-f0-9]{64}$/.test(message.sourceSha256||'')?{sourceSha256:message.sourceSha256}: {})};
 const old=current.mediaUploadState||{},key=message.status==='success'?'uploaded':'skipped',entries=old[key]||[],duplicate=entries.some(entry=>entry.label===item.label&&entry.name===item.name&&(key==='uploaded'?entry.source===item.source:entry.reason===item.reason)),status=key==='uploaded'?'ok':'warn';
 if(!duplicate||old.status!==status)runtime.update(task,{mediaUploadState:{...old,uploaded:old.uploaded||[],skipped:old.skipped||[],[key]:duplicate?entries:[...entries,item],status}},'media_upload_'+message.status);
 return{ok:true,duplicate};
}

const closureBrowser=task=>{
 const checkpoint=task.recoveryCheckpoint;
 if(checkpoint?.closedAt===task.tabClosedAt&&task.closedTargetIds?.includes(checkpoint.sourceTargetId))return checkpoint.sourceBrowserInstance;
 return [...(task.tabHistory||[])].reverse().find(entry=>entry.closedAt===task.tabClosedAt&&task.closedTargetIds?.includes(entry.targetId))?.browserInstance;
};

// A timestamp alone is conservative legacy evidence. Only explicit target
// IDs plus a matching browser generation can prove it belongs to another page.
export function currentPageClosed(task){
 if(!task?.tabClosedAt)return false;
 if(task.targetId&&task.browserInstance&&Array.isArray(task.closedTargetIds)&&task.closedTargetIds.length&&closureBrowser(task)===task.browserInstance&&!task.closedTargetIds.includes(task.targetId))return false;
 return true;
}

export function assertTaskPageCreationAllowed(task){
 if(task.attemptBoundary||task.receipt||task.status==='submitted_unconfirmed'||task.siteStatus==='sent_unconfirmed')throw Object.assign(Error('原任务已有投稿结果或未知边界，保留原页核验，禁止新开投稿页'),{staleTask:true});
}

function archivedPage(task,{at,action,targetId,browserInstance,url}){
 return{at,action,targetId,browserInstance,url,previous:structuredClone({targetId:task.recoveryCheckpoint?.sourceTargetId||task.targetId,browserInstance:closureBrowser(task)||task.browserInstance,tabClosedAt:task.tabClosedAt||null,closedTargetIds:task.closedTargetIds||[],closeReason:task.closeReason||'',attentionType:task.attentionType||'',reason:task.recoveryCheckpoint?.blockedReason||task.reason||'',recoveryCheckpoint:task.recoveryCheckpoint||null,cleanupFailure:task.cleanupFailure||null})};
}

export function taskPageRegistrationPatch(task,{targetId,browserInstance},{created=false,source='automatic_task_page',recoveryUrl,at=new Date().toISOString()}={}){
 if(!targetId||!browserInstance)throw Error('原任务新页登记缺少目标或浏览器身份');
 const patch={targetId,browserInstance};if(!created)return patch;
 assertTaskPageCreationAllowed(task);
 const prior=task.targetId||task.tabClosedAt||task.recoveryCheckpoint;
 return{...patch,tabClosedAt:null,closedTargetIds:[],closeReason:'',attentionType:'',cleanupFailure:null,recoveryCheckpoint:null,...(prior?{recoveryHistory:[...(task.recoveryHistory||[]),archivedPage(task,{at,action:source,targetId,browserInstance,url:recoveryUrl||task.url})]}:{})};
}

// Applied only after normal cleanup has verified the original task/page/scope.
// It retains a previous closure without making the newly opened page manual.
export function previousPageClosurePatch(task,at=new Date().toISOString()){
 if(!task.tabClosedAt||currentPageClosed(task))return{};
 return{tabClosedAt:null,closedTargetIds:[],closeReason:'',...(task.receipt?{attentionType:''}:{}),recoveryHistory:[...(task.recoveryHistory||[]),archivedPage(task,{at,action:'previous_page_closure_archived',targetId:task.targetId,browserInstance:task.browserInstance,url:task.url})]};
}

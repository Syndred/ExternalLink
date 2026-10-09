import {batchReport,automationLedger,plain} from './shared.mjs';
import {workbenchScope} from './workbench-sync.mjs';

const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value?.[key]!==undefined).map(key=>[key,plain(value[key])]));
const stateLabels={preview:'范围预览',running:'运行中',paused:'已暂停',stopped:'已停止',finished:'已结束',complete:'已结束',failed:'失败',pending:'待处理',opening:'打开页面中',filling:'填写中',submitting:'提交中',ok:'取得回执',err:'失败',skip:'跳过',needs_manual:'待人工',submitted_unconfirmed:'提交结果待核验',unregistered:'尚未注册',registration_unknown:'注册结果待核验',registration_rejected:'注册被拒绝',published:'已上线',pending_moderation:'等待审核',sent_unconfirmed:'提交结果待核验',unknown:'待核验'};
const label=value=>stateLabels[value]||({under_review:'等待审核',submitted:'已提交，待核验',needs_login:'需要登录',needs_captcha:'需要验证码',registration_unknown:'注册结果待核验',manual:'待人工'}[value])||'待核验';
const stamp=value=>Number.isFinite(Date.parse(value))?Date.parse(value):0;
const safeName=value=>String(value).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,160)||'原批次';
const sourceId=(kind,id)=>kind+':'+id;
const taskKeys=['id','runId','profileId','profileRevision','url','destinationKey','status','siteStatus','reason','createdAt','updatedAt','preparedAt','finishedAt','attentionType','controller','attemptBoundary','receipt','cloudVerified','syncStatus','reviewStatus','artifactRef','screenshot','actualPreparation','actualSubmission','indexNowNotification','mediaManifest','profileMediaSnapshot'];
const eventKeys=['id','at','taskId','runId','profileId','url','type','status','action','target','result','reason','message','level','cls','event','domain','taskIndex','errorCode','artifactRef','evidenceType','before','after','attempt','seq'];

function allowed(value,scope){return (!value?.scope||value.scope===scope)&&(!value?.workspaceId||value.workspaceId===scope.slice(scope.lastIndexOf('|')+1));}
function pairScope(runtime){const pair=runtime.store.get('pair');if(!pair?.endpoint)throw Error('请先连接原工作区，再导出其记录');return workbenchScope(pair);}
function enumerate(runtime,scope){
  const store=runtime.store,sources=[];
  for(const batch of store.values('workbenchBatch:'))if(allowed(batch,scope))sources.push({kind:'workbench',id:batch.id,value:batch,at:batch.startedAt||batch.createdAt});
  for(const frozen of store.values('acceptance:'))if(allowed(frozen,scope))sources.push({kind:'acceptance',id:frozen.id,value:frozen,at:frozen.startedAt||frozen.at});
  for(const run of store.values('run:'))if(allowed(run,scope))sources.push({kind:'run',id:run.id,value:run,at:run.createdAt||run.startedAt});
  const histories=store.values('originalRunHistory:').filter(value=>value.scope===scope).sort((a,b)=>stamp(b.restoredAt)-stamp(a.restoredAt));
  // Original local history is read only: it never becomes an executable batch.
  const originalBatch=store.get('activeBatchRun'),originalLedger=store.get('automationRunLedger');
  if(allowed(originalBatch,scope)&&allowed(originalLedger,scope)&&(originalBatch||originalLedger))histories.unshift({id:'local',activeBatchRun:originalBatch,automationRunLedger:originalLedger});
  for(const history of histories){
    if(history.activeBatchRun?.runId)sources.push({kind:'original-batch',id:history.id,value:history.activeBatchRun,at:history.activeBatchRun.startedAt});
    const ledger=history.automationRunLedger;
    for(const id of ledger?.order||[])if(ledger.runs?.[id])sources.push({kind:'original-run',id:history.id+':'+id,value:ledger.runs[id],at:ledger.runs[id].startedAt,originalRunId:id});
  }
  return sources.map(source=>({...source,sourceId:sourceId(source.kind,source.id)}));
}

function nativeBatch(runtime,source,scope){
  const store=runtime.store,value=source.value;
  let rows,metadata=value;
  if(source.kind==='workbench'){
    if(!Array.isArray(value.items)||value.count!==value.items.length)throw Error('原自选批次范围不完整，不能导出缩小后的报告');
    rows=value.items;
  }else if(source.kind==='acceptance'){
    if(!Array.isArray(value.combinations)||value.count!==value.combinations.length)throw Error('原固定范围不完整，不能替换组合');
    const execution=store.get('acceptanceExecution:'+value.id),active=store.get('acceptanceBatch');
    if(execution&&execution.scopeSha256!==value.sha256)throw Error('原固定范围与注册记录不一致');
    metadata={...value,...(active?.id===value.id?active:{status:value.startedAt?'paused':'preview'})};
    if(active?.id===value.id&&(active.scopeSha256!==value.sha256||active.count!==value.count))throw Error('原固定批次范围校验不一致');
    rows=value.combinations.map(combo=>({...combo,...execution?.items?.[combo.identity],profile:combo.profile,url:combo.url,profileId:combo.profileId,identity:combo.identity,taskId:execution?.items?.[combo.identity]?.taskId||combo.existingTaskId}));
  }else{
    const ids=Array.isArray(value.taskIds)?value.taskIds:Array.isArray(value.tasks)?value.tasks.map(item=>typeof item==='string'?item:item.id):null;
    if(!ids?.length)throw Error('原执行记录没有完整任务范围');
    if(new Set(ids).size!==ids.length)throw Error('原执行任务编号重复');
    rows=ids.map(id=>{const original=Array.isArray(value.tasks)?value.tasks.find(item=>item?.id===id):null;return{...original,taskId:id,runId:value.id,profileId:original?.profileId||value.profileId,status:'registered'};});
  }
  const originals=[],taskIds=[],runIds=new Set(source.kind==='run'?[value.id]:[]),entries=[];
  for(let index=0;index<rows.length;index++){
    const row=rows[index],stored=row.taskId&&store.get('task:'+row.taskId);
    if(stored&&!allowed(stored,scope))throw Error('原任务属于其他工作区，不能混入导出');
    if(stored&&(row.runId&&stored.runId!==row.runId||row.profileId&&stored.profileId!==row.profileId))throw Error('原任务编号与固定组合不一致');
    const task=stored;
    if(row.taskId)taskIds.push(row.taskId);if(row.runId||task?.runId)runIds.add(row.runId||task.runId);
    let status='pending',reason=row.reason||'',evidence='',publicationStatus='',publicUrl='',evidenceUrl='';
    const receipt=task?.receipt,confirmed=typeof receipt?.evidence==='string'&&receipt.evidence.trim()&&receipt.confirmedBy!=='migration'&&receipt.source!=='legacy_migration';
    if(['excluded','skip','skipped'].includes(row.status)){status='skip';}
    else if(confirmed){status='ok';evidence=receipt.evidence;publicationStatus=receipt.publicationStatus||'';publicUrl=receipt.publicUrl||'';evidenceUrl=receipt.evidenceUrl||receipt.url||'';reason='';}
    else if(task?.attemptBoundary||task?.status==='submitted_unconfirmed'){status='needs_manual';reason=task.reason||'已发生提交尝试，尚未取得确定回执，禁止重复投稿';}
    else if(['failed','err','registration_rejected'].includes(task?.status||row.status)){status='err';reason=task?.reason||reason;}
    else if(['excluded','skip','skipped'].includes(task?.status)){status='skip';reason=task.reason||reason;}
    else if(task&&['pending','opening','filling','submitting'].includes(task.status)){status=task.status==='pending'?'pending':'running';reason=task.reason||reason;}
    else if(task){status='needs_manual';reason=task.reason||'原任务尚未取得确定回执，请核验';}
    else if(['registered','registration_unknown','registering','complete','running'].includes(row.status)||row.existingTask||row.existingTaskId){status='needs_manual';reason=reason||'原任务暂不在本机或注册结果未确认，保留原编号待核验';}
    else reason=reason||'尚未开始处理';
    const url=row.url||task?.url||'',profileId=row.profileId||task?.profileId||'',profileName=row.profile?.name||task?.profileSnapshot?.name||profileId;
    entries.push({index:index+1,profileId,profileName,status,skipReason:reason,successEvidence:evidence,publicationStatus,publicUrl,evidenceUrl,url,domain:''});
    originals.push({index:index+1,identity:row.identity||row.taskId,taskId:row.taskId||null,runId:row.runId||task?.runId||null,profileId,url,registrationStatus:row.status||'unregistered',reason:row.reason||'',task:task?pick(task,taskKeys):null});
  }
  return{batch:{runId:value.id,status:metadata.status,startedAt:metadata.startedAt||null,finishedAt:metadata.completedAt||metadata.finishedAt,stoppedAt:metadata.stoppedAt,pauseReason:metadata.reason||metadata.pauseReason,config:metadata.config,unattendedState:metadata.unattendedState,tasks:entries},originals,taskIds,runIds:[...runIds],cursor:metadata.cursor??null,scopeSha256:value.scopeSha256||value.sha256||null};
}

function description(runtime,source,scope){
  const original=source.kind.startsWith('original-');
  const report=source.kind!=='original-run';
  const count=original?(source.kind==='original-batch'?source.value.tasks?.length||0:source.value.taskTotal||Object.keys(source.value.tasks||{}).length):nativeBatch(runtime,source,scope).originals.length;
  return{sourceId:source.sourceId,kind:source.kind,runId:original?source.value.runId||source.originalRunId:source.id,count,at:source.at||null,status:label(source.value.status),label:({workbench:'自选批次',acceptance:'固定批次',run:'执行批次','original-batch':'原插件批次报告','original-run':'原插件执行记录'}[source.kind])+' · '+(original?source.value.runId||source.originalRunId:source.id)+' · '+count+' 个组合',report,record:source.kind!=='original-batch'};
}

function translateReport(report){
  const translated=plain(report);translated.status=label(report.status);
  for(const tasks of Object.values(translated.groups))for(const task of tasks){task.status=label(task.status);if(task.publicationStatus)task.publicationStatus=label(task.publicationStatus);}
  return translated;
}

export function runExports(runtime,action,input={}){
  const store=runtime.store;store.db.exec('BEGIN');
  try{
    const scope=pairScope(runtime),sources=enumerate(runtime,scope);
    if(action==='runExportSources'){
      const preferred=sourceId('workbench',store.get('activeWorkbenchBatch'));
      const fixed=sourceId('acceptance',store.get('acceptanceBatch')?.id);
      // Original controls exported the active batch and the first ledger entry.
      const originalBatch=sources.find(source=>source.kind==='original-batch'),originalRun=sources.find(source=>source.kind==='original-run');
      sources.sort((a,b)=>stamp(b.at)-stamp(a.at));
      const defaultReport=originalBatch?.sourceId||sources.find(source=>source.sourceId===preferred)?.sourceId||sources.find(source=>source.sourceId===fixed)?.sourceId||sources.find(source=>source.kind!=='original-run')?.sourceId;
      return{ok:true,sources:sources.map(source=>{try{return description(runtime,source,scope);}catch(error){return{sourceId:source.sourceId,kind:source.kind,runId:source.id,label:'原记录范围待核验 · '+source.id,report:false,record:false,error:error.message};}}),defaultReport:defaultReport||null,defaultRecord:originalRun?.sourceId||defaultReport||sources[0]?.sourceId||null};
    }
    if(!['exportBatchReport','exportAutomationRun'].includes(action))throw Error('未知导出操作');
    if(typeof input.sourceId!=='string'||!input.sourceId)throw Error('请选择原批次或执行记录');
    const source=sources.find(source=>source.sourceId===input.sourceId);if(!source)throw Error('所选原记录不存在或属于其他工作区');
    let report,payload,native;
    if(source.kind==='original-run'){
      if(action==='exportBatchReport')throw Error('执行记录不是原批次报告，请选择完整批次');
      payload=plain(source.value);
    }else if(source.kind==='original-batch'){
      if(action==='exportAutomationRun')throw Error('原批次报告不替代执行记录，请选择原执行记录');
      report=plain(batchReport.build(source.value));
    }else{
      native=nativeBatch(runtime,source,scope);report=plain(batchReport.build(native.batch));
      const logs=store.exportLogs({scope,taskIds:native.taskIds,runIds:native.runIds});
      payload={schemaVersion:automationLedger.SCHEMA_VERSION,runId:source.id,status:native.batch.status,startedAt:native.batch.startedAt,finishedAt:native.batch.finishedAt||native.batch.stoppedAt||null,selectedProfileIds:[...new Set(native.originals.map(item=>item.profileId).filter(Boolean))],taskTotal:native.originals.length,destinationTotal:new Set(native.originals.map(item=>item.url).filter(Boolean)).size,fillOnly:source.value.fillOnly===true,tasks:Object.fromEntries(native.originals.filter(item=>item.taskId).map(item=>[item.taskId,item.task||{id:item.taskId,runId:item.runId,status:item.registrationStatus,reason:item.reason}])),events:logs.entries.map(entry=>pick(entry,eventKeys)),frozenCombinations:native.originals,report,source:{kind:source.kind,scopeSha256:native.scopeSha256,cursor:native.cursor,logHighWater:logs.highWater,availableEvents:logs.entries.length,missingTaskCount:native.originals.filter(item=>!item.task).length,historyNotice:'仅包含实际已持久保存的记录；未补造历史事件。'}};
    }
    const runId=source.kind==='original-run'?source.originalRunId:report.runId;
    if(action==='exportBatchReport'){
      const total=Object.values(report.summary).reduce((sum,count)=>sum+count,0);
      const content=batchReport.markdown(translateReport(report))+'\n\n原固定范围：'+total+' 个组合。取得回执 '+report.summary.success+'，待人工／待核验 '+report.summary.manual+'，失败 '+report.summary.failed+'，跳过 '+report.summary.skipped+'，剩余 '+report.summary.remaining+'。\n'+(native?'处理游标：'+(native.cursor??'未记录')+'；处理进度不等于成功数。\n':'');
      return{ok:true,sourceId:source.sourceId,filename:'externallink-'+safeName(runId)+'-本轮报告.md',mimeType:'text/markdown;charset=utf-8',content,summary:report.summary,count:total,report};
    }
    return{ok:true,sourceId:source.sourceId,filename:'externallink-'+safeName(runId)+'-执行记录.json',mimeType:'application/json;charset=utf-8',content:JSON.stringify(payload,null,2)};
  }finally{store.db.exec('COMMIT');}
}

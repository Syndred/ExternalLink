import '../../../core/url-library.js';
import { D1Store,sha256 } from './d1-store.mjs';
import { d1Api } from './d1-api.mjs';
import {parseBearerToken,secureEqual,artifactObjectKey,mediaObjectKey} from './worker-core.mjs';
import {automationSummary} from './submission-journal.mjs';
import {encodeBase64,decodePngEvidence} from './executor-binary.mjs';
import '../../../core/queue.js';
import '../../../core/target-filters.js';
import '../../../core/library-classifier.js';
import '../../../core/opportunity-score.js';
import '../../../core/submission-timeline.js';
import '../../../core/executor-contract.js';
import { applicationMutation as libraryMutation } from '../../../core/application-mutation.mjs';
import {freezeD1TaskMedia} from './task-media-manifest.mjs';
import {resolveOriginalCloudMediaDefaults,listOriginalD1Media} from '../../../core/original-cloud-media.mjs';
import {backupKeys} from '../../../core/application-backup.mjs';
import {deviceSnapshotResponse} from './device-snapshot.mjs';
import {putDeviceMedia,readDeviceMedia} from './device-media.mjs';
import {libraryTransfer} from './library-transfer.mjs';
import {batchRegisteredTask,validateBatchRunMetadata,batchJson} from '../../../core/workbench-batch-recovery.mjs';
import {applicationMutationDependencies} from '../../../core/application-mutation-dependencies.mjs';
import {freshRoundHost,freshRoundSuccessor,freshRoundRetiredIdentity,validateFreshRoundSource} from '../../../core/original-fresh-round.mjs';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const fail=(message,status=409)=>{throw Object.assign(new Error(message),{status});};
const hash=value=>sha256(new TextEncoder().encode(value));
export async function d1Executor(request,env,workspace,plan,assistant){
 const db=env.LEDGER_DB,store=new D1Store(db,env.MEDIA_BUCKET,workspace),url=new URL(request.url);let path=url.pathname.replace(/^\/v[12]\/executor\//,'');
 try{
  const token=parseBearerToken(request.headers.get('Authorization'))||'',admin=!!env.APP_ACCESS_TOKEN&&await secureEqual(token,env.APP_ACCESS_TOKEN);
  const raw=request.method==='GET'?'{}':await request.text();if(raw.length>9*1024*1024)fail('请求过大',413);
  let input=JSON.parse(raw);
  if(path==='devices'&&request.method==='POST'){
   let enrollment;try{enrollment=JSON.parse(env.EXECUTOR_ENROLLMENT||'null');}catch{}
   const enrolled=!admin&&token.startsWith('ele_')&&enrollment?.workspaceId===workspace&&Number(enrollment.expiresAt)>Date.now()&&await secureEqual(await hash(token),enrollment.hash||'');
   if(!admin&&!enrolled)fail('需要管理凭据或有效的一次性登记凭据',401);
   const id=crypto.randomUUID(),deviceToken='eld_'+[...crypto.getRandomValues(new Uint8Array(32))].map(v=>v.toString(16).padStart(2,'0')).join('');
   const writes=[];if(enrolled)writes.push(db.prepare('INSERT INTO executor_enrollments VALUES(?)').bind(enrollment.hash));
   writes.push(db.prepare('INSERT INTO executor_devices VALUES(?,?,?,?,0)').bind(workspace,id,await hash(deviceToken),String(input.name||'Windows').slice(0,100)));await db.batch(writes);
   return json({ok:true,deviceId:id,deviceToken,workspaceId:workspace,storageBackend:'d1'});
  }
  if(path==='revoke'&&request.method==='POST'){if(!admin)fail('未授权',401);await db.prepare('UPDATE executor_devices SET revoked=1 WHERE workspace=? AND id=?').bind(workspace,input.deviceId).run();return json({ok:true});}
  const device=token.startsWith('eld_')?await db.prepare('SELECT id FROM executor_devices WHERE workspace=? AND token_hash=? AND revoked=0').bind(workspace,await hash(token)).first():null;
  if(!device)fail('设备未授权或已撤销',401);const deviceId=device.id;
  if(path.startsWith('library-transfer/')){
   const action=path.slice('library-transfer/'.length);if((action==='status'&&request.method!=='GET')||(action!=='status'&&request.method!=='POST'))fail('备份传输方法无效',405);
   const transferred=await libraryTransfer(env.MEDIA_BUCKET,workspace,deviceId,action,action==='status'?{id:url.searchParams.get('id')}:input);
   if(action!=='commit')return json(transferred);
   path=transferred.route;input=transferred.payload;
  }
  if(/^ai\/(extract-site|generate-site|comment|domain-metrics|plan|vision-plan|judge|validate-fill)$/.test(path)&&request.method==='POST'){
   if(!assistant)fail('AI 服务暂不可用',503);
   return json(await assistant(path.slice(3),input));
  }
  if(path.startsWith('workspace/')){
   const target=path.slice('workspace/'.length);
   const readable=/^(journal-documents|submission-tasks|media|media\/[a-zA-Z0-9._-]+|automation\/artifacts\/[a-zA-Z0-9._-]+)$/.test(target);
   if(!(request.method==='GET'&&readable)&&!(request.method==='POST'&&target==='timeline'))fail('工作台接口未授权',403);
   const next=new URL(url);next.pathname='/v2/'+target;
   const forwarded=new Request(next,{method:request.method,headers:request.headers,...(request.method==='GET'?{}:{body:raw})});
   return d1Api(forwarded,env,async()=>true);
  }
  if(path==='revisions'&&request.method==='GET')return json({ok:true,deviceId,workspaceId:workspace,revisions:await store.revisions()});
  if(path==='runs'&&url.pathname.startsWith('/v1/')&&request.headers.get('X-Executor-Protocol')!=='2')return json({ok:false,error:'执行器需要更新以支持分页恢复；本机任务保持不变',code:'EXECUTOR_UPGRADE_REQUIRED'},426);
  const readTask=async id=>{
   const row=await db.prepare('SELECT c.*,j.object_key,j.checksum,j.item_index,j.summary FROM executor_controls c JOIN journal_tasks j ON j.workspace=c.workspace AND j.id=c.id WHERE c.workspace=? AND c.id=? AND c.device_id=?').bind(workspace,id,deviceId).first();
   if(!row)fail('任务不属于当前设备',403);
   const successor=freshRoundSuccessor(row.identity);
   if(successor&&request.method==='POST'&&!['review','artifact-read'].includes(path))fail('旧任务已进入历史，新一轮任务为 '+successor);
   const object=await store.readObject(row.object_key,row.checksum),data=row.item_index===null?object:object[row.item_index];
   return{...row,storedVersion:data.version,data:{...data,version:row.version,controllerId:row.controller_id,reviewStatus:row.review_status,...(successor?{originalFreshRoundSuccessorTaskId:successor}:{})}};
  };
  const snapshot=async()=>{const documents={},revisions=await store.revisions();for(const key of Object.keys(revisions)){const row=await store.document(key);documents[key]=row.data;revisions[key]=row.revision;}return{ok:true,deviceId,workspaceId:workspace,documents,revisions};};
  const updateDocument=async(key,change)=>{for(let i=0;i<3;i++){const old=await store.document(key);const data=change(old?.data||{});try{return{data,...await store.putDocument(key,data,old?.revision||0)};}catch(e){if(e.status!==409||i===2)throw e;}}};
  if(path==='diagnostics'&&request.method==='POST'){
   const before=await store.revisions(),payload={id:crypto.randomUUID(),workspaceId:workspace,deviceId,type:'device_diagnostic',at:new Date().toISOString()};
   const object=await store.object(payload);await db.prepare('INSERT INTO executor_events VALUES(?,?,?,?,?,?,?,NULL,?)').bind(workspace,payload.id,deviceId,'diagnostic',object.checksum,object.key,object.checksum,payload.at).run();
   const read=await store.readObject(object.key,object.checksum),after=await store.revisions();return json({ok:true,diagnostic:read,r2Readback:JSON.stringify(read)===JSON.stringify(payload),businessDocumentsUnchanged:JSON.stringify(before)===JSON.stringify(after),before,after});
  }
  if(path==='snapshot'&&request.method==='GET')return await deviceSnapshotResponse(store,deviceId);
  if(path.startsWith('media-assets/')&&request.method==='GET')return json({ok:true,asset:await readDeviceMedia(env.MEDIA_BUCKET,workspace,path.slice(13))});
  if(path==='media-upload'&&request.method==='POST')return json({ok:true,asset:await putDeviceMedia(env.MEDIA_BUCKET,workspace,input,(await store.document('siteProfiles'))?.data)});
  if(path==='library'&&request.method==='POST'){
   const type=input.operation?.type,dependencies=applicationMutationDependencies(input.operation);
   if(dependencies.some(key=>!backupKeys.includes(key)))fail('外链库字段未授权',403);const documents={},revisions={};for(const key of dependencies){const row=await store.document(key);documents[key]=row?.data;revisions[key]=row?.revision||0;}
   const change=libraryMutation(documents,input.operation,{inPlace:true});
   if(revisions[change.key]!==input.revision)fail('外链库已由其他客户端更新，请先回读');
   if(type==='automatic_mark'&&(!input.revisions||change.revisionKeys.some(key=>!Number.isSafeInteger(input.revisions[key])||input.revisions[key]<0)||input.revisions[change.key]!==input.revision))fail('缺少有效自动观察关联版本号',400);
   if(change.updates){const expected=Object.fromEntries(change.revisionKeys.map(key=>[key,input.revisions?input.revisions[key]:revisions[key]]));const saved=await store.putDocuments(change.updates,expected);return json({ok:true,key:change.key,event:change.event,record:change.record,revision:saved.revisions[change.key],...saved});}
   if(type==='recover_local'){await store.archive('local-source-'+input.operation.id,'source_backup',{key:change.key,data:input.operation.data});await store.archive('local-before-'+input.operation.id+'-'+input.revision,'source_backup',{key:change.key,revision:input.revision,data:documents[change.key]??null});}
   if(type==='backup_prepared_key'){await store.archive('backup-source-'+input.operation.id,'source_backup',{key:change.key,patch:input.operation.patch,profileIdMap:input.operation.profileIdMap||{}});await store.archive('backup-before-'+input.operation.id+'-'+input.revision,'source_backup',{key:change.key,revision:input.revision,data:documents[change.key]??null});}
   if(dependencies.length>1){const saved=await store.putDocuments({[change.key]:change.data},revisions);return json({ok:true,key:change.key,revision:saved.revisions[change.key],...saved});}
   return json({ok:true,key:change.key,...await store.putDocument(change.key,change.data,input.revision)});
  }
  if(path==='profile'&&request.method==='POST'){
   const current=await store.document('siteProfiles');if(current?.revision!==input.revision||!current.data[input.profileId]||input.profile?.id!==input.profileId)fail('资料身份或版本不匹配');
   const change=libraryMutation({siteProfiles:current.data},{type:'profile',profileId:input.profileId,profile:input.profile,at:new Date().toISOString()}),profile=change.data[input.profileId];
   return json({ok:true,profile,...await store.putDocument('siteProfiles',{...current.data,[input.profileId]:profile},input.revision)});
  }
  if(path==='runs'&&request.method==='GET'){
   const runId=url.searchParams.get('runId'),inventory=url.searchParams.get('view')==='inventory',after=url.searchParams.get('after')||'',limit=inventory?200:10;
   const runRows=after?{results:[]}:await db.prepare('SELECT * FROM executor_runs WHERE workspace=? AND device_id=? AND (? IS NULL OR id=?) ORDER BY id').bind(workspace,deviceId,runId,runId).all();
   const taskRows=await db.prepare('SELECT c.version,c.controller_id,c.review_status,c.identity AS control_identity,c.run_id AS control_run_id,j.* FROM executor_controls c JOIN journal_tasks j ON j.workspace=c.workspace AND j.id=c.id WHERE c.workspace=? AND c.device_id=? AND (? IS NULL OR c.run_id=?) AND c.id>? ORDER BY c.id LIMIT ?').bind(workspace,deviceId,runId,runId,after,limit+1).all();
   const runs=[],tasks=[];for(const r of runRows.results)runs.push(inventory?JSON.parse(r.summary):await store.readObject(r.object_key,r.checksum));
   const objects=new Map();for(const t of taskRows.results.slice(0,limit)){let value;if(inventory)value=JSON.parse(t.summary);else{if(!objects.has(t.object_key))objects.set(t.object_key,await store.readObject(t.object_key,t.checksum));const object=objects.get(t.object_key);value=t.item_index===null?object:object[t.item_index];}const successor=freshRoundSuccessor(t.control_identity);tasks.push({...value,runId:t.control_run_id,version:t.version,controllerId:t.controller_id,reviewStatus:t.review_status,...(successor?{originalFreshRoundSuccessorTaskId:successor}:{})});}
   return json({ok:true,runs,tasks,next:taskRows.results.length>limit?taskRows.results[limit-1].id:null,storageBackend:'d1'});
  }
  if(path.startsWith('tasks/')&&request.method==='GET')return json({ok:true,task:(await readTask(path.slice(6))).data});
  if(path==='runs'&&request.method==='POST'){
   const run=input.run;if(!run?.id||!Array.isArray(run.tasks)||!run.tasks.length||run.tasks.length>100)fail('D1 每批支持 1–100 个任务，请分批安排',400);
   await validateBatchRunMetadata(run,workspace,hash);
   const old=await db.prepare('SELECT checksum FROM executor_runs WHERE workspace=? AND id=?').bind(workspace,run.id).first();if(old)fail('批次已存在，请回读');
   const snap=await snapshot();if(run.profileRevision!==snap.revisions.siteProfiles||!snap.documents.siteProfiles?.[run.profileId])fail('资料已更新，请重新预览');
   const preparation=run.mode==='single_page_preparation';
   if(preparation)globalThis.ExtLinkExecutorContract.validateSinglePagePreparation(snap,run);else{const scope=globalThis.ExtLinkExecutorContract.selectScope(snap,null,run.profileId,run.tasks.map(t=>t.url));if(scope.exclusions.length||scope.tasks.length!==run.tasks.length)fail('当前范围含已提交、重复或排除目标');}
   const tasks=run.tasks.map(t=>{const destinationKey=globalThis.ExtLinkQueue.normalizeDestinationKey(t.url);if(!t.id||destinationKey!==t.destinationKey||!/^https?:\/\//.test(t.url))fail('目标身份无效',400);return{id:t.id,runId:run.id,url:t.url,destinationKey,profileId:run.profileId,identity:globalThis.ExtLinkQueue.submissionRecordKey(destinationKey,run.profileId),...batchRegisteredTask(run),...(t.originalFreshRound?{originalFreshRound:t.originalFreshRound}:{}),status:preparation?'needs_manual':'pending',...(preparation?{attentionType:'fill_only',reason:'单页填写，尚未授权投稿'}:{}),siteStatus:'not_submitted',reviewStatus:'pending_review',version:1};});
   const retirements=[];
   for(const task of tasks.filter(t=>t.originalFreshRound)){
    const source=await readTask(task.originalFreshRound.sourceTaskId);
    await validateFreshRoundSource(source.data,task.originalFreshRound,task,hash);
    const summary=JSON.parse(source.summary);if(summary.receipt||summary.attemptBoundary||['accepted','sent_unconfirmed','submitted_unconfirmed'].includes(summary.siteStatus))fail('原同站索引仍有收件或未知投稿，须先核验');
    if(source.controller_id&&source.controller_id!==run.freshRoundControllerId&&source.lease_until>Date.now())fail('原任务仍由其他控制者持有');
    if(source.host_identity!==task.profileId+'::'+freshRoundHost(task.url))fail('原任务同站索引不匹配');
    retirements.push({source,task});
   }
   const profile=snap.documents.siteProfiles[run.profileId],mediaLookup=await resolveOriginalCloudMediaDefaults(profile,()=>listOriginalD1Media(env.MEDIA_BUCKET,workspace)),mediaManifest=await freezeD1TaskMedia(env.MEDIA_BUCKET,workspace,profile,run.profileId,mediaLookup.originalMediaDefaults);
   const savedRun={...run,profile,...mediaLookup,mediaManifest,tasks:tasks.map(t=>t.id),deviceId,workspaceId:workspace};
   const runObject=await store.object(savedRun),taskObject=await store.object(tasks),writes=[db.prepare('INSERT INTO executor_runs VALUES(?,?,?,?,?,?)').bind(workspace,run.id,deviceId,JSON.stringify({id:run.id,profileId:run.profileId,profileRevision:run.profileRevision,createdAt:run.createdAt,workbenchBatchId:run.workbenchBatchId,workbenchBatchManifestId:run.workbenchBatchManifest?.id}),runObject.key,runObject.checksum)];
   // Move only the proved, unsubmitted terminal control out of the live unique
   // index. Body, journal row, run and events remain intact and readable. CAS
   // includes the body object, since event writes need not increment version.
   for(const {source,task}of retirements){const retired=freshRoundRetiredIdentity(task.id,source.id);
    writes.push(db.prepare('UPDATE executor_controls SET identity=?,host_identity=?,version=version+1 WHERE workspace=? AND id=? AND device_id=? AND version=? AND identity=? AND host_identity=? AND controller_id IS ? AND lease_until=? AND review_status=? AND EXISTS(SELECT 1 FROM journal_tasks WHERE workspace=? AND id=? AND object_key=? AND checksum=? AND item_index IS ? AND summary=?)').bind(retired,retired,workspace,source.id,deviceId,source.version,source.identity,source.host_identity,source.controller_id,source.lease_until,source.review_status,workspace,source.id,source.object_key,source.checksum,source.item_index,source.summary));
    writes.push(db.prepare("SELECT CASE WHEN changes()=1 THEN 1 ELSE json('fresh_round_conflict') END"));
   }
   // Multi-row inserts keep each statement under D1's 100 bind-parameter limit.
   for(let start=0;start<tasks.length;start+=10){const group=tasks.slice(start,start+10);
    writes.push(db.prepare('INSERT INTO journal_tasks(workspace,id,profile_id,destination,summary,object_key,checksum,updated_at,item_index) VALUES '+group.map(()=>'(?,?,?,?,?,?,?,?,?)').join(','))
     .bind(...group.flatMap((t,i)=>[workspace,t.id,t.profileId,t.destinationKey,JSON.stringify(t),taskObject.key,taskObject.checksum,new Date().toISOString(),start+i])));
    writes.push(db.prepare('INSERT INTO executor_controls(workspace,id,run_id,device_id,identity,host_identity,version) VALUES '+group.map(()=>'(?,?,?,?,?,?,1)').join(','))
     .bind(...group.flatMap(t=>[workspace,t.id,t.runId,deviceId,t.identity,t.profileId+'::'+new URL(t.url).hostname.toLowerCase().replace(/^www\./,'')])));
   }
   try{await db.batch(writes);}catch(error){if(retirements.length&&/malformed JSON/i.test(error.message))fail('原任务在注册时变化，新一轮未创建');throw error;}return json({ok:true,run:savedRun,tasks});
  }
  if(path==='recover-run'&&request.method==='POST'){
   const archive=await db.prepare("SELECT * FROM recovery_objects WHERE workspace=? AND id=? AND kind='run'").bind(workspace,'run-'+input.runId).first();if(!archive)fail('原批次档案不存在',404);
   const original=await store.readObject(archive.object_key,archive.checksum);
   const controls=await db.prepare('SELECT id FROM executor_controls WHERE workspace=? AND run_id=? AND device_id=? ORDER BY id').bind(workspace,input.runId,deviceId).all();if(!controls.results.length)fail('批次不属于本设备',403);
   const run={...original,tasks:controls.results.map(t=>t.id),deviceId,workspaceId:workspace};
   const object=await store.object(run),summary={id:input.runId,profileId:run.profileId,profileRevision:run.profileRevision,createdAt:run.createdAt,libraryPlanId:run.libraryPlanId};
   await db.prepare('INSERT OR IGNORE INTO executor_runs VALUES(?,?,?,?,?,?)').bind(workspace,input.runId,deviceId,JSON.stringify(summary),object.key,object.checksum).run();
   return json({ok:true,runId:input.runId,checksum:object.checksum});
  }
  if(path==='lease'&&request.method==='POST'){
   if(!input.controllerId)fail('缺少控制会话',400);const now=Date.now();
   const result=await db.prepare(`UPDATE executor_controls SET version=CASE WHEN controller_id IS NOT NULL AND controller_id<>? THEN version+1 ELSE version END,controller_id=?,lease_until=? WHERE workspace=? AND id=? AND device_id=? AND version=? AND identity NOT LIKE 'retired:%' AND (controller_id IS NULL OR controller_id=? OR lease_until<?) RETURNING version,lease_until`)
    .bind(input.controllerId,input.controllerId,now+90000,workspace,input.taskId,deviceId,input.version,input.controllerId,now).first();
   if(!result)fail('控制权版本冲突或原租约仍有效');return json({ok:true,...result});
  }
  if(path==='handoff'&&request.method==='POST'){
   if(!input.controllerId||!input.previousControllerId)fail('缺少控制会话',400);
   const result=await db.prepare("UPDATE executor_controls SET version=version+1,controller_id=?,lease_until=? WHERE workspace=? AND id=? AND device_id=? AND version=? AND identity NOT LIKE 'retired:%' AND controller_id=? RETURNING version")
    .bind(input.controllerId,Date.now()+90000,workspace,input.taskId,deviceId,input.version,input.previousControllerId).first();
   if(!result)fail('接管控制权冲突');return json({ok:true,...result});
  }
  if(path==='event'&&request.method==='POST'){
   const checksum=await hash(JSON.stringify(input));
   const existing=await db.prepare('SELECT checksum FROM executor_events WHERE workspace=? AND id=? AND device_id=?').bind(workspace,input.id||'',deviceId).first();
   if(existing){if(existing.checksum!==checksum)fail('事件编号已有不同内容');return json({ok:true,eventId:input.id,checksum,duplicate:true});}
   const task=await readTask(input.taskId),state=input.state;
   if(!input.id||!state||state.id!==task.id||state.runId!==task.run_id||state.profileId!==task.data.profileId||state.destinationKey!==task.data.destinationKey)fail('事件范围不匹配',403);
   if(batchJson(state.originalFreshRound)!==batchJson(task.data.originalFreshRound))fail('原新一轮来源不允许修改',403);
   if(task.version===Number(input.version)+1&&input.type==='takeover'&&state.controller==='supervisor'&&state.version===input.version&&Number(task.storedVersion||1)<task.version){
    const object=await store.object(input);
    const result=await db.prepare('INSERT INTO executor_events SELECT ?,?,?,?,?,?,?,NULL,? FROM executor_controls WHERE workspace=? AND id=? AND device_id=? AND version=? ON CONFLICT DO NOTHING')
     .bind(workspace,input.id,deviceId,input.taskId,checksum,object.key,object.checksum,input.at||new Date().toISOString(),workspace,input.taskId,deviceId,task.version).run();
    if(!result.meta.changes)fail('接管记录写入时版本已变化');return json({ok:true,eventId:input.id,checksum,historical:true});
   }
   if(task.version!==input.version||task.controller_id&&state.controllerId!==task.controller_id)fail('事件来自过期控制会话');
   const eventObject=await store.object(input),taskObject=await store.object({...state,reviewStatus:task.review_status});
   const summary=JSON.stringify({...automationSummary(state),receipt:state.receipt?{publicationStatus:state.receipt.publicationStatus,publicUrl:state.receipt.publicUrl}:undefined,reviewStatus:task.review_status});
   // D1 batch is atomic. The task advances only if this exact immutable event was
   // inserted under the current version/controller; stale owners cannot overwrite it.
   const results=await db.batch([
    db.prepare(`INSERT INTO executor_events SELECT ?,?,?,?,?,?,?,NULL,? FROM executor_controls WHERE workspace=? AND id=? AND device_id=? AND version=? AND (controller_id IS NULL OR controller_id=?) ON CONFLICT DO NOTHING`)
     .bind(workspace,input.id,deviceId,input.taskId,checksum,eventObject.key,eventObject.checksum,input.at||new Date().toISOString(),workspace,input.taskId,deviceId,input.version,state.controllerId||''),
    db.prepare(`UPDATE journal_tasks SET object_key=?,checksum=?,summary=?,updated_at=?,item_index=NULL WHERE workspace=? AND id=? AND changes()=1 AND EXISTS(SELECT 1 FROM executor_controls WHERE workspace=? AND id=? AND device_id=? AND version=? AND (controller_id IS NULL OR controller_id=?))`)
     .bind(taskObject.key,taskObject.checksum,summary,new Date().toISOString(),workspace,input.taskId,workspace,input.taskId,deviceId,input.version,state.controllerId||''),
   ]);
   if(results[0].meta.changes!==1||results[1].meta.changes!==1)fail('写入时控制权已变化，请回读');
   return json({ok:true,eventId:input.id,checksum});
  }
  const eventMatch=path.match(/^events\/([a-zA-Z0-9_-]+)$/);
  if(path==='events/proofs'&&request.method==='GET'){
   const rows=await db.prepare('SELECT id,checksum,object_checksum,item_index FROM executor_events WHERE workspace=? AND device_id=? AND id>? ORDER BY id LIMIT 201').bind(workspace,deviceId,url.searchParams.get('after')||'').all();
   return json({ok:true,events:rows.results.slice(0,200),next:rows.results.length>200?rows.results[199].id:null});
  }
  if(path==='recovery-archives'&&request.method==='GET'){
   const id=url.searchParams.get('id');
   if(id){const row=await db.prepare("SELECT * FROM recovery_objects WHERE workspace=? AND id=? AND kind='outbox'").bind(workspace,id).first();if(!row)fail('原事件档案不存在',404);
    if(url.searchParams.get('head')==='1'){const object=await env.MEDIA_BUCKET.head(row.object_key);if(!object||object.customMetadata?.sha256!==row.checksum)fail('原事件档案不存在或摘要元数据不一致',503);return json({ok:true,id,checksum:row.checksum,present:true});}
    const events=await store.readObject(row.object_key,row.checksum);return json({ok:true,id,checksum:row.checksum,eventCount:events.length});}
   const rows=await db.prepare("SELECT id,checksum FROM recovery_objects WHERE workspace=? AND kind='outbox' ORDER BY id").bind(workspace).all();return json({ok:true,archives:rows.results});
  }
  if(eventMatch&&request.method==='GET'){
   const row=await db.prepare('SELECT * FROM executor_events WHERE workspace=? AND id=? AND device_id=?').bind(workspace,eventMatch[1],deviceId).first();if(!row)return json({ok:false,error:'事件不存在'},404);
   if(url.searchParams.get('proof')==='1')return json({ok:true,eventId:row.id,checksum:row.checksum});
   const payload=await store.readObject(row.object_key,row.object_checksum),event=row.item_index===null?payload:payload[row.item_index];
   if(await hash(JSON.stringify(event))!==row.checksum)fail('事件存档校验失败',503);return json({ok:true,event});
  }
  if(path==='receipt'&&request.method==='POST'){
   const task=await readTask(input.taskId),record=input.record;
   if(task.version!==input.version||!record||record.profileId!==task.data.profileId||record.destinationKey!==task.data.destinationKey||record.taskId!==task.id||!record.evidence||!record.actualSubmission)fail('回执范围或证据不完整',403);
   const saved=await updateDocument('submissionRecords',records=>{const old=records[task.identity];if(old&&(old.taskId!==task.id||old.evidence!==record.evidence||JSON.stringify(old.actualSubmission)!==JSON.stringify(record.actualSubmission)))fail('已有回执受保护');return{...records,[task.identity]:old||record};});
   const event=globalThis.ExtLinkSubmissionTimeline.normalizeEvent({id:'executor-'+task.id,destinationKey:task.data.destinationKey,destinationUrl:task.data.url,profileId:task.data.profileId,type:record.publicationStatus||'submitted',status:record.publicationStatus||'submitted',occurredAt:record.submittedAt,note:record.evidence,evidenceUrl:record.evidenceUrl,source:record.confirmedBy==='manual'?'manual':'agent',recordKey:task.identity});
   await updateDocument('submissionTimeline',timeline=>globalThis.ExtLinkSubmissionTimeline.append(timeline,event));
   return json({ok:true,record:saved.data[task.identity],revision:saved.revision});
  }
  if(path==='review'&&request.method==='POST'){
   const task=await readTask(input.taskId);if(!['reviewed','disputed','pending_review'].includes(input.reviewStatus))fail('无效审阅状态',400);
   await db.prepare('UPDATE executor_controls SET review_status=? WHERE workspace=? AND id=? AND device_id=?').bind(input.reviewStatus,workspace,task.id,deviceId).run();
   await updateDocument('submissionRecords',records=>records[task.identity]?.taskId===task.id?{...records,[task.identity]:{...records[task.identity],reviewStatus:input.reviewStatus}}:records);
   return json({ok:true,task:{...task.data,reviewStatus:input.reviewStatus}});
  }
  if(path==='receipt-status'&&request.method==='POST'){
   const task=await readTask(input.taskId);if(input.status!=='pending_moderation'||!input.expectedEvidence)fail('只允许依原始证据补记待审核',400);
   const saved=await updateDocument('submissionRecords',records=>{const record=records[task.identity];if(record?.taskId!==task.id||record.evidence!==input.expectedEvidence||!['submitted','pending_moderation'].includes(record.publicationStatus))fail('原回执不匹配');return{...records,[task.identity]:{...record,publicationStatus:'pending_moderation'}};});
   const event={id:'executor-'+task.id+'-pending',profileId:task.data.profileId,destinationKey:task.data.destinationKey,destinationUrl:task.data.url,type:'pending_moderation',status:'pending_moderation',note:input.expectedEvidence,occurredAt:new Date().toISOString(),source:'agent'};
   await updateDocument('submissionTimeline',timeline=>globalThis.ExtLinkSubmissionTimeline.append(timeline,event));
   return json({ok:true,record:saved.data[task.identity],revision:saved.revision});
  }
  if(path==='media'&&request.method==='POST'){
   const task=await readTask(input.taskId),assetId=String(input.ref||'').replace(/^cloud-media:\/\//,'');
   const runRow=await db.prepare('SELECT * FROM executor_runs WHERE workspace=? AND id=? AND device_id=?').bind(workspace,task.run_id,deviceId).first();
   const run=runRow?await store.readObject(runRow.object_key,runRow.checksum):null,frozen=run?.mediaManifest?.find(a=>a.asset_id===assetId);
   if(!frozen)fail('素材不在该任务产品的冻结清单',403);
   const object=await env.MEDIA_BUCKET.get(mediaObjectKey(workspace,assetId));if(!object)fail('素材不存在',404);
   const bytes=new Uint8Array(await object.arrayBuffer());if(!frozen.sha256||await sha256(bytes)!==frozen.sha256)fail('素材版本不匹配');
   return json({ok:true,name:frozen.file_name||assetId,dataUrl:`data:${object.httpMetadata?.contentType||'image/png'};base64,${encodeBase64(bytes)}`});
  }
  if(path==='artifact'&&request.method==='POST'){
   const task=await readTask(input.taskId),bytes=decodePngEvidence(input.dataUrl),checksum=await sha256(bytes),id=`executor-${task.id}-${checksum.slice(0,16)}`,key=artifactObjectKey(workspace,id);
   await env.MEDIA_BUCKET.put(key,bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{taskId:task.id,sha256:checksum}});
   if(await sha256(await(await env.MEDIA_BUCKET.get(key)).arrayBuffer())!==checksum)fail('截图回读不一致');return json({ok:true,ref:'cloud-artifact://'+id,sha256:checksum});
  }
  if(path==='artifact-read'&&request.method==='POST'){
   const task=await readTask(input.taskId),id=String(input.ref||'').replace(/^cloud-artifact:\/\//,'');if(!id.startsWith(`executor-${task.id}-`))fail('截图不属于任务',403);
   const object=await env.MEDIA_BUCKET.get(artifactObjectKey(workspace,id));if(!object)fail('截图不存在',404);return json({ok:true,dataUrl:'data:image/png;base64,'+encodeBase64(new Uint8Array(await object.arrayBuffer()))});
  }
  if(path==='plan'&&request.method==='POST'){
   const task=await readTask(input.taskId);
   if(input.mode==='prepare_takeover'&&(task.data.attemptBoundary||task.data.receipt||task.version!==input.version||task.controller_id!==input.controllerId||task.lease_until<Date.now()))fail('接管任务已有提交边界或控制权变化，必须先核验',409);
   return json({ok:true,...await plan(input)});
  }
  return json({ok:false,error:'执行器接口不存在'},404);
 }catch(error){return json({ok:false,error:error.message,...(String(error.code||'').startsWith('AI_PROVIDER_')?{code:error.code,message:error.message,retryable:error.retryable}:{})},error.status||(/UNIQUE constraint/.test(error.message)?409:500));}
}

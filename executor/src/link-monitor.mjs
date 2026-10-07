import {randomUUID,createHash} from 'node:crypto';
import {checkablePublicUrl,inspectPublishedLink} from '../../core/link-monitor.mjs';
import {applicationData} from './application-data.mjs';
import {enqueueApplicationPlan,flushApplicationMutations,pendingApplication} from './application-mutations.mjs';
import {workbenchScope,journalSync} from './workbench-sync.mjs';
import '../../core/submission-timeline.js';
import {notifyDesktop} from './desktop-notification.mjs';
import {monitorSchedule} from '../../core/application-preferences.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
export async function startLinkMonitor(runtime,input={}){
 if(runtime.linkMonitorJob||runtime.linkMonitorStarting)throw Error('外链监测正在进行');runtime.linkMonitorStarting=true;try{const scope=workbenchScope(runtime.store.get('pair'));let job=input.jobId&&runtime.store.get('linkMonitorJob:'+input.jobId);if(input.jobId&&(!job||job.scope!==scope))throw Error('原监测任务不存在');
 if(!job){await applicationData(runtime,{refresh:true});const docs=runtime.store.get('applicationSnapshot').snapshot.documents,candidates=Object.entries(docs.submissionRecords||{}).filter(([,record])=>record?.status==='success'&&checkablePublicUrl(record)).map(([key,record])=>({key,record,profile:docs.siteProfiles?.[record.profileId],previous:docs.linkMonitorResults?.[key]}));job={id:randomUUID(),scope,candidates,cursor:0,status:'queued',source:input.scheduled?'schedule':'manual',at:new Date().toISOString(),counts:{live:0,missing:0,unreachable:0,uncheckable:0,excluded:0}};runtime.store.set('linkMonitorJob:'+job.id,job);}
 if(job.status==='completed')return{ok:true,job:summary(job)};runtime.linkMonitorJobId=job.id;runtime.linkMonitorJob=run(runtime,job).finally(()=>{runtime.linkMonitorJob=null;runtime.linkMonitorJobId=null;});return{ok:true,job:summary(job)};}finally{runtime.linkMonitorStarting=false;}
}
export const summary=job=>({id:job.id,scope:job.scope,count:job.candidates.length,cursor:job.cursor,status:job.status,source:job.source,at:job.at,completedAt:job.completedAt,counts:job.counts,error:job.error});
async function run(runtime,job){try{
 job.status='running';job.error='';runtime.store.set('linkMonitorJob:'+job.id,job);await flushApplicationMutations(runtime);await applicationData(runtime,{refresh:true});if(pendingApplication(runtime).length)throw Error('已有编辑尚待同步或解决冲突');
 while(job.cursor<job.candidates.length){const item=job.candidates[job.cursor],snapshot=await runtime.cloud.request('snapshot'),record=snapshot.documents.submissionRecords?.[item.key];if(!record||record.status!=='success'||checkablePublicUrl(record)!==checkablePublicUrl(item.record)){item.outcome='excluded';item.reason='原记录或公开链接已变化';job.counts.excluded++;job.cursor++;runtime.store.set('linkMonitorJob:'+job.id,job);continue;}
  if(!job.pendingResult){job.pendingResult=await inspectPublishedLink(record,item.profile,runtime.fetchPublic||globalThis.fetch);runtime.store.set('linkMonitorJob:'+job.id,job);}
  const result=job.pendingResult,operations=[{type:'monitor_result',recordKey:item.key,result,jobId:job.id},...(result.status==='live'&&record.publicationStatus!=='published'?[{type:'monitor_publication',recordKey:item.key,jobId:job.id}]:[])];
  const change=await enqueueApplicationPlan(runtime,item.planId?{planId:item.planId}:{operations},id=>{item.planId=id;runtime.store.set('linkMonitorJob:'+job.id,job);});if(change.remaining)throw Error(change.error||'监测证据已存本机，等待同步');
  const problem=item.previous?.status==='live'&&['missing','unreachable'].includes(result.status),published=result.status==='live'&&item.record.publicationStatus!=='published';
  if(problem||published){const event=globalThis.ExtLinkSubmissionTimeline.normalizeEvent({id:'monitor-'+job.id+'-'+hash(item.key),profileId:item.record.profileId,profileName:item.record.profileName,destinationUrl:item.record.destinationUrl||item.record.url,destinationKey:item.record.destinationKey||item.key.split('::')[0],occurredAt:result.checkedAt,type:problem?'link_missing':'published',note:problem?(result.status==='unreachable'?'发布链接当前无法访问，请人工复查':'发布页面未发现目标外链，请人工复查'):'发布链接监测确认外链已上线',publicUrl:published?result.url:'',evidenceUrl:result.url,source:'agent',confirmedBy:'link_check'});const saved=await journalSync(runtime).enqueue(event);if(saved.pending)throw Error(saved.error||'监测动态待同步');}
  if(problem){const id=job.id+'-'+hash(item.key);runtime.store.set('monitorNotification:'+id,{id,scope:job.scope,at:result.checkedAt,title:'外链状态发生变化',profileId:item.record.profileId,destinationUrl:item.record.destinationUrl,status:result.status,url:result.url,dismissed:false});}
  item.outcome=result.status;job.counts[result.status]++;job.cursor++;delete job.pendingResult;runtime.store.set('linkMonitorJob:'+job.id,job);
 }
 job.status='completed';job.completedAt=new Date().toISOString();runtime.store.set('linkMonitorJob:'+job.id,job);
 const alerts=runtime.store.values('monitorNotification:').filter(a=>a.scope===job.scope&&a.id.startsWith(job.id+'-')&&!a.desktopDelivery),schedule=runtime.store.get('applicationSnapshot')?.snapshot?.documents?.linkMonitorSchedule;
 if(job.source==='schedule'&&alerts.length&&schedule?.desktopNotifications!==false){const delivery=await(runtime.notifyDesktop||notifyDesktop)('ExternalLink 外链状态变化',alerts.length+' 个已监测链接无法访问或未发现目标外链，请打开工作台复查。');for(const alert of alerts)runtime.store.set('monitorNotification:'+alert.id,{...alert,desktopDelivery:delivery});}
 }catch(error){job.status='paused';job.error=error.message;}runtime.store.set('linkMonitorJob:'+job.id,job);
}
export function dismissMonitorAlert(runtime,input){const key='monitorNotification:'+input.id,alert=runtime.store.get(key);if(!alert||alert.scope!==workbenchScope(runtime.store.get('pair')))throw Error('监测提醒不存在');runtime.store.set(key,{...alert,dismissed:true});return{ok:true};}
export function recoverDataJobs(runtime){for(const prefix of ['domainAgeJob:','publicLibraryJob:','linkMonitorJob:','quickOpenJob:'])for(const job of runtime.store.values(prefix))if(job.status==='running')runtime.store.set(prefix+job.id,{...job,status:'paused',error:prefix==='quickOpenJob:'?'后台已重启，保留原打开记录；请核对已打开页签后重新选择未打开项':'后台已重启，请继续原任务'});}
export async function checkMonitorSchedule(runtime,now=Date.now()){
 if(runtime.connectionBusy||runtime.cloudPullOperation||runtime.store.get('connectionExecutionHold'))return;
 if(runtime.linkMonitorJob||runtime.linkMonitorStarting)return;const scope=workbenchScope(runtime.store.get('pair')),snapshot=runtime.store.get('applicationSnapshot');if(snapshot?.scope!==scope)return;const schedule=monitorSchedule(snapshot.snapshot.documents);if(schedule.enabled===false)return;const signature=JSON.stringify(schedule),key='linkMonitorScheduler:'+hash(scope);let state=runtime.store.get(key);if(!state||state.signature!==signature){runtime.store.set(key,{signature,nextDue:now+300000});return;}if(now<state.nextDue)return;
 try{const result=await startLinkMonitor(runtime,{scheduled:true});runtime.store.set(key,{signature,nextDue:now+Math.max(15,Number(schedule.minutes)||1440)*60000,lastJobId:result.job.id});}catch(error){runtime.store.set(key,{...state,nextDue:now+60000,error:error.message});}
}

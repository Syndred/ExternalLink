import { chromium } from 'playwright';
import {originalCommentRequest} from './comment-cache.mjs';
import {startLinkMonitor,dismissMonitorAlert} from './link-monitor.mjs';
import {startPublicLibrarySync} from './public-library-sync.mjs';
import {workbenchBackup} from './workbench-backup.mjs';
import {runExports} from './run-exports.mjs';
import {runHistory} from './run-history.mjs';
import {watchBatchDeadline,batchActionAllowed,finalizeBatchDeadline,reserveBatchModelCall,recoverBatchTasks} from './workbench-batch-policy.mjs';
import {startDomainAge} from './domain-age.mjs';
import {prepareIndexNotification,notifyIndexNow} from './index-notification.mjs';
import { readFile, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Cloud } from './cloud.mjs';
import { queue, profiles, plain, selectScope, priorProductSuccess, repo } from './shared.mjs';
import { attachEngine } from './engine.mjs';
import { assessSubmissionQuality } from './quality.mjs';
import {applySubmissionPreferences,hasManualSubmissionConsent} from './submission-preferences.mjs';
import { canRetryNoAction } from './recovery.mjs';
import { closeTaskTab,archiveDeferredTabs,recoveryCheckpoint } from './tab-cleanup.mjs';
import { observeTask, closeObservation } from './observation.mjs';
import { findGooglePopup } from './google-auth.mjs';
import { registerAccount, verifyRegistration } from './registration.mjs';
import { selectVerifiedOption } from './react-picker.mjs';
import { aiOfDayCopy,profileFieldChoices,profileTagline } from './known-copy.mjs';
import { finishProductPreview } from './product-preview.mjs';
import {annotateObservation} from './observation-note.mjs';
import {rejectOptionalCookies,inspectCookiePreferences,enableFunctionalCookies,acceptAuthorizedCookies} from './necessary-cookies.mjs';
import {advancePlan,verifyPlanStage} from './plan-stage.mjs';
import {validateSquarePng} from './directory-logo.mjs';
import {logoutAuthObservation,recoverToolScoutLogout} from './logout-recovery.mjs';
import {recordCommunityVisit} from './community-visit.mjs';
import {selectCommittedMenuOption} from './menu-picker.mjs';
import {fillAndVerifyText} from './text-input.mjs';
import {capturePageEvidence} from './page-evidence.mjs';
import {requestLoginLink} from './login-link.mjs';
import {navToolsAdapter} from './adapters/navtools.mjs';
import {restoreLostPreparation} from './lost-preparation.mjs';
import {toolScoutFinalPreparation} from './staged-form.mjs';
import{advanceBasicGoogleLogin,canAuthenticateOffline,readBasicGoogleUI}from'./basic-google-login.mjs';
import{getTargetInfo}from'./browser-target.mjs';
import{journalSync,pendingWorkbench,workbenchDocuments,enqueueWorkbench,workbenchScope}from'./workbench-sync.mjs';
import {runOriginalAgentPreparation,originalPlanDecision} from './original-agent-flow.mjs';
import {captureOriginalTaskVisual} from './task-visual-context.mjs';
import {originalVisualFillActions} from './original-visit-fill.mjs';
import {restrictPreparationActions} from '../../core/takeover-policy.mjs';
import { AgentBrowserAdapter } from './agent-browser-adapter.mjs';
import { materializeTaskMedia,materializeTaskUpload } from './task-media.mjs';
import {selectedFrozenPngLogo} from '../../core/task-media-selection.mjs';
import {originalTaskMediaEvidence} from './task-media-evidence.mjs';
import {recordTaskMediaUpload} from './task-media-feedback.mjs';
import { readAfterNavigation, settleObservedClick } from './navigation-read.mjs';
import { registerAcceptance } from './acceptance-register.mjs';
import { applicationData } from './application-data.mjs';
import {enqueueLibraryMutation,flushApplicationMutations,pendingApplication} from './application-mutations.mjs';
import {pendingMediaUploads,flushMediaUploads} from './media-uploads.mjs';
import {startAcceptanceBatch,nextAcceptanceTask,finishAcceptanceTask} from './acceptance-batch.mjs';
import {closeAcceptanceTask} from './acceptance-cleanup.mjs';
import {skipOriginalUnavailableTask,attachOriginalGroupPage,navigateOriginalGroupPage,originalTaskSync} from './original-agent-unavailable.mjs';
import {previewWorkbenchBatch,startWorkbenchBatch,nextWorkbenchTask,finishWorkbenchTask,pauseWorkbenchBatch,applicationAi,fillCommentDraft,detectOriginalTask} from './workbench-features.mjs';
import {runWorkbenchBatch} from './workbench-batch-scheduler.mjs';
import {checkpointTaskUpdate,recoverCloudBatchRecords,parkRestoredBatchTask,flushBatchTaskEvents} from './workbench-batch-recovery.mjs';
import {requestExecutionPause,finalizeUserPause,resumeExecution,persistBatchLifecycle} from './execution-lifecycle.mjs';
import {commentHistory,saveCommentVersion} from './comment-history.mjs';
import {quickOpenLibrary} from './quick-open.mjs';
import {mediaLibrary} from './media-library.mjs';
import {cloudStatus,pushLocalChanges} from './cloud-status.mjs';
import {pullCloudState,previewCloudPull,commitCloudPull} from './cloud-pull.mjs';
import {browserLibraryPages,addBrowserPage} from './browser-library.mjs';
import {saveAssistantSettings,fillAssistantTask,requestAutoFill} from './browser-assistant.mjs';
import {manualWatchMessage,checkManualWatches} from './manual-watch.mjs';
import {armCaptchaResume,armPageCaptchaResume,checkCaptchaResumes} from './captcha-resume.mjs';
import {assertParkedResumePage} from './parked-task-resume.mjs';
import {clearSiteAnnotation} from './library-reset.mjs';
import {manualSkip,manualSubmit,stopExecution} from './manual-controls.mjs';
import {handleTaskPageMessage} from './task-page-controls.mjs';
import {submissionQueue,removeFromSubmissionQueue} from './submission-queue.mjs';
import {sidepanelOpened,sidepanelClosed,sidepanelDetect,sidepanelFill} from './single-page.mjs';
import {localRecoverySources,previewLocalRecovery,recoverLocalDocuments} from './local-recovery.mjs';
import {isProductHuntLaunch,runProductHuntWorkflow} from './product-hunt.mjs';
import {captureFillLearning,flushFillLearning,pendingFillLearning} from './fill-learning.mjs';
import {applyDestinationFormKnowledge} from '../../core/form-knowledge.mjs';
import {classifyOriginalTaskGate,originalLinkrenaPostSubmitLogin} from './original-site-classification.mjs';

const hasJevPlayIdentity=profile=>profile?.id==='JevPlay'&&profile?.name==='JevPlay'&&profile?.url==='https://jevplay.com'&&
  profile?.fields?.Name==='JevPlay'&&profile?.fields?.Url==='https://jevplay.com';
const withinDeadline=(promise,ms,label)=>{
  let timer;return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}超时，已登记并跳过当前站收尾`)),ms);})]).finally(()=>clearTimeout(timer));
};
export function findUnambiguousOfflineRun(store,task){
  if(task.runId)return store.get(`run:${task.runId}`);
  if(task.status!=='pending'||task.attemptBoundary||task.receipt||!task.libraryPlanId||task.profileId!=='JevPlay')return null;
  const matches=store.values('run:').filter(run=>run.libraryPlanId===task.libraryPlanId&&run.profileId==='JevPlay'&&run.offlineSnapshotAt&&
    Array.isArray(run.tasks)&&run.tasks.some(item=>(typeof item==='string'?item:item?.id)===task.id));
  return matches.length===1?matches[0]:null;
}
export function ownedTaskTargetIds(store,planId,browserInstance){
  const ids=new Set();
  for(const task of store.values('task:').filter(t=>t.libraryPlanId===planId&&!t.tabClosedAt&&t.browserInstance===browserInstance&&!t.attemptBoundary&&!t.receipt))
    for(const id of [task.targetId,task.authTargetId,...(task.authPages||[]).map(page=>page.targetId)])if(id)ids.add(id);
  return ids;
}
export async function liveOwnedTaskTargetIds(runtime,planId,browserInstance){
  const recorded=ownedTaskTargetIds(runtime.store,planId,browserInstance),live=new Set();
  if(!runtime.context)await runtime.connect();
  for(const page of runtime.context.pages()){
    const info=await getTargetInfo(runtime.context,page);
    if(info&&(recorded.has(info.targetId)||recorded.has(info.openerId)))live.add(info.targetId);
  }
  return live;
}

export function classifyBlocker(reason){
 if(/验证码|真人|captcha|turnstile|verify.*human/i.test(reason))return 'human_verification';
 if(/登录|login|sign[ -]?in|账号|邮件.*验证|magic.?link/i.test(reason))return 'login';
 if(/付费|收费|付款|payment|paywall|checkout|subscription|priced?/i.test(reason))return 'payment';
 if(/评论.*审核|评论.*相关性/.test(reason))return 'comments_require_review';
 if(/素材|必填|字段|资料.*补|缺少/.test(reason))return 'missing_fields';
 if(/goto|timeout|超时|ERR_|certificate|net::|DNS|连接/i.test(reason))return 'site_unavailable';
 if(/表单|投稿入口|投稿按钮|前进动作/.test(reason))return 'site_form_unavailable';
 return 'site_requires_review';
}
export function classifyPauseFailure(error){
 const message=String(error?.message||error||'');
 if(error?.cloudQuota||/Your account or project has exceeded the quota|quota exceeded|额度.*超/i.test(message))
  return{attentionType:'cloud_quota',resumeEligible:false};
 if(error?.cloudFailure||error?.cloudNetwork)
  return{attentionType:'cloud_connection',resumeEligible:!error?.cloudQuota&&(!!error?.cloudNetwork||Number(error?.status)>=500)};
 if(/browserContext\.newCDPSession|no object with guid|(?:target|session) closed|page target disappeared|browser has disconnected|browser.*closed|connection.*closed/i.test(message))
  return{attentionType:'browser_connection',resumeEligible:false};
 return{attentionType:'executor_error',resumeEligible:false};
}
export function publicPageBlocker(inspection){
 const text=inspection.text||'';
 if(/^(?:404(?:\s*[-|:]?\s*(?:not found|page not found))?|page not found|(?:403|502|503|504)\b[^\n]*)$/i.test((inspection.title||'').trim())&&
   /(?:not found|could not be found|forbidden|bad gateway|service unavailable|gateway timeout)/i.test(text))
   return{attentionType:'site_unavailable',reason:'投稿地址返回明确站点错误页：'+inspection.title+'；保留证据后继续下一站，未投稿'};
 if((inspection.iframeSources||[]).some(u=>/challenges\.cloudflare\.com|(?:google\.com|recaptcha\.net)\/recaptcha|hcaptcha\.com/i.test(u))||/verify (?:that )?you are human|checking (?:your )?browser|验证您是真人|进行人机身份验证/i.test(text))
   return{attentionType:'human_verification',reason:'站方要求真人验证，已登记当前页面，跳过并继续下一站；未点击投稿'};
 if(inspection.hasPassword||!hasSubmissionFields(inspection)&&
   (/^(?:log\s*in|sign\s*in|create your account|register|登录|注册)(?:\b|[\s|—:])/i.test(inspection.title||'')||
    !/tool|product|startup/i.test(inspection.title||'')&&/\/(?:login|sign-?in|sign-?up|register|auth)(?:\/|$)/i.test(inspection.url||'')))return{attentionType:'login',reason:'当前站点要求账号登录或注册，缺少可自动核实的登录状态；已登记原页并继续下一站，未投稿'};
 if(/\/contact(?:[-/]|$)/i.test(inspection.url||'')&&!hasSubmissionFields(inspection))return{attentionType:'email_only',reason:'当前页面是联系渠道，没有已核实的产品投稿表单；不发送站外联系消息，登记后继续下一站'};
 if(/(?:this (?:typeform|form) is (?:now )?closed|form (?:does not exist|not found)|listing fee required|payment required)/i.test(text))
   return{attentionType:/fee required|payment required/i.test(text)?'payment':'site_form_unavailable',reason:'站方页面明确阻塞：'+text.slice(0,650)};
 if(/(?:do not|don.t|not accept|prohibit)[^.\n]{0,90}(?:AI.generated|copied descriptions)/i.test(text))
   return{attentionType:'missing_real_identity',reason:'站方要求真实原创投稿内容，现有生成描述不满足该要求；保留证据后继续下一站'};
 return null;
}
export function hasSubmissionFields(inspection){return (inspection.fieldLabels||[]).some(f=>f.type==='url'||!/^(?:search|query|搜索|检索)/i.test(f.label)&&/\b(?:website|tool name|product name|startup name|application name|description|business name)\b|网址|工具名称|产品名称/i.test(f.label));}
export function chooseFreeOffer(current,offers){
 const origin=new URL(current).origin,valid=(offers||[]).filter(o=>/^(?:free|[$€£]\s*0(?:\.00)?)$/i.test(o.heading||'')&&
   !/[$€£]\s*[1-9]|\b(?:trial|checkout|billing|payment)\b/i.test(o.text||'')&&
   (()=>{try{const u=new URL(o.href,current);return u.origin===origin&&!/checkout|payment|billing/i.test(u.pathname);}catch{return false;}})());
 const unique=[...new Map(valid.map(o=>[o.href,o])).values()];return unique.length===1?{...unique[0],offerText:unique[0].text,text:unique[0].textLabel||unique[0].text}:null;
}
export function chooseObservedEntry(current,links){
 const original=new URL(current),host=original.hostname.replace(/^www\./,'');
 const choices=[];
 for(const link of links){
   if(!/^(?:submit(?:\s+(?:a|an|your|new))?\s*(?:ai\s*)?(?:tool|startup|website|site|app|application|listing|product|resource|link|url|company|business)?|(?:add|list)\s+(?:a|an|your|new)?\s*(?:ai\s*)?(?:tool|startup|website|site|app|listing|product|company|business|url)|suggest\s+(?:a|an|your)?\s*(?:ai\s*)?(?:tool|resource|website|site|url)|(?:提交|添加|推荐)(?:网站|网址|工具|应用|产品|链接))\s*[→+!🌟]*$/i.test(link.text.trim()))continue;
   let url;try{url=new URL(link.href,current);}catch{continue;}
   if(!/^https?:$/.test(url.protocol)||url.href===original.href||url.username||url.password)continue;
   const same=url.hostname.replace(/^www\./,'')===host,hosted=url.protocol==='https:'&&/(?:^|\.)(?:airtable\.com|tally\.so|formaloo\.net|typeform\.com|forms\.gle)$/.test(url.hostname);
   if(!same&&!hosted)continue;
   if(!choices.some(c=>c.href===url.href))choices.push({...link,href:url.href});
 }
 return choices.length===1?choices[0]:null;
}

export class Runtime {
  constructor(store, home) { this.store = store; this.home = home; this.job = null; this.cloudError = ''; this.controllerId = store.get('executorControllerId') || randomUUID(); store.set('executorControllerId',this.controllerId); recoverBatchTasks(this);store.recover(); if(store.get('offlineMode')?.enabled)this.hydrated=true; if (store.get('singleTaskId')) { store.set('paused', true); store.set('singleTaskId', null); } }
  get cloud() { const pair = this.store.get('pair'); if (!pair) throw new Error('请先在插件中配对'); return new Cloud(pair, {
    onNetworkFailure: error => { this.lastCloudNetworkFailure = error.message; this.cloudError = error.message; },
    onSuccess: () => {
      if (this.lastCloudNetworkFailure && this.cloudError === this.lastCloudNetworkFailure) this.cloudError = '';
      this.lastCloudNetworkFailure = null;
    },
  }); }
  async withControl(operation) {
    this.controlBusy = true;
    try { return await operation(); }
    finally { this.controlBusy = false; }
  }
  status() { const pending = this.store.pendingSummary ? this.store.pendingSummary() : this.store.pending(),plan=this.store.get('libraryPlan'),tasks=this.store.values('task:');
    const plannedIds=new Set([...(plan?.initialPending||[]),...(plan?.batches||[]).flatMap(b=>b.taskIds)]),planned=tasks.filter(t=>plannedIds.has(t.id)),counts={};
    for(const task of planned){const key=task.siteStatus==='accepted'&&task.cloudVerified?'accepted':task.siteStatus==='accepted'?'accepted_local_pending_sync':['pending','opening','filling','submitting'].includes(task.status)?task.status:task.attentionType||task.status;counts[key]=(counts[key]||0)+1;}
    const offlineMode=this.store.get('offlineMode'),paused=this.store.get('paused')!==false,activeOfflineMode=offlineMode?.enabled===true&&paused===false;
    const historicalQuota=offlineMode?.enabled===true&&plan?.globalPause&&
      (plan.globalPause.attentionType==='cloud_quota'||/quota|额度|exceeded/i.test(plan.globalPause.reason||''));
    const globalGateActive=!!plan?.globalPause&&paused&&!historicalQuota;
    const libraryPlan=plan?{id:plan.id,status:plan.status,sourceTotal:plan.sourceTotal,profileId:plan.profileId,profileRevision:plan.profileRevision,
      frozenDenominator:plan.initialPending.length+plan.candidates.length,cursor:plan.cursor,candidateCount:plan.candidates.length,initialPending:plan.initialPending.length,
      enrolled:planned.length,processed:planned.filter(t=>!['pending','opening','filling','submitting'].includes(t.status)).length,counts,
      exclusions:plan.exclusions.length,runtimeExclusions:plan.runtimeExclusions.length,batches:plan.batches.length,scopeHash:plan.scopeHash,snapshotAt:plan.offlineSnapshotAt||null,
      globalPause:plan.globalPause?{...plan.globalPause,active:globalGateActive,historical:!globalGateActive}:null}:null;
    return { ok: true, runtimeMode:'standalone-core', paired: !!this.store.get('pair'), paused, busy: !!this.job||!!this.indexNowJobs?.size||!!this.backupImportOperations?.size,offlineMode:offlineMode?.enabled?offlineMode:null,libraryPlan,activeTaskId:this.activeTaskId,
    runs: this.store.values('run:'), tasks: tasks.map(task => ({ ...task, pendingEvents:pending.filter(e=>e.taskId===task.id).length, syncStatus:task.syncConflict?'conflict':pending.some(e => e.taskId === task.id) || (task.receipt && !task.cloudVerified) ? 'pending' : 'confirmed' })), pendingEvents: pending.length, workbenchPendingEvents:pendingWorkbench(this).length, cloudError:activeOfflineMode?'':this.cloudError, host: this.host ? { version: this.host.version, instance: this.host.startedAt } : null }; }
  async connect() {
    this.host = JSON.parse(await readFile(path.join(this.home, 'host.json'), 'utf8'));
    this.browser = await chromium.connectOverCDP(this.host.endpoint, { timeout: 10000 });
    this.context = this.browser.contexts()[0];
    const observedHost=this.host;
    await appendFile(path.join(this.home,'host-events.jsonl'),JSON.stringify({at:new Date().toISOString(),type:'executor_attached',browserInstance:observedHost.startedAt,chromePid:observedHost.chromePid,serverPid:process.pid})+'\n');
    this.browser.on('disconnected', () => { appendFile(path.join(this.home,'host-events.jsonl'),JSON.stringify({at:new Date().toISOString(),type:'browser_disconnected',browserInstance:observedHost.startedAt,chromePid:observedHost.chromePid,serverPid:process.pid})+'\n').catch(()=>{});this.browser = null; this.context = null; });
  }
  async preview(input) {
    const snapshot = await this.cloud.request('snapshot');
    const bundled = JSON.parse(await readFile(path.join(repo, 'core/table-library.json'), 'utf8'));
    if (!snapshot.documents.siteProfiles?.[input.profileId]) throw new Error('云端不存在选定产品');
    const scope = selectScope(snapshot, bundled, input.profileId, input.urls);
    const existing = await this.cloud.request('runs?view=inventory');
    const claimed = new Set(existing.tasks.map(t => `${t.destinationKey}::${t.profileId}`));
    const claimedHosts=new Set(existing.tasks.filter(t=>t.profileId===input.profileId).map(t=>queue.extractDomain(t.url).toLowerCase()));
    const selectedHosts=new Set();
    scope.tasks = scope.tasks.filter(t => {
      const host=queue.extractDomain(t.url).toLowerCase();
      if(claimed.has(`${t.destinationKey}::${input.profileId}`)||claimedHosts.has(host)){scope.exclusions.push({url:t.url,reason:'已有同站持久任务，需继续原任务'});return false;}
      if(selectedHosts.has(host)){scope.exclusions.push({url:t.url,reason:'同站其他入口，保留一个投稿目标'});return false;}
      selectedHosts.add(host);return true;
    });
    const preview = { id: randomUUID(), at: Date.now(), profileId: input.profileId, profileRevision: snapshot.revisions.siteProfiles, profile: snapshot.documents.siteProfiles[input.profileId], ...scope };
    this.store.set('preview', preview);
    return { ok: true, preview };
  }
  async start(input) {
    const preview = this.store.get('preview');
    if (!preview || preview.id !== input.previewId || Date.now() - preview.at > 300000) throw new Error('请先预览本次产品和范围');
    if (this.store.values('task:').some(t => ['pending','opening','filling','submitting'].includes(t.status))) throw new Error('已有未完成批次，请继续原批次');
    const limit = Number(input.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('范围需为 1–500 站');
    const run = { id: randomUUID(), profileId: preview.profileId, profileRevision: preview.profileRevision, createdAt: new Date().toISOString(), authorization: 'ordinary_free_submission', feeLimit: 0,
      tasks: preview.tasks.slice(0, limit).map(t => ({ ...t, id: randomUUID() })) };
    if (!run.tasks.length) throw new Error('没有可执行的新任务');
    const saved = await this.cloud.request('runs', { run });
    this.store.set(`run:${run.id}`, saved.run);
    for (const task of saved.tasks) this.store.set(`task:${task.id}`, task);
    this.store.set('executionStopped',null);this.store.set('manualResumeRunId',run.id);this.store.set('paused', false); this.tick();
    return this.status();
  }
  async startLibrary(input) {
    if(this.job||this.store.get('paused')!==true||(this.store.pendingCount?.()??this.store.pending().length))throw new Error('全库启动需要暂停空闲且历史事件已回读');
    const preview=this.store.get('preview');
    if(!preview||preview.id!==input.previewId||Date.now()-preview.at>300000||preview.profileId!=='JevPlay'||preview.profile.fields?.Url!=='https://jevplay.com'||input.ordinaryPermissionsAuthorized!==true)
      throw new Error('全库执行需要最新JevPlay预览及用户已授权的普通免费权限');
    const prior=this.store.get('libraryPlan');
    if(prior?.status==='active')throw new Error('已有全库计划，请继续原计划');
    const initialPending=this.store.values('task:').filter(t=>t.profileId===preview.profileId&&t.status==='pending'&&!t.attemptBoundary&&!t.receipt).map(t=>t.id);
    const plan={id:randomUUID(),createdAt:new Date().toISOString(),status:'active',profileId:preview.profileId,
      profileRevision:preview.profileRevision,sourceTotal:preview.total,sources:preview.sources,initialPending,
      candidates:plain(preview.tasks),exclusions:plain(preview.exclusions),cursor:0,batches:[],runtimeExclusions:[],
      batchSize:Math.min(100,Math.max(1,Number(input.batchSize)||100)),authorization:'explicit_user_all_permissions',feeLimit:0,
      retainedTabLimit:5,maxTaskTabCount:6,scopeHash:createHash('sha256').update(JSON.stringify({pending:initialPending,candidates:preview.tasks})).digest('hex')};
    this.store.set('executionStopped',null);this.store.set('manualResumeRunId',null);this.store.set('libraryPlan',plan);this.store.set('singleTaskId',null);this.store.set('paused',false);this.tick();return this.status();
  }
  async queueLibraryBatch() {
    let plan=this.store.get('libraryPlan');
    if(plan?.status!=='active')return;
    if(!plan.pendingBatch){
      if(plan.cursor>=plan.candidates.length){plan={...plan,status:'complete',completedAt:new Date().toISOString()};this.store.set('libraryPlan',plan);this.store.set('paused',true);return;}
      const items=plan.candidates.slice(plan.cursor,plan.cursor+plan.batchSize);
      if(this.store.get('offlineMode')?.enabled){
        const preview=this.store.get('preview');
        if(!preview||preview.profileId!==plan.profileId||preview.profileRevision!==plan.profileRevision||preview.profile?.fields?.Url!=='https://jevplay.com'||!plan.scopeHash)throw new Error('离线批次缺少匹配的完整云端快照，隔离本批次');
        const known=this.store.values('task:').filter(t=>t.profileId===plan.profileId),claimedHosts=new Set(known.map(t=>queue.extractDomain(t.url).toLowerCase()));
        const eligible=items.filter(t=>!claimedHosts.has(queue.extractDomain(t.url).toLowerCase()));
        const missing=items.filter(t=>claimedHosts.has(queue.extractDomain(t.url).toLowerCase())).map(t=>({url:t.url,at:new Date().toISOString(),reason:'离线去重命中本地持久任务或未知尝试边界，隔离且不重投'}));
        const runId=randomUUID();
        const run={id:runId,profileId:plan.profileId,profileRevision:plan.profileRevision,createdAt:new Date().toISOString(),authorization:'ordinary_free_submission',ordinaryPermissionsAuthorized:true,feeLimit:0,libraryPlanId:plan.id,offlineSnapshotAt:new Date(preview.at).toISOString(),tasks:eligible.map(t=>({...t,id:randomUUID(),runId,profileId:plan.profileId,profileSnapshot:plain(preview.profile),profileRevision:plan.profileRevision,libraryPlanId:plan.id,status:'pending',version:1,attemptBoundary:null,receipt:null,cloudVerified:false}))};
        if(!eligible.length){this.store.set('libraryPlan',{...plan,cursor:plan.cursor+items.length,runtimeExclusions:[...plan.runtimeExclusions,...missing]});return;}
        this.store.set(`run:${run.id}`,run);for(const task of run.tasks)this.store.set(`task:${task.id}`,task);
        this.store.set('libraryPlan',{...plan,cursor:plan.cursor+items.length,pendingBatch:null,batches:[...plan.batches,{runId:run.id,taskIds:run.tasks.map(t=>t.id),profileRevision:run.profileRevision,offline:true}],runtimeExclusions:[...plan.runtimeExclusions,...missing]});return;
      }
      const snapshot=await this.cloud.request('snapshot');
      if(snapshot.documents.siteProfiles?.[plan.profileId]?.fields?.Url!=='https://jevplay.com')throw new Error('全库产品资料身份发生变化，停止执行');
      const allowed=plain(selectScope(snapshot,null,plan.profileId,items.map(t=>t.url)));
      const saved=await this.cloud.request('runs?view=inventory'),claimedHosts=new Set(saved.tasks.filter(t=>t.profileId===plan.profileId).map(t=>queue.extractDomain(t.url).toLowerCase()));
      const tasks=allowed.tasks.filter(t=>!claimedHosts.has(queue.extractDomain(t.url).toLowerCase()));
      const missing=items.filter(t=>!tasks.some(a=>a.destinationKey===t.destinationKey)).map(t=>({url:t.url,at:new Date().toISOString(),reason:allowed.exclusions.find(e=>e.url===t.url)?.reason||'已有同站任务'}));
      if(!tasks.length){this.store.set('libraryPlan',{...plan,cursor:plan.cursor+items.length,runtimeExclusions:[...plan.runtimeExclusions,...missing]});return;}
      const run={id:randomUUID(),profileId:plan.profileId,profileRevision:snapshot.revisions.siteProfiles,createdAt:new Date().toISOString(),
        authorization:'ordinary_free_submission',ordinaryPermissionsAuthorized:true,feeLimit:0,libraryPlanId:plan.id,tasks:tasks.map(t=>({...t,id:randomUUID()}))};
      plan={...plan,pendingBatch:{run,nextCursor:plan.cursor+items.length,missing}};this.store.set('libraryPlan',plan);
    }
    const pending=plan.pendingBatch;
    // A saved batch identity survives a lost POST reply or a service restart.
    // Read it first; never create a second run to conceal a failed response.
    let saved=await this.cloud.request('runs?view=inventory'),existing=saved.runs.find(r=>r.id===pending.run.id);
    if(!existing){
      try{await this.cloud.request('runs',{run:pending.run});}
      catch(error){saved=await this.cloud.request(`runs?runId=${encodeURIComponent(pending.run.id)}`);if(!saved.runs.some(r=>r.id===pending.run.id))throw error;}
      saved=await this.cloud.request(`runs?runId=${encodeURIComponent(pending.run.id)}`);existing=saved.runs.find(r=>r.id===pending.run.id);
    }else{
      saved=await this.cloud.request(`runs?runId=${encodeURIComponent(pending.run.id)}`);existing=saved.runs.find(r=>r.id===pending.run.id);
    }
    const tasks=saved.tasks.filter(t=>t.runId===pending.run.id);
    if(!existing||tasks.length!==pending.run.tasks.length||pending.run.tasks.some(w=>!tasks.some(t=>t.id===w.id&&t.url===w.url&&t.destinationKey===w.destinationKey&&t.profileId===plan.profileId)))
      throw new Error('全库批次独立云端回读不一致');
    this.store.set('run:'+existing.id,existing);for(const task of tasks)this.store.set('task:'+task.id,task);
    this.store.set('libraryPlan',{...plan,cursor:pending.nextCursor,pendingBatch:null,batches:[...plan.batches,{runId:existing.id,taskIds:tasks.map(t=>t.id),profileRevision:existing.profileRevision}],runtimeExclusions:[...plan.runtimeExclusions,...pending.missing]});
  }
  async finalizeContinuousTask(prior) {
    const task=this.store.get('task:'+prior.id);
    const terminal=['payment','site_form_unavailable','email_only','site_unavailable','missing_fields','missing_real_identity','comments_require_review','site_requires_review'];
    if(task.tabClosedAt||task.tabHistory?.at(-1)?.disposition==='original_target_unavailable')return;
    const offline=this.store.get('offlineMode')?.enabled===true;
    const evidenceGap=offline&&task.status==='needs_manual'&&task.siteStatus==='not_submitted'&&!task.attemptBoundary&&!task.receipt&&
      task.attentionType==='site_unavailable'&&/(?:timeout|timed out|ERR_|net::|连接|超时)/i.test(task.reason||'');
    if((task.status==='finished'&&(task.cloudVerified||offline&&task.siteStatus==='accepted'&&task.screenshot))||
      task.status==='needs_manual'&&!task.attemptBoundary&&terminal.includes(task.attentionType)){
      if(task.artifactRef||offline&&(task.screenshot||evidenceGap))await closeTaskTab(this,task,{expectedTargetId:task.targetId,closeBlocked:true,
        ...(evidenceGap?{allowEvidenceGap:true,evidenceCaptureTimeoutMs:3000}:{})},{continuous:true});
    }else if(offline&&task.status==='needs_manual'&&task.siteStatus==='not_submitted'&&!task.attemptBoundary&&!task.receipt&&
      ['human_verification','login'].includes(task.attentionType)){
      await closeTaskTab(this,task,{expectedTargetId:task.targetId,archiveManual:true},{continuous:true,archiveManual:true});
    }else if(offline&&task.status==='submitted_unconfirmed'&&task.attemptBoundary&&!task.receipt&&task.attentionType==='unknown_receipt'&&!task.recoveryCheckpoint){
      let page=null;try{page=await this.findPage(task);}catch{}
      const checkpoint=recoveryCheckpoint(task,page||{url:()=>task.publicPage?.url||task.url},task.screenshot||'',null);
      checkpoint.nextStep='在保留的原任务页核验站方收件结果；不要再次提交';
      checkpoint.formRecoverability='original_page_verification_only_no_repost';checkpoint.originalTargetAvailable=!!page;
      this.update(task,{recoveryCheckpoint:checkpoint},'unknown_receipt_checkpoint');
    }else if(task.targetId&&task.tabRetainReason!==task.reason){
      this.update(task,{tabRetainReason:task.reason,deferredAt:new Date().toISOString()},'continuous_tab_retained');await this.synchronize();
    }
  }
  async finalizePriorContinuousTask(task) {
    this.activeTaskId=task.id;
    try { await this.finalizeContinuousTask(task); }
    finally { this.activeTaskId=null; }
  }
  async trimDeferredTabs(){
    const plan=this.store.get('libraryPlan');if(plan?.status!=='active')return;
    const eligible=this.store.values('task:').filter(t=>t.libraryPlanId===plan.id&&t.status==='needs_manual'&&!t.attemptBoundary&&!t.receipt&&!t.tabClosedAt&&
      !t.authTargetId&&!t.registration?.boundary&&!t.loginLinkRequest?.boundary&&['human_verification','login'].includes(t.attentionType))
      .sort((a,b)=>(a.deferredAt||'').localeCompare(b.deferredAt||''));
    for(const task of eligible.slice(0,Math.max(0,eligible.length-plan.retainedTabLimit))){
      this.activeTaskId=task.id;await closeTaskTab(this,task,{expectedTargetId:task.targetId,closeBlocked:true},{continuous:true,archiveDeferred:true});
    }
    this.activeTaskId=null;
  }
  async recoverContinuousConnection(){
    await this.synchronize();
    const [snapshot,runs]=await Promise.all([this.cloud.request('snapshot'),this.cloud.request('runs')]);
    const plan=this.store.get('libraryPlan');
    if(plan?.status!=='active'||snapshot.documents.siteProfiles?.[plan.profileId]?.fields?.Url!=='https://jevplay.com')throw new Error('连接恢复时产品资料身份不符');
    const keys=['id','runId','profileId','destinationKey','status','siteStatus','attemptBoundary','actualSubmission','artifactRef','artifactSha256','profileRevision','version','controllerId'];
    for(const local of this.store.values('task:')){
      const remote=runs.tasks.find(t=>t.id===local.id);
      if(!remote||keys.some(k=>!isDeepStrictEqual(plain(local[k]??null),remote[k]??null)))throw new Error('连接恢复时任务或控制权回读不一致，保持暂停');
    }
    this.store.recover();await this.synchronize();
    this.store.set('libraryPlan',{...plan,globalPause:null,lastConnectionRecovery:new Date().toISOString()});
    this.store.set('paused',false);this.cloudError='';
  }
  async preparePublicPage(page,task,{active=()=>this.store.get('paused')===false&&batchActionAllowed(this,task)}={}){
    for(let step=0;step<3;step++){
      const inspected=await readAfterNavigation(page,()=>page.evaluate(()=>({url:location.origin+location.pathname,documentTimeOrigin:performance.timeOrigin,title:document.title,text:document.body?.innerText?.slice(0,16000)||'',
        hasPassword:[...document.querySelectorAll('input[type=password]')].some(e=>e.getBoundingClientRect().width>0),
        fieldLabels:[...document.querySelectorAll('input:not([type=hidden]):not([type=password]),textarea,select')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({type:e.type,label:e.labels?.[0]?.textContent?.trim()||e.placeholder||e.name||e.id})),
        iframeSources:[...document.querySelectorAll('iframe[src]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>e.src),
        freeOffers:[...document.querySelectorAll('h1,h2,h3,h4')].filter(h=>h.getBoundingClientRect().width>0&&/^(?:free|[$€£]\s*0(?:\.00)?)$/i.test(h.textContent.trim())).flatMap(h=>{
          let p=h;for(let n=0;n<6&&p;n++,p=p.parentElement){const text=p.innerText||'';const links=[...p.querySelectorAll('a[href]')].filter(a=>a.getBoundingClientRect().width>0&&/submit now|get started|start free|select/i.test(a.textContent));
          if(links.length===1&&text.length<1600&&!/[$€£]\s*[1-9]/.test(text))return[{heading:h.textContent.trim(),text,href:links[0].href,textLabel:links[0].textContent.trim()}];}return[];}),
        links:[...document.querySelectorAll('a[href]')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({text:e.textContent.trim().slice(0,100),href:e.href}))})));
      const strip=u=>{try{const parsed=new URL(u);return parsed.origin+parsed.pathname;}catch{return'';}};
      this.update(task,{publicPage:{...inspected,links:inspected.links.map(l=>({...l,href:strip(l.href)}))}},'public_page_inspected');
      const free=chooseFreeOffer(page.url(),inspected.freeOffers);
      const gate=publicPageBlocker(inspected);
      const continueAuth=task.authAttempts?.length===1&&task.authAttempts[0].onlyBasicAuthentication===true&&task.authAttempts[0].status==='in_progress';
      if(gate?.attentionType==='login'&&(!task.authAttempts?.length||continueAuth)&&task.consentHistory?.some(c=>c.scope==='ordinary_submission_permissions')&&
        (await readBasicGoogleUI(page)).controls.filter(c=>/^(?:sign in|continue|log in|login|sign up|connect) with google$/i.test(c.label)).length===1){
        const login=await advanceBasicGoogleLogin(this,task,page,{continueExistingAuth:continueAuth});
        if(login.authenticated){
          const entry=page.getByRole('link',{name:/^submit\s*\+?$/i}).filter({visible:true});
          if(await entry.count()===1&&new URL(await entry.getAttribute('href'),page.url()).href===task.url){await page.goto(task.url,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);}
          continue;
        }
        this.update(task,{attentionType:/验证码|真人|OTP/.test(login.reason)?'human_verification':'login'},'basic_google_deferred');throw new Error(login.reason);
      }
      if(gate&&!(gate.attentionType==='payment'&&free)){
        this.update(task,{attentionType:gate.attentionType},'public_gate');
        const result=['payment','site_form_unavailable','site_unavailable'].includes(gate.attentionType)?{blocked:true,reason:gate.reason}:gate.attentionType==='human_verification'?{captcha:true,reason:gate.reason}:gate.attentionType==='login'?{gate:'login',reason:gate.reason}:null;
        if(result&&task.controller!=='ai')await classifyOriginalTaskGate(this,{task,page,result,active,assertPageDocument:async()=>{if(await page.evaluate(()=>performance.timeOrigin)!==inspected.documentTimeOrigin)throw Object.assign(Error('原公开页面文档已变化，自动观察停止'),{staleTask:true});}});
        throw Object.assign(new Error(gate.reason),result?{originalPublicGateResult:result,originalPublicGateClassified:task.controller!=='ai',originalPublicGateDocumentTimeOrigin:inspected.documentTimeOrigin}:{});
      }
      const hasForm=hasSubmissionFields(inspected);
      const entry=!hasForm&&(chooseObservedEntry(page.url(),inspected.links)||free);
      if(!entry||step===2)return;
      const file=path.join(this.home,`${task.id}-${Date.now()}-entry.png`);await capturePageEvidence(this.context,page,{path:file});
      const bytes=await readFile(file),sha=createHash('sha256').update(bytes).digest('hex');
      if(this.store.get('offlineMode')?.enabled){this.update(task,{entryHistory:[...(task.entryHistory||[]),{at:new Date().toISOString(),source:inspected.url,href:strip(entry.href),text:entry.text,freeOffer:entry.offerText,artifactRef:'',artifactSha256:sha,localEvidence:file,syncStatus:'pending'}]},'observed_entry_registered_offline');await page.goto(entry.href,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);continue;}
      const artifact=await this.cloud.request('artifact',{taskId:task.id,dataUrl:'data:image/png;base64,'+bytes.toString('base64')});
      const read=await this.cloud.request('artifact-read',{taskId:task.id,ref:artifact.ref});
      if(artifact.sha256!==sha||createHash('sha256').update(Buffer.from(read.dataUrl.split(',')[1],'base64')).digest('hex')!==sha)throw Object.assign(new Error('投稿入口截图独立回读不一致'),{cloudNetwork:true});
      this.update(task,{entryHistory:[...(task.entryHistory||[]),{at:new Date().toISOString(),source:inspected.url,href:strip(entry.href),text:entry.text,freeOffer:entry.offerText,artifactRef:artifact.ref,artifactSha256:sha}]},'observed_entry_registered');
      await this.cloud.flush(this.store);
      await page.goto(entry.href,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(1500);
    }
  }
  update(task, patch, type, stateChanges) { const checkpoint=checkpointTaskUpdate(this,task,patch,stateChanges);const next={...task,...checkpoint.patch};const event=this.store.transition(next,type,checkpoint.stateChanges);Object.assign(task,next);return event; }
  async lease(task,{online=false}={}) {
    if(task.originalFreshRoundSuccessorTaskId)throw Object.assign(Error('旧任务已进入历史，请使用原新一轮任务'),{status:409});
    const leaseScope=workbenchScope(this.store.get('pair')),leaseTask=structuredClone(this.store.get('task:'+task.id));
    if(this.store.get('offlineMode')?.enabled&&!online){task.version=Number(task.version)||0;task.controllerId=this.controllerId;task.localLease={at:new Date().toISOString(),controllerId:this.controllerId,authority:'single-local-executor'};this.store.set(`task:${task.id}`,task);return;}
    let lease;
    try { lease = await this.cloud.request('lease', { taskId: task.id, version: task.version, controllerId: this.controllerId }); }
    catch(error) {
      if(error.status!==409 || !/控制权版本已变化/.test(error.message) || (this.store.pendingCount?.()??this.store.pending().length))throw error;
      const remote=(await this.cloud.request('runs')).tasks.find(t=>t.id===task.id);
      const withoutVersion=value=>{const copy={...value};delete copy.version;return copy;};
      if(!remote || remote.version<=task.version || !isDeepStrictEqual(withoutVersion(remote),withoutVersion(task)))throw error;
      // A handoff may have changed only the CAS version before its local event
      // was saved. The cloud still enforces the active lease on this request.
      lease=await this.cloud.request('lease',{taskId:task.id,version:remote.version,controllerId:this.controllerId});
    }
    if(leaseScope!==workbenchScope(this.store.get('pair'))||!isDeepStrictEqual(this.store.get('task:'+task.id),leaseTask))throw Object.assign(Error('领取期间原任务或工作区已变化，保留新状态'),{staleTask:true});
    task.version = lease.version; task.controllerId = this.controllerId;
    this.store.set(`task:${task.id}`, task);
  }
  synchronize() {
    const previous=this.synchronizationOperation||Promise.resolve(),operation=previous.catch(()=>{}).then(()=>Runtime.prototype.synchronizeNow.call(this));this.synchronizationOperation=operation;
    return operation.finally(()=>{if(this.synchronizationOperation===operation)this.synchronizationOperation=null;});
  }
  async synchronizeNow() {
    if(pendingMediaUploads(this).length)await flushMediaUploads(this);
    if(pendingApplication(this).length)await flushApplicationMutations(this);
    if(pendingFillLearning(this).length)await flushFillLearning(this);
    if(this.store.get('offlineMode')?.enabled)return this.status();
    if(pendingWorkbench(this).length){const result=await journalSync(this).flush();if(result.pending&&result.error)throw Error('工作台进度待同步：'+result.error);}
    const offline=this.store.get('offlineMode');
    if(offline?.syncStartedAt)await this.reconcileOfflineRuns();
    await this.cloud.flush(this.store);
    if((this.store.pendingSummary?.()||this.store.pending()).some(e=>!this.store.get(`task:${e.taskId}`)?.syncConflict))return this.status();
    let imagesSynced=0,receiptsSynced=0;
    for (const task of this.store.values('task:')) {
      if(this.activeTaskIds?.has(task.id))continue;
      if (task.screenshot && !task.artifactRef && imagesSynced<4) {
        const bytes = await readFile(task.screenshot);
        const artifact = await this.cloud.request('artifact', { taskId: task.id, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` });
        if (artifact.sha256 !== createHash('sha256').update(bytes).digest('hex')) throw new Error('证据 SHA-256 回读不一致');
        const readback = await this.cloud.request('artifact-read', { taskId: task.id, ref: artifact.ref });
        if (createHash('sha256').update(Buffer.from(readback.dataUrl.split(',')[1],'base64')).digest('hex') !== artifact.sha256) throw new Error('独立证据下载校验失败');
        this.update(task, { artifactRef: artifact.ref, artifactSha256: artifact.sha256 }, 'artifact_readback');
        imagesSynced++;
      }
      if (!task.receipt || task.cloudVerified || task.syncConflict || receiptsSynced>=4) continue;
      receiptsSynced++;
      const record = plain(queue.buildSuccessRecord({ destinationUrl: task.url, destinationKey: task.destinationKey, profileId: task.profileId, submittedAt: task.attemptBoundary,
        evidence: task.receipt.evidence, evidenceUrl: task.receipt.url, publicationStatus: task.receipt.publicationStatus === 'pending_moderation' ? 'pending_moderation' : 'submitted' }));
      Object.assign(record, { taskId: task.id, runId: task.runId, actualSubmission: task.actualSubmission, reviewStatus: task.reviewStatus, artifactRef: task.artifactRef || '', executor: 'windows-playwright' });
      try{await this.cloud.request('receipt', { taskId: task.id, version: task.version, record });}
      catch(error){
        if(error.status!==409)throw error;
        const conflictSnapshot=await this.cloud.request('snapshot');
        const conflictRead=conflictSnapshot.documents.submissionRecords?.[queue.submissionRecordKey(task.destinationKey,task.profileId)];
        if(conflictRead?.taskId===task.id&&conflictRead.evidence===record.evidence&&isDeepStrictEqual(conflictRead.actualSubmission,record.actualSubmission)){
          this.update(task,{cloudVerified:true,cloudRevision:conflictSnapshot.revisions.submissionRecords},'cloud_readback');continue;
        }
        this.update(task,{syncConflict:true,syncConflictAt:new Date().toISOString(),syncConflictReason:'云端回执键已被其他记录占用；保留本地收件待人工核验'},'receipt_sync_conflict');continue;
      }
      const after = await this.cloud.request('snapshot');
      const read = after.documents.submissionRecords?.[queue.submissionRecordKey(task.destinationKey, task.profileId)];
      if (!read || read.taskId !== task.id || read.evidence !== record.evidence || !isDeepStrictEqual(read.actualSubmission, record.actualSubmission)) throw new Error('云端回执回读不一致');
      this.update(task, { cloudVerified: true, cloudRevision: after.revisions.submissionRecords }, 'cloud_readback');
    }
    let notificationDocuments;
    for(const task of this.store.values('task:'))if(!this.activeTaskIds?.has(task.id)&&task.cloudVerified&&task.receipt&&['pending','sending'].includes(task.indexNowNotification?.status)){
      if(task.indexNowNotification.status==='pending'&&!notificationDocuments)notificationDocuments=(await this.cloud.request('snapshot')).documents;
      await notifyIndexNow(this,task,notificationDocuments);
    }
    await this.cloud.flush(this.store);
    // An empty outbox performs no authenticated request and cannot prove recovery.
    if (this.cloudError !== this.lastCloudNetworkFailure) this.cloudError = '';
    return this.status();
  }
  async reconcileOfflineRuns(){
    const mode=this.store.get('offlineMode'),plan=this.store.get('libraryPlan');if(!mode?.syncStartedAt||!plan)return;
    const snapshot=await this.cloud.request('snapshot');
    if(snapshot.revisions.siteProfiles!==plan.profileRevision||snapshot.documents.siteProfiles?.[plan.profileId]?.fields?.Url!=='https://jevplay.com')throw new Error('离线期间资料修订已变化；待同步任务保持本地隔离');
    for(const localRun of this.store.values('run:').filter(r=>r.libraryPlanId===plan.id&&r.offlineSnapshotAt)){
      const remote=await this.cloud.request(`runs?runId=${encodeURIComponent(localRun.id)}`);
      if(remote.runs.some(r=>r.id===localRun.id))continue;
      const localTasks=localRun.tasks.map(t=>typeof t==='string'?this.store.get(`task:${t}`):this.store.get(`task:${t.id}`)).filter(Boolean);
      const safe=[];
      for(const task of localTasks){
        if(priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url)){
          this.update(task,{syncConflict:true,syncConflictAt:new Date().toISOString(),syncConflictReason:'离线后云端已出现同产品成功记录；保留收件和事件，不重投'},'offline_sync_conflict');
        }else safe.push(task);
      }
      if(!safe.length)continue;
      const run={...localRun,tasks:safe.map(t=>({id:t.id,url:t.url,destinationKey:t.destinationKey,profileId:t.profileId}))};
      const saved=await this.cloud.request('runs',{run});
      const check=await this.cloud.request(`runs?runId=${encodeURIComponent(localRun.id)}`);
      if(!check.runs.some(r=>r.id===localRun.id)||safe.some(t=>!check.tasks.some(x=>x.id===t.id&&x.url===t.url&&x.destinationKey===t.destinationKey)))throw new Error('离线批次注册后的独立云端回读不一致');
      this.store.set(`run:${localRun.id}`,{...localRun,remoteRegisteredAt:new Date().toISOString(),remoteProfileRevision:snapshot.revisions.siteProfiles,remoteTaskIds:safe.map(t=>t.id),profile:saved.run?.profile||localRun.profile});
    }
  }
  async resumeOffline(input={}) {
    if(this.job||this.store.get('paused')!==true)throw new Error('离线续跑需要执行器暂停且空闲');
    const plan=this.store.get('libraryPlan'),preview=this.store.get('preview');
    const mode=this.store.get('offlineMode');
    const frozenScope=plan&&createHash('sha256').update(JSON.stringify({pending:plan.initialPending,candidates:plan.candidates})).digest('hex');
    const sameIdentity=hasJevPlayIdentity(preview?.profile)&&preview.profileId===plan?.profileId&&plan?.profileId==='JevPlay';
    const sameRevision=preview?.profileRevision===plan?.profileRevision&&(!mode?.profileRevision||mode.profileRevision===plan?.profileRevision);
    const sameScope=!!plan?.scopeHash&&frozenScope===plan.scopeHash&&(!mode?.scopeHash||mode.scopeHash===plan.scopeHash)&&preview?.tasks?.length===plan?.candidates?.length;
    const initialEventsPresent=!mode?.initialOutboxIds||mode.initialOutboxIds.every(id=>this.store.pending().some(event=>event.id===id));
    if(plan?.id!=='fc7a2ae1-d2cf-4684-90cf-170ce81ca012'||plan.status!=='active'||!sameIdentity||!sameRevision||!sameScope||
      preview.total!==2915||preview.tasks?.length!==2603||!initialEventsPresent)
      throw new Error('离线续跑身份、资料修订、冻结范围或原始事件回读不一致，保持暂停并隔离');
    const quotaReason=String(plan.globalPause?.reason||this.cloudError||'');
    const existing=mode;
    if(!existing?.enabled&&!/quota|额度|exceeded/i.test(quotaReason))throw new Error('当前没有已记录的 Neon 额度阻断，拒绝切换离线模式');
    const offlineMode=existing?.enabled?existing:{enabled:true,authorizedAt:new Date().toISOString(),authorization:'user-explicit-2026-09-29',reason:quotaReason,
      candidateSnapshotAt:new Date(preview.at).toISOString(),completeCloudSnapshotAt:'2026-09-28T13:32:32.782Z',submissionRecordsRevision:150,ledgerVerifiedAt:'2026-09-28T13:35:06.457Z',
      profileRevision:preview.profileRevision,sourceTotal:preview.total,candidateCount:preview.tasks.length,scopeHash:plan.scopeHash,
      localTaskCount:this.store.values('task:').filter(t=>t.profileId==='JevPlay').length,initialOutboxIds:this.store.pending().map(e=>e.id)};
    const priorPause=plan.globalPause||{};
    const staleBrowserPause=/browserContext\.newCDPSession|no object with guid/i.test(String(priorPause.reason||''))?
      {...priorPause,previousAttentionType:priorPause.attentionType,attentionType:'browser_connection',resumeEligible:false,reclassifiedAt:new Date().toISOString()}:priorPause;
    this.store.set('offlineMode',offlineMode);
    this.store.set('libraryPlan',{...plan,offlineSnapshotAt:offlineMode.candidateSnapshotAt,
      offlineResumeValidation:{at:new Date().toISOString(),profileId:preview.profileId,profileName:preview.profile.name,profileUrl:preview.profile.url,
        nameField:preview.profile.fields.Name,urlField:preview.profile.fields.Url,profileRevision:preview.profileRevision,scopeHash:plan.scopeHash,
        initialOutboxIdsPresent:initialEventsPresent,priorPauseReason:plan.globalPause?.reason||'',
        priorPauseAttentionType:plan.globalPause?.attentionType||'',reclassifiedAsBrowserFailure:staleBrowserPause!==priorPause},
      globalPause:{...staleBrowserPause,offlineMode:true,resumeEligible:false}});
    this.hydrated=true;this.store.set('paused',false);this.tick();return this.status();
  }
  async restoreCloud() {
    if (this.hydrated || this.hydrating || !this.store.get('pair')) return;
    this.hydrating = true;
    try {
      const scope=workbenchScope(this.store.get('pair')),assertScope=()=>{if(scope!==workbenchScope(this.store.get('pair')))throw Error('工作区已切换，原云端恢复结果已放弃');};
      if(this.cloud.config?.storageBackend==='d1'){
        const index=await this.cloud.request('runs?view=inventory');
        assertScope();
        if(index.runs.every(run=>this.store.get(`run:${run.id}`)&&(!run.workbenchBatchId||this.store.get('workbenchBatch:'+run.workbenchBatchId)))&&index.tasks.every(task=>this.store.get(`task:${task.id}`)&&(!task.workbenchBatchId||this.store.get('workbenchBatch:'+task.workbenchBatchId))&&(!task.workbenchBatchCheckpointRevision||task.workbenchBatchCheckpointRevision<=(this.store.get('workbenchBatch:'+task.workbenchBatchId)?.cloudCheckpointRevision||0)))){recoverBatchTasks(this);this.store.recover();this.hydrated=true;return;}
      }
      const saved = await this.cloud.request('runs');
      assertScope();
      // The original Neon envelope only lists its latest 30 runs. Keep every
      // original task association by reading missing runs by their exact IDs.
      const missingRunIds=[...new Set(saved.tasks.map(task=>task.runId).filter(id=>id&&!saved.runs.some(run=>run.id===id)&&!this.store.get('run:'+id)))];
      for(const id of missingRunIds){const page=await this.cloud.request('runs?runId='+encodeURIComponent(id));assertScope();for(const run of page.runs)if(!saved.runs.some(r=>r.id===run.id))saved.runs.push(run);}
      for(const task of saved.tasks){const run=saved.runs.find(r=>r.id===task.runId)||this.store.get('run:'+task.runId);if(run?.workbenchBatchId&&!task.workbenchBatchId)task.workbenchBatchId=run.workbenchBatchId;}
      const batches=recoverCloudBatchRecords(this,saved.runs,saved.tasks);
      const pendingTaskIds=new Set((this.store.pendingSummary?.()||this.store.pending()).map(event=>event.taskId)),restoredTasks=[];
      for(const remote of saved.tasks){const local=this.store.get('task:'+remote.id);if(!local){restoredTasks.push(remote);continue;}if(remote.workbenchBatchId&&!pendingTaskIds.has(remote.id)&&(remote.workbenchBatchCheckpoint?.cloudCheckpointRevision||0)>(local.workbenchBatchCheckpoint?.cloudCheckpointRevision||0)){if(['runId','profileId','url','destinationKey'].some(key=>local[key]!==remote[key]))throw Error('云端原任务身份与本机记录冲突');if(local.attemptBoundary&&!remote.attemptBoundary||local.receipt&&!remote.receipt)throw Error('云端恢复不能清除本机原提交边界或回执');restoredTasks.push(remote);}}
      this.store.db.exec('BEGIN IMMEDIATE');
      try {
        for (const run of saved.runs) if (!this.store.get(`run:${run.id}`)) this.store.set(`run:${run.id}`, run);
        for (const task of restoredTasks) this.store.set(`task:${task.id}`, task);
        for(const batch of batches)this.store.set('workbenchBatch:'+batch.id,batch);
        if(batches.length){this.store.set('paused',true);this.store.set('singleTaskId',null);if(!this.store.get('activeWorkbenchBatch'))this.store.set('activeWorkbenchBatch',batches.slice().sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)))[0].id);}
        this.store.db.exec('COMMIT');
      }catch(error){this.store.db.exec('ROLLBACK');throw error;}
      for(const task of saved.tasks){const local=this.store.get('task:'+task.id);if(local)parkRestoredBatchTask(this,local);}
      recoverBatchTasks(this);
      this.store.recover(); this.hydrated = true;
    } finally { this.hydrating = false; }
  }
  tick() {
    // API operations own the single writer until their readbacks finish.
    // A paused timer must not flush their in-flight events concurrently.
    if (this.controlBusy||this.connectionBusy||this.cloudPullOperation||this.cloudPushOperation||this.localRecoveryOperation||this.fillLearningFlush) return;
    if(Date.now()<(this.syncRetryAt||0)){if(this.job)watchBatchDeadline(this);return;}
    if(this.store.get('connectionExecutionHold')&&this.store.get('paused')===false)this.store.set('connectionExecutionHold',null);
    watchBatchDeadline(this);
    const startupGate=this.store.get('libraryPlan')?.globalPause;
    if(this.store.get('paused')===true&&(startupGate?.attentionType==='cloud_quota'||/Your account or project has exceeded the quota/i.test(startupGate?.reason||''))&&!this.store.get('offlineMode')?.enabled){this.cloudError=startupGate.reason;return;}
    if (!this.hydrated) { this.restoreCloud().catch(error => { this.cloudError = error.message;this.syncFailures=(this.syncFailures||0)+1;this.syncRetryAt=Date.now()+Math.min(300000,30000*2**Math.min(this.syncFailures-1,4)); }); return; }
    if (this.job || !this.store.get('pair')) return;
    const needsCloudRecovery = this.lastCloudNetworkFailure && this.cloudError === this.lastCloudNetworkFailure;
    if (!(this.store.pendingCount?.()??this.store.pending().length) && !pendingWorkbench(this).length && !pendingApplication(this).length && !pendingMediaUploads(this).length && this.store.get('libraryPlan')?.status!=='active' && !this.store.values('task:').some(t => t.status === 'pending' || (t.screenshot&&!t.artifactRef) || (t.receipt && !t.cloudVerified&&!t.syncConflict)) && !needsCloudRecovery && !this.store.get('activeWorkbenchBatch')) return;
    if (this.store.get('paused') !== false) {
      const plan=this.store.get('libraryPlan'),gate=plan?.globalPause;
      if(gate?.attentionType==='cloud_quota'||/Your account or project has exceeded the quota/i.test(gate?.reason||''))return;
      if(!this.store.get('connectionExecutionHold')&&!this.store.get('executionStopped')&&!this.store.get('acceptanceBatch')&&plan?.status==='active'&&gate?.resumeEligible&&Date.now()>=(gate.nextProbeAt||0)){
        this.job=this.recoverContinuousConnection().catch(error=>{
          this.cloudError=error.message;const attempts=(gate.probes||0)+1;
          this.store.set('libraryPlan',{...this.store.get('libraryPlan'),globalPause:{...gate,probes:attempts,reason:error.message,
            resumeEligible:!error.cloudQuota&&(error.cloudNetwork||error.status>=500),attentionType:error.cloudQuota?'cloud_quota':gate.attentionType,nextProbeAt:Date.now()+Math.min(300000,60000*attempts)}});
        }).finally(()=>{this.job=null;});return;
      }
      if (!(this.store.pendingCount?.()??this.store.pending().length) && !pendingWorkbench(this).length && !pendingApplication(this).length && !pendingMediaUploads(this).length && !this.store.values('task:').some(t => (t.screenshot&&!t.artifactRef)||(t.receipt && !t.cloudVerified&&!t.syncConflict))) {
        if (needsCloudRecovery) {
          this.job = this.cloud.request('workspace/journal-documents').then(() => { this.syncFailures=0;this.syncRetryAt=0; })
            .catch(error => { this.cloudError=error.message;this.syncFailures=(this.syncFailures||0)+1;this.syncRetryAt=Date.now()+Math.min(300000,30000*2**Math.min(this.syncFailures-1,4)); })
            .finally(() => { this.job=null; });
        }
        return;
      }
      this.job = this.synchronize().then(result=>{this.syncFailures=0;this.syncRetryAt=0;return result;}).catch(error => { this.cloudError = error.message;
        this.syncFailures=(this.syncFailures||0)+1;this.syncRetryAt=Date.now()+Math.min(300000,30000*2**Math.min(this.syncFailures-1,4));
        if(error.cloudQuota&&plan)this.store.set('libraryPlan',{...plan,globalPause:{at:new Date().toISOString(),reason:error.message,attentionType:'cloud_quota',resumeEligible:false}});
      }).finally(() => { this.job = null; }); return;
    }
    const batchId=this.store.get('activeWorkbenchBatch'),parallelBatch=batchId&&!this.store.get('singleTaskId')&&this.store.get('workbenchBatch:'+batchId)?.config;
    this.job = (parallelBatch?runWorkbenchBatch(this):this.work()).catch(error => { this.cloudError = error.message;this.store.set('paused',true);
      pauseWorkbenchBatch(this,error.message);const batch=this.store.get('acceptanceBatch');if(batch?.status==='running')this.store.set('acceptanceBatch',{...batch,status:'paused',reason:error.message});
      const plan=this.store.get('libraryPlan'),classification=classifyPauseFailure(error);if(!batch&&plan?.status==='active')this.store.set('libraryPlan',{...plan,globalPause:{at:new Date().toISOString(),reason:error.message,
        ...classification,nextProbeAt:classification.resumeEligible?Date.now()+60000:null}});
    }).finally(() => {
      if (this.store.get('singleTaskId')) { if(!finishWorkbenchTask(this,this.store.get('singleTaskId'))&&!finishAcceptanceTask(this,this.store.get('singleTaskId')))this.store.set('paused', true);this.store.set('singleTaskId', null); }
      this.job = null;
    });
  }
  async work({taskId:assignedTaskId}={}) {
    await this.synchronize();
    if (!this.context) await this.connect();
    if(this.store.get('paused')===false)for(const prior of this.store.values('task:').filter(task=>task.status==='skip'&&task.originalAgentSkip&&task.originalGroupAdvance?.status==='awaiting_next'&&!task.tabClosedAt&&!this.activeTaskIds?.has(task.id)&&this.activeTaskId!==task.id)){const scope=workbenchScope(this.store.get('pair'));try{await closeAcceptanceTask(this,prior);}catch(error){if(!error.staleTask&&scope===workbenchScope(this.store.get('pair'))&&isDeepStrictEqual(this.store.get('task:'+prior.id),prior))this.update(prior,{cleanupFailure:{at:new Date().toISOString(),reason:error.message,targetId:prior.targetId}},'original_group_cleanup_deferred');}}
    const workbenchId=this.store.get('activeWorkbenchBatch');
    if(!assignedTaskId&&workbenchId&&!this.store.get('singleTaskId')){const selected=await nextWorkbenchTask(this);if(!selected)return;}
    const fixedBatch=this.store.get('acceptanceBatch');
    if(!assignedTaskId&&fixedBatch?.status==='running'&&!this.store.get('singleTaskId')){const selected=await nextAcceptanceTask(this);if(!selected)return;}
    const currentPlan=this.store.get('libraryPlan');
    const singleTaskId = assignedTaskId||this.store.get('singleTaskId');
    if(!singleTaskId&&currentPlan?.status==='active'){
      for(const old of this.store.values('task:').filter(t=>t.libraryPlanId===currentPlan.id&&!t.tabClosedAt&&
        (t.artifactRef||this.store.get('offlineMode')?.enabled&&(t.screenshot||t.status==='needs_manual'&&t.attentionType==='site_unavailable'&&!t.attemptBoundary&&
          !t.receipt&&/(?:timeout|timed out|ERR_|net::|连接|超时)/i.test(t.reason||'')))&&
        (t.status==='finished'||t.status==='needs_manual'&&!t.attemptBoundary&&!['human_verification','login','unknown_receipt'].includes(t.attentionType)))){
        await this.finalizePriorContinuousTask(old);
      }
    }
    const manualResumeRunId=this.store.get('manualResumeRunId');
    const eligiblePending=t=>t.status==='pending'&&(singleTaskId?t.id===singleTaskId:!t.workbenchBatchId&&(manualResumeRunId?t.runId===manualResumeRunId:!currentPlan||currentPlan.status!=='active'||t.profileId===currentPlan.profileId));
    if(!singleTaskId&&manualResumeRunId&&!this.store.values('task:').some(eligiblePending)){this.store.set('paused',true);this.store.set('manualResumeRunId',null);return;}
    if(!singleTaskId&&!this.store.values('task:').some(eligiblePending))await this.queueLibraryBatch();
    const task = this.store.values('task:').find(t => eligiblePending(t) && (!singleTaskId || t.id === singleTaskId));
    if (!task || this.store.get('paused') !== false) return;
    if(task.workbenchBatchRecoveryVersion===1)await flushBatchTaskEvents(this,task);
    const offline=!task.acceptanceId&&!!this.store.get('offlineMode')?.enabled;
    let snapshot=null;
    if(!offline){snapshot=await this.cloud.request('snapshot');if (priorProductSuccess(snapshot.documents.submissionRecords, task.profileId, task.url)) {this.update(task, { status: 'excluded', reason: '最新云端已有该产品提交，未打开投稿' }, 'dedup'); return;}}
    await this.lease(task);
    const continuousPlan=this.store.get('libraryPlan');
    let run=findUnambiguousOfflineRun(this.store,task);
    if(!run)throw new Error('原任务没有唯一匹配的持久批次，停止执行');
    if(!task.runId)this.update(task,{runId:run.id},'offline_run_link_recovered');
    const continuous=!singleTaskId&&!task.acceptanceId&&continuousPlan?.status==='active'&&continuousPlan.profileId===task.profileId;
    if(continuous){
      const current=offline?(this.store.get('preview')?.profile||task.profileSnapshot):snapshot.documents.siteProfiles?.[task.profileId];
      if(current?.fields?.Url!=='https://jevplay.com')throw new Error('全库产品资料身份发生变化，停止执行');
      this.update(task,{profileSnapshot:current,profileRevision:offline?continuousPlan.profileRevision:snapshot.revisions.siteProfiles,libraryPlanId:continuousPlan.id,
        consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'ordinary_submission_permissions',source:'user_reply',text:'用户授权全库连续免费投稿及普通注册；验证码等标记后继续下一站'}]},'continuous_scope');
    }
    const profile = task.profileSnapshot || run.profile;
    if(!task.profileSnapshot&&profile)this.update(task,{profileSnapshot:plain(profile),profileRevision:task.profileRevision??run.profileRevision},'task_profile_frozen');
    const defaults=snapshot?.documents||this.store.get('applicationSnapshot')?.snapshot?.documents||{};
    const frozenBatch=task.workbenchBatchId&&this.store.get('workbenchBatch:'+task.workbenchBatchId);
    this.update(task,{indexNotificationPreference:frozenBatch?.config?frozenBatch.config.pingIndex!==false:defaults.cfgPingIndex!==false},'index_notification_preference');
    const config = applySubmissionPreferences(this,task,defaults,applyDestinationFormKnowledge(defaults,plain(profiles.buildAgentConfigFromProfile(profile,{email:defaults.cfgEmail,username:defaults.cfgName,commentTemplate:defaults.cfgCommentTemplate})),task.url));
    config.ordinaryTermsAuthorized = task.consentHistory?.some(c=>c.scope==='ordinary_submission_permissions'&&['user_reply','approved_plan','workbench_manual_continue'].includes(c.source)) === true;
    // Hosted forms need the actual directory source when classifying their
    // final receipt. The product website URL is not the submission source.
    config.sidepanelContext = { ...config.sidepanelContext, url: task.url };
    const active = () => this.store.get('paused') === false && this.store.get(`task:${task.id}`).controller !== 'supervisor' && batchActionAllowed(this,task);
    if(!active()){finalizeBatchDeadline(this,task);return;}
    if(!assignedTaskId)this.activeTaskId=task.id;
    let page, engines = [], responseListener, staleWork=false;
    const requirePrepared=result=>{if(result.ok)return;throw Object.assign(Error(result.reason||'原AI接管未完成，请检查原任务'),{staleTask:result.staleTask===true,preparationInterrupted:result.interrupted===true,cloudNetwork:result.cloudNetwork,status:result.status,preparationResult:result});};
    const responseTasks = [], submissionResponses = [];
    try {
      await attachOriginalGroupPage(this,task);if(task.status==='needs_manual')return;
      await assertParkedResumePage(this,task);
      this.update(task, { status: 'opening', controller: 'executor' }, 'opening');
      let reused = false;
      if (task.targetId) {
        try { page = await this.findPage(task); reused = true; } catch (error) {
          if (task.attemptBoundary||task.originalGroupPage) throw Object.assign(error,{staleTask:true});
        }
      }
      if (!page) {
        if(continuous){
          const ownedTargets=await liveOwnedTaskTargetIds(this,continuousPlan.id,this.host.startedAt);
          const cap=Math.min(6,Math.max(1,Number(continuousPlan.maxTaskTabCount)||6));
          if(ownedTargets.size>=cap){
            const at=new Date().toISOString();this.store.set('libraryPlan',{...continuousPlan,
              tabCapacityPause:{at,cap,ownedOpenTargets:ownedTargets.size,reason:'达到执行器任务页签上限；停止新开页面，先关闭已登记的终端任务页'},
              globalPause:{at,reason:'执行器任务页签达到上限，等待安全清理后继续',attentionType:'tab_capacity',resumeEligible:false}});
            this.store.set('paused',true);return;
          }
        }
        page = await this.context.newPage();
      }
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      const targetInfo=await getTargetInfo(this.context,page);
      if(!targetInfo)throw new Error('browser page target disappeared before its task identity could be verified');
      const target = targetInfo.targetId;
      this.update(task, { targetId: target, browserInstance: this.host.startedAt }, 'target');
      if(!active())return;
      Object.assign(config,applySubmissionPreferences(this,task,defaults,config));
      if (!reused) await page.goto(task.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      else if(task.originalGroupPage&&await navigateOriginalGroupPage(this,task,page,{active})===false)return;
      // Hydrated forms can appear after DOMContentLoaded. Wait on visible
      // controls/frames, rather than treating the initial HTML as a dead end.
      await page.locator('input:visible, textarea:visible, select:visible, iframe:visible, [contenteditable=true]:visible, a[href]:visible, button:visible').first().waitFor({ timeout: 15000 }).catch(() => {});
      if(continuous)await page.waitForTimeout(1500);
      if(!active())return;
      await this.preparePublicPage(page,task,{active});
      if(!active())return;
      await this.prepareKnownPage(page, task.url, task);
      if (!active()) { this.update(task, { status: 'pending' }, 'paused_before_fill'); return; }
      this.update(task, { status: 'filling' }, 'filling');
      if(isProductHuntLaunch(task.url)){
        if(!task.profileSnapshot)this.update(task,{profileSnapshot:plain(profile),profileRevision:task.profileRevision??run.profileRevision},'producthunt_profile_frozen');
        await runProductHuntWorkflow(this,task,page,config,{active,offline,confirmCreate:task.productHuntCreationConsent?.targetId===task.targetId&&!task.fillOnlyRun});
        return;
      }
      for (const frame of page.frames()) {
        if(!active())return;
        if(!/^https?:/.test(frame.url()))continue;
        try {
          const engine = await attachEngine(this.context, frame, msg => this.bridge(task, msg));
          const detection = await engine.call({ action: 'detectPage', config });
          engines.push({ engine, frame, detection });
        } catch (error) { task.frameError = error.message; }
      }
      let candidate = engines.filter(e => e.detection.operable).sort((a, b) => b.detection.formFieldCount - a.detection.formFieldCount)[0];
      if(!active())return;
      if (!candidate && /^https:\/\/toolscout\.ai\/submit\/?$/i.test(task.url) &&
          task.stageHistory?.some(s => s.stage === 1) &&
          await page.getByRole('button', { name: 'Submit for review', exact: true }).isEnabled().catch(() => false)) {
        candidate = engines.find(e => e.frame === page.mainFrame());
        if (candidate) candidate.detection = { ...candidate.detection, platform: 'submission', operable: true };
      }
      if (!candidate && !task.attemptBoundary && (!task.fillOnlyRun||task.workbenchBatchId&&frozenBatch?.config?.fillOnly)) {
        for(const item of engines)await item.engine.detach();engines=[];
        const takeover=await this.prepareWithAi(page,task,config,active);
        candidate=takeover.candidate;if(candidate)engines.push(candidate);
        requirePrepared(takeover);
      }
      if (!candidate) throw new Error('没有可识别表单，后台 AI 已尝试原页并记录结果');
      let { engine, detection } = candidate;
      const preparingOnly = task.fillOnlyRun && /^(?:poweredbyai\.app|navtools\.ai|aioftheday\.com)$/.test(new URL(task.url).hostname);
      const observeSiteGate=result=>classifyOriginalTaskGate(this,{task,page,result,active,assertPageDocument:async()=>{if(!await candidate.engine.isCurrentDocument())throw Error('原表单文档已变化，自动观察停止');}});
      if (!detection.hasCaptcha && !preparingOnly && (detection.submitBlocker?.blocked || detection.submitBlocker?.needs_manual || detection.submitBlocker?.payment_uncertain)) {await observeSiteGate(detection.submitBlocker);throw new Error(detection.submitBlocker?.reason || '需要人工处理');}
      if (detection.platform==='article') throw new Error('普通文章评论需要逐页审核相关性，进入待人工');
      const forceRefreshExisting = !!task.preparationHistory?.length || !!task.attemptHistory?.length || !!task.stageHistory?.length ||
        /^https:\/\/(?:www\.)?futuretools\.io\/submit-a-tool\/?/i.test(task.url);
      const preparationConfig={...config,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false,forceRefreshExisting};
      if(!active())return;
      let fill = task.submitPreparedRun ? {ok:true,preparedForm:true,filledCount:0} : await engine.call(detection.platform==='wp_comment'?{action:'executeSubmit',platformType:'wp_comment',config:preparationConfig}:{action:'smartFill',config:preparationConfig});
      if(!active())return;
      if(!task.submitPreparedRun) {
        await this.reconcileTextInputs(candidate.frame, await engine.call({ action: 'getFilledFieldsReport' }), fill.mappings);
        try{await this.completeKnownForm(candidate.frame, task.url, profile, task);}
        catch(error){this.update(task,{normalPreparationFailure:{at:new Date().toISOString(),reason:error.message}},'normal_preparation_failed');fill={...fill,ok:false,reason:error.message};}
      }
      let validation = await engine.call({ action: 'collectFormValidation' });
      if(!active())return;
      const initialAction=await engine.call({action:'inspectSubmitAction',config,platform:detection.platform||'directory'});
      if ((validation.validationFailed || fill.ok===false || fill.needs_manual || initialAction.advanceFound&&!initialAction.finalFound) && active() && !task.submitPreparedRun && (!task.fillOnlyRun||task.workbenchBatchId&&frozenBatch?.config?.fillOnly) && !detection.hasCaptcha) {
        for(const item of engines)await item.engine.detach();engines=[];
        const takeover=await this.prepareWithAi(page,task,config,active,{normalFillDone:true});
        if(takeover.candidate)engines.push(takeover.candidate);
        requirePrepared(takeover);
        if(takeover.candidate){candidate=takeover.candidate;engine=candidate.engine;detection=candidate.detection;validation=await engine.call({action:'collectFormValidation'});fill={...fill,ok:true,needs_manual:false,aiPrepared:true};}
      }
      if (validation.validationFailed && active() && !task.submitPreparedRun && !task.aiTakeover) {
        const snapshot = await engine.call({ action: 'getPageSnapshot' });
        const plan = offline?null:await this.batchModelRequest(task,'plan', { taskId: task.id, task: { url: task.url, profileId: task.profileId }, snapshot, config, fillOnly: true }).catch(() => null);
        if (plan?.status === 'act' && plan.actions?.length && active()) {
          // The existing Worker only emits fill/select/check/wait; never a submit.
          const actions = plan.actions.filter(a => ['fill','select','check','wait'].includes(a.type));
          await engine.call({ action: 'executeActionPlan', actions });
          await this.reconcileTextInputs(candidate.frame, await engine.call({ action: 'getFilledFieldsReport' }), fill.mappings);
          await this.completeKnownForm(candidate.frame, task.url, profile, task);
          validation = await engine.call({ action: 'collectFormValidation' });
        }
      }
      const actualSubmission = await engine.call({ action: 'getFilledFieldsReport' });
      await engine.call({action:'persistFillLearnings',config});
      if (/^https:\/\/toolscout\.ai\/submit\/?$/i.test(task.url)) {
        const first = task.stageHistory?.find(s => s.stage === 1);
        if (first) actualSubmission.fields.push(...first.fields.filter(f=>['name','url','description'].includes(f.name)).map(f => ({ label: f.name === 'name' ? 'Tool Name' : f.name === 'url' ? 'Tool URL' : 'Short description',
          type: f.name === 'url' ? 'url' : 'text', value: f.value, issues: [] })));
      }
      actualSubmission.attachments = await candidate.frame.locator('input[type=file]').evaluateAll(async inputs => {
        const attachments=[];
        for(const input of inputs) for(const file of [...(input.files || [])]) {
          const hash=globalThis.crypto?.subtle ? [...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('') : '';
          attachments.push({ field:input.name || input.id, name:file.name, type:file.type, bytes:file.size, sha256:hash });
        }
        return attachments;
      });
      const qualityIssues = assessSubmissionQuality(actualSubmission, profile);
      qualityIssues.push(...await this.knownFormIssues(candidate.frame, task.url,profile));
      if (qualityIssues.length) {
        validation = { ...validation, validationFailed: true, allValid: false,
          issues: [...new Set([...(validation.issues || []), ...qualityIssues])] };
      }
      this.update(task, { actualSubmission, fill, validation }, 'filled_snapshot');
      if(!active())return;
      if(/^https:\/\/(?:www\.)?futuretools\.io\/submit-a-tool\/?$/.test(task.url)&&task.attemptHistory?.some(a=>a.kind==='verified_captcha_rejection')&&
       !await page.evaluate(()=>[...document.querySelectorAll('[name="cf-turnstile-response"]')].some(e=>Boolean(e.value?.trim())))){
        this.update(task,{attentionType:'human_verification'},'recovered_captcha_gate');
        throw new Error('FutureTools 明确真人拒绝的原任务已恢复，最新资料与免费分类填写完成；尚无完成的真人验证响应，保留当前原页，不点击投稿');
      }
      if(navToolsAdapter.matches(task.url)){const gate=await navToolsAdapter.gate(page,this.context);if(gate){this.update(task,{attentionType:gate.attentionType,adapterKey:navToolsAdapter.key},'adapter_human_gate');throw new Error(gate.reason);}}
      if(task.fillOnlyRun&&!detection.hasCaptcha){
        const complete=!validation.validationFailed&&fill.ok!==false&&!fill.needs_manual;
        this.update(task,{fillOnlyPrepared:complete,attentionType:complete?'fill_only':'missing_fields'},'batch_fill_only_prepared');
        if(!complete){await observeSiteGate(fill.agentResult||fill);throw Error(fill.reason||'仅填写已停止，必填资料或素材仍需核对，未点击提交');}
      }
      if(detection.hasCaptcha){await observeSiteGate({captcha:true});armCaptchaResume(this,task,{pageUrl:page.url(),frameUrl:candidate.frame.url(),documentId:candidate.engine.documentId});}
      if (detection.hasCaptcha || task.fillOnlyRun) throw new Error(detection.hasCaptcha ? '资料已准备，验证码待用户完成；未点击提交' : '仅填写资料已完成，未点击提交');
      if (validation.validationFailed || fill.ok === false || fill.needs_manual) {await observeSiteGate(fill.agentResult||fill);throw new Error(fill.reason || '必填项或素材需要补充，请接管核对');}
      if (!active()) { this.update(task, { status: 'pending' }, 'paused_before_submit'); return; }
      const submitAction = await engine.call({action:'inspectSubmitAction',config,platform:detection.platform||'directory'});
      this.update(task,{submitAction},'submit_action_preflight');
      if(submitAction.allowed===false)throw new Error(detection.platform==='wp_comment'?'评论已填写；标准 WordPress 评论自动提交未开启或表单未通过标准预检，请人工核对':'资料已填写；目录站自动提交未开启或当前页面仅允许填写，请人工核对');
      if(!submitAction.finalFound)throw new Error(submitAction.advanceFound?'当前只有前进动作，后台接管未完成下一步；未建立投稿边界':'未找到可用最终投稿按钮；未建立投稿边界');
      // Revalidate ownership and cloud dedup immediately before the mutation.
      await this.lease(task);
      if(!active())return;
      Object.assign(config,applySubmissionPreferences(this,task,defaults,config));
      const currentAction=await engine.call({action:'inspectSubmitAction',config,platform:detection.platform||'directory'});
      if(currentAction.allowed===false||!currentAction.finalFound)throw new Error('原提交授权或最终按钮已变化，请重新检查原任务；未建立投稿边界');
      const baseline = await engine.call({ action: 'classifySubmitEvidence', destinationUrl: task.url });
      if(!active())return;
      this.update(task, { status: 'submitting', siteStatus: 'sent_unconfirmed', attemptBoundary: new Date().toISOString(), baselineEvidence: baseline.evidence || '' }, 'attempt_boundary');
      if(!offline)await this.cloud.flush(this.store); // Online mode confirms the boundary before click; offline mode records it durably first.
      if (!active()) { this.update(task, { status: 'submitted_unconfirmed', reason: '尝试已保留，暂停后先核验' }, 'paused_boundary'); return; }
      responseListener = response => {
        responseTasks.push((async () => {
          try {
            const request = response.request();
            if (request.method() !== 'POST' || !['xhr','fetch','document'].includes(request.resourceType())) return;
            const target = new URL(response.url());
            if (target.hostname !== new URL(task.url).hostname) return;
            const item = { url: `${target.origin}${target.pathname}`, status: response.status() };
            if (/json/i.test(response.headers()['content-type'] || '')) {
              const body = await response.json();
              if (body && typeof body === 'object' && !Array.isArray(body)) {
                item.signals = Object.fromEntries(['ok','success','submitted','accepted','id','toolId','listingId','status','message','error']
                  .filter(key => ['string','number','boolean'].includes(typeof body[key]))
                  .map(key => [key, String(body[key]).slice(0, 240)]));
              }
            }
            if (submissionResponses.length < 20) submissionResponses.push(item);
          } catch { /* A navigation can close the response stream. */ }
        })());
      };
      page.on('response', responseListener);
      let result;
      try { result = await engine.call({ action: 'submitFilledForm', config, platform: detection.platform || 'directory' }); }
      catch (error) { result = { error: error.message }; }
      page.off('response', responseListener); responseListener = null;
      await Promise.allSettled(responseTasks);
      result = result || {};
      result.networkResponses = submissionResponses;
      this.update(task, { networkResponses: submissionResponses }, 'network_evidence');
      if (/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/i.test(result.error || '')) {
        const observed = await this.reobserveNavigatedReceipt(page, task);
        if (observed.matched) result = { ...result, ...observed, recoveredAfterNavigation: true };
      }
      if(!result.matched&&originalLinkrenaPostSubmitLogin(task.url,page.url()))result={...result,needs_manual:true,reason:'站方在最终提交后跳转邮箱登录，未产生投稿回执；登录页要求同意条款'};
      await classifyOriginalTaskGate(this,{task,page,result,active});
      if (result?.matched && result.evidence && result.evidence !== task.baselineEvidence) await this.accept(task, page, result);
      else this.update(task, { status: 'submitted_unconfirmed', attentionType:'unknown_receipt',reason: result.reason || result.error || '未取得明确新回执，先核验；不会自动重投', submitResult: result }, 'unknown');
    } catch (error) {
      if(error.staleTask){staleWork=true;return;}
      if(error.originalTaskSyncFailure)throw error;
      if(error.preparationInterrupted)return;
      if(error.preparationResult?.originalAgentUnavailable&&task.status==='skip'&&task.attentionType==='agent_unavailable'&&!task.attemptBoundary&&!task.receipt)return;
      if([401,403,409].includes(error.status)||!error.preparationResult&&(error.cloudNetwork||error.status>=500))throw error;
      if(task.originalDestinationDisposition?.kind==='dead_end'&&['skip','err'].includes(task.status)&&task.attentionType==='destination_dead_end'&&!task.attemptBoundary&&!task.receipt)return;
      this.update(task, { status: task.attemptBoundary ? 'submitted_unconfirmed' : 'needs_manual', siteStatus:task.attemptBoundary?'sent_unconfirmed':'not_submitted', reason: error.message,
        attentionType:task.attemptBoundary?'unknown_receipt':task.attentionType||classifyBlocker(error.message) }, 'attention');
      if(page&&task.attentionType==='human_verification'&&!task.attemptBoundary&&!task.receipt)await armPageCaptchaResume(this,task,page,{active}).catch(observationError=>this.update(task,{captchaResumeObservationFailure:{at:new Date().toISOString(),reason:observationError.message}},'captcha_resume_observation_failed'));
    } finally {
      try{
        if (page && responseListener) page.off('response', responseListener);
        if(staleWork){for(const {engine}of engines)await withinDeadline(engine.detach(),3000,'表单引擎断开').catch(()=>{});return;}
        finalizeBatchDeadline(this,task);
        finalizeUserPause(this,task);
        for (const { engine } of engines) await withinDeadline(engine.detach(),3000,'表单引擎断开').catch(()=>{});
        if (page && !page.isClosed()) {
          const file = path.join(this.home, `${task.id}-${Date.now()}.png`);
          try{await capturePageEvidence(this.context,page,{path:file,timeoutMs:15000});task.screenshot=file;task.artifactRef='';this.store.set(`task:${task.id}`,task);}
          catch(error){this.update(task,{evidenceCaptureFailure:{at:new Date().toISOString(),reason:error.message,targetId:task.targetId,browserInstance:task.browserInstance}},'evidence_capture_deferred');}
        }
        await this.synchronize();
        if(task.acceptanceId||task.workbenchBatchId||task.originalAgentSkip&&task.status==='skip'||task.originalDestinationDisposition?.kind==='dead_end'&&['skip','err'].includes(task.status)){
          try{await closeAcceptanceTask(this,task);}
          catch(error){if(!error.staleTask)this.update(task,{cleanupFailure:{at:new Date().toISOString(),reason:error.message,targetId:task.targetId}},'fixed_task_cleanup_deferred');}
        }
        if(continuous){
          try{await withinDeadline(this.finalizeContinuousTask(task),15000,'单站页签收尾');}
          catch(error){this.update(task,{cleanupFailure:{at:new Date().toISOString(),reason:error.message,targetId:task.targetId,browserInstance:task.browserInstance}},'site_cleanup_deferred');}
          try{await withinDeadline(this.trimDeferredTabs(),15000,'待处理页签整理');}
          catch(error){this.update(task,{cleanupFailure:{at:new Date().toISOString(),reason:error.message,targetId:task.targetId,browserInstance:task.browserInstance}},'deferred_tabs_cleanup_deferred');}
        }
      }finally{if(!assignedTaskId)this.activeTaskId=null;}
    }
  }
  async prepareWithAi(page,task,config,active,{normalFillDone=false,readyCheck}={}) {
    let candidate;
    let normalDone=normalFillDone;
    const scope=workbenchScope(this.store.get('pair')),identity=Object.fromEntries(['id','runId','profileId','profileRevision','targetId','browserInstance'].map(key=>[key,task[key]])),profile=plain(task.profileSnapshot||{}),preparationConfig={...config,fillOnly:true,autoSubmitDirectory:false,autoSubmitStandardWpComments:false};
    const canRelease=current=>scope===workbenchScope(this.store.get('pair'))&&Object.entries(identity).every(([key,value])=>current[key]===value)&&current.version===task.version&&current.controllerId===task.controllerId&&!current.attemptBoundary&&!current.receipt&&isDeepStrictEqual(plain(current.profileSnapshot||{}),profile);
    const assertCurrent=async()=>{const check=()=>{const current=this.store.get('task:'+task.id);if(!current||!canRelease(current)||current.controller!==task.controller||this.store.get('executionStopped')||this.store.get('connectionExecutionHold')||page.isClosed()||!/^https?:\/\//.test(page.url()))throw Object.assign(Error('原AI接管任务、产品、控制权或网页已变化'),{staleTask:true});if(!active())throw Object.assign(Error('原AI接管已暂停，原任务与预算保留'),this.store.get('paused')===true?{batchPaused:true}:{staleTask:true});};check();const target=await getTargetInfo(this.context,page);check();if(target?.targetId!==identity.targetId)throw Object.assign(Error('原AI接管页签身份已变化'),{staleTask:true});};
    const assertDocument=async()=>{await assertCurrent();if(!candidate||candidate.frame.isDetached()||candidate.frame.url()!==candidate.url||!await candidate.engine.isCurrentDocument())throw Object.assign(Error('原AI接管文档已变化，请重新观察'),{staleTask:true});await assertCurrent();};
    const adapter=new AgentBrowserAdapter({endpoint:this.host.endpoint,targetId:task.targetId,taskId:task.id,browserInstance:this.host.startedAt,
      upload:async(kind,selector)=>{const file=await materializeTaskUpload(this,task,config,kind,candidate.engine,selector);if(!active())throw Error('原任务已暂停，未上传图片');return file;}});
    let bound=false;
    const observe=async()=>{
      await this.preparePublicPage(page,task,{active});
      await assertCurrent();
      if(!bound){await adapter.bind();bound=true;}
      await candidate?.engine.detach();candidate=null;
      const options=[];
      for(const frame of page.frames())if(/^https?:/.test(frame.url())){
        let engine;try{await assertCurrent();engine=await attachEngine(this.context,frame,msg=>this.bridge(task,msg));const detection=await engine.call({action:'detectPage',config:preparationConfig}),observed=await engine.call({action:'getPageSnapshot'});options.push({engine,frame,detection,url:frame.url(),observed});}catch(error){await engine?.detach();if(error.staleTask||error.batchPaused){for(const item of options)await item.engine.detach();throw error;}}
      }
      candidate=options.sort((a,b)=>(b.observed.fields?.length||Number(b.detection.formFieldCount)||0)-(a.observed.fields?.length||Number(a.detection.formFieldCount)||0))[0];
      for(const item of options)if(item!==candidate)await item.engine.detach();
      if(!candidate)throw Error('原任务页面没有可观察上下文');
      await assertDocument();
      if(!normalDone&&candidate.detection.operable){
        normalDone=true;
        const fill=await candidate.engine.call({action:'smartFill',config:{...config,fillOnly:true,autoSubmitDirectory:false}});
        await assertDocument();
        await this.reconcileTextInputs(candidate.frame,await candidate.engine.call({action:'getFilledFieldsReport'}),fill.mappings);
        await assertDocument();
        this.update(task,{normalPreparation:{at:new Date().toISOString(),fill}},'normal_preparation_completed');
      }
      const snapshot=await candidate.engine.call({action:'getPageSnapshot'});
      snapshot.preparation={validation:await candidate.engine.call({action:'collectFormValidation'}),
        submitAction:await candidate.engine.call({action:'inspectSubmitAction',config,platform:candidate.detection.platform||'directory'}),
        filled:await candidate.engine.call({action:'getFilledFieldsReport'})};
      if(candidate.frame===page.mainFrame())snapshot.agentBrowser=await adapter.snapshot();
      return snapshot;
    };
    const ready=async()=>{
      if(!candidate)return false;
      try{
        await assertDocument();
        if(readyCheck)return await readyCheck(candidate.engine);
        const validation=await candidate.engine.call({action:'collectFormValidation'});
        const action=await candidate.engine.call({action:'inspectSubmitAction',config,platform:candidate.detection.platform||'directory'});
        const actual=await candidate.engine.call({action:'getFilledFieldsReport'});
        return !validation.validationFailed&&action.finalFound&&candidate.detection.operable&&
          !assessSubmissionQuality(actual,task.profileSnapshot||{}).length;
      }catch(error){if(error.staleTask)throw error;return false;}
    };
    let lastVisual;
    const taskPayload=()=>({index:0,domain:queue.extractDomain(task.url),url:task.url,platformType:candidate?.detection.platform||'auto',projectKey:config.projectKey||task.profileId});
    const model=async(kind,input)=>{
      await assertDocument();await originalTaskSync(()=>flushBatchTaskEvents(this,task));await assertDocument();
      if(kind==='vision-plan'){
        const visual=await captureOriginalTaskVisual(this,{task,page,candidate,assertCurrent:assertDocument});await assertDocument();
        lastVisual=visual;const plan=await this.batchModelRequest(task,'ai/vision-plan',{task:taskPayload(),config:preparationConfig,...input,...visual,fillOnly:true});await assertDocument();
        return{...plan,actions:originalVisualFillActions(plan.actions,visual.elements)};
      }
      if(kind==='judge'){const judge=await this.batchModelRequest(task,'ai/judge',{task:taskPayload(),config:preparationConfig,...input});await assertDocument();return judge;}
      const plan=await this.batchModelRequest(task,'plan',{mode:'prepare_takeover',taskId:task.id,version:task.version,controllerId:task.controllerId,task:{url:task.url,profileId:task.profileId},config:preparationConfig,...input,fillOnly:true});await assertDocument();return{...plan,actions:restrictPreparationActions(plan.actions,input.snapshot)};
    };
    const act=async(action,{visual=false}={})=>{
        await assertDocument();await originalTaskSync(()=>this.lease(task,{online:true}));await assertDocument();
        const before=action.type==='click'?await readAfterNavigation(page,()=>page.evaluate(()=>location.href+'|'+(document.body?.innerText||''))):null;
        if(action.type==='click')await candidate.engine.call({action:'persistFillLearnings',config});
        let result;
        if(!visual&&candidate.frame===page.mainFrame()&&action.type!=='scroll')result=await adapter.act(action);
        // Embedded forms share the same registered task page. The normal
        // Playwright frame executor supplies the scope that CLI selectors lack.
        else if(action.type==='upload'){const file=await materializeTaskUpload(this,task,config,action.mediaKind,candidate.engine,action.selector);if(!active())throw Error('原任务已暂停，未上传图片');result=await candidate.frame.locator(action.selector).setInputFiles(file);}
        else result=await candidate.engine.call({action:'executeActionPlan',actions:[action]});
        if(action.type==='click')await settleObservedClick(page,before);
        return result;
    };
    const result=await runOriginalAgentPreparation(this,{task,io:{assertCurrent,canRelease,observe,ready,readyBeforeJudge:config.productHuntPrepared===true,model,act,
      settle:ms=>page.waitForTimeout(ms),
      recordPlan:async plan=>{await assertDocument();this.update(task,{agentVisualHistory:[...(task.agentVisualHistory||[]),{at:new Date().toISOString(),status:plan.status,stage:plan.stage||'',reason:plan.reason||'',actions:(plan.actions||[]).map(action=>({type:action.type,selector:action.selector})),...(lastVisual?{localScreenshot:lastVisual.localScreenshot,artifactRef:lastVisual.artifactRef,artifactError:lastVisual.artifactError}:{}),...(!plan.visualAgent?{visualFallbackReason:task.aiTakeover?.visualFallbackReason||''}:{}),visualAgent:plan.visualAgent===true}].slice(-8)},'original_agent_plan');},
      visualFallback:async(snapshot,failure,request,execute)=>{const decision=originalPlanDecision(await request('vision-plan',{snapshot,failure}),snapshot);if(decision.terminal)return decision.terminal;const results=[];for(const action of decision.plan.actions||[]){const outcome=await execute(action);results.push(...(outcome?.results||[{...outcome,type:action.type}]));if(action.type==='click'||outcome?.ok===false)break;}return{ok:results.every(item=>item.ok!==false),results};}
    }});
    if(result.staleTask){await candidate?.engine.detach();throw Object.assign(Error(result.reason),{staleTask:true});}
    if(result.originalTaskSyncFailure){await candidate?.engine.detach();throw Object.assign(Error(result.reason),{originalTaskSyncFailure:true,status:result.status,cloudNetwork:result.cloudNetwork});}
    const assertResultDocument=result.originalPublicGateDocumentTimeOrigin===undefined?assertDocument:async()=>{await assertCurrent();if(await page.evaluate(()=>performance.timeOrigin)!==result.originalPublicGateDocumentTimeOrigin)throw Object.assign(Error('原公开页面文档已变化，接管关口已放弃'),{staleTask:true});await assertCurrent();};
    if(result.originalAgentUnavailable)await skipOriginalUnavailableTask(this,{task,page,result,assertCurrent:async()=>{await assertCurrent();await assertResultDocument();}});
    if(!result.serviceUnavailable&&!result.interrupted&&!result.originalPublicGateClassified)try{await classifyOriginalTaskGate(this,{task,page,result,active,assertPageDocument:assertResultDocument});}catch(error){await assertCurrent();await assertResultDocument();throw error;}
    return {...result,candidate};
  }
  async reobserveNavigatedReceipt(page, task) {
    const hostname = url => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '').toLowerCase() : ''; } catch { return ''; } };
    if (page.isClosed() || !hostname(task.url) || hostname(page.url()) !== hostname(task.url)) return { matched: false };
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    for (const frame of page.frames()) {
      if (hostname(frame.url()) !== hostname(task.url)) continue;
      let engine;
      try {
        engine = await attachEngine(this.context, frame);
        const evidence = await engine.call({ action: 'classifySubmitEvidence', destinationUrl: task.url });
        if (evidence.matched && evidence.evidence && evidence.evidence !== task.baselineEvidence) return evidence;
      } catch { /* No fresh receipt: retain the unknown attempt, never click again. */ }
      finally { await engine?.detach(); }
    }
    return { matched: false };
  }
  async reconcileTextInputs(frame, report, mappings = {}) {
    // The shared mapper runs in an isolated world. React forms can display a
    // value there while their own state still holds an empty string. Playwright
    // emits browser input events so the form sees the same value before submit.
    for (const field of report?.fields || []) {
      if (!['text', 'url', 'email', 'search', 'textarea'].includes(field.type) || !field.value || !field.selector) continue;
      const locator = frame.locator(field.selector);
      if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) continue;
      await fillAndVerifyText(locator,field.value);
    }
    // File uploads can rerender a controlled form and erase fields that were
    // filled earlier. Recover those exact values from this attempt's mapping.
    for (const [name, mapping] of Object.entries(mappings)) {
      if (!mapping?.value || !/^[\w-]+$/.test(name) || /cloud-media:|^https?:.*\.(?:png|jpe?g|svg)/i.test(String(mapping.value))) continue;
      const locator = frame.locator(`input[name="${name}"], textarea[name="${name}"]`);
      if (await locator.count() !== 1 || !await locator.isVisible() || !await locator.isEnabled()) continue;
      if (!['text', 'url', 'email', 'search', 'textarea'].includes(await locator.evaluate(e => e.tagName === 'TEXTAREA' ? 'textarea' : e.type))) continue;
      if (await locator.inputValue() !== String(mapping.value)) await fillAndVerifyText(locator,mapping.value);
    }
    for (const [name, mapping] of Object.entries(mappings)) {
      if (!mapping?.value || !/^[\w-]+$/.test(name)) continue;
      const select = frame.locator(`select[name="${name}"]`);
      if (await select.count() !== 1 || !await select.isVisible() || !await select.isEnabled()) continue;
      if (await select.inputValue() !== String(mapping.value) &&
          await select.locator(`option[value="${String(mapping.value).replace(/"/g, '\\"')}"]`).count() === 1) {
        await select.selectOption(String(mapping.value), { timeout: 5000 });
      }
    }
  }
  async prepareKnownPage(page, url, task) {
    if(new URL(url).hostname==='aitoolmall.com')await rejectOptionalCookies(this,page,task);
    if(new URL(url).hostname.replace(/^www\./,'')==='devpages.io'&&task.consentHistory?.some(c=>c.scope==='ordinary_submission_permissions')){
      if(await page.getByRole('listbox').filter({visible:true}).count())await page.keyboard.press('Escape');
      const accept=page.getByRole('button',{name:'Accept All Cookies',exact:true}).filter({visible:true});if(await accept.count()===1)await accept.click({timeout:5000});
    }
    const seoBar = page.getByRole('button', { name: 'Minimize SEObar', exact: true });
    if (await seoBar.count() === 1 && await seoBar.isVisible()) await seoBar.click({ timeout: 5000 });
    const entryPaths = { 'aitoolslist.io': '/submit-ai-tool/', 'tooldirectory.ai': '/submit-tool', 'avivadirectory.com': '/submit.php' };
    const initial = new URL(url);
    const entryPath = entryPaths[initial.hostname.replace(/^www\./,'')];
    if (entryPath && new URL(page.url()).pathname === '/') {
      const entries=page.locator(`a[href$="${entryPath}"]`);
      const publicMobileNavigation=initial.hostname.replace(/^www\./,'')==='tooldirectory.ai'&&await entries.count()>0;
      const entry=(publicMobileNavigation?entries:entries.filter({visible:true})).first();
      await entry.waitFor({state:publicMobileNavigation?'attached':'visible',timeout:15000});
      const href = new URL(await entry.getAttribute('href'),page.url());
      if(href.origin!==new URL(page.url()).origin || href.hostname.replace(/^www\./,'')!==initial.hostname.replace(/^www\./,'') || href.pathname!==entryPath) throw new Error('当前页面投稿入口与核实站点不一致');
      await this.lease(task);
      this.update(task,{navigationHistory:[...(task.navigationHistory || []),{at:new Date().toISOString(),action:'verified_submission_entry',from:page.url(),to:href.href}]},'submission_entry');
      await this.cloud.flush(this.store);
      // Some directory entry links open a new tab. Keep the verified URL on
      // the registered task target so later fill and receipt checks agree.
      await page.goto(href.href,{waitUntil:'domcontentloaded',timeout:45000});
      await page.locator('input:visible,textarea:visible,iframe:visible').first().waitFor({timeout:20000}).catch(()=>{});
    }
    if (/^https:\/\/(?:www\.)?toolscout\.ai\/submit\/?$/i.test(url) && task) {
      const body = await page.evaluate(() => document.body.innerText);
      const finalButton=page.getByRole('button',{name:'Submit for review',exact:true});
      const staged=await finalButton.count()===1?toolScoutFinalPreparation(task,body,!await finalButton.isEnabled()):null;
      if(staged){this.update(task,staged,'staged_form_human_gate');throw new Error(staged.reason);}
      if (/QUESTION \d OF 3/.test(body)) {
        const skip = page.getByRole('button', { name: 'Skip', exact: true });
        await this.lease(task);
        this.update(task, { stageHistory: [...(task.stageHistory || []),
          { at: new Date().toISOString(), stage: body.match(/QUESTION \d OF 3/)[0], action: 'skip_optional_launch_quiz' }] }, 'stage_boundary');
        await this.cloud.flush(this.store);
        await skip.click({ timeout: 5000 });
        throw new Error('ToolScout 已跳过可选推广问卷，等待核实免费方案；未点击最终投稿');
      }
      if (/STEP 3 OF 5/.test(body)) {
        const free = page.getByRole('radio', { name: /Standard listing.*Free.*\$0.*forever/i });
        if (await free.count() !== 1) throw new Error('没有唯一可核实的 $0 Standard Listing');
        if (!await free.isChecked()) await free.check();
        const next = page.getByRole('button', { name: 'Continue with Free', exact: true });
        await this.lease(task);
        this.update(task, { stageHistory: [...(task.stageHistory || []),
          { at: new Date().toISOString(), stage: 3, action: 'continue_zero_cost_standard' }] }, 'stage_boundary');
        await this.cloud.flush(this.store);
        await next.click({ timeout: 5000 });
        throw new Error('ToolScout 已确认 $0 Standard Listing，等待核实详情步骤；未点击最终投稿');
      }
      if (/STEP 4 OF 5/.test(body)) {
        const profile = task.profileSnapshot;
        if (!/free/i.test(profile?.fields?.Pricing || '')) throw new Error('没有核实的免费价格资料');
        await page.getByRole('checkbox', { name: 'Website', exact: true }).check();
        await page.getByRole('checkbox', { name: 'This tool is completely free (no pricing page)', exact: true }).check();
        await page.getByRole('checkbox', { name: 'Free', exact: true }).check();
        const download = page.getByRole('textbox', { name: 'App download link (optional)', exact: true });
        if (await download.count() === 1 && await download.inputValue()) await download.fill('');
        await this.lease(task);
        this.update(task, { stageHistory: [...(task.stageHistory || []),
          { at: new Date().toISOString(), stage: 4, fields: { platform: 'Website', pricing: 'Free', appDownload: '' } }] }, 'stage_boundary');
        await this.cloud.flush(this.store);
        await page.getByRole('button', { name: 'Next step: Support the community', exact: true }).click({ timeout: 5000 });
        throw new Error('ToolScout 详情确认 Website/Free，无下载链接，等待核实最终免费投稿');
      }
      if (/STEP 5 OF 5/.test(body) && /0 \/ 5 visited/.test(body)) {
        const visits = page.getByRole('link', { name: 'Visit', exact: true });
        if (await visits.count() < 5) throw new Error('站方要求访问5个社区工具，当前入口不足');
        for (let index=0; index<5; index++) {
          await this.lease(task);
          this.update(task, { stageHistory: [...(task.stageHistory || []),
            { at: new Date().toISOString(), stage: 5, action: 'open_community_tool', index }] }, 'stage_boundary');
          await this.cloud.flush(this.store);
          const opened = page.waitForEvent('popup', { timeout: 15000 });
          await visits.nth(index).click({ timeout: 5000 });
          const child = await opened;
          await recordCommunityVisit(this,task,child,index);
        }
        throw new Error('ToolScout 已实际打开5个社区工具页面，核对解锁后的最终投稿按钮');
      }
    }
    const airtable = page.locator('iframe[src*="airtable.com/"]');
    if (await airtable.count() === 1) {
      await airtable.contentFrame().locator('textarea:visible, input:visible, [contenteditable=true]:visible')
        .first().waitFor({ timeout: 20000 });
    }
    const tally = page.locator('iframe[src*="tally.so/"]');
    if (await tally.count() === 1) await tally.contentFrame().locator('input:visible,textarea:visible').first().waitFor({timeout:20000});
    if (/^https:\/\/(?:www\.)?saasaitools\.com\/?$/i.test(url)) {
      const submit = page.getByText('Submit your AI tool for FREE', { exact: true });
      if (await submit.count() === 1 && await submit.isVisible()) await submit.click();
    }
    if (/^https:\/\/(?:www\.)?futuretools\.io\/submit-a-tool\/?/i.test(url)) {
      const decline = page.getByText("No thanks, I'm good", { exact: true });
      if (await decline.count() === 1 && await decline.isVisible()) await decline.click();
    }
    if(navToolsAdapter.matches(url))await navToolsAdapter.prepare(page);
  }
  async completeKnownForm(frame, url, profile, task) {
    if(navToolsAdapter.matches(url)&&task)await navToolsAdapter.fill(frame,profile,task,this);
    if(new URL(url).hostname.replace(/^www\./,'')==='devpages.io'&&task){
      await fillAndVerifyText(frame.locator('#name'),profile.name);await fillAndVerifyText(frame.locator('#url'),profile.url);
      await fillAndVerifyText(frame.locator('#description'),profile.fields['Short Discription(100-150 words)']);
      await fillAndVerifyText(frame.locator('#email'),profile.fields['Business mail']);
      const github=frame.locator('#github'),[githubUrl]=profileFieldChoices(profile,['GitHub URL','Github URL','GitHub','Github','Repository URL']);if(githubUrl&&await github.count()===1)await fillAndVerifyText(github,githubUrl);
      await fillAndVerifyText(frame.locator('#email'),profile.fields['Business mail']);
      const selected={};for(const [id,keys]of [['category',['DevPages Category','Category']],['pricing',['PRICING TYPE','Pricing']]]){
        const [label]=profileFieldChoices(profile,keys);if(label)selected[id]=await selectCommittedMenuOption(frame,'#'+id,label);
      }this.update(task,{selectedPickers:selected},'verified_picker_values');
    }
    if(new URL(url).hostname==='aioftheday.com' && await frame.locator('input[name=features]').count()===5) {
      const copy=aiOfDayCopy(profile);
      await frame.locator('input[name=tagline]').fill(copy.tagline);
      await frame.locator('textarea[name=description]').fill(copy.description);
      const features=frame.locator('input[name=features]');
      for(let i=0;i<copy.features.length;i++)await features.nth(i).fill(copy.features[i]);
      const [pricing]=profileFieldChoices(profile,['PRICING TYPE','Pricing']);if(pricing)await frame.locator('#PriceType').selectOption({label:pricing});
      const category=profileFieldChoices(profile,['AIoftheday Category','Category']),technology=profileFieldChoices(profile,['Tech Stack','Technology','Technologies']);
      if(category.length)await selectVerifiedOption(frame,'#react-select-2-input',category);
      if(technology.length)await selectVerifiedOption(frame,'#react-select-3-input',technology);
    }
    if(/^https:\/\/poweredbyai\.app\/submit-tool\/?$/i.test(url) && task) {
      const prefill=frame.getByRole('button',{name:/^(?:从 URL 自动填充|Auto-?fill from URL)$/});
      const website=frame.locator('input[name=toolUrl]');
      if(await prefill.count()===1 && await website.count()===1 && await website.isVisible()) {
        await website.fill(profile.url);
        await this.lease(task);
        this.update(task,{stageHistory:[...(task.stageHistory || []),{at:new Date().toISOString(),stage:'fetch_product_url',url:profile.url,profileRevision:task.profileRevision}]},'url_prefill_boundary');
        await this.cloud.flush(this.store);await prefill.click({timeout:10000});await frame.page().waitForTimeout(5000);
        throw new Error('PoweredByAI 已用核实URL获取下一步表单，先核对抓取结果；未点击最终投稿');
      }
      if(await frame.locator('input[name=name]').isVisible().catch(()=>false)) {
        await frame.locator('input[name=name]').fill(profile.name);
        for(const [selector,value]of [['textarea[name=description]',profile.fields['Short Discription(100-150 words)']],['input[name=full_name]',profile.fields['Contact person']],['input[name=email]',profile.fields['Business mail']]])if(value)await frame.locator(selector).fill(String(value));
        const selected={};
        const category=profileFieldChoices(profile,['PoweredByAI Category','Category']),subcategory=profileFieldChoices(profile,['PoweredByAI Subcategory','Subcategory']);
        if(category.length)selected.category=await selectVerifiedOption(frame,'#react-select-submit-tool-category-input',category);
        if(subcategory.length)selected.subcategory=await selectVerifiedOption(frame,'#react-select-submit-tool-subcategory-input',subcategory);
        const logoInput=frame.locator('input[type=file]');
        if(await logoInput.count()!==1)throw new Error('Logo上传控件未唯一核实');
        if(!await logoInput.evaluate(e=>Boolean(e.files?.length))){
          const logo=selectedFrozenPngLogo(profile,this.store.get('run:'+task.runId)?.mediaManifest);
          if(!logo)throw new Error('冻结资料缺少PNG Logo');
          const media=await this.bridge(task,{action:'fetchCloudSubmissionMedia',ref:'cloud-media://'+logo.asset_id}),bytes=Buffer.from(media.dataUrl.split(',')[1],'base64');
          const verifiedLogo=validateSquarePng(bytes,logo.sha256||media.sha256);
          await logoInput.setInputFiles({name:media.name,mimeType:'image/png',buffer:bytes});
          this.update(task,{verifiedLogo},'verified_square_logo');
        }
        this.update(task,{selectedPickers:selected},'verified_picker_values');
      }
    }
    if(/^https:\/\/10015\.io\/product-finder\/submit\/?$/i.test(url) && task) {
      const advance=frame.getByRole('button',{name:'Submit URL',exact:true});
      const website=frame.locator('#submittedUrl');
      if(await advance.count()===1 && await website.count()===1 && await website.isVisible() && !await frame.locator('input#name').isVisible().catch(()=>false)) {
        await website.fill(profile.url);
        if(await website.inputValue()!==profile.url)throw new Error('10015 产品URL没有保持，未前进');
        await this.lease(task);
        this.update(task,{stageHistory:[...(task.stageHistory || []),{at:new Date().toISOString(),stage:'fetch_product_url',url:profile.url,profileRevision:task.profileRevision}]},'url_prefill_boundary');
        await this.cloud.flush(this.store);
        // The site's sticky navigation overlays pointer events while the
        // keyboard action remains available on the visible enabled button.
        if(!await advance.isEnabled())throw new Error('10015 URL前进按钮尚不可用');
        await advance.press('Enter');await frame.page().waitForTimeout(5000);
        throw new Error('10015 已用核实URL获取下一步表单，先核对抓取结果；未点击产品投稿');
      }
      if(await frame.locator('input#name').isVisible().catch(()=>false)) {
        const tagline=frame.locator('#tagline');
        const currentTagline=profileTagline(profile);if(currentTagline)await tagline.fill(currentTagline);
        const selected={};
        // This site renders committed tag chips below the search control.
        const readTags=()=>frame.locator('#tag').evaluate(e=>[...e.closest('[class$="-container"]').parentElement.parentElement.querySelectorAll('button')].map(b=>b.innerText.trim()).join(', '));
        for(const [selector,keys] of [['#pricing',['PRICING TYPE','Pricing']],['#category',['10015 Category','Category']],['#tag',['10015 Tags','Tags Keywords/Hashtags']]]) {
          const choices=profileFieldChoices(profile,keys);if(choices.length)selected[selector]=await selectVerifiedOption(frame,selector,choices,selector==='#tag'?readTags:undefined);
        }
        this.update(task,{selectedPickers:selected},'verified_picker_values');
      }
    }
    if (/^https:\/\/(?:www\.)?toolscout\.ai\/submit\/?$/i.test(url) && task) {
      const body = await frame.evaluate(() => document.body.innerText);
      const stage = body.match(/STEP (\d) OF 5/);
      if (stage?.[1] === '1') {
        const name = frame.locator('input[name=name]'), website = frame.locator('input[name=url]');
        if (await name.inputValue() === profile.name && await website.inputValue() === profile.url) {
          const next = frame.getByRole('button', { name: 'Next step: Launch plan', exact: true });
          await this.lease(task);
          const fields = await frame.locator('input[name=name],input[name=url],textarea[name=description]').evaluateAll(es=>es.map(e=>({name:e.name,value:e.value})));
          this.update(task, { stageHistory: [...(task.stageHistory || []), { stage: 1, at: new Date().toISOString(), fields, profileRevision: task.profileRevision }] }, 'stage_boundary');
          await this.cloud.flush(this.store);
          await next.click({ timeout: 5000 });
          await frame.getByText(/Question 1 of 3/i).waitFor({ timeout: 10000 });
          throw new Error('ToolScout 已完成真实步骤1并进入步骤2，等待核实 Launch plan；未点击最终投稿');
        }
      }
    }
    if (/^https:\/\/(?:www\.)?nextgentools\.me\/submit-your-tool\/?/i.test(url)) {
      const picker = frame.getByRole('combobox');
      const categories=profileFieldChoices(profile,['NextGenTools Category','Category']);
      if (categories.length&&await picker.count() === 1 &&
          !await picker.evaluate((e,choices) => choices.some(value=>e.parentElement?.textContent?.includes(value)),categories)) {
        await picker.click({ timeout: 5000 });
        let selected=false;
        for(const category of categories){const option=frame.getByRole('option',{name:category,exact:true});if(await option.count()===1&&await option.isVisible()){await option.click();if(!await picker.evaluate((e,value)=>e.parentElement?.textContent?.includes(value),category))throw Error('NextGenTools 分类未保持');selected=true;break;}}
        if(!selected)throw Error('NextGenTools 缺少原产品资料指定的分类');
      }
      const drop = frame.getByText('Drop files here or click to browse', { exact: true });
      const upload = frame.getByRole('button', { name: 'Upload 1 file', exact: true });
      if (await upload.count() === 1 && await upload.isVisible()) {
        await upload.click({ timeout: 5000 });
        await upload.waitFor({ state: 'hidden', timeout: 15000 });
        throw new Error('Airtable PNG logo 上传按钮已完成，核对附件后再投稿');
      }
      const uploadedLogo = frame.getByText('logo.png', { exact: true });
      if (task && await drop.count() === 1 && await drop.isVisible() &&
          !await uploadedLogo.isVisible().catch(() => false)) {
        const browse = frame.getByRole('button', { name: 'browse files', exact: true });
        if (!await browse.isVisible().catch(() => false)) {
          await drop.click({ timeout: 5000 });
          await browse.waitFor({ timeout: 5000 });
        }
        const run = this.store.get('run:' + task.runId);
        const logo = selectedFrozenPngLogo(profile,run.mediaManifest);
        if (!logo) throw new Error('本站要求 PNG logo，冻结素材中没有对应文件');
        const media = await this.bridge(task, { action:'fetchCloudSubmissionMedia', ref: 'cloud-media://' + logo.asset_id });
        const chooserPromise = frame.page().waitForEvent('filechooser', { timeout: 5000 });
        await browse.click({ timeout: 5000 });
        const chooser = await chooserPromise;
        await chooser.setFiles({ name: media.name, mimeType: 'image/png', buffer: Buffer.from(media.dataUrl.split(',')[1], 'base64') });
        throw new Error('PNG logo 已送入 Airtable 上传界面，等待核对上传完成；未提交');
      }
    }
    if (/^https:\/\/(?:www\.)?futuretools\.io\/submit-a-tool\/?/i.test(url)) {
      const category = frame.locator('select[name="category"]');
      const [categoryLabel]=profileFieldChoices(profile,['FutureTools Category','Category']);if (categoryLabel&&await category.count() === 1 && !await category.inputValue()) await category.selectOption({label:categoryLabel});
      const free = frame.getByRole('radio', { name: 'Free', exact: true });
      if (profileFieldChoices(profile,['PRICING TYPE','Pricing']).includes('Free')&&await free.count() === 1 && !await free.isChecked()) await free.check();
    }
    if (!/^https:\/\/(?:www\.)?tools-ai\.online\//i.test(url)) return;
    const description = String(profile?.fields?.['Short Discription(100-150 words)'] || '').trim();
    const editor = frame.locator('#toolDescription');
    if (description && await editor.count() === 1 && (await editor.inputValue()).length < 500) await editor.fill(description);
    const pricing = frame.locator('select[name="pricing"]');
    const [pricingLabel]=profileFieldChoices(profile,['PRICING TYPE','Pricing']);if (pricingLabel&&await pricing.count() === 1 && !await pricing.inputValue()) await pricing.selectOption({ label: pricingLabel });
    const category = frame.getByText('Select categories', { exact: true });
    const [categoryLabel]=profileFieldChoices(profile,['ToolsAI Category','Category']);if (categoryLabel&&await category.count() === 1) {
      await category.click();
      const game = frame.getByText(categoryLabel, { exact: true });
      if (await game.count() === 1 && await game.isVisible()) await game.click();
    }
    const tags = frame.getByText('Select tags', { exact: true });
    const [tagLabel]=profileFieldChoices(profile,['ToolsAI Tags','Tags Keywords/Hashtags']);if (tagLabel&&await tags.count() === 1) {
      await tags.click();
      const aiGaming = frame.getByText(tagLabel, { exact: true });
      if (await aiGaming.count() === 1 && await aiGaming.isVisible()) await aiGaming.click();
    }
  }
  async knownFormIssues(frame, url,profile) {
    if (!/^https:\/\/(?:www\.)?tools-ai\.online\//i.test(url)) return [];
    const state = await frame.evaluate(() => {
      const section = label => [...document.querySelectorAll('form label')].find(e => e.textContent?.trim().startsWith(label))?.parentElement?.innerText || '';
      return { description: document.querySelector('#toolDescription')?.value || '', categories: section('Categories'), tags: section('Tags'), pricing: document.querySelector('select[name="pricing"]')?.selectedOptions?.[0]?.textContent?.trim() || '' };
    });
    const issues = [];
    if (state.description.length < 500) issues.push('Tool Description 少于站方要求的 500 字符');
    const categories=profileFieldChoices(profile,['ToolsAI Category','Category']),tags=profileFieldChoices(profile,['ToolsAI Tags','Tags Keywords/Hashtags']),[pricing]=profileFieldChoices(profile,['PRICING TYPE','Pricing']);
    if (!state.categories.trim()||state.categories.includes('Select categories')||categories.length&&!categories.some(value=>state.categories.includes(value))) issues.push('分类为空或未保持原产品指定的分类');
    if (!state.tags.trim()||state.tags.includes('Select tags')||tags.length&&!tags.some(value=>state.tags.includes(value))) issues.push('标签为空或未保持原产品指定的标签');
    if (!state.pricing.trim()||pricing&&state.pricing!==pricing) issues.push('价格类型为空或未与原产品资料一致');
    return issues;
  }
  async accept(task, page, evidence) {
    if(!task.indexNowNotification)this.update(task,{indexNowNotification:prepareIndexNotification(this,task)},'index_notification_scheduled');
    this.update(task, { status: 'finished', siteStatus: 'accepted', receipt: { evidence: evidence.evidence, url: page.url(), publicationStatus: evidence.publicationStatus,receivedAt:new Date().toISOString(),syncStatus:'pending' }, cloudVerified: false,
      reason: evidence.publicationStatus === 'pending_moderation' ? '站方明确收件，等待审核' : '站方明确收件', completedAt: new Date().toISOString() }, 'receipt');
    const file = path.join(this.home, `${task.id}-${Date.now()}-receipt.png`);
    await capturePageEvidence(this.context,page,{path:file});
    this.update(task, { screenshot: file, artifactRef: '' }, 'receipt_screenshot');
  }
  async findPage(task) {
    if (!this.context) await this.connect();
    if(task.originalGroupAdvance?.status==='transferred'&&task.targetId===task.originalGroupAdvance.targetId)throw new Error('原页已交给同站下一产品，不能由旧产品重新使用');
    if (task.browserInstance !== this.host.startedAt) throw new Error('原浏览器宿主已变化；保留未知结果，不能重投');
    for (const page of this.context.pages()) {
      const info=await getTargetInfo(this.context,page);
      if (info?.targetId === task.targetId) return page;
    }
    throw new Error('原目标页已关闭；需要独立站方核验，不能新开表单重投');
  }
  async control(action, input) {
    if(['previewRunHistory','importRunHistory','runHistoryUploadStart','runHistoryUploadPart','runHistoryUploadComplete'].includes(action))return runHistory(this,action,input);
    if(['runExportSources','exportBatchReport','exportAutomationRun'].includes(action))return runExports(this,action,input);
    if(action==='localRecoverySources')return localRecoverySources(this);
    if(action==='previewLocalRecovery')return previewLocalRecovery(this,input);
    if(action==='submissionJournalRecoverLocal')return recoverLocalDocuments(this,input);
    if(action==='sidepanelOpened')return sidepanelOpened(this,input);
    if(action==='sidepanelClosed')return sidepanelClosed(this,input);
    if(action==='sidepanelDetect')return sidepanelDetect(this,input);
    if(action==='sidepanelFill')return sidepanelFill(this,input);
    if(action==='getSubmissionQueue')return submissionQueue(this,input);
    if(action==='advanceSubmission')return submissionQueue(this,input,true);
    if(action==='removeFromSubmissionQueue')return removeFromSubmissionQueue(this,input);
    if(action==='manualSkip')return manualSkip(this,input);
    if(action==='manualSubmit')return manualSubmit(this,input);
    if(action==='taskPageControl')return handleTaskPageMessage(this,input);
    if(action==='stop')return stopExecution(this,input);
    if(['resume','offlineResume'].includes(action)&&this.store.get('executionStopped'))throw Error('本次执行已经停止，请预览或明确重新开始原范围');
    if(action==='clearSiteAnnotation')return clearSiteAnnotation(this,input);
    if(action==='getBatchLog')return{ok:true,...this.store.logs({...input,scope:String(this.store.get('pair')?.endpoint||'')+'|'+String(this.store.get('pair')?.workspaceId||'default')})};
    if(action==='manualWatchMessage')return manualWatchMessage(this,input);
    if(action==='checkManualWatches')return checkManualWatches(this);
    if(action==='checkCaptchaResumes')return checkCaptchaResumes(this,input);
    if(action==='saveAssistantSettings')return saveAssistantSettings(this,input);
    if(action==='requestAutoFill')return requestAutoFill(this,input);
    if(action==='fillAssistantTask')return fillAssistantTask(this,input);
    if(action==='browserLibraryPages')return browserLibraryPages(this);
    if(action==='addBrowserPage')return addBrowserPage(this,input);
    if(action==='cloudSyncStatus')return cloudStatus(this);
    if(action==='cloudSyncPush')return pushLocalChanges(this);
    if(action==='cloudSyncPull')return pullCloudState(this,input);
    if(action==='previewCloudPull')return previewCloudPull(this,input);
    if(action==='commitCloudPull')return commitCloudPull(this,input);
    if(action==='mediaLibrary')return mediaLibrary(this);
    if(action==='commentHistory')return commentHistory(this,input);
    if(action==='saveCommentVersion')return saveCommentVersion(this,input);
    if(action==='quickOpenLibrary')return quickOpenLibrary(this,input);
    if(action==='startLinkMonitor')return startLinkMonitor(this,input);
    if(action==='dismissMonitorAlert')return dismissMonitorAlert(this,input);
    if(action==='startPublicLibrarySync')return startPublicLibrarySync(this,input);
    if(action==='startDomainAge')return startDomainAge(this,input);
    if(['exportBackup','previewBackup','importBackup','backupUploadStart','backupUploadPart','backupUploadComplete'].includes(action))return workbenchBackup(this,action,input);
    if(action==='detectOriginalTask')return detectOriginalTask(this,input);
    if(action==='fillCommentDraft')return fillCommentDraft(this,input);
    if(action==='previewBatch')return previewWorkbenchBatch(this,input);
    if(action==='startBatch')return startWorkbenchBatch(this,input);
    if(['extractProfile','generateProfile','commentDrafts'].includes(action))return applicationAi(this,action,input);
    if(action==='startAcceptance')return startAcceptanceBatch(this,input.acceptanceId);
    if(action==='libraryMutation')return enqueueLibraryMutation(this,input);
    if(action==='appData')return applicationData(this,input);
    if(action==='taskDetails'){
      const task=this.store.get('task:'+input.taskId);if(!task)throw Error('任务不存在');
      return{ok:true,task};
    }
    if(action==='registerAcceptance')return registerAcceptance(this,input.acceptanceId);
    if(action==='runTask'){
      if(this.job||this.store.get('paused')!==true||this.store.get('singleTaskId'))throw Error('原执行器需先暂停空闲');
      const selected=this.store.get('task:'+input.taskId);
      if(!selected||selected.attemptBoundary||selected.receipt||!['pending','needs_manual'].includes(selected.status)||selected.controller==='supervisor')throw Error('只能继续未投稿的原任务；未知结果须核验');
      const frozen=this.store.get('acceptance:'+input.acceptanceId),execution=this.store.get('acceptanceExecution:'+input.acceptanceId);
      const combo=frozen?.combinations.find(c=>(c.existingTaskId===selected.id||execution?.items[c.identity]?.taskId===selected.id)&&c.profileId===selected.profileId);
      if(!combo)throw Error('原任务不在冻结组合范围');
      const snapshot=await this.cloud.request('snapshot');
      if(priorProductSuccess(snapshot.documents.submissionRecords,selected.profileId,selected.url))throw Error('该产品同站已有收件，禁止重复投稿');
      await this.lease(selected,{online:true});
      this.update(selected,{status:'pending',controller:'executor',acceptanceId:input.acceptanceId,profileSnapshot:combo.profile,profileRevision:combo.profileRevision,
        consentHistory:[...(selected.consentHistory||[]),{at:new Date().toISOString(),scope:'ordinary_submission_permissions',source:'approved_plan',text:'已批准冻结范围普通免费投稿及基本登录，额外权限和本人验证留待用户'}]},'frozen_task_released');
      if(!frozen.startedAt)this.store.set('acceptance:'+input.acceptanceId,{...frozen,startedAt:new Date().toISOString()});
      this.store.set('executionStopped',null);this.store.set('manualResumeRunId',null);this.store.set('singleTaskId',selected.id);this.store.set('paused',false);this.tick();return this.status();
    }
    if(action==='workbenchDocuments')return workbenchDocuments(this);
    if(action==='journalProgress')return enqueueWorkbench(this,input);
    if(action==='journalFlush')return journalSync(this).flush();
    if(action==='workbenchPending')return{ok:true,pending:pendingWorkbench(this)};
    if(action==='archiveDeferredTabs')return archiveDeferredTabs(this);
    if (action === 'connectHost' || action === 'attachPage') {
      if (this.job || this.store.get('paused') !== true) throw new Error('连接人工浏览器需要执行器暂停且空闲');
      const task = action === 'attachPage' ? this.store.get(`task:${input.taskId}`) : null;
      if (action === 'attachPage' && (!task || task.attemptBoundary || task.receipt || !['pending','needs_manual'].includes(task.status))) {
        throw new Error('只有尚未发生提交尝试的原任务才能绑定人工登录页面');
      }
      const currentHost = JSON.parse(await readFile(path.join(this.home, 'host.json'), 'utf8'));
      if (this.context && this.host.startedAt !== currentHost.startedAt) throw new Error('执行器仍连接旧宿主，请先重启已暂停的本机服务');
      if (!this.context) await this.connect();
      if (!task) return this.status();
      let page;
      for (const candidate of this.context.pages()) {
        const session = await this.context.newCDPSession(candidate);
        const target = (await session.send('Target.getTargetInfo')).targetInfo;
        await session.detach();
        if (target.targetId === input.targetId) { page = candidate; break; }
      }
      const hostName = url => new URL(url).hostname.toLowerCase().replace(/^www\./, '');
      if (!page || !/^https?:/.test(page.url()) || hostName(page.url()) !== hostName(task.url)) throw new Error('人工登录页面与原任务站点不一致');
      await this.lease(task);
      const priorPage = { targetId: task.targetId, browserInstance: task.browserInstance, at: new Date().toISOString() };
      this.update(task, { targetId: input.targetId, browserInstance: this.host.startedAt,
        pageHistory: [...(task.pageHistory || []), priorPage], pageOwnership:'manual',controller: 'executor' }, 'manual_page_attached');
      if(!this.store.get('offlineMode')?.enabled)await this.synchronize();
      return this.status();
    }
    if (action === 'review' && this.job) await this.job;
    if (action === 'pause')requestExecutionPause(this,input.reason);
    if (action === 'takeover') { this.store.set('paused', true); if (this.job) await this.job; }
    if (action === 'pause') {pauseWorkbenchBatch(this,input.reason);const id=this.store.get('activeWorkbenchBatch');let syncError='';try{if(id)await persistBatchLifecycle(this,this.store.get('workbenchBatch:'+id),'workbench_run_paused');}catch(error){syncError=error.message;}const plan=this.store.get('libraryPlan');if(plan?.globalPause)this.store.set('libraryPlan',{...plan,globalPause:{...plan.globalPause,resumeEligible:false,manualPausedAt:new Date().toISOString()}});return{...this.status(),syncError};}
    if (action === 'offlineResume') return this.resumeOffline(input);
    if (action === 'resume') return resumeExecution(this,input);
    if (action === 'startLibrary') return this.startLibrary(input);
    if (action === 'runOne') {
      if (this.job || this.store.get('paused') !== true || this.store.get('singleTaskId')) throw new Error('逐站放行需要先暂停并等待当前动作结束');
      const selected = this.store.get(`task:${input.taskId}`);
      if (!selected || selected.status !== 'pending' || selected.attemptBoundary) throw new Error('只能放行无尝试边界的待处理任务');
      if(input.submitPrepared && (selected.url!=='https://aioftheday.com/submit-a-tool'||input.captchaCompletedByUser!==true))throw new Error('已填表单提交仅用于用户已完成验证码的AIoftheday原任务');
      this.update(selected,{fillOnlyRun:input.fillOnly===true,submitPreparedRun:input.submitPrepared===true,
        ...(input.submitPrepared?{humanCaptchaConfirmation:{at:new Date().toISOString(),source:'user_reply',text:'用户回复验证码已完成'}}:{})},'single_task_mode');
      this.store.set('singleTaskId', selected.id);
      this.store.set('paused', false);
      this.tick();
      return this.status();
    }
    let task = this.store.get(`task:${input.taskId}`);
    if (!task) throw new Error('任务不存在');
    if(action==='prepareTask'){
      if(task.attemptBoundary||task.receipt)throw Error('已有提交边界，必须先核验，禁止重新准备');
      if(this.job||this.store.get('paused')!==true||task.controller==='supervisor')throw Error('请先暂停并等待原控制器交回任务');
      const snapshot=await this.cloud.request('snapshot');
      let profile=snapshot.documents.siteProfiles?.[task.profileId],profileRevision=snapshot.revisions.siteProfiles;
      if(!profile||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw Error('资料缺失或已有收件，禁止准备新投稿');
      if(input.acceptanceId){
        const frozen=this.store.get('acceptance:'+input.acceptanceId);
        const execution=this.store.get('acceptanceExecution:'+input.acceptanceId);
        const combo=frozen?.combinations.find(c=>(c.existingTaskId===task.id||execution?.items[c.identity]?.taskId===task.id)&&c.profileId===task.profileId);
        if(!combo)throw Error('任务不在固定验收范围');
        profile=combo.profile;profileRevision=combo.profileRevision;
        if(!frozen.startedAt)this.store.set('acceptance:'+input.acceptanceId,{...frozen,startedAt:new Date().toISOString()});
        this.update(task,{acceptanceId:input.acceptanceId},'frozen_scope_task');
      }
      if(!this.context)await this.connect();
      await this.lease(task);
      let page;
      try{page=await this.findPage(task);}catch{
        const recovery=task.recoveryCheckpoint?.recoveryUrl||task.url;
        const url=new URL(recovery);if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw Error('原任务恢复地址无效');
        page=await this.context.newPage();
        const {targetId}=await getTargetInfo(this.context,page);
        this.update(task,{targetId,browserInstance:this.host.startedAt,tabClosedAt:null,
          recoveryHistory:[...(task.recoveryHistory||[]),{at:new Date().toISOString(),action:'prepare_original_task',url:recovery,targetId}],controller:'executor'},'preparation_page_registered');
        await page.goto(recovery,{waitUntil:'domcontentloaded',timeout:45000});
      }
      this.update(task,{profileSnapshot:profile,profileRevision,
        consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'ordinary_submission_permissions',source:'approved_plan',text:'已批准普通免费投稿及目标站基本 Google 登录；额外 OAuth 权限及本人验证须由用户完成'}]},'preparation_profile_frozen');
      const config=applyDestinationFormKnowledge(snapshot.documents,plain(profiles.buildAgentConfigFromProfile(profile,{email:snapshot.documents.cfgEmail,username:snapshot.documents.cfgName,commentTemplate:snapshot.documents.cfgCommentTemplate})),task.url);
      let prepared,preparationStale=false;
      const preparationScope=workbenchScope(this.store.get('pair'));
      const preparationCurrent=()=>{const current=this.store.get('task:'+task.id);return !preparationStale&&current&&preparationScope===workbenchScope(this.store.get('pair'))&&['runId','profileId','profileRevision','version','controller','controllerId','targetId','browserInstance'].every(key=>current[key]===task[key])&&isDeepStrictEqual(current.profileSnapshot,profile)&&!current.attemptBoundary&&!current.receipt&&!page.isClosed();};
      const assertPreparation=async()=>{if(!preparationCurrent()||prepared?.candidate&&!await prepared.candidate.engine.isCurrentDocument()||!preparationCurrent()){preparationStale=true;throw Object.assign(Error('原准备任务或文档已变化，迟到结果已放弃'),{staleTask:true});}};
      try{prepared=await this.prepareWithAi(page,task,config,()=>!page.isClosed()&&this.store.get('paused')===true);}
      catch(error){preparationStale=error.staleTask===true;throw error;}
      finally{if(preparationCurrent()){const file=path.join(this.home,`${task.id}-${Date.now()}-ai-preparation.png`);
        await capturePageEvidence(this.context,page,{path:file}).then(async()=>{await assertPreparation();this.update(task,{screenshot:file,artifactRef:''},'ai_preparation_evidence');}).catch(error=>{if(preparationCurrent())this.update(task,{evidenceCaptureFailure:{at:new Date().toISOString(),reason:error.message}},'ai_preparation_evidence_failed');});
      }}
      try{
        await assertPreparation();
        if(prepared.candidate){
          const engine=prepared.candidate.engine;
          const report=await engine.call({action:'getFilledFieldsReport'});
          report.attachments=await prepared.candidate.frame.locator('input[type=file]').evaluateAll(async inputs=>{
            const result=[];for(const input of inputs)for(const file of [...(input.files||[])]){
              const sha256=globalThis.crypto?.subtle?[...new Uint8Array(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join(''):'';
              result.push({field:input.name||input.id,name:file.name,type:file.type,bytes:file.size,sha256});
            }return result;
          });
          const validation=await engine.call({action:'collectFormValidation'});await assertPreparation();
          this.update(task,{actualPreparation:{at:new Date().toISOString(),url:prepared.candidate.frame.url(),report,
            validation,qualityIssues:assessSubmissionQuality(report,profile),
            prepared:prepared.ok,reason:prepared.reason}},'actual_preparation_recorded');
        }
      }finally{await prepared.candidate?.engine.detach();if(!preparationStale)await this.cloud.flush(this.store);}
      return{ok:true,taskId:task.id,prepared:prepared.ok,reason:prepared.reason,aiTakeover:task.aiTakeover,actualPreparation:task.actualPreparation,submitted:false};
    }
    if(action==='openRecoveryTask'){
      if(this.job||this.store.get('paused')!==true||!this.store.get('offlineMode')?.enabled||task.status!=='needs_manual'||
        !(task.tabClosedAt||task.deferredRecovery?.targetUnavailableAt)||
        task.attemptBoundary||task.receipt||!task.recoveryCheckpoint||task.profileId!=='JevPlay'||task.profileSnapshot?.fields?.Url!=='https://jevplay.com')
        throw new Error('仅允许暂停时打开已归档的JevPlay未投稿原任务；提交未知结果禁止用此入口重开');
      if(!this.context)await this.connect();
      const recoveryUrl=task.recoveryCheckpoint.recoveryUrl||task.url;
      if(new URL(recoveryUrl).origin!==new URL(task.url).origin)throw new Error('恢复地址与原任务站点不一致');
      const page=await this.context.newPage();let navigationError='';
      try{await page.goto(recoveryUrl,{waitUntil:'domcontentloaded',timeout:45000});}catch(error){navigationError=error.message;}
      if(new URL(page.url()).origin!==new URL(task.url).origin){await page.close().catch(()=>{});throw new Error('原任务页未能在同站恢复：'+navigationError);}
      await page.bringToFront();
      const session=await this.context.newCDPSession(page),targetId=(await session.send('Target.getTargetInfo')).targetInfo.targetId;await session.detach();
      this.update(task,{targetId,browserInstance:this.host.startedAt,tabClosedAt:null,recoveryCheckpoint:{...task.recoveryCheckpoint,reopenedAt:new Date().toISOString(),reopenedTargetId:targetId,
        reopenNotice:'页面重新打开成功；表单状态需要复核，旧验证码响应不可复用。没有发生投稿。'},recoveryHistory:[...(task.recoveryHistory||[]),
        {at:new Date().toISOString(),action:'open_original_task',url:page.url(),targetId,closedTargetId:task.recoveryCheckpoint.sourceTargetId}],reason:'原任务恢复页已打开；需按恢复检查点复核，未自动投稿'},'original_task_reopened');
      return this.status();
    }
    if(action==='retryPrefillOnly') {
      if(this.job || this.store.get('paused')!==true || task.url!=='https://poweredbyai.app/submit-tool' ||
        task.status!=='submitted_unconfirmed' || task.receipt || !task.attemptBoundary || task.attemptBoundary!==input.expectedAttemptBoundary ||
        task.reason!==input.expectedReason || task.submitResult?.reason!=='no_submit_button' || (task.networkResponses || []).length || task.prefillRecovery)
        throw new Error('只能恢复一次已证明未启动网址预填的 PoweredByAI 原任务');
      const page=await this.findPage(task);
      const fields=await page.locator('input:visible,textarea:visible,select:visible').evaluateAll(elements=>elements.map(e=>({name:e.name,value:e.value})));
      const prefill=page.getByRole('button',{name:/^Auto-?fill from URL$/});
      if(fields.length!==1 || fields[0].name!=='toolUrl' || await prefill.count()!==1 || !await prefill.isVisible())throw new Error('原页不是仅网址预填步骤，停止恢复');
      const snapshot=await this.cloud.request('snapshot'),profile=snapshot.documents.siteProfiles?.[task.profileId];
      if(!profile || priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw new Error('云端已有收件或资料缺失');
      await this.lease(task);
      const old={at:task.attemptBoundary,reason:task.reason,actualSubmission:task.actualSubmission,submitResult:task.submitResult,
        screenshot:task.screenshot,artifactRef:task.artifactRef,artifactSha256:task.artifactSha256,kind:'verified_url_prefill_not_invoked',fields};
      this.update(task,{attemptHistory:[...(task.attemptHistory || []),old],prefillRecovery:true,attemptBoundary:null,baselineEvidence:'',
        profileSnapshot:profile,profileRevision:snapshot.revisions.siteProfiles,status:'pending',siteStatus:'not_submitted',submitResult:null,
        reason:'原页仅有Auto-fill from URL，已证明预填及最终投稿均未启动；保留证据后恢复原任务'},'prefill_no_action_recovered');
      await this.synchronize();return this.status();
    }
    if (action === 'registerAccount') return registerAccount(this,task);
    if (action === 'verifyRegistration') return verifyRegistration(this,task);
    if (action === 'finishProductPreview') return finishProductPreview(this,task,input);
    if (action === 'advancePlan') return advancePlan(this,task);
    if (action === 'verifyPlanStage') return verifyPlanStage(this,task);
    if (action === 'inspectCookiePreferences') return inspectCookiePreferences(this,task);
    if (action === 'enableFunctionalCookies') return enableFunctionalCookies(this,task,input);
    if (action === 'acceptAuthorizedCookies') return acceptAuthorizedCookies(this,task,input);
    if (action === 'recoverToolScoutLogout') return recoverToolScoutLogout(this,task,input);
    if (action === 'requestLoginLink') return requestLoginLink(this,task,input);
    if (action === 'restoreLostPreparation') return restoreLostPreparation(this,task,input);
    if(action==='finishCommunityVisit'){
      if(this.job||this.store.get('paused')!==true||task.attemptBoundary||task.receipt||task.url!=='https://toolscout.ai/submit')throw new Error('只允许收尾原ToolScout未投稿任务的已登记查看页');
      const visit=task.communityVisits?.find(v=>v.targetId===input.expectedTargetId&&v.kind==='required_read_only_community_visit'&&!v.closedAt);
      if(!visit)throw new Error('未找到已登记且尚未收尾的社区查看页');
      const page=await this.findPage(visit);await this.lease(task);await recordCommunityVisit(this,task,page,visit.index);return this.status();
    }
    if (action === 'authorizeMarketing') {
      if (this.job || this.store.get('paused') !== true || task.attemptBoundary || task.receipt ||
          !/^(?:www\.)?(?:aioftheday|saasaitools)\.com$/i.test(new URL(task.url).hostname) || input.authorization !== 'explicit_user_approved')
        throw new Error('营销授权仅适用于用户明确同意的这两个未投稿站点');
      await this.lease(task);
      this.update(task,{consentHistory:[...(task.consentHistory || []),{at:new Date().toISOString(),scope:'marketing_subscription',source:'user_reply',text:'用户明确允许 AIoftheday 和 SaaSaitools 的营销订阅'}]},'user_marketing_authorized');
      await this.synchronize();return this.status();
    }
    if (action === 'claimTask') {
      if (this.job || this.store.get('paused') !== true || task.controller === 'supervisor') throw new Error('只允许暂停空闲时接续本机执行器控制；监工任务需正常交回');
      await this.synchronize();
      task = this.store.get(`task:${input.taskId}`);
      const saved = (await this.cloud.request('runs')).tasks.find(t=>t.id===task.id);
      if (!saved || saved.controllerId !== task.controllerId || saved.version !== task.version) throw new Error('原控制状态与云端不一致');
      const handoff=await this.cloud.request('handoff',{taskId:task.id,version:task.version,previousControllerId:task.controllerId,controllerId:this.controllerId});
      this.update(task,{version:handoff.version,controllerId:this.controllerId},'local_controller_recovered');
      await this.synchronize();return this.status();
    }
    if (action === 'closeTaskTab') return closeTaskTab(this, task, input);
    if (action === 'observeTask') return observeTask(this, task, input);
    if(action==='basicGoogleLogin'){
      if(this.job||this.store.get('paused')!==true||task.attemptBoundary||task.receipt||task.status!=='needs_manual')throw new Error('基本Google登录只允许暂停空闲的原未投稿任务');
      if(!this.context)await this.connect();
      const page=await this.findPage(task);
      if(input.inspectOnly===true)return{taskId:task.id,targetId:task.targetId,ui:await readBasicGoogleUI(page)};
      if(!this.cloudError&&/Your account or project has exceeded the quota/i.test(this.store.get('libraryPlan')?.globalPause?.reason||''))this.cloudError=this.store.get('libraryPlan').globalPause.reason;
      const offline=canAuthenticateOffline(this,task,input);
      if(input.allowOfflineAuthenticationOnly===true&&!offline)throw new Error('离线认证必须证明当前独占原任务、准确原页、Neon额度故障且没有产品尝试');
      const result=await advanceBasicGoogleLogin(this,task,page,{offline,continueExistingAuth:input.continueExistingAuth===true,allowSingleRetry:input.allowSingleRetry===true});
      this.update(task,{reason:result.authenticated?'Google基本登录已由原站回调确认；产品尚未投稿，云端可用后接续原任务':result.reason,
        attentionType:result.authenticated?(offline?'cloud_quota':'login'):/验证码|真人|OTP/.test(result.reason)?'human_verification':'login'},'basic_google_result');
      if(result.authenticated&&offline){this.update(task,{status:'pending',siteStatus:'not_submitted',attentionType:'',reason:'原站Google回调已确认，保持原任务和资料继续离线免费投稿'},'offline_google_login_resume');this.store.set('paused',false);this.tick();}
      if(!offline)await this.synchronize();return{...this.status(),authenticationResult:result};
    }
    if(action==='openAuthPage'){
      if(this.job||this.store.get('paused')!==true||!this.store.get('offlineMode')?.enabled||task.status!=='needs_manual'||task.attentionType!=='login'||task.attemptBoundary||task.receipt||task.profileId!=='JevPlay'||task.profileSnapshot?.fields?.Url!=='https://jevplay.com')throw new Error('只允许为原JevPlay未投稿登录待办恢复同站登录页');
      let targetUrl=task.url;
      if(input.href){const observed=(task.publicPage?.links||[]).find(link=>link.href===input.href);let requested;
        try{requested=new URL(input.href);}catch{throw new Error('登录入口不是有效网址');}
        if(!observed||requested.origin!==new URL(task.url).origin||!/(?:login|sign-?in)/i.test(requested.pathname))throw new Error('只能打开原任务证据中已观察到的同站登录入口');targetUrl=requested.href;
      }
      if(!this.context)await this.connect();
      let page,replacedPage=null;if(task.browserInstance===this.host.startedAt&&task.targetId){try{page=await this.findPage(task);}catch{page=await this.context.newPage();}}
      else page=await this.context.newPage();
      if(input.newPage===true||/^chrome-error:/i.test(page.url())){replacedPage=page;page=await this.context.newPage();}
      let navigationError='';
      try{await page.goto(targetUrl,{waitUntil:'domcontentloaded',timeout:45000});await page.locator('input:visible,button:visible,a[href]:visible').first().waitFor({timeout:8000}).catch(()=>{});await page.waitForTimeout(3000);}
      catch(error){navigationError=error.message;}
      let actualHost='';try{actualHost=new URL(page.url()).hostname.toLowerCase().replace(/^www\./,'');}catch{}
      if(actualHost!==new URL(task.url).hostname.toLowerCase().replace(/^www\./,'')){await page.close().catch(()=>{});throw new Error('原站登录页未能在同一站点打开：'+(navigationError||page.url()));}
      const session=await this.context.newCDPSession(page),targetId=(await session.send('Target.getTargetInfo')).targetInfo.targetId;await session.detach();
      const ui=await readBasicGoogleUI(page),file=path.join(this.home,`${task.id}-${Date.now()}-login-page.png`);await capturePageEvidence(this.context,page,{path:file});
      this.update(task,{targetId,browserInstance:this.host.startedAt,controller:'executor',controllerId:this.controllerId,
        pageHistory:[...(task.pageHistory||[]),{at:new Date().toISOString(),targetId:task.targetId,browserInstance:task.browserInstance,disposition:'offline_login_target_rebound'},
          {at:new Date().toISOString(),targetId,browserInstance:this.host.startedAt,url:page.url(),disposition:'original_task_login_page_reopened'}],screenshot:file,artifactRef:''},'offline_login_page_opened');
      if(replacedPage&&!replacedPage.isClosed())await replacedPage.close();
      return{ok:true,taskId:task.id,targetId,url:page.url(),ui,navigationError};
    }
    if (action === 'annotateObservation') return annotateObservation(this,task,input);
    if (action === 'closeObservation') return closeObservation(this, task, input);
    if(action==='continueUnsubmitted'){
      if(this.job||this.store.get('paused')!==true||(this.store.pendingCount?.()??this.store.pending().length)||task.attemptBoundary||task.receipt||task.status!=='needs_manual')throw new Error('只能继续尚未投稿且暂停空闲的原任务');
      const page=await this.findPage(task),snapshot=await this.cloud.request('snapshot'),profile=snapshot.documents.siteProfiles?.[task.profileId];
      if(!profile||priorProductSuccess(snapshot.documents.submissionRecords,task.profileId,task.url))throw new Error('资料缺失或云端已有收件');
      if(input.reload&&new URL(task.url).hostname!=='aitoolmall.com')throw new Error('此刷新仅用于已同意Cookie但未显示表单的AIToolMall');
      await this.lease(task);this.update(task,{preparationHistory:[...(task.preparationHistory||[]),{at:new Date().toISOString(),reason:task.reason,profileRevision:task.profileRevision,actualSubmission:task.actualSubmission,artifactRef:task.artifactRef}],
        status:'pending',controller:'executor',profileSnapshot:profile,profileRevision:snapshot.revisions.siteProfiles,
        consentHistory:[...(task.consentHistory||[]),{at:new Date().toISOString(),scope:'ordinary_submission_permissions',source:'user_reply',text:'用户明确权限都允许，不再反复询问；继续必要的免费投稿及注册权限'}],reason:'按最新用户授权继续原未投稿任务，仍须真实字段和站方结果核验'},'unsubmitted_continued');await this.synchronize();
      if(input.reload)await page.reload({waitUntil:'domcontentloaded',timeout:45000});return this.status();
    }
    if (action === 'retryNoAction') {
      if (this.job || this.store.get('paused') !== true || !canRetryNoAction(task, input))
        throw new Error('仅允许一次保留证据的非投稿动作恢复，未知或已点击投稿不能解除边界');
      const snapshot = await this.cloud.request('snapshot');
      const profile = snapshot.documents.siteProfiles?.[task.profileId];
      if (!profile || priorProductSuccess(snapshot.documents.submissionRecords, task.profileId, task.url))
        throw new Error('最新云端已有本站收件或资料缺失');
      await this.lease(task);
      const guardedFillOnly=task.submitResult?.fillOnly===true && task.reason==='fill_only';
      if(guardedFillOnly)await this.findPage(task);
      const prior = { at: task.attemptBoundary, reason: task.reason, screenshot: task.screenshot,
        artifactRef: task.artifactRef, artifactSha256: task.artifactSha256, actualSubmission: task.actualSubmission,
        submitResult: task.submitResult, kind: 'verified_non_submission_action' };
      this.update(task, { attemptHistory: [...(task.attemptHistory || []), prior], noActionRecovery: true,guardedFillRecovery:guardedFillOnly||task.guardedFillRecovery,
        attemptBoundary: null, baselineEvidence: '', targetId: guardedFillOnly?task.targetId:null, browserInstance: guardedFillOnly?task.browserInstance:null,
        status: 'pending', siteStatus: 'not_submitted', controller: 'executor', attentionType: '',
        profileSnapshot: profile, profileRevision: snapshot.revisions.siteProfiles, submitResult: null,
        reason: '已核验旧动作未发生产品投稿，保留证据后仅恢复原任务' }, 'retry_after_proven_no_action');
      await this.synchronize(); return this.status();
    }
    if (action === 'openEntry' || action === 'googleLogin') {
      const authObservation=action==='googleLogin'?logoutAuthObservation(task,input):null;
      if (this.job || this.store.get('paused') !== true || !authObservation&&(task.attemptBoundary || task.receipt ||
          task.status !== 'needs_manual')) throw new Error('只有暂停空闲、无投稿尝试的任务允许导航或基本登录');
      let page = await this.findPage(authObservation||task);
      if(authObservation && !task.authObservationTargetId){
        await this.lease(task);this.update(task,{authObservationTargetId:authObservation.targetId,authenticationHistory:[...(task.authenticationHistory||[]),{at:new Date().toISOString(),kind:'inventory_authentication_only',attemptBoundary:task.attemptBoundary,artifactRef:task.artifactRef,actualSubmission:task.actualSubmission,submitResult:task.submitResult,networkResponses:task.networkResponses}]},'inventory_auth_registered');await this.synchronize();
      }
      if(action==='googleLogin' && input.step==='findPopup') {
        const popup=await findGooglePopup(this.context,page);
        const session=await this.context.newCDPSession(popup);
        const targetId=(await session.send('Target.getTargetInfo')).targetInfo.targetId;await session.detach();
        const file=path.join(this.home,task.id+'-'+Date.now()+'-login-popup.png');await popup.screenshot({path:file});
        await this.lease(task);
        this.update(task,{authTargetId:targetId,authBrowserInstance:this.host.startedAt,
          authPages:[...(task.authPages || []),{at:new Date().toISOString(),targetId,browserInstance:this.host.startedAt,
            openerTargetId:task.targetId,url:new URL(popup.url()).origin+new URL(popup.url()).pathname,retainReason:'原任务基本 Google 登录待完成'}],
          screenshot:file,artifactRef:''},'google_popup_registered');
        await this.synchronize();return this.status();
      }
      if(action==='googleLogin' && input.step!=='openGoogle' && task.authTargetId)
        page=await this.findPage({targetId:task.authTargetId,browserInstance:task.authBrowserInstance});
      const before = new URL(page.url());
      let control;
      if (action === 'openEntry') {
        const next = new URL(input.href, page.url());
        if (next.origin !== new URL(task.url).origin || !/^https?:$/.test(next.protocol)) throw new Error('只能打开原站页面上观察到的同站入口');
        const links = page.locator('a[href]').filter({ visible: true });
        let match;
        for (const link of await links.all()) {
          const observed = new URL(await link.getAttribute('href'), page.url());
          if (observed.origin === next.origin && observed.pathname === next.pathname) { match = link; break; }
        }
        if (!match) throw new Error('入口链接未在原页核实');
        control = match;
      } else if (input.step === 'openSignIn' && before.hostname === '10015.io') {
        control=page.locator('.modal.open button').filter({hasText:/^Sign in$/});
      } else if (input.step === 'openSignIn' && before.hostname === 'aitach.com') {
        control=page.getByRole('link',{name:'Login to submit a tool',exact:true});
      } else if (input.step === 'openGoogle') {
        if (before.hostname !== new URL(task.url).hostname) throw new Error('必须从原站 Google 按钮开始');
        control = page.getByRole('button', { name: /^(?:Sign in|Continue|Log in|Login|Sign up|Connect) with Google$/i });
        if(await control.count()!==1 && before.hostname==='10015.io')control=page.locator('button#google').filter({hasText:/^Continue with Google$/});
        if (await control.count() !== 1) control = page.getByRole('link', { name: /^(?:Sign in|Continue|Log in|Login|Sign up|Connect) with Google$/i });
        if(await control.count()!==1&&before.hostname==='aitach.com')control=page.locator('a[href="https://aitach.com/social-auth/google"],a[href="/social-auth/google"]').filter({visible:true});
      } else {
        if (before.hostname !== 'accounts.google.com') throw new Error('当前不是 Google 官方账号选择页');
        const text = await page.evaluate(()=>document.body.innerText);
        if (/Google hasn.t verified|unverified app|unsafe|不安全|未验证|access.*(?:Drive|Gmail|Calendar)|读取.*(?:邮件|云端硬盘|日历)/i.test(text)) throw new Error('Google 页面出现额外权限或安全提示，停止自动授权');
        if (input.step === 'chooseAccount') {
          const email = task.profileSnapshot?.fields?.['Business mail'];
          if (!email) throw new Error('没有核实的登录邮箱');
          control = page.getByText(email, { exact: true });
        } else if (input.step === 'continue') {
          control = page.getByRole('button', { name: /^(?:Continue|继续)$/ });
        } else throw new Error('不支持的基本登录步骤');
      }
      if (!control || await control.count() !== 1 || !await control.isVisible()) throw new Error('登录控件未唯一核实');
      await this.lease(task);
      if (action === 'openEntry') await page.goto(new URL(await control.getAttribute('href'),page.url()).href,{waitUntil:'domcontentloaded',timeout:45000});
      else await control.click({ timeout: 10000 });
      await new Promise(resolve=>setTimeout(resolve,2000));
      if(page.isClosed()) {
        this.update(task,{authPages:(task.authPages || []).map(p=>p.targetId===task.authTargetId?{...p,closedAt:new Date().toISOString(),disposition:'provider_closed_after_auth'}:p),authTargetId:null},'google_auth_popup_closed');
        page=await this.findPage(authObservation||task);
      }
      const current = new URL(page.url());
      const file = path.join(this.home, task.id + '-' + Date.now() + '-navigation.png');
      await capturePageEvidence(this.context,page,{path:file});
      this.update(task, { navigationHistory: [...(task.navigationHistory || []),
        { at: new Date().toISOString(), action, step: input.step, from: before.origin + before.pathname, to: current.origin + current.pathname }],
        screenshot: file, artifactRef: '', reason: '同一任务页面导航/基本登录步骤已执行，继续核实站方会话与表单' }, 'site_navigation');
      await this.synchronize();
      return this.status();
    }
    if (action === 'prepareRetry') {
      if (this.job || this.store.get('paused') !== true) throw new Error('恢复未投稿任务需要执行器暂停且空闲');
      if (task.status !== 'needs_manual' || task.siteStatus !== 'not_submitted' || task.attemptBoundary ||
          task.receipt || (task.attemptHistory || []).length || !input.expectedReason || task.reason !== input.expectedReason) {
        throw new Error('只能恢复状态一致、没有提交尝试或收件的原人工待办');
      }
      const snapshot = await this.cloud.request('snapshot');
      const profile = snapshot.documents.siteProfiles?.[task.profileId];
      if (!profile || priorProductSuccess(snapshot.documents.submissionRecords, task.profileId, task.url)) {
        throw new Error('资料缺失或最新云端已有本站成功记录，禁止再次提交');
      }
      await this.lease(task);
      const prior = { at: new Date().toISOString(), reason: task.reason, attentionType: task.attentionType,
        profileRevision: task.profileRevision, targetId: task.targetId, browserInstance: task.browserInstance,
        tabClosedAt: task.tabClosedAt, tabRetainReason: task.tabRetainReason,
        screenshot: task.screenshot, artifactRef: task.artifactRef, artifactSha256: task.artifactSha256,
        actualSubmission: task.actualSubmission };
      this.update(task, { preparationHistory: [...(task.preparationHistory || []), prior],
        status: 'pending', siteStatus: 'not_submitted', controller: 'executor',
        targetId: null, browserInstance: null, baselineEvidence: '', attentionType: '', submitResult: null,
        tabClosedAt: null, tabRetainReason: null, deferredRecovery: null,
        profileSnapshot: profile, profileRevision: snapshot.revisions.siteProfiles,
        reason: '保留原未投稿证据，使用最新云端资料重新观察；只允许逐站放行' }, 'unsubmitted_retry_prepared');
      await this.synchronize();
      return this.status();
    }
    if (action === 'retryAfterLogin') {
      if (this.job || this.store.get('paused') !== true) throw new Error('登录后恢复需要先暂停并等待当前动作结束');
      if (!/^https:\/\/(?:www\.)?bai\.tools\/submit-ai-tools\/?$/i.test(task.url) ||
          task.status !== 'needs_manual' || task.siteStatus !== 'not_submitted' || task.attentionType !== 'login' ||
          !task.attemptBoundary || task.attemptBoundary !== input.expectedAttemptBoundary || task.receipt ||
          (task.attemptHistory || []).length) throw new Error('只能恢复一次已核验为未投稿的 BAI 登录待办');
      if (!this.context) await this.connect();
      const accountPage = this.context.pages().find(p => p.url() === 'https://bai.tools/my');
      if (!accountPage) throw new Error('需要先打开已登录账户的 My Submits 独立核验');
      await accountPage.reload({ waitUntil: 'networkidle', timeout: 20000 });
      if (accountPage.url() !== 'https://bai.tools/my' || await accountPage.locator('table').count() !== 1) throw new Error('账户投稿清单未能完整核验');
      const account = await accountPage.evaluate(async () => {
        const response = await fetch('/api/auth/session');
        const session = await response.json();
        return { signedIn: response.ok && !!session?.user, name: session?.user?.name };
      });
      if (!account.signedIn) throw new Error('站方登录尚未完成');
      const snapshot = await this.cloud.request('snapshot');
      const profile = snapshot.documents.siteProfiles?.[task.profileId];
      if (!profile || priorProductSuccess(snapshot.documents.submissionRecords, task.profileId, task.url)) throw new Error('资料缺失或最新云端已有本站成功记录，禁止再次提交');
      const productHost = new URL(profile.url || profile.fields?.Url).hostname.replace(/^www\./, '').toLowerCase();
      const inventory = await accountPage.locator('table').innerText();
      if (!productHost || inventory.toLowerCase().includes(productHost)) throw new Error('账户已存在该产品投稿，禁止再次提交');
      const proofPath = path.join(this.home, `${task.id}-${Date.now()}-login-inventory.png`);
      await accountPage.screenshot({ path: proofPath });
      await this.lease(task);
      const previous = { at: task.attemptBoundary, reason: task.reason, screenshot: task.screenshot,
        artifactRef: task.artifactRef, artifactSha256: task.artifactSha256, actualSubmission: task.actualSubmission };
      this.update(task, { attemptHistory: [previous], attemptBoundary: null, baselineEvidence: '',
        targetId: null, browserInstance: null, status: 'pending', siteStatus: 'not_submitted', controller: 'executor',
        reason: '站方登录完成且账户投稿清单无本产品，保留旧登录跳转证据后只允许一次逐站恢复', attentionType: '', submitResult: null,
        profileSnapshot: profile, profileRevision: snapshot.revisions.siteProfiles,
        loginVerification: { at: new Date().toISOString(), url: accountPage.url(), accountName: account.name, inventory },
        screenshot: proofPath, artifactRef: '' }, 'retry_after_verified_login');
      await this.synchronize();
      return this.status();
    }
    if (action === 'takeover') {
      await this.synchronize();
      task = this.store.get(`task:${input.taskId}`);
      if(input.surface==='workbench'){
        if(this.store.get('offlineMode')?.enabled||task.attemptBoundary||task.receipt||!['pending','needs_manual'].includes(task.status)||!/^https?:\/\//.test(task.url))throw Error('工作台只能接管未提交的原任务；已有尝试或回执请先核验');
        const controllerId=`supervisor-${randomUUID()}`;
        const handoff=await this.cloud.request('handoff',{taskId:task.id,version:task.version,previousControllerId:task.controllerId,controllerId});
        this.update(task,{version:handoff.version,controllerId,controller:'supervisor',status:'needs_manual',
          workbenchHandoff:{at:new Date().toISOString(),url:task.url,previousReason:task.workbenchHandoff?.previousReason||task.reason||''},
          reason:'已在普通浏览器工作台接管；原阻塞：'+(task.workbenchHandoff?.previousReason||task.reason||'待核对')},'workbench_takeover');
        await this.synchronize();
        return{...this.status(),takeover:{surface:'workbench',url:task.url,taskId:task.id,profileId:task.profileId}};
      }
      const page = await this.findPage(task); await page.bringToFront();
      const controllerId = `supervisor-${randomUUID()}`;
      const handoff = await this.cloud.request('handoff', { taskId: task.id, version: task.version, previousControllerId: task.controllerId, controllerId });
      task.version = handoff.version; task.controllerId = controllerId;
      this.update(task, { controller: 'supervisor', reason: '本站已交给监工；自动执行已暂停' }, 'takeover');
      await this.synchronize();
      return { ...this.status(), takeover: { endpoint: this.host.endpoint, targetId: task.targetId, url: page.url(), profileId: task.profileId, browserInstance: task.browserInstance } };
    }
    if (action === 'continueTask') {
      if (this.job) throw new Error('请先暂停并等待当前操作结束');
      if(task.workbenchHandoff)throw Error('工作台接管的站点请在外链总览登记实际结果；未经提交核验不能交回自动执行');
      if (task.attemptBoundary) throw new Error('已有提交尝试，只能先核验，禁止自动重投');
      if (task.controller !== 'supervisor') throw new Error('请先接管并处理本站待办');
      if (!input.supervisorDisconnected) throw new Error('需要监工断开确认后才能交回控制权');
      await this.synchronize();
      const handoff = await this.cloud.request('handoff', { taskId: task.id, version: task.version, previousControllerId: task.controllerId, controllerId: this.controllerId });
      this.update(task, { version: handoff.version, controllerId: this.controllerId, controller: 'executor', status: 'pending', reason: '人工处理完成，重新观察并校验' }, 'returned_to_executor');
      await this.synchronize();
      return this.status();
    }
    if (action === 'retryRejected') {
      if (this.job) throw new Error('请先暂停并等待当前操作结束');
      if (task.status !== 'needs_manual' || task.siteStatus !== 'rejected' || task.attentionType !== 'validation' ||
          !task.attemptBoundary || task.receipt || (task.attemptHistory || []).length ||
          !String(input.expectedError || '').trim() || !task.reason?.includes(input.expectedError)) {
        throw new Error('只有一次明确的站方校验拒绝才能在原任务上修正重试');
      }
      const page = await this.findPage(task);
      let visibleRejection = false;
      for (const frame of page.frames()) {
        if (await frame.getByText(input.expectedError, { exact: false }).first().isVisible().catch(() => false)) {
          visibleRejection = true; break;
        }
      }
      if (new URL(page.url()).hostname !== new URL(task.url).hostname ||
          !visibleRejection) {
        throw new Error('原目标页上已找不到明确的站方校验错误，停止重试');
      }
      const previous = { at: task.attemptBoundary, reason: task.reason, screenshot: task.screenshot,
        artifactRef: task.artifactRef, artifactSha256: task.artifactSha256, actualSubmission: task.actualSubmission };
      this.update(task, { attemptHistory: [previous], attemptBoundary: null, baselineEvidence: '',
        status: 'pending', siteStatus: 'not_submitted', reason: '站方明确校验拒绝后，保留旧尝试并修正原表单',
        attentionType: '', submitResult: null }, 'retry_after_explicit_validation_rejection');
      await this.synchronize();
      return this.status();
    }
    if (action === 'correctReceiptStatus') {
      if (this.job) throw new Error('请先暂停并等待当前操作结束');
      if (task.status !== 'finished' || task.siteStatus !== 'accepted' || !task.cloudVerified ||
          task.receipt?.evidence !== input.expectedEvidence ||
          !['submitted','pending_moderation'].includes(task.receipt?.publicationStatus) ||
          input.publicationStatus !== 'pending_moderation') throw new Error('只能修正同一已回读收件的审核状态');
      const updated = await this.cloud.request('receipt-status', { taskId: task.id,
        expectedEvidence: input.expectedEvidence, status: 'pending_moderation' });
      if (updated.record?.publicationStatus !== 'pending_moderation' || updated.record?.taskId !== task.id) throw new Error('站方审核状态回读不一致');
      this.update(task, { receipt: { ...task.receipt, publicationStatus: 'pending_moderation' },
        reason: '站方明确收件，等待审核', completedAt: new Date().toISOString(), cloudRevision: updated.revision }, 'receipt_status_corrected');
      await this.synchronize();
      return this.status();
    }
    if (action === 'verify') {
      if (this.job) throw new Error('请先暂停并等待当前操作结束');
      if (task.receipt && task.cloudVerified) return this.synchronize();
      if (!task.attemptBoundary) throw new Error('尚无提交尝试；请接管处理表单');
      const page = await this.findPage(task);
      for (const frame of page.frames()) {
        let engine;
        try {
          engine = await attachEngine(this.context, frame);
          const evidence = await engine.call({ action: 'classifySubmitEvidence', destinationUrl: task.url });
          if (evidence.matched && evidence.evidence && evidence.evidence !== task.baselineEvidence) { await this.accept(task, page, evidence); break; }
        } finally { await engine?.detach(); }
      }
      await this.synchronize(); return this.status();
    }
    if (action === 'review') {
      await this.synchronize();
      const result = await this.cloud.request('review', { taskId: task.id, reviewStatus: input.reviewStatus });
      task.reviewStatus = result.task.reviewStatus; this.store.set(`task:${task.id}`, task); return this.status();
    }
    throw new Error('未知控制操作');
  }
  async batchModelRequest(task,route,body,options){reserveBatchModelCall(this,task);const batch=task.workbenchBatchId&&this.store.get('workbenchBatch:'+task.workbenchBatchId);if(batch?.cloudRecoveryVersion===1){const event=this.update(task,{},'workbench_model_reserved');await originalTaskSync(()=>flushBatchTaskEvents(this,task,event.id));if(!batchActionAllowed(this,task)||this.store.get('paused')!==false&&!hasManualSubmissionConsent(this,task))throw Object.assign(Error('原批次已暂停，预算保留且未调用模型'),{batchPaused:true});}return this.cloud.request(route,body,undefined,options);}
  async bridge(task, message) {
    if(message.action==='captchaResolved')return this.dispatchControl?this.dispatchControl('checkCaptchaResumes',{taskId:task.id,expectedDocumentId:message.executorDocumentId,frameUrl:message.executorFrameUrl}):checkCaptchaResumes(this,{taskId:task.id,expectedDocumentId:message.executorDocumentId,frameUrl:message.executorFrameUrl});
    if(message.action==='mediaUploadStatus')return recordTaskMediaUpload(this,task,message);
    if(message.action==='saveFillLearnings'){
      const current=this.store.get('task:'+task.id);if(!current||current.targetId!==task.targetId||current.browserInstance!==task.browserInstance||current.profileId!==task.profileId||current.runId!==task.runId||current.profileRevision!==task.profileRevision||['ai','supervisor'].includes(current.controller))return{ok:false,error:'原字段学习任务已变化'};
      return captureFillLearning(this,{profileId:task.profileId,profile:task.profileSnapshot,taskId:task.id,targetId:task.targetId,browserInstance:task.browserInstance,profileRevision:task.profileRevision},message);
    }
    if(message.action==='log'){this.store.appendLog({at:new Date().toISOString(),type:'form_engine',runId:task.runId,taskId:task.id,profileId:task.profileId,url:task.url,message:String(message.msg||'').slice(0,4000),level:['warn','err','ok'].includes(message.cls)?message.cls:'info'});return{ok:true};}
    if(message.action==='generateCommentDrafts')return originalCommentRequest(this,{pageUrl:message.pageUrl,pageTitle:message.pageTitle,pageText:message.pageText,count:message.count,maxChars:message.maxChars,allowLink:message.allowLink,config:message.config,language:message.language,tone:message.config?.blogRules?.tone,refresh:message.refresh},payload=>this.batchModelRequest(task,'ai/comment',payload));
    if (message.action === 'fetchCloudSubmissionMedia') return await originalTaskMediaEvidence(this,task,message.ref)||this.cloud.request('media', { taskId: task.id, action:message.action,ref:message.ref });
    if(message.action==='fetchSubmissionMedia'){
      const config=plain(profiles.buildAgentConfigFromProfile(task.profileSnapshot||{}));
      const entries=[['logo',config.logoUrl],['featured',config.featuredImage],...(config.screenshots||[]).map((ref,index)=>['screenshot'+(index+1),ref])];
      const entry=entries.find(([,ref])=>ref&&ref===message.url);
      if(!entry)return{ok:false,error:'素材不属于原任务产品资料'};
      const file=await materializeTaskMedia(this,task,config,entry[0],{useEmbeddedLogo:false}),used=task.usedMedia.find(m=>m.kind===entry[0]);
      return{ok:true,dataUrl:'data:'+used.mime+';base64,'+(await readFile(file)).toString('base64')};
    }
    return { ok: false, error: '请使用资料中已上传的云端素材；未配置的内容服务进入待办' };
  }
}

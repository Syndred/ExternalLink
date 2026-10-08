import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { Runtime } from './runtime.mjs';
import { Cloud } from './cloud.mjs';
import { isDeepStrictEqual } from 'node:util';
import {capturePageEvidence} from './page-evidence.mjs';
import {CredentialVault} from './credential-vault.mjs';
import {GmailSync} from './gmail-sync.mjs';
import {enqueueProfileMutation,resolveApplicationConflict} from './application-mutations.mjs';
import {enqueueMediaUpload} from './media-uploads.mjs';
import {recoverDataJobs,checkMonitorSchedule} from './link-monitor.mjs';
import {setupInfo,connectWorkbench} from './workbench-connect.mjs';
import {resetWorkspace} from './workspace-reset.mjs';
import {connectionIdentity,connectionProfiles,connectionHistory,previewConnection,commitConnection} from './workbench-connections.mjs';
import {checkBrowserAssistant,stopBrowserAssistant} from './browser-assistant.mjs';
import {singlePagePanel,sidepanelClosed} from './single-page.mjs';
import {checkTaskPageControls,stopTaskPageControls} from './task-page-controls.mjs';

const home = process.env.EXTERNALLINK_HOME || path.join(os.homedir(), '.externallink-executor');
await mkdir(home, { recursive: true });
const store = new Store(path.join(home, 'outbox.sqlite'));
store.acquireOwner();
const runtime = new Runtime(store, home);
const priorSinglePanel=singlePagePanel(runtime);if(priorSinglePanel?.open)sidepanelClosed(runtime,{panelId:priorSinglePanel.id});
recoverDataJobs(runtime);
const monitorScheduler=setInterval(()=>checkMonitorSchedule(runtime).catch(error=>console.error('外链监测计划：'+error.message)),60000);monitorScheduler.unref();
let gmailVaultScope=store.get('gmailCredentialScope')||home,gmail=new GmailSync({store,vault:new CredentialVault(gmailVaultScope)});gmail.start();
runtime.connectionExternalBusy=()=>gmail.syncing||gmail.refreshing||gmail.accountRefresh||store.get('gmail')?.status==='authorizing';
runtime.onConnectionChanging=async()=>{gmail.stop();await stopTaskPageControls(runtime);await stopBrowserAssistant(runtime);const panel=singlePagePanel(runtime);if(panel?.open)sidepanelClosed(runtime,{panelId:panel.id});};
runtime.onConnectionChanged=async()=>{const scope=store.get('gmailCredentialScope')||home;if(scope!==gmailVaultScope){gmail.stop();gmailVaultScope=scope;gmail=new GmailSync({store,vault:new CredentialVault(scope)});}gmail.start();};
runtime.onConnectionChangeAborted=async()=>gmail.start();
runtime.onWorkspaceReset=async()=>{gmail.stop();await stopTaskPageControls(runtime);await stopBrowserAssistant(runtime);};
const code = randomBytes(18).toString('base64url');
const codeExpires = Date.now() + 10 * 60 * 1000;
const match = (a, b) => { const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || '')); return x.length === y.length && timingSafeEqual(x, y); };
let serial = Promise.resolve(), pairUsed = false;
runtime.dispatchControl=(action,input)=>{const expected=connectionIdentity(store.get('pair')),result=serial.then(()=>runtime.withControl(()=>{if(expected!==connectionIdentity(store.get('pair')))throw Error('云端连接已切换，旧网页操作已停止');return runtime.control(action,input);}));serial=result.catch(()=>{});return result;};
const assistantScheduler=setInterval(()=>checkBrowserAssistant(runtime).catch(error=>console.error('浏览器助手：'+error.message)),5000);assistantScheduler.unref();
const manualWatchScheduler=setInterval(()=>{if(!runtime.controlBusy&&!runtime.connectionBusy&&!store.get('connectionExecutionHold'))runtime.dispatchControl('checkManualWatches',{}).catch(error=>console.error('人工提交核验：'+error.message));},2000);manualWatchScheduler.unref();
const captchaResumeScheduler=setInterval(()=>{if(!runtime.controlBusy&&!runtime.connectionBusy&&!store.get('connectionExecutionHold'))runtime.dispatchControl('checkCaptchaResumes',{}).catch(error=>console.error('原任务验证码恢复：'+error.message));},3000);captchaResumeScheduler.unref();
const taskPageControlsScheduler=setInterval(()=>checkTaskPageControls(runtime).catch(error=>console.error('原任务页面按钮：'+error.message)),2000);taskPageControlsScheduler.unref();
function send(res, data, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const pair = store.get('pair');
  const port = server.address().port;
  // Host check rejects DNS rebinding; no remote website gets CORS access.
  if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return send(res, { ok: false, error: 'Host 未授权' }, 403);
  const extensionOrigin = /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
  const localSetupOrigin=origin==='http://127.0.0.1:'+Number(process.env.EXTERNALLINK_WEB_PORT||19389);
  if (origin && !localSetupOrigin&&(!extensionOrigin || (pair && pair.origin !== origin))) return send(res, { ok: false, error: '插件来源未授权' }, 403);
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Workbench-Connection');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const route = new URL(req.url, 'http://localhost').pathname;
  if (!['/pair','/setupInfo','/setup'].includes(route) && !match(req.headers.authorization, `Bearer ${pair?.localToken}`)) return send(res, { ok: false, error: '尚未配对或本机凭据失效' }, 401);
  try {
    const bodyParts=[];let bodyBytes=0;
    for await (const chunk of req) { bodyBytes+=chunk.length;if(bodyBytes>(['/mediaUpload','/previewBackup','/previewRunHistory','/libraryMutation'].includes(route)?9:1)*1024*1024)throw new Error('请求过大');bodyParts.push(chunk); }
    const text=Buffer.concat(bodyParts).toString('utf8');
    const input = text ? JSON.parse(text) : {};
    if(route==='/setupInfo'&&req.method==='GET'){if(!localSetupOrigin)throw Error('请使用本机连接页面');send(res,await setupInfo(runtime));return;}
    if(route==='/setup'&&req.method==='POST'){if(!localSetupOrigin)throw Error('请使用本机连接页面');send(res,await connectWorkbench(runtime,input));return;}
    if (route === '/pair' && req.method === 'POST') {
      if (pairUsed || Date.now() > codeExpires || !extensionOrigin || !match(input.code, code)) return send(res, { ok: false, error: '配对码错误、过期或已使用；重新启动执行器生成新码' }, 403);
      if (pair) return send(res, { ok: false, error: '此设备已配对，请使用插件已保存的连接' }, 409);
      let enrolled;
      try { enrolled = JSON.parse(await readFile(path.join(home, 'enrollment.json'), 'utf8')); } catch {}
      if (!input.deviceToken && !enrolled) { send(res, { ok: true, requiresCloud: true }); return; }
      const config = input.deviceToken ? { endpoint: input.endpoint, workspaceId: input.workspaceId, deviceId: input.deviceId, deviceToken: input.deviceToken, storageBackend: input.storageBackend } : enrolled;
      const cloud = new Cloud(config);
      const snapshot = await cloud.request('snapshot');
      if (snapshot.deviceId !== config.deviceId || snapshot.workspaceId !== config.workspaceId) throw new Error('云端设备范围不匹配');
      const localToken = randomBytes(32).toString('base64url');
      store.set('pair', { ...config, origin, localToken }); pairUsed = true;
      send(res, { ok: true, localToken, deviceId: config.deviceId }); return;
    }
    if (route === '/status' && req.method === 'GET') { send(res, runtime.status()); return; }
    if (route.startsWith('/evidence/') && req.method === 'GET') {
      const task = store.get(`task:${route.slice('/evidence/'.length)}`);
      if (!task?.screenshot) throw new Error('该任务暂未保存截图');
      send(res, { ok: true, dataUrl: `data:image/png;base64,${(await readFile(task.screenshot)).toString('base64')}` }); return;
    }
    if (route === '/catalog' && req.method === 'GET') { const snapshot = await runtime.cloud.request('snapshot'); send(res, { ok: true, profiles: snapshot.documents.siteProfiles, revision: snapshot.revisions.siteProfiles }); return; }
    if (req.method !== 'POST') { send(res, { ok: false, error: '接口不存在' }, 404); return; }
    const arrivedConnectionId=connectionIdentity(pair);
    const operation = async () => {
      const expectedId=req.headers['x-workbench-connection']||arrivedConnectionId;
      if(expectedId&&expectedId!==connectionIdentity(store.get('pair'))&&route!=='/commitConnection')throw Object.assign(Error('云端连接已切换，请刷新页面；旧请求未写入新工作区'),{status:409});
      if(route==='/connectionProfiles')return connectionProfiles(runtime);
      if(route==='/connectionHistory')return connectionHistory(runtime,input);
      if(route==='/previewConnection')return previewConnection(runtime,input);
      if(route==='/commitConnection')return commitConnection(runtime,input,{expectedId});
      if(['/localRecoverySources','/previewLocalRecovery','/submissionJournalRecoverLocal'].includes(route))return runtime.control(route.slice(1),input);
      if(['/sidepanelOpened','/sidepanelClosed','/sidepanelDetect','/sidepanelFill'].includes(route))return runtime.control(route.slice(1),input);
      if(['/clearSiteAnnotation','/getBatchLog','/manualSkip','/manualSubmit','/previewManualConfirmation','/confirmSubmissionSuccess','/stop','/getSubmissionQueue','/advanceSubmission','/removeFromSubmissionQueue'].includes(route))return runtime.control(route.slice(1),input);
      if(['/runExportSources','/exportBatchReport','/exportAutomationRun'].includes(route))return runtime.control(route.slice(1),input);
      if(['/localRunHistorySources','/previewLocalRunHistory','/previewRunHistory','/importRunHistory','/runHistoryUploadStart','/runHistoryUploadPart','/runHistoryUploadComplete'].includes(route))return runtime.control(route.slice(1),input);
      if(route==='/saveAssistantSettings')return runtime.control('saveAssistantSettings',input);
      if(route==='/requestAutoFill')return runtime.control('requestAutoFill',input);
      if(route==='/resetWorkspace')return resetWorkspace(runtime,input);
      if(route==='/gmailStatus')return{ok:true,gmail:gmail.status()};
      if(route==='/gmailMessage')return{ok:true,message:gmail.message(input.messageId)};
      if(route==='/gmailConfigure')return{ok:true,gmail:await gmail.configure(input.client)};
      if(route==='/gmailAuthorize')return gmail.authorize();
      if(route==='/gmailSync')return{ok:true,gmail:await gmail.sync()};
      if(route==='/gmailRefresh')return{ok:true,gmail:await gmail.refresh()};
      if(route==='/resolveConflict')return resolveApplicationConflict(runtime,input);
      if(route==='/mediaUpload')return enqueueMediaUpload(runtime,input);
      if(['/workbenchDocuments','/journalProgress','/journalFlush','/workbenchPending'].includes(route))return runtime.control(route.slice(1),input);
      if(route==='/basicGoogleLogin')return runtime.control('basicGoogleLogin',input);
      if(route==='/prepareTask')return runtime.control('prepareTask',input);
      if(route==='/registerAcceptance')return runtime.control('registerAcceptance',input);
      if(route==='/runTask')return runtime.control('runTask',input);
      if(route==='/startAcceptance')return runtime.control('startAcceptance',input);
      if(['/appData','/taskDetails','/libraryMutation','/previewBatch','/startBatch','/extractProfile','/generateProfile','/commentDrafts','/detectOriginalTask','/commentHistory','/mediaLibrary','/browserLibraryPages','/addBrowserPage','/cloudSyncStatus','/cloudSyncPush','/cloudSyncPull','/previewCloudPull','/commitCloudPull','/saveCommentVersion','/quickOpenLibrary','/fillCommentDraft','/exportBackup','/previewBackup','/importBackup','/backupUploadStart','/backupUploadPart','/backupUploadComplete','/startDomainAge','/startLinkMonitor','/dismissMonitorAlert','/startPublicLibrarySync'].includes(route))return runtime.control(route.slice(1),input);
      if (route === '/preview') return runtime.preview(input);
      if (route === '/annotate') {
        const task = store.get(`task:${input.taskId}`); if (!task) throw new Error('任务不存在');
        if (runtime.job) throw new Error('请先暂停并等待当前动作结束');
        const resolvedOutcomes = {
          rejected_no_receipt: { status: 'needs_manual', siteStatus: 'rejected' },
          login_gate_no_receipt: { status: 'needs_manual', siteStatus: 'not_submitted' },
          no_submit_action: { status: 'needs_manual', siteStatus: 'not_submitted' },
          non_submission_action: { status: 'needs_manual', siteStatus: 'not_submitted' },
        };
        if(input.parkUnsubmitted===true&&(input.outcome||task.attemptBoundary||task.receipt||!['pending','needs_manual'].includes(task.status)||!String(input.reason||'').trim()))throw new Error('只能明确标记未发生投稿尝试的原任务');
        const outcome = input.parkUnsubmitted===true?{status:'needs_manual',siteStatus:'not_submitted'}:input.outcome ? resolvedOutcomes[input.outcome] : null;
        if (input.outcome && (!outcome || !task.attemptBoundary || task.receipt || !String(input.reason || '').trim())) throw new Error('只有已核验且无回执的提交尝试才能标记明确结果');
        if (input.outcome === 'no_submit_action' && task.submitResult?.clickedSubmit !== false && task.submitResult?.reason !== 'no_submit_button') throw new Error('不能把已点击的提交尝试标为未发生动作');
        const page = await runtime.findPage(task);
        if (input.outcome === 'non_submission_action' &&
            (task.actualSubmission?.fields?.length || task.fill?.filledCount || !/[?&]s=&post_type=product(?:&|$)/.test(page.url()))) {
          throw new Error('未能证明误入站内搜索，不能标记为未投稿');
        }
        const screenshot = path.join(home, `${task.id}-${Date.now()}-note.png`);
        await capturePageEvidence(runtime.context,page,{path:screenshot});
        runtime.update(task, { ...outcome, reason: String(input.reason || '').slice(0,2000), attentionType: String(input.attentionType || 'manual').slice(0,60), screenshot, artifactRef: '' }, 'operator_note');
        await runtime.synchronize(); return runtime.status();
      }
      if (route === '/profile') {
        return enqueueProfileMutation(runtime,input);
      }
      if (route === '/start') return runtime.start(input);
    if (route === '/startLibrary') return runtime.startLibrary(input);
      if (route === '/sync') { if (runtime.job) await runtime.job;const offline=store.get('offlineMode');if(offline?.enabled){store.set('offlineMode',{...offline,enabled:false,syncStartedAt:new Date().toISOString()});try{return await runtime.synchronize();}catch(error){store.set('offlineMode',{...offline,enabled:true,lastSyncError:error.message,lastSyncAttemptAt:new Date().toISOString()});throw error;}}return runtime.synchronize(); }
      if (['/pause','/resume','/offlineResume','/runOne','/takeover','/continueTask','/verify','/review','/prepareRetry','/retryRejected','/retryAfterLogin','/correctReceiptStatus','/connectHost','/attachPage','/openAuthPage','/openEntry','/googleLogin','/retryNoAction','/closeTaskTab','/archiveDeferredTabs','/openRecoveryTask','/observeTask','/closeObservation','/claimTask','/authorizeMarketing','/registerAccount','/verifyRegistration','/retryPrefillOnly','/finishProductPreview','/annotateObservation','/advancePlan','/inspectCookiePreferences','/verifyPlanStage','/enableFunctionalCookies','/acceptAuthorizedCookies','/recoverToolScoutLogout','/continueUnsubmitted','/finishCommunityVisit','/requestLoginLink','/restoreLostPreparation'].includes(route)) return runtime.control(route.slice(1), input);
      throw new Error('接口不存在');
    };
    const result = serial.then(() => runtime.withControl(operation)); serial = result.catch(() => {});
    send(res, await result);
  } catch (error) { if(error.cloudNetwork)runtime.cloudError=error.message;send(res, { ok: false, error: error.message }, error.status || 400); }
});
server.requestTimeout = 90000;
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(Number(process.env.EXTERNALLINK_PORT || 19388), '127.0.0.1', resolve); });
await writeFile(path.join(home, 'server.json'), JSON.stringify({ pid: process.pid, endpoint: `http://127.0.0.1:${server.address().port}`, startedAt: new Date().toISOString() }));
// This local handoff file is outside the repository and contains no cloud token.
await writeFile(path.join(home, 'pairing.txt'), store.get('pair') ? '设备已配对，打开原插件运行工作台。' : `执行器地址：http://127.0.0.1:${server.address().port}\n一次性配对码：${code}\n有效期：10 分钟\n`);
console.log(store.get('pair') ? 'ExternalLink 执行器已恢复配对。' : `ExternalLink 配对信息：${path.join(home, 'pairing.txt')}`);
setInterval(() => runtime.tick(), 2000).unref();
process.on('SIGTERM', () => { gmail.stop(); server.close(); store.close(); process.exit(); });

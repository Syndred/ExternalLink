import './shared.mjs';
import {enqueueLibraryMutation,overlayApplication} from './application-mutations.mjs';
import {canonicalLibraryDestination} from '../../core/library-records.mjs';
import {workbenchScope} from './workbench-sync.mjs';
import {applyOriginalDestinationDisposition} from './original-destination-disposition.mjs';
import {cacheCloudSnapshot,cloudDigest} from './cloud-sync-state.mjs';

export async function classifyOriginalSite(runtime,{url,reason='',fallbackStatus='broken',assertCurrent=async()=>{}}){
 if(!url)return null;await assertCurrent();const scope=workbenchScope(runtime.store.get('pair')),status=globalThis.ExtLinkQueue.classifyStatusFromReason(reason,fallbackStatus);
 if(runtime.store.get('applicationSnapshot')?.scope!==scope&&!runtime.store.get('offlineMode')?.enabled){const identity=cloudDigest(runtime.store.get('pair')),snapshot=await runtime.cloud.request('snapshot');await assertCurrent();if(identity!==cloudDigest(runtime.store.get('pair'))||scope!==workbenchScope(runtime.store.get('pair')))throw Object.assign(Error('原连接已变化，自动观察停止'),{staleTask:true});cacheCloudSnapshot(runtime,snapshot);}
 const result=await enqueueLibraryMutation(runtime,{operation:{type:'automatic_mark',url,status,note:String(reason).slice(0,10000)}});
 await assertCurrent();if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已变化，自动观察保留在原工作区');
 const saved=runtime.store.get('applicationSnapshot'),annotation=saved?.scope===scope?overlayApplication(runtime,saved.snapshot).documents.siteAnnotations?.[canonicalLibraryDestination(url)]:undefined;
 return{status,annotation,mutationId:result.id,pending:result.pending||0,advance:false,keepTab:true};
}
export async function classifyOriginalFillGate(runtime,{url,fill,assertCurrent}){
 const gate=fill.agentResult||{};if(gate.semanticReview)return null;
 if(gate.needs_manual)return classifyOriginalSite(runtime,{url,reason:gate.reason||'需要人工处理',fallbackStatus:'needs_manual',assertCurrent});
 if(gate.captcha)return classifyOriginalSite(runtime,{url,reason:'请完成验证码',fallbackStatus:'needs_captcha',assertCurrent});
 if(gate.blocked)return classifyOriginalSite(runtime,{url,reason:gate.reason||'无法提交',fallbackStatus:'broken',assertCurrent});
 return null;
}

export function originalTaskGate(result={}){
 if(result.semanticReview||result.uncertain||result.payment_uncertain||result.humanGate==='payment_uncertain'||result.matched)return null;
 if(result.captcha||result.gate==='captcha'||result.humanGate==='captcha'||result.status==='needs_captcha')return{reason:'验证码已出现 — 页签留下，请完成后继续',fallbackStatus:'needs_captcha'};
 if(result.gate==='otp'||result.status==='needs_otp')return{reason:result.reason||'需要一次性验证码',fallbackStatus:'needs_otp'};
 if(result.gate==='login'||result.status==='needs_login')return{reason:result.reason||'需要登录',fallbackStatus:'needs_login'};
 if(result.needs_manual||result.status==='needs_manual')return{reason:result.reason||'需要人工处理',fallbackStatus:'needs_manual'};
 if(result.blocked||result.status==='blocked')return{reason:result.reason||'无法提交',fallbackStatus:'broken'};
 return null;
}
export function originalLinkrenaPostSubmitLogin(beforeUrl,afterUrl){
 try{const before=new URL(beforeUrl),after=new URL(afterUrl);return before.hostname==='linkrena.com'&&before.pathname==='/submit'&&after.hostname==='linkrena.com'&&after.pathname==='/login'&&after.searchParams.get('callbackUrl')==='/submit';}catch{return false;}
}
export async function classifyOriginalTaskGate(runtime,{task,page,result,active=()=>true,assertPageDocument=async()=>{}}){
 const gate=originalTaskGate(result);if(!gate)return null;
 const scope=workbenchScope(runtime.store.get('pair')),original={runId:task.runId,profileId:task.profileId,targetId:task.targetId,browserInstance:task.browserInstance,profileRevision:task.profileRevision,version:task.version,controller:task.controller,attemptBoundary:task.attemptBoundary},profile=JSON.stringify(task.profileSnapshot),pageUrl=page.url();
 const check=()=>{const current=runtime.store.get('task:'+task.id);if(!active()||!current||['ai','supervisor'].includes(current.controller)||scope!==workbenchScope(runtime.store.get('pair'))||Object.entries(original).some(([key,value])=>current[key]!==value)||JSON.stringify(current.profileSnapshot)!==profile||current.receipt||runtime.store.get('executionStopped')||runtime.store.get('connectionExecutionHold')||page.isClosed()||page.url()!==pageUrl)throw Object.assign(Error('原任务、资料或网页已变化，自动观察停止'),{staleTask:true});};
 const assertCurrent=async()=>{check();await assertPageDocument();check();};
 const classification=await classifyOriginalSite(runtime,{url:task.url,...gate,assertCurrent});await assertCurrent();
 runtime.update(task,{siteAutomaticObservation:{...gate,status:classification.status,mutationId:classification.mutationId,pending:classification.pending,at:new Date().toISOString()}},'site_automatic_observation');
 classification.disposition=await applyOriginalDestinationDisposition(runtime,{task,page,result,classification,assertCurrent});
 return classification;
}

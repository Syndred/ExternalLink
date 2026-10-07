import './shared.mjs';
import {enqueueLibraryMutation,overlayApplication} from './application-mutations.mjs';
import {canonicalLibraryDestination} from '../../core/library-records.mjs';
import {workbenchScope} from './workbench-sync.mjs';

export async function classifyOriginalSite(runtime,{url,reason='',fallbackStatus='broken',assertCurrent=async()=>{}}){
 if(!url)return null;await assertCurrent();const scope=workbenchScope(runtime.store.get('pair')),status=globalThis.ExtLinkQueue.classifyStatusFromReason(reason,fallbackStatus);
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

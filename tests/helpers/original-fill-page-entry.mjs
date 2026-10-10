import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
const baseline='bd916b2944a577b160a6afcb8a7d73d263044c0c';
const source=execFileSync('git',['show',baseline+':extension/sidepanel.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const handler=source.match(/^  async function fillPage\([^]*?^  \}/m)?.[0];if(!handler)throw Error('Complete original fillPage not found');
export const originalFillPageSource={baseline,path:'extension/sidepanel.js',lines:handler.split('\n').length,sha256:createHash('sha256').update(handler).digest('hex')};
export async function originalFillPageEntry(options={}){
 const calls=[],buttons=Object.fromEntries(['btnFillComment','btnFillForm','btnSubmitPage'].map(id=>[id,{textContent:id,disabled:false}]));
 const context=vm.createContext({activeTabId:1,currentPageUrl:'https://original.invalid/old',activeSiteId:'old',siteProfiles:{p:{id:'p'}},commentAvailability:{available:!options.unavailable,reason:'Comment unavailable'},productHuntReadyToCreateTabId:options.productHunt?7:null,
  refreshActiveTab:async()=>{calls.push('refresh');context.activeTabId=options.noTab?null:7;context.currentPageUrl='https://original.invalid/new';context.activeSiteId='p';},
  captureFillContext:(tabId,url,profileId)=>({tabId,url,profileId}),P:{profileConfigured:()=>!options.noProfile},chrome:{runtime:{openOptionsPage(){calls.push('openOptions');}}},
  $:id=>id==='spCommentText'?{value:'  Original 中文🙂  '}:options.noButton?null:buttons[id],showToast:(text,error)=>calls.push({toast:text,error}),resetMediaUploadState:()=>calls.push('resetMedia'),setAutoFillStatus:(text,state)=>calls.push({status:text,state}),
  runSidepanelFill:async input=>{calls.push({request:input});if(options.requestError)throw Error('Controlled request failure');return options.result;},
  handleFillResult:async(result,mode,owner)=>{calls.push({handled:result,mode,owner});if(options.handlerError)throw Error('Controlled handler failure');},setWorkflowStep:step=>calls.push({step}),updateProductHuntFillButton:()=>calls.push('restoreFormButton')});
 vm.runInContext(handler,context);await context.fillPage(options.mode||'form',{submit:!!options.submit});return JSON.parse(JSON.stringify({calls,buttons}));
}

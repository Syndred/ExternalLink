import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {originalLibraryGlobals} from './original-library-catalog.mjs';

const ref='bd916b2944a577b160a6afcb8a7d73d263044c0c';
const source=execFileSync('git',['show',ref+':extension/sidepanel.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
function originalFunction(name){const match=source.match(new RegExp('^  (?:async )?function '+name+'\\([^]*?^  }','m'));if(!match)throw Error('Original sidepanel function missing '+name);return match[0];}

// Execute the original notification, receipt decision, close guard and next-tab
// functions. Only browser I/O and the refreshed pending queue are supplied.
export async function originalSinglePageReceipt({url='https://bai.tools/submit',nextUrl='https://alieradox.com/submit',owned=true,selected=true,profileMatches=true,pageMatches=true,active=true,remainingCurrent=false,closeFails=false,openFails=false,fillResult}={}){
 const calls=[],current={id:7,url:pageMatches?url:'https://bai.tools/changed',active},tasks=nextUrl?[...(remainingCurrent?[{key:originalLibraryGlobals.ExtLinkQueue.normalizeDestinationKey(url),url}]:[]),{key:originalLibraryGlobals.ExtLinkQueue.normalizeDestinationKey(nextUrl),url:nextUrl}]:[];
 const context=vm.createContext({Q:originalLibraryGlobals.ExtLinkQueue,msg:{status:'cloudReceiptConfirmed',tabId:7,profileId:'p',url,evidence:'Original site receipt'},ownedSubmissionTabs:new Map(owned?[[7,url]]:[]),cloudReceiptCompletionTabs:new Set(),activeTabId:selected?7:17,activeSiteId:profileMatches?'p':'q',currentPageUrl:url,submissionTasks:[{key:originalLibraryGlobals.ExtLinkQueue.normalizeDestinationKey(url),url}],submissionIndex:0,ownerWindowIdPromise:Promise.resolve(1),skipActivationFromVerifiedClose:false,
  SITE_STATUS_MAP:{},updateProductHuntFillButton:()=>{},refreshMediaUploadResult:async()=>{},setAutoFillStatus:()=>{},showToast:()=>{},renderSubmissionNav:()=>{},loadClassifiedList:async()=>{},loadSubmissionQueue:async()=>{context.submissionTasks=tasks;context.submissionIndex=0;},
  chrome:{storage:{local:{set:async()=>{}}},tabs:{get:async()=>({...current}),remove:async id=>{if(closeFails)throw Error('Fixture close failed');calls.push({type:'close',id});},create:async input=>{if(openFails)throw Error('Fixture open failed');calls.push({type:'open',...input});return{id:8};}},runtime:{sendMessage:async input=>{calls.push({type:'ack',...input});return{ok:true};}}}});
 vm.runInContext(['captureFillContext','closeVerifiedOwnedTab','cycleSubmission','handleFillResult'].map(originalFunction).join('\n'),context);
 if(fillResult){let next;const cycle=context.cycleSubmission;context.cycleSubmission=(...args)=>{next=cycle(...args);return next;};await context.handleFillResult(fillResult,'form',context.captureFillContext(7,url,'p'));await next;return{calls,index:context.submissionIndex};}
 const start=source.indexOf('      if (msg.status === "cloudReceiptConfirmed")'),end=source.indexOf('      if (msg.status === "classified")',start);if(start<0||end<=start)throw Error('Original cloud receipt handler missing');
 let pending;context.capture=operation=>{pending=operation;return operation;};const handler=source.slice(start,end).replace('        handleFillResult({','        capture(handleFillResult({');
 // Capture the complete promise chain without changing the original decisions.
 const captured=handler.replace('          });\n        return;','          }));\n        return;');
 vm.runInContext('(function(){'+captured+'})()',context);await pending;
 return{calls,index:context.submissionIndex,guardRetained:context.cloudReceiptCompletionTabs.has(7),owned:context.ownedSubmissionTabs.has(7)};
}

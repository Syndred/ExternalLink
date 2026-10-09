import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {originalLibraryGlobals} from './original-library-catalog.mjs';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
function originalFunction(name){const match=source.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^}','m'));if(!match)throw Error('Original gate function missing '+name);return match[0];}
export async function originalSubmissionSequence(results){
 let submits=0,fills=0;const context=vm.createContext({state:{activeTabs:new Map()},MAX_VALIDATION_RETRIES:Number(source.match(/const MAX_VALIDATION_RETRIES = (\d+)/)[1]),sleep:async()=>{},log(){},broadcastAutoFillUpdate(){},tryAutoSubmitFilledForm:async()=>structuredClone(results[Math.min(submits++,results.length-1)]),fillFormUntilReady:async()=>{fills++;return{lastEmpty:{emptyCount:0,invalidCount:0},agentResult:{}};}});
 vm.runInContext(originalFunction('submitUntilAccepted'),context);const result=await context.submitUntilAccepted(7,{}, {},'directory');return{result:structuredClone(result),submits,fills};
}
export async function originalSinglePageGateResult(phase,gate){
 const profile={id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.example'}},updates=[];let fills=0,submits=0;
 const context=vm.createContext({self:originalLibraryGlobals,state:{activeTabs:new Map()},MAX_VALIDATION_RETRIES:2,chrome:{storage:{local:{get:async()=>({siteProfiles:{p:profile},activeSiteId:'p',autoSubmitDirectoryListings:true})}}},resolveTargetTabId:async()=>7,getTabUrlSafe:async()=> 'https://bai.tools/submit',sendTabMessage:async()=>({platform:'directory',operable:true,formFieldCount:2}),sendTabMessageToFrame:async()=>({blocked:false}),isCustomLaunchUrl:()=>false,broadcastAutoFillUpdate:value=>updates.push(structuredClone(value)),armManualSubmissionWatch:async()=>{},persistFillLearnings:async()=>[],autoClassifySite:async(_url,reason,status)=>({status:originalLibraryGlobals.ExtLinkQueue.classifyStatusFromReason(reason,status)}),sleep:async()=>{},log(){},
  fillFormUntilReady:async()=>{fills++;return{smartTotal:2,skippedFiles:[],uploadedFiles:[],inferredFields:[],agentResult:phase==='initial'||fills>1?structuredClone(gate):{},lastEmpty:{emptyCount:0,invalidCount:0,totalCount:2},validation:{submitReady:true,issues:[]}};},
  tryAutoSubmitFilledForm:async()=>{submits++;return phase==='stage'?{stageAdvanced:true}:{validationFailed:true,issues:['Original missing field']};}});
 vm.runInContext(originalFunction('submitUntilAccepted')+'\n'+originalFunction('runSidepanelFill'),context);
 const result=await context.runSidepanelFill({tabId:7,profileId:'p',expectedUrl:'https://bai.tools/submit',mode:'form',fillOnly:phase==='initial'});
 return{result:structuredClone(result),fills,submits,updates};
}

import {execFileSync} from 'node:child_process';
import vm from 'node:vm';

export const originalProductHuntCommit='bd916b2944a577b160a6afcb8a7d73d263044c0c';
const source=execFileSync('git',['show',originalProductHuntCommit+':extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
function originalFunction(name){const match=source.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^\\}','m'));if(!match)throw Error('Missing frozen original function '+name);return match[0];}
const functions=['productHuntWaitingHasHumanGate','shouldHandOffStableProductHuntStep','productHuntGateStatus','runProductHuntLaunchLoop','runProductHuntSidepanelLoop','runProductHuntSidepanelWithVisualFallback'].map(originalFunction).join('\n');
const constants=source.match(/^const (?:PRODUCT_HUNT_[A-Z_]+|MAX_AGENT_LOOPS) = \d+;/gm).join('\n');

// Execute the frozen control flow. Browser calls and persistence are recorded
// callbacks; actual native browser filling has separate runtime coverage.
export async function originalProductHuntFlow(replies,{entrypoint='launch',advanceAllowed=false,visualReplies}={}){
 const results=structuredClone(replies),calls=[],delays=[],checkpoints=[],actions=[];
 const task={id:'original-task',profileId:'original-product',domain:'producthunt.com'},entry={},config={profileId:task.profileId};
 const visualResults=structuredClone(visualReplies||[]);
 const context=vm.createContext({task,entry,config,options:{confirmCreate:false},
  state:{stopped:false,paused:false},self:{ExtLinkProfiles:{taskConfigIdentityMismatch:()=>''}},
  nextEntryRunId:()=>1,assertRunCurrent:()=>{},persistActiveBatchStatus:async()=>{},broadcastTaskUpdate:()=>{},getTaskConfig:()=>config,log:()=>{},
  sendTabMessage:async(tabId,message)=>{calls.push(structuredClone(message));return results.length>1?results.shift():results[0];},
  sleep:async ms=>delays.push(ms),persistProductHuntCheckpoint:async(_task,result)=>checkpoints.push(structuredClone(result)),recordAutomationEvent:async()=>{},
  parkProductHuntTask:(_tab,task,_entry,reason,status='needs_manual')=>{task.status=status;task.skipReason=reason;actions.push({type:'park',reason,status});},
  parkProductHuntReadyToCreate:()=>actions.push({type:'ready'}),pauseEntryForBatch:()=>actions.push({type:'pause'}),
  dispatchTrustedTabClick:async()=>{actions.push({type:'advance'});return advanceAllowed;},
  handOffToVisualAgent:async(_tab,_task,_entry,options,reason)=>actions.push({type:'visual',options:structuredClone(options),reason}),
  runSidepanelAgentFill:async(_tab,_config,_platform,_limit,options)=>{actions.push({type:'visual',options:structuredClone(options)});return visualResults.length>1?visualResults.shift():visualResults[0]||{ok:true};},
  completeTaskFromSubmit:()=>{throw Error('Frozen fill-only reference must not submit');},markTaskUnconfirmed:()=>{throw Error('Frozen reference unexpectedly submitted');}});
 vm.runInContext(constants+'\n'+functions,context);
 let result,error;
 try{result=await vm.runInContext(entrypoint==='sidepanel'?visualReplies?'runProductHuntSidepanelWithVisualFallback(9,config,options)':'runProductHuntSidepanelLoop(9,config,options)':'runProductHuntLaunchLoop(9,task,entry,options)',context);}catch(failure){error=failure.message;}
 return structuredClone({result,error,calls,delays,checkpoints,actions,task,entry});
}

export function originalProductHuntVisualHandoff(result,stable){
 const context=vm.createContext({result:structuredClone(result),stable});vm.runInContext(constants+'\n'+functions,context);
 return vm.runInContext('shouldHandOffStableProductHuntStep(result,stable)',context);
}

import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const ref='bd916b2944a577b160a6afcb8a7d73d263044c0c',source=execFileSync('git',['show',ref+':extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const section=name=>{const start=source.indexOf('async function '+name+'(');return source.slice(start,source.indexOf('\nfunction ',start+1)>0&&source.indexOf('\nfunction ',start+1)<source.indexOf('\nasync function ',start+1)?source.indexOf('\nfunction ',start+1):source.indexOf('\nasync function ',start+1));};
export async function originalSuccessGroup({manual=false,paused=false,hasNext=true,claim=true,sameUrl=false}={}){
 const calls=[],tasks=[{id:'first',index:0,status:manual?'needs_manual':'ok',confirmationNonce:'nonce',url:'https://site.example/submit',domain:'site.example',profileId:'p'},...(hasNext?[{id:'next',index:1,status:'pending',url:'https://site.example/submit',domain:'site.example',profileId:'q'}]:[])],group={tasks},entry={taskId:'first',taskIndex:0,runId:1},state={tasks,runId:'run',lifecycleVersion:1,paused,stopped:false,activeTabs:new Map([[7,entry]]),parkedTaskIds:new Set(['first']),queue:[]};
 const context=vm.createContext({self:{},state,findGroupForTask:()=>group,unattendedEnabled:()=>!claim,claimUnattendedTask:async()=>claim,persistParkedTaskIds:async()=>{},persistActiveBatchStatus:async()=>{},log(){},broadcastTaskUpdate(){},resetEntryTimeout(){},parkTaskEntry(){},POST_SUCCESS_CLOSE_DELAY_MS:1000,PAGE_LOAD_TIMEOUT_MS:45000,delayCloseTab:tabId=>calls.push({type:'close',tabId}),recordSubmittedProject:async()=>({status:'success'}),recordUnattendedSuccess:async()=>{},syncUnattendedManualCapacity:async()=>{},chrome:{tabs:{get:async()=>({url:sameUrl?tasks[0].url:'https://site.example/receipt'}),update:async(tabId,options)=>calls.push({type:'navigate',tabId,...options}),reload:async tabId=>calls.push({type:'reload',tabId})}}});
 vm.runInContext(execFileSync('git',['show',ref+':extension/lib/scheduler.js'],{encoding:'utf8'}),context);
 vm.runInContext(execFileSync('git',['show',ref+':extension/lib/unattended.js'],{encoding:'utf8'}),context);
 vm.runInContext(section('advanceDestinationGroup')+'\n'+section('confirmSubmissionSuccess'),context);
 await vm.runInContext(manual?'confirmSubmissionSuccess({taskId:"first",runId:"run",confirmationNonce:"nonce"})':'advanceDestinationGroup(7,state.tasks[0])',context);
 return{calls:structuredClone(calls),nextTaskId:entry.taskId,queued:state.queue.length,taskStatuses:tasks.map(task=>task.status)};
}

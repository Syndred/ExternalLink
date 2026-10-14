import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeTaskTab} from '../executor/src/tab-cleanup.mjs';

function fixture({wrongRunAt}={}){
 const bytes=Buffer.from('one original receipt screenshot'),task={id:'original-task',runId:'run/one &two=three',targetId:'owned-page',browserInstance:'browser',destinationKey:'directory',profileId:'photo',status:'finished',siteStatus:'accepted',cloudVerified:true,screenshot:'saved.png',artifactRef:'artifact',artifactSha256:createHash('sha256').update(bytes).digest('hex'),actualSubmission:{fields:[{name:'toolName',value:'OldPhotoLive AI'}]},profileRevision:20,receipt:{evidence:'Form submitted',url:'https://directory.example/form'}};
 const calls=[];let reads=0,remote=structuredClone(task),closed=false;
 const runtime={job:null,store:{get:key=>key==='paused'?true:null,pending:()=>[]},cloud:{request:async route=>{
  calls.push(route);if(route==='runs'||route.startsWith('runs?')){reads++;const copy=structuredClone(remote);if(reads===wrongRunAt)copy.runId='other-run';return{tasks:[copy]};}
  if(route==='snapshot')return{revisions:{submissionRecords:8},documents:{submissionRecords:{'directory::photo':{taskId:task.id,evidence:task.receipt.evidence,actualSubmission:task.actualSubmission}}}};
  assert.equal(route,'artifact-read');return{dataUrl:'data:image/png;base64,'+bytes.toString('base64')};
 }},synchronize:async()=>{remote=structuredClone(task);},lease:async()=>{},update(current,patch){Object.assign(current,patch);},status:()=>({ok:true}),findPage:async()=>({url:()=>task.receipt.url,close:async()=>{closed=true;calls.push('CLOSE');}})};
 return{task,runtime,calls,closed:()=>closed,input:{expectedTargetId:'owned-page'}};
}

test('all three online close readbacks request the exact encoded original run',async()=>{
 const f=fixture();await closeTaskTab(f.runtime,f.task,f.input);assert.deepEqual(f.calls.filter(route=>route.startsWith('runs')),['runs?runId=run%2Fone%20%26two%3Dthree','runs?runId=run%2Fone%20%26two%3Dthree','runs?runId=run%2Fone%20%26two%3Dthree']);assert.equal(f.closed(),true);assert.ok(f.task.tabClosedAt);
});

for(const [phase,wrongRunAt,expectedClosed,error]of [['initial',1,false,/云端任务/],['registration',2,false,/登记/],['after-close',3,true,/关闭事件云端回读/]])test(`a same-ID task from another run cannot satisfy ${phase} cloud readback`,async()=>{
 const f=fixture({wrongRunAt});await assert.rejects(()=>closeTaskTab(f.runtime,f.task,f.input),error);assert.equal(f.closed(),expectedClosed);assert.equal(f.task.runId,'run/one &two=three');if(expectedClosed)assert.ok(f.task.tabClosedAt);
});

test('missing original run identity fails closed without an unscoped history read',async()=>{
 const f=fixture();delete f.task.runId;await assert.rejects(()=>closeTaskTab(f.runtime,f.task,f.input),/runId|原运行/);assert.equal(f.calls.some(route=>route.startsWith('runs')),false);assert.equal(f.closed(),false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';
import {Cloud} from '../executor/src/cloud.mjs';
import {freezeBatchConfig} from '../executor/src/workbench-batch-policy.mjs';
import {runWorkbenchBatch,workbenchConcurrency} from '../executor/src/workbench-batch-scheduler.mjs';
import {finishWorkbenchTask} from '../executor/src/workbench-features.mjs';

const gate=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
async function until(condition){for(let count=0;count<100;count++){if(condition())return;await new Promise(done=>setTimeout(done,5));}throw Error('fixture condition not reached');}
function fixture(){const store=new Store(':memory:'),runtime=new Runtime(store,'isolated'),items=[];store.set('pair',{endpoint:'https://cloud.example',workspaceId:'default'});for(const profileId of ['p','q'])for(let n=0;n<3;n++){const id=profileId+n,item={taskId:id,runId:'run-'+id,profileId,url:'https://site'+n+'.example/form',destinationKey:'site'+n+'.example/form',status:'registered',profile:{id:profileId}};items.push(item);store.set('task:'+id,{id,runId:item.runId,profileId,url:item.url,status:'pending'});}
 store.set('workbenchBatch:b',{id:'b',scope:'https://cloud.example|default',status:'running',cursor:0,count:6,items,...freezeBatchConfig({cfgConcurrency:'2'})});store.set('activeWorkbenchBatch','b');store.set('paused',false);runtime.context={};runtime.synchronize=async()=>{};runtime.lease=async()=>{};return{runtime,store};}

test('original concurrency dispatches different destinations, prioritizes the next product in its group and preserves out-of-order results',async()=>{
 const {runtime,store}=fixture(),gates=new Map(),started=[],done=[];let peak=0;
 runtime.work=async({taskId})=>{started.push(taskId);peak=Math.max(peak,runtime.activeTaskIds.size);const hold=gate();gates.set(taskId,hold);await hold.promise;runtime.update(store.get('task:'+taskId),{status:'finished',receipt:{evidence:'original-'+taskId}},'fixture_receipt');done.push(taskId);};
 try{const running=runWorkbenchBatch(runtime);await until(()=>started.length===2);assert.deepEqual(started,['p0','p1']);assert.equal(store.get('singleTaskId'),null);gates.get('p1').resolve();await until(()=>started.length===3);assert.equal(started[2],'q1');assert.equal(store.get('workbenchBatch:b').cursor,0);gates.get('q1').resolve();await until(()=>started.length===4);assert.equal(started[3],'p2');gates.get('p0').resolve();await until(()=>started.length===5);assert.equal(started[4],'q0');gates.get('q0').resolve();gates.get('p2').resolve();await until(()=>started.length===6);assert.equal(started[5],'q2');gates.get('q2').resolve();await running;const batch=store.get('workbenchBatch:b');assert.equal(peak,2);assert.equal(new Set(started).size,6);assert.equal(batch.cursor,6);assert.equal(batch.count,6);assert.equal(batch.status,'complete');assert.deepEqual(batch.items.map(i=>i.taskId),['p0','p1','p2','q0','q1','q2']);assert.equal(batch.items.every(i=>i.result==='received'),true);assert.equal(runtime.activeTaskIds.size,0);assert.equal(store.get('activeWorkbenchBatch'),null);assert.equal(done[0],'p1');}finally{for(const hold of gates.values())hold.resolve();store.close();}
});

test('pause drains the actual active promises without opening remaining tasks; original indices and identities survive resume',async()=>{
 const {runtime,store}=fixture(),holds=[],started=[];runtime.work=async({taskId})=>{started.push(taskId);const hold=gate();holds.push(hold);await hold.promise;runtime.update(store.get('task:'+taskId),{status:'pending'},'fixture_paused');};
 try{const running=runWorkbenchBatch(runtime);await until(()=>started.length===2);store.set('paused',true);let settled=false;running.then(()=>settled=true);holds[0].resolve();await new Promise(done=>setTimeout(done,10));assert.equal(settled,false);assert.equal(started.length,2);holds[1].resolve();await running;assert.equal(store.get('workbenchBatch:b').cursor,0);assert.deepEqual(store.get('workbenchBatch:b').items.map(i=>i.taskId),['p0','p1','p2','q0','q1','q2']);assert.equal(runtime.activeTaskIds.size,0);assert.equal(store.get('task:p2').status,'pending');assert.equal(store.get('singleTaskId'),null);}finally{for(const hold of holds)hold.resolve();store.close();}
});

test('a parked original task holds subsequent products at its destination while other groups continue',async()=>{
 const {runtime,store}=fixture(),started=[];runtime.work=async({taskId})=>{started.push(taskId);runtime.update(store.get('task:'+taskId),taskId==='p0'?{status:'needs_manual',reason:'original captcha'}:{status:'finished',receipt:{evidence:'receipt-'+taskId}},'fixture_result');};
 try{await runWorkbenchBatch(runtime);assert.equal(started.includes('q0'),false);assert.equal(started.length,5);const batch=store.get('workbenchBatch:b');assert.equal(batch.status,'waiting_manual');assert.equal(batch.count,6);assert.equal(batch.items.find(i=>i.taskId==='q0').status,'registered');assert.equal(store.get('task:p0').status,'needs_manual');assert.equal(store.get('paused'),true);runtime.update(store.get('task:p0'),{status:'finished',receipt:{evidence:'human receipt'}},'fixture_manual_resolution');finishWorkbenchTask(runtime,'p0');store.set('workbenchBatch:b',{...store.get('workbenchBatch:b'),status:'running'});store.set('paused',false);await runWorkbenchBatch(runtime);assert.equal(started.at(-1),'q0');assert.equal(store.get('workbenchBatch:b').items[0].result,'received');assert.equal(store.get('workbenchBatch:b').status,'complete');}finally{store.close();}
});

test('unattended uses one original processing slot even when the saved ordinary concurrency is higher',async()=>{
 const {runtime,store}=fixture();try{const batch=store.get('workbenchBatch:b');const frozen=freezeBatchConfig({cfgConcurrency:'99'},{unattended:true});assert.equal(workbenchConcurrency({...batch,...frozen}),1);assert.equal(workbenchConcurrency({...batch,...freezeBatchConfig({cfgConcurrency:'7.8'})}),7);}finally{store.close();}
});

test('an original unknown attempt discovered during dispatch immediately parks its group and never opens another product there',async()=>{
 const {runtime,store}=fixture(),started=[];store.set('task:p0',{...store.get('task:p0'),status:'submitted_unconfirmed',attemptBoundary:'original-unknown-boundary'});runtime.work=async({taskId})=>{started.push(taskId);runtime.update(store.get('task:'+taskId),{status:'finished',receipt:{evidence:'receipt-'+taskId}},'fixture_receipt');};
 try{await runWorkbenchBatch(runtime);assert.equal(started.includes('p0'),false);assert.equal(started.includes('q0'),false);assert.equal(started.length,4);assert.equal(store.get('task:p0').attemptBoundary,'original-unknown-boundary');assert.equal(store.get('task:q0').status,'pending');const batch=store.get('workbenchBatch:b');assert.equal(batch.items[0].result,'sent_unconfirmed');assert.equal(batch.count,6);assert.equal(batch.status,'waiting_manual');}finally{store.close();}
});

test('cloud flush serializes different Cloud clients on one store and confirms boundaries added while the previous readback was pending',async()=>{
 const store=new Store(':memory:'),first=new Cloud({}),second=new Cloud({}),hold=gate(),entered=gate(),events=[];let reads=0;
 const request=async(route,body)=>{if(route==='event'){events.push(body.id);return{eventId:body.id,checksum:createHash('sha256').update(JSON.stringify(body)).digest('hex')};}const event=store.pending().find(e=>route.startsWith('events/'+e.id));if(++reads===1){entered.resolve();await hold.promise;}return{eventId:event.id,checksum:createHash('sha256').update(JSON.stringify(event)).digest('hex')};};first.request=request;second.request=request;
 try{store.transition({id:'p0',attemptBoundary:'first'},'boundary');const a=first.flush(store);await entered.promise;store.transition({id:'q1',attemptBoundary:'second'},'boundary');const b=second.flush(store);await new Promise(done=>setTimeout(done,10));assert.equal(events.length,1);hold.resolve();await Promise.all([a,b]);assert.equal(events.length,2);assert.equal(new Set(events).size,2);assert.equal(store.pendingCount(),0);assert.equal(store.get('task:q1').attemptBoundary,'second');}finally{hold.resolve();store.close();}
});

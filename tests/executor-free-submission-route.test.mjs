import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareExplicitFreeRoute} from '../executor/src/free-submission-route.mjs';

function fixture({outcome={ok:true,selected:true},failSync=false,pauseAfterSync=false,uncertain=false}={}){
  let allowed=true,selected=0;
  const task={id:'free-route-fixture',runId:'run',profileId:'photo',profileRevision:30,targetId:'target',browserInstance:'instance',
    version:1,controllerId:'owner',controller:'executor',status:'filling'},calls=[],pending=[];
  const proof={selector:'#request',formSelector:'#form',value:'free',label:'Free editorial consideration — no fee',
    selected:false,signature:'fnv1a-test',documentTimeOrigin:100};
  const store={get:key=>key==='pair'?{workerUrl:'https://worker.invalid',workspaceId:'fixture'}:key==='task:'+task.id?task:null,
    pendingSummary:()=>pending};
  const runtime={store,update(t,patch,type){calls.push(type);Object.assign(t,structuredClone(patch));pending.push({id:'event'+calls.length,taskId:t.id});},
    cloud:{flush:async()=>{calls.push('flush');if(failSync)throw Error('cloud readback unavailable');pending.splice(0);if(pauseAfterSync)allowed=false;}}};
  const frame={url:()=> 'https://directory.invalid/submit'};
  const candidate={frame,url:frame.url(),detection:{submitBlocker:{payment_uncertain:true},freeSubmissionRoute:proof},
    engine:{isCurrentDocument:async()=>true,call:async message=>{
      calls.push(message.action);
      if(message.action==='prepareExplicitFreeSubmissionRoute'){selected++;assert.equal(pending.length,0,'start checkpoint must flush before select');
        assert.equal(task.freeRoutePreparationHistory[0].status,'started');if(uncertain)throw Error('document navigated during selection');return outcome;}
      if(message.action==='detectPage')return{operable:true,freeSubmissionRoute:{...proof,selected:true},submitBlocker:null};
      throw Error('unexpected action '+message.action);
    }}};
  return{runtime,task,candidate,page:{isClosed:()=>false},active:()=>allowed,config:{},calls,selected:()=>selected};
}

test('free choice is persisted and flushed before selection, then re-detected; no final boundary',async()=>{
  const f=fixture();assert.equal(await prepareExplicitFreeRoute(f.runtime,f),true);
  assert.deepEqual(f.calls,['explicit_free_route_preparation_boundary','flush','prepareExplicitFreeSubmissionRoute',
    'explicit_free_route_preparation_observed','flush','detectPage']);
  assert.equal(f.task.freeRoutePreparationHistory[0].status,'selected');assert.equal(f.task.attemptBoundary,undefined);
  assert.equal(f.candidate.detection.submitBlocker,null);assert.equal(f.selected(),1);
});

test('original receipt/final boundary/controller, pause and cloud failure block preparation',async()=>{
  for(const patch of [{receipt:{evidence:'keep'}},{attemptBoundary:'keep'},{controller:'ai'}]){
    const f=fixture();Object.assign(f.task,patch);
    await assert.rejects(prepareExplicitFreeRoute(f.runtime,f),/任务、控制权或授权已变化/);assert.equal(f.selected(),0);
    assert.equal(f.task.receipt,patch.receipt);assert.equal(f.task.attemptBoundary,patch.attemptBoundary);
  }
  for(const options of [{failSync:true},{pauseAfterSync:true}]){
    const f=fixture(options);await assert.rejects(prepareExplicitFreeRoute(f.runtime,f));assert.equal(f.selected(),0);
    assert.equal(f.task.freeRoutePreparationHistory[0].status,'started');
  }
});

test('uncertain started selection is protected against replay and unexpected submission becomes a protected boundary',async()=>{
  const f=fixture({uncertain:true});await assert.rejects(prepareExplicitFreeRoute(f.runtime,f),/navigated/);
  assert.equal(f.task.freeRoutePreparationHistory[0].status,'started');assert.equal(f.selected(),1);
  await assert.rejects(prepareExplicitFreeRoute(f.runtime,f),/不重复未知/);assert.equal(f.selected(),1);
  const submitted=fixture({outcome:{ok:false,selected:true,unexpectedSubmission:true,reason:'unexpected protected'}});
  await assert.rejects(prepareExplicitFreeRoute(submitted.runtime,submitted),error=>error.preparationResult?.unconfirmed===true);
  assert.ok(submitted.task.attemptBoundary);assert.equal(submitted.task.status,'submitted_unconfirmed');
  assert.equal(submitted.task.siteStatus,'sent_unconfirmed');assert.equal(submitted.selected(),1);
});

test('no free proof and confirmed payment do not start a preparation action',async()=>{
  for(const changed of [{submitBlocker:{blocked:true}},{freeSubmissionRoute:null}]){
    const f=fixture();Object.assign(f.candidate.detection,changed);
    assert.equal(await prepareExplicitFreeRoute(f.runtime,f),false);assert.equal(f.selected(),0);assert.deepEqual(f.calls,[]);
  }
});

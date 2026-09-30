import test from 'node:test';import assert from 'node:assert/strict';import {canAdvancePlan} from '../executor/src/plan-stage.mjs';
test('only validated PoweredByAI details advance to plans without clearing an attempt',()=>{
 const task={url:'https://poweredbyai.app/submit-tool',status:'needs_manual',profileSnapshot:{name:'JevPlay',url:'https://jevplay.com'},validation:{allValid:true},actualSubmission:{attachments:[{type:'image/png',bytes:14333}]}};
 const observed={url:task.url,name:'JevPlay',website:'https://jevplay.com',buttonCount:1,buttonEnabled:true};
 assert.equal(canAdvancePlan(task,observed),true);
 assert.equal(canAdvancePlan(task,{...observed,url:task.url+'?toolID=jev-ai-games'}),true);
 for(const patch of [{attemptBoundary:'keep'},{receipt:{evidence:'received'}},{validation:{allValid:false}},{url:'https://other.test'},{actualSubmission:{attachments:[]}}])assert.equal(canAdvancePlan({...task,...patch},observed),false);
 assert.equal(canAdvancePlan(task,{...observed,name:'Jev AI Games'}),false);
});

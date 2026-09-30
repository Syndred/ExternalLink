import test from 'node:test';import assert from 'node:assert/strict';import{canContinueProductPreview}from'../executor/src/product-preview.mjs';
const task={url:'https://10015.io/product-finder/submit',status:'submitted_unconfirmed',siteStatus:'sent_unconfirmed',attemptBoundary:'old',
 submitResult:{stageAdvanced:true,submitted:false,clickedSubmit:true,networkResponses:[]},profileSnapshot:{name:'JevPlay',url:'https://jevplay.com'}};
const observed={url:task.url,name:'JevPlay',website:'https://jevplay.com',free:true,previewCount:1,submitCount:1,continueEditing:true};
test('The original zero-traffic preview transition can be continued once on its final button',()=>assert.equal(canContinueProductPreview(task,{expectedAttemptBoundary:'old'},observed),true));
test('Actual submission, lost preview, identity mismatch, payment or stale ownership must stop',()=>{
 for(const patch of [{receipt:{}},{previewFinalAttempt:true},{networkResponses:[{status:200}]},{submitResult:{stageAdvanced:true,submitted:true}},{attemptBoundary:'changed'}])assert.equal(canContinueProductPreview({...task,...patch},{expectedAttemptBoundary:'old'},observed),false);
 for(const patch of [{url:'https://10015.io/other'},{name:'Old Name'},{website:'https://other.test'},{free:false},{previewCount:0},{submitCount:2},{continueEditing:false}])assert.equal(canContinueProductPreview(task,{expectedAttemptBoundary:'old'},{...observed,...patch}),false);
});

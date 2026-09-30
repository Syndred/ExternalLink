import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function validation(disabled,value='JevPlay'){
 const input={type:'text',tagName:'INPUT',required:true,value};
 const submit={innerText:'Submit AI Tool',disabled,getAttribute:()=>null};
 const document={querySelectorAll:s=>s.includes('button')?[submit]:[]};
 const c=vm.createContext({document,queryFillableElements:()=>[input],queryCustomDropdowns:()=>[],collectChoiceGroups:()=>new Map(),
  fieldIsRequired:e=>e.required,getElementFillValue:e=>e.value,fieldNeedsRefill:()=>false,getActiveFillScope:()=>document,isVisible:()=>true,
  collectVisibleFieldErrors:()=>[]});
 vm.runInContext(source.slice(source.indexOf('  function countEmptyFillableFields('),source.indexOf('  function collectVisibleFieldErrors(')),c);
 vm.runInContext(source.slice(source.indexOf('  function collectFormValidationState('),source.indexOf('  function fieldIsRequired(')),c);
 return c.collectFormValidationState();
}
test('A disabled submit prevents readiness without inventing missing required fields',()=>{const r=validation(true);assert.equal(r.emptyCount,0);assert.equal(r.submitDisabled,true);assert.equal(r.allValid,false);assert.equal(r.validationFailed,true);assert(r.issues.some(x=>x.includes('提交按钮')));});
test('An enabled submit and complete fields are ready',()=>{const r=validation(false);assert.equal(r.emptyCount,0);assert.equal(r.allValid,true);assert.equal(r.validationFailed,false);});
test('A genuinely missing required input remains a field error',()=>{const r=validation(false,'');assert.equal(r.emptyCount,1);assert.equal(r.allValid,false);});

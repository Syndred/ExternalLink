import test from 'node:test';import assert from 'node:assert/strict';
import {planPreparation} from '../core/preparation-planner.mjs';
test('cloud preparation planner independently removes invented selectors and final-submit requests',async()=>{
  const snapshot={url:'https://directory.example/submit',fields:[{selector:'#name',type:'text',visible:true}],buttons:[{selector:'#publish',text:'Publish',visible:true}]};
  const result=await planPreparation({snapshot,config:{brandName:'Real Product'},strategy:'alternative'},async(system,user)=>{
    assert.match(system,/Never click final/);assert.equal(JSON.parse(user).config.brandName,'Real Product');
    return{status:'act',actions:[{type:'click',selector:'#publish'},{type:'fill',selector:'#name',value:'Real Product'},{type:'fill',selector:'#invented',value:'x'}]};
  });assert.equal(result.actions.length,1);assert.equal(result.actions[0].selector,'#name');
});

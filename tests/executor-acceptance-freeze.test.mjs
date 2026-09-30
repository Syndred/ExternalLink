import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';import {freezeAcceptance} from '../executor/src/acceptance-freeze.mjs';
test('freeze covers every actual product, deduplicates same-host paths and preserves unknown original tasks',()=>{
 const store=new Store(':memory:');const products={A:{id:'A',name:'A'},B:{id:'B',name:'B'},C:{id:'C',name:'C'}};
 const tasks=[{id:'unknown',profileId:'A',url:'https://site1.example/old',attemptBoundary:'sent',status:'submitted_unconfirmed'}];
 const args={id:'frozen',products,profileRevision:2,sites:['https://site1.example/new','https://www.site1.example/another','https://site2.example/submit'],tasks,count:6};
 const frozen=freezeAcceptance(store,args);assert.equal(frozen.combinations.length,6);assert.equal(new Set(frozen.combinations.map(c=>c.identity)).size,6);
 assert.deepEqual(new Set(frozen.combinations.map(c=>c.profileId)),new Set(['A','B','C']));
 const unknown=frozen.combinations.find(c=>c.existingTaskId==='unknown');assert.equal(unknown.requiresVerification,true);
 assert.equal(freezeAcceptance(store,{...args,sites:['https://different.example'],products:{A:products.A},count:1}).sha256,frozen.sha256);
 assert.equal(store.values('task:').length,0);store.close();
});
test('insufficient scope fails visibly rather than shrinking the fixed denominator or omitting products',()=>{
 const store=new Store(':memory:');assert.throws(()=>freezeAcceptance(store,{id:'x',products:{A:{id:'A'},B:{id:'B'}},sites:['https://a.example'],count:3}),/不足/);assert.equal(store.get('acceptance:x'),null);store.close();
});

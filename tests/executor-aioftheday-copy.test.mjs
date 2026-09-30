import test from 'node:test';import assert from 'node:assert/strict';import{aiOfDayCopy}from'../executor/src/known-copy.mjs';
test('AIoftheday uses the current full description and five distinct features within its published limits',()=>{
  const description='Current independently verified JevPlay description. '.repeat(12);
  const copy=aiOfDayCopy({name:'JevPlay',url:'https://jevplay.com',fields:{'Short Discription(100-150 words)':description}});
  assert.equal(copy.description,description.trim());assert.ok(copy.tagline.length<=60);
  assert.equal(new Set(copy.features).size,5);assert.ok(copy.features.every(x=>x.length<=160));
});
test('Site specific summaries cannot be applied to a different product or missing source copy',()=>{
  assert.throws(()=>aiOfDayCopy({name:'Other',url:'https://other.test'}));
  assert.throws(()=>aiOfDayCopy({name:'JevPlay',url:'https://jevplay.com',fields:{}}));
});

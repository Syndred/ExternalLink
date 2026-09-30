import test from 'node:test';import assert from 'node:assert/strict';import {navToolsValues} from '../executor/src/adapters/navtools.mjs';
test('NavTools uses each product actual facts without historical Jev analysis copy',()=>{
 const profile={name:'RainbowPetAI',url:'https://rainbowpetai.com',fields:{Name:'RainbowPetAI',Url:'https://rainbowpetai.com','Business mail':'owner@example.com','Short Discription(100-150 words)':'Create an online pet memorial.'}};
 const values=navToolsValues(profile);assert.equal(values.toolName,'RainbowPetAI');assert.equal(values.description,'Create an online pet memorial.');assert.equal(values['faqs.0.answer'],undefined);assert.doesNotMatch(JSON.stringify(values),/JevPlay|Chat Intent|conversation analysis/);
});

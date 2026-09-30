import test from 'node:test';import assert from 'node:assert/strict';import {associateMail} from '../core/mail-association.mjs';
const tasks=[{id:'a',profileId:'p',url:'https://directory.example/submit',attemptBoundary:'2026-09-29T12:00:00Z'},{id:'b',profileId:'q',url:'https://directory.example/other',attemptBoundary:'2026-09-29T12:00:00Z'}],products=[{id:'p',name:'Real Product',url:'https://product.example'},{id:'q',name:'Second Product',url:'https://second.example'}];
test('mail association needs exact sender site and explicit product identity, never implies publication',()=>{
 const result=associateMail({id:'m',from:'Support <help@directory.example>',subject:'Real Product received',at:'2026-09-30'},tasks,products);assert.equal(result.identity,'directory.example::p');assert.equal(result.publication,'unknown');assert.equal(result.review,'unknown');
 assert.equal(associateMail({from:'help@evil-directory.example',subject:'Real Product received'},tasks,products).status,'unmatched');
 assert.equal(associateMail({from:'help@directory.example',subject:'Real Product and Second Product',at:'2026-09-30'},tasks,products).status,'ambiguous');
 assert.equal(associateMail({from:'help@directory.example',subject:'Your submission received'},tasks,products).status,'unmatched');
});
test('mail predating a submission is excluded and unknown times retain candidates without claiming a reply',()=>{
 const message={id:'m',from:'help@directory.example',subject:'Real Product received',at:'2026-09-28T00:00:00Z'};
 assert.equal(associateMail(message,tasks,products).status,'unmatched');
 const unknown=associateMail({...message,at:'invalid'},tasks,products);assert.equal(unknown.status,'candidate');assert.deepEqual(unknown.candidates,['directory.example::p']);assert.equal(unknown.identity,undefined);
 const missing=associateMail({...message,at:'2026-09-30'},[{...tasks[0],attemptBoundary:null}],products);assert.equal(missing.status,'candidate');
 const repeated=associateMail({...message,at:'2026-09-30'},[tasks[0],{...tasks[0],id:'later',attemptBoundary:'2026-10-01'}],products);assert.deepEqual(repeated.taskIds,['a']);
});

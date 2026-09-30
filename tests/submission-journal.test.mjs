import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
function model(){const context={URL};vm.createContext(context);const file='extension/lib/submission-journal.js';if(fs.existsSync(file))vm.runInContext(fs.readFileSync(file,'utf8'),context);assert.equal(typeof context.ExtLinkSubmissionJournal?.build,'function','journal model must combine tasks, records and evidence');return context.ExtLinkSubmissionJournal;}
test('journal keeps product identities separate and merges host aliases without hiding task failures',()=>{
 const rows=model().build({tasks:[{id:'t',profileId:'A',url:'https://www.example.com/submit',siteStatus:'not_submitted',status:'needs_manual',reason:'Login'}],records:{'example.com::A':{profileId:'A',destinationKey:'example.com',status:'success'},'example.com::B':{profileId:'B',destinationKey:'example.com',status:'success'}}});
 assert.equal(rows.length,2);assert.equal(rows.find(r=>r.profileId==='A').tasks.length,1);assert.equal(rows.find(r=>r.profileId==='A').submission,'historical_receipt');assert.equal(rows.find(r=>r.profileId==='B').tasks.length,0);
});
test('later note or user review cannot erase site moderation and email is independent of link validity',()=>{
 const rows=model().build({tasks:[{id:'t',profileId:'A',url:'https://example.com',siteStatus:'accepted',reviewStatus:'reviewed',receipt:{publicationStatus:'pending_moderation'}}],timeline:{'example.com::A':[{profileId:'A',destinationKey:'example.com',type:'email_reply',note:'In review',occurredAt:'2026-09-28T10:00:00Z'},{profileId:'A',destinationKey:'example.com',type:'note',occurredAt:'2026-09-29T10:00:00Z'}]}});
 assert.equal(rows[0].moderation,'pending_moderation');assert.equal(rows[0].reply,'received');assert.equal(rows[0].validity,'unverified');
});
test('new link-missing evidence supersedes older published event, without undoing receipt',()=>{
 const rows=model().build({records:{'example.com::A':{status:'success'}},timeline:{'example.com::A':[{type:'published',publicUrl:'https://example.com/a',occurredAt:'2026-09-27T00:00:00Z'},{type:'link_missing',note:'No target link',occurredAt:'2026-09-29T00:00:00Z'}]}});
 assert.equal(rows[0].validity,'link_missing');assert.equal(rows[0].submission,'historical_receipt');
});
test('task cloudVerified refers to receipt and never hides newer unsynced local events',()=>{
 const rows=model().build({tasks:[{id:'t',profileId:'A',url:'https://example.com',siteStatus:'accepted',cloudVerified:true,pendingEvents:3}]});assert.equal(rows[0].pendingEvents,3);assert.equal(rows[0].sync,'pending');
});
test('archived-only successes stay visible but never imply current receipt, moderation or validity',()=>{
 const input={historicalRecords:{'example.com::A':{status:'success',publicationStatus:'published',archiveSource:'2026-09-25'}}};
 const row=model().build(input)[0];assert.equal(row.submission,'historical_unverified');assert.equal(row.moderation,'unknown');assert.equal(row.validity,'unverified');assert.equal(row.history.length,1);
 const active=model().build({...input,tasks:[{profileId:'A',url:'https://example.com',status:'needs_manual',siteStatus:'not_submitted'}]})[0];assert.equal(active.submission,'not_submitted');
});
test('a timeline-only entry is unknown, not falsely claimed to be an unexecuted task',()=>{
 const row=model().build({timeline:{'old.test::A':[{type:'note',note:'Historical activity'}]}})[0];assert.equal(row.submission,'unknown');
});

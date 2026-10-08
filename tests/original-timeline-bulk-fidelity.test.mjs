import test from 'node:test';
import assert from 'node:assert/strict';
import '../core/submission-timeline.js';
import {originalLibraryGlobals} from './helpers/original-library-catalog.mjs';
const old=originalLibraryGlobals.ExtLinkSubmissionTimeline,current=globalThis.ExtLinkSubmissionTimeline;
const plain=value=>JSON.parse(JSON.stringify(value));
const event=(id,offset,patch={})=>({id,destinationKey:'target.example',profileId:'product',occurredAt:new Date(Date.UTC(2020,0,1)+offset*1000).toISOString(),source:'agent',type:'note',note:'same',...patch});
const groups=events=>{const result={};for(const value of events)(result[value.destinationKey+'::'+value.profileId]||=[]).push(value);return result;};

test('bulk timeline append retains original intermediate pruning, duplicate IDs across groups and final pending normalization',()=>{
 const cases=[
  [groups([event('first',0)]),[event('second',1)]],
  [groups([event('first',0)]),[event('second',1),event('third',2)]],
  [groups([event('first',0),event('mirror',1,{source:'migration',legacy:{source:'submissionRecords'},type:'published',publicationStatus:'published'}),event('third',2),event('proof',1,{source:'manual',type:'published',note:'same'})]),[event('next',3,{destinationKey:'other.example'})]],
  [groups([event('same-id',0,{source:'manual'}),event('same-id',1,{destinationKey:'other.example',source:'manual'})]),[event('same-id',2),event('new',3)]],
  [groups([event('first',0)]),[]]
 ];
 for(const [base,incoming]of cases){const before=plain([base,incoming]);assert.deepEqual(plain(current.appendMany(base,incoming)),plain(old.appendMany(base,incoming)));assert.deepEqual([base,incoming],before);}
});

test('bulk timeline matches frozen original append and merge across deterministic mixed historical groups',()=>{
 let seed=321;const random=max=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;};
 for(let round=0;round<180;round++){
  const make=()=>event('id-'+random(24),random(240),{destinationKey:'site'+random(5)+'.example',profileId:'p'+random(3),source:['agent','manual','migration'][random(3)],type:['note','submitted','published'][random(3)],publicationStatus:random(2)?'published':'',note:'note-'+random(3),legacy:random(2)?{source:'submissionRecords'}:{retained:'original'}});
  const base=groups(Array.from({length:20},make)),incoming=Array.from({length:25},make),before=plain([base,incoming]);
  assert.deepEqual(plain(current.appendMany(base,incoming)),plain(old.appendMany(base,incoming)),'append '+round);
  assert.deepEqual(plain(current.mergeTimelines(base,groups(incoming))),plain(old.mergeTimelines(base,groups(incoming))),'merge '+round);
  assert.deepEqual([base,incoming],before);
 }
});

test('complete historical import keeps every original item and matches the frozen report rather than shrinking the batch',()=>{
 const originals=Array.from({length:400},(_,index)=>event('original-'+index,index*61,{destinationKey:'site'+index+'.example',source:'manual',note:'Original preserved note '+index}));
 const additions=Array.from({length:80},(_,index)=>event('missing-'+index,30000+index,{destinationKey:'old'+index+'.example',source:'manual',note:'Missing original note '+index}));
 const base=groups(originals),incoming=groups([...originals,...additions]);
 const result=current.mergeTimelines(base,incoming);assert.deepEqual(plain(result),plain(old.mergeTimelines(base,incoming)));assert.equal(Object.values(result).flat().length,480);assert.deepEqual(base,groups(originals));
});

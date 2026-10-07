import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync,rmdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {originalTimelineMutation,originalTimelineSatisfied,timelineDocumentKeys} from '../core/original-timeline-mutation.mjs';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueLibraryMutation,flushApplicationMutations,overlayApplication,resolveApplicationConflict} from '../executor/src/application-mutations.mjs';
const baseline='bd916b2944a577b160a6afcb8a7d73d263044c0c';
const originalFile=path=>execFileSync('git',['show',baseline+':'+path],{encoding:'utf8',maxBuffer:4*1024*1024});
const original=originalFile('extension/background.js'),body=original.slice(original.indexOf('function applyTimelinePublicationUpgrade('),original.indexOf('async function pinLibraryUrl('));
async function reference(initial,action,input){
 const documents=structuredClone(initial),context=vm.createContext({URL,console,input,chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(update){Object.assign(documents,structuredClone(update));}}}},submissionLedgerWrite:work=>work(),SUBMISSION_SCHEMA_VERSION:2});
 vm.runInContext('self=globalThis;'+originalFile('extension/lib/queue.js')+originalFile('extension/lib/submission-timeline.js'),context);
 vm.runInContext('const originalNormalize=ExtLinkSubmissionTimeline.normalizeEvent;ExtLinkSubmissionTimeline.normalizeEvent=input=>originalNormalize({...input,id:input.id||"event"});',context);
 await vm.runInContext(body+'\n'+({add:'addSubmissionTimelineEvent',update:'updateSubmissionTimelineEvent',remove:'removeSubmissionTimelineEvent'})[action]+'(input)',context);return documents;
}
const baseEvent={id:'event',destinationKey:'directory.example/submit',destinationUrl:'https://directory.example/submit',profileId:'p',profileName:'原产品',occurredAt:'2026-10-07T01:00:00.000Z',type:'note',status:'note',note:'原笔记',evidenceUrl:'',publicUrl:'',source:'manual',confirmedBy:'manual'};
const initial=()=>({siteProfiles:{p:{id:'p',name:'原产品'},q:{id:'q',name:'新产品'}},submissionTimeline:{'directory.example/submit::p':[structuredClone(baseEvent)]},submissionRecords:{untouched:{status:'success',evidence:'其他历史收件',taskId:'original-task'}}});
const apply=(documents,operation)=>{const next=structuredClone(documents);Object.assign(next,originalTimelineMutation(next,operation).updates);return next;};

test('timeline add and edit match frozen original product moves, common events, evidence gates and publication rank',async()=>{
 const cases=[['note','普通笔记','',''],['submitted','','',''],['submitted','提交成功','',''],['submitted','人工记录：submitted','',''],['submitted','收到站方回执 ABC123','',''],['submitted','','https://directory.example/receipt',''],['pending_moderation','','',''],['published','确认已上线','','https://directory.example/post'],['rejected','站方拒绝','',''],['needs_follow_up','需要跟进','',''],['needs_manual','需人工','',''],['link_missing','链接失效','','']];
 for(const [type,note,evidenceUrl,publicUrl]of cases)for(const action of ['add','update']){
  const docs=initial();if(action==='add')docs.submissionTimeline={};const patch={...baseEvent,type,status:type,note,evidenceUrl,publicUrl,profileId:'q',profileName:'新产品'};delete patch.id;delete patch.confirmedBy;
  const expected=await reference(docs,action,{...patch,eventId:'event'}),operation={action,eventId:'event',...(action==='add'?{event:{...patch,id:'event'}}:{patch})};
  assert.deepEqual(apply(docs,operation),expected,action+' '+type+' '+note);
 }
 for(const profileId of ['__destination__','deleted-original-product']){const patch={...baseEvent,profileId,profileName:'旧产品或外链站',type:'published',status:'published',note:'原动态'};delete patch.id;delete patch.confirmedBy;assert.deepEqual(apply(initial(),{action:'update',eventId:'event',patch}),await reference(initial(),'update',{...patch,eventId:'event'}));}
 const docs=initial();docs.submissionRecords['directory.example/submit::p']=globalThis.ExtLinkQueue.buildSuccessRecord({...baseEvent,submittedAt:baseEvent.occurredAt,evidence:'原收件',publicationStatus:'published',publicUrl:'https://directory.example/original-post'});const patch={...baseEvent,type:'pending_moderation',status:'pending_moderation',note:'后续审核说明'};delete patch.id;delete patch.confirmedBy;assert.deepEqual(apply(docs,{action:'update',eventId:'event',patch}),await reference(docs,'update',{...patch,eventId:'event'}));
});
test('frozen original removal preserves all old receipts and a migrated event remains editable',async()=>{
 const docs=initial();docs.submissionTimeline['directory.example/submit::p'][0].source='migration';docs.submissionRecords.keep={status:'success',publicUrl:'https://old.example/post'};
 const patch={...baseEvent,note:'修正旧导入说明'};delete patch.id;delete patch.confirmedBy;assert.deepEqual(apply(docs,{action:'update',eventId:'event',patch}),await reference(docs,'update',{...patch,eventId:'event'}));
 assert.deepEqual(apply(docs,{action:'remove',eventId:'event'}),await reference(docs,'remove',{eventId:'event'}));
});
test('frozen original destination changes and a common event moved to a product preserve original receipt identities',async()=>{
 let docs=initial();const common={...baseEvent,profileId:'__destination__',profileName:'外链站',type:'published',status:'published',note:'外链站动态'};delete common.id;delete common.confirmedBy;
 docs=apply(docs,{action:'update',eventId:'event',patch:common});assert.equal(docs.submissionRecords['directory.example/submit::__destination__'],undefined);
 const patch={...common,destinationKey:'other.example/entry',destinationUrl:'https://other.example/entry',profileId:'q',profileName:'新产品',note:'核对新入口',publicUrl:'https://other.example/post'};
 assert.deepEqual(apply(docs,{action:'update',eventId:'event',patch}),await reference(docs,'update',{...patch,eventId:'event'}));assert.equal(apply(docs,{action:'update',eventId:'event',patch}).submissionRecords['other.example/entry::q'].publicationStatus,'published');
});
test('a timeline alone cannot confirm a receipt upgrade; a confirmed original new ledger needs no timestamp-only replay',()=>{
 const docs=initial(),operation={action:'update',eventId:'event',patch:{profileId:'q',type:'published',status:'published',publicUrl:'https://directory.example/post',note:'核验上线'}};const saved=apply(docs,operation);assert.equal(originalTimelineSatisfied(saved,operation),true);delete saved.submissionRecords['directory.example/submit::q'];assert.equal(originalTimelineSatisfied(saved,operation),false);assert.equal(originalTimelineSatisfied({...saved,submissionRecords:{'directory.example/submit::q':{status:'success',evidence:'wrong'}}},operation),false);
});
function runtimeFixture(file=':memory:'){const store=new Store(file),pair={endpoint:'https://cloud.example',workspaceId:'one'};store.set('pair',pair);let snapshot={documents:initial(),revisions:{submissionTimeline:1,submissionRecords:1}},online=false,lost=false,writes=0;store.set('applicationSnapshot',{scope:workbenchScope(pair),snapshot});const runtime={store,cloud:{async request(route,input){if(!online)throw Error('offline');if(route==='snapshot')return structuredClone(snapshot);writes++;const change=originalTimelineMutation(snapshot.documents,input.operation);assert.deepEqual(input.revisions,Object.fromEntries(change.revisionKeys.map(key=>[key,snapshot.revisions[key]||0])));for(const [key,data]of Object.entries(change.updates)){snapshot.documents[key]=data;snapshot.revisions[key]=(snapshot.revisions[key]||0)+1;}if(lost){lost=false;throw Error('reply lost');}return{ok:true};}}};return{store,runtime,get snapshot(){return snapshot;},get writes(){return writes;},online(){online=true;},lose(){lost=true;}};}
test('offline product move retains linked documents and frozen task state across restart and lost reply',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'el-original-timeline-')),file=join(directory,'state.sqlite'),f=runtimeFixture(file);try{f.store.set('task:unknown',{id:'unknown',attemptBoundary:{uncertain:true}});f.store.set('acceptanceBatch',{status:'paused',cursor:13,count:30});const protectedBefore=[f.store.get('task:unknown'),f.store.get('acceptanceBatch')],input={operation:{type:'timeline',action:'update',eventId:'event',patch:{profileId:'q',profileName:'新产品',type:'published',status:'published',publicUrl:'https://directory.example/post',note:'确认上线'}}};
  assert.equal((await enqueueLibraryMutation(f.runtime,input)).pending,1);const item=f.store.values('appMutation:')[0],overlaid=overlayApplication(f.runtime,f.snapshot);assert.equal(overlaid.documents.submissionRecords['directory.example/submit::q'].publicationStatus,'published');assert.equal(item.operation.type,'timeline');assert.deepEqual(item.writeKeys,timelineDocumentKeys);f.store.close();f.store=new Store(file);f.runtime.store=f.store;assert.equal(f.store.values('appMutation:')[0].id,item.id);assert.deepEqual(f.store.values('appMutation:')[0].relatedBaseData,item.relatedBaseData);f.online();f.lose();await flushApplicationMutations({...f.runtime});assert.equal(f.writes,1);assert.equal((await flushApplicationMutations({...f.runtime})).pending,0);assert.equal(f.writes,1);assert.deepEqual([f.store.get('task:unknown'),f.store.get('acceptanceBatch')],protectedBefore);assert.equal(f.store.values('appMutation:')[0].id,item.id);
 }finally{f.store.close();for(const suffix of ['','-wal','-shm'])rmSync(file+suffix,{force:true});rmdirSync(directory);}
});
test('a concurrent ledger change stops the entire timeline edit and requires reviewing its exact associated versions',async()=>{
 const f=runtimeFixture();try{await enqueueLibraryMutation(f.runtime,{operation:{type:'timeline',action:'update',eventId:'event',patch:{profileId:'q',type:'published',publicUrl:'https://directory.example/post'}}});f.snapshot.documents.submissionRecords.concurrent={status:'success',evidence:'云端新收件'};f.snapshot.revisions.submissionRecords++;f.online();await flushApplicationMutations(f.runtime);assert.equal(f.writes,0);const item=f.store.values('appMutation:')[0];assert.equal(item.status,'conflict');await assert.rejects(resolveApplicationConflict(f.runtime,{id:item.id,choice:'local',revision:1}),/关联台账/);await resolveApplicationConflict(f.runtime,{id:item.id,choice:'local',revision:1,revisions:Object.fromEntries(Object.keys(item.relatedBaseRevisions).map(key=>[key,f.snapshot.revisions[key]||0]))});assert.equal(f.writes,1);assert.equal(f.snapshot.documents.submissionRecords.concurrent.evidence,'云端新收件');assert.equal(f.store.values('appMutation:')[0].resolution.originalRelatedBaseData.submissionRecords.untouched.evidence,'其他历史收件');
 }finally{f.store.close();}
});

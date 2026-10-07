import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {libraryMutation,libraryMutationSatisfied} from '../core/library-mutation.mjs';
import {applicationMutationDependencies} from '../core/application-mutation-dependencies.mjs';
import {Store} from '../executor/src/store.mjs';
import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {enqueueLibraryMutation,flushApplicationMutations,overlayApplication} from '../executor/src/application-mutations.mjs';
const baseline='bd916b2944a577b160a6afcb8a7d73d263044c0c',at='2026-10-07T00:00:00.000Z',Q=globalThis.ExtLinkQueue;
function originalFunction(name){const text=execFileSync('git',['show',baseline+':extension/background.js'],{encoding:'utf8',maxBuffer:3*1024*1024}),start=text.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert.ok(start>=0);const rest=text.slice(start),next=rest.slice(rest.indexOf('\n')+1).search(/^(?:async )?function /m);return next<0?rest:rest.slice(0,rest.indexOf('\n')+1+next);}
const plain=value=>JSON.parse(JSON.stringify(value)),withoutIds=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='mutationId'?undefined:item));
test('native automatic observation matches original writer for manual verdicts, automatic deletion and canonical aliases',async()=>{
 const statuses=[{status:'can_submit',statuses:['can_submit'],auto:false,note:'User note',library:{favorite:true,groups:['high_quality','original'],profileIds:['p']}},{status:'deleted',statuses:['deleted'],auto:false,note:'Keep deleted',submittedProjects:['original']},{status:'deleted',statuses:['deleted'],auto:true,note:'Old automatic note'},{auto:true,note:'Old automatic note'},{}, {statuses:['needs_login','can_submit'],auto:false,library:{groups:['original']}}];
 for(const [index,previous]of statuses.entries())for(const url of ['https://directory.example/submit','https://startupstash.com/submit']){
  const key=Q.normalizeLibraryDestinationKey(url),domain=Q.extractDomain(url),documents={siteAnnotations:{[key]:previous},deletedSubmissionKeys:[key,'retained.example/old']},status=index===3?'deleted':'needs_captcha';let original=structuredClone(documents);
  class Clock extends Date{constructor(...args){super(...(args.length?args:[at]));}}
  const context=vm.createContext({self:{ExtLinkQueue:Q},Date:Clock,URL,chrome:{storage:{local:{get:async()=>original,set:async update=>Object.assign(original,plain(update))}}}});
  vm.runInContext(originalFunction('siteKeyForUrl')+'\n'+originalFunction('writeSubmissionSiteAnnotation'),context);await context.writeSubmissionSiteAnnotation({url,status,note:'Actual CAPTCHA gate',auto:true});
  const operation={type:'automatic_mark',id:'native-'+index,at,url,status,note:'Actual CAPTCHA gate'},next=libraryMutation(documents,operation),native={...documents,...next.updates};assert.deepEqual(withoutIds(native),original);assert.equal(libraryMutationSatisfied(native,operation),true);assert.deepEqual(native.siteAnnotations[domain],native.siteAnnotations[key]);assert.deepEqual(applicationMutationDependencies(operation),['siteAnnotations','deletedSubmissionKeys']);assert.deepEqual(documents.siteAnnotations[key],previous);
 }
});
test('offline automatic observation and deleted-key update confirm a lost reply after independent readback without replay',async()=>{
 const home=mkdtempSync(join(tmpdir(),'el-original-observation-'));let store=new Store(join(home,'outbox.sqlite'));try{
  store.set('pair',{endpoint:'https://cloud.fixture.invalid',workspaceId:'original'});const scope=workbenchScope(store.get('pair'));let snapshot={documents:{siteAnnotations:{'directory.example/submit':{status:'deleted',statuses:['deleted'],auto:true,library:{favorite:true,groups:['original']}}},deletedSubmissionKeys:['directory.example/submit','retained.example/old'],submissionRecords:{receipt:{status:'success',evidence:'Keep original'}}},revisions:{siteAnnotations:1,deletedSubmissionKeys:1}},online=false,writes=0;
  store.set('applicationSnapshot',{scope,snapshot:structuredClone(snapshot)});const runtime={store,cloud:{async request(route,input){if(!online){assert.equal(store.values('appMutation:').length,1);throw Error('offline');}if(route==='snapshot')return structuredClone(snapshot);assert.equal(route,'library');assert.deepEqual(input.revisions,{siteAnnotations:1,deletedSubmissionKeys:1});writes++;const change=libraryMutation(snapshot.documents,input.operation);Object.assign(snapshot.documents,change.updates);for(const key of Object.keys(change.updates))snapshot.revisions[key]++;throw Error('reply lost after atomic write');}}};
  const queued=await enqueueLibraryMutation(runtime,{operation:{type:'automatic_mark',url:'https://directory.example/submit',status:'needs_captcha',note:'Actual CAPTCHA gate'}});assert.equal(queued.pending,1);const local=overlayApplication(runtime,snapshot);assert.equal(local.documents.siteAnnotations['directory.example/submit'].status,'needs_captcha');assert.deepEqual(local.documents.deletedSubmissionKeys,['retained.example/old']);assert.equal(store.values('appMutation:')[0].relatedBaseRevisions.deletedSubmissionKeys,1);
  online=true;await flushApplicationMutations(runtime);assert.equal(writes,1);store.close();store=new Store(join(home,'outbox.sqlite'));await flushApplicationMutations({store,cloud:runtime.cloud});assert.equal(writes,1);assert.equal(store.values('appMutation:')[0].status,'confirmed');assert.equal(snapshot.documents.siteAnnotations['directory.example/submit'].library.favorite,true);assert.deepEqual(snapshot.documents.submissionRecords,{receipt:{status:'success',evidence:'Keep original'}});
 }finally{store.close();assert.ok(resolve(home).startsWith(resolve(tmpdir())+sep)&&home.includes('el-original-observation-'));rmSync(home,{recursive:true,force:true});}
});
test('automatic observation keeps concurrent manual/deletion edits as conflict and never degrades into one-document recovery',async()=>{
 const store=new Store(':memory:');try{
  store.set('pair',{endpoint:'https://cloud.fixture.invalid',workspaceId:'original'});const scope=workbenchScope(store.get('pair')),snapshot={documents:{siteAnnotations:{original:{note:'Retained original local'}},deletedSubmissionKeys:['retained.example/old']},revisions:{siteAnnotations:0,deletedSubmissionKeys:1}};store.set('applicationSnapshot',{scope,snapshot});let writes=0;
  const runtime={store,cloud:{async request(route){if(route==='snapshot')return{documents:{deletedSubmissionKeys:['concurrent.example/new']},revisions:{deletedSubmissionKeys:2}};writes++;throw Error('Must preserve concurrent data');}}};
  await enqueueLibraryMutation(runtime,{operation:{type:'automatic_mark',url:'https://directory.example/submit',status:'needs_captcha',note:'Actual gate'}});const pending=store.values('appMutation:')[0];assert.equal(pending.operation.type,'automatic_mark');assert.equal(pending.status,'conflict');assert.equal(writes,0);assert.deepEqual(pending.baseData,snapshot.documents.siteAnnotations);assert.deepEqual(pending.relatedBaseData.deletedSubmissionKeys,snapshot.documents.deletedSubmissionKeys);
 }finally{store.close();}
});

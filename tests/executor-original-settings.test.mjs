import test from 'node:test';import assert from 'node:assert/strict';
import {Store} from '../executor/src/store.mjs';import {workbenchScope} from '../executor/src/workbench-sync.mjs';
import {applicationData} from '../executor/src/application-data.mjs';
import {enqueueLibraryMutation,flushApplicationMutations} from '../executor/src/application-mutations.mjs';
import {libraryMutation} from '../core/library-mutation.mjs';import {localRecoveryDocuments} from '../core/local-recovery.mjs';
import {validateApplicationBackup,mergeApplicationBackup,exportApplicationBackup,applicationBackupFragment} from '../core/application-backup.mjs';
import {workbenchBackup} from '../executor/src/workbench-backup.mjs';import{checkMonitorSchedule}from'../executor/src/link-monitor.mjs';
const profile={id:'p',name:'Original',fields:{Name:'Original',Url:'https://product.example'}};
const documents=()=>({siteProfiles:{p:profile},submissionRecords:{},autoSubmitDirectoryListings:false,autoSubmitStandardWpComments:true,linkMonitorEnabled:false,linkMonitorMinutes:60});
function fixture(){const store=new Store(':memory:');store.set('pair',{endpoint:'https://cloud.example',workspaceId:'original-settings'});store.set('paused',true);let snapshot={documents:documents(),revisions:{}},online=true,lost=false,writes=0;const runtime={store,status:()=>({tasks:[],paused:true,busy:false,pendingEvents:0}),cloud:{async request(route,input){if(!online)throw Error('offline');if(route==='snapshot')return structuredClone(snapshot);if(route==='library'){const change=libraryMutation(snapshot.documents,input.operation);assert.equal(input.revision,snapshot.revisions[change.key]||0);snapshot.documents[change.key]=change.data;snapshot.revisions[change.key]=(snapshot.revisions[change.key]||0)+1;writes++;if(lost){lost=false;throw Error('reply lost after commit');}return{ok:true};}throw Error(route);}}};return{store,runtime,snapshot,setOnline(v){online=v;},lose(){lost=true;},get writes(){return writes;}};}
test('original auto-submit settings appear in application readback and persist offline without releasing execution',async()=>{
 const f=fixture();try{let data=await applicationData(f.runtime,{refresh:true});assert.equal(data.settings.autoSubmitDirectoryListings,false);assert.equal(data.settings.autoSubmitStandardWpComments,true);assert.deepEqual(data.settings.linkMonitorSchedule,{enabled:false,minutes:60});
 assert.equal(f.store.get('applicationSnapshot').snapshot.documents.linkMonitorSchedule,undefined);f.setOnline(false);const edit=await enqueueLibraryMutation(f.runtime,{operation:{type:'settings',key:'autoSubmitStandardWpComments',value:false}});assert.equal(edit.persisted,true);data=await applicationData(f.runtime);assert.equal(data.settings.autoSubmitStandardWpComments,false);assert.equal(f.store.get('paused'),true);assert.equal(f.writes,0);
 f.setOnline(true);f.lose();await flushApplicationMutations(f.runtime);assert.equal(f.writes,1);await flushApplicationMutations(f.runtime);assert.equal(f.writes,1);data=await applicationData(f.runtime,{refresh:true});assert.equal(data.settings.autoSubmitStandardWpComments,false);assert.equal(data.pendingEdits.length,0);
 const saved=await enqueueLibraryMutation(f.runtime,{operation:{type:'settings',key:'linkMonitorSchedule',value:data.settings.linkMonitorSchedule}});assert.equal(saved.pending,0);assert.deepEqual(f.snapshot.documents.linkMonitorSchedule,{enabled:false,minutes:60});for(const key of ['autoSubmitDirectoryListings','autoSubmitStandardWpComments'])for(const value of ['false',1,null,{},[]])assert.throws(()=>libraryMutation(documents(),{id:'invalid',at:'now',type:'settings',key,value}),/设置/);
 }finally{f.store.close();}
});
test('legacy monitor settings retain disabled state and original rounding and bounds in recovery, import, fragments and export',()=>{
 for(const [minutes,expected]of [[60,60],[15.6,16],[0,15],[-1,15],[999999,10080],['invalid',1440]]){
  const old={...documents(),linkMonitorMinutes:minutes},expectedSchedule={enabled:false,minutes:expected};
  for(const wrapper of [old,{documents:old},{snapshot:{documents:old}}])assert.deepEqual(localRecoveryDocuments(wrapper).linkMonitorSchedule,expectedSchedule);
  const raw={format:'externallink-submission-backup',...old},imported=validateApplicationBackup(raw);assert.deepEqual(imported.linkMonitorSchedule,expectedSchedule);assert.deepEqual(mergeApplicationBackup({},imported).linkMonitorSchedule,expectedSchedule);assert.deepEqual(applicationBackupFragment(raw,'linkMonitorSchedule').linkMonitorSchedule,expectedSchedule);assert.deepEqual(exportApplicationBackup(old).linkMonitorSchedule,expectedSchedule);
 }
 assert.deepEqual(localRecoveryDocuments({...documents(),linkMonitorSchedule:{enabled:true,minutes:120,desktopNotifications:false}}).linkMonitorSchedule,{enabled:true,minutes:120,desktopNotifications:false});
 const noOriginalKeys={siteProfiles:{p:profile},submissionRecords:{}};assert.equal(localRecoveryDocuments(noOriginalKeys).linkMonitorSchedule,undefined);
});
test('legacy raw backup confirmation writes the normalized monitor fragment using its original import plan',async()=>{
 const f=fixture();try{const {preview}=await workbenchBackup(f.runtime,'previewBackup',{backup:{format:'externallink-submission-backup',...documents()}});assert.ok(preview.changes.includes('linkMonitorSchedule'));const result=await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(result.remaining,0);assert.deepEqual(f.snapshot.documents.linkMonitorSchedule,{enabled:false,minutes:60});assert.equal(f.store.get('paused'),true);const writes=f.writes;await workbenchBackup(f.runtime,'importBackup',{id:preview.id});assert.equal(f.writes,writes);}finally{f.store.close();}
});
test('legacy disabled monitor stays disabled before saving while new canonical settings take precedence',async()=>{
 const f=fixture();try{f.store.set('applicationSnapshot',{scope:workbenchScope(f.store.get('pair')),snapshot:f.snapshot});await checkMonitorSchedule(f.runtime,Date.now());assert.equal(f.store.values('linkMonitorScheduler:').length,0);assert.equal(f.store.values('linkMonitorJob:').length,0);f.snapshot.documents.linkMonitorSchedule={enabled:true,minutes:30};f.store.set('applicationSnapshot',{scope:workbenchScope(f.store.get('pair')),snapshot:f.snapshot});await checkMonitorSchedule(f.runtime,Date.now());assert.equal(f.store.values('linkMonitorScheduler:').length,1);}finally{f.store.close();}
});
test('backup import rejects non-boolean auto-submit preferences instead of silently changing the original behavior',()=>{
 for(const key of ['autoSubmitDirectoryListings','autoSubmitStandardWpComments'])for(const value of ['false',1,null,{},[]])assert.throws(()=>validateApplicationBackup({format:'externallink-submission-backup',...documents(),[key]:value}),/提交设置/);
});

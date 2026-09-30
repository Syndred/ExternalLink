import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';import {join,resolve,dirname} from 'node:path';import {tmpdir} from 'node:os';
import {Store} from '../executor/src/store.mjs';import {setupInfo,connectWorkbench} from '../executor/src/workbench-connect.mjs';import {resetWorkspace} from '../executor/src/workspace-reset.mjs';
test('first connection verifies enrollment, rejects expired nonce and preserves an existing device',async()=>{
 const home=resolve(await mkdtemp(join(tmpdir(),'externallink-setup-'))),store=new Store(join(home,'outbox.sqlite')),config={endpoint:'https://cloud.test',workspaceId:'w',deviceId:'device',deviceToken:'eld_test',storageBackend:'d1'};
 try{await writeFile(join(home,'enrollment.json'),JSON.stringify(config));const runtime={store,home,CloudClass:class{constructor(c){assert.deepEqual(c,config);}async request(route){assert.equal(route,'snapshot');return{deviceId:'device',workspaceId:'w',documents:{siteProfiles:{}},revisions:{siteProfiles:1}};}}};
 const info=await setupInfo(runtime);assert.equal(info.enrollmentAvailable,true);await assert.rejects(connectWorkbench(runtime,{nonce:'wrong'}),/过期/);assert.equal(store.get('pair'),null);
 const result=await connectWorkbench(runtime,{nonce:info.nonce});assert.equal(result.deviceId,'device');assert.equal(store.get('paused'),true);assert.equal(store.get('applicationSnapshot').snapshot.revisions.siteProfiles,1);assert.equal(store.get('workbenchSetupNonce'),null);
 const paired=store.get('pair');await assert.rejects(connectWorkbench(runtime,{nonce:info.nonce,enrollment:{...config,deviceId:'other'}}),/已有连接/);assert.deepEqual(store.get('pair'),paired);
 }finally{store.close();assert.equal(dirname(home),resolve(tmpdir()));await rm(home,{recursive:true,force:true});}
});
test('local clear creates an intact private SQLite recovery backup before removing state and pending events',async()=>{
 const home=resolve(await mkdtemp(join(tmpdir(),'externallink-reset-'))),store=new Store(join(home,'outbox.sqlite'));try{
 store.set('pair',{deviceToken:'private-test',localToken:'local-test'});store.set('paused',true);store.transition({id:'original',status:'submitted_unconfirmed',attemptBoundary:'original'},'unknown');await mkdir(join(home,'browser-profile-stable'));await writeFile(join(home,'original.png'),'existing-file');
 const runtime={store,home,backupRoot:join(home,'backups')};await assert.rejects(resetWorkspace(runtime,{confirmation:'wrong'}),/确认/);assert.equal(store.pendingCount(),1);runtime.linkMonitorJob=Promise.resolve();await assert.rejects(resetWorkspace(runtime,{confirmation:'清空本机工作区'}),/后台/);runtime.linkMonitorJob=null;
 const result=await resetWorkspace(runtime,{confirmation:'清空本机工作区'});assert.equal(result.integrity,'ok');assert.equal(store.get('pair'),null);assert.equal(store.pendingCount(),0);assert.equal(store.get('paused'),true);
 const backup=new Store(join(result.backupDirectory,'outbox.sqlite'),{readOnly:true});try{assert.equal(backup.get('pair').deviceToken,'private-test');assert.equal(backup.get('task:original').attemptBoundary,'original');assert.equal(backup.pendingCount(),1);}finally{backup.close();}
 }finally{store.close();assert.equal(dirname(home),resolve(tmpdir()));await rm(home,{recursive:true,force:true});}
});

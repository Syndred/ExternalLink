import test from 'node:test';import assert from 'node:assert/strict';
import { GmailSync,parseDesktopClient } from '../executor/src/gmail-sync.mjs';
const fixture=()=>{const data=new Map();return{get:key=>data.get(key)||null,set:(key,value)=>{data.set(key,structuredClone(value));return value;},values:prefix=>[...data].filter(([k])=>k.startsWith(prefix)).map(([,v])=>structuredClone(v))};};
test('client import accepts only installed Google clients',()=>{
 assert.throws(()=>parseDesktopClient({web:{client_id:'test.apps.googleusercontent.com'}}),/桌面/);
 assert.throws(()=>parseDesktopClient({installed:{client_id:'bad'}}),/客户端/);
 assert.equal(parseDesktopClient({installed:{client_id:'test.apps.googleusercontent.com',client_secret:'fixture'}}).client_id,'test.apps.googleusercontent.com');
});
test('local mail detail renders content as text and rejects arbitrary record identities',()=>{
 const store=fixture();store.set('gmail',{emailAddress:'fixture@example.com'});store.set('gmailMessage:mail1',{id:'mail1',emailAddress:'fixture@example.com',from:'sender@example.com',subject:'Review',at:'2026-09-30',sha256:'hash',payload:{mimeType:'text/html',body:{data:Buffer.from('<script>private</script>').toString('base64url')}}});
 const sync=new GmailSync({store,vault:{}});assert.equal(sync.message('mail1').text,'<script>private</script>');assert.equal(sync.message('mail1').source,'gmail_readonly');assert.throws(()=>sync.message('../pair'),/身份/);assert.throws(()=>sync.message('missing'),/尚未同步/);assert.equal(sync.message('mail1').payload,undefined);
});
test('unowned legacy mail stays quarantined when no original mailbox was recorded',()=>{
 const store=fixture();store.set('gmailMessage:secret',{id:'secret',subject:'unknown owner'});const sync=new GmailSync({store,vault:{}});
 assert.equal(sync.status().messageCount,0);assert.throws(()=>sync.message('secret'),/邮箱/);
 store.set('gmail',{...store.get('gmail'),emailAddress:'new@example.com'});const restarted=new GmailSync({store,vault:{}});assert.equal(restarted.status().messageCount,0);assert.equal(store.get('gmailMessage:secret').emailAddress,undefined);
});
test('an interrupted migration keeps the original mailbox owner after account metadata changes',()=>{
 const store=fixture();store.set('gmail',{emailAddress:'old@example.com'});store.set('gmailMessage:a',{id:'a'});store.set('gmailMessage:b',{id:'b'});
 const set=store.set;store.set=(key,value)=>{if(key==='gmailMessage:b')throw Error('interrupted');return set(key,value);};assert.throws(()=>new GmailSync({store,vault:{}}),/interrupted/);
 store.set=set;store.set('gmail',{...store.get('gmail'),emailAddress:'new@example.com'});const sync=new GmailSync({store,vault:{}});assert.equal(sync.status().messageCount,0);assert.equal(store.get('gmailMessage:b').emailAddress,'old@example.com');
});
test('timer sync waits for account refresh verification before using a mailbox cursor',async()=>{
 const store=fixture();store.set('gmail',{emailAddress:'old@example.com',historyId:'900'});let releaseRefresh;const refreshGate=new Promise(resolve=>releaseRefresh=resolve),routes=[];
 const vault={read:async name=>name==='gmail-client'?{client_id:'test.apps.googleusercontent.com'}:{access_token:'fixture',refresh_token:'refresh',expiresAt:Date.now()+3600000},write:async()=>{}};
 const sync=new GmailSync({store,vault,fetcher:async url=>{routes.push(url);if(url.includes('/token')){await refreshGate;return Response.json({access_token:'new',expires_in:3600});}if(url.endsWith('/profile'))return Response.json({emailAddress:'new@example.com',historyId:'100'});if(url.includes('/messages?'))return Response.json({messages:[]});throw Error('An old mailbox cursor was used during refresh');}});
 const refreshing=sync.refresh();await new Promise(resolve=>setImmediate(resolve));const syncing=sync.sync();await new Promise(resolve=>setImmediate(resolve));assert.ok(!routes.some(url=>url.includes('/history')));releaseRefresh();await refreshing;await syncing;assert.equal(store.get('gmail').emailAddress,'new@example.com');
});
test('incremental cursor advances only after messages are durably saved, without modifying Gmail',async()=>{
 const store=fixture();store.set('gmail',{status:'connected',historyId:'100'});
 const calls=[],vault={read:async name=>name==='gmail-client'?{client_id:'test.apps.googleusercontent.com'}:{access_token:'fixture',refresh_token:'refresh',expiresAt:Date.now()+3600000}};
 const sync=new GmailSync({store,vault,fetcher:async(url,options)=>{calls.push({url,method:options.method});if(url.includes('/history?'))return Response.json({history:[{messagesAdded:[{message:{id:'mail1'}}]}],historyId:'102'});if(url.endsWith('/messages/mail1?format=full'))return Response.json({id:'mail1',internalDate:'1000',snippet:'received',payload:{headers:[{name:'From',value:'Support <help@bai.tools>'},{name:'Subject',value:'Graffiti received'}]}});throw Error('Unexpected request');}});
 await sync.sync();assert.equal(store.get('gmail').historyId,'102');assert.equal(store.get('gmail').lastSyncMode,'history');assert.equal(store.values('gmailMessage:').length,1);assert.ok(calls.every(c=>c.method==='GET'));
 store.set('gmail',{status:'connected',historyId:'100'});const failed=new GmailSync({store,vault,fetcher:async url=>url.includes('/history?')?Response.json({history:[{messagesAdded:[{message:{id:'mail2'}}]}],historyId:'103'}):Response.json({error:{message:'private error'}},{status:503})});
 await assert.rejects(failed.sync());assert.equal(store.get('gmail').historyId,'100');assert.doesNotMatch(store.get('gmail').error,/private error/);
});
test('expired access refresh persists rotated grant in vault only',async()=>{
 const store=fixture(),saved=[],tokens={access_token:'old',refresh_token:'refresh',expiresAt:0};
 const vault={read:async name=>name==='gmail-client'?{client_id:'test.apps.googleusercontent.com'}:tokens,write:async(name,value)=>saved.push({name,value})};
 const sync=new GmailSync({store,vault,fetcher:async()=>Response.json({access_token:'new',expires_in:3600,refresh_token_expires_in:604800})});assert.equal(await sync.accessToken(),'new');assert.equal(saved[0].value.refresh_token,'refresh');assert.ok(Date.parse(store.get('gmail').refreshGrantExpiresAt)>Date.now()+6*86400000);assert.doesNotMatch(JSON.stringify(store.get('gmail')),/refresh_token|access_token/);
});
test('initial import pages resume after restart and hold the incremental cursor until complete',async()=>{
 const store=fixture(),vault={read:async()=>({access_token:'fixture',refresh_token:'refresh',expiresAt:Date.now()+3600000})};let profiles=0;
 const fetcher=async url=>{if(url.endsWith('/profile')){profiles++;return Response.json({emailAddress:'fixture@example.com',historyId:'200'});}if(url.includes('/messages?'))return Response.json(url.includes('pageToken=next')?{messages:[{id:'second'}]}:{messages:[{id:'first'}],nextPageToken:'next'});if(url.includes('/messages/'))return Response.json({id:url.includes('/first?')?'first':'second',internalDate:'1000',payload:{}});throw Error('Unexpected request');};
 await new GmailSync({store,vault,fetcher}).sync();assert.equal(store.get('gmail').historyId,undefined);assert.equal(store.get('gmail').initialSync.pageToken,'next');assert.equal(store.values('gmailMessage:').length,1);
 await new GmailSync({store,vault,fetcher}).sync();assert.equal(store.get('gmail').historyId,'200');assert.equal(store.get('gmail').initialSync,null);assert.equal(profiles,1);assert.equal(store.values('gmailMessage:').length,2);
});
test('reauthorizing another mailbox resets its cursor and does not mix historical messages',async()=>{
 const store=fixture(),vault={read:async()=>({access_token:'fixture',refresh_token:'refresh',expiresAt:Date.now()+3600000})};store.set('gmail',{emailAddress:'old@example.com',historyId:'900',validateAccount:true});store.set('gmailMessage:old1',{id:'old1',emailAddress:'old@example.com'});
 const routes=[],sync=new GmailSync({store,vault,fetcher:async url=>{routes.push(url);if(url.endsWith('/profile'))return Response.json({emailAddress:'new@example.com',historyId:'100'});if(url.includes('/messages?'))return Response.json({messages:[]});throw Error('Old mailbox history must not be read');}});
 await sync.sync();assert.equal(store.get('gmail').emailAddress,'new@example.com');assert.equal(store.get('gmail').historyId,'100');assert.equal(sync.status().messageCount,0);assert.equal(store.values('gmailMessage:').length,1);assert.ok(!routes.some(url=>url.includes('/history')));assert.throws(()=>sync.message('old1'),/邮箱/);
});
test('existing authorization restart migrates legacy messages and isolates legacy associations before history',async()=>{
 const store=fixture();store.set('gmail',{emailAddress:'old@example.com',historyId:'900'});
 store.set('gmailMessage:same',{id:'same',subject:'Old mail',payload:{}});
 store.set('gmailAssociation:same',{messageId:'same',status:'associated',identity:'directory.example::p'});
 const sync=new GmailSync({store,vault:{},fetcher:async()=>{throw Error('Network unavailable');}});
 assert.equal(sync.status().messageCount,1);assert.equal(sync.message('same').subject,'Old mail');
 assert.equal(store.get('gmailAssociation:same').emailAddress,'old@example.com');
 assert.equal(store.values('gmailAssociation:').filter(a=>a.emailAddress==='old@example.com'&&a.status==='associated').length,1);
 const restarted=new GmailSync({store,vault:{}});assert.equal(restarted.status().messageCount,1);
});
test('switch and refresh preserve old legacy ownership and fetch colliding message IDs for the new account',async()=>{
 const store=fixture();store.set('gmail',{emailAddress:'old@example.com',historyId:'900',initialSync:{pageToken:'old-page'},validateAccount:true});
 store.set('gmailMessage:same',{id:'same',subject:'Old secret',payload:{}});store.set('gmailAssociation:same',{messageId:'same',status:'associated'});
 const vault={read:async name=>name==='gmail-client'?{client_id:'test.apps.googleusercontent.com'}:{access_token:'fixture',refresh_token:'refresh',expiresAt:Date.now()+3600000},write:async()=>{}};
 const fetcher=async url=>{if(url.includes('/token'))return Response.json({access_token:'new',expires_in:3600});if(url.endsWith('/profile'))return Response.json({emailAddress:'new@example.com',historyId:'100'});if(url.includes('/messages?'))return Response.json({messages:[{id:'same'}]});if(url.includes('/messages/same?'))return Response.json({id:'same',internalDate:'1000',payload:{headers:[{name:'Subject',value:'New mail'}]}});throw Error('Old cursor must not be used');};
 const sync=new GmailSync({store,vault,fetcher});await sync.refresh();assert.equal(store.get('gmail').historyId,null);assert.equal(store.get('gmail').initialSync,null);assert.throws(()=>sync.message('same'),/邮箱/);
 await sync.sync();assert.equal(sync.message('same').subject,'New mail');assert.equal(sync.status().messageCount,1);
 assert.equal(store.get('gmailMessage:same').emailAddress,'old@example.com');assert.equal(store.get('gmailAssociation:same').emailAddress,'old@example.com');
 assert.equal(store.values('gmailMessage:').length,2);
});

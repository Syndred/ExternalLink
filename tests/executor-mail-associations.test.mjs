import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {Store} from '../executor/src/store.mjs';
import {currentMailAssociations} from '../executor/src/mail-associations.mjs';
test('canonical account association wins over legacy aliases without duplicate reply evidence or stale historical matches',()=>{
 const store=new Store(':memory:'),emailAddress='fixture@example.com',hash=createHash('sha256').update(emailAddress).digest('hex').slice(0,24);store.set('gmail',{emailAddress});
 const legacy={messageId:'m',emailAddress,status:'associated',identity:'site.example::p'};store.set('gmailAssociation:m',legacy);store.set('gmailAssociation:'+hash+':m',legacy);
 assert.equal(currentMailAssociations(store).length,1);
 store.set('gmailAssociation:'+hash+':m',{messageId:'m',emailAddress,status:'unmatched'});assert.equal(currentMailAssociations(store).length,0);
 store.set('gmailAssociation:other',{...legacy,messageId:'other',emailAddress:'old@example.com'});assert.equal(currentMailAssociations(store).length,0);store.close();
});

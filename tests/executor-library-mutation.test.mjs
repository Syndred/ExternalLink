import test from 'node:test';import assert from 'node:assert/strict';import {libraryMutation} from '../core/library-mutation.mjs';
test('library import deduplicates identities without discarding table metadata or changing the source',()=>{
 const docs={sheetTableData:{source:'original',entries:[{link:'https://site.example/',da:42,note:'original'}]}};
 const result=libraryMutation(docs,{id:'i',at:'now',type:'import',urls:['https://site.example/','https://new.example/submit','https://new.example/submit']});assert.equal(result.data.entries.length,2);assert.equal(result.data.entries[0].da,42);assert.equal(result.data.source,'original');assert.equal(docs.sheetTableData.entries.length,1);
 assert.throws(()=>libraryMutation(docs,{id:'i',at:'now',type:'import',urls:['chrome://extensions']}),/HTTP/);
});
test('site marking preserves submission history and remains distinct from receipt evidence',()=>{
 const docs={siteAnnotations:{'site.example/submit':{lastSuccessAt:'before',status:'needs_login'}},submissionRecords:{receipt:{evidence:'Received'}}};
 const next=libraryMutation(docs,{id:'m',at:'now',type:'mark',url:'https://site.example/submit',status:'deleted',note:'User archived'});assert.equal(next.data['site.example/submit'].lastSuccessAt,'before');assert.deepEqual(docs.submissionRecords,{receipt:{evidence:'Received'}});assert.equal(next.key,'siteAnnotations');
});

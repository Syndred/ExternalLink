import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
const fragment=source.slice(source.indexOf('  function isNonSubmissionUtilityField('),source.indexOf('  // ─── Waiting banner overlay'));
const owner={},doc={};const c=vm.createContext({document:doc,hasLikelyListingFields:()=>true,hasLikelySubmissionFields:()=>true,getFieldHint:e=>e.label+' '+e.name,getSnapshotLabel:e=>e.label});vm.runInContext(fragment,c);
const input=(label,name='s',type='text')=>({label,name,type,closest:s=>s==='form'?owner:null});
test('WordPress and plain text search inputs stay outside all automatic fill/report scopes',()=>{
 for(const e of [input('Search This Website Search'),input('Search…','q'),input('检索网站'),input('','search','search')])assert.equal(c.isNonSubmissionUtilityField(e),true);
 assert.equal(c.isNonSubmissionUtilityField(input('AI Tool Website','website','url')),false);
});

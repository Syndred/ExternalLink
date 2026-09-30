import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function receipt(text,sourceUrl='https://10015.io/product-finder/submit') {
 const c=vm.createContext({URL,location:{hostname:'10015.io',pathname:'/product-finder/submit',href:'https://10015.io/product-finder/submit'}});
 const start=source.indexOf('  function classify10015Receipt(');if(start<0)return null;
 vm.runInContext(source.slice(start,source.indexOf('  function classifyVisibleEvidence(',start)),c);return c.classify10015Receipt(text,sourceUrl);
}
const text='Thanks for submitting your product! "JevPlay" has been submitted successfully. Every product submission goes through a review queue. Standard Review 3-4 Months Free Priority Review $9.99';
test('The final explicit product receipt is pending moderation despite optional paid priority review',()=>{
 const r=receipt(text);assert.equal(r?.matched,true);assert.equal(r.publicationStatus,'pending_moderation');assert.match(r.evidence,/JevPlay/);
});
test('Preview, pricing and a mismatched directory source cannot count as product acceptance',()=>{
 for(const copy of ['Product Preview JevPlay Free Submit Product','Standard Review Free Priority Review $9.99','Thanks for submitting your product!'])assert.equal(receipt(copy),null);
 assert.equal(receipt(text,'https://other.test'),null);
});

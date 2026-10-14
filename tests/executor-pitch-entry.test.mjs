import test from 'node:test';
import assert from 'node:assert/strict';
import {chooseObservedEntry} from '../executor/src/runtime.mjs';

const current='https://startup88.com/';
const form='https://startup88.typeform.com/to/CRjWqM';

test('observed startup pitch entry follows the unique hosted form and ignores category navigation',()=>{
 const links=[
  {text:'Pitch Your Startup',href:form},
  {text:'Pitch your Startup',href:'https://startup88.com/category/startups'},
  {text:'Pitch Your Startup or Product',href:form},
  {text:'Get 100s of Leads',href:'https://startup88.typeform.com/to/XBRRjJ'},
 ];
 assert.equal(chooseObservedEntry(current,links)?.href,form);
});

test('observed product pitch accepts a same-site submission path',()=>{
 for(const path of ['/submit','/submit-product','/submission/new','/pitch-your-startup']){
  const href=new URL(path,current).href;
  assert.equal(chooseObservedEntry(current,[{text:'Pitch Your Product',href}])?.href,href,path);
 }
});

test('pitch entry preserves the permitted hosted form origins',()=>{
 for(const href of ['https://tally.so/r/example','https://airtable.com/appExample/form','https://forms.gle/example','https://example.formaloo.net/form']){
  assert.equal(chooseObservedEntry(current,[{text:'Pitch Your Startup',href}])?.href,href);
 }
});

test('pitch labels do not turn same-site category, news, or contact links into submission entries',()=>{
 for(const path of ['/category/startups','/tag/startup','/blog/pitch-your-startup','/news/pitch-your-product','/contact','/about']){
  assert.equal(chooseObservedEntry(current,[{text:'Pitch Your Startup',href:new URL(path,current).href}]),null,path);
 }
});

test('pitch entry rejects mail, unrelated origins, credentials, and insecure hosted forms',()=>{
 for(const href of ['mailto:editor@startup88.com','https://unrelated.example/submit','https://typeform.com.unrelated.example/to/form','https://user:password@startup88.typeform.com/to/form','http://startup88.typeform.com/to/form','chrome://settings']){
  assert.equal(chooseObservedEntry(current,[{text:'Pitch Your Startup',href}]),null,href);
 }
});

test('pitch entry does not broaden arbitrary editorial or email pitches',()=>{
 for(const text of ['Pitch to us','Pitch your story','Pitch your startup by email','Pitch your news','Pitch Your Startup - contact our editor']){
  assert.equal(chooseObservedEntry(current,[{text,href:form}]),null,text);
 }
});

test('multiple observed pitch form destinations remain ambiguous',()=>{
 assert.equal(chooseObservedEntry(current,[{text:'Pitch Your Startup',href:form},{text:'Pitch Your Product',href:'https://startup88.typeform.com/to/OTHER'}]),null);
});

test('ordinary submission entries retain their existing selection behavior',()=>{
 const href='https://startup88.com/submit';
 assert.equal(chooseObservedEntry(current,[{text:'Submit a product',href}])?.href,href);
 assert.equal(chooseObservedEntry(current,[{text:'Submit a product',href},{text:'Pitch Your Startup',href:form}]),null);
});

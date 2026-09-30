import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function classify(host='10015.io',path='/product-finder/submit',expanded=true) {
  const c=vm.createContext({location:{hostname:host,pathname:path},document:{querySelector:()=>expanded?{}:null},PLATFORMS:{forum:{match:()=>true}},detectWPComment:()=>false,detectArticleComment:()=>false,detectSubmissionForm:()=>false});
  vm.runInContext(source.slice(source.indexOf('  function identifyPlatform('),source.indexOf('  // ==============================',source.indexOf('  function identifyPlatform('))),c);return c.identifyPlatform();
}
test('10015 expanded product submission outranks logged in account menu forum markers',()=>assert.equal(classify(),'submission'));
test('The directory rule does not turn login, other pages or unrelated forums into submissions',()=>{assert.equal(classify('10015.io','/profile'),'forum');assert.equal(classify('other.test'),'forum');assert.equal(classify('10015.io','/product-finder/submit',false),'forum');});

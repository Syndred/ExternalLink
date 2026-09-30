import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function setup(host='10015.io',buttons=['Chat','Data Analysis']) {
  const root={parentElement:{parentElement:{querySelectorAll:()=>buttons.map(innerText=>({innerText}))}},querySelector:()=>null};
  const field={id:'tag',tagName:'INPUT',value:'uncommitted search',type:'text',getAttribute:key=>key==='role'?'combobox':null,closest:()=>root};
  const c=vm.createContext({location:{hostname:host,pathname:'/product-finder/submit'},isVisible:()=>true,isContentEditableField:()=>false,compactText:x=>String(x||'').trim()});
  const helper=source.indexOf('  function getExternalSelectedTags(');
  vm.runInContext(source.slice(helper>=0?helper:source.indexOf('  function getElementFillValue('),source.indexOf('  function collectFilledFieldsReport(')),c);
  vm.runInContext(source.slice(source.indexOf('  function isCustomDropdownEmpty('),source.indexOf('  function countEmptyFillableFields(')),c);
  return {c,field};
}
test('10015 external chips supply actual tag values and satisfy picker requiredness',()=>{const{c,field}=setup();assert.equal(c.getElementFillValue(field),'Chat, Data Analysis');assert.equal(c.isCustomDropdownEmpty(field),false);});
test('Search text with no committed chips stays empty',()=>{const{c,field}=setup('10015.io',[]);assert.equal(c.getElementFillValue(field),'');assert.equal(c.isCustomDropdownEmpty(field),true);});
test('Unrelated sites never inherit the 10015 tag wrapper rule',()=>{const{c,field}=setup('other.test');assert.equal(c.getElementFillValue(field),'uncommitted search');assert.equal(c.isCustomDropdownEmpty(field),true);});

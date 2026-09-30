import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function constraints(shared=false,text=null,label=null) {
 const field={maxLength:-1,minLength:-1,required:true,getAttribute:()=>null};
 const sibling={};const local={textContent:text||(shared?'Max. 1500 Characters':'862 / 1500'),querySelectorAll:()=>[field]};
 const broad={textContent:'Tagline 58/60 Characters Description Max. 1500 Characters',querySelectorAll:()=>[sibling,field]};
 field.parentElement=local;local.parentElement=broad;
 const c=vm.createContext({document:{getElementById:()=>null},getSnapshotLabel:()=>label||(shared?'Description Max. 1500 Characters':'Description'),getFieldHint:()=>''});
 vm.runInContext(source.slice(source.indexOf('  function findCharCounter('),source.indexOf('  function fitValueToConstraints(')),c);
 return c.getFieldConstraints(field);
}
test('A neighboring tagline counter cannot truncate a description with its own 1500 character limit',()=>assert.equal(constraints(true).maxLength,1500));
test('An owned inline counter still supplies its field limit',()=>assert.equal(constraints().maxLength,1500));
test('Thousands separators in description, instruction and FAQ counters never become a one-character limit',()=>{for(const max of [1500,1200])assert.equal(constraints(false,'1 / '+max.toLocaleString('en-US')).maxLength,max);});
test('An explicit character range with a thousands separator supplies both bounds',()=>{const result=constraints(false,'862 / 1,500','Full Description 50–1,500 characters');assert.equal(result.maxLength,1500);assert.equal(result.minLength,50);});

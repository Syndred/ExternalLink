import test from 'node:test';import assert from 'node:assert/strict';
import {selectVerifiedOption} from '../executor/src/react-picker.mjs';
function fixture(options,selected='',legacy=false) {
  const events=[];let current=selected,search='';
  const input={count:async()=>1,focus:async()=>events.push('focus'),press:async key=>events.push(key),fill:async value=>{search=value;events.push('fill');},evaluate:async()=>current};
  const group=(name,values=options)=>({first:()=>({waitFor:async()=>{}}),allTextContents:async()=>values,count:async()=>name?values.filter(x=>x===name).length:values.length,filter:({hasText})=>group(options.find(x=>hasText.test(x))),click:async()=>{current=name;search='';events.push('select:'+name);}});
  const frame={locator:s=>{events.push('locator:'+s);return s.startsWith('#')?input:group();},getByRole:(_,{name}={})=>group(name,legacy?[]:options)};
  return {frame,events,getSearch:()=>search};
}
test('React picker selects only an available exact option and confirms the committed value',async()=>{
  const f=fixture(['Free','Freemium']);assert.equal(await selectVerifiedOption(f.frame,'#pricing',['Free']),'Free');
  assert.ok(f.events.includes('select:Free'));assert.equal(f.getSearch(),'');
});
test('Missing truthful option stops without choosing a fuzzy or first item',async()=>{
  const f=fixture(['Games','Developer Tools']);await assert.rejects(selectVerifiedOption(f.frame,'#category',['Artificial Intelligence','Productivity']),/可用选项/);
  assert.ok(!f.events.some(x=>x.startsWith('select:')));
});
test('Already committed exact selection is kept',async()=>{
  const f=fixture(['Free'],'Free');assert.equal(await selectVerifiedOption(f.frame,'#pricing',['Free']),'Free');assert.deepEqual(f.events,['locator:#pricing']);
});
test('Legacy React Select with option IDs and no ARIA roles still commits the exact choice',async()=>{
  const f=fixture(['Free','Freemium'],'',true);assert.equal(await selectVerifiedOption(f.frame,'#pricing',['Free']),'Free');
});
test('Committed chips outside the select container are read through the observed section',async()=>{
  const f=fixture([]);assert.equal(await selectVerifiedOption(f.frame,'#tag',['Data Analysis'],()=>Promise.resolve('Chat, Data Analysis')),'Data Analysis');assert.deepEqual(f.events,['locator:#tag']);
});
test('Default React input IDs route to their own option prefix',async()=>{
  const f=fixture(['Productivity'],'',true);await selectVerifiedOption(f.frame,'#react-select-2-input',['Productivity']);
  assert.ok(f.events.includes('locator:[id^="react-select-2-option-"]:visible'));
});
test('Native pricing options elsewhere cannot hide the category picker options',async()=>{
 const f=fixture(['Productivity']);f.frame.getByRole=()=>({count:async()=>4,allTextContents:async()=>['Select Pricing Type','Free','Freemium','Paid'],first:()=>({waitFor:async()=>{}})});
 assert.equal(await selectVerifiedOption(f.frame,'#react-select-2-input',['Productivity']),'Productivity');
});

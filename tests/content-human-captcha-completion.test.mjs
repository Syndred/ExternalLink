import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import{readFileSync}from'node:fs';
const source=readFileSync(new URL('../extension/content.js',import.meta.url),'utf8');
function completed(host,token) {
 const c=vm.createContext({location:{hostname:host,pathname:'/submit-a-tool'},document:{querySelectorAll:()=>[{value:token}]}});
 const start=source.indexOf('  function hasCompletedAiOfDayCaptcha(');if(start<0)return false;
 vm.runInContext(source.slice(start,source.indexOf('  function detectCaptcha(',start)),c);return c.hasCompletedAiOfDayCaptcha();
}
test('Only an actual response already supplied by the human on AIoftheday resolves this gate',()=>{assert.equal(completed('aioftheday.com','human-generated-response'),true);assert.equal(completed('aioftheday.com',''),false);assert.equal(completed('other.test','response'),false);});

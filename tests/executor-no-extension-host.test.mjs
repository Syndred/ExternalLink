import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
test('normal browser host preserves the stable dedicated profile and cannot load an extension or protected setup page',async()=>{
 const native=await readFile(new URL('../executor/src/native-browser-host.mjs',import.meta.url),'utf8');
 const entry=await readFile(new URL('../executor/src/browser-host.mjs',import.meta.url),'utf8');
 assert.match(native,/--disable-extensions/);assert.match(native,/browser-profile-stable/);
 for(const source of [native,entry])assert.doesNotMatch(source,/--load-extension|--disable-extensions-except|chrome:\/\/extensions|chrome-extension:\/\//);
});

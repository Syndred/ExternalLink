import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import {attachEngine} from '../executor/src/engine.mjs';

test('form core refuses protected pages before creating any browser control session',async()=>{
  for(const url of ['chrome://extensions','chrome-extension://abcdefghijklmnop/panel.html','file:///private.html','devtools://devtools']) {
    await assert.rejects(attachEngine({newCDPSession(){throw Error('must not create a session');}},{url:()=>url}),/普通 HTTP/);
  }
});

test('executor business and form core load without extension sources or Chrome extension API', async () => {
  const root=fileURLToPath(new URL('../',import.meta.url));
  for(const name of ['shared.mjs','engine.mjs','workbench-sync.mjs','runtime.mjs']) {
    const source=await readFile(join(root,'executor/src',name),'utf8');
    assert.doesNotMatch(source, /(?:['"`]extension(?:\/|['"`])|\.\.\/\.\.\/extension\/|chrome\.(?:runtime|storage))/);
  }
  for(const name of ['d1-executor.mjs','d1-api.mjs','executor-api.mjs']){
    assert.doesNotMatch(await readFile(join(root,'cloud/worker/src',name),'utf8'),/import.*extension\//);
  }
  const core=join(root,'core');
  for(const name of await readdir(core))if(name.endsWith('.js')) {
    const source=await readFile(join(core,name),'utf8');
    assert.doesNotMatch(source,/chrome\.(?:runtime|storage)/,name+' must use explicit host services');
  }
  const probe=spawnSync(process.execPath,['--input-type=module','-e',
    'import {queue,profiles,inventory} from "./executor/src/shared.mjs"; console.log(JSON.stringify({host:queue.extractDomain("https://www.example.com/submit"),configured:profiles.profileConfigured({name:"Product"}),count:inventory({documents:{}},null).total}));'],{cwd:root,encoding:'utf8'});
  assert.equal(probe.status,0,probe.stderr);
  const result=JSON.parse(probe.stdout.trim());
  assert.equal(result.host,'example.com');
  assert.equal(result.configured,true);
  assert.equal(result.count,0);
});

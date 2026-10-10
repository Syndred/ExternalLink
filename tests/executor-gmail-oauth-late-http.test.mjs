import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

for(const scenario of ['authorized','cancelled','expired'])test('Gmail OAuth closed callback safely rejects real reused HTTP requests: '+scenario,{timeout:15000},()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./helpers/gmail-oauth-late-http.mjs',import.meta.url)),scenario],{encoding:'utf8',timeout:10000});
 assert.equal(result.error,undefined,result.error?.message);assert.equal(result.status,0,result.stderr||result.stdout);
 const evidence=JSON.parse(result.stdout.trim());assert.equal(evidence.ok,true);assert.equal(evidence.realHttpKeepAliveReused,true);assert.equal(evidence.listenerClosed,true);assert.equal(evidence.lateRequestsRejected,true);
});

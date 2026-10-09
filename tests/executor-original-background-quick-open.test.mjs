import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

test('native Chrome preserves original background opening and active-page auto-fill including cancellation and recovery',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../executor/test/original-background-quick-open.mjs',import.meta.url))],{encoding:'utf8',timeout:45000,maxBuffer:4*1024*1024,windowsHide:true});
 assert.equal(result.status,0,result.stdout+'\n'+result.stderr+'\n'+(result.error?.message||''));
 const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(proof.ok,true);assert.equal(proof.results.length,5);assert.equal(proof.posts,0);assert.equal(proof.registrations,3);
});

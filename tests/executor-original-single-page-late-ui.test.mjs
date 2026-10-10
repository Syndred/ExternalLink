import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('single-page UI fences delayed old mode replies and preserves the pending fill lock',{timeout:30000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-single-page-late-ui.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:25000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['ok','actualProductUi','lateModeReplyIgnored','lateProductReplyIgnored','closedPanelReplyIgnored','noConcurrentFillAfterSelectionChange','staleBusyTimedOutNotShownAsSuccess','buttonRestoredAfterEveryResult'])assert.equal(proof[key],true,key);assert.equal(proof.productionWrites,0);assert.equal(proof.posts,0);
});

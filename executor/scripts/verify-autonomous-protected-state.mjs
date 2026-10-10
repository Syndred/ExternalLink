import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.mjs';
const output=new URL('../../docs/evidence/no-extension-2026-09-30/autonomous-closure-2026-10-10/',import.meta.url),baseline=new URL('native-comment-baseline.json',output),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const store=new Store(join(homedir(),'.externallink-executor','outbox.sqlite'),{readOnly:true});
try{
 assert.equal(store.get('paused'),true);assert.equal(store.pendingCount(),0);const fixed=store.get('acceptanceBatch');assert.equal(fixed.cursor,13);assert.equal(fixed.count,30);assert.equal(fixed.status,'paused');
 const commentRows=store.db.prepare("SELECT id,value FROM state WHERE id LIKE 'comment%' OR id LIKE 'originalComment%' ORDER BY id").all(),state={kind:'readonly_exact_native_comment_rows',rowCount:commentRows.length,rawRowsSha256:hash(JSON.stringify(commentRows)),fixedBatch:{status:fixed.status,cursor:fixed.cursor,count:fixed.count},paused:true,pendingEvents:0};
 if(process.argv.includes('--baseline'))await writeFile(baseline,JSON.stringify(state,null,2)+'\n');else assert.deepEqual(state,JSON.parse(await readFile(baseline,'utf8')));
 console.log(JSON.stringify({...state,exactNativeCommentRowsUnchanged:!process.argv.includes('--baseline')}));
}finally{store.close();}
if(!process.argv.includes('--baseline')){
 assert.equal(process.argv.includes('--capture-transition'),false,'Original protection reference must stay read-only');
 const reference=new URL('../../docs/evidence/no-extension-2026-09-30/original-product-hunt-control-flow-2026-10-09/original-product-hunt-monitor-transition-2026-10-09.mjs.txt',import.meta.url);
 const source=(await readFile(reference,'utf8')).replace(/from\s*(['"])(\.\.?\/[^'"]+)\1/g,(_match,_quote,path)=>'from '+JSON.stringify(new URL(path,new URL('../test/',import.meta.url)).href));
 await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
}

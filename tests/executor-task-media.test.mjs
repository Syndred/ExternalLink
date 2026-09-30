import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {materializeTaskMedia} from '../executor/src/task-media.mjs';
test('frozen task media survives offline operation and rejects a changed local backup',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-media-')),file=join(home,'logo.asset'),bytes=Buffer.from('verified media fixture');await writeFile(file,bytes);
 const asset={productId:'P',kind:'logo',ref:'https://product.example/logo.png',file,mime:'image/png',ok:true,sha256:createHash('sha256').update(bytes).digest('hex')};
 const task={id:'t',profileId:'P',acceptanceId:'fixed'};const runtime={home,store:{get:()=>({combinations:[{profileId:'P',mediaManifest:[asset]}]})},update(t,p){Object.assign(t,p);}};
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('offline');};
 try{assert.match(await materializeTaskMedia(runtime,task,{logoUrl:asset.ref},'logo'),/\.png$/);assert.equal(task.usedMedia[0].sha256,asset.sha256);
  await writeFile(file,'changed');await assert.rejects(materializeTaskMedia(runtime,task,{logoUrl:asset.ref},'logo'),/校验/);
 }finally{globalThis.fetch=oldFetch;await rm(home,{recursive:true,force:true});}
});

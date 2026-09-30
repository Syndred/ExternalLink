import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import{Runtime}from'../executor/src/runtime.mjs';import{Store}from'../executor/src/store.mjs';
test('a failed cloud synchronization backs off instead of repeatedly querying a quota-limited backend',()=>{
 const runtime={syncRetryAt:Date.now()+30000,store:{get(){throw Error('must not access backend or state during backoff');}},restoreCloud(){throw Error('must not retry');}};
 assert.doesNotThrow(()=>Runtime.prototype.tick.call(runtime));
});
test('D1 startup with a complete local checkpoint reads the lightweight index only',async()=>{
 const store=new Store(':memory:');try{store.set('pair',{});store.set('run:r',{id:'r'});store.set('task:t',{id:'t',status:'finished'});const calls=[];
 const runtime={store,cloud:{config:{storageBackend:'d1'},request:async route=>{calls.push(route);return{runs:[{id:'r'}],tasks:[{id:'t'}]};}}};
 await Runtime.prototype.restoreCloud.call(runtime);assert.deepEqual(calls,['runs?view=inventory']);assert.equal(runtime.hydrated,true);
 }finally{store.close();}
});
test('background synchronization bounds image uploads and continues remaining evidence next cycle',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'el-sync-')),store=new Store(':memory:');
 try{
  const bytes=Buffer.from('test evidence'),file=join(dir,'evidence.png');await writeFile(file,bytes);const sha256=createHash('sha256').update(bytes).digest('hex');
  for(let i=0;i<7;i++)store.set('task:'+i,{id:String(i),version:1,screenshot:file});let uploads=0;
  const runtime={store,status:()=>({ok:true}),update:(task,patch,type)=>{Object.assign(task,patch);store.transition(task,type);},cloud:{flush:async s=>{for(const e of s.pending())s.ack(e.id);},request:async(route,input)=>{if(route==='artifact'){uploads++;return{ref:'cloud-artifact://'+input.taskId,sha256};}if(route==='artifact-read')return{dataUrl:'data:image/png;base64,'+bytes.toString('base64')};throw Error('Unexpected request');}}};
  await Runtime.prototype.synchronize.call(runtime);assert.equal(uploads,4);assert.equal(store.values('task:').filter(t=>t.artifactRef).length,4);
  await Runtime.prototype.synchronize.call(runtime);assert.equal(uploads,7);assert.equal(store.pendingCount(),0);
  await Runtime.prototype.synchronize.call(runtime);assert.equal(uploads,7);
 }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

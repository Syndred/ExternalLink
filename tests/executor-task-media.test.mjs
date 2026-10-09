import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';import {materializeTaskMedia} from '../executor/src/task-media.mjs';
test('frozen task media survives offline operation and rejects a changed local backup',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-media-')),file=join(home,'logo.asset'),bytes=Buffer.from('verified media fixture');await writeFile(file,bytes);
 const asset={productId:'P',kind:'logo',ref:'https://product.example/logo.png',file,mime:'image/png',ok:true,sha256:createHash('sha256').update(bytes).digest('hex')};
 const task={id:'t',profileId:'P',acceptanceId:'fixed'};const runtime={home,store:{get:()=>({combinations:[{profileId:'P',mediaManifest:[asset]}]})},update(t,p){Object.assign(t,p);}};
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>{throw Error('offline');};
 try{assert.match(await materializeTaskMedia(runtime,task,{logoUrl:asset.ref},'logo'),/\.png$/);assert.equal(task.usedMedia[0].sha256,asset.sha256);
  await writeFile(file,'changed');await assert.rejects(materializeTaskMedia(runtime,task,{logoUrl:asset.ref},'logo'),/校验/);
 }finally{globalThis.fetch=oldFetch;await rm(home,{recursive:true,force:true});}
});
test('original fifth and sixth screenshots materialize with frozen identity and checksum enforcement',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-legacy-screens-')),task={id:'t',runId:'r',profileId:'p'},screenshots=Array.from({length:6},(_,i)=>'cloud-media://screen-'+(i+1)),bytes=Buffer.from('frozen original screenshot'),sha256=createHash('sha256').update(bytes).digest('hex');let returned=bytes,requests=0;
 const runtime={home,store:{get:key=>key==='run:r'?{profileId:'p',tasks:['t'],profile:{id:'p',media:{screenshots}},mediaManifest:screenshots.map(ref=>({asset_id:ref.slice(14),sha256}))}:null},bridge:async()=>{requests++;return{dataUrl:'data:image/png;base64,'+returned.toString('base64')};},update(t,p){Object.assign(t,p);}};
 try{
  for(const kind of ['screenshot5','screenshot6']){const file=await materializeTaskMedia(runtime,task,{screenshots},kind);assert.deepEqual(await readFile(file),bytes);assert.equal(task.usedMedia.find(item=>item.kind===kind).sha256,sha256);}
  assert.equal(requests,2);const used=structuredClone(task.usedMedia);
  returned=Buffer.from('changed original screenshot');await assert.rejects(materializeTaskMedia(runtime,task,{screenshots},'screenshot6'),/校验/);
  const replacement=[...screenshots];replacement[5]='cloud-media://other-profile';await assert.rejects(materializeTaskMedia(runtime,task,{screenshots:replacement},'screenshot6'),/选定/);
  await assert.rejects(materializeTaskMedia(runtime,task,{screenshots},'screenshot7'),/缺少/);
  for(const kind of ['screenshot0','screenshot9007199254740992'])await assert.rejects(materializeTaskMedia(runtime,task,{screenshots},kind),/类别无效/);
  assert.equal(requests,3);assert.deepEqual(task.usedMedia,used);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('native cloud attachment independently rejects changed bytes and assets outside the original task manifest',async()=>{
 const home=await mkdtemp(join(tmpdir(),'el-media-integrity-')),bytes=Buffer.from('original frozen image'),asset={asset_id:'selected',sha256:createHash('sha256').update(bytes).digest('hex')},task={id:'t',runId:'r',profileId:'p'};let returned=bytes,requests=0;
 const runtime={home,store:{get:key=>key==='run:r'?{profileId:'p',tasks:[task.id],profile:{id:'p',fields:{'Cloud LOGO':'cloud-media://selected'}},mediaManifest:[asset]}:null},bridge:async()=>{requests++;return{dataUrl:'data:image/png;base64,'+returned.toString('base64')};},update(t,p){Object.assign(t,p);}};
 try{await materializeTaskMedia(runtime,task,{logoUrl:'cloud-media://selected'},'logo');assert.equal(task.usedMedia[0].sha256,asset.sha256);const original=structuredClone(task.usedMedia);returned=Buffer.from('corrupted frozen image');await assert.rejects(materializeTaskMedia(runtime,task,{logoUrl:'cloud-media://selected'},'logo'),/校验/);assert.deepEqual(task.usedMedia,original);await assert.rejects(materializeTaskMedia(runtime,task,{logoUrl:'cloud-media://unselected-history'},'logo'),/冻结清单|选定/);assert.equal(requests,2);}finally{await rm(home,{recursive:true,force:true});}
});

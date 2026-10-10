import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
import {assistantMedia} from '../executor/src/assistant-media.mjs';
test('actual manual image icon uploads cross-origin media without registering a task and rejects a delayed old product',{timeout:30000},()=>{
 const result=spawnSync(process.execPath,['executor/test/original-manual-image-source.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:25000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const proof=JSON.parse(result.stdout.trim().split('\n').at(-1));for(const key of ['unregisteredPageCrossOriginImageUploaded','unregisteredPageCloudImageUploaded','iframeRemoteAndCloudImagesUploaded','controlledCloudAuthChecked','productSwitchDuringReadRejected'])assert.equal(proof[key],true,key);assert.equal(proof.newTasks,0);assert.equal(proof.posts,0);
});
test('field-only media refuses unselected disabled foreign changed and invalid media before returning bytes',async()=>{
 const png=Buffer.from([137,80,78,71]),digest='0'.repeat(64);let reads=0,mime='image/png';const server=http.createServer((req,res)=>{reads++;res.setHeader('Content-Type',mime);res.end(png);});await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 const config={projectKey:'p',logoUrl:origin+'/logo',mediaDisabled:{}},pair={endpoint:origin,workspaceId:'fixture',storageBackend:'d1',deviceToken:'fixture'},runtime={store:{get:()=>pair},cloud:{request:async()=>({assets:[{asset_id:'logo',profile_id:'other',sha256:digest}]})}},check=async()=>{};
 try{
  await assert.rejects(assistantMedia(runtime,{action:'fetchSubmissionMedia',url:origin+'/unselected'},config,check),/不属于/);assert.equal(reads,0);
  await assert.rejects(assistantMedia(runtime,{action:'fetchSubmissionMedia',url:config.logoUrl},{...config,mediaDisabled:{logo:true}},check),/不属于/);assert.equal(reads,0);
  const cloudConfig={...config,logoUrl:'cloud-media://logo'};await assert.rejects(assistantMedia(runtime,{action:'fetchCloudSubmissionMedia',ref:cloudConfig.logoUrl},cloudConfig,check),/不属于/);assert.equal(reads,0);
  runtime.cloud.request=async()=>({assets:[{asset_id:'logo',profile_id:'p',sha256:digest}]});await assert.rejects(assistantMedia(runtime,{action:'fetchCloudSubmissionMedia',ref:cloudConfig.logoUrl},cloudConfig,check),/字节已变化/);assert.equal(reads,1);
  mime='text/html';await assert.rejects(assistantMedia(runtime,{action:'fetchSubmissionMedia',url:config.logoUrl},config,check),/不是支持的图片/);assert.equal(reads,2);
  mime='image/png';let checks=0;await assert.rejects(assistantMedia(runtime,{action:'fetchSubmissionMedia',url:config.logoUrl},config,async()=>{checks++;if(checks===3)throw Error('Changed selected product');}),/Changed selected product/);assert.equal(reads,3);
 }finally{await new Promise(done=>server.close(done));}
});

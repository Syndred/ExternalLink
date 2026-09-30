import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';import {join,resolve,dirname} from 'node:path';import {tmpdir} from 'node:os';
const listen=server=>new Promise(r=>server.listen(0,'127.0.0.1',r));
async function freePort(){const server=http.createServer();await listen(server);const port=server.address().port;await new Promise(r=>server.close(r));return port;}
test('standalone first-install HTTP setup issues a protected session without exposing device credentials',async()=>{
 const home=resolve(await mkdtemp(join(tmpdir(),'externallink-setup-http-'))),cloud=http.createServer((req,res)=>{assert.equal(req.headers.authorization,'Bearer eld_test');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,deviceId:'device',workspaceId:'test',documents:{siteProfiles:{},submissionRecords:{},siteAnnotations:{}},revisions:{siteProfiles:1}}));});await listen(cloud);
 const port=await freePort(),webPort=await freePort(),env={...process.env,EXTERNALLINK_HOME:home,EXTERNALLINK_PORT:String(port),EXTERNALLINK_WEB_PORT:String(webPort)},children=[];
 try{
  const root=resolve('executor/src'),start=file=>{const child=spawn(process.execPath,[join(root,file)],{env,stdio:'ignore',windowsHide:true});children.push(child);return child;};
  start('server.mjs');let ready=false;for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:'+port+'/setupInfo',{headers:{Origin:'http://127.0.0.1:'+webPort}})).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert.equal(ready,true);
  start('workbench-server.mjs');const base='http://127.0.0.1:'+webPort;let response;for(let i=0;i<50;i++){try{response=await fetch(base+'/connection');break;}catch{}await new Promise(r=>setTimeout(r,100));}const info=await response.json();assert.equal(info.setupRequired,true);assert.equal(info.deviceToken,undefined);
  const enrollment={endpoint:'http://127.0.0.1:'+cloud.address().port,workspaceId:'test',deviceId:'device',deviceToken:'eld_test',storageBackend:'d1'},post=body=>fetch(base+'/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post({nonce:'wrong',enrollment})).status,400);assert.equal((await fetch(base+'/connection',{headers:{Origin:'https://outside.test'}})).status,403);
  response=await post({nonce:info.nonce,enrollment});assert.equal(response.status,200);const body=await response.json();assert.equal(body.localToken,undefined);assert.equal(body.deviceToken,undefined);const cookie=response.headers.get('Set-Cookie');assert.match(cookie,/HttpOnly; SameSite=Strict/);
  const paired=await(await fetch(base+'/connection',{headers:{Cookie:cookie.split(';')[0]}})).json();assert.equal(paired.workspaceId,'test');assert.equal((await fetch(base+'/connection')).status,401);
 }finally{for(const child of children){child.kill();await new Promise(r=>{if(child.exitCode!==null)return r();child.once('exit',r);});}await new Promise(r=>cloud.close(r));assert.equal(dirname(home),resolve(tmpdir()));await rm(home,{recursive:true,force:true});}
});

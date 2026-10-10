import assert from 'node:assert/strict';
import http from 'node:http';
import {mock} from 'node:test';
import {beginGmailOAuth,GMAIL_READONLY} from '../../executor/src/gmail-oauth.mjs';

const scenario=process.argv[2];
assert.ok(['authorized','cancelled','expired'].includes(scenario));
if(scenario==='expired')mock.timers.enable({apis:['setTimeout']});
const agent=new http.Agent({keepAlive:true,maxSockets:1});
const originalCreateServer=http.createServer;
let callbackServer,flow,tokenRequests=0,writes=0;
const statuses=[];
http.createServer=function(...args){
 callbackServer=originalCreateServer.apply(this,args);
 // Keep one real accepted socket alive during close, reproducing the browser's
 // queued keep-alive request after the listener and server.address() disappear.
 callbackServer.closeIdleConnections=()=>{};
 return callbackServer;
};
try{
 flow=await beginGmailOAuth({client:{client_id:'late-http.apps.googleusercontent.com'},vault:{async write(name,value){assert.equal(name,'gmail-tokens');assert.equal(value.refresh_token,'fixture-refresh');writes++;}},onStatus:status=>statuses.push(status.status),fetcher:async(url,options)=>{tokenRequests++;assert.equal(url,'https://oauth2.googleapis.com/token');const body=new URLSearchParams(options.body);assert.equal(body.get('grant_type'),'authorization_code');assert.ok(body.get('code_verifier'));return Response.json({access_token:'fixture-access',refresh_token:'fixture-refresh',scope:GMAIL_READONLY,expires_in:3600});}});
 http.createServer=originalCreateServer;
 const authorization=new URL(flow.authorizationUrl),callback=new URL(authorization.searchParams.get('redirect_uri'));
 const request=(path,host=callback.host)=>new Promise((resolve,reject)=>{
  const req=http.request({hostname:callback.hostname,port:callback.port,path,headers:{Host:host},agent},res=>{let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body,reusedSocket:req.reusedSocket}));});
  req.on('error',reject);req.end();
 });
 const valid='/?'+new URLSearchParams({state:authorization.searchParams.get('state'),code:'fixture-code'});
 if(scenario==='authorized'){
  assert.equal((await request('/?state=forged&code=fixture-code')).status,400);
  assert.equal((await request(valid,'foreign.example:'+callback.port)).status,400);
  const accepted=await request(valid);assert.equal(accepted.status,200);assert.doesNotMatch(accepted.body,/fixture-(?:access|refresh)/);
  assert.equal(callbackServer.address(),null);
  const favicon=await request('/favicon.ico');assert.equal(favicon.reusedSocket,true);assert.equal(favicon.status,400);
  const replay=await request(valid);assert.equal(replay.reusedSocket,true);assert.equal(replay.status,400);
  assert.equal(tokenRequests,1);assert.equal(writes,1);assert.deepEqual(statuses,['connected']);
 }else{
  assert.equal((await request('/?state=forged&code=fixture-code')).status,400);
  if(scenario==='cancelled')flow.cancel();else{mock.timers.tick(599999);assert.ok(callbackServer.address());assert.deepEqual(statuses,[]);mock.timers.tick(1);}
  assert.equal(callbackServer.address(),null);
  const late=await request(valid);assert.equal(late.reusedSocket,true);assert.equal(late.status,400);
  assert.equal(tokenRequests,0);assert.equal(writes,0);assert.deepEqual(statuses,scenario==='expired'?['needs_authorization']:[]);
 }
 console.log(JSON.stringify({ok:true,scenario,realHttpKeepAliveReused:true,listenerClosed:true,lateRequestsRejected:true,tokenRequests,writes}));
}finally{
 http.createServer=originalCreateServer;flow?.cancel();agent.destroy();callbackServer?.closeAllConnections();
 if(scenario==='expired')mock.timers.reset();
}

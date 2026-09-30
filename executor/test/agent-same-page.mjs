import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright';
import { AgentBrowserAdapter } from '../src/agent-browser-adapter.mjs';
import { runPreparationTakeover } from '../src/auto-takeover.mjs';
import { Store } from '../src/store.mjs';

const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>AI same-page regression</title><label>Product Name<input id="name"></label><button id="next" onclick="document.getElementById(\'stage\').textContent=\'Ready\'">Next</button><p id="stage">Waiting</p>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const portServer=http.createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions',`--remote-debugging-port=${port}`]});
const store=new Store(':memory:');
try{
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
  const session=await page.context().newCDPSession(page);const {targetInfo}=await session.send('Target.getTargetInfo');await session.detach();
  const task={id:'same-page',version:1,status:'filling',controller:'executor',url:page.url(),targetId:targetInfo.targetId};
  const adapter=new AgentBrowserAdapter({endpoint:`http://127.0.0.1:${port}`,targetId:task.targetId,taskId:task.id,browserInstance:'regression-'+Date.now()});
  await adapter.bind();const observed=await adapter.snapshot();assert.ok(observed);
  const runtime={store,lease:async()=>{},update(t,patch,type){Object.assign(t,patch);store.transition(t,type);}};
  let calls=0;
  const result=await runPreparationTakeover(runtime,{task,
    observe:async()=>({url:page.url(),domHash:await page.locator('#stage').innerText()+'|'+await page.locator('#name').inputValue(),fields:[{selector:'#name',type:'text',visible:true}],buttons:[{selector:'#next',text:'Next',visible:true}]}),
    ready:async()=>await page.locator('#stage').innerText()==='Ready',
    plan:async()=>({status:'act',actions:++calls===1?[{type:'fill',selector:'#name',value:'Real product fixture'}]:[{type:'click',selector:'#next'}]}),
    act:action=>adapter.act(action)});
  assert.equal(result.ok,true,JSON.stringify(result));assert.equal(await page.locator('#name').inputValue(),'Real product fixture');
  assert.equal(task.targetId,targetInfo.targetId);assert.equal(task.controller,'executor');assert.equal(page.context().pages().length,1);
  console.log(JSON.stringify({ok:true,kind:'synthetic_regression',sameTarget:true,newPages:0,extensionInstalled:false,actions:task.aiTakeover.actions,calls:task.aiTakeover.calls}));
}finally{store.close();await browser.close();await new Promise(r=>server.close(r));}

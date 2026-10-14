import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {chromium} from '../executor/node_modules/playwright/index.mjs';
import {attachEngine} from '../executor/src/engine.mjs';

test('real isolated CDP attaches same-process and OOP frames whose URLs contain fragments',async t=>{
 let posts=0,externalRequests=0;
 const server=createServer((request,response)=>{
  if(request.method!=='GET'){posts++;response.writeHead(405).end();return;}
  const port=server.address().port;
  response.setHeader('Content-Type','text/html');
  response.end(request.url.startsWith('/main')
   ?`<!doctype html><title>Local frame identity fixture</title><iframe name="same-process" src="/form?slot=one#stage-one"></iframe><iframe name="oop" src="http://localhost:${port}/form?slot=two#stage-two"></iframe>`
   :'<!doctype html><title>Submit local tool</title><form><label>Tool name<input name="toolName" value="Fixture Product"></label><label>Website<input type="url" name="website" value="https://product.invalid/"></label></form>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions','--site-per-process']});
 t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));});
 const context=await browser.newContext({serviceWorkers:'block'});
 await context.route('**/*',route=>{
  const host=new URL(route.request().url()).hostname;
  if(['127.0.0.1','localhost'].includes(host))return route.continue();
  externalRequests++;return route.abort();
 });
 const page=await context.newPage();
 await page.goto(`http://127.0.0.1:${server.address().port}/main#parent`,{waitUntil:'load'});
 const childFrames=page.frames().filter(frame=>frame!==page.mainFrame());
 assert.equal(childFrames.length,2);
 const cdp=await context.newCDPSession(page),tree=await cdp.send('Page.getFrameTree');await cdp.detach();
 assert.equal(tree.frameTree.frame.urlFragment,'#parent');
 for(const name of ['same-process','oop']){
  const frame=childFrames.find(child=>child.name()===name),url=new URL(frame.url());
  let node;
  if(name==='same-process'){
   node=tree.frameTree.childFrames.find(child=>child.frame.name===name);
   await assert.rejects(context.newCDPSession(frame),/part of the parent frame's session/);
  }
  else{
   const ownSession=await context.newCDPSession(frame);
   try{
    const ownTree=await ownSession.send('Page.getFrameTree'),info=(await ownSession.send('Target.getTargetInfo')).targetInfo;
    assert.equal(info.type,'iframe');assert.equal(ownTree.frameTree.frame.id,info.targetId);node=ownTree.frameTree;
   }finally{await ownSession.detach();}
  }
  assert.ok(node);
  assert.equal(node.frame.urlFragment,url.hash);
  assert.equal(node.frame.url,url.href.slice(0,url.href.indexOf('#')));
  const engine=await attachEngine(context,frame);
  try{const snapshot=await engine.call({action:'getPageSnapshot'});assert.equal(snapshot.url,node.frame.url);assert.ok(snapshot.fields.some(field=>field.name==='toolName'&&field.value.present));assert.equal(await engine.isCurrentDocument(),true);}
  finally{await engine.detach();}
 }
 const mainEngine=await attachEngine(context,page.mainFrame());
 try{assert.equal((await mainEngine.call({action:'getPageSnapshot'})).url,tree.frameTree.frame.url);}
 finally{await mainEngine.detach();}
 assert.equal(posts,0);assert.equal(externalRequests,0);
});

function fakeAttachment(frameUrl,nodes,{index=0,name='',oop=false}={}){
 const calls=[],root={frame:{id:oop?'oop-frame':'page-frame',url:oop?nodes[0].url:'https://directory.invalid/root',...(oop?{urlFragment:nodes[0].urlFragment}:{})},...(oop?{}:{childFrames:nodes.map((node,i)=>({frame:{id:'child-'+i,...node}}))})};
 const session={async send(method,params){calls.push({method,params});if(method==='Page.getFrameTree')return{frameTree:root};if(method==='Page.createIsolatedWorld')return{executionContextId:7};if(method==='Runtime.evaluate')return{result:{value:true}};return{};},on(){},async detach(){calls.push({method:'detach'});}};
 const parent={parentFrame:()=>null,childFrames:()=>index<0?[]:index===0?[frame]:[{},frame]};
 const frame={url:()=>frameUrl,name:()=>name,parentFrame:()=>parent,page:()=>({})};
 return{frame,context:{newCDPSession:async()=>session},calls};
}

for(const [label,url]of [
 ['protocol','http://form.invalid/entry?slot=one'],
 ['host','https://other.invalid/entry?slot=one'],
 ['path','https://form.invalid/other?slot=one'],
 ['query','https://form.invalid/entry?slot=two'],
])test(`fragment handling still rejects a changed frame ${label}`,async()=>{
 const fixture=fakeAttachment('https://form.invalid/entry?slot=one#stage',[{url,urlFragment:'#stage'}]);
 await assert.rejects(attachEngine(fixture.context,fixture.frame),/iframe 身份已变化/);
 assert.ok(!fixture.calls.some(call=>call.method==='Page.createIsolatedWorld'));
 assert.ok(fixture.calls.some(call=>call.method==='detach'));
});

test('fragment-only fallback remains rejected when multiple frame base URLs are ambiguous',async()=>{
 const base='https://form.invalid/entry?slot=one',fixture=fakeAttachment(base+'#expected',[{url:base,urlFragment:'#first'},{url:base,urlFragment:'#second'}],{index:-1});
 await assert.rejects(attachEngine(fixture.context,fixture.frame),/iframe 身份已变化/);
 assert.ok(!fixture.calls.some(call=>call.method==='Page.createIsolatedWorld'));
});

test('a validated ancestor position preserves the intended frame ID despite equal base URLs',async()=>{
 const base='https://form.invalid/entry?slot=one',fixture=fakeAttachment(base+'#second',[{url:base,urlFragment:'#first'},{url:base,urlFragment:'#second'}],{index:1});
 const engine=await attachEngine(fixture.context,fixture.frame);await engine.detach();
 assert.equal(fixture.calls.find(call=>call.method==='Page.createIsolatedWorld').params.frameId,'child-1');
});

test('fragment matching preserves an OOP frame rooted in its own CDP target',async()=>{
 const base='https://form.invalid/entry?slot=one',fixture=fakeAttachment(base+'#same-document',[{url:base,urlFragment:'#same-document'}],{oop:true,index:-1});
 const engine=await attachEngine(fixture.context,fixture.frame);await engine.detach();
 assert.equal(fixture.calls.find(call=>call.method==='Page.createIsolatedWorld').params.frameId,'oop-frame');
});

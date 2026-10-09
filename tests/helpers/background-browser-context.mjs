import assert from 'node:assert/strict';

// CDP-level double for queue/catalogue tests. Real focus and filling are
// exercised by original-background-quick-open.mjs with owned native Chrome.
export function backgroundContext(navigate){
 let sequence=0;const pages=[];
 const makePage=()=>{const page={targetId:'fixture-'+sequence++,isClosed:()=>false,async goto(url){await navigate(url);}};pages.push(page);return page;};makePage();
 const session={async send(method,input){assert.equal(method,'Target.createTarget');assert.equal(input.background,true);assert.equal(input.url,'about:blank');assert.equal(input.browserContextId,'owned-fixture-context');return{targetId:makePage().targetId};},async detach(){}};
 return{pages:()=>pages,browser:()=>({async newBrowserCDPSession(){return session;}}),async newCDPSession(page){return{async send(method){assert.equal(method,'Target.getTargetInfo');return{targetInfo:{targetId:page.targetId,browserContextId:'owned-fixture-context'}};},async detach(){}};}};
}

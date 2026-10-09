const staleTargetError=error=>/no object with guid|(?:target|session) closed|target.*not found|page has been closed/i.test(String(error?.message||error));

// A page may close after context.pages() was copied but before its CDP target
// can be addressed. Treat that one page as absent while still surfacing a
// genuinely disconnected context to the caller.
export async function getTargetInfo(context,page){
 if(page.isClosed())return null;
 let session;
 try{
  session=await context.newCDPSession(page);
  return (await session.send('Target.getTargetInfo')).targetInfo;
 }catch(error){
  if(page.isClosed()||staleTargetError(error))return null;
  throw error;
 }finally{await session?.detach().catch(()=>{});}
}

export function isStaleTargetError(error){return staleTargetError(error);}

// chrome.tabs.create({ active: false }) in the original quick-open action.
// Create a blank target first so Playwright can attach before navigation and
// keep request interception, page identity and navigation errors observable.
export async function createBackgroundPage(context){
 const browser=context.browser();
 if(!browser)throw Error('浏览器连接已断开');
 // An empty context has no current tab to preserve; establish its identity.
 const existing=context.pages()[0],seed=existing||await context.newPage(),info=await getTargetInfo(context,seed);
 if(!info)throw Error('浏览器页签已变化，请重新打开');
 const session=await browser.newBrowserCDPSession();
 try{
  const {targetId}=await session.send('Target.createTarget',{url:'about:blank',background:true,...(info.browserContextId?{browserContextId:info.browserContextId}:{})});
  for(let n=0;n<200;n++){
   for(const page of context.pages())if(page!==seed&&(await getTargetInfo(context,page))?.targetId===targetId){if(!existing)await seed.close();return{page,targetId};}
   await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw Object.assign(Error('后台页签已创建，暂未连接；请核对该页签后再操作'),{targetId});
 }finally{await session.detach().catch(()=>{});}
}

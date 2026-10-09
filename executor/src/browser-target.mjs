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

// Match chrome.tabs.create({url, active:false}): creation acknowledges the
// target, not completion of its network navigation. Chrome owns the loading
// page even when its renderer attaches later or the destination fails to load.
export async function createBackgroundTarget(context,url){
 const browser=context.browser();
 if(!browser)throw Error('浏览器连接已断开');
 const existing=context.pages()[0],seed=existing||await context.newPage(),info=await getTargetInfo(context,seed);
 if(!info)throw Error('浏览器页签已变化，请重新打开');
 const session=await browser.newBrowserCDPSession();
 try{
  const {targetId}=await session.send('Target.createTarget',{url,background:true,...(info.browserContextId?{browserContextId:info.browserContextId}:{})});
  if(!existing)await seed.close().catch(()=>{});
  return targetId;
 }finally{await session.detach().catch(()=>{});}
}

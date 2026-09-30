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

import{writeFile}from'node:fs/promises';
const bounded=(promise,ms,label)=>{
 let timer;return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label}超过${ms}ms，已跳过本地证据收尾`)),ms);})]).finally(()=>clearTimeout(timer));
};
export async function capturePageEvidence(context,page,options={}){
 const{timeoutMs=15000,...screenshotOptions}=options;
 return bounded((async()=>{
  if(/^https?:/.test(page.url())&&page.bringToFront)await page.bringToFront();
  try{return await page.screenshot({...screenshotOptions,timeout:10000});}catch(error){
   if(!/Timeout.*exceeded|Cannot take screenshot with 0 width/.test(error.message)||!/^https?:/.test(page.url()))throw error;
   const session=await context.newCDPSession(page);try{
    const frame=(await session.send('Page.getFrameTree')).frameTree.frame;if(frame.url!==page.url())throw new Error('截图目标身份不一致，保留页签');
    const result=await session.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false}),bytes=Buffer.from(result.data,'base64');
    if(screenshotOptions.path)await writeFile(screenshotOptions.path,bytes);return bytes;
   }finally{await session.detach();}
  }
 })(),timeoutMs,'页面截图');
}

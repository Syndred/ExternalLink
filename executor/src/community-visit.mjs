import path from 'node:path';import{readFile,writeFile}from'node:fs/promises';import{createHash}from'node:crypto';import{isDeepStrictEqual}from'node:util';
export async function recordCommunityVisit(runtime,task,page,index){
 const session=await runtime.context.newCDPSession(page),targetId=(await session.send('Target.getTargetInfo')).targetInfo.targetId;await session.detach();
 let visit=task.communityVisits?.find(v=>v.targetId===targetId&&v.index===index&&v.browserInstance===runtime.host.startedAt&&!v.closedAt);
 if(!visit){visit={at:new Date().toISOString(),index,targetId,browserInstance:runtime.host.startedAt,kind:'required_read_only_community_visit',profileRevision:task.profileRevision,disposition:'registered'};
 runtime.update(task,{communityVisits:[...(task.communityVisits||[]),visit]},'community_visit_registered');await runtime.cloud.flush(runtime.store);}
 await page.waitForLoadState('domcontentloaded',{timeout:15000}).catch(()=>{});const u=new URL(page.url());visit.url=u.origin+u.pathname;visit.title=await page.title();
 const file=path.join(runtime.home,task.id+'-'+Date.now()+'-community-'+index+'.png');await page.bringToFront();
 try{await page.screenshot({path:file,animations:'disabled',timeout:10000});}catch(error){
  if(!/waiting for fonts to load/.test(error.message))throw error;
  const capture=await runtime.context.newCDPSession(page);try{const frame=(await capture.send('Page.getFrameTree')).frameTree.frame;if(frame.url!==page.url())throw new Error('截图目标身份不一致，保留页签');const result=await capture.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await writeFile(file,Buffer.from(result.data,'base64'));}finally{await capture.detach();}
 }
 const bytes=await readFile(file),hash=createHash('sha256').update(bytes).digest('hex');
 const artifact=await runtime.cloud.request('artifact',{taskId:task.id,dataUrl:'data:image/png;base64,'+bytes.toString('base64')}),read=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:artifact.ref});
 if(artifact.sha256!==hash||createHash('sha256').update(Buffer.from(read.dataUrl.split(',')[1],'base64')).digest('hex')!==hash)throw new Error('社区查看证据回读不一致；保留页签');
 Object.assign(visit,{screenshot:file,artifactRef:artifact.ref,artifactSha256:hash});runtime.update(task,{communityVisits:task.communityVisits},'community_visit_observed');await runtime.cloud.flush(runtime.store);
 const remote=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);if(!isDeepStrictEqual(remote?.communityVisits,JSON.parse(JSON.stringify(task.communityVisits))))throw new Error('社区查看登记未回读；保留页签');
 await page.close();Object.assign(visit,{closedAt:new Date().toISOString(),disposition:'closed'});runtime.update(task,{communityVisits:task.communityVisits},'community_visit_closed');await runtime.cloud.flush(runtime.store);
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { attachEngine } from './engine.mjs';
import {capturePageEvidence} from './page-evidence.mjs';
const onWire = value => JSON.parse(JSON.stringify(value));
export function canObserveEmbeddedForm(task,input,url,host){
 const parent=task.observationHistory?.find(o=>o.targetId===input.parentTargetId&&!o.closedAt&&o.browserInstance===host&&o.artifactRef&&o.artifactSha256);
 return url.protocol==='https:'&&/(?:^|\.)(?:formaloo\.net|formaloo\.me|airtable\.com|tally\.so)$/.test(url.hostname)&&
  !!parent?.frames?.some(f=>f.iframeSources?.includes(url.href));
}

export async function closeObservation(runtime, task, input) {
  if(runtime.job || runtime.store.get('paused')!==true || runtime.store.pending().length) throw new Error('查询收尾需要暂停空闲且无待回读事件');
  const observation=task.observationHistory?.find(o=>o.targetId===input.expectedTargetId);
  if(!observation || observation.closedAt || !observation.artifactRef || observation.retainReason) throw new Error('查询页没有完整证据或仍需保留');
  await runtime.synchronize();
  const remote=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
  if(!isDeepStrictEqual(remote?.observationHistory,onWire(task.observationHistory))) throw new Error('查询证据未独立回读');
  const artifact=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:observation.artifactRef});
  if(createHash('sha256').update(Buffer.from(artifact.dataUrl.split(',')[1],'base64')).digest('hex')!==observation.artifactSha256) throw new Error('查询截图校验失败');
  await runtime.lease(task);
  const page=await runtime.findPage({targetId:observation.targetId,browserInstance:observation.browserInstance});
  await page.close();Object.assign(observation,{closedAt:new Date().toISOString(),disposition:'closed'});
  runtime.update(task,{observationHistory:task.observationHistory},'lookup_tab_closed');await runtime.synchronize();
  const after=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
  if(!isDeepStrictEqual(after?.observationHistory,onWire(task.observationHistory)))throw new Error('关闭事件待恢复');
  return runtime.status();
}

export async function observeTask(runtime, task, input) {
  if (runtime.job || runtime.store.get('paused') !== true || task.receipt) throw new Error('只读查询需要暂停空闲且排除已收件任务');
  const url = new URL(input.href || task.url);
  const original=new URL(task.url);
  if (!runtime.context) await runtime.connect();
  const embedded=canObserveEmbeddedForm(task,input,url,runtime.host.startedAt);
  if (!embedded&&(url.protocol!==original.protocol || url.port!==original.port || url.hostname.replace(/^www\./,'')!==original.hostname.replace(/^www\./,''))) throw new Error('只允许原站或已登记真实iframe来源的表单核验');
  if (!embedded&&url.href !== new URL(task.url).href && !(task.observationHistory || []).some(o => o.frames?.some(f =>
      f.links?.some(l => new URL(l.href, f.url).href === url.href)))) throw new Error('必须先从原站观察并保存入口链接');
  if(embedded){const parent=task.observationHistory.find(o=>o.targetId===input.parentTargetId),remote=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
   if(!isDeepStrictEqual(remote?.observationHistory,onWire(task.observationHistory)))throw new Error('iframe原页证据未独立回读');
   const artifact=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:parent.artifactRef});
   if(createHash('sha256').update(Buffer.from(artifact.dataUrl.split(',')[1],'base64')).digest('hex')!==parent.artifactSha256)throw new Error('iframe来源截图不一致');
  }
  await runtime.lease(task);
  const incomplete=(task.observationHistory || []).findLast(o=>o.url===url.href && !o.closedAt && !o.artifactRef && o.browserInstance===runtime.host.startedAt);
  const page = incomplete ? await runtime.findPage(incomplete) : await runtime.context.newPage();
  const session = await runtime.context.newCDPSession(page);
  const targetId = (await session.send('Target.getTargetInfo')).targetInfo.targetId; await session.detach();
  const observation = incomplete || { at:new Date().toISOString(), taskId:task.id, targetId, browserInstance:runtime.host.startedAt,
    url:url.href, kind:embedded?'read_only_linked_form_check':'read_only_site_check', parentTargetId:embedded?input.parentTargetId:undefined, profileRevision:task.profileRevision ?? runtime.store.get('run:'+task.runId)?.profileRevision, originalTargetId:task.targetId, frames:[] };
  if(!incomplete)runtime.update(task,{observationHistory:[...(task.observationHistory || []),observation]},'lookup_tab_registered');
  await runtime.synchronize();
  try { await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:45000}); }
  catch(error){observation.navigationError=error.message.slice(0,300);}
  await page.waitForTimeout(Math.min(15000,Math.max(2500,Number(input.settleMs)||2500)));
  for(const frame of page.frames()) {
    let engine;
    try {
      const observed=await frame.evaluate(()=>({url:location.origin+location.pathname,text:document.body?.innerText?.slice(0,16000),
        iframeSources:[...document.querySelectorAll('iframe[src]')].map(e=>{try{return new URL(e.getAttribute('src'),location.href).href}catch{return''}}).filter(u=>u.startsWith('https://')),
        controls:[...document.querySelectorAll('input,textarea,select,button,[contenteditable=true],[role=combobox],[role=option]')]
          .filter(e=>e.getBoundingClientRect().width>0 && !['password','hidden'].includes(e.type))
          .map(e=>({tag:e.tagName,type:e.type,id:e.id,name:e.name,role:e.getAttribute('role'),placeholder:e.getAttribute('placeholder'),
            label:e.labels?.[0]?.textContent?.trim()||e.getAttribute('aria-label')||'',value:e.value,
            text:e.tagName==='BUTTON'||e.getAttribute('role')?e.textContent?.trim().slice(0,250):'',
            options:e.tagName==='SELECT'?[...e.options].map(o=>({value:o.value,label:o.text})):undefined})),
        links:[...document.querySelectorAll('a[href]')].filter(e=>e.getBoundingClientRect().width>0 &&
          /submi(?:t|ssion)|add|login|sign|cookie|privacy|terms|free|account|dashboard|profile|suggest|jevplay|jev-ai-games/i.test(e.textContent+' '+e.getAttribute('href')))
          .map(e=>({text:e.textContent.trim().slice(0,100),href:new URL(e.getAttribute('href'),location.href).href.split('?')[0]})).slice(0,80)}));
      if (!/chatbase|stripe|accounts\.google/.test(observed.url)) {
        engine=await attachEngine(runtime.context,frame); observed.detection=await engine.call({action:'detectPage'});
      }
      observation.frames.push(observed);
    }catch(error){observation.frames.push({error:error.message.slice(0,300)});}finally{await engine?.detach();}
  }
  const screenshot=path.join(runtime.home,task.id+'-'+Date.now()+'-lookup.png');
  await capturePageEvidence(runtime.context,page,{path:screenshot});
  const bytes=await readFile(screenshot), sha=createHash('sha256').update(bytes).digest('hex');
  const artifact=await runtime.cloud.request('artifact',{taskId:task.id,dataUrl:'data:image/png;base64,'+bytes.toString('base64')});
  const downloaded=await runtime.cloud.request('artifact-read',{taskId:task.id,ref:artifact.ref});
  if(sha!==artifact.sha256 || sha!==createHash('sha256').update(Buffer.from(downloaded.dataUrl.split(',')[1],'base64')).digest('hex'))
    throw new Error('查询截图回读失败；保留页面');
  Object.assign(observation,{url:page.url().split('?')[0],screenshot,artifactRef:artifact.ref,artifactSha256:sha,
    disposition:'registered',retainReason:input.keepOpen ? '后续登录或独立核验需要此查询页' :
      observation.frames.some(f=>f.detection?.hasCaptcha) ? '验证码待用户处理' : ''});
  runtime.update(task,{observationHistory:task.observationHistory},'lookup_evidence_saved');
  await runtime.synchronize();
  const remote=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
  if(!isDeepStrictEqual(remote?.observationHistory,onWire(task.observationHistory))) throw new Error('查询证据未回读；保留页面');
  if(!observation.retainReason) {
    await page.close(); Object.assign(observation,{closedAt:new Date().toISOString(),disposition:'closed'});
    runtime.update(task,{observationHistory:task.observationHistory},'lookup_tab_closed');
    await runtime.synchronize();
    const after=(await runtime.cloud.request('runs')).tasks.find(t=>t.id===task.id);
    if(!isDeepStrictEqual(after?.observationHistory,onWire(task.observationHistory))) throw new Error('查询页已关闭，关闭事件待恢复');
  }
  return {ok:true,taskId:task.id,observation};
}

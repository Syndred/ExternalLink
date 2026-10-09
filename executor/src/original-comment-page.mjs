import {randomUUID} from 'node:crypto';
import {attachEngine} from './engine.mjs';
import {getTargetInfo} from './browser-target.mjs';
import {connectionIdentity} from './workbench-connections.mjs';

// Use the same page snapshot / content preview split as the original sidepanel.
// A standalone article URL remains supported when no executor page matches it.
export async function originalPageCommentDrafts(runtime,input,request,assertScope){
 const typed=String(input.pageText||'').trim();
 if(typed.length>=120&&!input.targetId)return null;
 const connection=connectionIdentity(runtime.store.get('pair'));
 if(!runtime.context&&typeof runtime.connect==='function'){
  try{await runtime.connect();}catch(error){if(input.targetId)throw error;}
 }
 assertScope();
 if(connection!==connectionIdentity(runtime.store.get('pair')))throw Error('工作区或设备已切换，旧评论结果已放弃');
 const context=runtime.context;if(!context){if(input.targetId)throw Error('所选文章页已断开，请重新选择');return null;}
 let pages=context.pages().filter(page=>!page.isClosed()&&/^https?:\/\//.test(page.url())&&new URL(page.url()).href===input.pageUrl);
 if(input.targetId){const selected=[];for(const page of pages){const info=await getTargetInfo(context,page);if(info?.targetId===input.targetId)selected.push(page);}pages=selected;if(!pages.length)throw Error('所选文章页已关闭或跳转，请重新选择');}
 if(!pages.length)return null;
 if(pages.length>1)throw Error('执行器中有多个相同文章页，请选择评论使用的网页');
 const page=pages[0];let engine,transferred=false;
 const assertOwner=()=>{assertScope();if(connection!==connectionIdentity(runtime.store.get('pair')))throw Error('工作区或设备已切换，旧评论结果已放弃');if(runtime.context!==context||page.isClosed()||new URL(page.url()).href!==input.pageUrl)throw Error('文章页面已切换，旧评论结果已放弃');};
 const assertCurrent=async()=>{assertOwner();if(engine&&!await engine.isCurrentDocument())throw Error('文章页面已切换，旧评论结果已放弃');assertOwner();};
 const transfer=result=>{transferred=true;return{result,assertCurrent,assertOwner,release:()=>engine.detach()};};
 try{
  await assertCurrent();
  engine=await attachEngine(context,page.mainFrame(),async message=>{
   if(message.action!=='generateCommentDrafts')return{ok:true};
   await assertCurrent();const result=await request({...input,...message,config:input.config,language:input.language,allowLink:input.allowLink,tone:input.tone});await assertCurrent();return result;
  },{worldName:'ExternalLinkCommentPreview-'+randomUUID()});
  let snapshot;
  if(typed.length<120){try{snapshot=await engine.call({action:'getPageSnapshot'});}catch{}await assertCurrent();}
  const pageText=typed.length>=120?typed:String(snapshot?.text||'').trim();
  if(pageText.length>=120){const result=await request({...input,pageText,pageTitle:input.pageTitle||snapshot?.title||''});await assertCurrent();return transfer(result);}
  const preview=await engine.call({action:'generateCommentPreview',config:input.config,refresh:input.refresh===true,count:1});await assertCurrent();
  if(!preview?.ok||!preview.text?.trim())throw Error(preview?.error||'AI 评论生成失败，请确认文章正文足够长');
  return transfer({ok:true,status:'ok',drafts:[{text:preview.text,angle:'页面兜底'}]});
 }finally{if(!transferred)await engine?.detach();}
}

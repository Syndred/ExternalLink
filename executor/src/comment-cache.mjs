import {connectionIdentity} from './workbench-connections.mjs';

// The original background kept 60 successful responses for 30 minutes.
// This cache is separate from the durable, edited comment history.
const ttl=30*60*1000,limit=60,caches=new WeakMap();
export async function originalCommentRequest(runtime,input,request){
 const config=input.config||{};
 if(config.aiComments===false)return{ok:false,status:'disabled',drafts:[],error:'AI 评论生成已在设置中关闭'};
 const scope=connectionIdentity(runtime.store.get('pair'));
 let cache=caches.get(runtime);if(!cache||cache.scope!==scope){cache={scope,values:new Map()};caches.set(runtime,cache);}
 const key=`${config.projectKey||''}|${input.pageUrl||''}|${input.count||1}`,cached=cache.values.get(key);
 if(cached&&!input.refresh&&Date.now()-cached.at<ttl)return{...structuredClone(cached.value),cached:true};
 const payload={...input,language:input.language||config.language||'auto',allowLink:input.allowLink!==false&&config.aiCommentAllowLink!==false};delete payload.refresh;
 const result=await request(payload);
 if(scope!==connectionIdentity(runtime.store.get('pair')))throw Error('工作区或设备已切换，旧评论结果已放弃');
 if(result?.ok!==false&&result?.status==='ok'&&Array.isArray(result.drafts)&&result.drafts.some(draft=>typeof draft?.text==='string'&&draft.text.trim())){
  cache.values.set(key,{at:Date.now(),value:structuredClone(result)});
  if(cache.values.size>limit)cache.values.delete(cache.values.keys().next().value);
 }
 return result;
}

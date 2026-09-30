(async()=>{
 const token=new URLSearchParams(location.hash.slice(1)).get('access');history.replaceState(null,'',location.pathname);
 const status=document.getElementById('connection-status');
 window.ExtLinkWorkbench=true;
 document.querySelectorAll('[data-view]').forEach(tab=>tab.addEventListener('click',()=>{
  document.querySelectorAll('[data-view]').forEach(item=>item.setAttribute('aria-selected',String(item===tab)));
  for(const view of ['workbench','journal'])document.getElementById('panel-'+view).hidden=view!==tab.dataset.view;
 }));
 const request=async(path,body,raw=false)=>{const response=await fetch(path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});if(raw){if(!response.ok)throw Error('图片读取失败');const blob=await response.blob();return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({ok:true,dataUrl:reader.result});reader.onerror=reject;reader.readAsDataURL(blob);});}const data=await response.json();if(!response.ok||data.ok===false)throw Error(data.error||'请求失败');return data;};
 try{
 const connection=await request('/connection');let snapshot=await request('/workbenchDocuments',{});const pending=await request('/workbenchPending',{});
 const state={...snapshot.documents,activeSiteId:'JevPlay',cloudSyncConfig:{...connection,storageBackend:'d1'},executorConnection:{endpoint:location.origin,localToken:token},cloudSyncPendingKeys:[],d1JournalPending:pending.pending};const listeners=[];
 // Adapter uses application memory and authenticated APIs, never extension storage.
 window.chrome={storage:{local:{get:async keys=>Object.fromEntries((Array.isArray(keys)?keys:[keys]).filter(k=>k in state).map(k=>[k,state[k]])),set:async values=>{Object.assign(state,values);for(const fn of listeners)fn(Object.fromEntries(Object.keys(values).map(k=>[k,{}])),'local');}},onChanged:{addListener:fn=>listeners.push(fn)}},runtime:{sendMessage:async msg=>{try{
 if(msg.action==='submissionJournalCloud'){if(!msg.taskId){await request('/journalFlush',{});const pending=await request('/workbenchPending',{});state.d1JournalPending=pending.pending;}return await request('/cloud/workspace/submission-tasks?'+(msg.taskId?'taskId='+encodeURIComponent(msg.taskId):'after='+encodeURIComponent(msg.after||'')));}
 if(msg.action==='submissionJournalDocuments'){snapshot=await request('/workbenchDocuments',{});showConnection();return snapshot;}
 if(msg.action==='submissionJournalArtifact'||msg.action==='fetchCloudSubmissionMedia'){const artifact=msg.action==='submissionJournalArtifact',id=String(msg.ref).replace(/^cloud-(artifact|media):\/\//,'');if(!/^[a-zA-Z0-9._-]+$/.test(id))throw Error('无效图片引用');return await request('/cloud/workspace/'+(artifact?'automation/artifacts/':'media/')+id,undefined,true);}
 if(msg.action==='submissionJournalProgress'){const event={...msg,id:crypto.randomUUID(),source:'manual',confirmedBy:'manual'};delete event.action;const result=await request('/journalProgress',{event}),pending=await request('/workbenchPending',{});state.d1JournalPending=pending.pending;return result;}
 throw Error('此操作请使用对应工作台入口');}catch(error){return{ok:false,error:error.message};}}}};
 for(const src of ['/extension/executor-panel.js','/extension/submission-journal.js'])await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;script.onload=resolve;script.onerror=reject;document.body.append(script);});
 document.getElementById('journal-recover').closest('details').hidden=true;document.getElementById('executor-pair-details').hidden=true;
 window.addEventListener('externallink:tasks',async event=>{if(event.detail.workbenchPendingEvents!==undefined&&event.detail.workbenchPendingEvents!==state.d1JournalPending.length){try{const pending=await request('/workbenchPending',{});await window.chrome.storage.local.set({d1JournalPending:pending.pending});}catch{}}});
 const edit=document.createElement('button'),editor=document.createElement('section');edit.textContent='编辑本站资料';editor.hidden=true;editor.className='journal-detail';editor.id='workbench-profile-editor';document.querySelector('.journal-controls').append(edit);document.getElementById('journal-status').after(editor);
 edit.onclick=async()=>{edit.disabled=true;try{
  const fresh=await request('/cloud/workspace/journal-documents'),id=document.getElementById('journal-profile').value,original=fresh.documents.siteProfiles[id];if(!original)throw Error('该站点资料不存在，请刷新');
  editor.replaceChildren();editor.hidden=false;const heading=document.createElement('h3');heading.textContent='编辑 '+(original.name||id)+' 的云端资料';editor.append(heading);
  const form=document.createElement('form'),inputs=new Map(),message=document.createElement('p');message.setAttribute('role','status');
  for(const [key,value]of Object.entries(original.fields||{})){if(typeof value!=='string'||/password|token|secret|密码/i.test(key))continue;const label=document.createElement('label'),input=document.createElement('textarea');label.textContent=key;input.value=value;input.rows=/description|描述|feature/i.test(key)?5:2;input.setAttribute('aria-label','编辑 '+key);input.style.cssText='display:block;width:100%;box-sizing:border-box;margin:6px 0 16px';label.append(input);form.append(label);inputs.set(key,input);}
  const save=document.createElement('button'),cancel=document.createElement('button');save.type='submit';save.textContent='保存资料到云端';cancel.type='button';cancel.textContent='关闭编辑';cancel.onclick=()=>{editor.hidden=true;};form.append(save,cancel,message);editor.append(form);
  form.onsubmit=async event=>{event.preventDefault();save.disabled=true;try{
   const fields=Object.fromEntries([...inputs].map(([key,input])=>[key,input.value])),changed=Object.keys(fields).some(key=>fields[key]!==original.fields[key]);
   if(changed){const profile={id,fields,...(Object.hasOwn(fields,'Url')?{url:fields.Url}:{})};await request('/cloud/profile',{profileId:id,profile,revision:fresh.revisions.siteProfiles});}
   const proof=await request('/cloud/workspace/journal-documents');if(Object.entries(fields).some(([key,value])=>proof.documents.siteProfiles?.[id]?.fields?.[key]!==value))throw Error('云端资料已变化，回读不一致；编辑内容仍保留');
   snapshot=proof;await window.chrome.storage.local.set({siteProfiles:proof.documents.siteProfiles});document.getElementById('journal-refresh').click();message.textContent=changed?'资料已保存，并完成云端回读核对。':'资料与云端一致，无需重复写入。';
  }catch(error){message.textContent='保存未确认，编辑内容仍保留：'+error.message;}finally{save.disabled=false;}};
 }catch(error){status.textContent='资料暂不可编辑：'+error.message;}finally{edit.disabled=false;}};
 function showConnection(){status.textContent=snapshot.cached?'云端暂不可读，已恢复本机缓存（'+snapshot.cachedAt+'）；新进度会持久保存在本机并重试。':'已连接真实 D1 云端；本机执行器连接状态见下方运行工作台。';}
 showConnection();document.getElementById('journal-refresh').click();
 }catch(error){status.textContent='连接失败：'+error.message;}
})();

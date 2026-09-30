export function showSetup({connection,content,status,el,button,request}){
 status.textContent='本机尚未连接云端';const file=el('input',{type:'file',accept:'.json','aria-label':'设备登记文件'}),message=el('p',{role:'status'});let enrollment;
 file.onchange=async()=>{try{const chosen=file.files[0];if(!chosen)return;if(chosen.size>32768)throw Error('登记文件过大');enrollment=JSON.parse(await chosen.text());message.textContent='已选择登记文件，连接时会核验设备和工作区。';}catch(error){message.textContent=error.message;}};
 const connect=async fromLocal=>{if(!fromLocal&&!enrollment)throw Error('请先选择设备登记文件');await request('/setup',{nonce:connection.nonce,...(!fromLocal?{enrollment}:{})});location.reload();};
 content.replaceChildren(el('h2',{text:'连接云端'}),el('p',{text:'使用设备登记文件连接原云端账本，登录凭据保存在本机。连接成功后可导入原插件备份完成首次迁移。'}),...(connection.enrollmentAvailable?[button('使用本机已有登记连接',()=>connect(true),true)]:[]),el('label',{},['选择设备登记文件',file]),button('连接所选云端设备',()=>connect(false),true),message);
}

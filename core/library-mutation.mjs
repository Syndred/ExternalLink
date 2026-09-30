import './queue.js';
const fail=message=>{throw Object.assign(Error(message),{status:400});};
const keyOf=url=>{let parsed;try{parsed=new URL(url);}catch{fail('无效网址');}if(!/^https?:$/.test(parsed.protocol)||parsed.username||parsed.password)fail('外链入口必须为普通 HTTP/HTTPS 网页');return globalThis.ExtLinkQueue.normalizeDestinationKey(parsed.href);};
const storedKey=row=>{try{return keyOf(row.indexPage||row.link);}catch{return null;}};
export function libraryMutation(documents,operation){
 const at=operation.at||'',id=operation.id;if(!id||!at)fail('缺少修改身份');
 if(operation.type==='import'){
  const table=structuredClone(documents.sheetTableData||{entries:[]}),known=new Set(table.entries.map(storedKey).filter(Boolean));
  const urls=operation.urls;if(!Array.isArray(urls)||urls.length<1||urls.length>500)fail('每次导入 1–500 个网址');
  for(const url of urls){const key=keyOf(url);if(known.has(key))continue;known.add(key);table.entries.push({link:new URL(url).href,indexPage:new URL(url).href,source:'application_import',addedAt:at,mutationId:id});}
  return{key:'sheetTableData',data:table};
 }
 const destinationKey=keyOf(operation.url);
 if(operation.type==='mark'){
  if(!['can_submit','paid','broken','skip','needs_otp','needs_captcha','needs_login','needs_manual','deleted'].includes(operation.status))fail('无效站点标记');
  const annotations=structuredClone(documents.siteAnnotations||{}),previous=annotations[destinationKey]||{};
  annotations[destinationKey]={...previous,status:operation.status,statuses:[operation.status],note:String(operation.note||'').slice(0,10000),updatedAt:at,source:'application_manual',mutationId:id};
  return{key:'siteAnnotations',data:annotations};
 }
 if(operation.type==='edit'){
  const table=structuredClone(documents.sheetTableData||{entries:[]}),row=table.entries.find(r=>storedKey(r)===destinationKey);if(!row)fail('该入口不是可编辑的表格行');
  const allowed=new Set(['name','category','tags','da','dr','price','note']);
  for(const [key,value]of Object.entries(operation.fields||{})){if(!allowed.has(key)||typeof value!=='string'||value.length>10000)fail('字段无效');row[key]=value;}
  row.updatedAt=at;row.mutationId=id;return{key:'sheetTableData',data:table};
 }
 fail('不支持的外链库操作');
}
export function libraryMutationSatisfied(documents,operation){
 if(operation.type==='import'){const known=new Set((documents.sheetTableData?.entries||[]).map(storedKey));return operation.urls.every(url=>known.has(keyOf(url)));}
 const key=keyOf(operation.url);
 if(operation.type==='mark'){const annotation=documents.siteAnnotations?.[key];return annotation?.status===operation.status&&annotation?.note===String(operation.note||'').slice(0,10000);}
 if(operation.type==='edit'){const row=documents.sheetTableData?.entries.find(r=>storedKey(r)===key);return !!row&&Object.entries(operation.fields||{}).every(([key,value])=>row[key]===value);}
 return false;
}

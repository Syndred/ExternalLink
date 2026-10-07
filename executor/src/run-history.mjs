import {createHash} from 'node:crypto';
import {workbenchScope} from './workbench-sync.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.trim()&&value.length<=500;
const partBytes=512*1024,maxFileBytes=256*1024*1024;
function safeTree(value){if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(['__proto__','constructor','prototype'].includes(key))throw Error('记录含不安全字段');safeTree(child);}}
function validateRun(run){
 if(!object(run)||!id(run.runId)||!object(run.tasks)||!Array.isArray(run.events))throw Error('原执行记录格式不完整');
 // Original ledgers store task/event facts, never pairing credentials or model keys.
 const rejectCredentials=value=>{if(!value||typeof value!=='object')return;for(const [key,child]of Object.entries(value)){if(/^(?:pair|credentials?|password|deviceToken|localToken|accessToken|apiKey|cfgApiKey|cloudSyncConfig)$/i.test(key))throw Error('执行记录包含连接凭据，请使用原执行记录导出文件');rejectCredentials(child);}};
 rejectCredentials(run);for(const event of run.events)if(!object(event)||!id(event.id))throw Error('原事件编号缺失，不能补造历史事件');
 if(new Set(run.events.map(event=>event.id)).size!==run.events.length)throw Error('原事件编号重复');
}
function normalize(raw){
 if(!object(raw))throw Error('请选择原插件记录或包含执行历史的JSON文件');safeTree(raw);
 const candidates=[raw,raw.documents,raw.data,raw.storage].filter(object);
 let source=candidates.find(value=>Object.hasOwn(value,'activeBatchRun')||Object.hasOwn(value,'automationRunLedger'));
 if(!source){if(Array.isArray(raw.order)&&object(raw.runs))source={automationRunLedger:raw};else if(id(raw.runId)&&Array.isArray(raw.tasks))source={activeBatchRun:raw};else if(id(raw.runId)&&object(raw.tasks)&&Array.isArray(raw.events))source={automationRunLedger:{schemaVersion:1,order:[raw.runId],runs:{[raw.runId]:raw}}};}
 if(!source)throw Error('文件没有原批次或执行历史；普通资料备份不代表执行记录');
 const history={};
 if(source.activeBatchRun!=null){const batch=source.activeBatchRun;if(!object(batch)||!id(batch.runId)||!Array.isArray(batch.tasks)||batch.destinations!=null&&!Array.isArray(batch.destinations))throw Error('原批次范围格式不完整');for(const task of batch.tasks)if(!Array.isArray(task)&&!object(task))throw Error('原批次组合格式无效');history.activeBatchRun=structuredClone(batch);}
 if(source.automationRunLedger!=null){const ledger=source.automationRunLedger;if(!object(ledger)||!Array.isArray(ledger.order)||!object(ledger.runs)||new Set(ledger.order).size!==ledger.order.length)throw Error('原执行历史顺序格式无效');for(const key of ledger.order)if(!id(key)||!Object.hasOwn(ledger.runs,key))throw Error('原执行历史缺少对应记录');for(const [key,run]of Object.entries(ledger.runs)){validateRun(run);if(key!==run.runId)throw Error('原执行记录编号不一致');}history.automationRunLedger=structuredClone(ledger);}
 if(!history.activeBatchRun&&!history.automationRunLedger?.order.length)throw Error('文件没有可恢复的执行历史');
 return history;
}

function preparePreview(store,scope,input,verifiedFileSha256){
  const raw=JSON.parse(input.content.replace(/^\uFEFF/,''));if(raw.scope&&raw.scope!==scope)throw Error('记录来自其他工作区');
  const history=normalize(raw),sha256=verifiedFileSha256||digest(input.content),historyHash=digest(JSON.stringify(history)),previewId=digest(scope+'|'+historyHash),preview={id:previewId,scope,sha256,historyHash,history,name:String(input.name||'原执行历史.json').slice(0,200),at:new Date().toISOString()};
  const existing=store.get('originalRunHistory:'+previewId);store.set('runHistoryPreview:'+previewId,preview);
  return{ok:true,preview:{id:previewId,name:preview.name,originalBatchId:history.activeBatchRun?.runId||null,combinations:history.activeBatchRun?.tasks.length||0,runIds:history.automationRunLedger?.order||[],runs:history.automationRunLedger?.order.length||0,events:Object.values(history.automationRunLedger?.runs||{}).reduce((sum,run)=>sum+run.events.length,0),alreadyRestored:!!existing}};
}
export function runHistory(runtime,action,input={}){
 const store=runtime.store,pair=store.get('pair');if(!pair?.endpoint)throw Error('请先连接原工作区');const scope=workbenchScope(pair);
 if(action==='previewRunHistory'){
  if(typeof input.content!=='string'||Buffer.byteLength(input.content)>8*1024*1024)throw Error('较大执行历史请使用分段文件恢复入口');
  return preparePreview(store,scope,input);
 }
 if(action==='runHistoryUploadStart'){
  if(!/^[a-f0-9]{64}$/.test(input.sha256)||!Number.isSafeInteger(input.bytes)||input.bytes<1||input.bytes>maxFileBytes)throw Error('执行历史文件需为不超过256 MiB的JSON文件');
  const uploadId=digest(scope+'|'+input.sha256),previous=store.get('runHistoryUpload:'+uploadId);
  if(previous&&(previous.bytes!==input.bytes||previous.sha256!==input.sha256||previous.scope!==scope))throw Error('原文件上传范围校验不一致');
  const upload=previous||{id:uploadId,scope,sha256:input.sha256,bytes:input.bytes,count:Math.ceil(input.bytes/partBytes),partBytes,name:String(input.name||'原执行历史.json').slice(0,200),at:new Date().toISOString()};
  if(!previous)store.set('runHistoryUpload:'+uploadId,upload);
  return{ok:true,upload:{id:upload.id,partBytes,count:upload.count,present:store.values('runHistoryPart:'+upload.id+':').map(part=>part.index)}};
 }
 if(['runHistoryUploadPart','runHistoryUploadComplete'].includes(action)){
  if(typeof input.id!=='string'||!/^[a-f0-9]{64}$/.test(input.id))throw Error('原历史上传编号无效');const upload=store.get('runHistoryUpload:'+input.id);
  if(!upload||upload.scope!==scope)throw Error('工作区或原历史上传已变化');
  if(action==='runHistoryUploadPart'){
   if(!Number.isInteger(input.index)||input.index<0||input.index>=upload.count||typeof input.data!=='string'||input.data.length>Math.ceil(partBytes/3)*4)throw Error('原历史分段范围无效');
   const bytes=Buffer.from(input.data,'base64'),expected=Math.min(partBytes,upload.bytes-input.index*partBytes);
   if(bytes.length!==expected||bytes.toString('base64')!==input.data||digest(bytes)!==input.sha256)throw Error('原历史分段校验失败');
   const key='runHistoryPart:'+upload.id+':'+input.index,previous=store.get(key);
   if(previous&&previous.sha256!==input.sha256)throw Error('原历史分段已有不同内容，不能覆盖');
   if(!previous)store.set(key,{index:input.index,sha256:input.sha256,data:input.data});return{ok:true,index:input.index,alreadySaved:!!previous};
  }
  const parts=[];for(let index=0;index<upload.count;index++){const part=store.get('runHistoryPart:'+upload.id+':'+index);if(!part)throw Error('原历史分段未齐，请重新选择原文件继续');const bytes=Buffer.from(part.data,'base64');if(digest(bytes)!==part.sha256)throw Error('已保存原历史分段校验失败');parts.push(bytes);}
  const bytes=Buffer.concat(parts);if(bytes.length!==upload.bytes||digest(bytes)!==upload.sha256)throw Error('原执行历史完整文件校验失败');const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return preparePreview(store,scope,{content,name:upload.name},upload.sha256);
 }
 if(action!=='importRunHistory')throw Error('未知执行历史恢复操作');
 if(typeof input.previewId!=='string'||!/^[a-f0-9]{64}$/.test(input.previewId))throw Error('请先预览原执行历史');const preview=store.get('runHistoryPreview:'+input.previewId);
 if(!preview||preview.scope!==scope)throw Error('工作区或原文件预览已变化，请重新预览');
 if(digest(JSON.stringify(preview.history))!==preview.historyHash||digest(scope+'|'+preview.historyHash)!==preview.id)throw Error('原执行历史预览校验不一致');
 normalize(preview.history);store.db.exec('BEGIN IMMEDIATE');
 try{
  const existing=store.get('originalRunHistory:'+preview.id);
  if(existing&&existing.historyHash!==preview.historyHash)throw Error('原历史编号已有不同内容，不能覆盖');
  if(!existing)store.set('originalRunHistory:'+preview.id,{id:preview.id,scope,historyHash:preview.historyHash,sourceFileSha256:preview.sha256,name:preview.name,restoredAt:new Date().toISOString(),...preview.history});
  store.db.exec('COMMIT');return{ok:true,id:preview.id,alreadyRestored:!!existing,executionStarted:false};
 }catch(error){store.db.exec('ROLLBACK');throw error;}
}

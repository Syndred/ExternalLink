import './queue.js';
import './target-filters.js';
import './library-classifier.js';
import './submission-timeline.js';
import {canonicalLibraryDestination} from './library-records.mjs';
import {backupKeys,mergeApplicationBackup} from './application-backup.mjs';
import {mergeSubmify,applySubmifyGates} from './submify-sync.mjs';
import {checkablePublicUrl,targetHostForProfile} from './link-monitor.mjs';
import {recoveryDocument,validateRecoveryValue} from './local-recovery.mjs';
import {applyPreparedBackupKey} from './prepared-backup-key.mjs';
import {formKnowledgeMutation,formKnowledgeSatisfied} from './form-knowledge.mjs';
import {applicationSettingKeys} from './application-preferences.mjs';
import {validateBatchPreferenceValue,batchPreferencePatch} from './original-batch-config.mjs';
import {pruneDomainMetrics,domainMetricsLimit} from './domain-metrics.mjs';
import {originalTimelineMutation,originalTimelineSatisfied} from './original-timeline-mutation.mjs';
import {jsonValueEqual} from './json-value.mjs';
const fail=message=>{throw Object.assign(Error(message),{status:400});};
const keyOf=url=>{let parsed;try{parsed=new URL(url);}catch{fail('无效网址');}if(!/^https?:$/.test(parsed.protocol)||parsed.username||parsed.password)fail('外链入口必须为普通 HTTP/HTTPS 网页');return globalThis.ExtLinkQueue.normalizeDestinationKey(parsed.href);};
const catalogKeyOf=url=>{keyOf(url);return canonicalLibraryDestination(url);};
const storedKey=row=>{try{return keyOf(row.indexPage||row.link);}catch{return null;}};
function blacklistChange(current,value){
 const rows=input=>Array.isArray(input)?input:typeof input==='string'?input.split(/[\n,]/):[];
 let patch;if(Array.isArray(value)||typeof value==='string')patch={replace:true,add:rows(value)};
 else if(value&&typeof value==='object'&&!Object.keys(value).some(k=>!['add','remove','replace'].includes(k))&&(value.replace===undefined||typeof value.replace==='boolean'))patch=value;
 else fail('黑名单无效');
 for(const key of ['add','remove'])if(patch[key]!==undefined&&(!Array.isArray(patch[key])||patch[key].length>10000||patch[key].some(v=>typeof v!=='string'||v.length>10000)))fail('黑名单无效');
 if(typeof value==='string'&&value.length>100000)fail('黑名单无效');
 const normalize=globalThis.ExtLinkQueue.normalizeBlacklistEntry,next=new Set(rows(current).map(normalize));
 if(patch.replace)next.clear();
 for(const item of patch.add||[]){const entry=item.trim();if(!entry)continue;const normalized=normalize(entry);next.add(/^[*.]/.test(entry)?'.'+normalized:normalized);}
 for(const item of patch.remove||[]){const normalized=normalize(item);next.delete(normalized);next.delete('.'+normalized);}
 return [...next].filter(Boolean).sort();
}
export function libraryMutation(documents,operation,options={}){
 const copy=value=>options.inPlace?value:structuredClone(value);
 const at=operation.at||'',id=operation.id;if(!id||!at)fail('缺少修改身份');
 if(['form_learning','form_knowledge'].includes(operation.type)){keyOf(operation.url);return formKnowledgeMutation(documents,operation);}
 if(operation.type==='recover_local')return{key:operation.key,data:recoveryDocument(documents,operation.key,operation.data)};
 if(operation.type==='backup_prepared_key'){try{const data=applyPreparedBackupKey(documents,operation);validateRecoveryValue(operation.key,data);return{key:operation.key,data};}catch(error){fail(error.message);}}
 if(operation.type==='add_browser_url'){
  const key=catalogKeyOf(operation.url),url=operation.url.trim(),platform=operation.platformType??'directory';if(typeof platform!=='string'||!/^\w{1,64}$/.test(platform))fail('网页类型无效');
  const lines=String(documents.urlList||'').split('\n').map(line=>line.trim()).filter(Boolean);
  const exists=lines.some(line=>{try{return catalogKeyOf(line.split('|')[0].trim())===key;}catch{return false;}});
  if(!exists)lines.unshift(url+'|'+platform);
  const annotations=structuredClone(documents.siteAnnotations||{});delete annotations[key];delete annotations[globalThis.ExtLinkQueue.extractDomain(url)];
  const updates={urlList:lines.join('\n'),deletedSubmissionKeys:(documents.deletedSubmissionKeys||[]).filter(value=>value!==key),siteAnnotations:annotations};
  return{key:'urlList',data:updates.urlList,updates,revisionKeys:Object.keys(updates)};
 }
 if(operation.type==='pin'){
  const platform=operation.platformType??'directory';if(typeof platform!=='string'||!/^\w{1,64}$/.test(platform))fail('网页类型无效');
  const key=catalogKeyOf(operation.url),lines=String(documents.urlList||'').split('\n').map(s=>s.trim()).filter(Boolean),matching=lines.find(s=>{try{return catalogKeyOf(s.split('|')[0])===key;}catch{return false;}}),rest=lines.filter(s=>{try{return catalogKeyOf(s.split('|')[0])!==key;}catch{return true;}});
  return{key:'urlList',data:[matching||new URL(operation.url).href+'|'+platform,...rest].join('\n')};
 }
 if(operation.type==='clear_deleted'){const key=catalogKeyOf(operation.url);return{key:'deletedSubmissionKeys',data:(documents.deletedSubmissionKeys||[]).filter(k=>k!==key)};}
 if(operation.type==='set_deleted'){const key=catalogKeyOf(operation.url);return{key:'deletedSubmissionKeys',data:[...new Set([...(documents.deletedSubmissionKeys||[]),key])]};}
 if(operation.type==='remove_queue'){
  const key=catalogKeyOf(operation.url),domain=globalThis.ExtLinkQueue.extractDomain(operation.url),annotations=structuredClone(documents.siteAnnotations||{}),previous=annotations[key]||annotations[domain]||{};
  annotations[key]={...previous,url:operation.url,domain,status:'deleted',statuses:['deleted'],note:String(operation.note||previous.note||'').slice(0,10000),updatedAt:at,auto:false,mutationId:id};annotations[domain]=structuredClone(annotations[key]);return{key:'siteAnnotations',data:annotations};
 }
 if(operation.type==='clear_annotation'){
  const key=catalogKeyOf(operation.url),domain=globalThis.ExtLinkQueue.extractDomain(operation.url),annotations=structuredClone(documents.siteAnnotations||{}),knowledge=(annotations[key]||annotations[domain])?.formKnowledge;
  delete annotations[key];delete annotations[domain];if(knowledge){annotations[key]={url:operation.url,domain,formKnowledge:knowledge};annotations[domain]=structuredClone(annotations[key]);}
  return{key:'siteAnnotations',data:annotations};
 }
 if(operation.type==='submify_refs'){
  if(!Array.isArray(operation.items)||operation.items.length>5000)fail('公共库来源编号无效');const table=copy(documents.sheetTableData||{entries:[]}),rows=new Map();for(const row of table.entries){const key=storedKey(row);if(key&&!rows.has(key))rows.set(key,row);}
  for(const item of operation.items){const key=keyOf(item.link||item.url),row=rows.get(key);if(!row)fail('公共库入口已变化，请先核对原同步');if(item.id)row.sourceRefs=[...new Set([row.sourceId,...(row.sourceRefs||[]),item.id].map(v=>String(v||'').trim()).filter(Boolean))];}
  return{key:'sheetTableData',data:table};
 }
 if(operation.type==='submify_import'){
  if(!Array.isArray(operation.items)||!operation.items.length||operation.items.length>5000)fail('公共库记录无效');for(const item of operation.items){keyOf(item?.link||item?.url);if(item.id!=null&&typeof item.id!=='string'&&typeof item.id!=='number')fail('公共库身份无效');}
  return{key:'sheetTableData',data:mergeSubmify(documents,operation.items,at).tableData};
 }
 if(operation.type==='submify_gates'){
  if(!Array.isArray(operation.gates)||operation.gates.length>5000)fail('导入门槛无效');for(const gate of operation.gates){keyOf(gate?.url);if(!['paid','skip'].includes(gate.reason))fail('导入门槛无效');}
  return{key:'siteAnnotations',data:applySubmifyGates(documents.siteAnnotations,operation.gates,at,id)};
 }
 if(operation.type==='monitor_result'){
  const result=operation.result;if(typeof operation.recordKey!=='string'||!documents.submissionRecords?.[operation.recordKey]||!result||!['live','missing','unreachable','uncheckable'].includes(result.status)||typeof result.targetFound!=='boolean')fail('监测结果无效');
  if(result.status==='live'&&(!result.targetFound||!result.targetHost))fail('监测没有目标链接证据');
  return{key:'linkMonitorResults',data:{...documents.linkMonitorResults,[operation.recordKey]:{...structuredClone(result),monitorJobId:operation.jobId}}};
 }
 if(operation.type==='monitor_publication'){
  const record=documents.submissionRecords?.[operation.recordKey],proof=documents.linkMonitorResults?.[operation.recordKey];
  if(record?.status!=='success'||proof?.status!=='live'||!proof.targetFound||proof.monitorJobId!==operation.jobId||proof.inputUrl!==checkablePublicUrl(record)||proof.targetHost!==targetHostForProfile(documents.siteProfiles?.[record.profileId]))fail('原收件与监测证据不一致，不能确认上线');
  return{key:'submissionRecords',data:{...documents.submissionRecords,[operation.recordKey]:globalThis.ExtLinkQueue.applyPublicationUpgrade(record,'published',{publicUrl:record.publicUrl||proof.url})}};
 }
 if(operation.type==='domain_metrics'){
  const rows=operation.results;if(!Array.isArray(rows)||rows.length>20)fail('域名查询结果无效');
  const cache=structuredClone(documents.domainMetricsCache||{});
  for(const row of rows){if(!row||!/^([a-z0-9-]+\.)+[a-z0-9-]+$/.test(row.domain||'')||!['ok','unknown'].includes(row.status)||['ageDays','ageMonths'].some(k=>row[k]!=null&&(!Number.isFinite(row[k])||row[k]<0))||row.fetchedAt!==undefined&&(!Number.isFinite(row.fetchedAt)||row.fetchedAt<0))fail('域名查询结果无效');cache[row.domain]={...cache[row.domain],...structuredClone(row),fetchedAt:row.fetchedAt??(Date.parse(at)||0),checkedAt:at};}
  return{key:'domainMetricsCache',data:pruneDomainMetrics(cache)};
 }
 if(['backup_merge','backup_key_merge'].includes(operation.type)){
  if(!backupKeys.includes(operation.key))fail('不支持的备份字段');
  const merged=mergeApplicationBackup(documents,operation.backup,{prepareProfiles:false});if(!Object.hasOwn(merged,operation.key))fail('备份未包含该字段');
  return{key:operation.key,data:merged[operation.key]};
 }
 if(operation.type==='timeline'){
  return originalTimelineMutation(documents,operation);
 }
 if(operation.type==='settings'){
  const allowed=applicationSettingKeys;
  if(!allowed.includes(operation.key))fail('不支持的设置');
  const value=operation.value;
  if(operation.key==='unattendedPreferences')return{key:operation.key,data:{...(documents.unattendedPreferences||{}),...batchPreferencePatch(value)}};
  if(operation.key==='cfgConcurrency'){validateBatchPreferenceValue(operation.key,value);return{key:operation.key,data:structuredClone(value)};}
  if(operation.key.startsWith('autoSubmit')){
   if(typeof value!=='boolean')fail('自动提交设置必须为开启或关闭');
  }else if(operation.key==='cfgPingIndex'){
   if(typeof value!=='boolean')fail('搜索引擎通知设置必须为开启或关闭');
  }else if(operation.key==='autoFillOnVisit'){
   if(typeof value!=='boolean')fail('访问自动填写设置必须为开启或关闭');
  }else if(operation.key==='linkMonitorSchedule'){
   if(!value||typeof value.enabled!=='boolean'||!Number.isFinite(value.minutes)||value.minutes<15||value.minutes>10080||value.desktopNotifications!==undefined&&typeof value.desktopNotifications!=='boolean'||Object.keys(value).some(k=>!['enabled','minutes','desktopNotifications'].includes(k)))fail('监测计划无效');
  }else if(operation.key==='targetFilters'){
   if(!value||typeof value!=='object'||Array.isArray(value))fail('筛选条件无效');
   const numeric=['minOpportunityScore','minDr','minDa','minDomainAgeMonths'];
   const booleans=['aiCommentAllowLink','aiComments','blacklistEnabled','requireKnownDomainAge','showManualFillIcons'];
   if(Object.entries(value).some(([k,v])=>!numeric.includes(k)&&!booleans.includes(k)||v!==null&&!['string','number','boolean'].includes(typeof v)||typeof v==='string'&&v.length>10000))fail('筛选条件无效');
   return{key:operation.key,data:globalThis.ExtLinkTargetFilters.normalize({...globalThis.ExtLinkTargetFilters.normalize(documents.targetFilters),...value})};
  }else if(operation.key==='domainBlacklist'){
   return{key:operation.key,data:blacklistChange(documents.domainBlacklist,value)};
  }else if(typeof value!=='string'||value.length>10000)fail('设置无效');
  return{key:operation.key,data:structuredClone(value)};
 }
 if(operation.type==='create'){
  const key=keyOf(operation.url),table=structuredClone(documents.sheetTableData||{entries:[]});
  if(table.entries.some(r=>storedKey(r)===key))fail('该网址已在外链库中，请编辑原记录');
  const fields=operation.fields||{};
  for(const [k,v]of Object.entries(fields))if(!['name','category','tags','dr','da','price','note','language','accessModel'].includes(k)||typeof v!=='string'||v.length>10000)fail('网站资料无效');
  const metrics={};for(const k of ['dr','da'])if(fields[k]?.trim()){const n=Number(fields[k]);if(!Number.isFinite(n)||n<0||n>100)fail('DR / DA 应为 0–100');metrics[k]=n;}
  table.entries.push({...fields,link:new URL(operation.url).href,indexPage:new URL(operation.url).href,metrics,source:'application_manual',addedAt:at,mutationId:id});
  return{key:'sheetTableData',data:table};
 }
 if(operation.type==='import'){
  const table=structuredClone(documents.sheetTableData||{entries:[]}),known=new Set(table.entries.map(storedKey).filter(Boolean));
  const urls=operation.urls;if(!Array.isArray(urls)||urls.length<1||urls.length>500)fail('每次导入 1–500 个网址');
  for(const url of urls){const key=keyOf(url);if(known.has(key))continue;known.add(key);table.entries.push({link:new URL(url).href,indexPage:new URL(url).href,source:'application_import',addedAt:at,mutationId:id});}
  return{key:'sheetTableData',data:table};
 }
 const destinationKey=['preferences','mark','automatic_mark'].includes(operation.type)?catalogKeyOf(operation.url):keyOf(operation.url);
 if(operation.type==='preferences'){
  const annotations=structuredClone(documents.siteAnnotations||{}),previous=annotations[destinationKey]||globalThis.ExtLinkQueue.findDestinationAnnotation(annotations,destinationKey,new URL(operation.url).hostname.replace(/^www\./,''))||{};
  const patch=operation.preferences;
  if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!['favorite','enabled','pinned','groups','profileIds'].includes(k)))fail('外链偏好无效');
  for(const k of ['favorite','enabled','pinned'])if(patch[k]!==undefined&&typeof patch[k]!=='boolean')fail('外链偏好无效');
  if(patch.groups!==undefined&&(!Array.isArray(patch.groups)||patch.groups.some(g=>!['high_quality','free_submit'].includes(g))))fail('外链分组无效');
  if(patch.profileIds!==undefined&&(!Array.isArray(patch.profileIds)||patch.profileIds.some(p=>!Object.hasOwn(documents.siteProfiles||{},p))))fail('产品分配无效');
  const classifier=globalThis.ExtLinkLibraryClassifier,defaults=classifier.libraryPreferences(previous),library={...previous.library,favorite:patch.favorite??defaults.favorite,enabled:patch.enabled??defaults.enabled,profileIds:classifier.normalizeProfileIds(patch.profileIds??defaults.profileIds),...patch,updatedAt:at};
  library.profileIds=classifier.normalizeProfileIds(library.profileIds);if(Object.hasOwn(library,'groups'))library.groups=classifier.normalizeLibraryGroups(library.groups);
  const domain=globalThis.ExtLinkQueue.extractDomain(operation.url);annotations[destinationKey]={...previous,url:operation.url,domain,library,updatedAt:at,mutationId:id};
  if(destinationKey===domain||!Object.hasOwn(library,'groups'))annotations[domain]=structuredClone(annotations[destinationKey]);
  return{key:'siteAnnotations',data:annotations};
 }
 if(operation.type==='mark'){
  const statuses=operation.statuses??[operation.status];
  if(!Array.isArray(statuses)||statuses.some(s=>!['can_submit','paid','broken','skip','needs_otp','needs_captcha','needs_login','needs_manual','deleted'].includes(s)))fail('无效站点标记');
  const annotations=structuredClone(documents.siteAnnotations||{}),previous=annotations[destinationKey]||globalThis.ExtLinkQueue.findDestinationAnnotation(annotations,destinationKey,new URL(operation.url).hostname.replace(/^www\./,''))||{};
  const queue=globalThis.ExtLinkQueue,domain=queue.extractDomain(operation.url),normalized=queue.normalizeAnnotationStatuses(statuses);
  annotations[destinationKey]={...previous,url:operation.url,domain,status:queue.primaryAnnotationStatus(normalized),statuses:normalized,note:String(operation.note||previous.note||'').slice(0,10000),updatedAt:at,auto:false,source:'application_manual',mutationId:id};annotations[domain]=structuredClone(annotations[destinationKey]);
  return{key:'siteAnnotations',data:annotations};
 }
 if(operation.type==='automatic_mark'){
  const queue=globalThis.ExtLinkQueue,status=operation.status;
  if(!['can_submit','paid','broken','skip','needs_otp','needs_captcha','needs_login','needs_manual','deleted'].includes(status)||typeof operation.note!=='string'||operation.note.length>10000)fail('无效自动网站观察');
  const annotations=structuredClone(documents.siteAnnotations||{}),domain=queue.extractDomain(operation.url),previous=annotations[destinationKey]||annotations[domain]||{},previousStatuses=queue.normalizeAnnotationStatuses(previous),note=operation.note;
  let annotation,deleted=documents.deletedSubmissionKeys||[];
  if(previousStatuses.length&&previous.auto!==true){
   annotation={...previous,status:queue.primaryAnnotationStatus(previousStatuses),statuses:previousStatuses,lastAutomaticObservation:{status,statuses:[status],note,updatedAt:at,mutationId:id}};
  }else{
   annotation={...previous,url:operation.url,domain,status:queue.primaryAnnotationStatus([status]),statuses:[status],note:note||previous.note||'',submittedProjects:Array.isArray(previous.submittedProjects)?[...previous.submittedProjects]:[],updatedAt:at,auto:true,mutationId:id};
   deleted=status==='deleted'?[...new Set([...deleted,destinationKey])]:deleted.filter(key=>key!==destinationKey);
  }
  annotations[destinationKey]=annotation;annotations[domain]=structuredClone(annotation);
  const updates={siteAnnotations:annotations,...(previousStatuses.length&&previous.auto!==true?{}:{deletedSubmissionKeys:deleted})};
  return{key:'siteAnnotations',data:annotations,updates,revisionKeys:['siteAnnotations','deletedSubmissionKeys']};
 }
 if(operation.type==='edit'){
  const table=structuredClone(documents.sheetTableData||{entries:[]}),row=table.entries.find(r=>storedKey(r)===destinationKey);if(!row)fail('该入口不是可编辑的表格行');
  const allowed=new Set(['name','category','tags','da','dr','price','note','language','accessModel']);
  for(const [key,value]of Object.entries(operation.fields||{})){if(!allowed.has(key)||typeof value!=='string'||value.length>10000)fail('字段无效');if(['dr','da'].includes(key)){const n=value.trim()?Number(value):null;if(n!==null&&(!Number.isFinite(n)||n<0||n>100))fail('DR / DA 应为 0–100');row.metrics={...row.metrics,[key]:n};}row[key]=value;}
  row.updatedAt=at;row.mutationId=id;return{key:'sheetTableData',data:table};
 }
 fail('不支持的外链库操作');
}
export function libraryMutationSatisfied(documents,operation){
 if(operation.type==='add_browser_url'){try{return Object.entries(libraryMutation(documents,operation).updates).every(([key,value])=>jsonValueEqual(documents[key],value));}catch{return false;}}
 if(['form_learning','form_knowledge'].includes(operation.type))return formKnowledgeSatisfied(documents,operation);
 if(operation.type==='recover_local')return jsonValueEqual(documents[operation.key],recoveryDocument(documents,operation.key,operation.data));
 if(operation.type==='set_deleted')return(documents.deletedSubmissionKeys||[]).includes(catalogKeyOf(operation.url));
 if(operation.type==='remove_queue'){const key=catalogKeyOf(operation.url),domain=globalThis.ExtLinkQueue.extractDomain(operation.url);return[key,domain].every(k=>documents.siteAnnotations?.[k]?.statuses?.length===1&&documents.siteAnnotations[k].statuses[0]==='deleted'&&(!operation.note||documents.siteAnnotations[k].note===operation.note));}
 if(operation.type==='clear_annotation'){const key=catalogKeyOf(operation.url),domain=globalThis.ExtLinkQueue.extractDomain(operation.url);return[key,domain].every(k=>!documents.siteAnnotations?.[k]||Object.keys(documents.siteAnnotations[k]).every(field=>['url','domain','formKnowledge'].includes(field)));}
 if(operation.type==='pin'){try{return documents.urlList===libraryMutation(documents,operation).data;}catch{return false;}}
 if(operation.type==='clear_deleted')return !(documents.deletedSubmissionKeys||[]).includes(catalogKeyOf(operation.url));
 if(operation.type==='submify_refs'){const rows=new Map();for(const row of documents.sheetTableData?.entries||[]){const key=storedKey(row);if(key&&!rows.has(key))rows.set(key,row);}return operation.items.every(item=>!item.id||(rows.get(keyOf(item.link||item.url))?.sourceRefs||[]).map(String).includes(String(item.id)));}
 if(operation.type==='submify_import'){const table=documents.sheetTableData;if(table?.snapshotMeta?.lastExternalImport?.importedAt!==operation.at||table.snapshotMeta.lastExternalImport.sourceTotal!==operation.items.length)return false;return operation.items.every(item=>(table.entries||[]).some(row=>storedKey(row)===keyOf(item.link||item.url)&&(!item.id||String(row.sourceId||'')===String(item.id)||(row.sourceRefs||[]).map(String).includes(String(item.id)))));}
 if(operation.type==='submify_gates')return operation.gates.every(g=>{const a=documents.siteAnnotations?.[keyOf(g.url)];return a?.library?.enabled===false&&a?.importGate?.importId===operation.id;});
 if(operation.type==='monitor_result')return documents.linkMonitorResults?.[operation.recordKey]?.monitorJobId===operation.jobId&&Object.entries(operation.result).every(([k,v])=>jsonValueEqual(documents.linkMonitorResults[operation.recordKey][k],v));
 if(operation.type==='monitor_publication')return documents.submissionRecords?.[operation.recordKey]?.status==='success'&&documents.submissionRecords[operation.recordKey].publicationStatus==='published';
 if(operation.type==='domain_metrics')return Object.keys(documents.domainMetricsCache||{}).length<=domainMetricsLimit&&operation.results.every(row=>Object.entries(row).every(([k,v])=>jsonValueEqual(documents.domainMetricsCache?.[row.domain]?.[k],v)));
 if(operation.type==='backup_prepared_key'){try{return jsonValueEqual(documents[operation.key],applyPreparedBackupKey(documents,operation));}catch{return false;}}
 if(['backup_merge','backup_key_merge'].includes(operation.type)){try{return jsonValueEqual(documents[operation.key],mergeApplicationBackup(documents,operation.backup,{prepareProfiles:false})[operation.key]);}catch{return false;}}
 if(operation.type==='timeline')return originalTimelineSatisfied(documents,operation);
 // Incremental blacklist edits are not idempotent in the original function:
 // existing wildcard prefixes normalize before new rules are added. The outbox
 // must confirm their frozen base/result rather than apply them a second time.
 if(operation.type==='settings'){if(operation.key==='domainBlacklist'&&operation.value&&typeof operation.value==='object'&&!Array.isArray(operation.value)&&operation.value.replace!==true)return false;try{return jsonValueEqual(documents[operation.key],libraryMutation(documents,operation).data);}catch{return false;}}
 if(operation.type==='create'){const row=documents.sheetTableData?.entries?.find(r=>storedKey(r)===keyOf(operation.url));return !!row&&Object.entries(operation.fields||{}).every(([k,v])=>row[k]===v);}
 if(operation.type==='import'){const known=new Set((documents.sheetTableData?.entries||[]).map(storedKey));return operation.urls.every(url=>known.has(keyOf(url)));}
 const key=['preferences','mark','automatic_mark'].includes(operation.type)?catalogKeyOf(operation.url):keyOf(operation.url);
 if(operation.type==='automatic_mark'){
  const annotation=documents.siteAnnotations?.[key],queue=globalThis.ExtLinkQueue,domain=queue.extractDomain(operation.url),observation=annotation?.lastAutomaticObservation;
  if(!jsonValueEqual(documents.siteAnnotations?.[domain],annotation))return false;
  if(observation?.mutationId===operation.id)return observation.status===operation.status&&jsonValueEqual(observation.statuses,[operation.status])&&observation.note===operation.note&&observation.updatedAt===operation.at;
  return annotation?.auto===true&&annotation.mutationId===operation.id&&annotation.status===queue.primaryAnnotationStatus([operation.status])&&jsonValueEqual(annotation.statuses,[operation.status])&&annotation.updatedAt===operation.at&&(!operation.note||annotation.note===operation.note)&&((documents.deletedSubmissionKeys||[]).includes(key)===(operation.status==='deleted'));
 }
 if(operation.type==='preferences'){const annotation=documents.siteAnnotations?.[key],library=annotation?.library,domain=globalThis.ExtLinkQueue.extractDomain(operation.url),classifier=globalThis.ExtLinkLibraryClassifier;return !!library&&annotation.url===operation.url&&annotation.domain===domain&&(Object.hasOwn(library,'groups')||jsonValueEqual(documents.siteAnnotations?.[domain],annotation))&&Object.entries(operation.preferences).every(([k,v])=>jsonValueEqual(library[k],k==='groups'?classifier.normalizeLibraryGroups(v):k==='profileIds'?classifier.normalizeProfileIds(v):v));}
 if(operation.type==='mark'){const annotation=documents.siteAnnotations?.[key],queue=globalThis.ExtLinkQueue,domain=queue.extractDomain(operation.url),statuses=queue.normalizeAnnotationStatuses(operation.statuses??[operation.status]);return annotation?.auto===false&&annotation.url===operation.url&&annotation.domain===domain&&annotation.status===queue.primaryAnnotationStatus(statuses)&&jsonValueEqual(annotation.statuses,statuses)&&jsonValueEqual(documents.siteAnnotations?.[domain],annotation)&&(!operation.note||annotation.note===String(operation.note).slice(0,10000));}
 if(operation.type==='edit'){const row=documents.sheetTableData?.entries.find(r=>storedKey(r)===key);return !!row&&Object.entries(operation.fields||{}).every(([key,value])=>row[key]===value);}
 return false;
}

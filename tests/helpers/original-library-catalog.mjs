import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import '../../core/application-model.mjs';
// Keep the reference independent of subsequent extension changes: migration
// parity is measured against the last commit before the first refactor.
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
// A caller may freeze time for both implementations. Preserve that same clock
// across the reference VM rather than giving seeded profiles a different time.
const referenceDate=new Proxy(Date,{construct(_target,args){return Reflect.construct(globalThis.Date,args);},get(_target,key){return globalThis.Date[key];}});
const libraryReference=vm.createContext({self:{},URL,structuredClone,Date:referenceDate});
for(const name of ['profiles','queue','submission-timeline','opportunity-score','library-classifier','library-groups'])vm.runInContext(execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/lib/'+name+'.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),libraryReference);
export const originalLibraryGlobals=libraryReference.self;
export function originalTimelineWithDateParser(parse){
 const DateWithParser=new Proxy(referenceDate,{get(target,key){return key==='parse'?parse:Reflect.get(target,key);}}),context=vm.createContext({self:{},URL,Date:DateWithParser});
 vm.runInContext(execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/lib/submission-timeline.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),context);
 return context.self.ExtLinkSubmissionTimeline;
}
const destinationHelpers=source.slice(source.indexOf('const DISPLAY_HOST_DESTINATIONS'),source.indexOf('function expandSubmissionRecordsForQueue'));
const catalog=source.slice(source.indexOf('async function getLibraryManagerStateUnlocked('),source.indexOf('function applyTimelinePublicationUpgrade('));
const schema=source.slice(source.indexOf('async function ensureSubmissionSchema('),source.indexOf('function scopeDestinationGroupsByLibraryCategory('));
const seedProfiles=source.slice(source.indexOf('async function ensureProfilesFromTable('),source.indexOf('async function ensureSubmissionSchema('));
const batchLibraryReference=vm.createContext({self:{}});
vm.runInContext(execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/lib/url-library.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),batchLibraryReference);
export const originalBuiltinUrls=[...batchLibraryReference.self.ExtLinkUrlLibrary];
function originalFunction(name){const found=source.match(new RegExp('^(?:async )?function '+name+'\\([^]*?^\\}','m'));if(!found)throw Error('Original library function missing '+name);return found[0];}
export async function originalLibraryBatchQueue(snapshot,input={}){
 const documents=structuredClone(snapshot.documents),table=documents.sheetTableData||{entries:[]},self={...originalLibraryGlobals,ExtLinkUrlLibrary:batchLibraryReference.self.ExtLinkUrlLibrary};
 const context=vm.createContext({self,URL,Date:referenceDate,SUBMISSION_SCHEMA_VERSION:self.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION,chrome:{storage:{local:{async get(keys){return Object.fromEntries(keys.filter(key=>Object.hasOwn(documents,key)).map(key=>[key,structuredClone(documents[key])]));},async set(values){Object.assign(documents,structuredClone(values));}}}},loadTableLibrary:async()=>structuredClone(table),applySubmissionLedgerCloudPull:async()=>({}),options:{selectedProfileIds:input.profileIds,category:input.category,group:input.group}});
 const functions=['expandSubmissionRecordsForQueue','scopeDestinationGroupsByLibraryCategory','scopeDestinationGroupsByLibraryGroup','normalizeTargetFilters','loadPendingSubmissionTasks'].map(originalFunction).join('\n');
 return structuredClone(await vm.runInContext(destinationHelpers+'\n'+seedProfiles+'\n'+schema+'\n'+functions+'\nloadPendingSubmissionTasks(options)',context));
}
// Execute the frozen request handler and real original candidate loader. The
// fill callback records the request only; browser filling is verified separately.
export async function originalAutoVisitRequest(snapshot,{url,activeTabId=9,flag=true,beforeTimer={},parkedTasks=[],unattended=false,activeTask=false,detection={},guard={}}={}){
 const documents=structuredClone(snapshot.documents),pending=await originalLibraryBatchQueue(snapshot),fills=[],updates=[],callbacks=[],current={url,activeTabId};
 if(flag!==undefined)documents.autoFillOnVisit=flag;
 const context=vm.createContext({URL,self:originalLibraryGlobals,sidePanelOpen:true,state:{activeTabs:new Map(activeTask?[[9,{}]]:[]),tasks:parkedTasks,parkedTaskIds:new Set(parkedTasks.map(task=>task.id))},autoFillInProgress:new Set(),autoFillTimers:new Map(),AUTO_FILL_DEBOUNCE_MS:600,
  unattendedEnabled:()=>unattended,setTimeout:callback=>{callbacks.push(callback);return callbacks.length;},clearTimeout:()=>{},log:()=>{},
  chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(values){Object.assign(documents,structuredClone(values));}}},tabs:{async query(){return[{id:current.activeTabId}];},async get(){return{id:9,url:current.url};},async create(){throw Error('Frozen visit request must not open a new tab');}}},
  loadPendingSubmissionTasks:async()=>structuredClone(pending),broadcastAutoFillUpdate:value=>updates.push(structuredClone(value)),sendTabMessage:async(_id,message)=>message.action==='detectPage'?{platform:'directory',operable:true,formFieldCount:4,...detection}:guard,
  handleSidepanelFill:async input=>{fills.push(structuredClone(input));return{ok:true,filledCount:0};},advanceSubmissionQueue:async()=>{throw Error('Frozen fill-only request must not advance');}});
 vm.runInContext(destinationHelpers+'\n'+['isSidepanelSender','isParkedUnattendedTarget','handleRequestAutoFill'].map(originalFunction).join('\n'),context);
 await context.handleRequestAutoFill({fromSidepanel:true,tabId:9,url},{});
 Object.assign(current,beforeTimer);if(beforeTimer.activeSiteId)documents.activeSiteId=beforeTimer.activeSiteId;
 for(const callback of callbacks)await callback();
 return{fills,updates,timers:callbacks.length,pending,documents};
}
export async function originalNavigationState(snapshot,{input={},cursor={},advance=false}={}){
 const queue=await originalLibraryBatchQueue(snapshot,{profileIds:advance?undefined:input.selectedSiteIds}),documents={submissionQueueIndex:cursor.index??0,submissionQueueKey:cursor.key||''},opened=[];
 const context=vm.createContext({input,self:{...originalLibraryGlobals},loadPendingSubmissionTasks:async()=>structuredClone(queue),chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(values){Object.assign(documents,structuredClone(values));}}},tabs:{async query(){return[{id:77}];},async update(id,options){opened.push({id,...options});}}}});
 vm.runInContext(execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/lib/scheduler.js'],{encoding:'utf8'}),context);
 const functions=['getSubmissionQueueState','toSubmissionGroupSummary','advanceSubmissionQueue'].map(originalFunction).join('\n');
 const result=await vm.runInContext(functions+'\n'+(advance?'advanceSubmissionQueue':'getSubmissionQueueState')+'(input)',context);
 return{result:structuredClone(result),cursor:{index:documents.submissionQueueIndex,key:documents.submissionQueueKey},opened};
}
export async function originalProfileSource(initial){
 const documents=structuredClone(initial),context=vm.createContext({URL,self:{ExtLinkProfiles:originalLibraryGlobals.ExtLinkProfiles},chrome:{storage:{local:{async set(values){Object.assign(documents,structuredClone(values));}}}},initial:documents});
 const result=await vm.runInContext(seedProfiles+'\nensureProfilesFromTable(initial.sheetTableData,initial.siteProfiles,initial.activeSiteId,initial.selectedSiteIds)',context);return{result:structuredClone(result),documents};
}
const preferences=source.slice(source.indexOf('async function updateLibraryPreferences('),source.indexOf('async function quickOpenLibraryUrls('));
const quickOpen=source.slice(source.indexOf('async function quickOpenLibraryUrls('),source.indexOf('async function getLibraryManagerState('));
export async function originalLibraryAction(initial,type,input){
 const specs={add:['async function addToUrlList(','async function removeFromSubmissionQueue(','addToUrlList'],mark:['async function writeSubmissionSiteAnnotation(','async function listSiteAnnotations(','writeSubmissionSiteAnnotation'],clear:['async function removeSiteAnnotation(','async function advanceSubmissionQueue(','removeSiteAnnotation'],pin:['async function pinLibraryUrl(','async function exportSubmissionData(','pinLibraryUrl']},[start,end,name]=specs[type],body=source.slice(source.indexOf(start),source.indexOf(end)),documents=structuredClone(initial),context=vm.createContext({URL,input,self:{ExtLinkQueue:originalLibraryGlobals.ExtLinkQueue},chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(values){Object.assign(documents,structuredClone(values));}}}}});
 const result=await vm.runInContext(destinationHelpers+'\n'+body+'\n'+name+'(input)',context);return{result:structuredClone(result),documents};
}
export async function originalLibraryQuickOpen(snapshot,input){
 const library=await originalLibraryCatalog(snapshot),opened=[],context=vm.createContext({URL,input,setTimeout,self:{ExtLinkQueue:originalLibraryGlobals.ExtLinkQueue},getLibraryManagerState:async()=>library,chrome:{tabs:{async create(options){opened.push(options.url);return{id:opened.length};}}}});
 await vm.runInContext(destinationHelpers+'\n'+quickOpen+'\nquickOpenLibraryUrls(input)',context);
 return opened;
}
export async function originalLibraryPreferences(initial,input){
 const documents=structuredClone(initial),context=vm.createContext({URL,input,chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(values){Object.assign(documents,structuredClone(values));}}}},self:{ExtLinkQueue:originalLibraryGlobals.ExtLinkQueue,ExtLinkLibraryClassifier:originalLibraryGlobals.ExtLinkLibraryClassifier},runSiteAnnotationWrite:operation=>operation()});
 const result=await vm.runInContext(destinationHelpers+'\n'+preferences+'\nupdateLibraryPreferences(input)',context);
 return{result:structuredClone(result),documents};
}
export async function originalLibraryCatalog(snapshot,{seedOriginalProfiles=false}={}){
 const documents=structuredClone(snapshot.documents),table=documents.sheetTableData||{entries:[]};
 const context=vm.createContext({URL,structuredClone,SUBMISSION_SCHEMA_VERSION:originalLibraryGlobals.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION,chrome:{storage:{local:{async get(keys){return Object.fromEntries(keys.filter(k=>k in documents).map(k=>[k,structuredClone(documents[k])]));},async set(values){Object.assign(documents,structuredClone(values));}}}},self:{ExtLinkProfiles:originalLibraryGlobals.ExtLinkProfiles,ExtLinkQueue:originalLibraryGlobals.ExtLinkQueue,ExtLinkSubmissionTimeline:originalLibraryGlobals.ExtLinkSubmissionTimeline,ExtLinkOpportunityScore:originalLibraryGlobals.ExtLinkOpportunityScore,ExtLinkLibraryClassifier:originalLibraryGlobals.ExtLinkLibraryClassifier,ExtLinkLibraryGroups:originalLibraryGlobals.ExtLinkLibraryGroups,ExtLinkUrlLibrary:[]},applySubmissionLedgerCloudPull:async()=>({}),loadTableLibrary:async()=>structuredClone(table),ensureProfilesFromTable:async()=>({profiles:structuredClone(documents.siteProfiles||{}),idRemap:{}})});
 return structuredClone(await vm.runInContext(destinationHelpers+'\n'+(seedOriginalProfiles?seedProfiles+'\n':'')+schema+'\n'+catalog+'\ngetLibraryManagerStateUnlocked()',context));
}

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
export async function originalProfileSource(initial){
 const documents=structuredClone(initial),context=vm.createContext({URL,self:{ExtLinkProfiles:originalLibraryGlobals.ExtLinkProfiles},chrome:{storage:{local:{async set(values){Object.assign(documents,structuredClone(values));}}}},initial:documents});
 const result=await vm.runInContext(seedProfiles+'\nensureProfilesFromTable(initial.sheetTableData,initial.siteProfiles,initial.activeSiteId,initial.selectedSiteIds)',context);return{result:structuredClone(result),documents};
}
const preferences=source.slice(source.indexOf('async function updateLibraryPreferences('),source.indexOf('async function quickOpenLibraryUrls('));
const quickOpen=source.slice(source.indexOf('async function quickOpenLibraryUrls('),source.indexOf('async function getLibraryManagerState('));
export async function originalLibraryAction(initial,type,input){
 const specs={mark:['async function writeSubmissionSiteAnnotation(','async function listSiteAnnotations(','writeSubmissionSiteAnnotation'],clear:['async function removeSiteAnnotation(','async function advanceSubmissionQueue(','removeSiteAnnotation'],pin:['async function pinLibraryUrl(','async function exportSubmissionData(','pinLibraryUrl']},[start,end,name]=specs[type],body=source.slice(source.indexOf(start),source.indexOf(end)),documents=structuredClone(initial),context=vm.createContext({URL,input,self:{ExtLinkQueue:originalLibraryGlobals.ExtLinkQueue},chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(values){Object.assign(documents,structuredClone(values));}}}}});
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

import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import '../../core/application-model.mjs';
const source=readFileSync(new URL('../../extension/background.js',import.meta.url),'utf8');
const destinationHelpers=source.slice(source.indexOf('const DISPLAY_HOST_DESTINATIONS'),source.indexOf('function expandSubmissionRecordsForQueue'));
const catalog=source.slice(source.indexOf('async function getLibraryManagerStateUnlocked('),source.indexOf('function applyTimelinePublicationUpgrade('));
const schema=source.slice(source.indexOf('async function ensureSubmissionSchema('),source.indexOf('function scopeDestinationGroupsByLibraryCategory('));
const seedProfiles=source.slice(source.indexOf('async function ensureProfilesFromTable('),source.indexOf('async function ensureSubmissionSchema('));
export async function originalProfileSource(initial){
 const documents=structuredClone(initial),context=vm.createContext({URL,self:{ExtLinkProfiles:globalThis.ExtLinkProfiles},chrome:{storage:{local:{async set(values){Object.assign(documents,structuredClone(values));}}}},initial:documents});
 const result=await vm.runInContext(seedProfiles+'\nensureProfilesFromTable(initial.sheetTableData,initial.siteProfiles,initial.activeSiteId,initial.selectedSiteIds)',context);return{result:structuredClone(result),documents};
}
const preferences=source.slice(source.indexOf('async function updateLibraryPreferences('),source.indexOf('async function quickOpenLibraryUrls('));
const quickOpen=source.slice(source.indexOf('async function quickOpenLibraryUrls('),source.indexOf('async function getLibraryManagerState('));
export async function originalLibraryAction(initial,type,input){
 const specs={mark:['async function writeSubmissionSiteAnnotation(','async function listSiteAnnotations(','writeSubmissionSiteAnnotation'],clear:['async function removeSiteAnnotation(','async function advanceSubmissionQueue(','removeSiteAnnotation'],pin:['async function pinLibraryUrl(','async function exportSubmissionData(','pinLibraryUrl']},[start,end,name]=specs[type],body=source.slice(source.indexOf(start),source.indexOf(end)),documents=structuredClone(initial),context=vm.createContext({URL,input,self:{ExtLinkQueue:globalThis.ExtLinkQueue},chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(values){Object.assign(documents,structuredClone(values));}}}}});
 const result=await vm.runInContext(destinationHelpers+'\n'+body+'\n'+name+'(input)',context);return{result:structuredClone(result),documents};
}
export async function originalLibraryQuickOpen(snapshot,input){
 const library=await originalLibraryCatalog(snapshot),opened=[],context=vm.createContext({URL,input,setTimeout,self:{ExtLinkQueue:globalThis.ExtLinkQueue},getLibraryManagerState:async()=>library,chrome:{tabs:{async create(options){opened.push(options.url);return{id:opened.length};}}}});
 await vm.runInContext(destinationHelpers+'\n'+quickOpen+'\nquickOpenLibraryUrls(input)',context);
 return opened;
}
export async function originalLibraryPreferences(initial,input){
 const documents=structuredClone(initial),context=vm.createContext({URL,input,chrome:{storage:{local:{async get(){return structuredClone(documents);},async set(values){Object.assign(documents,structuredClone(values));}}}},self:{ExtLinkQueue:globalThis.ExtLinkQueue,ExtLinkLibraryClassifier:globalThis.ExtLinkLibraryClassifier},runSiteAnnotationWrite:operation=>operation()});
 const result=await vm.runInContext(destinationHelpers+'\n'+preferences+'\nupdateLibraryPreferences(input)',context);
 return{result:structuredClone(result),documents};
}
export async function originalLibraryCatalog(snapshot,{seedOriginalProfiles=false}={}){
 const documents=structuredClone(snapshot.documents),table=documents.sheetTableData||{entries:[]};
 const context=vm.createContext({URL,structuredClone,SUBMISSION_SCHEMA_VERSION:globalThis.ExtLinkQueue.SUBMISSION_SCHEMA_VERSION,chrome:{storage:{local:{async get(keys){return Object.fromEntries(keys.filter(k=>k in documents).map(k=>[k,structuredClone(documents[k])]));},async set(values){Object.assign(documents,structuredClone(values));}}}},self:{ExtLinkProfiles:globalThis.ExtLinkProfiles,ExtLinkQueue:globalThis.ExtLinkQueue,ExtLinkSubmissionTimeline:globalThis.ExtLinkSubmissionTimeline,ExtLinkOpportunityScore:globalThis.ExtLinkOpportunityScore,ExtLinkLibraryClassifier:globalThis.ExtLinkLibraryClassifier,ExtLinkLibraryGroups:globalThis.ExtLinkLibraryGroups,ExtLinkUrlLibrary:[]},applySubmissionLedgerCloudPull:async()=>({}),loadTableLibrary:async()=>structuredClone(table),ensureProfilesFromTable:async()=>({profiles:structuredClone(documents.siteProfiles||{}),idRemap:{}})});
 return structuredClone(await vm.runInContext(destinationHelpers+'\n'+(seedOriginalProfiles?seedProfiles+'\n':'')+schema+'\n'+catalog+'\ngetLibraryManagerStateUnlocked()',context));
}

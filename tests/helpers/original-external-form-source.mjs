import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const body=source.slice(source.indexOf('function normalizeSourceHost'),source.indexOf('async function armManualSubmissionWatch'));
export function originalExternalFormSource({tabs={},stored={},now=Date.now()}={}){
 const context=vm.createContext({URL,Date:class extends Date{static now(){return now;}},chrome:{tabs:{async get(id){if(!tabs[id])throw Error('tab closed');return tabs[id];}},storage:{session:{async get(key){return{[key]:stored[key]};},async set(value){Object.assign(stored,value);}}}}});
 vm.runInContext(body,context);
 return{destination:(page,referrer)=>JSON.parse(JSON.stringify(context.trustedExternalFormDestination(page,referrer))),standalone:context.isStandaloneExternalFormUrl,capture:context.captureTrustedExternalFormOpen,async resolve(...args){return JSON.parse(JSON.stringify(await context.trustedExternalFormSourceForTab(...args)));},stored};
}

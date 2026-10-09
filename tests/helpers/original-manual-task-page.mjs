import {execFileSync} from 'node:child_process';
import vm from 'node:vm';

const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/sidepanel.js'],{encoding:'utf8'});
const start=source.indexOf('  function renderManualTasks() {');
const body=source.slice(start,source.indexOf('\n  chrome.runtime.onMessage.addListener',start));
export async function originalManualTaskPage(task,{stopped=false,label,closed=false}={}){
 const nodes=[],calls=[];
 const node=()=>{const value={children:[],events:{},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},addEventListener(type,callback){this.events[type]=callback;}};nodes.push(value);return value;};
 const list=node();
 const context=vm.createContext({parkedTasks:[structuredClone(task)],batchStatus:stopped?'stopped':'running',URL,ownerWindowIdPromise:Promise.resolve(73),
  document:{createElement:node},$:id=>id==='manualTaskList'?list:null,
  showToast:(message,error)=>calls.push({kind:'toast',message,error:!!error}),syncTasksFromBackground:()=>calls.push({kind:'refresh'}),
  chrome:{tabs:{async update(id,options){if(closed)throw Error('closed');calls.push({kind:'focus',id,...options});},async create(options){calls.push({kind:'create',...options});}},runtime:{async sendMessage(input){calls.push({kind:'message',...input});}}}});
 vm.runInContext(body+'\nrenderManualTasks()',context);
 const buttons=nodes.filter(n=>n.events.click);
 if(label){const button=buttons.find(n=>n.textContent===label);if(!button)throw Error('Original button missing: '+label);await button.events.click();}
 return{labels:buttons.map(n=>n.textContent),calls:structuredClone(calls)};
}

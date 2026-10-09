import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const baseline='bd916b2944a577b160a6afcb8a7d73d263044c0c';
const read=path=>execFileSync('git',['show',baseline+':'+path],{encoding:'utf8',maxBuffer:4*1024*1024});
const source=read('extension/settings.js'),functions=['annotationStatuses','createLibraryGroupPanel'].map(name=>{const match=source.match(new RegExp('^  function '+name+'\\([^]*?^  \\}','m'));if(!match)throw Error('Missing original '+name);return match[0];}).join('\n');
const modules=['queue','library-classifier','library-groups'].map(name=>read('extension/lib/'+name+'.js'));
export function originalLibraryGroupPanel(item){
 const context=vm.createContext({URL,console,document:{createElement:tag=>({tag,children:[],attributes:{},disabled:false,title:'',append(...nodes){this.children.push(...nodes);},setAttribute(key,value){this.attributes[key]=value;},addEventListener(){}})},toggleLibraryGroup(){},alert(){}});context.self=context;
 for(const source of modules)vm.runInContext(source,context);
 context.Q=context.ExtLinkQueue;context.LibraryGroups=context.ExtLinkLibraryGroups;vm.runInContext(functions,context);
 const panel=context.createLibraryGroupPanel(structuredClone(item));return panel.children.at(-1).children.map(button=>({label:button.textContent,selected:button.attributes['aria-pressed']==='true',disabled:button.disabled,title:button.title}));
}

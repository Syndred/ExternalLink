import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/settings.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const extract=name=>{const match=source.match(new RegExp('^  function '+name+'\\([^]*?^  \\}','m'));if(!match)throw Error('Missing original editor function '+name);return match[0];};
export function originalTimelineEditor(event=null,values={}){
 const field=value=>({value,options:[],append(option){this.options.push(option);}}),form={profile:field(''),type:field(''),occurredAt:field(''),url:field(''),note:field(''),submit:{},cancel:{}},context=vm.createContext({Date,Array,document:{createElement:()=>({})},activityLabel:type=>type,siteProfiles:{p:{name:'原产品'}}});
 vm.runInContext(['toDatetimeLocalValue','fillTimelineForm','timelinePayload'].map(extract).join('\n'),context);
 context.fillTimelineForm(form,event);for(const[key,value]of Object.entries(values))form[key].value=value;
 const payload=context.timelinePayload({key:'target.fixture.invalid/form',url:'https://target.fixture.invalid/form'},form);
 return{values:Object.fromEntries(['profile','type','occurredAt','url','note'].map(key=>[key,form[key].value])),cancelHidden:form.cancel.hidden,payload:structuredClone(payload)};
}
export async function originalTimelineSaveOutcome(mode){
 let form;const calls=[],alerts=[],context=vm.createContext({Date,Array,Set,document:{createElement:()=>({value:'',options:[],listeners:{},append(...nodes){this.options.push(...nodes);},setAttribute(){},addEventListener(name,handler){this.listeners[name]=handler;}})},activityLabel:value=>value,siteProfiles:{p:{name:'原产品'}},orderedSiteIds:()=>['p'],TIMELINE_TYPES:[['submitted','已提交'],['note','笔记']],editingTimelineEventId:'old-event',nonProfileEditorRevision:1,nonProfileDirtyScopes:new Set(['timeline']),alert:message=>alerts.push(message),loadLibrary:async()=>calls.push('render'),chrome:{runtime:{async sendMessage(input){calls.push(structuredClone(input));if(mode==='changed'){form.timelineFields.note.value='继续输入';context.nonProfileEditorRevision++;}return mode==='failed'?{ok:false,error:'Fixture failed'}:{ok:true};}}}});
 vm.runInContext(['toDatetimeLocalValue','fillTimelineForm','timelinePayload','clearNonProfileEditorDirty','createTimelineForm'].map(extract).join('\n'),context);
 form=context.createTimelineForm({key:'target.fixture.invalid/form',url:'https://target.fixture.invalid/form'});form.timelineFields.note.value='已提交草稿';
 if(mode==='cancel')form.timelineFields.cancel.listeners.click();else await form.listeners.submit({preventDefault(){}});
 return{editingEventId:context.editingTimelineEventId,dirty:context.nonProfileDirtyScopes.has('timeline'),note:form.timelineFields.note.value,disabled:form.timelineFields.submit.disabled===true,calls,alerts};
}

import './sidepanel-model.js';
import './unattended.js';
export const originalUnattended=globalThis.ExtLinkUnattended;
export function originalBatchConfig(documents={},options={}){
 const preferences=documents.unattendedPreferences||{};
 return globalThis.ExtLinkSidepanel.buildBatchConfig({concurrency:documents.cfgConcurrency,pingIndex:documents.cfgPingIndex,...{unattended:preferences.enabled===true,unattendedMaxHours:preferences.hours||8,unattendedMaxTasks:preferences.tasks||100,unattendedMaxManualTabs:preferences.manualTabs||20},...options});
}
export function validateBatchPreferenceValue(key,value){
 if(key==='cfgConcurrency'){
  if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value)||typeof value==='string'&&value.length>10000)throw Object.assign(Error('并发设置格式无效'),{status:400});
 }else if(key==='unattendedPreferences'){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['enabled','hours','tasks','manualTabs'].includes(key))||Object.hasOwn(value,'enabled')&&typeof value.enabled!=='boolean'||['hours','tasks','manualTabs'].some(key=>Object.hasOwn(value,key)&&(!['number','string'].includes(typeof value[key])||typeof value[key]==='number'&&!Number.isFinite(value[key])||typeof value[key]==='string'&&value[key].length>10000)))throw Object.assign(Error('无人值守设置格式无效'),{status:400});
 }
}
export function batchPreferencePatch(value){
 validateBatchPreferenceValue('unattendedPreferences',value);const patch={...value};
 for(const [key,max,fallback]of [['hours',12,8],['tasks',500,100],['manualTabs',100,20]])if(Object.hasOwn(value,key))patch[key]=Math.max(1,Math.min(max,Number(value[key])||fallback));
 return patch;
}

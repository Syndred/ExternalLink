import './profiles.js';
import './queue.js';
const P=globalThis.ExtLinkProfiles,Q=globalThis.ExtLinkQueue;
const unsafe=key=>['__proto__','prototype','constructor'].includes(key);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const text=(value,limit=4000)=>typeof value==='string'&&value.length<=limit;
export function fillLearningMappings(value={}){
 if(!object(value)||Object.keys(value).length>500)throw Error('字段学习记录无效');
 const result={};for(const [key,item]of Object.entries(value)){
  if(!key||unsafe(key)||key.length>4000||!object(item)||Object.keys(item).some(unsafe)||!text(item.profileKey,200)||!item.profileKey||unsafe(item.profileKey)||!text(item.label||'')||!text(item.hint||'')||!text(item.value||'',100000))throw Error('字段学习记录无效');
  if(/password|secret|token|api.?key|captcha|\botp\b|verification|consent|privacy|terms|agree/i.test([key,item.profileKey,item.label,item.hint].join(' ')))continue;
  result[key]={profileKey:item.profileKey,value:item.value||'',label:item.label||'',hint:item.hint||''};
 }return result;
}
export function reusableDestinationMappings(value={}){
 const safe={};for(const [key,item]of Object.entries(object(value)?value:{})){try{Object.assign(safe,fillLearningMappings({[key]:item}));}catch{}}
 return Object.fromEntries(Object.entries(safe).filter(([,item])=>(item.label||item.hint)&&!['select','category'].includes(item.profileKey)).map(([key,item])=>[key,{profileKey:item.profileKey,label:item.label,hint:item.hint,shared:true}]));
}
export function destinationFormSchema(snapshot){
 if(!snapshot)return null;let url;try{url=new URL(snapshot.url);}catch{throw Error('表单记忆网址无效');}if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw Error('表单记忆网址无效');
 if(!Array.isArray(snapshot.forms||[])||!Array.isArray(snapshot.fields||[])||(snapshot.forms||[]).length>100||(snapshot.fields||[]).length>500)throw Error('表单记忆结构无效');
 const forms=(snapshot.forms||[]).map(form=>{if(!object(form)||!text(form.method||'',100))throw Error('表单记忆结构无效');return{method:form.method||''};});
 const fields=(snapshot.fields||[]).map(field=>{if(!object(field)||['selector','name','id','type','label'].some(key=>field[key]!==undefined&&!text(field[key]))||!Array.isArray(field.options||[])||(field.options||[]).length>500)throw Error('表单记忆字段无效');
  const options=(field.options||[]).map(option=>{if(typeof option==='string'){if(!text(option))throw Error('表单记忆选项无效');return option;}if(!object(option)||['value','label','text'].some(key=>option[key]!==undefined&&!text(option[key]))||option.disabled!==undefined&&typeof option.disabled!=='boolean')throw Error('表单记忆选项无效');return Object.fromEntries(['value','label','text','disabled'].filter(key=>option[key]!==undefined).map(key=>[key,option[key]]));});
  return{...Object.fromEntries(['selector','name','id','type','label'].filter(key=>field[key]!==undefined).map(key=>[key,field[key]])),required:field.required===true,options};});
 return{url:url.origin+url.pathname,forms,fields};
}
export function applyDestinationFormKnowledge(documents,config,url){
 const host=new URL(url).hostname,key=Q.normalizeDestinationKey(url),annotation=documents.siteAnnotations?.[key]||documents.siteAnnotations?.[Q.extractDomain(url)];
 const legacy=Object.assign({},...Object.values(documents.siteProfiles||{}).map(profile=>reusableDestinationMappings(profile.learnedFieldMappings?.[host]))),mappings={...legacy,...reusableDestinationMappings(annotation?.formKnowledge?.mappings)};
 const result={...config};delete result.destinationFormSchema;delete result.destinationFormStages;
 if(annotation?.formKnowledge?.schema)result.destinationFormSchema=destinationFormSchema(annotation.formKnowledge.schema);
 if(annotation?.formKnowledge?.stages)result.destinationFormStages=annotation.formKnowledge.stages.map(destinationFormSchema);
 if(Object.keys(mappings).length)result.learnedFieldMappings={...config.learnedFieldMappings,[host]:{...mappings,...config.learnedFieldMappings?.[host]}};
 return result;
}
export function formKnowledgeMutation(documents,operation){
 const mappings=fillLearningMappings(operation.mappings),host=new URL(operation.url).hostname,key=Q.normalizeDestinationKey(operation.url),domain=Q.extractDomain(operation.url);
 if(operation.type==='form_learning'){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(operation.profileId||'')||unsafe(operation.profileId)||!Object.hasOwn(documents.siteProfiles||{},operation.profileId))throw Error('原字段学习产品身份已变化');
  const profile=documents.siteProfiles?.[operation.profileId];if(!profile||profile.archived||!object(operation.identity)||!text(operation.identity.name,200)||!operation.identity.name||!text(operation.identity.url)||!operation.identity.url||P.fillIdentityMismatch({projectKey:operation.profileId,brandName:operation.identity.name,targetDomain:operation.identity.url},profile))throw Error('原字段学习产品身份已变化');
  const expanded=P.learnProfileFieldsFromFill(profile,mappings).profile;
  return{key:'siteProfiles',data:{...documents.siteProfiles,[operation.profileId]:{...expanded,learnedFieldMappings:{...profile.learnedFieldMappings,[host]:{...profile.learnedFieldMappings?.[host],...mappings}},updatedAt:operation.at}}};
 }
 const reusable=reusableDestinationMappings(mappings),schema=destinationFormSchema(operation.schema),annotations=structuredClone(documents.siteAnnotations||{}),previous=annotations[key]||annotations[domain]||{};
 const annotation={...previous,url:previous.url||operation.url,domain,formKnowledge:{version:1,mappings:{...previous.formKnowledge?.mappings,...reusable},schema:schema||previous.formKnowledge?.schema||null,stages:schema?[...(previous.formKnowledge?.stages||[]).filter(stage=>JSON.stringify(stage)!==JSON.stringify(schema)),schema].slice(-12):previous.formKnowledge?.stages||[],updatedAt:operation.at}};
 annotations[key]=annotation;annotations[domain]=structuredClone(annotation);return{key:'siteAnnotations',data:annotations};
}
export function formKnowledgeSatisfied(documents,operation){
 try{const mappings=operation.type==='form_learning'?fillLearningMappings(operation.mappings):reusableDestinationMappings(operation.mappings),host=new URL(operation.url).hostname;
  if(operation.type==='form_learning'){formKnowledgeMutation(documents,operation);const profile=documents.siteProfiles?.[operation.profileId];return!!profile&&Object.entries(mappings).every(([key,item])=>JSON.stringify(profile.learnedFieldMappings?.[host]?.[key])===JSON.stringify(item))&&P.learnProfileFieldsFromFill(profile,mappings).added.length===0;}
  const schema=destinationFormSchema(operation.schema);return[Q.normalizeDestinationKey(operation.url),Q.extractDomain(operation.url)].every(key=>{const knowledge=documents.siteAnnotations?.[key]?.formKnowledge;return!!knowledge&&Object.entries(mappings).every(([field,item])=>JSON.stringify(knowledge.mappings?.[field])===JSON.stringify(item))&&(!schema||(knowledge.stages||[]).some(stage=>JSON.stringify(stage)===JSON.stringify(schema)));});
 }catch{return false;}
}

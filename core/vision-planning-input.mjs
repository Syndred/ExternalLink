const MAX_TEXT_CHARS = 60000;
const secretKey = /password|passphrase|secret|token|api[\s_-]*key|authorization|credential|cookie|private[\s_-]*key/i;
const mediaKey = /^(?:logoDataUrl|screenshots?|media|inlineMedia)$/i;
const productIdentity = /^(?:Name|Url|Title|Pricing|PRICING TYPE|Category|Categories|Tags Keywords\/Hashtags)$/i;
const own = (value,key) => Object.prototype.hasOwnProperty.call(value||{},key);
const list = (value,limit) => Array.isArray(value)?value.slice(0,limit):[];

function text(value,limit=1200){
 if(typeof value!=='string')return typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)?value:undefined;
 if(/^\s*data:/i.test(value))return undefined;
 let clean=value.replace(/data:[^\s<>"']+/gi,'[inline media omitted]').replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi,'[credential omitted]');
 if(/^https?:\/\/[^\s]+$/i.test(clean)){
  try{const url=new URL(clean);url.username='';url.password='';for(const key of url.searchParams.keys())if(secretKey.test(key))url.searchParams.set(key,'REDACTED');url.hash='';clean=url.href;}catch{}
 }
 return clean.slice(0,limit);
}

function safeValue(value,limit=1200,depth=0){
 if(depth>3)return undefined;
 if(typeof value==='string')return text(value,limit);
 if(typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||value===null)return value;
 if(Array.isArray(value))return value.slice(0,16).map(item=>safeValue(item,limit,depth+1)).filter(item=>item!==undefined);
 if(value&&typeof value==='object'){
  const result={};
  for(const key of Object.keys(value).slice(0,64))if(!secretKey.test(key)&&!mediaKey.test(key)&&!['__proto__','constructor','prototype'].includes(key)){
   const clean=safeValue(value[key],limit,depth+1);if(clean!==undefined)result[key]=clean;
  }
  return result;
 }
}

function pick(source,keys,limit=1200){
 const result={};for(const key of keys)if(own(source,key)){const value=safeValue(source[key],limit);if(value!==undefined)result[key]=value;}return result;
}

function valueState(value,type){
 if(value===undefined)return undefined;
 if(value&&typeof value==='object'){
  // Only the engine's value metadata belongs in planning text, never raw values.
  return pick(value,['present','kind','length','checked','selectedLabel','files','accept','multiple'],160);
 }
 return {present:Boolean(value),kind:type==='password'?'secret':'text',length:String(value||'').length};
}

function target(source,visual=false){
 const result=pick(source,['badge','type','tag','role','required','disabled','visible','visibleInScreenshot','checked','selected','expanded'],80);
 // A selector is actionable identity. Reject oversized identity rather than
 // truncating it into a different selector that the operator might use.
 if(typeof source?.selector==='string'&&source.selector.length<=600)result.selector=source.selector;
 else if(source?.selector)throw new Error('视觉规划控件标识过长，请重新观察');
 const value=valueState(source?.value,source?.type);if(value!==undefined)result.value=value;
 if(visual)result.rect=pick(source?.rect,['x','y','width','height'],0);
 return result;
}

export function visionPlanningInput(input={},snapshot=input.snapshot||{}){
 const fields=list(snapshot.fields,120),elements=list(input.elements,80),config=input.config||{};
 const projectFields={};
 for(const key of Object.keys(config.projectFields||{}))if(productIdentity.test(key)){
  const value=safeValue(config.projectFields[key],1200);if(value!==undefined)projectFields[key]=value;
 }
 const payload={
  snapshot:{...pick(snapshot,['url','title','domHash'],600),meta:pick(snapshot.meta,['platform','hasCaptcha','fieldCount','buttonCount','formCount'],80),fields:fields.map(field=>target(field))},
  elements:elements.map(element=>target(element,true)),
  task:pick(input.task,['index','domain','url','platformType','projectKey'],600),
  config:{...pick(config,['projectKey','targetDomain','brandName','email','username','pricing','tags','category','categories','launchDate','fillOnly'],1200),projectFields},
  fillOnly:input.fillOnly===true,
  step:Math.max(0,Number(input.step)||0),
  limits:{fieldCount:fields.length,elementCount:elements.length,omittedFields:Math.max(0,(snapshot.fields?.length||0)-fields.length),omittedElements:Math.max(0,(input.elements?.length||0)-elements.length)},
 };
 let size=JSON.stringify(payload).length;
 if(size>MAX_TEXT_CHARS)throw new Error('视觉规划控件和值状态超过文字预算，请缩小观察范围');
 const add=(object,key,value)=>{
  if(value===undefined||['__proto__','constructor','prototype'].includes(key))return false;
  const delta=own(object,key)?JSON.stringify(value).length-JSON.stringify(object[key]).length:JSON.stringify(key).length+1+JSON.stringify(value).length+(Object.keys(object).length?1:0);
  if(size+delta>MAX_TEXT_CHARS)return false;
  object[key]=value;size+=delta;return true;
 };
 const detail=(source,result)=>{
  for(const key of ['label','name','id','placeholder','aria','visibilityReason'])if(own(source,key))add(result,key,text(source[key],160));
  if(source.constraints)add(result,'constraints',safeValue(source.constraints,100));
  if(source.options)add(result,'options',list(source.options,16).map(option=>pick(option,['value','label','disabled'],120)));
 };
 // Give visible control meanings space before supplemental profile prose.
 for(let index=0;index<elements.length;index++)detail(elements[index],payload.elements[index]);
 for(let index=0;index<fields.length;index++)detail(fields[index],payload.snapshot.fields[index]);
 for(const key of ['buttons','widgets','forms','frames','evidenceSignals']){
  const limit={buttons:40,widgets:40,forms:8,frames:10,evidenceSignals:8}[key];
  if(!Array.isArray(snapshot[key]))continue;
  const records=list(snapshot[key],limit).map(record=>{
   if(key==='buttons'||key==='widgets')return {...target(record),...pick(record,['label','name','id','placeholder','aria','text','href','visibilityReason'],160)};
   return pick(record,['selector','id','name','action','method','fields','buttons','title','src','visible','type','text','url','matched','publicationStatus'],240);
  });
  add(payload.snapshot,key,records);
 }
 for(const key of ['anchorText','commentTemplate','targetAudience','valueProposition','useCases','sellablePoints','avoidContent','description','shortDescription','longDescription'])if(own(config,key))add(payload.config,key,safeValue(config[key],2000));
 // Preserve profile-specific text fields, while identity/pricing above remains
 // independent of object insertion order and optional description budgets.
 for(const key of Object.keys(config.projectFields||{}).filter(key=>!productIdentity.test(key)&&!secretKey.test(key)&&!mediaKey.test(key)).slice(0,80))add(projectFields,key,safeValue(config.projectFields[key],2000));
 add(payload.snapshot,'text',text(snapshot.text,6000));
 add(payload,'failure',text(input.failure,1000));
 const history=list(Array.isArray(input.history)?input.history.slice(-8):[],8).map(entry=>({
  ...pick(entry,['step','stage','status','reason','domHash'],300),
  actions:list(entry.actions,4).map(action=>pick(action,['type','selector','ok','reason','code'],160)),
  results:list(entry.results,4).map(result=>pick(result,['type','selector','ok','reason','code'],160)),
 }));
 add(payload,'history',history);
 return payload;
}

export function visionPlanningJson(input,snapshot){return JSON.stringify(visionPlanningInput(input,snapshot));}

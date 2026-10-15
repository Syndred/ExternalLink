const secretKey=/password|passphrase|secret|token|api[\s_-]*key|authorization|credential|cookie|csrf|turnstile|captcha.?response/i;
const mediaKey=/^(?:logoDataUrl|screenshots?|media|inlineMedia)$/i;

// Keep whole review evidence and actual field values. Inline image bytes and
// credentials cannot help a textual submission verdict and must not displace it.
export function reviewPlanningJson(input={},maxChars=60000){
 const clean=(value,key='',depth=0)=>{
  if(secretKey.test(key)||mediaKey.test(key))return undefined;
  if(depth>12)throw Error('表单审查结构过深，请重新观察原表单');
  if(typeof value==='string')return /^\s*data:/i.test(value)?undefined:value.replace(/data:[^\s<>"']+/gi,'[inline media omitted]');
  if(value===null||typeof value==='boolean'||typeof value==='number')return value;
  if(Array.isArray(value))return value.map(v=>clean(v,'',depth+1)).filter(v=>v!==undefined);
  if(value&&typeof value==='object'){
   const sensitiveField=value.type==='password'||secretKey.test(String(value.name||''));
   return Object.fromEntries(Object.entries(value).filter(([k])=>!['__proto__','prototype','constructor'].includes(k)).map(([k,v])=>[k,sensitiveField&&k==='value'?'[credential omitted]':clean(v,k,depth+1)]).filter(([,v])=>v!==undefined));
  }
 };
 const json=JSON.stringify(clean(input));
 if(json.length>maxChars)throw Error('表单审查证据超过文字预算，请缩小观察范围；未截断实际字段或回执');
 return json;
}

export const MAX_IMAGE_BYTES=6*1024*1024;
export const MAX_LOGO_BYTES=2*1024*1024;
export function validateMediaSize(bytes,kind){if(kind==='logo'&&bytes.length>MAX_LOGO_BYTES)throw Object.assign(new Error('产品标志图片超过 2 MB'),{status:400});return bytes;}
export const IMAGE_MIME_TYPES=Object.freeze(['image/png','image/jpeg','image/webp','image/gif','image/svg+xml']);
const invalidImage=message=>Object.assign(new Error(message),{status:400});
function svgSignature(bytes){
 let text;try{text=new TextDecoder(bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8',{fatal:true}).decode(bytes).trim();}catch{return false;}
 // Read the XML prefix without fetching DTDs or resolving entities. The bytes remain unchanged.
 while(text.startsWith('<?')||text.startsWith('<!--')||/^<!DOCTYPE\s/i.test(text)){
  let end=-1;if(text.startsWith('<?')){const at=text.indexOf('?>');if(at>=0)end=at+2;}else if(text.startsWith('<!--')){const at=text.indexOf('-->');if(at>=0)end=at+3;}else{let quote='',depth=0;for(let i=9;i<text.length;i++){const char=text[i];if(quote){if(char===quote)quote='';continue;}if(char==='"'||char==="'"){quote=char;continue;}if(char==='[')depth++;else if(char===']')depth--;else if(char==='>'&&!depth){end=i+1;break;}}}
  if(end<0)return false;text=text.slice(end).trimStart();
 }
 const root=/^<((?:[a-zA-Z_][\w.-]*:)?svg)(?=[\s/>])/.exec(text);if(!root)return false;
 let quote='',end=-1;for(let i=root[0].length;i<text.length;i++){const char=text[i];if(quote){if(char===quote)quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='>'){end=i;break;}}if(end<0)return false;
 const opening=text.slice(0,end+1),prefix=root[1].includes(':')?root[1].split(':')[0]:'',namespaceName=prefix?'xmlns:'+prefix:'xmlns';for(const match of opening.matchAll(/\b(xmlns(?::[\w.-]+)?)\s*=\s*(["'])(.*?)\2/g))if(match[1]===namespaceName&&match[3]!=='http://www.w3.org/2000/svg')return false;
 const tail=text.slice(end+1).replace(/<!--[^]*?-->/g,'').trim();if(/\/\s*>$/.test(opening))return !tail;
 return tail.endsWith('</'+root[1]+'>')||new RegExp('</'+root[1].replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\s*>$').test(tail);
}
export function validateImageBytes(bytes,mime){
 if(!IMAGE_MIME_TYPES.includes(mime))throw invalidImage('仅支持 PNG/JPEG/WEBP/GIF/SVG 图片');
 if(!bytes.length||bytes.length>MAX_IMAGE_BYTES)throw invalidImage('仅支持 6 MB 以内 PNG/JPEG/WEBP/GIF/SVG 图片');
 const png=bytes.length>=24&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v),jpeg=bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,webp=bytes.length>=16&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP',gif=bytes.length>=13&&['GIF87a','GIF89a'].includes(String.fromCharCode(...bytes.slice(0,6)))&&(bytes[6]||bytes[7])&&(bytes[8]||bytes[9]);
 if(!(mime==='image/png'?png:mime==='image/jpeg'?jpeg:mime==='image/webp'?webp:mime==='image/gif'?gif:svgSignature(bytes)))throw invalidImage('图片格式与声明不匹配');
 return bytes;
}
export function decodeImageAsset(dataUrl){
 const match=/^data:(image\/(?:png|jpeg|webp|gif|svg\+xml));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl||'');
 if(!match||match[2].length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw invalidImage('仅支持 6 MB 以内 PNG/JPEG/WEBP/GIF/SVG 图片');
 let bytes;try{bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));}catch{throw invalidImage('图片编码无效');}
 return validateImageBytes(bytes,match[1]);
}
export function profileMediaReferences(profile){
 const refs=[],seen=new Set(),add=(ref,kind)=>{if(typeof ref==='string'&&ref.startsWith('cloud-media://')&&!profile.mediaDisabled?.[kind]&&!seen.has(ref)){seen.add(ref);refs.push({ref,kind});}};
 for(const [name,ref]of Object.entries(profile.fields||{})){if(/logo/i.test(name))add(ref,'logo');else if(/featured image/i.test(name))add(ref,'featured');else if(/screenshot/i.test(name))add(ref,'screenshot'+(name.match(/\d+/)?.[0]||'1'));}
 add(profile.media?.logo,'logo');add(profile.media?.featured,'featured');for(const [i,ref]of (profile.media?.screenshots||[]).entries())add(ref,'screenshot'+(i+1));return refs;
}

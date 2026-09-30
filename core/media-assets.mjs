export const MAX_IMAGE_BYTES=6*1024*1024;
export function decodeImageAsset(dataUrl){
 const match=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl||'');
 if(!match||match[2].length>Math.ceil(MAX_IMAGE_BYTES/3)*4)throw Error('仅支持 6 MB 以内 PNG/JPEG/WEBP 图片');
 let bytes;try{bytes=Uint8Array.from(atob(match[2]),c=>c.charCodeAt(0));}catch{throw Error('图片编码无效');}
 const png=bytes.length>=24&&[137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v),jpeg=bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,webp=bytes.length>=16&&String.fromCharCode(...bytes.slice(0,4))==='RIFF'&&String.fromCharCode(...bytes.slice(8,12))==='WEBP';
 if(!bytes.length||bytes.length>MAX_IMAGE_BYTES||!(match[1]==='image/png'?png:match[1]==='image/jpeg'?jpeg:webp))throw Error('图片格式与声明不匹配');
 return bytes;
}
export function profileMediaReferences(profile){
 const refs=[],seen=new Set(),add=(ref,kind)=>{if(typeof ref==='string'&&ref.startsWith('cloud-media://')&&!profile.mediaDisabled?.[kind]&&!seen.has(ref)){seen.add(ref);refs.push({ref,kind});}};
 for(const [name,ref]of Object.entries(profile.fields||{})){if(/logo/i.test(name))add(ref,'logo');else if(/featured image/i.test(name))add(ref,'featured');else if(/screenshot/i.test(name))add(ref,'screenshot'+(name.match(/\d+/)?.[0]||'1'));}
 add(profile.media?.logo,'logo');add(profile.media?.featured,'featured');for(const [i,ref]of (profile.media?.screenshots||[]).entries())add(ref,'screenshot'+(i+1));return refs;
}

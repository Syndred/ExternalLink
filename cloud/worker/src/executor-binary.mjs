import {Buffer} from 'node:buffer';
const PREFIX='data:image/png;base64,';
const MAX_BYTES=3*1024*1024;
export function encodeBase64(bytes){return Buffer.from(bytes).toString('base64');}
export function decodePngEvidence(dataUrl){
 const invalid=message=>{throw Object.assign(new Error(message),{status:400});};
 if(typeof dataUrl!=='string'||!dataUrl.startsWith(PREFIX))invalid('证据必须是 PNG');
 const encoded=dataUrl.slice(PREFIX.length);
 if(encoded.length>Math.ceil(MAX_BYTES/3)*4)invalid('证据超过 3MB');
 const bytes=Buffer.from(encoded,'base64');
 if(!bytes.length||encodeBase64(bytes)!==encoded)invalid('证据 Base64 无效');
 if(bytes.length>MAX_BYTES)invalid('证据超过 3MB');
 return bytes;
}

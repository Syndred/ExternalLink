import {createHash} from 'node:crypto';
export function validateSquarePng(bytes,expectedHash){
 if(bytes.length<24||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw new Error('目录Logo必须使用已核验PNG素材');
 const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20),sha256=createHash('sha256').update(bytes).digest('hex');
 if(width!==height||width<500)throw new Error('目录Logo必须为至少500px的正方形PNG');
 if(sha256!==expectedHash)throw new Error('冻结Logo素材SHA不一致');return {width,height,sha256,bytes:bytes.length,type:'image/png'};
}

import { DatabaseSync } from 'node:sqlite';
import { homedir } from 'node:os';import {join} from 'node:path';
import {readFile,mkdir,writeFile,stat} from 'node:fs/promises';import {createHash} from 'node:crypto';
import {profiles,plain} from '../src/shared.mjs';
const source=process.argv[2];if(!source)throw Error('指定已备份的 snapshot.json');
const snapshot=JSON.parse(await readFile(source,'utf8'));
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor');
const db=new DatabaseSync(join(home,'outbox.sqlite'),{readOnly:true});
const pair=JSON.parse(db.prepare("SELECT value FROM state WHERE id='pair'").get().value);db.close();
const output=join(homedir(),'.externallink-backups','media-no-extension-'+new Date().toISOString().replace(/[:.]/g,'-'));await mkdir(output,{recursive:true});
const assets=[];
for(const [id,profile]of Object.entries(snapshot.documents.siteProfiles)) {
 const config=plain(profiles.buildAgentConfigFromProfile(profile));
 const refs=[['logo',config.logoUrl],['featured',config.featuredImage],...(config.screenshots||[]).map((ref,i)=>['screenshot'+(i+1),ref]),
   ...Object.entries(profile.fields||{}).filter(([key,value])=>/^Local (?:LOGO|Screenshot \d)$/.test(key)&&value).map(([key,value])=>[key,value])];
 for(const [kind,ref]of refs) {
  const record={productId:id,kind,ref,at:new Date().toISOString()};
  try {
   let bytes,mime='';
   if(!ref)throw Error('未配置');
   if(/^[a-z]:[\\/]/i.test(ref)){const info=await stat(ref);if(!info.isFile()||info.size>6*1024*1024)throw Error('本机媒体无效');bytes=await readFile(ref);}
   else {
    const cloud=ref.startsWith('cloud-media://');const url=cloud?new URL('/v2/executor/workspace/media/'+encodeURIComponent(ref.slice(14)),pair.endpoint):new URL(ref);
    if(url.protocol!=='https:'||url.username||url.password)throw Error('非公开 HTTPS 媒体地址');
    if(cloud)url.searchParams.set('workspace',pair.workspaceId);
    const response=await fetch(url,{headers:cloud?{Authorization:'Bearer '+pair.deviceToken}:{},signal:AbortSignal.timeout(15000),redirect:cloud?'error':'follow'});
    mime=response.headers.get('content-type')?.split(';')[0]||'';
    if(!response.ok||!mime.startsWith('image/'))throw Error('媒体 HTTP '+response.status+' '+mime);
    const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>6*1024*1024)throw Error('媒体超过 6 MB');chunks.push(chunk);}bytes=Buffer.concat(chunks);
   }
   if(!bytes.length)throw Error('媒体为空');
   const sha256=createHash('sha256').update(bytes).digest('hex');const file=join(output,sha256+'.asset');await writeFile(file,bytes);
   Object.assign(record,{ok:true,bytes:bytes.length,sha256,mime,file});
  }catch(error){Object.assign(record,{ok:false,error:error.message});}
  assets.push(record);
 }
}
const manifest={at:new Date().toISOString(),output,assets};await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2));
console.log(JSON.stringify({output,assets:assets.length,verified:assets.filter(a=>a.ok).length,failures:assets.filter(a=>!a.ok).map(a=>({productId:a.productId,kind:a.kind,error:a.error}))}));

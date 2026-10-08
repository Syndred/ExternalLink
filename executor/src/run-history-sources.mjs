import {readFile,readdir,realpath,stat} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createHash} from 'node:crypto';
import {workbenchScope} from './workbench-sync.mjs';
import {inspectRunHistory,prepareRunHistoryPreview} from './run-history.mjs';
const names=new Set(['original-run-history.json','execution-history.json','automation-run.json']);
const maxBytes=256*1024*1024,digest=value=>createHash('sha256').update(value).digest('hex');
const rootFor=runtime=>runtime.backupRoot||process.env.EXTERNALLINK_BACKUP_ROOT||join(homedir(),'.externallink-backups');
async function readSource(runtime,file,scope){
 const root=await realpath(rootFor(runtime)),path=await realpath(file);
 if(!path.startsWith(root+sep)||!names.has(basename(path)))throw Error('原历史来源不在本机备份目录内');
 const before=await stat(path);if(!before.isFile()||before.size<1||before.size>maxBytes)throw Error('原历史文件需为不超过256 MiB的JSON文件');
 const bytes=await readFile(path),after=await stat(path);
 if(before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size)throw Error('原历史来源在读取期间变化，请刷新后重试');
 let content,raw;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,'');raw=JSON.parse(content);}catch{throw Error('原历史JSON文件无法读取，请核对完整备份');}
 // Automatic discovery only offers scoped backups. Unscoped original exports
 // remain available through the existing user-selected file import.
 if(typeof raw.scope!=='string'||!raw.scope)return null;
 if(raw.scope!==scope)return null;
 const summary=inspectRunHistory(raw);
 if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，原历史来源未加入新工作区');
 return{path,content,sha256:digest(bytes),bytes:bytes.length,modifiedAt:after.mtime.toISOString(),...summary};
}
export async function localRunHistorySources(runtime){
 const scope=workbenchScope(runtime.store.get('pair')),root=rootFor(runtime),sources=[];
 if(!runtime.store.get('pair')?.endpoint)throw Error('请先连接原工作区');let directories;
 try{directories=await readdir(root,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return{ok:true,sources};throw error;}
 for(const dir of directories.filter(entry=>entry.isDirectory()))for(const name of names){
  const file=join(root,dir.name,name);if(!await stat(file).then(info=>info.isFile(),()=>false))continue;
  try{const value=await readSource(runtime,file,scope);if(!value)continue;const id=digest(scope+'|'+resolve(value.path));
   runtime.store.set('runHistorySource:'+id,{id,scope,path:value.path,sha256:value.sha256});
   const {content,path,...summary}=value;sources.push({id,label:'本机原历史 / '+value.modifiedAt,...summary});
  }catch(error){if(scope!==workbenchScope(runtime.store.get('pair')))throw error;sources.push({unavailable:true,label:'本机原历史 / '+dir.name,error:error.message});}
 }
 if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，请重新读取原历史来源');
 sources.sort((a,b)=>String(b.modifiedAt||'').localeCompare(String(a.modifiedAt||'')));return{ok:true,sources};
}
export async function previewLocalRunHistory(runtime,input={}){
 const scope=workbenchScope(runtime.store.get('pair')),source=runtime.store.get('runHistorySource:'+input.sourceId);
 if(!source||source.scope!==scope)throw Error('请刷新并选择当前工作区的本机原历史');
 const value=await readSource(runtime,source.path,scope);
 if(!value||value.sha256!==source.sha256)throw Error('本机原历史已变化，请刷新后重新选择');
 if(scope!==workbenchScope(runtime.store.get('pair')))throw Error('工作区已切换，请重新读取原历史来源');
 return prepareRunHistoryPreview(runtime.store,scope,{name:'本机原执行历史.json',content:value.content},value.sha256);
}

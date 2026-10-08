import {workbenchScope} from './workbench-sync.mjs';
import {cloudDigest,cloudSnapshot,cacheCloudSnapshot} from './cloud-sync-state.mjs';

// Browsing uses the original local library when cloud reads are unavailable.
// Execution continues to use its own fresh readback and registration checks.
export async function browsingSnapshot(runtime){
 const pair=runtime.store.get('pair'),scope=workbenchScope(pair),identity=cloudDigest(pair);let remote,failure;
 try{remote=await runtime.cloud.request('snapshot');}catch(error){failure=error;}
 if(scope!==workbenchScope(runtime.store.get('pair'))||identity!==cloudDigest(runtime.store.get('pair')))throw Error('云端连接已变化，请重新查看本机资料');
 if(!failure){
  cloudSnapshot(pair,remote);cacheCloudSnapshot(runtime,remote);
  return{snapshot:remote,browseSource:'cloud',browseSavedAt:runtime.store.get('applicationSnapshot').at,browseMessage:''};
 }
 const saved=runtime.store.get('applicationSnapshot');
 if(saved?.scope!==scope||!saved.snapshot?.documents)throw failure;
 return{snapshot:saved.snapshot,browseSource:'local',browseSavedAt:saved.at||'',browseMessage:'云端暂不可用，当前按本机已保存资料浏览。'};
}

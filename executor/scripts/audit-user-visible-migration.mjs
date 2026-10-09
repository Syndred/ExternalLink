import assert from 'node:assert/strict';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {Store} from '../src/store.mjs';
import {batchJson} from '../../core/workbench-batch-recovery.mjs';
const store=new Store(join(homedir(),'.externallink-executor','outbox.sqlite'),{readOnly:true});
try{
 const pair=store.get('pair');
 const protectedState=()=>batchJson([store.get('pair'),store.values('task:'),store.values('run:'),store.values('workbenchBatch:'),store.pending()]);
 const before=protectedState(),reports=[];
 for(const port of [19388,19389]){
  const response=await fetch(`http://127.0.0.1:${port}/appData`,{method:'POST',headers:{Authorization:'Bearer '+pair.localToken,'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(30000)});
  assert.equal(response.status,200);const data=await response.json();assert.equal(data.ok,true);
  assert.equal(data.runtime.paused,true);assert.equal(data.runtime.busy,false);assert.equal(data.pendingEdits.length,0);
  const placeholder=value=>/no-extension-acceptance\.invalid|重构功能验收\s*2026-09-30/.test(batchJson(value));
  const visibleProducts=data.model.products.filter(product=>!product.archived),visibleIds=new Set(visibleProducts.map(product=>product.id));
  assert.ok(visibleProducts.every(product=>!placeholder(product)),'当前网站仍出现验收占位资料');
  assert.ok(data.model.library.every(row=>!placeholder({url:row.url,name:row.name,note:row.note,record:row.record,detail:row.detail,annotation:row.annotation,profileStatuses:row.profileStatuses?.filter(status=>visibleIds.has(status.profileId))})),'外链库仍出现验收占位资料');
  assert.ok(data.model.activity.every(cell=>cell.hasActivity===true),'未操作组合进入提交总览');
  assert.ok(data.model.activity.filter(cell=>visibleIds.has(cell.profileId)).every(cell=>!placeholder(cell)),'提交总览仍出现验收占位资料');
  reports.push({port,products:data.model.products.length,visibleProducts:visibleProducts.length,library:data.model.library.length,activity:data.model.activity.length,untouchedCombinationsExcluded:data.model.combinations.filter(cell=>!cell.hasActivity).length,placeholderAbsentFromVisibleProductsLibraryAndOverview:true,archivedPlaceholderProductsRetained:data.model.products.filter(product=>product.archived&&placeholder(product)).length});
 }
 assert.equal(protectedState(),before);
 console.log(JSON.stringify({ok:true,kind:'readonly_user_visible_migration_audit',reports,originalTasksRunsBatchesPendingAndCredentialsUnchanged:true,productionBusinessWrites:0,realSubmissions:0,realModels:0}));
}finally{store.close();}

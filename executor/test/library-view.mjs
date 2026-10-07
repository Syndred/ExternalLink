import assert from 'node:assert/strict';
import http from 'node:http';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {applicationModel} from '../../core/application-model.mjs';
import {Store} from '../src/store.mjs';
import {applicationData} from '../src/application-data.mjs';
import {previewWorkbenchBatch} from '../src/workbench-features.mjs';

const z='https://z.example/form',a='https://a.example/form',m='https://m.example/form',b='https://b.example/form';
const originalSettings=await readFile(new URL('../../extension/settings.js',import.meta.url),'utf8'),originalHtml=await readFile(new URL('../../extension/settings.html',import.meta.url),'utf8');
const start=originalSettings.indexOf('  function renderLibrary()'),referenceBody=originalSettings.slice(originalSettings.indexOf('    const query = ',start),originalSettings.indexOf('    el.replaceChildren();',start)),referenceLabel=originalSettings.match(/  function annotationLabel\(status\) \{[\s\S]*?^  \}/m)[0];
const snapshot={documents:{
 siteProfiles:{p:{id:'p',name:'原产品甲',sortIndex:0,url:'https://product.example',fields:{Name:'原产品甲',Url:'https://product.example','Business mail':'owner@example.com','Long description':'Original description'}},q:{id:'q',name:'未提交产品乙',sortIndex:1,url:'https://second.example',fields:{Name:'未提交产品乙',Url:'https://second.example','Business mail':'owner@example.com','Long description':'Other description'}}},activeSiteId:'p',selectedSiteIds:['q'],
 sheetTableData:{entries:[{link:z,name:'甲目录',category:'启动发布',language:'zh',accessModel:'free',note:'迁移核验备注',metrics:{dr:90,da:80}},{link:a,name:'乙目录',category:'AI 工具目录',language:'en',accessModel:'paid',note:'迁移核验备注',metrics:{dr:5}},{link:m,name:'丙目录',category:'启动发布',accessModel:'free',note:'迁移核验备注',metrics:{dr:75}},{link:b,name:'丁目录',category:'启动发布',accessModel:'free',note:'迁移核验备注',metrics:{dr:30}},...Array.from({length:45},(_,i)=>({link:'https://extra'+i+'.example/form',name:'迁移分页 '+i,category:'应用目录',metrics:{dr:1}}))]},
 siteAnnotations:{'z.example/form':{statuses:['can_submit','needs_login'],library:{groups:['high_quality']}},'a.example/form':{status:'paid',library:{pinned:true}},'m.example/form':{status:'can_submit',library:{favorite:true,groups:['free_submit']}},'b.example/form':{statuses:[],status:'paid'}},
 submissionRecords:{'z.example/form::p':{profileId:'p',destinationUrl:z,destinationKey:'z.example/form',status:'success',confirmedBy:'manual',evidence:'Original receipt',publicationStatus:'published',submittedAt:'2026-10-01T00:00:00Z'}},
 submissionTimeline:{'z.example/form::q':[{id:'follow',profileId:'q',destinationUrl:z,type:'needs_follow_up',note:'独特跟进笔记',occurredAt:'2026-10-02T00:00:00Z'}],'m.example/form::p':[{id:'action',profileId:'p',destinationUrl:m,type:'link_submit',occurredAt:'2026-10-02T00:00:00Z'}]}
},revisions:{siteProfiles:1,sheetTableData:1,siteAnnotations:1,submissionRecords:1,submissionTimeline:1}};
const baseline=structuredClone(snapshot),store=new Store(':memory:'),requests=[],previews=[],errors=[];
store.set('pair',{endpoint:'https://fixture.invalid',workspaceId:'library-view'});store.set('paused',true);store.set('acceptanceBatch',{id:'original-fixed',status:'paused',cursor:13,count:30});
const runtime={store,status:()=>({tasks:[],paused:true,busy:false,pendingEvents:0}),cloud:{async request(route){if(route==='snapshot')return structuredClone(snapshot);if(route==='runs?view=inventory')return{runs:[],tasks:[]};throw Error('Unexpected cloud write '+route);}}};
function original(filters={}){
 const values={librarySearch:filters.query??'迁移核验',libraryCategoryFilter:filters.category||'',libraryStatusFilter:filters.status||'',libraryGroupFilter:filters.group||'',libraryProgressFilter:filters.progress||'',libraryQualityFilter:filters.quality||0,librarySort:filters.sort||'quality'};
 const model=applicationModel(snapshot),context=vm.createContext({libraryItems:model.library,Timeline:globalThis.ExtLinkSubmissionTimeline,$:id=>({value:values[id]}),annotationStatuses:globalThis.ExtLinkQueue.normalizeAnnotationStatuses,matchedLibraryGroups:item=>globalThis.ExtLinkLibraryGroups.GROUPS.filter(([id])=>globalThis.ExtLinkLibraryGroups.matches(item,id))});
 return Array.from(vm.runInContext(referenceLabel+'\n(()=>{'+referenceBody+'return filtered;})()',context),item=>item.url);
}
const server=http.createServer(async(req,res)=>{try{
 const path=new URL(req.url,'http://localhost').pathname,files={'/':'../web/application.html','/profiles-core.js':'../../core/profiles.js','/target-filters-core.js':'../../core/target-filters.js','/timeline-core.js':'../../core/submission-timeline.js'};
 if(files[path]||['/application.js','/comment-studio.js','/setup.js','/application.css','/activity-time.js'].includes(path)){res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(files[path]||'../web'+path,import.meta.url)));return;}
 let raw='';for await(const chunk of req)raw+=chunk;const input=raw?JSON.parse(raw):{};let result;
 if(path==='/connection')result={ok:true};else if(path==='/appData')result=await applicationData(runtime,input);else if(path==='/previewBatch'){requests.push(structuredClone(input));result=await previewWorkbenchBatch(runtime,input);previews.push(result.batch.id);}else throw Error('Unexpected mutation or submission route '+path);
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
}catch(error){res.writeHead(error.status||500,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:false,error:error.message}));}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port,browser=await chromium.launch({channel:'chrome',headless:true,args:['--disable-extensions']});
try{
 const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());await page.goto(origin);await page.getByRole('button',{name:'外链库',exact:true}).click();
 const field=label=>page.getByLabel(label,{exact:true}),rows=()=>page.locator('#content tbody tr td:nth-child(2) a').evaluateAll(nodes=>nodes.map(node=>node.href));
 const options=id=>Array.from(originalHtml.match(new RegExp('<select id="'+id+'"[^>]*>([\\s\\S]*?)</select>'))[1].matchAll(/<option value="([^"]*)"/g),match=>match[1]);
 for(const [originalId,label]of [['libraryCategoryFilter','外链分类'],['libraryStatusFilter','站点状态'],['libraryProgressFilter','提交进度'],['librarySort','外链排序']]){const actual=await field(label).locator('option').evaluateAll(nodes=>nodes.map(n=>n.value));for(const value of options(originalId))assert.ok(actual.includes(value),label+' preserves original option '+value);}
 await field('搜索').fill('迁移核验');
 for(const sort of ['quality','position','domain']){await field('外链排序').selectOption(sort);assert.deepEqual(await rows(),original({sort}));}
 await field('外链排序').selectOption('quality');
 for(const progress of ['submitted','published','needs_follow_up','awaiting_index','action_recorded','unsubmitted']){await field('提交进度').selectOption(progress);assert.deepEqual(await rows(),original({progress}));}
 await field('提交进度').selectOption('');
 for(const status of ['can_submit','needs_login','paid','needs_manual','deleted']){await field('站点状态').selectOption(status);assert.deepEqual(await rows(),original({status}));}
 await field('站点状态').selectOption('');
 for(const query of ['  独特跟进笔记  ','未提交产品乙','需登录','已删除','高质量优先','zh','free']){await field('搜索').fill(query);assert.deepEqual(await rows(),original({query}).slice(0,40));}
 await field('搜索').fill('迁移核验');await field('外链分类').selectOption('启动发布');await field('外链分组').selectOption('free_submit');await field('收藏状态').selectOption('favorite');await field('启用状态').selectOption('enabled');await field('费用类型').selectOption('free');await field('最低 DR').selectOption('60');await field('站点状态').selectOption('can_submit');assert.deepEqual(await rows(),[m]);
 await page.getByRole('button',{name:'选择当前筛选',exact:true}).click();await page.getByRole('button',{name:'批量提交',exact:true}).click();await page.getByRole('button',{name:'预览批量提交',exact:true}).click();await page.getByRole('heading',{name:'批量提交范围确认',exact:true}).waitFor();assert.deepEqual(requests.at(-1),{profileIds:['q'],urls:[m]});assert.equal(store.get('workbenchBatch:'+previews.at(-1)).items[0].status,'ready');await page.getByRole('button',{name:'关闭详情',exact:true}).click();
 await page.getByRole('button',{name:'清空选择',exact:true}).click();for(const label of ['外链分类','外链分组','收藏状态','启用状态','费用类型','站点状态'])await field(label).selectOption('');await field('最低 DR').selectOption('0');await field('提交进度').selectOption('published');assert.deepEqual(await rows(),[z]);assert.match(await page.locator('#content tbody').innerText(),/需要跟进/);
 await page.getByRole('button',{name:'选择当前筛选',exact:true}).click();await page.getByRole('button',{name:'批量提交',exact:true}).click();await page.getByRole('button',{name:'预览批量提交',exact:true}).click();await page.getByRole('heading',{name:'批量提交范围确认',exact:true}).waitFor();assert.deepEqual(requests.at(-1),{profileIds:['q'],urls:[z]});assert.equal(store.get('workbenchBatch:'+previews.at(-1)).items[0].status,'excluded');await page.getByRole('button',{name:'关闭详情',exact:true}).click();
 await field('提交进度').selectOption('');await field('搜索').fill('迁移分页');assert.equal((await rows()).length,40);await page.getByRole('button',{name:'下一页',exact:true}).click();assert.equal((await rows()).length,5);await field('站点状态').selectOption('can_submit');assert.deepEqual(await rows(),[]);await field('站点状态').selectOption('');assert.equal((await rows()).length,40);
 assert.deepEqual(snapshot,baseline);assert.deepEqual(store.get('applicationSnapshot').snapshot,baseline);assert.deepEqual(store.get('acceptanceBatch'),{id:'original-fixed',status:'paused',cursor:13,count:30});assert.equal(store.get('paused'),true);assert.equal(store.values('task:').length,0);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({passed:true,allOriginalOptions:true,originalFunctionComparison:true,multiProductProgress:true,searchAndComposedFilters:true,paginationReset:true,actualSelectedScopeAndBatchPreview:true,rawSnapshotAndReceiptPreserved:true,originalBatchPaused:true,newRealSubmissions:0}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));store.close();}

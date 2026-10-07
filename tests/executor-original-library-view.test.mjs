import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import vm from 'node:vm';
import {applicationModel} from '../core/application-model.mjs';
import {originalLibraryGlobals} from './helpers/original-library-catalog.mjs';

const originalSource=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/settings.js'],{encoding:'utf8',maxBuffer:4*1024*1024});
const migratedSource=readFileSync(new URL('../executor/web/application.js',import.meta.url),'utf8');
const originalStart=originalSource.indexOf('  function renderLibrary()');
const originalBody=originalSource.slice(originalSource.indexOf('    const query = ',originalStart),originalSource.indexOf('    el.replaceChildren();',originalStart));
const originalLabel=originalSource.match(/  function annotationLabel\(status\) \{[\s\S]*?^  \}/m)[0];
const migratedBody=migratedSource.slice(migratedSource.indexOf('function libraryStatuses(')>=0?migratedSource.indexOf('function libraryStatuses('):migratedSource.indexOf('function filteredLibrary('),migratedSource.indexOf('async function savePreferences('));
const Q=globalThis.ExtLinkQueue,Timeline=globalThis.ExtLinkSubmissionTimeline,LibraryGroups=globalThis.ExtLinkLibraryGroups;
const groupLabels=Object.fromEntries(LibraryGroups.GROUPS),markLabels={can_submit:'可以提交',paid:'需要付费',broken:'网址失效',skip:'暂不提交',needs_otp:'需要邮箱或手机验证码',needs_captcha:'需要完成验证码',needs_login:'需要登录',needs_manual:'需要人工处理',deleted:'已归档'};
function original(items,filters={}){
 const values={librarySearch:filters.query||'',libraryCategoryFilter:filters.category||'',libraryStatusFilter:filters.status||'',libraryGroupFilter:filters.group||'',libraryProgressFilter:filters.progress||'',libraryQualityFilter:filters.quality||0,librarySort:filters.sort||'quality'};
 const originals=originalLibraryGlobals,groups=originals.ExtLinkLibraryGroups,context=vm.createContext({libraryItems:items,Timeline:originals.ExtLinkSubmissionTimeline,Q:originals.ExtLinkQueue,LibraryGroups:groups,$:id=>({value:values[id]}),annotationStatuses:originals.ExtLinkQueue.normalizeAnnotationStatuses,matchedLibraryGroups:item=>groups.GROUPS.filter(([id])=>groups.matches(item,id))});
 return Array.from(vm.runInContext(originalLabel+'\n(()=>{'+originalBody+'return filtered;})()',context),r=>r.url);
}
function migrated(items,filters={}){
 const context=vm.createContext({data:{model:{library:items}},query:filters.query||'',libraryCategory:filters.category||'',libraryStatus:filters.status||'',libraryGroup:filters.group||'',libraryFavorite:filters.favorite||'',libraryEnabled:filters.enabled||'',libraryAccess:filters.access||'',libraryProgress:filters.progress||'',libraryMinQuality:filters.quality||0,libraryMinDr:filters.dr||0,librarySort:filters.sort||'quality',profileFilter:filters.profile||'',groupLabels,markLabels,accessLabels:{free:'免费',paid:'付费',unknown:'费用待核验'},parseActivityTime:Timeline.parseTime,ExtLinkSubmissionTimeline:Timeline});
 return Array.from(vm.runInContext(migratedBody+'\nfilteredLibrary()',context),r=>r.url);
}
const items=[
 {url:'https://z.example/form',site:'z.example',domain:'z.example',position:0,name:'Z',category:'启动发布',quality:{score:90},annotation:{statuses:['can_submit','needs_login']},groups:['high_quality'],preferences:{enabled:true},language:'zh',accessModel:'free',events:[{profileId:'p',profileName:'原产品甲',note:'独特跟进笔记',type:'published',occurredAt:'2026-10-01T00:00:00Z'},{profileId:'q',type:'needs_follow_up',occurredAt:'2026-10-02T00:00:00Z'}],profileStatuses:[{profileId:'p',profileName:'原产品甲',success:true},{profileId:'q',profileName:'原产品乙'}]},
 {url:'https://a.example/form',site:'a.example',domain:'a.example',position:1,name:'A',pinned:true,category:'AI 工具目录',quality:{score:35},annotation:{status:'paid'},groups:[],preferences:{enabled:true},language:'en',accessModel:'paid',profileStatuses:[{profileId:'p',profileName:'原产品甲'}]},
 {url:'https://m.example/form',site:'m.example',domain:'m.example',position:2,name:'M',category:'启动发布',quality:{score:75},annotation:{statuses:['needs_manual']},groups:['free_submit'],preferences:{favorite:true,enabled:true},accessModel:'free',events:[{profileId:'p',type:'link_submit',occurredAt:'2026-10-02T00:00:00Z'}],profileStatuses:[{profileId:'p',profileName:'原产品甲'}]},
 {url:'https://b.example/form',site:'b.example',domain:'b.example',position:3,name:'B',category:'启动发布',quality:{score:55},annotation:{statuses:[],status:'paid'},groups:[],preferences:{enabled:false},accessModel:'unknown',profileStatuses:[]},
 {url:'https://k.example/form',site:'k.example',domain:'k.example',position:4,name:'K',category:'启动发布',quality:{score:45},annotation:{status:'can_submit'},preferences:{enabled:true},profileStatuses:[{profileId:'p',success:true},{profileId:'q'}],events:[{profileId:'q',type:'pending_moderation',occurredAt:'2026-10-02T00:00:00Z'}]},
 {url:'https://live.example/form',site:'live.example',domain:'live.example',position:5,name:'Live',category:'启动发布',quality:{score:65},annotation:{status:'can_submit'},preferences:{enabled:true},monitorStatus:'live',profileStatuses:[{profileId:'p'}],events:[{profileId:'p',type:'rejected',occurredAt:'2026-10-02T00:00:00Z'}]}
].map(item=>({pinned:false,...item,groups:LibraryGroups.GROUPS.filter(([id])=>LibraryGroups.matches(item,id)).map(([id])=>id),progress:Timeline.deriveLibraryProgress(item)}));
test('library progress filters match original multi-product flags instead of only current status',()=>{
 assert.equal(items[0].progress.current,'needs_follow_up');
 assert.equal(items[4].progress.current,'pending_moderation');assert.ok(items[4].progress.profileStates.includes('awaiting_index'));assert.equal(items[5].progress.current,'rejected');assert.equal(items[5].progress.hasPublished,true);
 for(const progress of ['submitted','published','awaiting_index','needs_follow_up','action_recorded','pending_moderation','unsubmitted'])assert.deepEqual(migrated(items,{progress}),original(items,{progress}),progress);
});
test('library station status filtering uses the original multi-marker normalization and empty-list precedence',()=>{
 for(const status of ['can_submit','needs_login','paid','needs_manual','skip','deleted'])assert.deepEqual(migrated(items,{status}),original(items,{status}),status);
});
test('library original quality, position and domain sorts are not overridden by pinned preferences',()=>{
 for(const sort of ['quality','position','domain'])assert.deepEqual(migrated(items,{sort}),original(items,{sort}),sort);
});
test('library search matches original language, status/group labels, event notes, profile names and surrounding spaces',()=>{
 for(const query of ['  独特跟进笔记  ','原产品乙','需登录','付费','高质量优先','zh','free'])assert.deepEqual(migrated(items,{query}),original(items,{query}),query);
});
test('library model retains original positions, source fields and names of products with no submission',()=>{
 const snapshot={documents:{siteProfiles:{p:{id:'p',sortIndex:0,name:'原产品甲',url:'https://product.example'},q:{id:'q',sortIndex:1,name:'未提交的原产品乙',url:'https://other.example'}},sheetTableData:{entries:[{link:'https://z.example/form',note:'原备注',record:'原记录',detail:'原详情'},{link:'https://a.example/form'}]},urlList:'https://custom.example/form'}};
 const before=structuredClone(snapshot),model=applicationModel(snapshot);
 assert.deepEqual(model.library.map(r=>r.position),[0,1,2]);
 assert.deepEqual(model.library[0].profileStatuses.map(p=>p.profileName),['原产品甲','未提交的原产品乙']);
 assert.equal(model.library[0].note,'原备注');assert.equal(model.library[0].record,'原记录');assert.equal(model.library[0].detail,'原详情');assert.equal(model.library[0].domain,'z.example');
 assert.deepEqual(model.libraryCategories,globalThis.ExtLinkLibraryClassifier.CATEGORY_ORDER);
 assert.deepEqual(snapshot,before);
});
test('added favorite, enabled, fee, DR and product-assignment filters still compose with original filters',()=>{
 const rows=items.map(r=>({...r,metrics:{dr:r.preferences.favorite?80:10},preferences:{...r.preferences,profileIds:r.preferences.favorite?['p']:['q']}}));
 assert.deepEqual(migrated(rows,{favorite:'favorite',enabled:'enabled',access:'free',dr:60,profile:'p',quality:55,category:'启动发布'}),[items[2].url]);
 assert.equal(migrated(rows,{sort:'dr'})[0],items[2].url);
 assert.equal(migrated(rows,{sort:'pinned'})[0],items[1].url);
 assert.equal(migrated(rows,{sort:'name'})[0],items[1].url);
});

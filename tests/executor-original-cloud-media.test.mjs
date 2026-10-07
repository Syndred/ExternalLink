import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {execFileSync} from 'node:child_process';
import {originalCloudMediaDefaults,applyOriginalCloudMediaDefaults,listOriginalD1Media,frozenOriginalMediaDefaults,resolveOriginalCloudMediaDefaults} from '../core/original-cloud-media.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {taskMediaReferences} from '../core/task-media-selection.mjs';
import {originalTaskMediaConfig} from '../executor/src/original-task-media-config.mjs';
import {profiles,plain} from '../executor/src/shared.mjs';
import {Store} from '../executor/src/store.mjs';
import {Runtime} from '../executor/src/runtime.mjs';

const profile={id:'JevPlay',name:'JevPlay',fields:{Name:'JevPlay',Url:'https://jevplay.com',LOGO:'https://product.fixture.invalid/logo.png','Screenshot 1':'https://product.fixture.invalid/example-output.png'}};
const assets=[{asset_id:'other-logo',profile_id:'other',media_kind:'logo',content_type:'image/png'},{asset_id:'original-logo',profile_id:'JevPlay',media_kind:'logo',content_type:'image/png'},{asset_id:'second-logo',profile_id:'JevPlay',media_kind:'logo',content_type:'image/png'},{asset_id:'two',profile_id:'JevPlay',media_kind:'screenshot',media_index:2,content_type:'image/png'},{asset_id:'one',profile_id:'JevPlay',media_kind:'screenshot',media_index:1,content_type:'image/png'}];

test('cloud fallback logo and screenshots match the first pre-refactor fill helper without modifying original profile or public image fields',async()=>{
 const source=execFileSync('git',['show','bd916b2944a577b160a6afcb8a7d73d263044c0c:extension/background.js'],{encoding:'utf8',maxBuffer:4*1024*1024}),start=source.indexOf('async function preferCloudSubmissionMedia('),end=source.indexOf('// ─── AI comment drafts',start),original=vm.createContext({self:{ExtLinkProfiles:profiles},listCloudSubmissionMedia:async()=>({assets}),setTimeout,clearTimeout,log(){}});assert.ok(start>=0&&end>start);vm.runInContext(source.slice(start,end),original);
 const before=structuredClone(profile),config=plain(profiles.buildAgentConfigFromProfile(profile)),reference=structuredClone(config);await original.preferCloudSubmissionMedia(reference);
 const defaults=originalCloudMediaDefaults(profile,assets),actual=applyOriginalCloudMediaDefaults(config,defaults);assert.equal(actual.projectFields['Cloud LOGO'],reference.projectFields['Cloud LOGO']);assert.deepEqual(actual.screenshots,Array.from(reference.screenshots));assert.equal(actual.projectFields.LOGO,config.projectFields.LOGO);assert.deepEqual(profile,before);assert.equal(config.projectFields['Cloud LOGO'],undefined);
 assert.deepEqual(taskMediaReferences(profile,defaults),[{ref:'cloud-media://original-logo',kind:'logo'},{ref:'cloud-media://one',kind:'screenshot1'},{ref:'cloud-media://two',kind:'screenshot2'}]);
 const embedded={...profile,logoDataUrl:'data:image/png;base64,original'},embeddedConfig=plain(profiles.buildAgentConfigFromProfile(embedded)),embeddedReference=structuredClone(embeddedConfig);await original.preferCloudSubmissionMedia(embeddedReference);const embeddedActual=applyOriginalCloudMediaDefaults(embeddedConfig,originalCloudMediaDefaults(embedded,assets));assert.equal(embeddedActual.logoDataUrl,embeddedReference.logoDataUrl);assert.equal(embeddedActual.logoDataUrl,embedded.logoDataUrl);assert.equal(embeddedActual.projectFields['Cloud LOGO'],embeddedReference.projectFields['Cloud LOGO']);
});

test('explicit selected cloud versions and disabled slots retain their selection while cloud defaults cannot use other products or non-images',()=>{
 const selected={...profile,fields:{...profile.fields,'Cloud LOGO':'cloud-media://selected'},media:{screenshots:['cloud-media://selected-shot']}};assert.deepEqual(originalCloudMediaDefaults(selected,assets),{});
 const disabled={...profile,mediaDisabled:{logo:true,screenshot2:true}},defaults=originalCloudMediaDefaults(disabled,assets);assert.equal(defaults.logo,undefined);assert.deepEqual(defaults.screenshots,['cloud-media://one','']);assert.deepEqual(taskMediaReferences(disabled,defaults),[{ref:'cloud-media://one',kind:'screenshot1'}]);
 assert.deepEqual(originalCloudMediaDefaults(profile,assets.filter(asset=>asset.profile_id==='other')),{});assert.deepEqual(originalCloudMediaDefaults(profile,assets.map(asset=>({...asset,content_type:'text/plain'}))),{});
 assert.deepEqual(originalCloudMediaDefaults(profile,[{asset_id:'modern-two',profile_id:'JevPlay',media_kind:'screenshot2',content_type:'image/png'},{asset_id:'modern-one',profile_id:'JevPlay',media_kind:'screenshot1',content_type:'image/png'}]).screenshots,['cloud-media://modern-one','cloud-media://modern-two']);
});

test('D1 catalogue pagination keeps the original list order and refuses repeated cursors',async()=>{
 const row=(id,kind)=>({key:'workspaces/default/media/'+id,customMetadata:{profileId:'JevPlay',kind},httpMetadata:{contentType:'image/png'}}),calls=[],bucket={async list(input){calls.push(input.cursor);return input.cursor?{objects:[row('second','screenshot1')],truncated:false}:{objects:[row('first','logo')],truncated:true,cursor:'next'};}};
 assert.deepEqual((await listOriginalD1Media(bucket,'default')).map(asset=>asset.asset_id),['first','second']);assert.deepEqual(calls,[undefined,'next']);bucket.list=async()=>({objects:[],truncated:true,cursor:'repeated'});await assert.rejects(listOriginalD1Media(bucket,'default'),/游标重复/);
});

test('original catalogue failure and bounded timeout preserve public and embedded fields without suppressing explicit cloud selections',async()=>{
 const embedded={...profile,logoDataUrl:'data:image/png;base64,original'},config=plain(profiles.buildAgentConfigFromProfile(embedded)),before=structuredClone(config);
 for(const list of [async()=>{throw Error('Fixture catalogue unavailable');},()=>new Promise(()=>{})]){
  const result=await resolveOriginalCloudMediaDefaults(embedded,list,{timeoutMs:10});assert.deepEqual(result.originalMediaDefaults,{});assert.match(result.originalMediaLookupWarning,/保留原资料图片/);assert.deepEqual(applyOriginalCloudMediaDefaults(config,result.originalMediaDefaults),before);
 }
 const selected={...profile,fields:{...profile.fields,'Cloud LOGO':'cloud-media://selected'}},result=await resolveOriginalCloudMediaDefaults(selected,async()=>{throw Error('Fixture catalogue unavailable');});assert.deepEqual(taskMediaReferences(selected,result.originalMediaDefaults),[{ref:'cloud-media://selected',kind:'logo'}]);
 assert.deepEqual((await resolveOriginalCloudMediaDefaults(profile,async()=>assets)).originalMediaDefaults,originalCloudMediaDefaults(profile,assets));
});

test('original native work consumes frozen cloud defaults even when current cloud catalogue and public-only original fields differ',async()=>{
 const store=new Store(':memory:');try{
  const defaults=originalCloudMediaDefaults(profile,assets),manifest=taskMediaReferences(profile,defaults).map(({ref,kind})=>({asset_id:ref.slice(14),media_kind:kind,sha256:'1'.repeat(64)})),task={id:'t',runId:'r',profileId:profile.id,profileSnapshot:profile,profileRevision:7,url:'https://directory.fixture.invalid/submit',status:'pending',controller:'executor'},run={id:'r',profileId:profile.id,profile,profileRevision:7,tasks:[task.id],mediaManifest:manifest,originalMediaDefaults:defaults};store.set('run:r',run);store.set('task:t',task);store.set('paused',false);let captured,closed=false;
  const page={isClosed:()=>closed,on(){},goto:async()=>{},locator:()=>({first:()=>({waitFor:async()=>{}})}),frames:()=>[]},runtime={store,host:{startedAt:'original-browser'},context:{newPage:async()=>page,newCDPSession:async()=>({send:async()=>({targetInfo:{targetId:'original-target'}}),detach:async()=>{}})},cloud:{request:async()=>({documents:{siteProfiles:{JevPlay:profile},submissionRecords:{}},revisions:{siteProfiles:7}})},synchronize:async()=>{},lease:async()=>{},preparePublicPage:async()=>{},prepareKnownPage:async()=>{},update(t,patch){Object.assign(t,patch);store.set('task:'+t.id,t);},prepareWithAi:async(_page,_task,config)=>{captured=config;closed=true;store.set('paused',true);return{};}};
  await Runtime.prototype.work.call(runtime,{taskId:task.id});assert.equal(captured.logoUrl,'cloud-media://original-logo');assert.deepEqual(captured.screenshots,['cloud-media://one','cloud-media://two']);assert.deepEqual(store.get('run:r'),run);assert.deepEqual(store.get('task:t').profileSnapshot,profile);assert.equal(store.get('task:t').attemptBoundary,undefined);
  store.set('run:r',{...run,workspaceId:'foreign'});store.set('pair',{workspaceId:'default'});assert.throws(()=>originalTaskMediaConfig(runtime,task,plain(profiles.buildAgentConfigFromProfile(profile))),/归属/);store.set('run:r',{...run,mediaManifest:[]});assert.throws(()=>originalTaskMediaConfig(runtime,task,plain(profiles.buildAgentConfigFromProfile(profile))),/冻结版本/);
 }finally{store.close();}
});

test('old native catalogues recover only their own proved image versions and are never rewritten or replaced by the current catalogue',()=>{
 const run={id:'original-run',profileId:profile.id,profile,mediaManifest:[{asset_id:'original-logo',media_kind:'logo',file_name:'logo.png',sha256:'1'.repeat(64)},{asset_id:'unproven-later-logo',media_kind:'logo',file_name:'later.png',sha256:''},{asset_id:'original-shot',media_kind:'screenshot',media_index:1,file_name:'shot.png',sha256:'2'.repeat(64)}]},before=structuredClone(run);
 assert.deepEqual(frozenOriginalMediaDefaults(run),{logo:'cloud-media://original-logo',screenshots:['cloud-media://original-shot']});assert.deepEqual(run,before);assert.deepEqual(frozenOriginalMediaDefaults({...run,originalMediaDefaults:{}}),{});assert.deepEqual(frozenOriginalMediaDefaults({...run,mediaManifest:run.mediaManifest.map(asset=>({...asset,sha256:''}))}),{});
});

test('actual isolated automatic and manual single-page fields upload original frozen cloud defaults with exact file SHA and no model or submission',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-cloud-media-fill.mjs'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:45000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.ok,true);assert.equal(evidence.results.length,2);for(const row of evidence.results){assert.equal(row.submitReady,true);assert.ok(row.files.every(file=>file.sha256===evidence.originalImageSourceSha256));}for(const key of ['posts','externalRequests','realModelCalls','productionWrites'])assert.equal(evidence[key],0);
});

test('actual original mapper keeps embedded logo priority with a frozen cloud fallback in both automatic and manual entry points',()=>{
 const result=spawnSync(process.execPath,['executor/test/original-cloud-media-fill.mjs','--embedded'],{cwd:fileURLToPath(new URL('..',import.meta.url)),encoding:'utf8',timeout:45000,maxBuffer:1024*1024});assert.equal(result.status,0,result.stderr+'\n'+result.stdout);const evidence=JSON.parse(result.stdout.trim().split('\n').at(-1));assert.equal(evidence.results.length,2);assert.equal(evidence.embeddedLogoPreferred,true);assert.ok(evidence.downloadRefs.every(ref=>ref==='cloud-media://original-screenshot'));for(const row of evidence.results){assert.ok(row.files.every(file=>file.sha256===evidence.originalImageSourceSha256));assert.equal(row.submitReady,true);}for(const key of ['posts','externalRequests','realModelCalls','productionWrites'])assert.equal(evidence[key],0);
});

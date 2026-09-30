import test from 'node:test';import assert from 'node:assert/strict';import {Store} from '../executor/src/store.mjs';import {registerAcceptance} from '../executor/src/acceptance-register.mjs';
function fixture(){const store=new Store(':memory:');store.set('paused',true);const profile={id:'p',fields:{Name:'P',Url:'https://product.example'}};
 store.set('acceptance:fixed',{sha256:'frozen',count:2,combinations:['one.example','two.example'].map(siteId=>({identity:siteId+'::p',siteId,url:'https://'+siteId+'/submit',profileId:'p',profileRevision:2,profile}))});
 const requests=[];const runtime={store,job:null,cloud:{async request(route,body){requests.push({route,body});if(route==='snapshot')return{documents:{siteProfiles:{p:profile}},revisions:{siteProfiles:2}};if(route.startsWith('runs?'))return{runs:[],tasks:[]};if(route==='runs')return{run:{...body.run,tasks:body.run.tasks.map(t=>t.id)},tasks:body.run.tasks.map(t=>({...t,profileId:'p',runId:body.run.id,status:'pending'}))};}}};return{runtime,store,requests};}
test('fixed registration preserves denominator and task IDs across repeated calls without starting browser work',async()=>{
 const f=fixture();const first=await registerAcceptance(f.runtime,'fixed');assert.equal(first.count,2);assert.equal(first.started,false);
 const second=await registerAcceptance(f.runtime,'fixed');assert.deepEqual(first.items,second.items);assert.equal(f.requests.filter(r=>r.route==='runs').length,2);assert.equal(f.store.get('paused'),true);f.store.close();
});
test('uncertain registration persists intent and refuses to replay or replace its task',async()=>{
 const f=fixture(),original=f.runtime.cloud.request;f.runtime.cloud.request=async(route,body)=>{if(route==='runs'){assert.equal(f.store.get('acceptanceExecution:fixed').items['one.example::p'].status,'registering');throw Object.assign(Error('connection lost'),{cloudNetwork:true});}return original(route,body);};
 const first=await registerAcceptance(f.runtime,'fixed');const taskId=first.items['one.example::p'].taskId;assert.equal(first.items['one.example::p'].status,'registration_unknown');
 const second=await registerAcceptance(f.runtime,'fixed');assert.equal(second.items['one.example::p'].taskId,taskId);assert.equal(second.items['one.example::p'].status,'registration_unknown');f.store.close();
});

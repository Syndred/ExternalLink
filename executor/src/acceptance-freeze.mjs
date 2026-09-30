import { createHash } from 'node:crypto';
import {queue,priorProductSuccess,plain} from './shared.mjs';

export function freezeAcceptance(store,{id,products,profileRevision,sites,tasks=[],records={},count=30,mediaManifest=[]}) {
 const existing=store.get('acceptance:'+id);if(existing)return existing;
 const entries=Object.entries(products||{});if(!entries.length||!Number.isInteger(count)||count<entries.length)throw Error('验收范围不足以覆盖全部实际产品');
 const hosts=new Set(),targets=[];
 for(const value of sites||[]){const url=new URL(value);if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw Error('验收地址必须为普通网页');
  const siteId=queue.extractDomain(url.href).toLowerCase();if(!hosts.has(siteId)){hosts.add(siteId);targets.push({siteId,url:url.href});}}
 const combinations=[],admissionExclusions=[];
 for(const target of targets)for(const [profileId,profile]of entries) {
  const previous=tasks.filter(t=>t.profileId===profileId&&queue.extractDomain(t.url).toLowerCase()===target.siteId);
  if(priorProductSuccess(records,profileId,target.url)||previous.some(t=>t.receipt||t.siteStatus==='accepted')){admissionExclusions.push({siteId:target.siteId,profileId,reason:'已存在真实收件，禁止新投稿'});continue;}
  if(combinations.length>=count)continue;
  const task=previous.find(t=>t.attemptBoundary)||previous[0];
  combinations.push({...target,profileId,identity:target.siteId+'::'+profileId,profileRevision,profile:plain(profile),
   profileSha256:createHash('sha256').update(JSON.stringify(profile)).digest('hex'),
   mediaManifest:mediaManifest.filter(asset=>asset.productId===profileId),existingTaskId:task?.id||null,
   requiresVerification:!!task?.attemptBoundary,initialStatus:task?.status||'not_started'});
 }
 if(combinations.length!==count||entries.some(([id])=>!combinations.some(c=>c.profileId===id)))throw Error('候选组合不足，不能降低固定分母或移除产品');
 const scope={id,at:new Date().toISOString(),count,productIds:entries.map(([id])=>id),profileRevision,combinations,admissionExclusions};
 const frozen={...scope,sha256:createHash('sha256').update(JSON.stringify(scope)).digest('hex'),startedAt:null};
 store.set('acceptance:'+id,frozen);return frozen;
}

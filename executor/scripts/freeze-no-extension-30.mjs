import {homedir} from 'node:os';import {join} from 'node:path';import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {Store} from '../src/store.mjs';import {Cloud} from '../src/cloud.mjs';import {freezeAcceptance} from '../src/acceptance-freeze.mjs';
const home=process.env.EXTERNALLINK_HOME||join(homedir(),'.externallink-executor');
const mediaFile=process.argv[2];if(!mediaFile)throw Error('指定已完成媒体盘点的 manifest.json');
const store=new Store(join(home,'outbox.sqlite'));
try {
 const snapshot=await new Cloud(store.get('pair')).request('snapshot');
 const media=JSON.parse(await readFile(mediaFile,'utf8'));
 const frozen=freezeAcceptance(store,{id:'no-extension-30-2026-09-30',products:snapshot.documents.siteProfiles,profileRevision:snapshot.revisions.siteProfiles,
   sites:['https://bai.tools/submit-ai-tools','https://navtools.ai/submit','https://once.tools/submit','https://neeed.directory/submit','https://toolscout.ai/submit','https://tools.so/submit'],
   records:snapshot.documents.submissionRecords,tasks:store.values('task:'),count:30,mediaManifest:media.assets});
 const output=join(home,'acceptance-no-extension-30');await mkdir(output,{recursive:true});
 await writeFile(join(output,'frozen.json'),JSON.stringify(frozen,null,2));
 const publicEvidence={id:frozen.id,at:frozen.at,count:frozen.count,sha256:frozen.sha256,productIds:frozen.productIds,profileRevision:frozen.profileRevision,startedAt:frozen.startedAt,
   combinations:frozen.combinations.map(({identity,profileId,siteId,url,profileSha256,existingTaskId,requiresVerification,initialStatus,mediaManifest})=>({identity,profileId,siteId,url,profileSha256,existingTaskId,requiresVerification,initialStatus,mediaVerified:mediaManifest.filter(m=>m.ok).length,mediaIssues:mediaManifest.filter(m=>!m.ok).map(m=>({kind:m.kind,error:m.error}))})),admissionExclusions:frozen.admissionExclusions};
 const evidence=new URL('../../docs/evidence/no-extension-2026-09-30/',import.meta.url);await mkdir(evidence,{recursive:true});
 await writeFile(new URL('frozen-30.json',evidence),JSON.stringify(publicEvidence,null,2));
 console.log(JSON.stringify({output,count:frozen.count,sha256:frozen.sha256,products:frozen.productIds,sites:[...new Set(frozen.combinations.map(c=>c.siteId))],verifyOnly:frozen.combinations.filter(c=>c.requiresVerification).length,started:false}));
} finally{store.close();}
